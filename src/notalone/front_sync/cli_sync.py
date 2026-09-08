"""已确认会话集合的 CLI 后台增量同步。

这个模块与前台 OCR 定位完全分离：它只接收持久化的 active 绑定，使用一个
全局 sessions 事件流发现变化，再用联系人自己的 cursor 读取正文；事件队列
空闲后还会做有界安全对账，覆盖事件流可能漏报的我方发送。调用方只需要在
每个后端心跳调用 ``cycle(enabled=...)``，不需要管理多个 follow 进程或了解
退避、baseline 和写入细节。
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Protocol
from uuid import UUID

from notalone.front_sync.event_publisher import (
    MessageEventPublisher,
    NullMessageEventPublisher,
)
from notalone.persistence.backfill_state import (
    BackfillPhase,
    BackfillStatePersistenceError,
    PostgresBackfillStateStore,
)
from notalone.persistence.conversation_repository import (
    ConversationBindingPersistenceError,
)
from notalone.persistence.front_sync_state import (
    FrontSyncStatePersistenceError,
)
from notalone.persistence.observation_store import (
    ObservationMode,
    ObservationPersistenceError,
    PostgresObservationStore,
)
from notalone.wechat_cli import (
    CliAdapterError,
    CliOutputError,
    LocalWechatCli,
    SessionEventStream,
)
from notalone.wechat_cli.models import TailResult
from notalone.wechat_cli.normalizer import (
    CliNormalizationError,
    normalize_cli_events,
)


class CliSyncPhase(StrEnum):
    """后台 CLI 通道的最小生命周期。"""

    DISABLED = "disabled"
    WAITING_BINDINGS = "waiting_bindings"
    ACTIVE = "active"
    DEGRADED = "degraded"


@dataclass(frozen=True, slots=True)
class CliSyncStatus:
    """后台 CLI 状态；不含会话标题、预览或消息正文。"""

    phase: CliSyncPhase
    stream_active: bool
    stream_mode: str | None
    failure_code: str | None
    bound_count: int
    pending_count: int = 0
    backfill_phase: str = "not_required"
    backfill_contact_id: UUID | None = None
    backfill_message_count: int = 0
    backfill_non_text_count: int = 0
    backfill_last_cursor: str | None = None
    backfill_failure_code: str | None = None
    backfill_total_contacts: int = 0
    backfill_completed_contacts: int = 0
    backfill_succeeded_contacts: int = 0
    backfill_skipped_contacts: int = 0
    backfill_failed_contacts: int = 0
    backfill_incomplete_contacts: int = 0
    backfill_pending_contacts: int = 0
    backfill_total_message_count: int = 0
    backfill_total_non_text_count: int = 0


@dataclass(frozen=True, slots=True)
class CliSyncCycleResult:
    """一次后台心跳的元数据结果。"""

    status: CliSyncStatus
    batch_message_count: int


class BindingSourcePort(Protocol):
    """active 会话绑定读取端口。"""

    def list_active_bindings(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
    ) -> tuple[object, ...]:
        """返回指定 owner/渠道范围的 active 绑定。"""


class ObservationStorePort(Protocol):
    """CLI 后台同步所需的持久化端口。"""

    def ensure_baseline(self, **kwargs: object) -> datetime:
        """为绑定创建或读取一次 baseline。"""

    def read_baseline(self, **kwargs: object) -> datetime | None:
        """读取绑定 baseline。"""

    def read_cursor(self, **kwargs: object) -> object | None:
        """读取联系人独立 cursor。"""

    def read_reliable_cursor(self, **kwargs: object) -> object | None:
        """读取最后一个与来源、消息同一事务提交的 cursor。"""

    def rewind_cursor(self, **kwargs: object) -> None:
        """将超前 cursor 回退到可靠位置。"""

    def record_batch_with_messages(self, **kwargs: object) -> object:
        """原子写入观察来源、cursor 和规范消息。"""


class BackfillStatePort(Protocol):
    """后台补齐状态的持久化端口；不承载聊天正文。"""

    def read(self, **kwargs: object) -> object | None:
        """读取一个绑定最近一次补齐状态。"""

    def ensure_started(self, **kwargs: object) -> object:
        """创建或恢复一次补齐触发。"""

    def mark_running(self, **kwargs: object) -> object:
        """记录补齐进入执行状态。"""

    def mark_complete(self, **kwargs: object) -> object:
        """在来源批次成功后记录完成状态。"""

    def mark_failed(self, **kwargs: object) -> object:
        """记录不含正文的稳定失败原因。"""

    def mark_incomplete(self, **kwargs: object) -> object:
        """记录 CLI 不可用或 freshness 未知。"""

    def mark_paused(self, **kwargs: object) -> object:
        """记录用户暂停。"""

    def mark_retry(self, **kwargs: object) -> object:
        """为失败或暂停状态建立新的尝试。"""


class SyncStatePort(Protocol):
    """读取同步开关时间，用于识别重新开启后的可检测缺口。"""

    def read(self, *, owner_id: UUID) -> object:
        """返回 owner 的同步开关状态。"""


_MAX_EVENTS_PER_CYCLE = 128
_MAX_BINDINGS_PER_CYCLE = 32
_SAFETY_SWEEP_INTERVAL = timedelta(seconds=15)
_SAFETY_SWEEP_BINDINGS_PER_CYCLE = 8
_INCOMPLETE_CLI_FAILURE_CODES = frozenset(
    {
        "cli_unavailable",
        "cli_not_found",
        "cli_timeout",
        "cli_key_refresh_required",
        "cli_freshness_unknown",
        "cli_follow_unsupported",
        "cli_follow_failed",
    }
)


class CliBackgroundSync:
    """一个全局 session 流 + 有界联系人正文读取的深模块。"""

    __slots__ = (
        "_owner_id",
        "_channel",
        "_account_scope",
        "_cli",
        "_bindings",
        "_observation_store",
        "_backfill_state",
        "_sync_state",
        "_message_events",
        "_clock",
        "_stream",
        "_stream_supported",
        "_global_cursor",
        "_initial_scan_done",
        "_sweep_index",
        "_last_sweep_at",
        "_pending_locators",
        "_pending_locator_set",
        "_live_pending_locators",
        "_failure_code",
        "_last_bound_count",
        "_cli_version",
        "_last_backfill_state",
        "_backfill_check_requested",
        "_backfill_trigger_at",
        "_backfill_pending_locators",
        "_backfill_paused",
    )

    def __init__(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        cli: LocalWechatCli,
        bindings: BindingSourcePort | Sequence[object],
        observation_store: ObservationStorePort | PostgresObservationStore,
        backfill_state: BackfillStatePort | PostgresBackfillStateStore | None = None,
        sync_state: SyncStatePort | None = None,
        message_events: MessageEventPublisher | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not isinstance(cli, LocalWechatCli) and not hasattr(cli, "tail"):
            raise TypeError("cli 必须提供 tail 接口。")
        self._owner_id = owner_id
        self._channel = channel
        self._account_scope = account_scope
        self._cli = cli
        self._bindings = bindings
        self._observation_store = observation_store
        self._backfill_state = backfill_state
        self._sync_state = sync_state
        self._message_events = message_events or NullMessageEventPublisher()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._stream: SessionEventStream | object | None = None
        self._stream_supported = True
        self._global_cursor: str | None = None
        self._initial_scan_done = False
        self._sweep_index = 0
        self._last_sweep_at: datetime | None = None
        self._pending_locators: deque[str] = deque()
        self._pending_locator_set: set[str] = set()
        # 同一联系人可能同时有补齐任务和实时事件；实时事件优先读取，
        # 但不能因此丢掉尚未完成的补齐任务。
        self._live_pending_locators: set[str] = set()
        self._failure_code: str | None = None
        self._last_bound_count = 0
        self._cli_version: str | None = None
        self._last_backfill_state: object | None = None
        # 新进程启动后对已有 cursor 做一次有限预算的可靠性检查；baseline
        # 仍是每个绑定自己的起点，不会因此追溯完整历史。
        self._backfill_check_requested = True
        self._backfill_trigger_at: datetime | None = self._clock()
        self._backfill_pending_locators: set[str] = set()
        self._backfill_paused = False

    def cycle(
        self,
        *,
        enabled: bool,
        priority_contact_id: UUID | None = None,
    ) -> CliSyncCycleResult:
        """执行一次后台同步心跳；关闭时立即关闭唯一全局流。"""

        if not isinstance(enabled, bool):
            raise TypeError("enabled 必须是 bool。")
        if priority_contact_id is not None and not isinstance(priority_contact_id, UUID):
            raise TypeError("priority_contact_id 必须是 UUID 或 None。")
        if not enabled:
            self.close()
            return CliSyncCycleResult(
                status=CliSyncStatus(
                    phase=CliSyncPhase.DISABLED,
                    stream_active=False,
                    stream_mode=None,
                    failure_code=None,
                    bound_count=0,
                    **self._backfill_status_fields(),
                ),
                batch_message_count=0,
            )

        if self._stream_supported:
            # 可重试的 CLI/持久化错误只影响当前轮；全局流明确不可用时
            # 保留其稳定错误码，向界面说明正在使用有界轮询。
            self._failure_code = None
        try:
            bindings = self._active_bindings()
        except ConversationBindingPersistenceError:
            return self._failure_result(
                bound_count=self._last_bound_count,
                failure_code="binding_list_unavailable",
            )
        try:
            disabled_window = self._disabled_window()
        except FrontSyncStatePersistenceError:
            return self._failure_result(
                bound_count=len(bindings),
                failure_code="sync_state_unavailable",
            )
        self._last_bound_count = len(bindings)
        if not bindings:
            self.close()
            return CliSyncCycleResult(
                status=CliSyncStatus(
                    phase=CliSyncPhase.WAITING_BINDINGS,
                    stream_active=False,
                    stream_mode=None,
                    failure_code=None,
                    bound_count=0,
                    **self._backfill_status_fields(),
                ),
                batch_message_count=0,
            )

        by_locator = {binding.conversation_locator: binding for binding in bindings}
        if self._backfill_check_requested:
            # 只有新请求才初始化整批联系人。大于单轮预算时，后续心跳
            # 必须保留尚未处理的集合，不能把已完成联系人重新加入。
            if not self._backfill_pending_locators:
                self._backfill_pending_locators.update(by_locator)
            else:
                self._backfill_pending_locators.intersection_update(by_locator)
        for binding in bindings:
            try:
                self._observation_store.ensure_baseline(
                    owner_id=self._owner_id,
                    contact_id=binding.scope.contact_id,
                    binding_id=binding.binding_id,
                    conversation_locator=binding.conversation_locator,
                    baseline_at=self._clock(),
                )
            except ObservationPersistenceError:
                self._failure_code = "baseline_unavailable"

        if self._stream is None and self._stream_supported:
            self._start_global_stream()
        if self._stream is not None:
            self._consume_global_events(by_locator)
            self._enqueue_initial_or_safety_sweep(
                bindings,
                priority_contact_id=priority_contact_id,
            )
        else:
            # 全局能力不可用时只做有界一次性轮询；不会创建长进程。
            self._enqueue_initial_or_safety_sweep(
                bindings,
                priority_contact_id=priority_contact_id,
            )

        self._prioritize_pending(priority_contact_id, bindings)

        written = 0
        processed = 0
        while self._pending_locators and processed < _MAX_BINDINGS_PER_CYCLE:
            locator = self._pending_locators.popleft()
            self._pending_locator_set.discard(locator)
            live_read = locator in self._live_pending_locators
            self._live_pending_locators.discard(locator)
            binding = by_locator.get(locator)
            if binding is None:
                continue
            processed += 1
            try:
                written += self._read_binding(
                    binding,
                    disabled_window=disabled_window,
                    backfill_trigger_at=self._backfill_trigger_at
                    if self._backfill_check_requested
                    else None,
                    live_read=live_read,
                )
            except CliNormalizationError:
                self._failure_code = "cli_normalization_failed"
            except CliAdapterError as error:
                self._failure_code = error.code
                # 不在当前轮立刻回队；否则一个持续失败的会话会占满队列。
                # 全局流的安全轮询或降级轮询会在后续心跳重试它。
            except ObservationPersistenceError:
                self._failure_code = "observation_persistence_failed"
                # 与 CLI 错误相同，延后到后续有界轮询，保证其他联系人公平。
            except BackfillStatePersistenceError:
                self._failure_code = "backfill_state_unavailable"
                # 补齐状态无法写入时不能把本轮显示为完成；后续心跳重试。
            finally:
                self._backfill_pending_locators.discard(locator)

        if self._backfill_check_requested and not self._backfill_pending_locators:
            self._backfill_check_requested = False
            self._backfill_trigger_at = None

        try:
            backfill_states = self._active_backfill_states(bindings)
        except BackfillStatePersistenceError:
            self._failure_code = self._failure_code or "backfill_state_unavailable"
            backfill_states = ()

        if self._stream is not None:
            phase = (
                CliSyncPhase.DEGRADED
                if self._failure_code is not None
                else CliSyncPhase.ACTIVE
            )
            mode = "global_follow"
            stream_active = not bool(getattr(self._stream, "closed", False))
            if not stream_active:
                self._close_stream()
                self._stream_supported = False
                self._failure_code = self._failure_code or "cli_follow_failed"
                phase = CliSyncPhase.DEGRADED
                mode = "bounded_polling"
        else:
            phase = CliSyncPhase.DEGRADED
            mode = "bounded_polling"
            stream_active = False
        return CliSyncCycleResult(
            status=CliSyncStatus(
                phase=phase,
                stream_active=stream_active,
                stream_mode=mode,
                failure_code=self._failure_code,
                bound_count=len(bindings),
                pending_count=len(self._pending_locators),
                **self._backfill_status_fields(
                    bindings=bindings,
                    states=backfill_states,
                    priority_contact_id=priority_contact_id,
                    expected=bool(
                        self._backfill_check_requested
                        or disabled_window is not None
                        or backfill_states
                    ),
                ),
            ),
            batch_message_count=written,
        )

    def _failure_result(
        self,
        *,
        bound_count: int,
        failure_code: str,
    ) -> CliSyncCycleResult:
        # 当前轮无法读取绑定或开关状态时，不让状态 API 声称还有可用的
        # 全局流；下一轮会从内存 cursor 重新建立单一流。
        self._close_stream()
        self._initial_scan_done = False
        self._sweep_index = 0
        self._last_sweep_at = None
        self._failure_code = failure_code
        return CliSyncCycleResult(
            status=CliSyncStatus(
                phase=CliSyncPhase.DEGRADED,
                stream_active=False,
                stream_mode="bounded_polling",
                failure_code=failure_code,
                bound_count=bound_count,
                pending_count=len(self._pending_locators),
                **self._backfill_status_fields(),
            ),
            batch_message_count=0,
        )

    def close(self) -> None:
        """关闭全局流并清空本轮排队；持久化 cursor 不受影响。"""

        self._close_stream()
        self._pending_locators.clear()
        self._pending_locator_set.clear()
        self._live_pending_locators.clear()
        self._initial_scan_done = False
        self._sweep_index = 0
        self._last_sweep_at = None
        self._stream_supported = True
        self._failure_code = None

    def request_safety_sweep(self) -> None:
        """让下一次空闲心跳立即执行一小批安全对账。"""

        # 手动检查也给之前降级的全局流一次恢复机会；正文仍受本轮
        # 固定联系人预算限制。
        self._stream_supported = True
        self._last_sweep_at = None

    def request_backfill_check(self) -> None:
        """请求一次覆盖全部 active 绑定的有限补齐检查。"""

        self._backfill_check_requested = True
        self._backfill_trigger_at = self._clock()
        self._backfill_pending_locators.clear()
        self._stream_supported = True
        self._last_sweep_at = None

    def pause_backfill(self) -> None:
        """暂停补齐读取，但实时事件和安全对账仍可推进普通 cursor。"""

        store = self._backfill_state
        if store is None:
            self._backfill_paused = True
            self._backfill_check_requested = False
            self._backfill_pending_locators.clear()
            return
        bindings = self._active_bindings()
        has_task = self._backfill_check_requested
        for binding in bindings:
            state = store.read(
                owner_id=self._owner_id,
                contact_id=binding.scope.contact_id,
                binding_id=binding.binding_id,
            )
            phase = _backfill_phase_value(getattr(state, "phase", None))
            if state is None:
                if not self._backfill_check_requested:
                    continue
                state = store.ensure_started(
                    owner_id=self._owner_id,
                    contact_id=binding.scope.contact_id,
                    binding_id=binding.binding_id,
                    trigger_at=self._backfill_trigger_at or self._clock(),
                )
                phase = _backfill_phase_value(getattr(state, "phase", None))
            elif self._backfill_check_requested and phase == BackfillPhase.COMPLETE.value:
                state = store.mark_retry(
                    owner_id=self._owner_id,
                    contact_id=binding.scope.contact_id,
                    binding_id=binding.binding_id,
                    trigger_at=self._backfill_trigger_at or self._clock(),
                )
                phase = _backfill_phase_value(getattr(state, "phase", None))
            if phase in {
                BackfillPhase.GAP_DETECTED.value,
                BackfillPhase.BACKFILLING.value,
                BackfillPhase.INCOMPLETE.value,
            }:
                self._last_backfill_state = store.mark_paused(
                    owner_id=self._owner_id,
                    contact_id=binding.scope.contact_id,
                    binding_id=binding.binding_id,
                )
                has_task = True
        self._backfill_paused = has_task
        self._backfill_check_requested = False
        self._backfill_pending_locators.clear()

    def retry_backfill(self) -> None:
        """恢复暂停、失败或不完整状态，并开始一次新的有限检查。"""

        store = self._backfill_state
        self._backfill_paused = False
        if store is not None:
            binding_ids: dict[UUID, list[UUID]] = {}
            for binding in self._active_bindings():
                binding_ids.setdefault(binding.scope.contact_id, []).append(
                    binding.binding_id
                )
            for state in store.list_active(
                owner_id=self._owner_id,
                channel=self._channel,
                account_scope=self._account_scope,
            ):
                phase = _backfill_phase_value(getattr(state, "phase", None))
                if phase not in {
                    BackfillPhase.PAUSED.value,
                    BackfillPhase.FAILED.value,
                    BackfillPhase.INCOMPLETE.value,
                }:
                    continue
                binding_id = getattr(state, "binding_id", None)
                if not isinstance(binding_id, UUID):
                    candidates = binding_ids.get(state.scope.contact_id, [])
                    binding_id = candidates[0] if len(candidates) == 1 else None
                if not isinstance(binding_id, UUID):
                    continue
                self._last_backfill_state = store.mark_retry(
                    owner_id=self._owner_id,
                    contact_id=state.scope.contact_id,
                    binding_id=binding_id,
                    trigger_at=self._clock(),
                )
        self.request_backfill_check()

    def _active_bindings(self) -> tuple[object, ...]:
        source = self._bindings
        if hasattr(source, "list_active_bindings"):
            result = source.list_active_bindings(
                owner_id=self._owner_id,
                channel=self._channel,
                account_scope=self._account_scope,
            )
            return tuple(result)
        return tuple(source)

    def _start_global_stream(self) -> None:
        try:
            self._stream = self._cli.session_events_follow(
                cursor=self._global_cursor,
                scan_limit=5000,
                poll_interval="3s",
            )
        except CliAdapterError as error:
            self._failure_code = error.code
            self._stream_supported = False
            self._stream = None

    def _consume_global_events(self, by_locator: dict[str, object]) -> None:
        stream = self._stream
        if stream is None:
            return
        # 新建全局流时 cursor 为空，CLI 可能先输出一批当前会话快照；
        # 这些事件由本轮初始化/补齐检查处理，不能在用户暂停补齐后
        # 被误当成刚到达的实时事件。流已有水位后才把事件标为 live。
        live_events = self._global_cursor is not None
        try:
            for _ in range(_MAX_EVENTS_PER_CYCLE):
                event = stream.read(timeout=0.01)
                if event is None:
                    break
                self._global_cursor = event.cursor
                if event.conversation_locator in by_locator:
                    self._enqueue(event.conversation_locator, live=live_events)
        except CliAdapterError as error:
            self._failure_code = error.code
            self._close_stream()
            self._stream_supported = False

    def _enqueue(self, locator: str, *, live: bool = False) -> None:
        if live:
            self._live_pending_locators.add(locator)
        if locator in self._pending_locator_set:
            return
        self._pending_locator_set.add(locator)
        self._pending_locators.append(locator)

    def _prioritize_pending(
        self,
        priority_contact_id: UUID | None,
        bindings: Sequence[object],
    ) -> None:
        """把当前前台联系人移到已有事件队列的队首。"""

        if priority_contact_id is None:
            return
        priority = next(
            (
                binding.conversation_locator
                for binding in bindings
                if getattr(binding.scope, "contact_id", None) == priority_contact_id
            ),
            None,
        )
        if priority is None or not self._pending_locators:
            return
        if self._pending_locators[0] == priority:
            return
        self._pending_locators = deque(
            [priority]
            + [locator for locator in self._pending_locators if locator != priority]
        )

    def _enqueue_initial_or_safety_sweep(
        self,
        bindings: Sequence[object],
        *,
        priority_contact_id: UUID | None,
    ) -> None:
        if not self._initial_scan_done:
            live = not self._backfill_check_requested
            for binding in self._ordered_bindings(
                bindings,
                priority_contact_id=priority_contact_id,
            ):
                self._enqueue(binding.conversation_locator, live=live)
            self._initial_scan_done = True
            # 初始化批次可能尚未在本轮全部处理完；从此刻开始计时，
            # 避免初始化刚结束就立刻再发起一批安全 CLI 进程。
            self._last_sweep_at = self._clock()
            return
        if self._backfill_check_requested:
            for binding in self._ordered_bindings(
                bindings,
                priority_contact_id=priority_contact_id,
            ):
                if binding.conversation_locator in self._backfill_pending_locators:
                    self._enqueue(binding.conversation_locator)
            self._last_sweep_at = self._clock()
            return
        if self._pending_locators:
            return
        # sessions 事件流并不保证会为“我方发送”产生变化通知。
        # 队列空闲后按低频、固定预算做安全轮询，仍使用各联系人的
        # cursor，因此不会重复写入，也不会为每个联系人创建 Follow。
        now = self._clock()
        if (
            self._last_sweep_at is not None
            and now < self._last_sweep_at + _SAFETY_SWEEP_INTERVAL
        ):
            return
        self._enqueue_round_robin(
            bindings,
            priority_contact_id=priority_contact_id,
        )
        self._last_sweep_at = now

    def _enqueue_round_robin(
        self,
        bindings: Sequence[object],
        *,
        priority_contact_id: UUID | None,
    ) -> None:
        """为全局事件流增加一个有界的定期对账窗口。"""

        if not bindings:
            return
        priority = next(
            (
                binding
                for binding in bindings
                if getattr(binding.scope, "contact_id", None) == priority_contact_id
            ),
            None,
        )
        if priority is not None:
            self._enqueue(priority.conversation_locator)
        remaining = tuple(binding for binding in bindings if binding is not priority)
        if not remaining:
            return
        count = min(
            _SAFETY_SWEEP_BINDINGS_PER_CYCLE - (1 if priority is not None else 0),
            len(remaining),
        )
        if count <= 0:
            return
        start = self._sweep_index % len(remaining)
        for offset in range(count):
            binding = remaining[(start + offset) % len(remaining)]
            self._enqueue(binding.conversation_locator, live=True)
        self._sweep_index = (start + count) % len(remaining)

    @staticmethod
    def _ordered_bindings(
        bindings: Sequence[object],
        *,
        priority_contact_id: UUID | None,
    ) -> tuple[object, ...]:
        """把当前前台联系人放在队首，保留其余绑定的稳定顺序。"""

        if priority_contact_id is None:
            return tuple(bindings)
        priority = tuple(
            binding
            for binding in bindings
            if getattr(binding.scope, "contact_id", None) == priority_contact_id
        )
        rest = tuple(
            binding
            for binding in bindings
            if getattr(binding.scope, "contact_id", None) != priority_contact_id
        )
        return priority + rest

    def _disabled_window(self) -> tuple[float, float] | None:
        if self._sync_state is None:
            return None
        state = self._sync_state.read(owner_id=self._owner_id)
        disabled_at = getattr(state, "disabled_at", None)
        enabled_at = getattr(state, "enabled_at", None)
        if not isinstance(disabled_at, datetime) or not isinstance(enabled_at, datetime):
            return None
        if enabled_at <= disabled_at:
            return None
        return disabled_at.timestamp(), enabled_at.timestamp()

    def _read_binding(
        self,
        binding: object,
        *,
        disabled_window: tuple[float, float] | None,
        backfill_trigger_at: datetime | None,
        live_read: bool,
    ) -> int:
        contact_id = binding.scope.contact_id
        backfill_state = self._prepare_backfill_state(
            binding,
            disabled_window=disabled_window,
            trigger_at=backfill_trigger_at,
        )
        backfill_phase = _backfill_phase_value(
            getattr(backfill_state, "phase", None)
        )
        backfill_suppressed = backfill_phase == BackfillPhase.PAUSED.value or (
            self._backfill_paused
            and backfill_phase not in {None, BackfillPhase.COMPLETE.value}
        )
        if backfill_suppressed:
            if not live_read:
                return 0
            # “暂停补齐”不应关闭已开启的实时同步；这次读取只推进
            # 普通联系人 cursor，不改变 paused/failed 的补齐生命周期。
            backfill_state = None
        cursor = self._reconcile_cursor(binding)
        kwargs: dict[str, object] = {}
        if cursor is not None:
            kwargs["cursor"] = cursor.last_cursor
        else:
            baseline = self._observation_store.read_baseline(
                owner_id=self._owner_id,
                contact_id=contact_id,
                binding_id=binding.binding_id,
            )
            if baseline is None:
                baseline = self._observation_store.ensure_baseline(
                    owner_id=self._owner_id,
                    contact_id=contact_id,
                    binding_id=binding.binding_id,
                    conversation_locator=binding.conversation_locator,
                    baseline_at=self._clock(),
                )
            # wechat-cli 只接受本地时间布局（例如
            # ``2026-09-01T15:04:05``），不接受带 ``+00:00`` 的 RFC3339
            # 后缀；同时不能传纯数字，否则命令行解析会把它变成 int64。
            # 先转成本机时区，再去掉时区后缀，保留到秒的精确 baseline。
            kwargs["since_time"] = (
                baseline.astimezone()
                .replace(tzinfo=None)
                .isoformat(timespec="seconds")
            )
        try:
            result: TailResult = self._cli.tail(
                binding.conversation_locator,
                **kwargs,
            )
        except CliAdapterError as error:
            self._fail_backfill(
                binding,
                error.code,
                backfill_state,
                incomplete=_is_incomplete_cli_failure(error.code),
            )
            raise
        if not result.freshness_confirmed:
            error = CliOutputError(
                "cli_freshness_unknown",
                "微信 CLI 无法确认读取结果已覆盖到当前水位。",
            )
            self._fail_backfill(
                binding,
                error.code,
                backfill_state,
                incomplete=True,
            )
            raise error
        if result.last_local_id is None or result.cursor is None:
            if result.last_local_id is not None or result.cursor is not None:
                error = CliOutputError(
                    "cli_output_invalid",
                    "微信 CLI 返回的水位不完整。",
                )
                self._fail_backfill(
                    binding,
                    error.code,
                    backfill_state,
                    incomplete=True,
                )
                raise error
            if backfill_state is not None:
                self._complete_backfill(
                    binding,
                    message_count=0,
                    last_local_id=(
                        None if cursor is None else cursor.last_local_id
                    ),
                    last_cursor=(None if cursor is None else cursor.last_cursor),
                )
            return 0
        try:
            messages = normalize_cli_events(result.events)
        except CliNormalizationError:
            self._fail_backfill(binding, "cli_normalization_failed", backfill_state)
            raise
        try:
            event_count = (
                len(result.events)
                if result.event_count is None
                else result.event_count
            )
            non_text_count = (
                sum(1 for event in result.events if event.kind != "text")
                if result.event_count is None
                else result.non_text_count
            )
            batch = self._observation_store.record_batch_with_messages(
                owner_id=self._owner_id,
                contact_id=contact_id,
                binding_id=binding.binding_id,
                mode=ObservationMode.CLI_BACKGROUND,
                cli_version=self._cli_version_value(),
                conversation_locator=binding.conversation_locator,
                since_local_id=None if cursor is None else cursor.last_local_id,
                since_cursor=None if cursor is None else cursor.last_cursor,
                last_local_id=result.last_local_id,
                last_cursor=result.cursor,
                record_count=len(messages),
                event_count=event_count,
                non_text_count=non_text_count,
                messages=messages,
            )
        except CliAdapterError as error:
            self._fail_backfill(
                binding,
                error.code,
                backfill_state,
                incomplete=_is_incomplete_cli_failure(error.code),
            )
            raise
        except ObservationPersistenceError:
            self._fail_backfill(binding, "observation_persistence_failed", backfill_state)
            raise
        if backfill_state is not None:
            self._complete_backfill(
                binding,
                message_count=len(messages),
                last_local_id=result.last_local_id,
                last_cursor=result.cursor,
                non_text_count=non_text_count,
            )
        self._publish_message_events(
            scope=binding.scope,
            messages=messages,
            message_ids=getattr(batch, "created_message_ids", ()),
        )
        return len(messages)

    def _reconcile_cursor(self, binding: object) -> object | None:
        """在读取前确认联系人游标没有超过最后可靠观察批次。"""

        contact_id = binding.scope.contact_id
        cursor = self._observation_store.read_cursor(
            owner_id=self._owner_id,
            contact_id=contact_id,
        )
        read_reliable = getattr(self._observation_store, "read_reliable_cursor", None)
        rewind = getattr(self._observation_store, "rewind_cursor", None)
        if not callable(read_reliable) or not callable(rewind):
            return cursor
        reliable = read_reliable(
            owner_id=self._owner_id,
            contact_id=contact_id,
            binding_id=binding.binding_id,
        )
        if cursor is None:
            # 游标行可能在清理或恢复过程中暂时缺失；已有可靠观察时
            # 仍从该位置继续，不回到 baseline 重读整段范围。
            return reliable
        cursor_matches_binding = (
            getattr(cursor, "binding_id", None) == binding.binding_id
            and getattr(cursor, "conversation_locator", None)
            == binding.conversation_locator
        )
        cursor_is_ahead = reliable is None or (
            getattr(cursor, "last_local_id", 0)
            > getattr(reliable, "last_local_id", 0)
        )
        if not cursor_matches_binding or cursor_is_ahead:
            rewind(
                owner_id=self._owner_id,
                contact_id=contact_id,
                binding_id=binding.binding_id,
                target=reliable,
            )
            return reliable
        return cursor

    def _prepare_backfill_state(
        self,
        binding: object,
        *,
        disabled_window: tuple[float, float] | None,
        trigger_at: datetime | None,
    ) -> object | None:
        """为重启、重新开启或手动检查建立或恢复一次补齐状态。"""

        store = self._backfill_state
        contact_id = binding.scope.contact_id
        if store is None:
            return None

        existing = store.read(
            owner_id=self._owner_id,
            contact_id=contact_id,
            binding_id=binding.binding_id,
        )
        if existing is not None:
            self._last_backfill_state = existing

        # 暂停后仍会有正常后台心跳；不能因为失败状态不是 paused，
        # 就在 _read_binding 的暂停判断之前把它重新写成 backfilling。
        # 新的显式检查会带 trigger_at，届时由 retry_backfill 明确解除暂停。
        if self._backfill_paused and trigger_at is None:
            return existing

        if trigger_at is None and disabled_window is None:
            if existing is None:
                return None
            existing_phase = _backfill_phase_value(getattr(existing, "phase", None))
            if existing_phase == BackfillPhase.COMPLETE.value:
                return None
            if existing_phase in {
                BackfillPhase.PAUSED.value,
            }:
                return existing
            running = store.mark_running(
                owner_id=self._owner_id,
                contact_id=contact_id,
                binding_id=binding.binding_id,
            )
            self._last_backfill_state = running
            return running

        if (
            self._backfill_check_requested
            and existing is not None
            and _backfill_phase_value(getattr(existing, "phase", None))
            == BackfillPhase.COMPLETE.value
        ):
            # 手动检查或新进程触发了新的覆盖窗口；即使时钟精度导致
            # trigger_at 与上次相同，完成状态也不能吞掉这次新检查。
            existing = store.mark_retry(
                owner_id=self._owner_id,
                contact_id=contact_id,
                binding_id=binding.binding_id,
                trigger_at=trigger_at or self._clock(),
            )
            self._last_backfill_state = existing

        selected_trigger_at = trigger_at
        if selected_trigger_at is None:
            assert disabled_window is not None
            selected_trigger_at = datetime.fromtimestamp(
                disabled_window[1],
                tz=timezone.utc,
            )
        started = store.ensure_started(
            owner_id=self._owner_id,
            contact_id=contact_id,
            binding_id=binding.binding_id,
            trigger_at=selected_trigger_at,
        )
        self._last_backfill_state = started
        started_phase = _backfill_phase_value(getattr(started, "phase", None))
        if started_phase == BackfillPhase.COMPLETE.value:
            return None
        if started_phase == BackfillPhase.PAUSED.value:
            return started
        running = store.mark_running(
            owner_id=self._owner_id,
            contact_id=contact_id,
            binding_id=binding.binding_id,
        )
        self._last_backfill_state = running
        return running

    def _complete_backfill(
        self,
        binding: object,
        *,
        message_count: int,
        last_local_id: int | None,
        last_cursor: str | None,
        non_text_count: int = 0,
    ) -> None:
        store = self._backfill_state
        if store is None:
            return
        state = store.mark_complete(
            owner_id=self._owner_id,
            contact_id=binding.scope.contact_id,
            binding_id=binding.binding_id,
            message_count=message_count,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            non_text_count=non_text_count,
        )
        self._last_backfill_state = state

    def _fail_backfill(
        self,
        binding: object,
        failure_code: str,
        state: object | None,
        *,
        incomplete: bool = False,
    ) -> None:
        store = self._backfill_state
        if store is None or state is None:
            return
        try:
            mark = store.mark_incomplete if incomplete else store.mark_failed
            self._last_backfill_state = mark(
                owner_id=self._owner_id,
                contact_id=binding.scope.contact_id,
                binding_id=binding.binding_id,
                failure_code=failure_code,
            )
        except BackfillStatePersistenceError:
            # 状态无法落库时不能继续把本轮视为普通 CLI 失败；让 cycle
            # 暴露稳定的持久化错误，并保留未完成的持久化生命周期。
            self._failure_code = "backfill_state_unavailable"
            raise

    def _active_backfill_states(
        self,
        bindings: Sequence[object],
    ) -> tuple[object, ...]:
        """读取当前 active 绑定的持久化状态，缺失状态不伪造为完成。"""

        store = self._backfill_state
        if store is None:
            return ()
        list_active = getattr(store, "list_active", None)
        if callable(list_active):
            return tuple(
                list_active(
                    owner_id=self._owner_id,
                    channel=self._channel,
                    account_scope=self._account_scope,
                )
            )
        states: list[object] = []
        for binding in bindings:
            state = store.read(
                owner_id=self._owner_id,
                contact_id=binding.scope.contact_id,
                binding_id=binding.binding_id,
            )
            if state is not None:
                states.append(state)
        return tuple(states)

    def _backfill_status_fields(
        self,
        *,
        bindings: Sequence[object] = (),
        states: Sequence[object] = (),
        priority_contact_id: UUID | None = None,
        expected: bool = False,
    ) -> dict[str, object]:
        """汇总补齐状态；缺失或失败联系人不会被折算成完成。"""

        if not expected and not states:
            return _empty_backfill_status_fields()

        by_binding = {
            getattr(state, "binding_id", None): state
            for state in states
        }
        total_contacts = len(bindings) if expected else len(states)
        complete_states = [
            state
            for state in states
            if _backfill_phase_value(getattr(state, "phase", None))
            == BackfillPhase.COMPLETE.value
        ]
        failed_states = [
            state
            for state in states
            if _backfill_phase_value(getattr(state, "phase", None))
            == BackfillPhase.FAILED.value
        ]
        incomplete_states = [
            state
            for state in states
            if _backfill_phase_value(getattr(state, "phase", None))
            == BackfillPhase.INCOMPLETE.value
        ]
        active_states = [
            state
            for state in states
            if _backfill_phase_value(getattr(state, "phase", None))
            in {
                BackfillPhase.GAP_DETECTED.value,
                BackfillPhase.BACKFILLING.value,
            }
        ]
        paused_states = [
            state
            for state in states
            if _backfill_phase_value(getattr(state, "phase", None))
            == BackfillPhase.PAUSED.value
        ]
        completed_contacts = len(complete_states)
        skipped_contacts = sum(
            1
            for state in complete_states
            if int(getattr(state, "message_count", 0)) == 0
            and int(getattr(state, "non_text_count", 0)) == 0
        )
        pending_contacts = max(total_contacts - completed_contacts, 0)

        current = next(
            (
                state
                for state in states
                if priority_contact_id is not None
                and getattr(
                    getattr(state, "scope", None), "contact_id", None
                )
                == priority_contact_id
            ),
            self._last_backfill_state,
        )
        if current is None or getattr(current, "binding_id", None) not in by_binding:
            current = next(
                iter(active_states or paused_states or incomplete_states or failed_states or states),
                None,
            )
        if active_states:
            phase = BackfillPhase.BACKFILLING.value
        elif incomplete_states:
            phase = BackfillPhase.INCOMPLETE.value
        elif failed_states:
            phase = BackfillPhase.FAILED.value
        elif paused_states:
            phase = BackfillPhase.PAUSED.value
        elif states and completed_contacts == total_contacts:
            phase = BackfillPhase.COMPLETE.value
        else:
            phase = BackfillPhase.GAP_DETECTED.value

        failure_state = next(iter(incomplete_states or failed_states), None)
        scope = getattr(current, "scope", None)
        contact_id = getattr(scope, "contact_id", None)
        return {
            "backfill_phase": phase,
            "backfill_contact_id": contact_id,
            "backfill_message_count": int(
                getattr(current, "message_count", 0)
            )
            if current is not None
            else 0,
            "backfill_non_text_count": int(
                getattr(current, "non_text_count", 0)
            )
            if current is not None
            else 0,
            "backfill_last_cursor": (
                getattr(current, "last_cursor", None) if current is not None else None
            ),
            "backfill_failure_code": (
                getattr(failure_state, "failure_code", None)
                if failure_state is not None
                else getattr(current, "failure_code", None)
                if current is not None
                else None
            ),
            "backfill_total_contacts": total_contacts,
            "backfill_completed_contacts": completed_contacts,
            "backfill_succeeded_contacts": completed_contacts - skipped_contacts,
            "backfill_skipped_contacts": skipped_contacts,
            "backfill_failed_contacts": len(failed_states),
            "backfill_incomplete_contacts": len(incomplete_states),
            "backfill_pending_contacts": pending_contacts,
            "backfill_total_message_count": sum(
                int(getattr(state, "message_count", 0)) for state in states
            ),
            "backfill_total_non_text_count": sum(
                int(getattr(state, "non_text_count", 0)) for state in states
            ),
        }

    def _cli_version_value(self) -> str:
        if self._cli_version is None:
            self._cli_version = self._cli.version()
        return self._cli_version

    def _publish_message_events(
        self,
        *,
        scope: object,
        messages: tuple[object, ...],
        message_ids: Sequence[UUID | None],
    ) -> None:
        for message, message_id in zip(messages, message_ids):
            if message_id is None:
                continue
            occurred_at = message.occurred_at or self._clock()
            self._message_events.publish_message_created(
                scope=scope,
                occurred_at=occurred_at,
                message_id=message_id,
            )

    def _close_stream(self) -> None:
        stream = self._stream
        if stream is not None:
            stream.close()
            self._stream = None


def _backfill_phase_value(phase: object) -> str | None:
    if isinstance(phase, BackfillPhase):
        return phase.value
    if isinstance(phase, str):
        return phase
    return None


def _empty_backfill_status_fields() -> dict[str, object]:
    """返回未触发补齐时的稳定状态投影。"""

    return {
        "backfill_phase": "not_required",
        "backfill_contact_id": None,
        "backfill_message_count": 0,
        "backfill_non_text_count": 0,
        "backfill_last_cursor": None,
        "backfill_failure_code": None,
        "backfill_total_contacts": 0,
        "backfill_completed_contacts": 0,
        "backfill_succeeded_contacts": 0,
        "backfill_skipped_contacts": 0,
        "backfill_failed_contacts": 0,
        "backfill_incomplete_contacts": 0,
        "backfill_pending_contacts": 0,
        "backfill_total_message_count": 0,
        "backfill_total_non_text_count": 0,
    }


def _is_incomplete_cli_failure(failure_code: str) -> bool:
    """只把来源不可用类错误归为无法确认完整。"""

    return failure_code in _INCOMPLETE_CLI_FAILURE_CODES
