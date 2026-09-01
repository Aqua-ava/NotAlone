"""已确认会话集合的 CLI 后台增量同步。

这个模块与前台 OCR 定位完全分离：它只接收持久化的 active 绑定，使用一个
全局 sessions 事件流发现变化，再用联系人自己的 cursor 读取正文。调用方
只需要在每个后端心跳调用 ``cycle(enabled=...)``，不需要管理多个 follow
进程或了解退避、baseline 和写入细节。
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Protocol
from uuid import UUID

from notalone.front_sync.event_publisher import (
    MessageEventPublisher,
    NullMessageEventPublisher,
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
    LocalWechatCli,
    SessionEventStream,
)
from notalone.wechat_cli.models import CliMessageEvent, TailResult
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

    def record_batch_with_messages(self, **kwargs: object) -> object:
        """原子写入观察来源、cursor 和规范消息。"""


class SyncStatePort(Protocol):
    """读取同步开关时间，用于跳过手动关闭窗口。"""

    def read(self, *, owner_id: UUID) -> object:
        """返回 owner 的同步开关状态。"""


_MAX_EVENTS_PER_CYCLE = 128
_MAX_BINDINGS_PER_CYCLE = 32


class CliBackgroundSync:
    """一个全局 session 流 + 有界联系人正文读取的深模块。"""

    __slots__ = (
        "_owner_id",
        "_channel",
        "_account_scope",
        "_cli",
        "_bindings",
        "_observation_store",
        "_sync_state",
        "_message_events",
        "_clock",
        "_stream",
        "_stream_supported",
        "_global_cursor",
        "_initial_scan_done",
        "_pending_locators",
        "_pending_locator_set",
        "_failure_code",
        "_last_bound_count",
        "_cli_version",
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
        self._sync_state = sync_state
        self._message_events = message_events or NullMessageEventPublisher()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._stream: SessionEventStream | object | None = None
        self._stream_supported = True
        self._global_cursor: str | None = None
        self._initial_scan_done = False
        self._pending_locators: deque[str] = deque()
        self._pending_locator_set: set[str] = set()
        self._failure_code: str | None = None
        self._last_bound_count = 0
        self._cli_version: str | None = None

    def cycle(self, *, enabled: bool) -> CliSyncCycleResult:
        """执行一次后台同步心跳；关闭时立即关闭唯一全局流。"""

        if not isinstance(enabled, bool):
            raise TypeError("enabled 必须是 bool。")
        if not enabled:
            self.close()
            return CliSyncCycleResult(
                status=CliSyncStatus(
                    phase=CliSyncPhase.DISABLED,
                    stream_active=False,
                    stream_mode=None,
                    failure_code=None,
                    bound_count=0,
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
                ),
                batch_message_count=0,
            )

        by_locator = {binding.conversation_locator: binding for binding in bindings}
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
            if not self._initial_scan_done:
                for binding in bindings:
                    self._enqueue(binding.conversation_locator)
                self._initial_scan_done = True
        else:
            # 全局能力不可用时只做有界一次性轮询；不会创建长进程。
            for binding in bindings:
                self._enqueue(binding.conversation_locator)

        written = 0
        processed = 0
        while self._pending_locators and processed < _MAX_BINDINGS_PER_CYCLE:
            locator = self._pending_locators.popleft()
            self._pending_locator_set.discard(locator)
            binding = by_locator.get(locator)
            if binding is None:
                continue
            processed += 1
            try:
                written += self._read_binding(binding, disabled_window=disabled_window)
            except CliNormalizationError:
                self._failure_code = "cli_normalization_failed"
            except CliAdapterError as error:
                self._failure_code = error.code
                self._enqueue(locator)
            except ObservationPersistenceError:
                self._failure_code = "observation_persistence_failed"
                self._enqueue(locator)

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
        self._failure_code = failure_code
        return CliSyncCycleResult(
            status=CliSyncStatus(
                phase=CliSyncPhase.DEGRADED,
                stream_active=False,
                stream_mode="bounded_polling",
                failure_code=failure_code,
                bound_count=bound_count,
                pending_count=len(self._pending_locators),
            ),
            batch_message_count=0,
        )

    def close(self) -> None:
        """关闭全局流并清空本轮排队；持久化 cursor 不受影响。"""

        self._close_stream()
        self._pending_locators.clear()
        self._pending_locator_set.clear()
        self._initial_scan_done = False
        self._stream_supported = True
        self._failure_code = None

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
        try:
            for _ in range(_MAX_EVENTS_PER_CYCLE):
                event = stream.read(timeout=0.01)
                if event is None:
                    break
                self._global_cursor = event.cursor
                if event.conversation_locator in by_locator:
                    self._enqueue(event.conversation_locator)
        except CliAdapterError as error:
            self._failure_code = error.code
            self._close_stream()
            self._stream_supported = False

    def _enqueue(self, locator: str) -> None:
        if locator in self._pending_locator_set:
            return
        self._pending_locator_set.add(locator)
        self._pending_locators.append(locator)

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
    ) -> int:
        contact_id = binding.scope.contact_id
        cursor = self._observation_store.read_cursor(
            owner_id=self._owner_id,
            contact_id=contact_id,
        )
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
            kwargs["since_time"] = baseline.isoformat()
        result: TailResult = self._cli.tail(
            binding.conversation_locator,
            **kwargs,
        )
        if result.last_local_id is None or result.cursor is None:
            return 0
        messages = normalize_cli_events(
            _outside_disabled_window(result.events, disabled_window)
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
            messages=messages,
        )
        self._publish_message_events(
            scope=binding.scope,
            messages=messages,
            message_ids=getattr(batch, "created_message_ids", ()),
        )
        return len(messages)

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


def _outside_disabled_window(
    events: tuple[CliMessageEvent, ...],
    window: tuple[float, float] | None,
) -> tuple[CliMessageEvent, ...]:
    """过滤手动关闭窗口内的文字事件，但仍让 cursor 前移。"""

    if window is None:
        return events
    disabled_at, enabled_at = window
    kept: list[CliMessageEvent] = []
    for event in events:
        moment = _event_epoch(event)
        if moment is None:
            # 无法证明发生在关闭窗口之外时保守跳过。
            continue
        if moment <= disabled_at or moment > enabled_at:
            kept.append(event)
    return tuple(kept)


def _event_epoch(event: object) -> float | None:
    create_time = getattr(event, "create_time", None)
    if isinstance(create_time, int) and not isinstance(create_time, bool):
        return float(create_time)
    time_iso = getattr(event, "time_iso", None)
    if not isinstance(time_iso, str):
        return None
    try:
        parsed = datetime.fromisoformat(time_iso)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()
