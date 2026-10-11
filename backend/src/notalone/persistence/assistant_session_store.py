"""PostgreSQL 默认助手会话；候选只从既有回复权威记录读取。"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from typing import Any, Iterator
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound,
    AssistantSessionPersistenceError, AssistantSessionRejected, AssistantSessionSnapshot, AssistantTurn,
)
from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.persistence.style_sample_store import captured_reply_sources, require_reply_sources_current
from notalone.reply.context import ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.exploration import ExplorationExpired
from notalone.reply.interface import ReplyGenerated, ReplyToMessage
from notalone.reply.store import ReplyRequest, _normalize_input, canonical_reply_input
from notalone.scopes import ContactScope


def _digest(binding_id: UUID, normalized: str) -> str:
    return hashlib.sha256(f"{binding_id}:{normalized}".encode("utf-8")).hexdigest()


def _input_payload(normalized: str) -> dict[str, Any]:
    content = json.loads(normalized)
    continued = content.pop("continued_from_candidate_id")
    skill = content.pop("skill")
    content["type"] = content.pop("mode")
    return {"content": content, "continued_from_candidate_id": continued,
            "skill_version_id": skill.split(":", 1)[1] if skill.startswith("user_choice:") else None,
            "skill_disabled": skill == "disabled"}


def _active_binding(connection: Any, scope: ContactScope) -> UUID:
    if not connection.execute(
        "SELECT 1 FROM public.contact WHERE owner_id = %s AND id = %s",
        (scope.owner_id, scope.contact_id),
    ).fetchone():
        raise AssistantSessionNotFound("指定范围内不存在联系人。")
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
        ))
    for identifier in {row["request_id"] for row in rows}:
        dependencies.update(captured_reply_sources(connection, owner_id=scope.owner_id, request_id=identifier))
    # 继承当时实际捕获的依赖，不把后来挂接的来源补进旧候选的来历。
    return dependencies


def _evidence_dependencies(
    connection: Any, *, owner_id: UUID, evidence_id: UUID, kind: str,
    source_ids: set[UUID],
) -> set[UUID]:
    dependencies = set(source_ids)
    if kind == "owner_memory" and dependencies == {owner_id} and connection.execute(
        "SELECT 1 FROM public.owner_memory WHERE owner_id = %s AND id = %s "
        "AND adoption_method = 'manual' AND source_ids = %s::uuid[]",
        (owner_id, evidence_id, [owner_id]),
    ).fetchone():
        # 手工本人记忆沿用 owner 伪引用；依赖具体记忆，不能把任意 UUID 当来源放行。
        dependencies.clear()
    if kind not in ("user_draft", "user_purpose", "continued_candidate"):
        dependencies.add(evidence_id)
    return dependencies


def _dependencies_available(connection: Any, owner_id: UUID, dependencies: set[UUID]) -> bool:
    """同一 owner 锁与数据库事务时间内核验来源、证据和记忆有效期。"""

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
                SELECT 1 FROM public.confirmed_memory AS memory
                WHERE memory.owner_id = %(owner_id)s AND memory.id = dependency.id
                  AND memory.status = 'active'
                  AND (memory.valid_at IS NULL OR memory.valid_at <= now())
                  AND (memory.invalid_at IS NULL OR now() < memory.invalid_at)
                UNION ALL
                SELECT 1 FROM public.owner_memory AS memory
                WHERE memory.owner_id = %(owner_id)s AND memory.id = dependency.id
                  AND memory.status = 'active'
                  AND (memory.valid_at IS NULL OR memory.valid_at <= now())
                  AND (memory.invalid_at IS NULL OR now() < memory.invalid_at)
                  AND (memory.source_ids <> ARRAY[%(owner_id)s]::uuid[]
                       OR memory.adoption_method = 'manual')
                UNION ALL
                SELECT 1 FROM public.memory_candidate AS candidate
                WHERE candidate.owner_id = %(owner_id)s AND candidate.id = dependency.id
                  AND candidate.status IN ('pending', 'confirmed')
                  AND (candidate.valid_at IS NULL OR candidate.valid_at <= now())
                  AND (candidate.invalid_at IS NULL OR now() < candidate.invalid_at)
            )
        ) AS available
        """,
        {"owner_id": owner_id, "dependencies": list(dependencies)},
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
    if (binding_id != request.conversation_binding_id
            or turn["conversation_binding_id"] != binding_id
            or turn["input_digest"] != _digest(binding_id, request.normalized_input)):
        raise ReplyStoreInvariantError("助手会话输入版本已失效。")
    from notalone.persistence.assistant_session_inputs import require_current_input
    try:
        require_current_input(connection, request.scope, turn["session_id"], turn["input_version_id"])
    except (AssistantSessionRejected, AssistantSessionNotFound):
        raise ReplyStoreInvariantError("助手会话当前输入已改变，不能提交旧候选。") from None
    dependencies = set(turn["dependency_ids"])
    dependencies.update(captured_reply_sources(connection, owner_id=request.scope.owner_id,
                                               request_id=request.request_id))
    for evidence in context.evidence:
        dependencies.update(_evidence_dependencies(
            connection, owner_id=request.scope.owner_id, evidence_id=evidence.evidence_id,
            kind=evidence.kind, source_ids=set(evidence.source_ids),
        ))
    if request.continued_from_candidate_id is not None:
        previous = connection.execute(
            "SELECT reply_request_id FROM public.reply_candidate "
            "WHERE owner_id = %s AND contact_id = %s AND id = %s",
            (request.scope.owner_id, request.scope.contact_id, request.continued_from_candidate_id),
        ).fetchone()
        if previous is None:
            raise ReplyStoreInvariantError("前序候选来源已失效。")
        dependencies.update(_reply_dependencies(connection, request.scope, previous["reply_request_id"]))
    if not _dependencies_available(connection, request.scope.owner_id, dependencies):
        raise ReplyStoreInvariantError("助手会话来源已失效，不能提交旧候选。")
    connection.execute(
        "UPDATE public.assistant_session_turn SET reply_request_id = %s, dependency_ids = %s, "
        "updated_at = now() WHERE id = %s",
        (request.request_id, list(dependencies), turn["id"]),
    )


