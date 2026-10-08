"""只做 OCR/探针前台定位的只读模块。"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from notalone.conversation.matcher import (
    BindingMatchKind,
    BindingMatchReason,
    StoredBindingEvidence,
    match_front_session,
    normalize_display_text,
)
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
        if not observation.wechat_in_front or observation.evidence is None:
            return self._status(
                phase=FrontSyncPhase.WAITING_FOREGROUND,
                probe_available=True,
                wechat_in_front=False,
            )
        evidence = observation.evidence
        if not normalize_display_text(evidence.display_name):
            return self._status(
                phase=FrontSyncPhase.UNAVAILABLE,
                probe_available=True,
                wechat_in_front=True,
                decision_reason=BindingMatchReason.OBSERVATION_UNREADABLE,
            )

        try:
            candidates = self._cli.resolve_chat(
                evidence.display_name,
                type_filter="private",
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
