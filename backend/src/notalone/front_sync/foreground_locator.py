"""只做 OCR/探针前台定位的只读模块。"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID
from time import monotonic

from notalone.conversation.matcher import (
    BindingMatchKind,
    BindingMatchReason,
    StoredBindingEvidence,
    match_front_session,
    normalize_display_text,
)
from notalone.front_sync.foreground_observation import FreshForegroundObservation
from notalone.front_sync.probe_adapter import (
    FrontSessionProbeObservation,
    ProbeAdapterError,
)
from notalone.front_sync.sync_engine import BindingCandidateView
from notalone.front_sync.tail_lifecycle import FrontSyncPhase
from notalone.persistence.conversation_repository import (
    ConversationBindingPersistenceError,
    PersistedConversationBinding,
    PostgresConversationBindingRepository,
)
from notalone.wechat_cli import CliAdapterError, LocalWechatCli
from notalone.wechat_cli.models import ChatCandidate


@dataclass(frozen=True, slots=True)
class ForegroundLocatorStatus:
    """前台 OCR 通道的最小投影；不携带正文。"""

    phase: FrontSyncPhase
    probe_available: bool
    wechat_in_front: bool
    failure_code: str | None
    active_contact_id: UUID | None
    active_binding_display_name: str | None
    decision_reason: BindingMatchReason | None
    candidates: tuple[BindingCandidateView, ...]


_FALLBACK_SESSION_LIMIT = 20


class ForegroundLocator:
    """只定位当前前台会话，不启动 tail、不写入消息。"""

    __slots__ = ("_owner_id", "_channel", "_account_scope", "_probe", "_cli", "_bindings")

    def __init__(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        probe: object,
        cli: LocalWechatCli,
        bindings: PostgresConversationBindingRepository | object,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        self._owner_id = owner_id
        self._channel = channel
        self._account_scope = account_scope
        self._probe = probe
        self._cli = cli
        self._bindings = bindings

    def observe_fresh(
        self, *, enabled: bool, deadline: float,
    ) -> FreshForegroundObservation:
        """独立一次定位与元数据消歧，不读正文、不消费历史或写绑定。"""

        if not enabled:
            return FreshForegroundObservation.create(
                phase="paused", reason="sync_disabled", probe_available=False,
                wechat_in_front=False,
            )
        observe = getattr(self._probe, "observe_fresh", None)
        if not callable(observe):
            return FreshForegroundObservation.create(
                phase="unavailable", reason="minimal_region_unavailable",
                probe_available=False, wechat_in_front=False,
            )
        remaining = deadline - monotonic()
        if remaining <= 0:
            return FreshForegroundObservation.create(
                phase="unavailable", reason="observation_timeout",
                probe_available=False, wechat_in_front=False,
            )
        try:
            observation = observe(timeout_seconds=min(0.9, remaining))
        except ProbeAdapterError as error:
            reason = error.code if error.code in {
                "probe_not_found", "probe_timeout", "probe_output_invalid",
                "screen_capture_permission_missing", "probe_failed",
            } else "probe_failed"
            return FreshForegroundObservation.create(
                phase="unavailable", reason=reason,
                probe_available=False, wechat_in_front=False,
            )
        if not observation.wechat_in_front:
            return FreshForegroundObservation.create(
                phase="paused", reason="wechat_not_in_front",
                probe_available=True, wechat_in_front=False,
            )
        evidence = observation.qualified_evidence
        if (evidence is None or observation.quality is None
                or observation.quality.capture_version != "automatic-window-v2"
                or observation.captured_at is None):
            return FreshForegroundObservation.create(
                phase="manual-required", reason="quality_unverified",
                probe_available=True, wechat_in_front=True,
                observed_at=observation.captured_at,
            )
        remaining = deadline - monotonic()
        if remaining <= 0:
            return FreshForegroundObservation.create(
                phase="unavailable", reason="observation_timeout",
                probe_available=False, wechat_in_front=True,
                observed_at=observation.captured_at,
            )
        name = normalize_display_text(evidence.display_name)
        try:
            # all包含同名群聊及未绑定会话；达到上限即不能证明唯一。
            candidates = self._cli.sessions(
                keyword=name, type_filter="all", limit=51,
                timeout_seconds=min(0.25, remaining),
            )
            if monotonic() >= deadline:
                raise TimeoutError
            if len(candidates) >= 51:
                return FreshForegroundObservation.create(
                    phase="manual-required", reason="session_candidates_truncated",
                    probe_available=True, wechat_in_front=True,
                    observed_at=observation.captured_at,
                )
            exact = tuple(item for item in candidates
                          if normalize_display_text(item.display_name) == name)
            if len(exact) != 1 or exact[0].chat_type != "private":
                return FreshForegroundObservation.create(
                    phase="manual-required", reason="ambiguous_requires_selection",
                    probe_available=True, wechat_in_front=True,
                    observed_at=observation.captured_at,
                )
            bindings = self._bindings.list_active_bindings(
                owner_id=self._owner_id, channel=self._channel,
                account_scope=self._account_scope, bounded=True,
            )
            if monotonic() >= deadline:
                raise TimeoutError
        except TimeoutError:
            return FreshForegroundObservation.create(
                phase="unavailable", reason="observation_timeout",
                probe_available=False, wechat_in_front=True,
                observed_at=observation.captured_at,
            )
        except (CliAdapterError, ConversationBindingPersistenceError):
            return FreshForegroundObservation.create(
                phase="unavailable", reason="binding_verification_unavailable",
                probe_available=False, wechat_in_front=True,
                observed_at=observation.captured_at,
            )
        matching = tuple(item for item in bindings
                         if item.conversation_locator == exact[0].username)
        if len(matching) == 1:
            binding = matching[0]
            if normalize_display_text(binding.display_name) == name:
                return FreshForegroundObservation.create(
                    phase="confirmed", reason="confirmed_active_binding",
                    probe_available=True, wechat_in_front=True,
                    binding_id=binding.binding_id, contact_id=binding.scope.contact_id,
                    observed_at=observation.captured_at,
                )
        return FreshForegroundObservation.create(
            phase="manual-required", reason="unmatched_requires_selection",
            probe_available=True, wechat_in_front=True,
            observed_at=observation.captured_at,
        )

    def observe(self, *, enabled: bool) -> ForegroundLocatorStatus:
        """观察一次前台状态；禁用时不启动探针。"""

        if not enabled:
            return ForegroundLocatorStatus(
                phase=FrontSyncPhase.SYNC_DISABLED,
                probe_available=True,
                wechat_in_front=False,
                failure_code=None,
                active_contact_id=None,
                active_binding_display_name=None,
                decision_reason=None,
                candidates=(),
            )
        try:
            observation: FrontSessionProbeObservation = self._probe.observe()
        except ProbeAdapterError as error:
            return self._status(
                phase=FrontSyncPhase.FAILED,
                probe_available=False,
                failure_code=error.code,
            )
        if not observation.wechat_in_front:
            return self._status(
                phase=FrontSyncPhase.WAITING_FOREGROUND,
                probe_available=True,
                wechat_in_front=False,
            )
        evidence = observation.qualified_evidence
        if evidence is None:
            return self._status(
                phase=FrontSyncPhase.UNAVAILABLE,
                probe_available=True,
                wechat_in_front=True,
                decision_reason=BindingMatchReason.OBSERVATION_UNREADABLE,
            )

        try:
            candidates = self._cli.resolve_chat(
                evidence.display_name,
            ).candidates
            recent_sessions: tuple[ChatCandidate, ...] = ()
            if not candidates:
                recent_sessions = self._cli.sessions(
                    type_filter="private",
                    limit=_FALLBACK_SESSION_LIMIT,
                )
            bindings = self._active_bindings()
        except CliAdapterError as error:
            return self._status(
                phase=FrontSyncPhase.FAILED,
                probe_available=True,
                wechat_in_front=True,
                failure_code=error.code,
            )
        except ConversationBindingPersistenceError:
            return self._status(
                phase=FrontSyncPhase.FAILED,
                probe_available=True,
                wechat_in_front=True,
                failure_code="binding_list_unavailable",
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
                for binding in bindings
            ),
            recent_sessions=recent_sessions,
        )
        if decision.kind is not BindingMatchKind.CONFIRMED:
            return self._status(
                phase=FrontSyncPhase.UNAVAILABLE,
                probe_available=True,
                wechat_in_front=True,
                decision_reason=decision.reason,
                candidates=tuple(_candidate_view(candidate) for candidate in decision.candidates),
            )
        binding = next(
            (item for item in bindings if item.binding_id == decision.confirmed_binding_id),
            None,
        )
        if binding is None:
            return self._status(
                phase=FrontSyncPhase.UNAVAILABLE,
                probe_available=True,
                wechat_in_front=True,
                decision_reason=BindingMatchReason.NO_CANDIDATE,
            )
        return self._status(
            phase=FrontSyncPhase.ACTIVE,
            probe_available=True,
            wechat_in_front=True,
            active_contact_id=binding.scope.contact_id,
            active_binding_display_name=binding.display_name,
            decision_reason=decision.reason,
            candidates=tuple(_candidate_view(candidate) for candidate in decision.candidates),
        )

    def _active_bindings(self) -> tuple[PersistedConversationBinding, ...]:
        return tuple(
            self._bindings.list_active_bindings(
                owner_id=self._owner_id,
                channel=self._channel,
                account_scope=self._account_scope,
            )
        )

    @staticmethod
    def _status(
        *,
        phase: FrontSyncPhase,
        probe_available: bool,
        wechat_in_front: bool = False,
        failure_code: str | None = None,
        active_contact_id: UUID | None = None,
        active_binding_display_name: str | None = None,
        decision_reason: BindingMatchReason | None = None,
        candidates: tuple[BindingCandidateView, ...] = (),
    ) -> ForegroundLocatorStatus:
        return ForegroundLocatorStatus(
            phase=phase,
            probe_available=probe_available,
            wechat_in_front=wechat_in_front,
            failure_code=failure_code,
            active_contact_id=active_contact_id,
            active_binding_display_name=active_binding_display_name,
            decision_reason=decision_reason,
            candidates=candidates,
        )


def _candidate_view(candidate: ChatCandidate) -> BindingCandidateView:
    return BindingCandidateView(
        username=candidate.username,
        display_name=normalize_display_text(candidate.display_name),
        last_timestamp=candidate.last_timestamp,
    )
