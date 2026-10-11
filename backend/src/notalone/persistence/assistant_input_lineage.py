"""A唯一无正文派生输入选择器；来源根与样本有效性仍由C中央守卫裁定。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True)
class AssistantCarryInputLineage:
    """A携入适配器核验实际origin后提供的边；不得从前端普通JSON构造。"""

    scope: ContactScope
    conversation_binding_id: UUID
    input_version_id: UUID
    parent_input_version_id: UUID

    def __post_init__(self) -> None:
        if (not isinstance(self.scope, ContactScope)
                or any(not isinstance(value, UUID) for value in (
                    self.conversation_binding_id, self.input_version_id, self.parent_input_version_id,
                )) or self.input_version_id == self.parent_input_version_id):
            raise ValueError("携入输入来源身份无效。")


@dataclass(frozen=True, slots=True)
class AssistantInputDependents:
    owner_id: UUID
    input_version_ids: tuple[UUID, ...]
    turn_ids: tuple[UUID, ...]
    reply_request_ids: tuple[UUID, ...]


def select_assistant_input_dependents(
    connection: Any, *, owner_id: UUID, removed_ids: set[UUID], reply_request_ids: list[UUID],
    turn_ids: tuple[UUID, ...] = (), contact_id: UUID | None = None,
    carry_edges: tuple[AssistantCarryInputLineage, ...] = (),
) -> AssistantInputDependents:
    """调用方持有owner锁并给出实际C根；只选择实际A输入，不写记录或传播正文。

    13的父边复用首次CURRENT CAS已验证的submission身份，父输入须有实际同范围C请求。
    携入仅接受A适配器已核验origin的类型化边，并再次核对实际candidate_carry输入和父输入；
    候选版本、选择UUID及摘要仍由携入权威核验，不解析普通讨论JSON推断来历。
    """

    if (not isinstance(owner_id, UUID) or not isinstance(carry_edges, tuple)
            or any(not isinstance(edge, AssistantCarryInputLineage) or edge.scope.owner_id != owner_id
                   for edge in carry_edges)):
        raise ValueError("派生输入范围无效。")
    parameters = {
        "owner": owner_id, "removed": list(removed_ids), "requests": reply_request_ids,
        "turns": list(turn_ids), "contact": contact_id,
        "carry": Jsonb([{"child": str(edge.input_version_id), "parent": str(edge.parent_input_version_id),
                         "contact": str(edge.scope.contact_id), "binding": str(edge.conversation_binding_id)}
                        for edge in carry_edges]),
    }
    raw = getattr(connection, "connection", connection)
    with raw.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            """
            WITH RECURSIVE inputs AS (
                SELECT input.id, input.contact_id, input.session_id, input.conversation_binding_id,
                       input.input_type, turn.id AS turn_id, request.id AS request_id,
                       coalesce(turn.dependency_ids,input.dependency_ids) AS dependencies,
                       turn.idempotency_key, turn.input_digest,
                       turn.input_payload->'continuation' AS continuation
                FROM public.assistant_session_input AS input
                LEFT JOIN public.assistant_session_turn AS turn ON turn.id=input.turn_id
                  AND turn.input_version_id=input.id AND turn.owner_id=input.owner_id
                  AND turn.contact_id=input.contact_id AND turn.session_id=input.session_id
                  AND turn.conversation_binding_id=input.conversation_binding_id
                LEFT JOIN public.reply_request AS request ON request.owner_id=turn.owner_id
                  AND request.contact_id=turn.contact_id AND request.idempotency_key=turn.idempotency_key
                  AND request.conversation_binding_id=turn.conversation_binding_id
                  AND (turn.reply_request_id IS NULL OR request.id=turn.reply_request_id)
                WHERE input.owner_id=%(owner)s AND input.state<>'redacted'
            ), edges AS (
                SELECT child.id AS child_id, parent.id AS parent_id FROM inputs AS child
                JOIN inputs AS parent
                  ON child.continuation->'submission'->>'expected_input_version_id'=parent.id::text
                  AND child.contact_id=parent.contact_id AND child.session_id=parent.session_id
                  AND child.conversation_binding_id=parent.conversation_binding_id
                WHERE child.input_type='generation' AND child.turn_id IS NOT NULL
                  AND parent.input_type='generation' AND parent.turn_id IS NOT NULL
                  AND parent.request_id IS NOT NULL AND parent.input_digest IS NOT NULL
                  AND child.continuation->>'version'='1'
                  AND child.continuation->>'scope'='this_assistant_session_only'
                  AND child.continuation->'submission'->>'idempotency_key'=child.idempotency_key::text
                  AND child.continuation->'submission'->'displayed_group'->>'session_id'=child.session_id::text
                UNION
                SELECT child.id, parent.id
                FROM jsonb_to_recordset(%(carry)s::jsonb)
                  AS carry(child uuid,parent uuid,contact uuid,binding uuid)
                JOIN inputs AS child ON child.id=carry.child AND child.contact_id=carry.contact
                  AND child.conversation_binding_id=carry.binding AND child.input_type='candidate_carry'
                JOIN inputs AS parent ON parent.id=carry.parent AND parent.contact_id=child.contact_id
                  AND parent.conversation_binding_id=child.conversation_binding_id
                WHERE parent.turn_id IS NOT NULL AND parent.request_id IS NOT NULL
                  AND parent.input_digest IS NOT NULL
            ), affected(id) AS (
                SELECT id FROM inputs WHERE dependencies && %(removed)s::uuid[]
                  OR request_id=ANY(%(requests)s::uuid[])
                  OR (turn_id=ANY(%(turns)s::uuid[])
                      AND (%(contact)s::uuid IS NULL OR contact_id=%(contact)s))
                UNION
                SELECT edges.child_id FROM affected JOIN edges ON edges.parent_id=affected.id
            )
            SELECT id,turn_id,request_id FROM inputs WHERE id IN (SELECT id FROM affected)
            ORDER BY id
            """,
            parameters,
        ).fetchall()
    return AssistantInputDependents(
        owner_id, tuple(row["id"] for row in rows),
        tuple(sorted({row["turn_id"] for row in rows if row["turn_id"] is not None})),
        tuple(sorted({row["request_id"] for row in rows if row["request_id"] is not None})),
    )