def erase_assistant_source_turns(
    connection: Any, *, owner_id: UUID, contact_id: UUID | None,
    removed_ids: set[UUID], reply_request_ids: list[UUID],
    turn_ids: list[UUID] | None = None,
) -> None:
    """在原回复副本清除前留下无正文占位，同一 owner 下的传递依赖全部清除。"""

    explicit_turn_ids = set(turn_ids or ())
    rows = connection.execute(
        """
        SELECT turn.id, turn.input_payload, turn.dependency_ids,
               request.state AS request_state
        FROM public.assistant_session_turn AS turn
        LEFT JOIN public.reply_request AS request
          ON request.owner_id = turn.owner_id AND request.contact_id = turn.contact_id
         AND request.idempotency_key = turn.idempotency_key
        WHERE turn.owner_id = %s AND turn.state <> 'redacted'
          AND (turn.dependency_ids && %s::uuid[] OR request.id = ANY(%s::uuid[])
               OR (turn.id = ANY(%s::uuid[])
                   AND (%s::uuid IS NULL OR turn.contact_id = %s)))
        FOR UPDATE OF turn
        """,
        (owner_id, list(removed_ids), reply_request_ids, list(explicit_turn_ids), contact_id, contact_id),
    ).fetchall()
    for row in rows:
        payload = row["input_payload"] if isinstance(row, dict) else row[1]
        dependencies = row["dependency_ids"] if isinstance(row, dict) else row[2]
        request_state = row["request_state"] if isinstance(row, dict) else row[3]
        turn_id = row["id"] if isinstance(row, dict) else row[0]
        # 既有删除会撤销同联系人所有运行租约；与来源无关的独立草稿仍可回看。
        independent_draft = (
            turn_id not in explicit_turn_ids
            and request_state == "running" and not (set(dependencies) & removed_ids)
            and payload["content"]["type"] == "rewrite_draft"
            and not payload["content"].get("include_relationship_context", False)
            and payload.get("continued_from_candidate_id") is None
        )
        if independent_draft:
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
    erase_assistant_source_inputs(connection, owner_id=owner_id, removed_ids=removed_ids)


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

    def reserve(
        self, scope: ContactScope, session_id: UUID, request: ReplyServiceRequest,
    ) -> UUID:
        with self._transaction(scope) as connection:
            self._require_session(connection, scope, session_id)
            binding_id = _active_binding(connection, scope)
            command = request.build_command(
                owner_id=scope.owner_id, contact_id=scope.contact_id, binding_id=binding_id,
            )
            if command is None or not command.has_valid_content():
                raise AssistantSessionRejected("invalid_reply_input")
            normalized = _normalize_input(command)
            digest = _digest(binding_id, normalized)
            existing = connection.execute(
                "SELECT id, session_id, state, input_digest FROM public.assistant_session_turn "
                "WHERE owner_id = %s AND contact_id = %s AND idempotency_key = %s FOR UPDATE",
                (scope.owner_id, scope.contact_id, request.idempotency_key),
            ).fetchone()
            if existing is not None:
                if existing["state"] == "redacted":
                    raise AssistantSessionRejected("source_deleted")
                if existing["session_id"] != session_id or existing["input_digest"] != digest:
                    raise AssistantSessionConflict("请求键已用于不同输入。")
                dependencies = connection.execute(
                    "SELECT dependency_ids FROM public.assistant_session_turn WHERE id = %s",
                    (existing["id"],),
                ).fetchone()["dependency_ids"]
                if not _dependencies_available(connection, scope.owner_id, set(dependencies)):
                    raise AssistantSessionRejected("source_unavailable")
                if existing["state"] != "completed":
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
            from notalone.persistence.assistant_session_inputs import check_expected_input, require_input_session
            check_expected_input(require_input_session(connection, scope, session_id), request.expected_input_version_id)
            from notalone.persistence.explored_generation import prepare_explored_generation
            dependencies = prepare_explored_generation(connection, scope, session_id, command)
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
            if not _dependencies_available(connection, scope.owner_id, dependencies):
                raise AssistantSessionRejected("source_unavailable")
            row = connection.execute(
                "INSERT INTO public.assistant_session_turn "
                "(session_id, owner_id, contact_id, idempotency_key, conversation_binding_id, "
                "input_digest, input_payload, dependency_ids) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, input_version_id",
                (session_id, scope.owner_id, scope.contact_id, request.idempotency_key,
                 binding_id, digest, Jsonb(_input_payload(canonical_reply_input(command))), list(dependencies)),
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
            self._require_session(connection, scope, session_id)
            binding_id = _active_binding(connection, scope)
            turn = connection.execute(
                "SELECT * FROM public.assistant_session_turn WHERE owner_id = %s "
                "AND contact_id = %s AND session_id = %s AND id = %s FOR UPDATE",
                (scope.owner_id, scope.contact_id, session_id, turn_id),
            ).fetchone()
            if turn is None:
                raise AssistantSessionNotFound("助手讨论不存在。")
            if turn["state"] == "redacted":
                raise AssistantSessionRejected("source_deleted")
            if turn["state"] != "completed":
                # 首次可靠完成前继续复验；已完成同 key 重放保留历史身份。
                from notalone.persistence.assistant_session_inputs import require_current_input
                require_current_input(connection, scope, session_id, turn["input_version_id"])
            stored = connection.execute(
                "SELECT * FROM public.reply_request WHERE owner_id = %s AND contact_id = %s "
                "AND id = %s AND idempotency_key = %s AND state = 'completed'",
                (scope.owner_id, scope.contact_id, reply.reply_request_id, turn["idempotency_key"]),
            ).fetchone()
            if stored is None or stored["conversation_binding_id"] != binding_id:
                raise AssistantSessionPersistenceError("回复结果尚未可靠关联到会话。")
            dependencies = set(turn["dependency_ids"]) | _reply_dependencies(
                connection, scope, reply.reply_request_id,
            )
            if not _dependencies_available(connection, scope.owner_id, dependencies):
                raise AssistantSessionRejected("source_unavailable")
            from notalone.persistence.reply_store import PostgresReplyStore
            saved_reply = PostgresReplyStore(self._database_url)._read_result(connection, stored)
            if saved_reply != reply:
                raise AssistantSessionPersistenceError("回复结果与可靠保存记录不一致。")
            connection.execute(
                "UPDATE public.assistant_session_turn SET state = 'completed', "
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
            "SELECT * FROM public.assistant_session_turn WHERE owner_id = %s "
            "AND contact_id = %s AND session_id = %s ORDER BY created_at, id",
            (scope.owner_id, scope.contact_id, session_id),
        ).fetchall()
        from notalone.persistence.reply_store import PostgresReplyStore
        store = PostgresReplyStore(self._database_url)
        turns = []
        for row in rows:
            reply = None
            if row["state"] != "redacted" and not _dependencies_available(
                connection, scope.owner_id, set(row["dependency_ids"]),
            ):
                # 此时只遮挡读取结果；真正来源清除后才写 redacted 占位。
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
                    require_reply_sources_current(connection, owner_id=scope.owner_id, request_id=request["id"])
                except ReplyStoreInvariantError:
                    row["state"] = "unavailable"
                    row["input_payload"] = None
                else:
                    reply = store._read_result(connection, request)
            turns.append(self._turn(row, reply))
        return tuple(turns)

    @staticmethod
    def _turn(row: dict[str, Any], reply: ReplyGenerated | None) -> AssistantTurn:
        return AssistantTurn(
            turn_id=row["id"], session_id=row["session_id"],
            input_version_id=row["input_version_id"], request_key=row["idempotency_key"],
            state=row["state"], input=row["input_payload"], reply=reply,
        )
