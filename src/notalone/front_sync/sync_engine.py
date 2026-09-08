"""前台同步引擎：把定位证据、绑定确认与 tail 生命周期接成纵切。

引擎不启动后台线程：调用方在每次前台观察时调用 ``cycle``，在一次性
选择入口调用严格的 ``confirm_binding`` 或短时证据确认的
``confirm_pending_binding``。所有报告字段都不携带消息正文；
候选展示只包含 display name、外部会话标识和最近活动时间。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.conversation.matcher import (
    BindingMatchDecision,
    BindingMatchKind,
    BindingMatchReason,
    FrontSessionEvidence,
    normalize_display_text,
    summarize_evidence,
)
from notalone.front_sync.probe_adapter import (
    FrontSessionProbeObservation,
    ProbeAdapterError,
)
from notalone.front_sync.tail_lifecycle import (
    FrontObserveOutcome,
    FrontSyncPhase,
    FollowRuntimeStatus,
    TailLifecycle,
)
from notalone.persistence.conversation_repository import (
    ConversationBindingConflictError,
    ConversationBindingNotFoundError,
    ConversationBindingPersistenceError,
    PostgresConversationBindingRepository,
)
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.wechat_cli import CliAdapterError, LocalWechatCli
from notalone.wechat_cli.models import ChatCandidate


class FrontSessionProbePort(Protocol):
    """前台定位的可替换边界；实现必须失败关闭。"""

    def observe(self) -> FrontSessionProbeObservation:
        """返回一次前台观察结果；不可用时抛出 ProbeAdapterError。"""


class FrontSyncEngineError(RuntimeError):
    """不泄漏会话内容或正文的引擎错误。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class BindingConfirmationError(FrontSyncEngineError):
    """一次性绑定确认被拒绝；稳定原因见 ``code``。"""


@dataclass(frozen=True, slots=True)
class BindingCandidateView:
    """供用户选择的候选最小投影；不含会话正文。"""

    username: str
    display_name: str
    last_timestamp: int | None


@dataclass(frozen=True, slots=True)
class FrontSyncCycleReport:
    """一次观察+轮询循环的展示结果；不含消息正文。"""

    sync_enabled: bool
    phase: FrontSyncPhase
    probe_available: bool
    wechat_in_front: bool
    cli_available: bool
    failure_code: str | None
    active_contact_id: UUID | None
    active_binding_display_name: str | None
    decision_reason: BindingMatchReason | None
    candidates: tuple[BindingCandidateView, ...] = ()
    batch_message_count: int = 0
    # 新的双通道状态；旧前台引擎保留默认值，供兼容和人工验证使用。
    sync_mode: str = "foreground"
    cli_sync_phase: str = "disabled"
    cli_sync_mode: str | None = None
    cli_stream_active: bool = False
    cli_bound_count: int = 0
    cli_pending_count: int = 0
    cli_batch_message_count: int = 0
    cli_failure_code: str | None = None
    cli_backfill_phase: str = "not_required"
    cli_backfill_contact_id: UUID | None = None
    cli_backfill_message_count: int = 0
    cli_backfill_non_text_count: int = 0
    cli_backfill_last_cursor: str | None = None
    cli_backfill_failure_code: str | None = None
    cli_backfill_total_contacts: int = 0
    cli_backfill_completed_contacts: int = 0
    cli_backfill_succeeded_contacts: int = 0
    cli_backfill_skipped_contacts: int = 0
    cli_backfill_failed_contacts: int = 0
    cli_backfill_incomplete_contacts: int = 0
    cli_backfill_pending_contacts: int = 0
    cli_backfill_total_message_count: int = 0
    cli_backfill_total_non_text_count: int = 0
    foreground_phase: str = "sync_disabled"
    foreground_failure_code: str | None = None


@dataclass(frozen=True, slots=True)
class _PendingBindingSelection:
    """最近一次需要用户选择的前台绑定证据；只存进程内短时状态。"""

    observed_at: float
    decision: BindingMatchDecision
    evidence: FrontSessionEvidence


