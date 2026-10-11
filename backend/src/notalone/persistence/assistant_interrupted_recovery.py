"""原 owner 事务内复验中断身份，沿唯一 A reserve 还原完整输入。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from notalone.application.assistant_continuation import AssistantContinuationReservation
from notalone.application.assistant_continuation_identity import AssistantContinuationReplyRequest
from notalone.application.assistant_interrupted_recovery import RecoverInterruptedAssistantGeneration
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionRejected,
)
from notalone.persistence.assistant_continuation import _reference_from_metadata, _request_from_input
from notalone.persistence.assistant_generation_lifecycle import interrupt_generation_in_transaction, require_interruption_input
from notalone.persistence.assistant_session_inputs import require_current_input
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore, _active_binding, captured_generation_dependencies
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope


def reserve_interrupted_generation_in_transaction(
    connection: Any, store: PostgresAssistantSessionStore, scope: ContactScope, session_id: UUID,
    command: RecoverInterruptedAssistantGeneration,
) -> AssistantContinuationReservation:
    store._require_session(connection, scope, session_id)
    original = connection.execute(
        "SELECT * FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s "
        "AND session_id=%s AND id=%s AND input_version_id=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, session_id, command.original_turn_id, command.original_input_version_id),
    ).fetchone()
    if original is None:
        raise AssistantSessionNotFound("原中断输入不存在。")
    if original["state"] != "failed" or original["interruption_reason"] != "app_quit":
        raise AssistantSessionRejected("generation_not_interrupted")
    if command.request_key == original["idempotency_key"]:
        raise AssistantSessionRejected("generation_interrupted")
    if original["input_payload"] is None:
        raise AssistantSessionRejected("source_deleted")
    binding_id = require_interruption_input(
        connection, scope, session_id, original["id"], original["idempotency_key"], original["input_version_id"],
    )
    if _active_binding(connection, scope) != binding_id:
        raise AssistantSessionRejected("binding_changed")
    terminal = interrupt_generation_in_transaction(
        connection, scope, session_id, original["idempotency_key"], original["input_version_id"],
        complete_saved=store._complete_saved_in_transaction,
    )
    if terminal.state != "failed" or terminal.interruption_reason != "app_quit":
        raise AssistantSessionRejected("generation_not_interrupted")
    # 原失败 turn 尚未填回 C 结果时，仍继承 C 模型前实际捕获的资料和样本。
    try:
        dependencies = set(original["dependency_ids"]) | captured_generation_dependencies(
            connection, scope, original["idempotency_key"], binding_id, original["reply_request_id"],
        )
    except ReplyStoreInvariantError:
        raise AssistantSessionRejected("source_unavailable") from None
    existing = connection.execute(
        "SELECT session_id,input_payload FROM public.assistant_session_turn "
        "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, command.request_key),
    ).fetchone()
    if existing is not None:
        payload = existing["input_payload"]
        metadata = payload.get("continuation") if isinstance(payload, dict) else None
        if (existing["session_id"] != session_id or not isinstance(metadata, dict)
                or metadata.get("recovery") != command.origin()):
            raise AssistantSessionConflict("恢复键已用于不同的原输入。")
    else:
        dependencies.update(require_current_input(connection, scope, session_id, command.original_input_version_id))
        payload = original["input_payload"]
        metadata = payload.get("continuation")
        if not isinstance(metadata, dict):
            content = payload["content"]
            intent_field = "direction" if content["type"] == "reply_to_message" else (
                "purpose" if content["type"] == "initiate_conversation" else "draft_text")
            metadata = {"version": 1, "submission": command.origin(), "candidate_group_id": None,
                        "candidate_number": None, "candidate_id": None, "version_id": None,
                        "effective_intent": {"source": intent_field},
                        "effective_requirements": [content["user_instruction"]] if content.get("user_instruction") else [],
                        "intention_changed": False, "scope": "this_assistant_session_only"}
        metadata = {**metadata, "recovery": command.origin()}
        payload = {**payload, "continuation": metadata}
    original_request = _request_from_input(scope, command.request_key, payload)
    request = AssistantContinuationReplyRequest(
        idempotency_key=command.request_key, content=original_request.content,
        continued_from_candidate_id=original_request.continued_from_candidate_id,
        skill_version_id=original_request.skill_version_id, skill_disabled=original_request.skill_disabled,
        expected_input_version_id=command.original_input_version_id,
        suggestion=original_request.suggestion, continuation=metadata,
        reference=_reference_from_metadata(connection, scope, session_id, metadata),
    )
    turn_id = store._reserve_in_transaction(
        connection, scope, session_id, request, inherited_dependencies=tuple(sorted(dependencies)),
    )
    return AssistantContinuationReservation(turn_id, request)
