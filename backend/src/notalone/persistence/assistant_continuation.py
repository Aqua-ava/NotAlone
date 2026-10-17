"""A会话内解析与普通领取共用一个owner事务；版本正文不另建副本。"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Any
from uuid import UUID

from notalone.application.assistant_continuation import (
    AssistantContinuationClarification, AssistantContinuationInvalid, AssistantContinuationReplyRequest,
    AssistantContinuationReservation, ContinueAssistantSession, continuation_reference,
    continuation_submission, requirement_clauses, resolve_requirements,
)
from notalone.application.assistant_session_service import AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionRejected
from notalone.application.reply_service import ReplyServiceRequest
from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.application.reply_request import parse_reply_request
from notalone.persistence.assistant_candidate_versions import (
    AssistantCandidateHistory, AssistantCandidateVersion, AssistantCandidateVersionError, read_candidate_versions,
)
from notalone.persistence.assistant_session_inputs import require_current_input
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.assistant_continuation_reference import AssistantContinuationReference
from notalone.reply.interface import AccumulatedReplyRequirements, ConfirmedDirection, DirectionSource, InitiateConversation, ReplyInput, ReplyToMessage, RewriteDraft
from notalone.scopes import ContactScope


def _frame_histories(
    connection: Any, scope: ContactScope, session_id: UUID, command: ContinueAssistantSession,
) -> dict[int, tuple[AssistantCandidateHistory, AssistantCandidateVersion]]:
    frame = command.displayed_group
    if frame.session_id != session_id:
        raise AssistantContinuationClarification("candidate_session_mismatch")
    numbers = [item.number for item in frame.candidates]
    candidates = [item.candidate_id for item in frame.candidates]
    if not candidates:
        raise AssistantContinuationClarification("candidate_group_missing")
    if len(set(numbers)) != len(numbers) or len(set(candidates)) != len(candidates):
        raise AssistantContinuationClarification("candidate_frame_ambiguous")
    members = connection.execute(
        "SELECT candidate.id,candidate.ordinal FROM public.reply_candidate AS candidate "
        "JOIN public.assistant_session_turn AS turn ON turn.reply_request_id=candidate.reply_request_id "
        "AND turn.owner_id=candidate.owner_id AND turn.contact_id=candidate.contact_id "
        "AND turn.conversation_binding_id=candidate.conversation_binding_id "
        "WHERE candidate.owner_id=%s AND candidate.contact_id=%s AND turn.session_id=%s "
        "AND candidate.reply_request_id=%s",
        (scope.owner_id, scope.contact_id, session_id, frame.candidate_group_id),
    ).fetchall()
    if {(row["ordinal"] + 1, row["id"]) for row in members} != set(zip(numbers, candidates)):
        raise AssistantContinuationClarification("candidate_group_unavailable")
    histories = {}
    for item in frame.candidates:
        try:
            history = read_candidate_versions(connection, scope, session_id, item.candidate_id)
        except AssistantCandidateVersionError:
            raise AssistantContinuationClarification("candidate_version_unavailable") from None
        if (history.candidate_group_id, history.candidate_number) != (frame.candidate_group_id, item.number):
            raise AssistantContinuationClarification("candidate_frame_ambiguous")
        version = next((version for version in history.versions if version.version_id == item.version_id), None)
        if version is None:
            raise AssistantContinuationClarification("candidate_version_unavailable")
        histories[item.number] = history, version
    return histories


def _request_from_input(scope: ContactScope, key: UUID, payload: dict[str, Any]):
    metadata = payload.get("continuation")
    content = dict(payload["content"])
    suggestion = content.pop("suggestion", None)
    payload = {**payload, "content": content, "suggestion": suggestion}
    accumulated = None
    if isinstance(metadata, dict):
        requirements = metadata.get("effective_requirements")
        if not isinstance(requirements, list) or not isinstance(content, dict):
            raise AssistantContinuationInvalid("持续要求记录无效。")
        accumulated = AccumulatedReplyRequirements(tuple(requirements)) if requirements else None
        if content.get("user_instruction") != accumulated:
            raise AssistantContinuationInvalid("持续要求记录不一致。")
        # 只复原同事务内的权威累积要求，其余字段继续经过原公开结构解析。
        payload = {**payload, "content": {**content, "user_instruction": None}}
    _, request = parse_reply_request(json.dumps({
        **payload, "contact_id": str(scope.contact_id), "idempotency_key": str(key),
    }, ensure_ascii=False).encode("utf-8"))
    if isinstance(metadata, dict):
        request = replace(request, content=replace(request.content, user_instruction=accumulated))
    return request


def _reference_from_metadata(
    connection: Any, scope: ContactScope, session_id: UUID, metadata: dict[str, Any],
) -> AssistantContinuationReference | None:
    candidate_id = metadata["candidate_id"]
    if candidate_id is None:
        return None
    try:
        history = read_candidate_versions(connection, scope, session_id, UUID(candidate_id))
        version = next((version for version in history.versions if str(version.version_id) == metadata["version_id"]), None)
    except (AssistantCandidateVersionError, TypeError, ValueError):
        raise AssistantContinuationClarification("candidate_version_unavailable") from None
    if version is None:
        raise AssistantContinuationClarification("candidate_version_unavailable")
    return AssistantContinuationReference(history.candidate_id, version.version_id, version.messages)


def restore_prepared_reply_request(
    connection: Any, scope: ContactScope, session_id: UUID, key: UUID, payload: dict[str, Any],
) -> ReplyServiceRequest:
    """固定准备复原真实继续身份，并在同范围事务内重验所选版本正文。"""
    request = _request_from_input(scope, key, payload)
    metadata = payload.get("continuation")
    if not isinstance(metadata, dict):
        return request
    # 普通继续提交当前版本；中断恢复提交原版本，二者均来自已保存的会话身份。
    try:
        submission = metadata["submission"]
        version_field = ("expected_input_version_id" if "expected_input_version_id" in submission
                         else "original_input_version_id")
        expected_version = UUID(submission[version_field])
    except (KeyError, TypeError, ValueError, AttributeError):
        raise AssistantContinuationInvalid("持续要求输入版本记录无效。") from None
    return AssistantContinuationReplyRequest(
        idempotency_key=key, content=request.content,
        continued_from_candidate_id=request.continued_from_candidate_id,
        skill_version_id=request.skill_version_id, skill_disabled=request.skill_disabled,
        scene=request.scene, suggestion=request.suggestion,
        expected_input_version_id=expected_version,
        continuation=metadata,
        reference=_reference_from_metadata(connection, scope, session_id, metadata),
    )


def _known_intention(instruction: str) -> str | None:
    match = re.fullmatch(r"(?:还是|改为|改口[:：]?)(答应|拒绝|同意|不去)(?:吧)?[。！!]?", instruction)
    return match.group(1) if match else None


def require_continuation_policy(connection: Any, scope: ContactScope, payload: dict[str, Any]) -> None:
    """已经准备或中断的无编号继续也保留原候选组的政策边界。"""
    metadata = payload.get('continuation')
    group = metadata.get('candidate_group_id') if isinstance(metadata, dict) else None
    if group is not None:
        from notalone.persistence.skill_execution_view import saved_skill_policy_change
        try:
            identifier = UUID(group)
        except (ValueError, TypeError, AttributeError):
            raise AssistantSessionRejected('skill_policy_changed') from None
        if saved_skill_policy_change(connection, scope, identifier) is not None:
            raise AssistantSessionRejected('skill_policy_changed')


def reserve_continuation_in_transaction(
    connection: Any, store: PostgresAssistantSessionStore, scope: ContactScope, session_id: UUID,
    command: ContinueAssistantSession,
) -> AssistantContinuationReservation:
    submission = continuation_submission(command)
    store._require_session(connection, scope, session_id)
    existing = connection.execute(
        "SELECT id,session_id,state,input_payload FROM public.assistant_session_turn "
        "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, command.idempotency_key),
    ).fetchone()
    if existing is not None:
        if existing["state"] == "redacted" or existing["input_payload"] is None:
            raise AssistantSessionRejected("source_deleted")
        metadata = existing["input_payload"].get("continuation")
        if (existing["session_id"] != session_id or not isinstance(metadata, dict)
                or metadata.get("submission") != submission):
            raise AssistantSessionConflict("请求键已用于不同的持续要求。")
        require_continuation_policy(connection, scope, existing['input_payload'])
        original = _request_from_input(scope, command.idempotency_key, existing["input_payload"])
        request = AssistantContinuationReplyRequest(
            idempotency_key=command.idempotency_key, content=original.content,
            continued_from_candidate_id=original.continued_from_candidate_id,
            skill_version_id=original.skill_version_id, skill_disabled=original.skill_disabled,
            scene=original.scene,
            suggestion=original.suggestion,
            expected_input_version_id=command.expected_input_version_id,
            continuation=metadata,
            reference=_reference_from_metadata(connection, scope, session_id, metadata),
        )
        return AssistantContinuationReservation(store._reserve_in_transaction(connection, scope, session_id, request), request)
    # 首次解析、当前输入CAS、来源与领取均在同一个owner事务中完成。
    current_dependencies = require_current_input(connection, scope, session_id, command.expected_input_version_id)
    current = connection.execute(
        "SELECT id,state,input_payload,dependency_ids,reply_request_id FROM public.assistant_session_turn "
        "WHERE owner_id=%s AND contact_id=%s "
        "AND session_id=%s AND input_version_id=%s",
        (scope.owner_id, scope.contact_id, session_id, command.expected_input_version_id),
    ).fetchone()
    if current is None or current["state"] != "completed" or current["input_payload"] is None:
        raise AssistantContinuationClarification("completed_generation_required")
    if current["reply_request_id"] is None:
        raise AssistantContinuationClarification("completed_generation_required")
    from notalone.persistence.skill_execution_view import saved_skill_policy_change
    if saved_skill_policy_change(connection, scope, current['reply_request_id']) is not None:
        raise AssistantSessionRejected('skill_policy_changed')
    # 无编号的下一轮也从当前已完成输入派生，不能把复制的候选正文变为独立用户稿。
    inherited_dependencies = tuple(sorted(set(current_dependencies) | require_reply_sources_current(
        connection, owner_id=scope.owner_id, request_id=current["reply_request_id"],
        historical=True,
    )))
    histories = _frame_histories(connection, scope, session_id, command)
    number, instruction = continuation_reference(command.instruction)
    if number is not None and number not in histories:
        raise AssistantContinuationClarification("candidate_number_missing")
    selected = histories.get(number) if number is not None else None
    payload = current["input_payload"]
    original = _request_from_input(scope, command.idempotency_key, payload)
    old_content = original.content
    pasted = isinstance(old_content, RewriteDraft) and old_content.input_kind == "current_chat"
    intent_field = "direction" if isinstance(old_content, ReplyToMessage) or pasted else "purpose" if isinstance(old_content, InitiateConversation) else "draft_text"
    prior_intent = (old_content.direction.text if isinstance(old_content, ReplyToMessage)
                    else old_content.purpose.text if isinstance(old_content, InitiateConversation) else old_content.pasted_direction if pasted else old_content.draft_text)
    instruction_intention = _known_intention(instruction)
    if instruction_intention is not None and command.intention_update is not None:
        # 同次提交没有字段优先约定；仅核对既有明确语法，不推断未知方向。
        canonical = {"答应": "accept", "同意": "accept", "拒绝": "decline", "不去": "decline"}
        update_intention = _known_intention(command.intention_update) or command.intention_update
        if (canonical.get(update_intention) is not None
                and canonical[instruction_intention] != canonical[update_intention]):
            raise AssistantContinuationClarification("intention_conflict")
    intention = command.intention_update or instruction_intention
    if intention is not None and (instruction_intention is not None or instruction == intention):
        instruction = ""
    prior_metadata = payload.get("continuation")
    previous = (tuple(prior_metadata["effective_requirements"]) if isinstance(prior_metadata, dict)
                else requirement_clauses(old_content.user_instruction))
    if selected is not None:
        previous = tuple(dict.fromkeys((*previous, *requirement_clauses(selected[1].requirements))))
    requirements = resolve_requirements(previous, instruction, command.requirement_changes,
                                        intention_changed=intention is not None and intention != prior_intent)
    user_instruction = AccumulatedReplyRequirements(requirements) if requirements else None
    reference = (AssistantContinuationReference(selected[0].candidate_id, selected[1].version_id, selected[1].messages)
                 if selected is not None else None)
    content: ReplyInput
    if intention is not None:
        if isinstance(old_content, ReplyToMessage):
            content = replace(old_content, direction=ConfirmedDirection(intention, DirectionSource.DIRECT_INPUT),
                              user_instruction=user_instruction, clarification_answer=None)
        elif isinstance(old_content, InitiateConversation):
            content = replace(old_content, purpose=ConfirmedDirection(intention, DirectionSource.DIRECT_INPUT),
                              user_instruction=user_instruction, clarification_answer=None)
        else:
            content = (replace(old_content, pasted_direction=intention, user_instruction=user_instruction) if pasted else
                       RewriteDraft(intention, user_instruction, old_content.include_relationship_context))
    else:
        # 编号只选择说法参考；旧候选不能替换本次明确意愿或用户原句。
        content = replace(old_content, user_instruction=user_instruction)
    metadata = {
        "version": 1, "submission": submission,
        "candidate_group_id": str(command.displayed_group.candidate_group_id),
        "candidate_number": number,
        "candidate_id": str(reference.candidate_id) if reference is not None else None,
        "version_id": str(reference.version_id) if reference is not None else None,
        "effective_intent": {"source": intent_field},
        "effective_requirements": list(requirements), "intention_changed": intention is not None,
        "scope": "this_assistant_session_only",
    }
    request = AssistantContinuationReplyRequest(
        idempotency_key=command.idempotency_key, content=content,
        continued_from_candidate_id=reference.candidate_id if reference is not None else None,
        skill_version_id=original.skill_version_id, skill_disabled=original.skill_disabled,
        scene=original.scene,
        suggestion=original.suggestion if intention is None else None,
        expected_input_version_id=command.expected_input_version_id,
        continuation=metadata, reference=reference,
    )
    turn_id = store._reserve_in_transaction(
        connection, scope, session_id, request, inherited_dependencies=inherited_dependencies,
    )
    return AssistantContinuationReservation(turn_id, request)


class PostgresAssistantContinuationStore:
    """沿用唯一A普通reserve与其事务；不会另立来源或当前输入权威。"""

    def __init__(self, database_url: str) -> None:
        self._store = PostgresAssistantSessionStore(database_url)

    def reserve_continuation(
        self, scope: ContactScope, session_id: UUID, command: ContinueAssistantSession,
    ) -> AssistantContinuationReservation:
        with self._store._transaction(scope) as connection:
            return reserve_continuation_in_transaction(connection, self._store, scope, session_id, command)

    def prepare_continuation(
        self, scope: ContactScope, session_id: UUID, command: ContinueAssistantSession,
    ) -> AssistantGenerationReceipt:
        from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
        from notalone.persistence.assistant_preparation_rejection import (
            has_generation_key, prepare_generation_in_transaction,
        )
        with self._store._transaction(scope) as connection:
            def reserve() -> AssistantGenerationReceipt:
                reserved = reserve_continuation_in_transaction(connection, self._store, scope, session_id, command)
                return self._store._prepared_receipt(connection, scope, session_id, reserved.turn_id)
            try:
                prepared = prepare_generation_in_transaction(connection, scope, session_id, command.idempotency_key, reserve)
            except AssistantContinuationClarification:
                # 合法澄清仍可同键确认；已领取的同键却不能被澄清伪装成零生成。
                if has_generation_key(connection, scope, command.idempotency_key):
                    raise AssistantSessionConflict("本次生成身份尚未确认。") from None
                raise
        if isinstance(prepared, AssistantPreparationRejected):
            raise prepared
        return prepared
