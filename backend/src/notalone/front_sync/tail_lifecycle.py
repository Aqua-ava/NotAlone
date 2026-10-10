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
from notalone.front_sync.event_publisher import (
    MessageEventPublisher,
    NullMessageEventPublisher,
)
from notalone.ingest.models import NormalizedMessage
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
from notalone.persistence.source_processing import SourceProcessingWriteError
from notalone.scopes import ContactScope
from notalone.source_processing.models import ProcessingRecord
from notalone.source_processing.rule_capture import capture_execution
from notalone.wechat_cli import (
    CliAdapterError,
    CliCommandError,
    LocalWechatCli,
    TailFollowStream,
)
from notalone.wechat_cli.models import (
    ChatCandidate,
    CliMessageEvent,
    TailFollowItem,
)
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
class FollowRuntimeStatus:
    """供人工验证页面展示的 follow 运行时最小投影。"""

    enabled: bool
    stream_active: bool
    process_id: int | None = None
    mode: str | None = None
    watermark: int | None = None


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
    follow_stream: TailFollowStream | None = None


_MAX_BACKOFF_SECONDS = 30.0
_FAILURE_NORMALIZATION = "cli_normalization_failed"
_FAILURE_PERSISTENCE = "observation_persistence_failed"
# 连续 follow 失败且从未送达任何流事件时，达到阈值即永久降级一次性轮询；
# 已送达过事件的流崩溃仍按"崩溃退避重启"处理，不累计降级。
_FOLLOW_DEGRADE_FAILURE_LIMIT = 3
# 名字精确匹配落空时，用最近会话列表做一次性选择的回退窗口。
_FALLBACK_SESSION_LIMIT = 20


