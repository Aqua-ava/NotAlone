"""PostgreSQL 默认助手会话；候选只从既有回复权威记录读取。"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Iterator
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt, AssistantPreparationFormatReceipt
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound,
    AssistantSessionPersistenceError, AssistantSessionRejected, AssistantSessionSnapshot, AssistantTurn,
)
from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.assistant_input_lineage import (
    AssistantCarryInputLineage, AssistantInputDependents, select_assistant_input_dependents,
)
from notalone.persistence.reply_discussion_dependencies import CapturedReplyDiscussionUse
from notalone.application.assistant_continuation_identity import (
    AssistantContinuationInvalid, continuation_commit_input, continuation_digest_input, continuation_input_payload,
)
from notalone.persistence.assistant_reply_identity import (
    prepare_assistant_reply_start as prepare_assistant_reply_start,
)
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.message_sources import active_source_ref_sql, valid_source_ref_exists_sql
from notalone.persistence.style_sample_store import (
    captured_reply_sources, reply_evidence_sources, require_reply_sources_current,
)
from notalone.reply.assistant_discussion import DiscussionDependencies
from notalone.reply.context import ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.exploration import ExplorationExpired
from notalone.reply.interface import ReplyGenerated, ReplyToMessage
from notalone.reply.store import ReplyRequest, _normalize_input, canonical_reply_input
from notalone.scopes import ContactScope

if TYPE_CHECKING:
    from notalone.application.assistant_message_adoption import AssistantMessageAdoptionRequest
    from notalone.application.assistant_continuation import AssistantContinuationReservation
    from notalone.application.assistant_interrupted_recovery import RecoverInterruptedAssistantGeneration


def _digest(binding_id: UUID, normalized: str) -> str:
    return hashlib.sha256(f"{binding_id}:{normalized}".encode("utf-8")).hexdigest()


def _input_payload(normalized: str) -> dict[str, Any]:
    content = json.loads(normalized)
    continued = content.pop("continued_from_candidate_id")
    skill = content.pop("skill")
    scene = content.pop('scene', None)
    content["type"] = content.pop("mode")
    return {"content": content, "continued_from_candidate_id": continued,
            "skill_version_id": skill.split(":", 1)[1] if skill.startswith("user_choice:") else None,
            "skill_disabled": skill == "disabled", **({'scene': scene} if scene is not None else {})}


def _active_binding(connection: Any, scope: ContactScope) -> UUID:
    if not connection.execute(
        "SELECT 1 FROM public.contact WHERE owner_id = %s AND id = %s",
        (scope.owner_id, scope.contact_id),
    ).fetchone():
        raise AssistantSessionNotFound("指定范围内不存在联系人。")
    from notalone.application.manual_input_scope import manual_input_contact
    if manual_input_contact.get() is not None:
        if manual_input_contact.get() != scope.contact_id:
            raise AssistantSessionRejected("scope_mismatch")
        manual = connection.execute(
            "SELECT id FROM public.manual_contact_confirmation WHERE owner_id=%s AND contact_id=%s FOR SHARE",
            (scope.owner_id, scope.contact_id),
        ).fetchone()
        if manual is None:
            raise AssistantSessionRejected("manual_contact_unconfirmed")
        return manual["id"]
    rows = connection.execute(
        "SELECT id FROM public.conversation_binding "
        "WHERE owner_id = %s AND contact_id = %s AND status = 'active' FOR SHARE",
        (scope.owner_id, scope.contact_id),
    ).fetchall()
    if not rows:
        raise AssistantSessionRejected("no_active_binding")
    if len(rows) != 1:
        raise AssistantSessionRejected("ambiguous_binding")
    return rows[0]["id"]


def _expand_message_sources(connection: Any, owner_id: UUID, dependencies: set[UUID]) -> set[UUID]:
    """本人记忆可引用同一 owner 的其他联系人来源，仍先按 owner 隔离。"""

    rows = connection.execute(
        "SELECT coalesce(source_document_id, observation_id) AS source_id "
        "FROM public.message_source_ref AS ref WHERE owner_id = %s AND message_id = ANY(%s::uuid[]) "
        "AND (EXISTS (SELECT 1 FROM public.source_document AS source "
        "WHERE source.id = ref.source_document_id AND source.owner_id = ref.owner_id "
        "AND source.contact_id = ref.contact_id AND source.status = 'active') "
        "OR EXISTS (SELECT 1 FROM public.local_wechat_observation AS observation "
        "WHERE observation.id = ref.observation_id AND observation.owner_id = ref.owner_id "
        "AND observation.contact_id = ref.contact_id))",
        (owner_id, list(dependencies)),
    ).fetchall()
    return dependencies | {row["source_id"] for row in rows}


def _reply_dependencies(connection: Any, scope: ContactScope, request_id: UUID) -> set[UUID]:
    rows = connection.execute(
        """
        WITH RECURSIVE lineage AS (
            SELECT id, continued_from_candidate_id
            FROM public.reply_request WHERE owner_id = %s AND contact_id = %s AND id = %s
            UNION
            SELECT parent.id, parent.continued_from_candidate_id
            FROM lineage
            JOIN public.reply_candidate AS candidate ON candidate.id = lineage.continued_from_candidate_id
            JOIN public.reply_request AS parent ON parent.id = candidate.reply_request_id
            WHERE parent.owner_id = %s AND parent.contact_id = %s
        )
        SELECT evidence.evidence_id, evidence.kind, evidence.source_ids, turn.dependency_ids,
               lineage.id AS request_id
        FROM lineage JOIN public.reply_context_evidence AS evidence ON evidence.reply_request_id = lineage.id
        LEFT JOIN public.assistant_session_turn AS turn ON turn.reply_request_id = lineage.id
          AND turn.owner_id = %s AND turn.contact_id = %s
        """,
        (scope.owner_id, scope.contact_id, request_id, scope.owner_id, scope.contact_id,
         scope.owner_id, scope.contact_id),
    ).fetchall()
    dependencies: set[UUID] = set()
    for row in rows:
        dependencies.update(row["dependency_ids"] or ())
        dependencies.update(_evidence_dependencies(
            connection, owner_id=scope.owner_id, evidence_id=row["evidence_id"],
            kind=row["kind"], source_ids={UUID(value) for value in row["source_ids"]},
            historical=True,
        ))
    for identifier in {row["request_id"] for row in rows}:
        dependencies.update(captured_reply_sources(connection, owner_id=scope.owner_id, request_id=identifier))
    # 继承当时实际捕获的依赖，不把后来挂接的来源补进旧候选的来历。
    return dependencies


def captured_generation_dependencies(
    connection: Any, scope: ContactScope, request_key: UUID, binding_id: UUID,
    reply_request_id: UUID | None,
    *, historical: bool = False,
) -> set[UUID]:
    """同事务沿实际C请求键复验模型前捕获；失败输入不以尚未填回的结果ID放行。"""

    from notalone.persistence.reply_discussion_dependencies import (
        reply_style_sample_dependencies, require_reply_discussion_dependencies,
    )

    request = connection.execute(
        "SELECT id, conversation_binding_id FROM public.reply_request "
        "WHERE owner_id = %s AND contact_id = %s AND idempotency_key = %s",
        (scope.owner_id, scope.contact_id, request_key),
    ).fetchone()
    if request is None:
        if reply_request_id is not None:
            raise ReplyStoreInvariantError("助手会话的实际回复请求已失效。")
        return set()
    if (request["conversation_binding_id"] != binding_id
            or reply_request_id is not None and request["id"] != reply_request_id):
        raise ReplyStoreInvariantError("助手会话的实际回复请求身份不一致。")
    dependencies = require_reply_sources_current(
        connection, owner_id=scope.owner_id, request_id=request["id"], historical=historical,
    )
    dependencies.update(_reply_dependencies(connection, scope, request["id"]))
    discussion = require_reply_discussion_dependencies(connection, scope, request["id"])
    if discussion is not None:
        dependencies.update(discussion.source_ids)
    dependencies.update(reply_style_sample_dependencies(connection, scope, request["id"]))
    return dependencies


def _evidence_dependencies(
    connection: Any, *, owner_id: UUID, evidence_id: UUID, kind: str,
    source_ids: set[UUID],
    historical: bool = False,
) -> set[UUID]:
    dependencies = reply_evidence_sources(
        connection, owner_id=owner_id, evidence_id=evidence_id,
        kind=kind, source_ids=tuple(source_ids), historical=historical,
    )
    if kind not in ("user_draft", "user_current_chat", "user_purpose", "continued_candidate"):
        dependencies.add(evidence_id)
    return dependencies


def _partition_assistant_dependencies(
    connection: Any, scope: ContactScope, dependencies: set[UUID],
    *, require_available: bool = True,
) -> DiscussionDependencies:
    """既有turn依赖按实际同范围样本分型；样本仍沿C唯一可用性门禁。"""

    from notalone.persistence.reply_discussion_dependencies import _require_samples

    rows = connection.execute(
        "SELECT id FROM public.style_sample WHERE owner_id=%s AND contact_id=%s "
        "AND id=ANY(%s::uuid[]) ORDER BY id",
        (scope.owner_id, scope.contact_id, list(dependencies)),
    ).fetchall()
    samples = tuple(row["id"] for row in rows)
    if require_available:
        _require_samples(connection, scope, samples)
    return DiscussionDependencies(tuple(sorted(dependencies - set(samples))), samples)


def _dependencies_available(
    connection: Any, scope: ContactScope, dependencies: set[UUID], *, historical: bool = False,
) -> bool:
    """历史仅复验未删除的原依赖；新资料仍须处于当前有效期。"""

    if not dependencies:
        return True
    try:
        typed = _partition_assistant_dependencies(connection, scope, dependencies)
        from notalone.persistence.reply_overview_navigation import registered_navigation_dependencies
        navigation = registered_navigation_dependencies(connection, scope) & dependencies
    except ReplyStoreInvariantError:
        return False
    row = connection.execute(
        f"""
        SELECT NOT EXISTS (
            SELECT 1 FROM unnest(%(dependencies)s::uuid[]) AS dependency(id)
            WHERE NOT EXISTS (
                SELECT 1 FROM public.source_document AS source
                WHERE source.owner_id = %(owner_id)s AND source.id = dependency.id
                  AND source.status = 'active'
                UNION ALL
                SELECT 1 FROM public.local_wechat_observation AS observation
                WHERE observation.owner_id = %(owner_id)s AND observation.id = dependency.id
                UNION ALL
                SELECT 1 FROM public.message AS message
                WHERE message.owner_id = %(owner_id)s AND message.id = dependency.id
                  AND {valid_source_ref_exists_sql('message')}
                UNION ALL
                SELECT 1 FROM public.expression_preference AS preference
                WHERE preference.owner_id = %(owner_id)s AND preference.id = dependency.id
                  AND preference.status = 'active'
                  AND (%(historical)s OR preference.contact_id IS NULL OR preference.contact_id = %(contact_id)s)
                UNION ALL
                SELECT 1 FROM public.confirmed_memory AS memory
                WHERE memory.owner_id = %(owner_id)s AND memory.id = dependency.id
                  AND memory.contact_id = %(contact_id)s
                  AND (memory.status = 'active' OR %(historical)s AND memory.status = 'invalidated')
                  AND (%(historical)s OR (memory.valid_at IS NULL OR memory.valid_at <= now())
                    AND (memory.invalid_at IS NULL OR now() < memory.invalid_at))
                UNION ALL
                SELECT 1 FROM public.owner_memory AS memory
                WHERE memory.owner_id = %(owner_id)s AND memory.id = dependency.id
                  AND (memory.status = 'active' OR %(historical)s AND memory.status = 'invalidated')
                  AND (%(historical)s OR (memory.valid_at IS NULL OR memory.valid_at <= now())
                    AND (memory.invalid_at IS NULL OR now() < memory.invalid_at))
                  AND (memory.source_ids <> ARRAY[%(owner_id)s]::uuid[]
                       OR memory.adoption_method = 'manual')
                UNION ALL
                SELECT 1 FROM public.memory_candidate AS candidate
                WHERE candidate.owner_id = %(owner_id)s AND candidate.id = dependency.id
                  AND candidate.contact_id = %(contact_id)s
                  AND (candidate.status IN ('pending', 'confirmed')
                    OR %(historical)s AND candidate.status IN ('rejected', 'invalidated'))
                  AND (%(historical)s OR (candidate.valid_at IS NULL OR candidate.valid_at <= now())
                    AND (candidate.invalid_at IS NULL OR now() < candidate.invalid_at))
                UNION ALL
                SELECT 1 FROM public.message_source_ref AS ref
                JOIN public.message AS message ON message.id=ref.message_id AND message.owner_id=ref.owner_id
                WHERE ref.owner_id=%(owner_id)s AND ref.id=dependency.id
                  AND dependency.id=ANY(%(navigation)s::uuid[])
                  AND ref.contact_id=message.contact_id AND {active_source_ref_sql('ref')}
                UNION ALL
                SELECT 1 FROM public.memory_correction_decision AS decision
                WHERE decision.owner_id=%(owner_id)s AND decision.id=dependency.id
                  AND dependency.id=ANY(%(navigation)s::uuid[])
                  AND decision.evidence->>'kind' IS DISTINCT FROM 'erased_guard'
                UNION ALL
                SELECT 1 FROM public.scenario_document_version AS version
                WHERE version.owner_id=%(owner_id)s AND version.contact_id=%(contact_id)s
                  AND version.id=dependency.id AND dependency.id=ANY(%(navigation)s::uuid[])
                UNION ALL
                SELECT 1 FROM public.layered_profile_version AS version
                WHERE version.owner_id=%(owner_id)s AND version.contact_id=%(contact_id)s
                  AND version.id=dependency.id AND NOT version.withdrawn
                  AND dependency.id=ANY(%(navigation)s::uuid[])
                UNION ALL
                SELECT 1 FROM public.owner AS owner
                WHERE owner.id=%(owner_id)s AND owner.id=dependency.id
                  AND dependency.id=ANY(%(navigation)s::uuid[])
                UNION ALL
                SELECT 1 FROM public.memory_candidate AS candidate
                WHERE candidate.owner_id=%(owner_id)s AND candidate.id=dependency.id
                  AND dependency.id=ANY(%(navigation)s::uuid[])
                  AND (candidate.status IN ('pending','confirmed')
                    OR %(historical)s AND candidate.status IN ('rejected','invalidated'))
                  AND (%(historical)s OR (candidate.valid_at IS NULL OR candidate.valid_at <= now())
                    AND (candidate.invalid_at IS NULL OR now() < candidate.invalid_at))
                UNION ALL
                SELECT 1 FROM public.confirmed_memory AS memory
                WHERE memory.owner_id=%(owner_id)s AND memory.id=dependency.id
                  AND dependency.id=ANY(%(navigation)s::uuid[])
                  AND (memory.status='active' OR %(historical)s AND memory.status='invalidated')
                  AND (%(historical)s OR (memory.valid_at IS NULL OR memory.valid_at <= now())
                    AND (memory.invalid_at IS NULL OR now() < memory.invalid_at))
            )
        ) AS available
        """,
        {"owner_id": scope.owner_id, "contact_id": scope.contact_id,
         "historical": historical, "dependencies": list(typed.source_ids), "navigation": list(navigation)},
    ).fetchone()
    return row["available"]



def prepare_assistant_reply_commit(
    connection: Any, request: ReplyRequest, context: ReplyContext,
) -> None:
    """原候选事务内复验会话、绑定与来源；既有独立回复路径保持不变。"""

    turn = connection.execute(
        "SELECT * FROM public.assistant_session_turn WHERE owner_id = %s AND contact_id = %s "
        "AND idempotency_key = %s FOR UPDATE",
        (request.scope.owner_id, request.scope.contact_id, request.idempotency_key),
    ).fetchone()
    if turn is None:
        return
    if turn["state"] == "redacted":
        raise ReplyStoreInvariantError("助手会话来源已失效。")
    try:
        binding_id = _active_binding(connection, request.scope)
    except (AssistantSessionRejected, AssistantSessionNotFound):
        raise ReplyStoreInvariantError("助手会话绑定已失效。") from None
    try:
        normalized = continuation_commit_input(context.command, request.normalized_input, turn["input_payload"])
    except AssistantContinuationInvalid:
        raise ReplyStoreInvariantError("助手会话输入身份已失效。") from None
    if (binding_id != request.conversation_binding_id
            or turn["conversation_binding_id"] != binding_id
            or turn["input_digest"] != _digest(binding_id, normalized)):
        raise ReplyStoreInvariantError("助手会话输入版本已失效。")
    from notalone.persistence.assistant_session_inputs import require_current_input
    try:
        require_current_input(connection, request.scope, turn["session_id"], turn["input_version_id"])
    except (AssistantSessionRejected, AssistantSessionNotFound):
        raise ReplyStoreInvariantError("助手会话当前输入已改变，不能提交旧候选。") from None
    dependencies = set(turn["dependency_ids"])
    dependencies.update(captured_reply_sources(connection, owner_id=request.scope.owner_id,
                                               request_id=request.request_id))
    from notalone.persistence.reply_discussion_dependencies import reply_style_sample_dependencies
    dependencies.update(reply_style_sample_dependencies(connection, request.scope, request.request_id))
    from notalone.persistence.reply_basis_changes import require_current_reply_memory
    require_current_reply_memory(connection, request.scope, context.evidence)
    current_dependencies: set[UUID] = set()
    historical_dependencies: set[UUID] = set()
    for evidence in context.evidence:
        actual_dependencies = _evidence_dependencies(
            connection, owner_id=request.scope.owner_id, evidence_id=evidence.evidence_id,
            kind=evidence.kind, source_ids=set(evidence.source_ids),
            historical=evidence.navigation is not None and evidence.timing.current_status == "historical",
        )
        if evidence.navigation is not None and evidence.timing.current_status == "historical":
            historical_dependencies.update(actual_dependencies)
        else:
            current_dependencies.update(actual_dependencies)
    if not _dependencies_available(connection, request.scope, current_dependencies):
        raise ReplyStoreInvariantError("本次新候选的当前依据已变化。")
    if not _dependencies_available(connection, request.scope, historical_dependencies, historical=True):
        raise ReplyStoreInvariantError("本次新候选的历史依据已不可用。")
    dependencies.update(current_dependencies)
    dependencies.update(historical_dependencies)
    if request.continued_from_candidate_id is not None:
        previous = connection.execute(
            "SELECT reply_request_id FROM public.reply_candidate "
            "WHERE owner_id = %s AND contact_id = %s AND id = %s",
            (request.scope.owner_id, request.scope.contact_id, request.continued_from_candidate_id),
        ).fetchone()
        if previous is None:
            raise ReplyStoreInvariantError("前序候选来源已失效。")
        dependencies.update(_reply_dependencies(connection, request.scope, previous["reply_request_id"]))
    if not _dependencies_available(connection, request.scope, dependencies, historical=True):
        raise ReplyStoreInvariantError("助手会话来源已失效，不能提交旧候选。")
    connection.execute(
        "UPDATE public.assistant_session_turn SET reply_request_id = %s, dependency_ids = %s, "
        "updated_at = now() WHERE id = %s",
        (request.request_id, list(dependencies), turn["id"]),
    )


def _assistant_source_turn_rows(
    connection: Any, *, owner_id: UUID, contact_id: UUID | None,
    removed_ids: set[UUID], reply_request_ids: list[UUID], turn_ids: set[UUID],
) -> list[Any]:
    return connection.execute("""
        SELECT turn.id, turn.input_payload, turn.dependency_ids,
               request.state AS request_state, request.id AS request_id
        FROM public.assistant_session_turn AS turn
        LEFT JOIN public.reply_request AS request
          ON request.owner_id = turn.owner_id AND request.contact_id = turn.contact_id
         AND request.idempotency_key = turn.idempotency_key
        WHERE turn.owner_id = %s AND turn.state <> 'redacted'
          AND (turn.dependency_ids && %s::uuid[] OR request.id = ANY(%s::uuid[])
               OR (turn.id = ANY(%s::uuid[])
                   AND (%s::uuid IS NULL OR turn.contact_id = %s)))
        FOR UPDATE OF turn
        """, (owner_id, list(removed_ids), reply_request_ids,
              list(turn_ids), contact_id, contact_id)).fetchall()


def _independent_assistant_source_draft(
    row: Any, *, explicit_turn_ids: set[UUID], removed_ids: set[UUID],
) -> bool:
    payload = row["input_payload"] if isinstance(row, dict) else row[1]
    dependencies = row["dependency_ids"] if isinstance(row, dict) else row[2]
    request_state = row["request_state"] if isinstance(row, dict) else row[3]
    turn_id = row["id"] if isinstance(row, dict) else row[0]
    return (
        turn_id not in explicit_turn_ids
        and request_state == "running" and not (set(dependencies) & removed_ids)
        and isinstance(payload, dict)
        and payload["content"]["type"] == "rewrite_draft"
        and not payload["content"].get("include_relationship_context", False)
        and payload.get("continued_from_candidate_id") is None
        and not isinstance(payload.get("continuation"), dict)
    )


def select_assistant_source_input_dependents(
    connection: Any, *, owner_id: UUID, contact_id: UUID | None,
    removed_ids: set[UUID], reply_request_ids: list[UUID],
    turn_ids: list[UUID] | None = None,
    carry_edges: tuple[AssistantCarryInputLineage, ...] = (),
    captured_uses: tuple[CapturedReplyDiscussionUse, ...] = (),
) -> AssistantInputDependents:
    """同 owner 锁内、C清空捕获身份前选删除闭包；撤租约的独立草稿不作为根。"""

    explicit_turn_ids = set(turn_ids or ())
    # prepare尚未创建C请求时，也已保存用户明确选择的不可变版本。
    # 沿真实版本/owner身份选中A删除根，不能等下一次GET或模型执行才清正文。
    selected_skills = connection.execute(
        "SELECT turn.id FROM public.assistant_session_turn AS turn "
        "JOIN public.reply_skill_version AS version "
        "ON turn.input_payload->>'skill_version_id'=version.id::text "
        "JOIN public.reply_skill AS skill ON skill.id=version.skill_id AND skill.owner_id=turn.owner_id "
        "WHERE turn.owner_id=%s AND turn.state<>'redacted' AND version.id=ANY(%s::uuid[])",
        (owner_id, list(removed_ids)),
    ).fetchall()
    explicit_turn_ids.update(row['id'] if isinstance(row, dict) else row[0] for row in selected_skills)
    rows = _assistant_source_turn_rows(
        connection, owner_id=owner_id, contact_id=contact_id, removed_ids=removed_ids,
        reply_request_ids=reply_request_ids, turn_ids=explicit_turn_ids,
    )

    # 范围撤租约中的独立草稿不是删除根；实际历史闭包命中后仍必须清除。
    independent_requests = {
        row["request_id"] if isinstance(row, dict) else row[4]
        for row in rows if _independent_assistant_source_draft(
            row, explicit_turn_ids=explicit_turn_ids, removed_ids=removed_ids,
        )
    }
    return select_assistant_input_dependents(
        connection, owner_id=owner_id, contact_id=contact_id, removed_ids=removed_ids,
        reply_request_ids=[identifier for identifier in reply_request_ids if identifier not in independent_requests],
        turn_ids=tuple(explicit_turn_ids), carry_edges=carry_edges, captured_uses=captured_uses,
    )


def erase_assistant_source_turns(
    connection: Any, *, owner_id: UUID, contact_id: UUID | None,
    removed_ids: set[UUID], reply_request_ids: list[UUID],
    turn_ids: list[UUID] | None = None,
    carry_edges: tuple[AssistantCarryInputLineage, ...] = (),
    captured_uses: tuple[CapturedReplyDiscussionUse, ...] = (),
) -> None:
    """在原回复副本清除前留下无正文占位，同一 owner 下的传递依赖全部清除。"""

    explicit_turn_ids = set(turn_ids or ())
    selected = select_assistant_source_input_dependents(
        connection, owner_id=owner_id, contact_id=contact_id, removed_ids=removed_ids,
        reply_request_ids=reply_request_ids, turn_ids=turn_ids,
        carry_edges=carry_edges, captured_uses=captured_uses,
    )
    explicit_turn_ids.update(selected.turn_ids)
    from notalone.persistence.skill_learning import erase_skill_learning
    erase_skill_learning(connection, owner_id=owner_id,
                         removed_ids=set(removed_ids) | set(reply_request_ids)
                         | explicit_turn_ids | set(selected.input_version_ids))
    rows = _assistant_source_turn_rows(
        connection, owner_id=owner_id, contact_id=contact_id, removed_ids=removed_ids,
        reply_request_ids=reply_request_ids, turn_ids=explicit_turn_ids,
    )
    for row in rows:
        turn_id = row["id"] if isinstance(row, dict) else row[0]
        if _independent_assistant_source_draft(
            row, explicit_turn_ids=explicit_turn_ids, removed_ids=removed_ids,
        ):
            connection.execute(
                "UPDATE public.assistant_session_turn SET state = 'failed', reply_request_id = NULL, "
                "updated_at = now() WHERE id = %s", (turn_id,),
            )
        else:
            connection.execute(
                "UPDATE public.assistant_session_turn SET state = 'redacted', input_payload = NULL, "
                "input_digest = NULL, reply_request_id = NULL, dependency_ids = '{}', "
                "updated_at = now() WHERE id = %s", (turn_id,),
            )
    from notalone.persistence.assistant_session_inputs import erase_assistant_source_inputs
    erase_assistant_source_inputs(
        connection, owner_id=owner_id, removed_ids=removed_ids,
        input_version_ids=selected.input_version_ids,
    )


class PostgresAssistantSessionStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    @contextmanager
    def _transaction(self, scope: ContactScope) -> Iterator[Any]:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                yield connection
        except ExplorationExpired:
            from notalone.persistence.reply_exploration import PostgresExplorationStore
            from notalone.persistence.retrieval import PostgresRetrieval
            from notalone.reply.exploration_context import ExplorationEvidence
            PostgresExplorationStore(self._database_url, evidence=ExplorationEvidence(
                PostgresRetrieval(self._database_url),
            )).prune_expired(scope)
            raise AssistantSessionRejected("exploration_expired") from None
        except psycopg.Error:
            raise AssistantSessionPersistenceError("助手会话未可靠保存。") from None

    @staticmethod
    def _require_session(connection: Any, scope: ContactScope, session_id: UUID) -> None:
        if not connection.execute(
            "SELECT 1 FROM public.assistant_session "
            "WHERE owner_id = %s AND contact_id = %s AND id = %s",
            (scope.owner_id, scope.contact_id, session_id),
        ).fetchone():
            raise AssistantSessionNotFound("指定范围内不存在助手会话。")

    def default(self, scope: ContactScope) -> UUID:
        with self._transaction(scope) as connection:
            _active_binding(connection, scope)
            row = connection.execute(
                "INSERT INTO public.assistant_session (owner_id, contact_id) "
                "VALUES (%s, %s) ON CONFLICT (owner_id, contact_id) WHERE is_default "
                "DO UPDATE SET updated_at = public.assistant_session.updated_at RETURNING id",
                (scope.owner_id, scope.contact_id),
            ).fetchone()
            return row["id"]

    def interrupt(
        self, scope: ContactScope, session_id: UUID, request_key: UUID, input_version_id: UUID, reason: str = "app_quit",
    ) -> AssistantGenerationReceipt:
        from notalone.persistence.assistant_generation_lifecycle import interrupt_generation_in_transaction
        with self._transaction(scope) as connection:
            return interrupt_generation_in_transaction(
                connection, scope, session_id, request_key, input_version_id,
                complete_saved=self._complete_saved_in_transaction, reason=reason,
            )

    def reserve(
        self, scope: ContactScope, session_id: UUID, request: ReplyServiceRequest,
    ) -> UUID:
        with self._transaction(scope) as connection:
            return self._reserve_in_transaction(connection, scope, session_id, request)

    def has_prepared_context(self, scope: ContactScope, receipt: AssistantGenerationReceipt) -> bool:
        with self._transaction(scope) as connection:
            row = connection.execute(
                "SELECT prepared_context IS NOT NULL AS fixed FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND id=%s "
                "AND input_version_id=%s AND idempotency_key=%s",
                (scope.owner_id, scope.contact_id, receipt.session_id, receipt.turn_id,
                 receipt.input_version_id, receipt.request_key),
            ).fetchone()
            return row is not None and row["fixed"]

    def require_prepared_format(self, scope: ContactScope, session_id: UUID, request_key: UUID) -> None:
        from notalone.persistence.assistant_prepared_format import check_prepared_format
        with self._transaction(scope) as connection:
            reason = check_prepared_format(connection, scope, session_id, request_key,
                                           complete_saved=self._complete_saved_in_transaction)
        if reason is not None:
            raise AssistantSessionRejected(reason)

    def preparation_format(self, scope: ContactScope, session_id: UUID, request_key: UUID,
                           input_version_id: UUID) -> AssistantPreparationFormatReceipt:
        from notalone.persistence.assistant_prepared_format import check_prepared_format
        from notalone.persistence.assistant_generation_lifecycle import require_interruption_input
        with self._transaction(scope) as connection:
            self._require_session(connection, scope, session_id)
            turn = connection.execute(
                "SELECT id,input_version_id FROM public.assistant_session_turn WHERE owner_id=%s "
                "AND contact_id=%s AND session_id=%s AND idempotency_key=%s FOR UPDATE",
                (scope.owner_id, scope.contact_id, session_id, request_key),
            ).fetchone()
            if turn is None:
                raise AssistantSessionNotFound("指定范围内不存在生成准备。")
            if turn["input_version_id"] != input_version_id:
                raise AssistantSessionRejected("input_version_stale")
            require_interruption_input(connection, scope, session_id, turn["id"], request_key, input_version_id)
            reason = check_prepared_format(connection, scope, session_id, request_key,
                                           complete_saved=self._complete_saved_in_transaction)
            receipt = self._prepared_receipt(connection, scope, session_id, turn["id"])
            return AssistantPreparationFormatReceipt(receipt,
                reason.removeprefix("prepared_context_") if reason is not None else "compatible")

    def prepared_request(self, scope: ContactScope, receipt: AssistantGenerationReceipt) -> ReplyServiceRequest:
        from notalone.persistence.assistant_continuation import restore_prepared_reply_request
        with self._transaction(scope) as connection:
            row = connection.execute(
                "SELECT input_payload FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s "
                "AND session_id=%s AND id=%s AND input_version_id=%s AND idempotency_key=%s",
                (scope.owner_id, scope.contact_id, receipt.session_id, receipt.turn_id,
                 receipt.input_version_id, receipt.request_key),
            ).fetchone()
            if row is None or row["input_payload"] is None:
                raise AssistantSessionRejected("source_unavailable")
            return restore_prepared_reply_request(connection, scope, receipt.session_id,
                                                  receipt.request_key, row["input_payload"])

    def reject_unavailable_preparation(self, scope: ContactScope, session_id: UUID, request_key: UUID) -> None:
        """模型缺配置也须先持锁证实未领取，不能留下无法退出的未知作业。"""
        from notalone.persistence.assistant_preparation_rejection import prove_preparation_rejected
        failure = AssistantSessionRejected("reply_unavailable")
        with self._transaction(scope) as connection:
            rejected = prove_preparation_rejected(connection, scope, session_id, request_key, failure)
        if rejected is not None:
            raise rejected
        raise failure

    def reserve_prepared(
        self, scope: ContactScope, session_id: UUID, request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt:
        """复用唯一领取 writer 和 B prepare hook，同事务投影实际元数据。"""

        from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
        from notalone.persistence.assistant_preparation_rejection import prepare_generation_in_transaction
        with self._transaction(scope) as connection:
            prepared = prepare_generation_in_transaction(connection, scope, session_id, request.idempotency_key,
                lambda: self._prepared_receipt(connection, scope, session_id,
                    self._reserve_in_transaction(connection, scope, session_id, request)))
        if isinstance(prepared, AssistantPreparationRejected):
            raise prepared
        return prepared

    def reserve_message_adoption(
        self, scope: ContactScope, session_id: UUID, request: AssistantMessageAdoptionRequest,
        running_request_key: UUID | None = None,
    ) -> AssistantContinuationReservation:
        from notalone.persistence.assistant_message_adoption import reserve_message_adoption_in_transaction
        if running_request_key is not None and running_request_key == request.idempotency_key:
            raise AssistantSessionRejected("invalid_generation_replacement")
        with self._transaction(scope) as connection:
            return reserve_message_adoption_in_transaction(
                connection, self, scope, session_id, request, running_request_key)

    def prepare_message_adoption(
        self, scope: ContactScope, session_id: UUID, request: AssistantMessageAdoptionRequest,
        running_request_key: UUID | None = None,
    ) -> AssistantGenerationReceipt:
        from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
        from notalone.persistence.assistant_message_adoption import reserve_message_adoption_in_transaction
        from notalone.persistence.assistant_preparation_rejection import prepare_generation_in_transaction
        if running_request_key is not None and running_request_key == request.idempotency_key:
            raise AssistantSessionRejected("invalid_generation_replacement")
        with self._transaction(scope) as connection:
            def reserve() -> AssistantGenerationReceipt:
                reserved = reserve_message_adoption_in_transaction(
                    connection, self, scope, session_id, request, running_request_key)
                return self._prepared_receipt(connection, scope, session_id, reserved.turn_id)
            prepared = prepare_generation_in_transaction(connection, scope, session_id, request.idempotency_key, reserve)
        if isinstance(prepared, AssistantPreparationRejected):
            raise prepared
        return prepared

    def reserve_interrupted(
        self, scope: ContactScope, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantContinuationReservation:
        from notalone.persistence.assistant_interrupted_recovery import reserve_interrupted_generation_in_transaction
        with self._transaction(scope) as connection:
            return reserve_interrupted_generation_in_transaction(connection, self, scope, session_id, command)

    def prepare_interrupted(
        self, scope: ContactScope, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantGenerationReceipt:
        from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
        from notalone.persistence.assistant_interrupted_recovery import reserve_interrupted_generation_in_transaction
        from notalone.persistence.assistant_preparation_rejection import prepare_generation_in_transaction
        with self._transaction(scope) as connection:
            def reserve() -> AssistantGenerationReceipt:
                reserved = reserve_interrupted_generation_in_transaction(connection, self, scope, session_id, command)
                return self._prepared_receipt(connection, scope, session_id, reserved.turn_id)
            prepared = prepare_generation_in_transaction(connection, scope, session_id, command.request_key, reserve)
        if isinstance(prepared, AssistantPreparationRejected):
            raise prepared
        return prepared

    @staticmethod
    def _prepared_receipt(
        connection: Any, scope: ContactScope, session_id: UUID, turn_id: UUID,
    ) -> AssistantGenerationReceipt:
        turn = connection.execute(
            "SELECT turn.id, turn.session_id, turn.idempotency_key, turn.input_version_id, "
            "CASE WHEN request.state IN ('running', 'completed', 'failed') THEN request.state ELSE turn.state END AS state "
            "FROM public.assistant_session_turn AS turn LEFT JOIN public.reply_request AS request "
            "ON request.owner_id = turn.owner_id AND request.contact_id = turn.contact_id "
            "AND request.idempotency_key = turn.idempotency_key "
            "AND (turn.reply_request_id IS NULL OR request.id = turn.reply_request_id) "
            "WHERE turn.owner_id = %s AND turn.contact_id = %s "
            "AND turn.session_id = %s AND turn.id = %s",
            (scope.owner_id, scope.contact_id, session_id, turn_id),
        ).fetchone()
        if turn is None:
            raise AssistantSessionPersistenceError("已领取生成身份未可靠保存。")
        return AssistantGenerationReceipt(
            session_id=turn["session_id"], turn_id=turn["id"],
            request_key=turn["idempotency_key"], input_version_id=turn["input_version_id"],
            state=turn["state"],
        )

    def reserve_replacement_prepared(
        self, scope: ContactScope, session_id: UUID, running_request_key: UUID,
        request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt:
        """复用原替换 writer；先失效旧输入再领取新版本，全程不调用模型。"""

        if (not isinstance(running_request_key, UUID)
                or not isinstance(request, ReplyServiceRequest)
                or not isinstance(request.idempotency_key, UUID)
                or request.idempotency_key == running_request_key):
            raise AssistantSessionRejected("invalid_generation_replacement")
        from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
        from notalone.persistence.assistant_preparation_rejection import prepare_generation_in_transaction
        with self._transaction(scope) as connection:
            prepared = prepare_generation_in_transaction(connection, scope, session_id, request.idempotency_key,
                lambda: self._prepared_receipt(connection, scope, session_id,
                    self._reserve_in_transaction(connection, scope, session_id, request,
                                                 running_request_key=running_request_key)))
        if isinstance(prepared, AssistantPreparationRejected):
            raise prepared
        return prepared

    def reserve_replacement(
        self, scope: ContactScope, session_id: UUID, running_request_key: UUID,
        request: ReplyServiceRequest,
    ) -> UUID:
        """显式旧键由服务端定位；失效与唯一新输入领取在同一事务内提交。"""

        if (not isinstance(running_request_key, UUID)
                or not isinstance(request, ReplyServiceRequest)
                or not isinstance(request.idempotency_key, UUID)
                or request.idempotency_key == running_request_key):
            raise AssistantSessionRejected("invalid_generation_replacement")
        with self._transaction(scope) as connection:
            return self._reserve_in_transaction(
                connection, scope, session_id, request, running_request_key=running_request_key,
            )

    def _reserve_in_transaction(
        self, connection: Any, scope: ContactScope, session_id: UUID,
        request: ReplyServiceRequest, *, running_request_key: UUID | None = None,
        inherited_dependencies: tuple[UUID, ...] = (),
    ) -> UUID:
        """复用既有规范化、探索与来源门禁；同键重放先于旧请求失效。"""

        self._require_session(connection, scope, session_id)
        binding_id = _active_binding(connection, scope)
        command = request.build_command(
            owner_id=scope.owner_id, contact_id=scope.contact_id, binding_id=binding_id,
        )
        if command is None or not command.has_valid_content():
            raise AssistantSessionRejected("invalid_reply_input")
        normalized = _normalize_input(command)
        digest = _digest(binding_id, continuation_digest_input(request, normalized))
        existing = connection.execute(
            "SELECT id, session_id, state, input_digest, reply_request_id, interruption_reason FROM public.assistant_session_turn "
            "WHERE owner_id = %s AND contact_id = %s AND idempotency_key = %s FOR UPDATE",
            (scope.owner_id, scope.contact_id, request.idempotency_key),
        ).fetchone()
        if existing is not None:
            if existing["state"] == "redacted":
                raise AssistantSessionRejected("source_deleted")
            if existing["session_id"] != session_id or existing["input_digest"] != digest:
                raise AssistantSessionConflict("请求键已用于不同输入。")
            if existing["interruption_reason"] is not None:
                raise AssistantSessionRejected("generation_interrupted")
            if connection.execute(
                "SELECT 1 FROM public.reply_invalidated_key WHERE owner_id = %s "
                "AND contact_id = %s AND idempotency_key = %s",
                (scope.owner_id, scope.contact_id, request.idempotency_key),
            ).fetchone():
                raise AssistantSessionRejected("request_deleted")
            dependencies = connection.execute(
                "SELECT dependency_ids FROM public.assistant_session_turn WHERE id = %s",
                (existing["id"],),
            ).fetchone()["dependency_ids"]
            if not _dependencies_available(connection, scope, set(dependencies), historical=True):
                raise AssistantSessionRejected("source_unavailable")
            completed = connection.execute(
                "SELECT id, normalized_input FROM public.reply_request WHERE owner_id = %s "
                "AND contact_id = %s AND idempotency_key = %s AND conversation_binding_id = %s "
                "AND state = 'completed' AND (%s::uuid IS NULL OR id = %s)",
                (scope.owner_id, scope.contact_id, request.idempotency_key, binding_id,
                 existing["reply_request_id"], existing["reply_request_id"]),
            ).fetchone()
            if completed is not None:
                if completed["normalized_input"] != normalized:
                    raise AssistantSessionConflict("请求键已用于不同输入。")
                from notalone.persistence.skill_execution_view import saved_skill_policy_change
                if saved_skill_policy_change(connection, scope, completed['id']) is not None:
                    raise AssistantSessionRejected('skill_policy_changed')
                try:
                    require_reply_sources_current(connection, owner_id=scope.owner_id,
                                                  request_id=completed["id"], historical=True)
                except ReplyStoreInvariantError:
                    raise AssistantSessionRejected("source_unavailable") from None
            if existing["state"] != "completed" and completed is None:
                from notalone.persistence.explored_generation import prepare_explored_generation
                prepare_explored_generation(connection, scope, session_id, command)
            return existing["id"]
        # 沿用回复层的无正文失效凭证，在新会话落输入前阻止旧键恢复。
        if connection.execute(
            "SELECT 1 FROM public.reply_invalidated_key WHERE owner_id = %s "
            "AND contact_id = %s AND idempotency_key = %s",
            (scope.owner_id, scope.contact_id, request.idempotency_key),
        ).fetchone():
            raise AssistantSessionRejected("request_deleted")
        if connection.execute(
            "SELECT 1 FROM public.reply_request WHERE owner_id = %s AND contact_id = %s "
            "AND idempotency_key = %s",
            (scope.owner_id, scope.contact_id, request.idempotency_key),
        ).fetchone():
            raise AssistantSessionConflict("历史回复请求不能自动归并。")
        from notalone.persistence.assistant_session_inputs import (
            check_expected_input, require_current_input, require_input_session,
        )
        check_expected_input(require_input_session(connection, scope, session_id), request.expected_input_version_id)
        # 新键延续明确旧输入时，CURRENT UUID 相同仍须来源可用，并保留其实际删除依赖。
        expected_dependencies = (require_current_input(connection, scope, session_id, request.expected_input_version_id)
                                 if request.expected_input_version_id is not None else ())
        from notalone.persistence.explored_generation import prepare_explored_generation
        dependencies = prepare_explored_generation(connection, scope, session_id, command)
        dependencies.update(inherited_dependencies)
        dependencies.update(expected_dependencies)
        if isinstance(command.content, ReplyToMessage):
            target = connection.execute(
                "SELECT 1 FROM public.message WHERE owner_id = %s AND contact_id = %s AND id = %s",
                (scope.owner_id, scope.contact_id, command.content.target_message_id),
            ).fetchone()
            if target is None:
                raise AssistantSessionRejected("target_message_unavailable")
            dependencies.add(command.content.target_message_id)
            dependencies = _expand_message_sources(connection, scope.owner_id, dependencies)
        if request.continued_from_candidate_id is not None:
            candidate = connection.execute(
                "SELECT reply_request_id FROM public.reply_candidate WHERE owner_id = %s "
                "AND contact_id = %s AND conversation_binding_id = %s AND id = %s",
                (scope.owner_id, scope.contact_id, binding_id, request.continued_from_candidate_id),
            ).fetchone()
            if candidate is None:
                raise AssistantSessionRejected("continued_candidate_unavailable")
            dependencies.update(_reply_dependencies(connection, scope, candidate["reply_request_id"]))
        if not _dependencies_available(connection, scope, dependencies, historical=True):
            raise AssistantSessionRejected("source_unavailable")
        if running_request_key is not None:
            old = connection.execute(
                "SELECT id, input_version_id FROM public.assistant_session_turn "
                "WHERE owner_id = %s AND contact_id = %s AND session_id = %s "
                "AND idempotency_key = %s FOR UPDATE",
                (scope.owner_id, scope.contact_id, session_id, running_request_key),
            ).fetchone()
            if old is None:
                raise AssistantSessionNotFound("指定会话内不存在旧生成请求。")
            from notalone.persistence.assistant_generation_replacement import invalidate_running_generation
            if not invalidate_running_generation(
                connection, scope, session_id, old["id"], old["input_version_id"],
            ):
                raise AssistantSessionRejected("generation_not_running")
        row = connection.execute(
            "INSERT INTO public.assistant_session_turn "
            "(session_id, owner_id, contact_id, idempotency_key, conversation_binding_id, "
            "input_digest, input_payload, dependency_ids) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, input_version_id",
            (session_id, scope.owner_id, scope.contact_id, request.idempotency_key,
             binding_id, digest, Jsonb(continuation_input_payload(
                 request, _input_payload(canonical_reply_input(command)))), list(dependencies)),
        ).fetchone()
        connection.execute(
            "INSERT INTO public.assistant_session_input "
            "(id, session_id, owner_id, contact_id, conversation_binding_id, input_type, turn_id) "
            "VALUES (%s, %s, %s, %s, %s, 'generation', %s)",
            (row["input_version_id"], session_id, scope.owner_id, scope.contact_id, binding_id, row["id"]),
        )
        connection.execute(
            "UPDATE public.assistant_session SET current_input_version_id = %s, updated_at = now() "
            "WHERE owner_id = %s AND contact_id = %s AND id = %s",
            (row["input_version_id"], scope.owner_id, scope.contact_id, session_id),
        )
        return row["id"]

    def complete(
        self, scope: ContactScope, session_id: UUID, turn_id: UUID, reply: ReplyGenerated,
    ) -> AssistantTurn:
        with self._transaction(scope) as connection:
            return self._complete_in_transaction(connection, scope, session_id, turn_id, reply)

    def _complete_saved_in_transaction(
        self, connection: Any, scope: ContactScope, session_id: UUID, turn_id: UUID, request_id: UUID,
    ) -> AssistantTurn:
        from notalone.persistence.reply_store import PostgresReplyStore
        stored = connection.execute(
            "SELECT * FROM public.reply_request WHERE owner_id = %s AND contact_id = %s "
            "AND id = %s AND state = 'completed'",
            (scope.owner_id, scope.contact_id, request_id),
        ).fetchone()
        if stored is None:
            raise AssistantSessionPersistenceError("回复结果尚未可靠保存。")
        reply = PostgresReplyStore(self._database_url)._read_result(connection, stored)
        return self._complete_in_transaction(connection, scope, session_id, turn_id, reply)

    def _complete_in_transaction(
        self, connection: Any, scope: ContactScope, session_id: UUID, turn_id: UUID, reply: ReplyGenerated,
    ) -> AssistantTurn:
        self._require_session(connection, scope, session_id)
        turn = connection.execute(
            "SELECT * FROM public.assistant_session_turn WHERE owner_id = %s "
            "AND contact_id = %s AND session_id = %s AND id = %s FOR UPDATE",
            (scope.owner_id, scope.contact_id, session_id, turn_id),
        ).fetchone()
        if turn is None:
            raise AssistantSessionNotFound("助手讨论不存在。")
        if turn["state"] == "redacted":
            raise AssistantSessionRejected("source_deleted")
        if turn["interruption_reason"] is not None:
            raise AssistantSessionRejected("generation_interrupted")
        # C 已在实际保存事务中复验输入和来源；此处只关联可靠结果，不回退 CURRENT。
        stored = connection.execute(
            "SELECT * FROM public.reply_request WHERE owner_id = %s AND contact_id = %s "
            "AND id = %s AND idempotency_key = %s AND state = 'completed'",
            (scope.owner_id, scope.contact_id, reply.reply_request_id, turn["idempotency_key"]),
        ).fetchone()
        if stored is None or stored["conversation_binding_id"] != turn["conversation_binding_id"]:
            raise AssistantSessionPersistenceError("回复结果尚未可靠关联到会话。")
        from notalone.persistence.skill_execution_view import saved_skill_policy_change
        if saved_skill_policy_change(connection, scope, reply.reply_request_id) is not None:
            raise AssistantSessionRejected('skill_policy_changed')
        dependencies = set(turn["dependency_ids"]) | _reply_dependencies(
            connection, scope, reply.reply_request_id,
        )
        if not _dependencies_available(connection, scope, dependencies, historical=True):
            raise AssistantSessionRejected("source_unavailable")
        from notalone.persistence.reply_store import PostgresReplyStore
        saved_reply = PostgresReplyStore(self._database_url)._read_result(connection, stored)
        # 变化提示是当前只读投影；可靠候选正文及原依据仍必须完全一致。
        if replace(saved_reply, basis_changes=()) != replace(reply, basis_changes=()):
            raise AssistantSessionPersistenceError("回复结果与可靠保存记录不一致。")
        connection.execute(
            "UPDATE public.assistant_session_turn SET state = 'completed', interruption_reason = NULL, "
            "reply_request_id = %s, dependency_ids = %s, updated_at = now() WHERE id = %s",
            (reply.reply_request_id, list(dependencies), turn_id),
        )
        turn["state"] = "completed"
        return self._turn(turn, saved_reply)

    def fail(self, scope: ContactScope, turn_id: UUID) -> None:
        with self._transaction(scope) as connection:
            connection.execute(
                "UPDATE public.assistant_session_turn SET state = 'failed', updated_at = now() "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s AND state = 'running'",
                (scope.owner_id, scope.contact_id, turn_id),
            )

    def read(self, scope: ContactScope, session_id: UUID) -> tuple[AssistantTurn, ...]:
        with self._transaction(scope) as connection:
            self._require_session(connection, scope, session_id)
            return self._read_turns(connection, scope, session_id)

    def delete(self, scope: ContactScope, session_id: UUID) -> None:
        from notalone.persistence.assistant_session_deletion import delete_assistant_session
        with self._transaction(scope) as connection:
            delete_assistant_session(connection, scope, session_id)

    def read_session(self, scope: ContactScope, session_id: UUID) -> AssistantSessionSnapshot:
        from notalone.persistence.assistant_session_inputs import read_input_records, require_input_session
        with self._transaction(scope) as connection:
            session = require_input_session(connection, scope, session_id)
            return AssistantSessionSnapshot(
                session_id=session_id, current_input_version_id=session["current_input_version_id"],
                turns=self._read_turns(connection, scope, session_id),
                inputs=read_input_records(connection, scope, session_id),
            )

    def record_discussion_input(
        self, scope: ContactScope, session_id: UUID, content: dict[str, Any],
        expected_input_version_id: UUID | None = None,
        *, verified_dependencies: tuple[UUID, ...] = (),
    ) -> UUID:
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        return PostgresAssistantSessionInputs(self._database_url).record_discussion_input(
            scope, session_id, content, expected_input_version_id, verified_dependencies=verified_dependencies,
        )

    def is_current_input(self, scope: ContactScope, session_id: UUID, input_version_id: UUID) -> bool:
        from notalone.persistence.assistant_session_inputs import PostgresAssistantSessionInputs
        return PostgresAssistantSessionInputs(self._database_url).is_current_input(scope, session_id, input_version_id)

    def _read_turns(
        self, connection: Any, scope: ContactScope, session_id: UUID,
    ) -> tuple[AssistantTurn, ...]:
        rows = connection.execute(
            "SELECT turn.*, (request.id IS NULL AND turn.state='failed' AND EXISTS ("
            "SELECT 1 FROM public.reply_invalidated_key AS sealed WHERE sealed.owner_id=turn.owner_id "
            "AND sealed.contact_id=turn.contact_id AND sealed.idempotency_key=turn.idempotency_key)) AS prepared_key_sealed, "
            "CASE WHEN EXISTS (SELECT 1 FROM public.reply_attempt AS attempt "
            "WHERE attempt.reply_request_id = request.id AND attempt.state = 'running') THEN true "
            "WHEN request.state IN ('failed', 'completed', 'expired') AND EXISTS ("
            "SELECT 1 FROM public.reply_attempt AS attempt WHERE attempt.reply_request_id = request.id "
            "AND attempt.number = request.attempt AND attempt.state IN ('failed', 'completed', 'expired')) "
            "THEN false ELSE NULL END AS generation_active "
            "FROM public.assistant_session_turn AS turn LEFT JOIN public.reply_request AS request "
            "ON request.owner_id = turn.owner_id AND request.contact_id = turn.contact_id "
            "AND request.idempotency_key = turn.idempotency_key "
            "AND request.conversation_binding_id = turn.conversation_binding_id "
            "AND (turn.reply_request_id IS NULL OR request.id = turn.reply_request_id) "
            "WHERE turn.owner_id = %s AND turn.contact_id = %s AND turn.session_id = %s "
            "ORDER BY turn.created_at, turn.id",
            (scope.owner_id, scope.contact_id, session_id),
        ).fetchall()
        from notalone.persistence.reply_store import PostgresReplyStore
        store = PostgresReplyStore(self._database_url)
        turns = []
        for row in rows:
            reply = None
            if row["state"] != "redacted" and not _dependencies_available(
                connection, scope, set(row["dependency_ids"]), historical=True,
            ):
                # 此时只遮挡读取结果；真正来源清除后才写 redacted 占位。
                row["state"] = "unavailable"
                row["input_payload"] = None
            if row["state"] in ("running", "failed"):
                try:
                    captured_generation_dependencies(
                        connection, scope, row["idempotency_key"], row["conversation_binding_id"],
                        row["reply_request_id"], historical=True,
                    )
                except ReplyStoreInvariantError:
                    row["state"] = "unavailable"
                    row["input_payload"] = None
            if row["state"] == "completed":
                request = connection.execute(
                    "SELECT * FROM public.reply_request WHERE owner_id = %s AND contact_id = %s "
                    "AND id = %s AND state = 'completed'",
                    (scope.owner_id, scope.contact_id, row["reply_request_id"]),
                ).fetchone()
                if request is None:
                    raise AssistantSessionPersistenceError("会话回复记录不完整。")
                # 已知来源拒绝只遮挡本轮；数据库与其他记录故障仍明确失败。
                try:
                    require_reply_sources_current(connection, owner_id=scope.owner_id,
                                                  request_id=request["id"], historical=True)
                except ReplyStoreInvariantError:
                    row["state"] = "unavailable"
                    row["input_payload"] = None
                else:
                    reply = store._read_result(connection, request)
            turns.append(self._turn(row, reply, connection=connection))
        return tuple(turns)

    @staticmethod
    def _turn(row: dict[str, Any], reply: ReplyGenerated | None, *, connection: Any | None = None) -> AssistantTurn:
        from notalone.persistence.assistant_prepared_format import requires_reprepare
        scope = ContactScope(row["owner_id"], row["contact_id"])
        reprepare = (requires_reprepare(row, scope, connection=connection)
                     if row["state"] not in ("redacted", "unavailable", "completed") else False)
        active = row.get("generation_active")
        if reprepare and row.get("prepared_key_sealed"):
            active = False
        return AssistantTurn(
            turn_id=row["id"], session_id=row["session_id"],
            input_version_id=row["input_version_id"], request_key=row["idempotency_key"],
            state=row["state"], input=row["input_payload"], reply=reply,
            interruption_reason=row.get("interruption_reason") if row["state"] == "failed" else None,
            generation_active=(active
                               if row["state"] not in ("redacted", "unavailable") else None),
            requires_reprepare=reprepare,
        )
