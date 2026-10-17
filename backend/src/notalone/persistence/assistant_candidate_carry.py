"""携入只保存精确候选来历；正文逐次从原权威版本读取。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.assistant_candidate_carry import (
    CandidateCarryOrigin, CarriedAssistantSession, CarryAssistantCandidate,
    carry_origin_from_payload, carry_origin_to_payload,
)
from notalone.application.assistant_session_service import (
    AssistantSessionNotFound, AssistantSessionPersistenceError, AssistantSessionRejected,
)
from notalone.persistence.assistant_candidate_versions import (
    AssistantCandidateHistory, AssistantCandidateVersion, AssistantCandidateVersionConflict,
    AssistantCandidateVersionError, AssistantCandidateVersionNotFound,
    _messages, read_candidate_selection, read_candidate_versions,
)
from notalone.persistence.assistant_session_inputs import (
    require_input_session, verified_discussion_dependencies,
)
from notalone.persistence.assistant_session_store import (
    _active_binding, _partition_assistant_dependencies, _reply_dependencies,
)
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.reply_discussion_dependencies import reply_style_sample_dependencies
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.assistant_discussion import DiscussionDependencies
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import CandidateMessage, ReplyBasisChange
from notalone.scopes import ContactScope

if TYPE_CHECKING:
    from notalone.persistence.assistant_input_lineage import AssistantCarryInputLineage


@dataclass(frozen=True, slots=True, repr=False)
class ResolvedCandidateCarry:
    origin: CandidateCarryOrigin
    messages: tuple[CandidateMessage, ...]
    candidate_number: int
    version_number: int
    parent_version_id: UUID | None
    dependencies: DiscussionDependencies
    basis_changes: tuple[ReplyBasisChange, ...] = ()

    def content_payload(self) -> dict[str, Any]:
        """仅供当前公开读取；该正文投影不得重新保存成来历记录。"""

        return {
            **carry_origin_to_payload(self.origin),
            "messages": [{"message_id": str(message.message_id), "text": message.text}
                         for message in self.messages],
        }


def _messages_fingerprint(messages: tuple[CandidateMessage, ...]) -> str:
    payload = [{"message_id": str(message.message_id), "text": message.text} for message in messages]
    # 复用讨论权威的规范化指纹，携入不另建摘要算法。
    from notalone.persistence.assistant_discussion_context import _fingerprint
    return _fingerprint(payload)


def _history(
    connection: Any, scope: ContactScope, session_id: UUID, candidate_id: UUID,
) -> AssistantCandidateHistory:
    try:
        return read_candidate_versions(connection, scope, session_id, candidate_id)
    except AssistantCandidateVersionNotFound:
        raise AssistantSessionNotFound("指定范围内不存在可携入候选。") from None
    except AssistantCandidateVersionConflict as error:
        raise AssistantSessionRejected(error.reason) from None
    except AssistantCandidateVersionError:
        raise AssistantSessionPersistenceError("候选来历未可靠读取。") from None


def _version(history: AssistantCandidateHistory, version_id: UUID) -> AssistantCandidateVersion:
    version = next((item for item in history.versions if item.version_id == version_id), None)
    if version is None:
        raise AssistantSessionNotFound("指定范围内不存在可携入版本。")
    return version


def _origin_dependencies(
    connection: Any, scope: ContactScope, history: AssistantCandidateHistory,
) -> tuple[DiscussionDependencies, UUID, UUID]:
    """来源与样本仅消费既有 A/C 端口，不另建捕获或删除权威。"""

    from notalone.persistence.skill_execution_view import saved_skill_policy_change
    if saved_skill_policy_change(connection, scope, history.candidate_group_id) is not None:
        raise AssistantSessionRejected('skill_policy_changed')

    with connection.cursor(row_factory=dict_row) as cursor:
        turn = cursor.execute(
            "SELECT conversation_binding_id, input_version_id, dependency_ids FROM public.assistant_session_turn "
            "WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND id=%s "
            "AND reply_request_id=%s AND state='completed'",
            (scope.owner_id, scope.contact_id, history.session_id, history.turn_id,
             history.candidate_group_id),
        ).fetchone()
        if turn is None:
            raise AssistantSessionRejected("candidate_unavailable")
        try:
            dependencies = set(turn["dependency_ids"])
            dependencies.update(require_reply_sources_current(
                cursor, owner_id=scope.owner_id, request_id=history.candidate_group_id,
                historical=True,
            ))
            dependencies.update(_reply_dependencies(cursor, scope, history.candidate_group_id))
            typed = _partition_assistant_dependencies(cursor, scope, dependencies)
            sources = verified_discussion_dependencies(cursor, scope, typed.source_ids, historical=True)
            samples = tuple(sorted(set(typed.style_sample_ids) | set(
                reply_style_sample_dependencies(connection, scope, history.candidate_group_id),
            )))
        except ReplyStoreInvariantError:
            raise AssistantSessionRejected("source_unavailable") from None
        return (DiscussionDependencies(tuple(sorted(sources)), samples),
                turn["conversation_binding_id"], turn["input_version_id"])


def read_candidate_carry_in_transaction(
    connection: Any, scope: ContactScope, content: object,
    *, dependency_ids: tuple[UUID, ...], conversation_binding_id: UUID,
) -> ResolvedCandidateCarry:
    """调用方持有 owner 锁；精确父版本仍有效才返回其完整消息组。"""

    try:
        origin = carry_origin_from_payload(content)
    except ValueError:
        raise AssistantSessionPersistenceError("携入来历记录无效。") from None
    if (origin.origin_owner_id, origin.origin_contact_id, origin.origin_binding_id) != (
        scope.owner_id, scope.contact_id, conversation_binding_id,
    ):
        raise AssistantSessionRejected("candidate_unavailable")
    history = _history(connection, scope, origin.origin_session_id, origin.origin_candidate_id)
    if (history.turn_id, history.candidate_group_id) != (
        origin.origin_turn_id, origin.origin_reply_request_id,
    ):
        raise AssistantSessionRejected("candidate_unavailable")
    with connection.cursor(row_factory=dict_row) as cursor:
        selection = cursor.execute(
            "SELECT 1 FROM public.assistant_candidate_selection "
            "WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND id=%s "
            "AND candidate_id=%s AND version_id=%s",
            (scope.owner_id, scope.contact_id, origin.origin_session_id, origin.origin_selection_id,
             origin.origin_candidate_id, origin.origin_version_id),
        ).fetchone()
    if selection is None:
        raise AssistantSessionRejected("candidate_unavailable")
    version = _version(history, origin.origin_version_id)
    if _messages_fingerprint(version.messages) != origin.payload_sha256:
        raise AssistantSessionRejected("candidate_unavailable")
    dependencies, binding_id, input_version_id = _origin_dependencies(connection, scope, history)
    if (binding_id != conversation_binding_id
            or input_version_id != origin.origin_input_version_id
            or dependencies.source_ids != tuple(sorted(set(dependency_ids)))
            or dependencies.style_sample_ids != origin.style_sample_ids):
        raise AssistantSessionRejected("source_unavailable")
    return ResolvedCandidateCarry(origin, version.messages, history.candidate_number,
                                  version.version_number, version.parent_version_id, dependencies,
                                  history.basis_changes)


def new_assistant_session_with_candidate(
    connection: Any, scope: ContactScope, session_id: UUID, command: CarryAssistantCandidate,
) -> CarriedAssistantSession:
    """同一事务完成当前选择复验和新会话写入；不预留任务或调用模型。"""

    if (not isinstance(scope, ContactScope) or not isinstance(session_id, UUID)
            or not isinstance(command, CarryAssistantCandidate)):
        raise ValueError("携候选请求结构无效。")
    CarryAssistantCandidate.__post_init__(command)
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        require_input_session(cursor, scope, session_id)
        binding_id = _active_binding(cursor, scope)
    try:
        selection = read_candidate_selection(connection, scope, session_id)
    except AssistantCandidateVersionNotFound:
        raise AssistantSessionNotFound("指定范围内不存在可携入候选。") from None
    except AssistantCandidateVersionConflict as error:
        raise AssistantSessionRejected(error.reason) from None
    except AssistantCandidateVersionError:
        raise AssistantSessionPersistenceError("候选选择未可靠读取。") from None
    if selection is None:
        raise AssistantSessionRejected("candidate_not_selected")
    if (selection.selection_id, selection.candidate_id, selection.version_id) != (
        command.expected_selection_id, command.candidate_id, command.version_id,
    ):
        raise AssistantSessionRejected("selection_stale")
    history = _history(connection, scope, session_id, command.candidate_id)
    version = _version(history, command.version_id)
    dependencies, origin_binding_id, origin_input_version_id = _origin_dependencies(connection, scope, history)
    if origin_binding_id != binding_id:
        raise AssistantSessionRejected("binding_changed")
    origin = CandidateCarryOrigin(
        scope.owner_id, scope.contact_id, binding_id, session_id, origin_input_version_id,
        history.turn_id, history.candidate_group_id, history.candidate_id,
        version.version_id, selection.selection_id, _messages_fingerprint(version.messages),
        dependencies.style_sample_ids,
    )
    # 复用目录的唯一新会话 writer；局部导入避免目录适配器的组合循环。
    from notalone.persistence.assistant_session_catalog import new_assistant_session_in_transaction
    with connection.cursor(row_factory=dict_row) as cursor:
        new_session_id = new_assistant_session_in_transaction(cursor, scope)
        row = cursor.execute(
            "INSERT INTO public.assistant_session_input "
            "(session_id, owner_id, contact_id, conversation_binding_id, input_type, content, dependency_ids) "
            "VALUES (%s,%s,%s,%s,'candidate_carry',%s,%s) RETURNING id",
            (new_session_id, scope.owner_id, scope.contact_id, binding_id,
             Jsonb(carry_origin_to_payload(origin)), list(dependencies.source_ids)),
        ).fetchone()
        cursor.execute(
            "UPDATE public.assistant_session SET current_input_version_id=%s, updated_at=now() "
            "WHERE owner_id=%s AND contact_id=%s AND id=%s",
            (row["id"], scope.owner_id, scope.contact_id, new_session_id),
        )
        return CarriedAssistantSession(new_session_id, row["id"])


def read_candidate_carry_lineage_for_deletion(
    connection: Any, *, owner_id: UUID,
) -> tuple[AssistantCarryInputLineage, ...]:
    """同事务只核验真实携入父边；不授予当前来源读取或生成资格。

    删除中的原始来源或样本已经不可用，不能用当前可用性拒绝识别删除边。
    边只交 A 唯一无正文 selector，C 仍独立决定真实来源及消费记录的删除根。
    """

    from notalone.persistence.assistant_input_lineage import AssistantCarryInputLineage

    if not isinstance(owner_id, UUID):
        raise ValueError("携入输入来源身份无效。")
    raw = getattr(connection, "connection", connection)
    lock_owner_scope(raw, owner_id=owner_id)
    edges: list[AssistantCarryInputLineage] = []
    with raw.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            "SELECT id, owner_id, contact_id, conversation_binding_id, session_id, content "
            "FROM public.assistant_session_input WHERE owner_id=%s "
            "AND input_type='candidate_carry' AND state='active' ORDER BY id",
            (owner_id,),
        ).fetchall()
        for row in rows:
            try:
                origin = carry_origin_from_payload(row["content"])
            except ValueError:
                raise AssistantSessionPersistenceError("携入来历记录无效，尚未可靠清理。") from None
            if ((origin.origin_owner_id, origin.origin_contact_id, origin.origin_binding_id) != (
                    row["owner_id"], row["contact_id"], row["conversation_binding_id"],
                ) or origin.origin_session_id == row["session_id"]):
                raise AssistantSessionPersistenceError("携入范围关联无效，尚未可靠清理。")
            parent = cursor.execute(
                "SELECT CASE WHEN version.version_number=0 THEN candidate.message_group "
                "ELSE version.message_group END AS message_group "
                "FROM public.assistant_session_input AS parent "
                "JOIN public.assistant_session_turn AS turn ON turn.id=parent.turn_id "
                "AND turn.input_version_id=parent.id AND turn.owner_id=parent.owner_id "
                "AND turn.contact_id=parent.contact_id AND turn.session_id=parent.session_id "
                "AND turn.conversation_binding_id=parent.conversation_binding_id "
                "JOIN public.reply_request AS request ON request.id=turn.reply_request_id "
                "AND request.idempotency_key=turn.idempotency_key AND request.owner_id=turn.owner_id "
                "AND request.contact_id=turn.contact_id AND request.conversation_binding_id=turn.conversation_binding_id "
                "JOIN public.reply_candidate AS candidate ON candidate.reply_request_id=request.id "
                "AND candidate.owner_id=request.owner_id AND candidate.contact_id=request.contact_id "
                "AND candidate.conversation_binding_id=request.conversation_binding_id "
                "JOIN public.assistant_candidate_version AS version ON version.candidate_id=candidate.id "
                "AND version.owner_id=parent.owner_id AND version.contact_id=parent.contact_id "
                "AND version.session_id=parent.session_id AND version.turn_id=turn.id "
                "JOIN public.assistant_candidate_selection AS selection ON selection.version_id=version.id "
                "AND selection.candidate_id=candidate.id AND selection.session_id=parent.session_id "
                "AND selection.owner_id=parent.owner_id AND selection.contact_id=parent.contact_id "
                "WHERE parent.owner_id=%s AND parent.contact_id=%s AND parent.conversation_binding_id=%s "
                "AND parent.session_id=%s AND parent.id=%s AND turn.id=%s AND request.id=%s "
                "AND candidate.id=%s AND version.id=%s AND selection.id=%s",
                (origin.origin_owner_id, origin.origin_contact_id, origin.origin_binding_id,
                 origin.origin_session_id, origin.origin_input_version_id, origin.origin_turn_id,
                 origin.origin_reply_request_id, origin.origin_candidate_id, origin.origin_version_id,
                 origin.origin_selection_id),
            ).fetchone()
            if parent is None or _messages_fingerprint(_messages(parent["message_group"])) != origin.payload_sha256:
                raise AssistantSessionPersistenceError("携入父版本关联无效，尚未可靠清理。")
            edges.append(AssistantCarryInputLineage(
                ContactScope(row["owner_id"], row["contact_id"]), row["conversation_binding_id"],
                row["id"], origin.origin_input_version_id,
            ))
    return tuple(edges)