class TailLifecycle:
    """按前台观察驱动的 follow 优先 tail 生命周期。

    调用方在前台观察变化时调用 ``observe_front_session``，持续调用
    ``poll`` 消费常驻 follow 流；follow 不可用时退回一次性读取。
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
        message_events: MessageEventPublisher | None = None,
        follow_enabled: bool = False,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not normalize_display_text(channel):
            raise ValueError("channel 不能为空。")
        if not normalize_display_text(account_scope):
            raise ValueError("account_scope 不能为空。")
        if not isinstance(follow_enabled, bool):
            raise TypeError("follow_enabled 必须是 bool。")
        self._owner_id = owner_id
        self._channel = channel
        self._account_scope = account_scope
        self._cli = cli
        self._bindings = bindings
        self._observation_store = observation_store
        self._sync_state = sync_state
        self._message_events = message_events or NullMessageEventPublisher()
        self._follow_enabled = follow_enabled
        self._follow_supported = True
        self._follow_failures = 0
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

    def close(self) -> None:
        """关闭读取资源，但不修改持久化同步开关。"""

        self._stop_session(FrontSyncPhase.SYNC_DISABLED)

    def set_follow_enabled(self, enabled: bool) -> None:
        """切换人工验证用的 follow 优先策略，不改变同步开关。"""

        if not isinstance(enabled, bool):
            raise TypeError("enabled 必须是 bool。")
        if self._follow_enabled == enabled:
            return
        self._follow_enabled = enabled
        self._follow_supported = True
        self._follow_failures = 0
        if not enabled:
            session = self._session
            if session is not None:
                self._close_follow_stream(session)
                if self._phase is FrontSyncPhase.FAILED:
                    self._recover_from_failure()

    def interrupt_follow_stream(self) -> bool:
        """只中断当前 follow 子进程，供人工验证恢复路径使用。"""

        session = self._session
        if session is None or session.follow_stream is None:
            return False
        self._close_follow_stream(session)
        self._prepare_follow_restart(session)
        self._mark_failure("cli_follow_failed")
        return True

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        """返回 follow 开关、流进程和联系人水位，不含消息正文。"""

        session = self._session
        stream = session.follow_stream if session is not None else None
        return FollowRuntimeStatus(
            enabled=self._follow_enabled,
            stream_active=stream is not None and not stream.closed,
            process_id=stream.process_id if stream is not None else None,
            mode=(session.next_mode.value if session is not None else None),
            watermark=(
                session.since_local_id if session is not None else None
            ),
        )

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
            ).candidates
        except CliAdapterError as error:
            self._stop_session(FrontSyncPhase.FAILED)
            self._mark_failure(error.code)
            return FrontObserveOutcome(
                phase=FrontSyncPhase.FAILED, evidence=evidence
            )

        # OCR 可能把标题读变形导致查询落空；回退读最近会话，
        # 由匹配层认出已绑定会话或转一次性选择，不静默放弃。
        recent_sessions: tuple[ChatCandidate, ...] = ()
        if not candidates:
            try:
                recent_sessions = self._cli.sessions(
                    type_filter="private",
                    limit=_FALLBACK_SESSION_LIMIT,
                )
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
            recent_sessions=recent_sessions,
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
        if (
            self._phase is FrontSyncPhase.FAILED
            and not self._backoff_elapsed()
        ):
            return 0
        if self._follow_enabled and self._follow_supported:
            if (
                session.next_mode is ObservationMode.CLI_CATCHUP
                and session.follow_stream is None
            ):
                return self._poll_once(session)
            return self._poll_follow(session)
        return self._poll_once(session)

    def _poll_follow(self, session: _ActiveTailSession) -> int:
        if session.follow_stream is None:
            try:
                session.follow_stream = self._cli.tail_follow(
                    session.binding.conversation_locator,
                    cursor=session.since_cursor,
                )
            except CliCommandError as error:
                if error.code == "cli_follow_unsupported":
                    self._follow_supported = False
                    return self._poll_once(session)
                if self._follow_failure_escalates():
                    return self._poll_once(session)
                self._mark_failure(error.code)
                return 0
            except CliAdapterError as error:
                if self._follow_failure_escalates():
                    return self._poll_once(session)
                self._mark_failure(error.code)
                return 0

        stream = session.follow_stream
        assert stream is not None
        try:
            item = stream.read(timeout=0.05)
        except CliAdapterError as error:
            stream.close()
            session.follow_stream = None
            failure_code = self._read_failure_code(session, error)
            if failure_code != error.code:
                self._mark_failure(failure_code)
                return 0
            if error.code == "cli_follow_unsupported":
                self._follow_supported = False
                return self._poll_once(session)
            self._prepare_follow_restart(session)
            if self._follow_failure_escalates():
                self._recover_from_failure()
                return self._poll_once(session)
            self._mark_failure(error.code)
            return 0
        if item is None:
            if stream.closed:
                stream.close()
                session.follow_stream = None
                self._prepare_follow_restart(session)
                if self._follow_failure_escalates():
                    self._recover_from_failure()
                    return self._poll_once(session)
                self._mark_failure("cli_follow_failed")
            return 0
        # 送达过流事件说明 follow 能力可用；后续崩溃按重启处理。
        self._follow_failures = 0
        return self._record_follow_item(session, item)

    def _poll_once(self, session: _ActiveTailSession) -> int:
        try:
            result = self._cli.tail(
                session.binding.conversation_locator,
                cursor=session.since_cursor,
            )
        except CliAdapterError as error:
            self._mark_failure(self._read_failure_code(session, error))
            return 0
        if result.last_local_id is None or result.cursor is None:
            if session.next_mode is ObservationMode.CLI_CATCHUP:
                session.next_mode = ObservationMode.LIVE
            self._recover_from_failure()
            return 0
        events, filtered_records = _select_events(
            result.events, session.skip_window
        )
        try:
            processing_receipts: list[ProcessingRecord] = []
            messages = normalize_cli_events(
                events, processing_receipts=processing_receipts
            )
        except CliNormalizationError as error:
            self._mark_failure(self._read_failure_code(session, error))
            return 0
        return self._record_batch(
            session,
            last_local_id=result.last_local_id,
            last_cursor=result.cursor,
            messages=messages,
            processing_records=_ordered_processing_records(
                (
                    *processing_receipts,
                    *result.filtered_records,
                    *filtered_records,
                )
            ),
            event_count=result.event_count,
            non_text_count=result.non_text_count,
        )

    def _record_follow_item(
        self,
        session: _ActiveTailSession,
        item: TailFollowItem,
    ) -> int:
        events = () if item.event is None else (item.event,)
        events, filtered_records = _select_events(events, session.skip_window)
        try:
            processing_receipts: list[ProcessingRecord] = []
            messages = normalize_cli_events(
                events, processing_receipts=processing_receipts
            )
        except CliNormalizationError as error:
            self._prepare_follow_restart(session)
            self._mark_failure(self._read_failure_code(session, error))
            self._close_follow_stream(session)
            return 0
        return self._record_batch(
            session,
            last_local_id=item.local_id,
            last_cursor=item.cursor,
            messages=messages,
            processing_records=tuple(processing_receipts)
            + (
                (item.processing_record,)
                if item.event is None and item.processing_record is not None
                else ()
            )
            + filtered_records,
            event_count=1,
            non_text_count=int(item.event is None),
        )

    def _record_batch(
        self,
        session: _ActiveTailSession,
        *,
        last_local_id: int,
        last_cursor: str,
        messages: tuple[NormalizedMessage, ...],
        processing_records: tuple[ProcessingRecord, ...] = (),
        event_count: int | None = None,
        non_text_count: int = 0,
    ) -> int:
        scope = session.binding.scope
        try:
            batch = self._observation_store.record_batch_with_messages(
                owner_id=self._owner_id,
                contact_id=scope.contact_id,
                binding_id=session.binding.binding_id,
                mode=session.next_mode,
                cli_version=self._require_cli_version(),
                conversation_locator=session.binding.conversation_locator,
                since_local_id=session.since_local_id,
                since_cursor=session.since_cursor,
                last_local_id=last_local_id,
                last_cursor=last_cursor,
                record_count=len(messages),
                messages=messages,
                processing_records=processing_records,
                event_count=event_count,
                non_text_count=non_text_count,
            )
        except (
            CliAdapterError,
            ObservationPersistenceError,
            SourceProcessingWriteError,
        ) as error:
            if session.follow_stream is not None:
                self._prepare_follow_restart(session)
            self._mark_failure(
                "source_processing_write_failed"
                if isinstance(error, SourceProcessingWriteError)
                else _FAILURE_PERSISTENCE
            )
            self._close_follow_stream(session)
            return 0
        self._publish_message_events(
            scope=scope,
            messages=messages,
            message_ids=batch.created_message_ids,
        )
        self._advance_session(session, last_local_id, last_cursor)
        self._recover_from_failure()
        return len(messages)

    def _read_failure_code(
        self,
        session: _ActiveTailSession,
        error: CliAdapterError | CliNormalizationError,
    ) -> str:
        """已确认读取的损坏输入只保存安全定位；记录写入失败也关闭本轮。"""

        record_failure = getattr(
            self._observation_store, "record_input_failure", None
        )
        if error.failure_record is not None and callable(record_failure):
            try:
                record_failure(
                    owner_id=self._owner_id,
                    contact_id=session.binding.scope.contact_id,
                    binding_id=session.binding.binding_id,
                    conversation_locator=session.binding.conversation_locator,
                    record=error.failure_record,
                )
            except SourceProcessingWriteError:
                return "source_processing_write_failed"
            except ObservationPersistenceError:
                return _FAILURE_PERSISTENCE
        return error.code

    def _publish_message_events(
        self,
        *,
        scope: ContactScope,
        messages: tuple[NormalizedMessage, ...],
        message_ids: tuple[UUID | None, ...],
    ) -> None:
        for message, message_id in zip(messages, message_ids):
            if message_id is None:
                continue
            self._message_events.publish_message_created(
                scope=scope,
                occurred_at=(
                    message.occurred_at or _datetime_from_clock(self._clock())
                ),
                message_id=message_id,
            )

    def status(self) -> FrontSyncStatus:
        """返回当前阶段与活跃联系人；不携带会话内容。"""

        session = self._session
        return FrontSyncStatus(
            phase=self._phase,
            active_binding_id=(
                session.binding.binding_id if session is not None else None
            ),
            active_contact_id=(
                session.binding.scope.contact_id
                if session is not None
                else None
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
        if (
            session is not None
            and session.binding.binding_id == binding.binding_id
        ):
            # 并发或重复启动同一联系人保持稳定，不重建会话。
            if self._phase is not FrontSyncPhase.FAILED:
                self._phase = FrontSyncPhase.ACTIVE
                self._failure_code = None
            return

        self._close_session_stream()
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
            since_local_id=(
                cursor.last_local_id if cursor is not None else None
            ),
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

        self._close_session_stream()
        self._session = None
        self._phase = phase
        if phase is not FrontSyncPhase.FAILED:
            self._failure_code = None
            self._consecutive_failures = 0
            self._failed_at = None

    def _close_session_stream(self) -> None:
        session = self._session
        if session is not None:
            self._close_follow_stream(session)

    @staticmethod
    def _close_follow_stream(session: _ActiveTailSession) -> None:
        if session.follow_stream is not None:
            session.follow_stream.close()
            session.follow_stream = None

    def _advance_session(
        self,
        session: _ActiveTailSession,
        last_local_id: int,
        last_cursor: str,
    ) -> None:
        session.since_local_id = last_local_id
        session.since_cursor = last_cursor
        session.next_mode = ObservationMode.LIVE

    @staticmethod
    def _prepare_follow_restart(session: _ActiveTailSession) -> None:
        session.next_mode = (
            ObservationMode.CLI_CATCHUP
            if session.since_cursor is not None
            else ObservationMode.LIVE
        )

    def _mark_failure(self, code: str) -> None:
        self._phase = FrontSyncPhase.FAILED
        self._failure_code = code
        self._consecutive_failures += 1
        self._failed_at = self._clock()

    def _follow_failure_escalates(self) -> bool:
        """连续 follow 失败达到阈值后永久降级回一次性轮询。

        只在从未成功送达任何流事件时累计；已送达的崩溃按退避重启
        处理，不影响本计数。
        """
        self._follow_failures += 1
        if self._follow_failures >= _FOLLOW_DEGRADE_FAILURE_LIMIT:
            self._follow_supported = False
            return True
        return False

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


def _ordered_processing_records(
    records: tuple[ProcessingRecord, ...],
) -> tuple[ProcessingRecord, ...]:
    return tuple(
        sorted(
            records,
            key=lambda record: record.payload().get("input_position") or 0,
        )
    )


def _select_events(
    read_events: tuple[CliMessageEvent, ...],
    window: tuple[float, float] | None,
) -> tuple[tuple[CliMessageEvent, ...], tuple[ProcessingRecord, ...]]:
    """在真正筛选时捕获时间；跳过正文只留判断所需的定位和时间。"""

    started_at = datetime.now(timezone.utc)
    selected_events = _outside_disabled_window(read_events, window)
    filtering = capture_execution(started_at, __file__, status="filtered")
    return selected_events, _disabled_window_records(
        read_events, selected_events, window=window, filtering=filtering
    )


def _disabled_window_records(
    read_events: tuple[CliMessageEvent, ...],
    selected_events: tuple[CliMessageEvent, ...],
    *,
    window: tuple[float, float] | None,
    filtering: dict[str, object],
) -> tuple[ProcessingRecord, ...]:
    """旧前台验证的关闭窗口仅保存筛选定位，不保留已跳过的正文。"""

    records = []
    selected = {id(event) for event in selected_events}
    for event in read_events:
        if id(event) not in selected:
            records.append(
                ProcessingRecord.capture(
                    f"cli:{event.message_id.local_id}",
                    {
                        "capture_layer": "metadata_only",
                        "input_position": (
                            event.processing_record.payload().get(
                                "input_position"
                            )
                            if event.processing_record is not None
                            else None
                        ),
                        "record_text": None,
                        "parsed": {
                            "id": {
                                "local_id": event.message_id.local_id,
                                "talker": event.message_id.talker,
                            }
                        },
                        "outcome": "disabled_window_filtered",
                        "filter_rule": "outside_disabled_window",
                        "filter_input": {
                            "create_time": event.create_time,
                            "time_iso": event.time_iso,
                            "disabled_window": window,
                        },
                        "filter": filtering,
                    },
                )
            )
    return tuple(records)


def _datetime_from_clock(moment: float) -> datetime:
    return datetime.fromtimestamp(moment, tz=timezone.utc)


def _skip_window_from_state(
    state: FrontSyncState,
) -> tuple[float, float] | None:
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
