"""只做 OCR/探针前台定位的只读模块。"""

from __future__ import annotations

from collections.abc import Callable

from dataclasses import dataclass
import re
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
from notalone.front_sync.emoji_tail import has_supported_emoji_suffix
from notalone.front_sync.observation_budget import FRESH_PROBE_SECONDS
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
        self, *, enabled: bool, deadline: float, check_current: Callable[[], None] | None = None,
    ) -> FreshForegroundObservation:
        """独立一次定位与元数据消歧，不读正文、不消费历史或写绑定。"""

        if check_current is not None:
            check_current()
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
            if check_current is not None:
                check_current()
            observation = observe(timeout_seconds=min(FRESH_PROBE_SECONDS, remaining))
        except ProbeAdapterError as error:
            reason = error.code if error.code in {
                "probe_not_found", "probe_timeout", "probe_output_invalid",
                "screen_capture_permission_missing", "probe_failed",
                "foreground_application_unavailable",
                "calibration_wechat_instances_ambiguous", "calibration_wechat_version_unsupported",
                "calibration_window_not_visible", "calibration_windows_ambiguous",
                "calibration_window_geometry_invalid", "calibration_context_unavailable",
                "automatic_capture_context_changed", "automatic_capture_window_metadata_changed",
                "automatic_capture_scale_invalid", "automatic_capture_dimensions_changed",
                "automatic_layout_vertical_boundary", "automatic_layout_header_boundary",
                "automatic_layout_selection_ambiguous", "automatic_layout_sidebar_boundary",
                "minimal_region_layout_unverified", "minimal_region_layout_changed",
                "quality_unverified", "header_name_unreadable", "row_name_unreadable",
                "session_names_mismatch", "session_name_confidence_low", "minimal_region_capture_failed",
                "wechat_not_in_front",
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
        raw_title = observation.evidence.display_name if observation.evidence else ""
        # 人数尾缀仅用于查找群元数据；私聊资格仍要求完整原名精确匹配。
        member_suffix = re.search(r"[（(]\s*[0-9０-９]+\s*[）)]\s*$", raw_title or "")

        def pause_group(reason: str = "group_chat_suspected") -> FreshForegroundObservation:
            return FreshForegroundObservation.create(
                phase="paused", reason=reason, probe_available=True,
                wechat_in_front=True, observed_at=observation.captured_at,
            )

        recognized = {}
        if (observation.quality is not None
                and observation.quality.capture_version in ("automatic-header-v3", "automatic-header-v4")
                and observation.captured_at is not None and observation.evidence is not None):
            raw_name = observation.evidence.display_name
            if (isinstance(raw_name, str) and raw_name.strip() and len(raw_name) <= 256
                    and "\n" not in raw_name and "\r" not in raw_name):
                recognized = {"recognized_name": raw_name,
                              "recognition_confidence": observation.quality.display_name_confidence}
        if observation.text_fallback is not None:
            return self._observe_emoji_fallback(
                observation, deadline=deadline, check_current=check_current,
                recognized=recognized, member_suffix=bool(member_suffix),
            )
        evidence = observation.qualified_evidence
        quality_failure = None
        if (evidence is None or observation.quality is None
                or observation.quality.capture_version not in ("automatic-window-v2", "automatic-header-v3", "automatic-header-v4")
                or observation.captured_at is None):
            if member_suffix:
                return pause_group()
            quality_failure = FreshForegroundObservation.create(
                phase="manual-required", reason="quality_unverified",
                probe_available=True, wechat_in_front=True,
                observed_at=observation.captured_at,
                **recognized,
            )
            if not recognized:
                return quality_failure
        remaining = deadline - monotonic()
        if remaining <= 0:
            if member_suffix:
                return pause_group()
            if quality_failure is not None:
                return quality_failure
            return FreshForegroundObservation.create(
                phase="unavailable", reason="observation_timeout",
                probe_available=False, wechat_in_front=True,
                observed_at=observation.captured_at,
            )
        name = normalize_display_text(raw_title)
        group_name = normalize_display_text(raw_title[:member_suffix.start()]) if member_suffix else name
        try:
            # all包含同名群聊及未绑定会话；达到上限即不能证明唯一。
            if check_current is not None:
                check_current()
            candidates = self._cli.sessions(
                keyword=group_name or name, type_filter="all", limit=51,
                timeout_seconds=min(0.25, remaining),
            )
            if monotonic() >= deadline:
                raise TimeoutError
            exact = tuple(item for item in candidates
                          if normalize_display_text(item.display_name) == name)
            groups = tuple(item for item in candidates if item.chat_type == "group"
                           and normalize_display_text(item.display_name) in (name, group_name))
            if groups:
                return pause_group("group_chat_suspected" if any(item.chat_type == "private" for item in exact)
                                   else "group_chat_unsupported")
            # 低质量文字只允许保守判群，不能据此查询绑定或授予私聊身份。
            if quality_failure is not None:
                return quality_failure
            if len(candidates) >= 51:
                if member_suffix:
                    return pause_group()
                return FreshForegroundObservation.create(
                    phase="manual-required", reason="session_candidates_truncated",
                    probe_available=True, wechat_in_front=True,
                    observed_at=observation.captured_at,
                    **recognized,
                )
            if len(exact) != 1 or exact[0].chat_type != "private":
                if member_suffix:
                    return pause_group()
                return FreshForegroundObservation.create(
                    phase="manual-required", reason="ambiguous_requires_selection",
                    probe_available=True, wechat_in_front=True,
                    observed_at=observation.captured_at,
                    **recognized,
                )
            if check_current is not None:
                check_current()
            bindings = self._bindings.list_active_bindings(
                owner_id=self._owner_id, channel=self._channel,
                account_scope=self._account_scope, bounded=True,
            )
            if monotonic() >= deadline:
                raise TimeoutError
        except TimeoutError:
            if member_suffix:
                return pause_group()
            if quality_failure is not None:
                return quality_failure
            return FreshForegroundObservation.create(
                phase="unavailable", reason="observation_timeout",
                probe_available=False, wechat_in_front=True,
                observed_at=observation.captured_at,
            )
        except (CliAdapterError, ConversationBindingPersistenceError):
            if member_suffix:
                return pause_group()
            if quality_failure is not None:
                return quality_failure
            return FreshForegroundObservation.create(
                phase="unavailable", reason="binding_verification_unavailable",
                probe_available=False, wechat_in_front=True,
                observed_at=observation.captured_at,
            )
        if check_current is not None:
            check_current()
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
                    **recognized,
                )
        return FreshForegroundObservation.create(
            phase="manual-required", reason="unmatched_requires_selection",
            probe_available=True, wechat_in_front=True,
            observed_at=observation.captured_at,
            **recognized,
        )

    def _observe_emoji_fallback(
        self, observation: FrontSessionProbeObservation, *, deadline: float,
        check_current: Callable[[], None] | None, recognized: dict, member_suffix: bool,
    ) -> FreshForegroundObservation:
        """只以全会话前缀消歧核验已有绑定，不用原始误识别文本授予身份。"""

        def result(phase: str, reason: str) -> FreshForegroundObservation:
            return FreshForegroundObservation.create(
                phase=phase, reason=reason, probe_available=phase != "unavailable",
                wechat_in_front=True, observed_at=observation.captured_at,
                **(recognized if phase == "manual-required" else {}),
            )

        if member_suffix:
            return result("paused", "group_chat_suspected")
        fallback = observation.text_fallback
        quality = observation.quality
        if (fallback is None or quality is None or quality.capture_version != "automatic-header-v4"
                or quality.name_complete is not True or observation.captured_at is None
                or observation.evidence is None or not recognized
                or fallback.text_complete is not True or fallback.mask_verified is not True
                or fallback.confidence < 0.90
                or fallback.text != normalize_display_text(fallback.text)):
            return result("manual-required", "quality_unverified")
        prefix = fallback.text
        if re.search(r"[（(]\s*[0-9０-９]+\s*[）)]\s*$", prefix):
            return result("paused", "group_chat_suspected")
        remaining = deadline - monotonic()
        if remaining <= 0:
            return result("unavailable", "observation_timeout")
        try:
            if check_current is not None:
                check_current()
            candidates = self._cli.sessions(
                keyword=None, type_filter="all", limit=5000,
                timeout_seconds=min(0.25, remaining),
            )
            if monotonic() >= deadline:
                raise TimeoutError
            matching = tuple(item for item in candidates
                             if normalize_display_text(item.display_name).startswith(prefix))
            if any(item.chat_type == "group" for item in matching):
                return result("paused", "group_chat_suspected")
            if len(candidates) >= 5000:
                return result("manual-required", "session_candidates_truncated")
            if len(matching) != 1 or matching[0].chat_type != "private":
                return result("manual-required", "ambiguous_requires_selection")
            candidate = matching[0]
            full_name = normalize_display_text(candidate.display_name)
            if (not isinstance(candidate.username, str) or not candidate.username.strip()
                    or sum(item.username == candidate.username for item in candidates) != 1
                    or candidate.display_name != candidate.display_name.rstrip()
                    or not has_supported_emoji_suffix(full_name, prefix)):
                return result("manual-required", "unmatched_requires_selection")
            if check_current is not None:
                check_current()
            bindings = self._bindings.list_active_bindings(
                owner_id=self._owner_id, channel=self._channel,
                account_scope=self._account_scope, bounded=True,
            )
            if monotonic() >= deadline:
                raise TimeoutError
        except TimeoutError:
            return result("unavailable", "observation_timeout")
        except (CliAdapterError, ConversationBindingPersistenceError):
            return result("unavailable", "binding_verification_unavailable")
        if check_current is not None:
            check_current()
        active = tuple(item for item in bindings if item.conversation_locator == candidate.username)
        if len(active) == 1:
            binding = active[0]
            if (binding.scope.owner_id == self._owner_id and binding.channel == self._channel
                    and binding.account_scope == self._account_scope and binding.status == "active"
                    and normalize_display_text(binding.display_name) == full_name):
                return FreshForegroundObservation.create(
                    phase="confirmed", reason="confirmed_active_binding_emoji_fallback",
                    probe_available=True, wechat_in_front=True,
                    binding_id=binding.binding_id, contact_id=binding.scope.contact_id,
                    observed_at=observation.captured_at, **recognized,
                )
        return result("manual-required", "unmatched_requires_selection")

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
