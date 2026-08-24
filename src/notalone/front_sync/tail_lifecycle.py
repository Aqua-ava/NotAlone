"""当前前台联系人的 tail 读取生命周期编排。

任何时刻只允许当前唯一联系人拥有有效读取任务：切换联系人时先停止
旧联系人再启动新联系人；每个联系人使用自己的水位，切回时补读并
标记 ``cli_catchup``；同步关闭、微信非前台、定位失败或 CLI 不可用
时停止读取；手动关闭期间产生的消息窗口按原始时间跳过；应用重启且
同步仍开启时从水位恢复。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from uuid import UUID

from notalone.conversation.matcher import (
    BindingMatchDecision,
    BindingMatchKind,
    FrontSessionEvidence,
    StoredBindingEvidence,
    match_front_session,
    normalize_display_text,
)
from notalone.persistence.conversation_repository import (
    PersistedConversationBinding,
    PostgresConversationBindingRepository,
)
from notalone.persistence.front_sync_state import (
    FrontSyncState,
    PostgresFrontSyncStateStore,
)
from notalone.persistence.observation_store import (
    ObservationMode,
    ObservationPersistenceError,
    PostgresObservationStore,
)
from notalone.wechat_cli import CliAdapterError, LocalWechatCli
from notalone.wechat_cli.models import CliMessageEvent
from notalone.wechat_cli.normalizer import (
    CliNormalizationError,
    normalize_cli_events,
)


class FrontSyncPhase(StrEnum):
    """不会泄漏会话内容的生命周期阶段。"""

    SYNC_DISABLED = "sync_disabled"
    WAITING_FOREGROUND = "waiting_foreground"
    UNAVAILABLE = "unavailable"
    ACTIVE = "active"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class FrontSyncStatus:
    """供展示层使用的最小同步状态；不含消息正文。"""

    phase: FrontSyncPhase
    active_binding_id: UUID | None = None
    active_contact_id: UUID | None = None
    failure_code: str | None = None
    active_binding_display_name: str | None = None


@dataclass(frozen=True, slots=True)
class FrontObserveOutcome:
    """一次前台观察的稳定结论；携带绑定决策供一次性确认入口使用。

    门禁在前（开关、前台、可读性）时 ``decision`` 为 None；
    完成候选解析与匹配后无论是否确认都携带决策。
    """

    phase: FrontSyncPhase
    decision: BindingMatchDecision | None = None
    evidence: FrontSessionEvidence | None = None


@dataclass(slots=True)
class _ActiveTailSession:
    """当前唯一联系人的读取会话；水位只来自成功返回。"""

    binding: PersistedConversationBinding
    next_mode: ObservationMode
    since_local_id: int | None
    since_cursor: str | None
    # 手动关闭窗口 (关闭时刻, 开启时刻) 的 epoch 秒；窗口内消息不写入。
    skip_window: tuple[float, float] | None = None


_MAX_BACKOFF_SECONDS = 30.0
_FAILURE_NORMALIZATION = "cli_normalization_failed"
_FAILURE_PERSISTENCE = "observation_persistence_failed"


class TailLifecycle:
    """按前台观察驱动的一次性轮询式 tail 生命周期。

    本类不启动后台线程；调用方在前台观察变化时调用
    ``observe_front_session``，并按固定间隔调用 ``poll``。
    """

    def __init__(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        cli: LocalWechatCli,
        bindings: PostgresConversationBindingRepository,
        observation_store: PostgresObservationStore,
        sync_state: PostgresFrontSyncStateStore,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not normalize_display_text(channel):
            raise ValueError("channel 不能为空。")
        if not normalize_display_text(account_scope):
            raise ValueError("account_scope 不能为空。")
        self._owner_id = owner_id
        self._channel = channel
        self._account_scope = account_scope
        self._cli = cli
        self._bindings = bindings
        self._observation_store = observation_store
        self._sync_state = sync_state
        self._clock = clock
        self._session: _ActiveTailSession | None = None
        self._phase = FrontSyncPhase.SYNC_DISABLED
        self._failure_code: str | None = None
        self._failed_at: float | None = None
        self._consecutive_failures = 0
        self._cli_version: str | None = None

    # ------------------------------------------------------------------
    # 同步开关
    # ------------------------------------------------------------------

    def enable_sync(self) -> None:
        """用户手动开启前台同步；恢复读取等待下一次前台观察。"""

        self._sync_state.enable(
            owner_id=self._owner_id,
            at=_datetime_from_clock(self._clock()),
        )

    def disable_sync(self) -> None:
        """用户手动关闭前台同步；立即停止读取并记录关闭窗口起点。"""

        self._sync_state.disable(
            owner_id=self._owner_id,
            at=_datetime_from_clock(self._clock()),
        )
        self._stop_session(FrontSyncPhase.SYNC_DISABLED)

    # ------------------------------------------------------------------
    # 前台观察与轮询
    # ------------------------------------------------------------------

    def observe_front_session(
        self,
        *,
        wechat_in_front: bool,
        evidence: FrontSessionEvidence | None,
    ) -> FrontObserveOutcome:
        """根据前台证据切换读取任务；不确定时停止，不猜测联系人。"""

        if not self._sync_state.read(owner_id=self._owner_id).enabled:
            self._stop_session(FrontSyncPhase.SYNC_DISABLED)
            return FrontObserveOutcome(phase=FrontSyncPhase.SYNC_DISABLED)
        if not wechat_in_front or evidence is None:
            self._stop_session(FrontSyncPhase.WAITING_FOREGROUND)
            return FrontObserveOutcome(phase=FrontSyncPhase.WAITING_FOREGROUND)
        if not normalize_display_text(evidence.display_name):
            # display name 暂时不可读：跳过当前帧，不沿用旧联系人写入。
            self._stop_session(FrontSyncPhase.UNAVAILABLE)
            return FrontObserveOutcome(
                phase=FrontSyncPhase.UNAVAILABLE, evidence=evidence
            )

        try:
            candidates = self._cli.resolve_chat(
                evidence.display_name,
                type_filter="private",
            ).candidates
        except CliAdapterError as error:
            self._stop_session(FrontSyncPhase.FAILED)
            self._mark_failure(error.code)
            return FrontObserveOutcome(
                phase=FrontSyncPhase.FAILED, evidence=evidence
            )

        stored_bindings = self._bindings.list_active_bindings(
            owner_id=self._owner_id,
            channel=self._channel,
            account_scope=self._account_scope,
        )
        decision = match_front_session(
            evidence=evidence,
            candidates=candidates,
            stored_bindings=tuple(
                StoredBindingEvidence(
                    binding_id=binding.binding_id,
                    conversation_locator=binding.conversation_locator,
                    display_name=binding.display_name,
                )
                for binding in stored_bindings
            ),
        )
        if decision.kind is not BindingMatchKind.CONFIRMED:
            # 首次绑定、重名或证据矛盾都需要用户确认，期间不读取。
            self._stop_session(FrontSyncPhase.UNAVAILABLE)
            return FrontObserveOutcome(
                phase=FrontSyncPhase.UNAVAILABLE,
                decision=decision,
                evidence=evidence,
            )

        confirmed = next(
            (
                binding
                for binding in stored_bindings
                if binding.binding_id == decision.confirmed_binding_id
            ),
            None,
        )
        if confirmed is None:
            self._stop_session(FrontSyncPhase.UNAVAILABLE)
            return FrontObserveOutcome(
                phase=FrontSyncPhase.UNAVAILABLE,
                decision=decision,
                evidence=evidence,
            )
        self._resume_binding(confirmed)
        return FrontObserveOutcome(
            phase=self._phase, decision=decision, evidence=evidence
        )

    def poll(self) -> int:
        """执行当前联系人的一次增量读取；返回本轮处理的规范消息数。

        计数包含跨来源去重后复用既有规范消息的部分；失败进入退避重试。
        """

        session = self._session
        if session is None:
            return 0
        if self._phase is FrontSyncPhase.FAILED and not self._backoff_elapsed():
            return 0

        scope = session.binding.scope
        locator = session.binding.conversation_locator
        try:
            result = self._cli.tail(locator, cursor=session.since_cursor)
        except CliAdapterError as error:
            self._mark_failure(error.code)
            return 0

        if result.last_local_id is None or result.cursor is None:
            # 没有新消息：保持活跃状态与既有水位。
            self._recover_from_failure()
            return 0

        # 手动关闭期间产生的消息窗口只前移水位，不写入消息；
        # 过滤按消息原始时间对每个联系人独立生效。
        events = _outside_disabled_window(result.events, session.skip_window)

        try:
            messages = normalize_cli_events(events)
        except CliNormalizationError:
            self._mark_failure(_FAILURE_NORMALIZATION)
            return 0

        try:
            self._observation_store.record_batch_with_messages(
                owner_id=self._owner_id,
                contact_id=scope.contact_id,
                binding_id=session.binding.binding_id,
                mode=session.next_mode,
                cli_version=self._require_cli_version(),
                conversation_locator=locator,
                since_local_id=session.since_local_id,
                since_cursor=session.since_cursor,
                last_local_id=result.last_local_id,
                last_cursor=result.cursor,
                record_count=len(messages),
                messages=messages,
            )
        except (CliAdapterError, ObservationPersistenceError):
            self._mark_failure(_FAILURE_PERSISTENCE)
            return 0

        self._advance_session(session, result.last_local_id, result.cursor)
        self._recover_from_failure()
        return len(messages)

    def status(self) -> FrontSyncStatus:
        """返回当前阶段与活跃联系人；不携带会话内容。"""

        session = self._session
        return FrontSyncStatus(
            phase=self._phase,
            active_binding_id=(
                session.binding.binding_id if session is not None else None
            ),
            active_contact_id=(
                session.binding.scope.contact_id if session is not None else None
            ),
            failure_code=self._failure_code,
            active_binding_display_name=(
                session.binding.display_name if session is not None else None
            ),
        )

    # ------------------------------------------------------------------
    # 内部状态迁移
    # ------------------------------------------------------------------

    def _resume_binding(self, binding: PersistedConversationBinding) -> None:
        """启动或保持一个联系人的读取会话；先停止旧联系人。"""

        session = self._session
        if session is not None and session.binding.binding_id == binding.binding_id:
            # 并发或重复启动同一联系人保持稳定，不重建会话。
            if self._phase is not FrontSyncPhase.FAILED:
                self._phase = FrontSyncPhase.ACTIVE
                self._failure_code = None
            return

        self._session = None
        cursor = self._observation_store.read_cursor(
            owner_id=self._owner_id,
            contact_id=binding.scope.contact_id,
        )
        self._session = _ActiveTailSession(
            binding=binding,
            # 从既有水位恢复的第一次读取是补读；首次读取为 live。
            next_mode=(
                ObservationMode.CLI_CATCHUP
                if cursor is not None
                else ObservationMode.LIVE
            ),
            since_local_id=cursor.last_local_id if cursor is not None else None,
            since_cursor=cursor.last_cursor if cursor is not None else None,
            skip_window=_skip_window_from_state(
                self._sync_state.read(owner_id=self._owner_id)
            ),
        )
        self._phase = FrontSyncPhase.ACTIVE
        self._failure_code = None
        self._consecutive_failures = 0
        self._failed_at = None

    def _stop_session(self, phase: FrontSyncPhase) -> None:
        """停止当前读取任务；水位已随成功批次保存，无需额外写入。"""

        self._session = None
        self._phase = phase
        if phase is not FrontSyncPhase.FAILED:
            self._failure_code = None
            self._consecutive_failures = 0
            self._failed_at = None

    def _advance_session(
        self,
        session: _ActiveTailSession,
        last_local_id: int,
        last_cursor: str,
    ) -> None:
        session.since_local_id = last_local_id
        session.since_cursor = last_cursor
        session.next_mode = ObservationMode.LIVE

    def _mark_failure(self, code: str) -> None:
        self._phase = FrontSyncPhase.FAILED
        self._failure_code = code
        self._consecutive_failures += 1
        self._failed_at = self._clock()

    def _recover_from_failure(self) -> None:
        self._phase = FrontSyncPhase.ACTIVE
        self._failure_code = None
        self._consecutive_failures = 0
        self._failed_at = None

    def _backoff_elapsed(self) -> bool:
        if self._failed_at is None:
            return True
        delay = min(
            _MAX_BACKOFF_SECONDS,
            2.0 ** min(self._consecutive_failures, 5),
        )
        return self._clock() - self._failed_at >= delay

    def _require_cli_version(self) -> str:
        if self._cli_version is None:
            # 版本读取失败与 CLI 不可用同样处理，不使用伪造版本。
            self._cli_version = self._cli.version()
        return self._cli_version


def _datetime_from_clock(moment: float) -> datetime:
    return datetime.fromtimestamp(moment, tz=timezone.utc)


def _skip_window_from_state(state: FrontSyncState) -> tuple[float, float] | None:
    """从开关状态推导手动关闭窗口；从未关闭过或时间矛盾时返回 None。"""

    if state.disabled_at is None or state.enabled_at is None:
        return None
    if state.enabled_at <= state.disabled_at:
        return None
    return (state.disabled_at.timestamp(), state.enabled_at.timestamp())


def _outside_disabled_window(
    events: tuple[CliMessageEvent, ...],
    window: tuple[float, float] | None,
) -> tuple[CliMessageEvent, ...]:
    """保留关闭窗口之外的消息；窗口内或无法确定时间的消息不写入。"""

    if window is None:
        return events
    disabled_at, enabled_at = window
    kept: list[CliMessageEvent] = []
    for event in events:
        moment = _event_epoch(event)
        if moment is None:
            # 缺失原始时间无法证明在窗口之外，保守不写入。
            continue
        if moment <= disabled_at or moment > enabled_at:
            kept.append(event)
    return tuple(kept)


def _event_epoch(event: CliMessageEvent) -> float | None:
    """解析事件的原始时间为 epoch 秒；缺失或损坏时返回 None。"""

    if event.create_time is not None:
        return float(event.create_time)
    if event.time_iso is not None:
        try:
            parsed = datetime.fromisoformat(event.time_iso)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    return None