_PENDING_BINDING_SELECTION_TTL_SECONDS = 60.0


class FrontSyncEngine:
    """前台定位 -> 绑定门禁 -> 增量读取的端到端编排。"""

    __slots__ = (
        "_owner_id",
        "_channel",
        "_account_scope",
        "_probe",
        "_lifecycle",
        "_bindings",
        "_sync_state",
        "_cli",
        "_cli_status",
        "_pending_binding_selection",
        "_clock",
    )

    def __init__(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        probe: FrontSessionProbePort,
        lifecycle: TailLifecycle,
        bindings: PostgresConversationBindingRepository,
        sync_state: PostgresFrontSyncStateStore,
        cli: LocalWechatCli,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not normalize_display_text(channel):
            raise ValueError("channel 不能为空。")
        if not normalize_display_text(account_scope):
            raise ValueError("account_scope 不能为空。")
        if not callable(clock):
            raise TypeError("clock 必须是可调用对象。")
        self._owner_id = owner_id
        self._channel = channel
        self._account_scope = account_scope
        self._probe = probe
        self._lifecycle = lifecycle
        self._bindings = bindings
        self._sync_state = sync_state
        self._cli = cli
        self._cli_status: tuple[bool, str | None] | None = None
        self._pending_binding_selection: _PendingBindingSelection | None = None
        self._clock = clock

    # ------------------------------------------------------------------
    # 同步开关
    # ------------------------------------------------------------------

    def enable_sync(self) -> None:
        """用户手动开启前台同步。"""

        self._lifecycle.enable_sync()

    def disable_sync(self) -> None:
        """用户手动关闭前台同步；立即停止读取。"""

        self._lifecycle.disable_sync()

    def close(self) -> None:
        """关闭读取资源，但不修改持久化同步开关。"""

        self._lifecycle.close()

    def sync_enabled(self) -> bool:
        """读取当前同步开关；不触发探针或 CLI。"""

        return self._sync_state.read(owner_id=self._owner_id).enabled

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        """启用人工验证用 follow 优先策略并立即执行一轮。"""

        self._lifecycle.set_follow_enabled(True)
        return self.cycle()

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        """关闭人工验证用 follow 优先策略，恢复一次性轮询。"""

        self._lifecycle.set_follow_enabled(False)
        return self.cycle()

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        """中断当前 follow 流并立即返回恢复前的状态报告。"""

        self._lifecycle.interrupt_follow_stream()
        return self.cycle()

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        """返回人工验证页面所需的 follow 运行时最小投影。"""

        return self._lifecycle.follow_runtime_status()

    # ------------------------------------------------------------------
    # 观察循环
    # ------------------------------------------------------------------

    def cycle(self) -> FrontSyncCycleReport:
        """执行一次前台观察与增量读取，并汇总展示状态。"""

        probe_available = True
        wechat_in_front = False
        probe_failure: str | None = None
        decision = None
        try:
            observation = self._probe.observe()
        except ProbeAdapterError as error:
            probe_available = False
            probe_failure = error.code
            # 探针不可用无法证明微信在前台：按非前台停止读取。
            self._lifecycle.observe_front_session(
                wechat_in_front=False, evidence=None
            )
        else:
            wechat_in_front = observation.wechat_in_front
            outcome = self._lifecycle.observe_front_session(
                wechat_in_front=wechat_in_front,
                evidence=observation.evidence,
            )
            decision = outcome.decision
            self._remember_pending_selection(outcome)

        written = self._lifecycle.poll()
        status = self._lifecycle.status()
        cli_available, _ = self._cli_availability()
        candidate_source = (
            decision.candidates
            if decision is not None
            and decision.kind is BindingMatchKind.NEEDS_SELECTION
            else self._pending_candidate_source()
        )
        candidates = (
            tuple(_candidate_view(item) for item in candidate_source)
        )
        return FrontSyncCycleReport(
            sync_enabled=self._sync_state.read(owner_id=self._owner_id).enabled,
            phase=status.phase,
            probe_available=probe_available,
            wechat_in_front=wechat_in_front,
            cli_available=cli_available,
            failure_code=probe_failure or status.failure_code,
            active_contact_id=status.active_contact_id,
            active_binding_display_name=status.active_binding_display_name,
            decision_reason=decision.reason if decision is not None else None,
            candidates=candidates,
            batch_message_count=written,
        )

    # ------------------------------------------------------------------
    # 一次性绑定确认
    # ------------------------------------------------------------------

    def confirm_binding(self, *, contact_id: UUID, locator: str) -> FrontSyncCycleReport:
        """在当前前台会话上完成一次性绑定选择，然后立即读取一轮。

        首次绑定与重名选择创建新绑定；改名确认只更新既有绑定的
        display name 与证据摘要。确认前会重新观察，证据失效即拒绝。
        """

        if not isinstance(contact_id, UUID):
            raise TypeError("contact_id 必须是 UUID。")
        locator = normalize_display_text(locator)
        if not locator:
            raise ValueError("locator 不能为空。")

        try:
            observation = self._probe.observe()
        except ProbeAdapterError as error:
            raise BindingConfirmationError(
                "probe_unavailable", "前台定位探针不可用，不能确认绑定。"
            ) from error
        evidence = observation.evidence
        if not observation.wechat_in_front or evidence is None:
            raise BindingConfirmationError(
                "front_session_unavailable",
                "微信不在前台或会话无法定位，不能确认绑定。",
            )

        outcome = self._lifecycle.observe_front_session(
            wechat_in_front=True, evidence=evidence
        )
        self._remember_pending_selection(outcome)
        decision = outcome.decision
        if decision is None or decision.kind is not BindingMatchKind.NEEDS_SELECTION:
            raise BindingConfirmationError(
                "no_pending_selection", "当前会话没有待确认的一次性选择。"
            )
        candidate = next(
            (item for item in decision.candidates if item.username == locator),
            None,
        )
        if candidate is None:
            raise BindingConfirmationError(
                "candidate_not_found", "所选候选不在当前会话候选中。"
            )

        self._apply_binding_confirmation(
            contact_id=contact_id,
            locator=locator,
            decision=decision,
            evidence=evidence,
        )
        self._pending_binding_selection = None
        return self.cycle()

    def confirm_pending_binding(
        self, *, contact_id: UUID, locator: str
    ) -> FrontSyncCycleReport:
        """消费最近一次前台候选，即使确认操作让微信暂时离开前台。

        候选证据只在进程内保留 60 秒，且仍然要求用户明确选择联系人；
        不重新读取当前窗口，也不把候选变成自动绑定。
        """

        if not isinstance(contact_id, UUID):
            raise TypeError("contact_id 必须是 UUID。")
        locator = normalize_display_text(locator)
        if not locator:
            raise ValueError("locator 不能为空。")

        pending = self._pending_binding_selection
        if pending is None:
            raise BindingConfirmationError(
                "no_pending_selection", "当前没有可消费的待确认绑定证据。"
            )
        if self._clock() - pending.observed_at > _PENDING_BINDING_SELECTION_TTL_SECONDS:
            self._pending_binding_selection = None
            raise BindingConfirmationError(
                "pending_selection_expired",
                "待确认绑定证据已过期，请返回微信重新观察。",
            )
        if not any(
            candidate.username == locator for candidate in pending.decision.candidates
        ):
            raise BindingConfirmationError(
                "candidate_not_found", "所选候选不在待确认绑定证据中。"
            )

        self._apply_binding_confirmation(
            contact_id=contact_id,
            locator=locator,
            decision=pending.decision,
            evidence=pending.evidence,
        )
        self._pending_binding_selection = None
        return self.cycle()

    def _remember_pending_selection(self, outcome: FrontObserveOutcome) -> None:
        """记录新的前台决策；离开微信时保留旧证据以完成显式确认。"""

        decision = outcome.decision
        if decision is None:
            return
        if (
            decision.kind is BindingMatchKind.NEEDS_SELECTION
            and outcome.evidence is not None
        ):
            self._pending_binding_selection = _PendingBindingSelection(
                observed_at=self._clock(),
                decision=decision,
                evidence=outcome.evidence,
            )
            return
        # 新的已确认或不可用决策覆盖旧的候选，避免把旧窗口用于确认。
        self._pending_binding_selection = None

    def _pending_candidate_source(self) -> tuple[ChatCandidate, ...]:
        pending = self._pending_binding_selection
        if pending is None:
            return ()
        if self._clock() - pending.observed_at > _PENDING_BINDING_SELECTION_TTL_SECONDS:
            self._pending_binding_selection = None
            return ()
        return pending.decision.candidates

    def _apply_binding_confirmation(
        self,
        *,
        contact_id: UUID,
        locator: str,
        decision: BindingMatchDecision,
        evidence: FrontSessionEvidence,
    ) -> None:
        observed_name = normalize_display_text(evidence.display_name)
        if decision.reason is BindingMatchReason.BINDING_NAME_CHANGED:
            self._confirm_name_change(
                contact_id=contact_id,
                locator=locator,
                observed_name=observed_name,
                evidence=evidence,
            )
        else:
            self._create_first_binding(
                contact_id=contact_id,
                locator=locator,
                observed_name=observed_name,
                evidence=evidence,
            )

    def _create_first_binding(
        self,
        *,
        contact_id: UUID,
        locator: str,
        observed_name: str,
        evidence: FrontSessionEvidence,
    ) -> None:
        try:
            self._bindings.create_binding(
                owner_id=self._owner_id,
                contact_id=contact_id,
                channel=self._channel,
                account_scope=self._account_scope,
                conversation_locator=locator,
                display_name=observed_name or None,
                metadata_summary=summarize_evidence(evidence),
            )
        except ConversationBindingConflictError as error:
            raise BindingConfirmationError(
                "binding_conflict", "该会话或联系人已有冲突的有效绑定。"
            ) from error
        except ConversationBindingNotFoundError as error:
            raise BindingConfirmationError(
                "contact_not_found", "指定的 owner/contact 范围不存在。"
            ) from error
        except ConversationBindingPersistenceError as error:
            raise BindingConfirmationError(
                "binding_persistence_failed", "绑定写入失败，未创建绑定。"
            ) from error

    def _confirm_name_change(
        self,
        *,
        contact_id: UUID,
        locator: str,
        observed_name: str,
        evidence: FrontSessionEvidence,
    ) -> None:
        binding = next(
            (
                stored
                for stored in self._bindings.list_active_bindings(
                    owner_id=self._owner_id,
                    channel=self._channel,
                    account_scope=self._account_scope,
                )
                if stored.conversation_locator == locator
                and stored.scope.contact_id == contact_id
            ),
            None,
        )
        if binding is None:
            raise BindingConfirmationError(
                "binding_not_found", "未找到该联系人在此会话的有效绑定。"
            )
        try:
            self._bindings.update_matching_metadata(
                owner_id=self._owner_id,
                contact_id=contact_id,
                binding_id=binding.binding_id,
                display_name=observed_name or None,
                metadata_summary=summarize_evidence(evidence),
            )
        except ConversationBindingPersistenceError as error:
            raise BindingConfirmationError(
                "binding_persistence_failed", "绑定证据更新失败。"
            ) from error

    # ------------------------------------------------------------------
    # CLI 可用性
    # ------------------------------------------------------------------

    def _cli_availability(self) -> tuple[bool, str | None]:
        """每个进程生命周期内只探测一次 CLI 版本。"""

        if self._cli_status is None:
            try:
                self._cli.version()
            except CliAdapterError as error:
                self._cli_status = (False, error.code)
            else:
                self._cli_status = (True, None)
        return self._cli_status


def _candidate_view(candidate: ChatCandidate) -> BindingCandidateView:
    return BindingCandidateView(
        username=candidate.username,
        display_name=normalize_display_text(candidate.display_name),
        last_timestamp=candidate.last_timestamp,
    )
