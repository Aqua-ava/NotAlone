"""同owner事务恢复当前完整要求并复用唯一reserve，不复制用户候选为新稿。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from uuid import UUID

from notalone.application.assistant_continuation import AssistantContinuationReservation
from notalone.application.assistant_continuation_identity import AssistantContinuationInvalid, AssistantContinuationReplyRequest
from notalone.application.reply_service import ReplyServiceRequest
from notalone.application.assistant_message_adoption import AssistantMessageAdoptionRequest
from notalone.application.assistant_session_service import AssistantSessionConflict, AssistantSessionRejected
from notalone.persistence.assistant_continuation import _request_from_input
from notalone.persistence.assistant_session_inputs import require_current_input
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore, _expand_message_sources
from notalone.reply.interface import AccumulatedReplyRequirements, ReplyToMessage
from notalone.scopes import ContactScope


def reserve_message_adoption_in_transaction(
    connection: Any, store: PostgresAssistantSessionStore, scope: ContactScope, session_id: UUID,
    command: AssistantMessageAdoptionRequest, running_request_key: UUID | None = None,
) -> AssistantContinuationReservation:
    store._require_session(connection, scope, session_id)
    existing = connection.execute(
        "SELECT session_id,state,input_payload FROM public.assistant_session_turn "
        "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, command.idempotency_key),
    ).fetchone()
    dependencies: set[UUID] = set()
    if existing is not None:
        payload = existing["input_payload"]
        if existing["state"] == "redacted" or not isinstance(payload, dict):
            raise AssistantSessionRejected("source_deleted")
        metadata = payload.get("continuation")
        if (existing["session_id"] != session_id or not isinstance(metadata, dict)
                or metadata.get("message_adoption") != command.submission):
            raise AssistantSessionConflict("采用键已用于不同输入。")
        restored = _restore_request(scope, command, payload)
        content = restored.content
    else:
        if command.expected_input_version_id is None:
            raise AssistantSessionRejected("invalid_message_adoption")
        dependencies.update(require_current_input(connection, scope, session_id, command.expected_input_version_id))
        current = connection.execute(
            "SELECT input_payload FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s "
            "AND session_id=%s AND input_version_id=%s",
            (scope.owner_id, scope.contact_id, session_id, command.expected_input_version_id),
        ).fetchone()
        if current is None or not isinstance(current["input_payload"], dict):
            raise AssistantSessionRejected("invalid_message_adoption")
        payload = current["input_payload"]
        restored = _restore_request(scope, command, payload)
        if type(restored.content) is not type(command.content):
            raise AssistantSessionRejected("invalid_message_adoption")
        previous = payload.get("continuation")
        # 只复原权威元数据并核全文相等；普通短要求沿原声明完整保留。
        requirements = (previous["effective_requirements"] if isinstance(previous, dict)
                        else [restored.content.user_instruction] if restored.content.user_instruction else [])
        accumulated = AccumulatedReplyRequirements(tuple(requirements)) if requirements else None
        content = replace(command.content, user_instruction=accumulated)
        intent_field = "direction" if isinstance(content, ReplyToMessage) else "purpose"
        intent_changed = getattr(restored.content, intent_field).text != getattr(content, intent_field).text
        metadata = {"version": 1, "submission": command.submission, "message_adoption": command.submission,
                    "candidate_group_id": None, "candidate_number": None, "candidate_id": None, "version_id": None,
                    "effective_intent": {"source": intent_field}, "effective_requirements": list(requirements),
                    "intention_changed": intent_changed, "scope": "this_assistant_session_only"}
    # 同键重放也核实际新消息可用性，不能恢复被删来源或跨联系人事件。
    message = connection.execute(
        "SELECT 1 FROM public.message WHERE owner_id=%s AND contact_id=%s AND id=%s",
        (scope.owner_id, scope.contact_id, command.adopt_new_message_id),
    ).fetchone()
    if message is None:
        raise AssistantSessionRejected("target_message_unavailable")
    dependencies.update(_expand_message_sources(connection, scope.owner_id, {command.adopt_new_message_id}))
    request = AssistantContinuationReplyRequest(
        idempotency_key=command.idempotency_key, content=content,
        skill_version_id=command.skill_version_id, skill_disabled=command.skill_disabled,
        scene=command.scene,
        expected_input_version_id=command.expected_input_version_id, continuation=metadata,
    )
    turn_id = store._reserve_in_transaction(connection, scope, session_id, request,
        running_request_key=running_request_key, inherited_dependencies=tuple(sorted(dependencies)))
    return AssistantContinuationReservation(turn_id, request)


def _restore_request(
    scope: ContactScope, command: AssistantMessageAdoptionRequest, payload: dict[str, Any],
) -> ReplyServiceRequest:
    try:
        return _request_from_input(scope, command.idempotency_key, payload)
    except (AssistantContinuationInvalid, ValueError, TypeError, KeyError):
        raise AssistantSessionRejected("invalid_message_adoption") from None
