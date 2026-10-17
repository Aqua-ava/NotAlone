"""原 owner 事务内复验中断身份，沿唯一 A reserve 还原完整输入。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from uuid import UUID

from notalone.application.assistant_continuation import AssistantContinuationReservation
from notalone.application.assistant_continuation_identity import AssistantContinuationReplyRequest
from notalone.application.assistant_interrupted_recovery import RecoverInterruptedAssistantGeneration
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionRejected,
)
from notalone.persistence.assistant_continuation import _reference_from_metadata, _request_from_input, require_continuation_policy
from notalone.persistence.assistant_generation_lifecycle import interrupt_generation_in_transaction, require_interruption_input
from notalone.persistence.assistant_session_inputs import require_current_input
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore, _active_binding, captured_generation_dependencies
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import DirectionSource, InitiateConversation, ReplyToMessage, SuggestionReference
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
    if original["state"] != "failed" or original["interruption_reason"] not in ("app_quit", "configuration_reload"):
        raise AssistantSessionRejected("generation_not_interrupted")
    if command.request_key == original["idempotency_key"]:
        raise AssistantSessionRejected("generation_interrupted")
    if original["input_payload"] is None:
        raise AssistantSessionRejected("source_deleted")
    require_continuation_policy(connection, scope, original['input_payload'])
    binding_id = require_interruption_input(
        connection, scope, session_id, original["id"], original["idempotency_key"], original["input_version_id"],
    )
    if _active_binding(connection, scope) != binding_id:
        raise AssistantSessionRejected("binding_changed")
    terminal = interrupt_generation_in_transaction(
        connection, scope, session_id, original["idempotency_key"], original["input_version_id"],
        complete_saved=store._complete_saved_in_transaction,
    )
    if terminal.state != "failed" or terminal.interruption_reason != original["interruption_reason"]:
        raise AssistantSessionRejected("generation_not_interrupted")
    # 原失败 turn 尚未填回 C 结果时，仍继承 C 模型前实际捕获的资料和样本。
    try:
        dependencies = set(original["dependency_ids"]) | captured_generation_dependencies(
            connection, scope, original["idempotency_key"], binding_id, original["reply_request_id"],
            historical=True,
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
            intent_field = "direction" if content["type"] == "reply_to_message" or content.get("input_kind") == "current_chat" else (
                "purpose" if content["type"] == "initiate_conversation" else "draft_text")
            metadata = {"version": 1, "submission": command.origin(), "candidate_group_id": None,
                        "candidate_number": None, "candidate_id": None, "version_id": None,
                        "effective_intent": {"source": intent_field},
                        "effective_requirements": [content["user_instruction"]] if content.get("user_instruction") else [],
                        "intention_changed": False, "scope": "this_assistant_session_only"}
        metadata = {**metadata, "recovery": command.origin()}
        payload = {**payload, "continuation": metadata}
    original_request = _request_from_input(scope, command.request_key, payload)
    # 恢复副本也有 continuation；是否重确认由 B 实际执行键与原失败 turn 的绑定决定。
    if (existing is None and original_request.suggestion is not None and connection.execute(
            "SELECT 1 FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s "
            "AND session_id=%s AND id=%s AND request_key=%s",
            (scope.owner_id, scope.contact_id, session_id, original_request.suggestion.task_id,
             original["idempotency_key"]),
    ).fetchone() is not None):
        from notalone.persistence.reply_exploration import PostgresExplorationStore
        from notalone.persistence.retrieval import PostgresRetrieval
        from notalone.reply.exploration import ExplorationError
        from notalone.reply.exploration_context import ExplorationEvidence
        reference = original_request.suggestion
        content = original_request.content
        if not isinstance(content, (ReplyToMessage, InitiateConversation)):
            raise AssistantSessionRejected("exploration_stale")
        intent = content.direction if isinstance(content, ReplyToMessage) else content.purpose
        try:
            task = PostgresExplorationStore(connection.info.dsn, evidence=ExplorationEvidence(
                PostgresRetrieval(connection.info.dsn),
            )).reconfirm_in_transaction(
                connection, scope, session_id, reference.task_id, reference.input_version,
                expected_input_version_id=command.original_input_version_id, request_key=command.request_key,
                suggestion_id=reference.suggestion_id if intent.source == DirectionSource.CONFIRMED_SUGGESTION else None,
                direct_intent=intent.text if intent.source == DirectionSource.DIRECT_INPUT else None,
            )
        except ExplorationError:
            raise AssistantSessionRejected("exploration_stale") from None
        if not isinstance(task.selection_id, UUID):
            raise AssistantSessionRejected("exploration_stale")
        # 新执行身份只由 B 原确认 writer 生成；原明确意愿与资料仍保持原值。
        original_request = replace(original_request,
            suggestion=SuggestionReference(task.exploration_id, task.input_version_id, task.selection_id),
            expected_input_version_id=task.input_version_id)
    request = AssistantContinuationReplyRequest(
        idempotency_key=command.request_key, content=original_request.content,
        continued_from_candidate_id=original_request.continued_from_candidate_id,
        skill_version_id=original_request.skill_version_id, skill_disabled=original_request.skill_disabled,
        scene=original_request.scene,
        expected_input_version_id=original_request.expected_input_version_id or command.original_input_version_id,
        suggestion=original_request.suggestion, continuation=metadata,
        reference=_reference_from_metadata(connection, scope, session_id, metadata),
    )
    turn_id = store._reserve_in_transaction(
        connection, scope, session_id, request, inherited_dependencies=tuple(sorted(dependencies)),
    )
    return AssistantContinuationReservation(turn_id, request)
