"""助手准备回执的有界材料：固定正文、补查身份和既有删除依赖。"""
from dataclasses import replace
from uuid import UUID, uuid4
from typing import Any, Callable

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.persistence.assistant_session_store import _dependencies_available, _evidence_dependencies
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.assistant_discussion_context import require_assistant_discussion_current
from notalone.reply.context import allows_history, ReplyContext, ReplyContextPort, ContinuedReplyCandidate
from notalone.reply.interface import GenerateReply
from notalone.scopes import VerifiedConversationScope
from notalone.reply.errors import ReplyContextInvariantError
from notalone.reply.prepared_context_codec import encode_context, decode_context

# 只保存补查身份，不复制历史正文；模型仍受原次数、条数和字符预算约束。
HISTORY_SCOPE_LIMIT = 500


class PreparedAssistantContext:
    def __init__(self, context: ReplyContextPort, database_url: str) -> None:
        self._context, self._database_url = context, database_url

    def _read(self, command: GenerateReply) -> dict[str, Any] | None:
        with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
            return connection.execute(
                "SELECT id,state,input_payload,prepared_context FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                (command.scope.owner_id, command.scope.contact_id, command.idempotency_key),
            ).fetchone()

    def build(self, *, command: GenerateReply, verified_scope: VerifiedConversationScope,
              reply_request_id: UUID | None = None,
              continued_candidate: ContinuedReplyCandidate | None = None) -> ReplyContext:
        row = self._read(command)
        if row is not None and row["prepared_context"] is not None:
            if row["input_payload"] is None or row["state"] in ("redacted", "unavailable"):
                raise ReplyContextInvariantError("固定上下文已失效。")
            return decode_context(row["prepared_context"], command, reply_request_id)
        return self._context.build(command=command, verified_scope=verified_scope,
                                   reply_request_id=reply_request_id, continued_candidate=continued_candidate)

    def prepare(self, *, command: GenerateReply, verified_scope: VerifiedConversationScope,
                validate: Callable[[ReplyContext], None]) -> None:
        row = self._read(command)
        if row is None or row["input_payload"] is None:
            raise ReplyContextInvariantError("准备输入没有可靠身份。")
        if row["state"] == "completed":
            return
        with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
            continued = PostgresReplyStore._resolve_continuation(connection, command, verified_scope)
        context = self.build(command=command, verified_scope=verified_scope, reply_request_id=uuid4(),
                             continued_candidate=continued)
        self.validate_current(context)
        validate(context)
        scope = command.scope
        dependencies = {identifier for item in context.style_references for identifier in (*item.source_ids, item.sample_id)}
        with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=scope.owner_id)
            current = connection.execute(
                "SELECT state,input_payload,prepared_context FROM public.assistant_session_turn WHERE id=%s FOR UPDATE",
                (row["id"],),
            ).fetchone()
            if current is None or current["input_payload"] != row["input_payload"] or current["state"] in ("redacted", "unavailable"):
                raise ReplyContextInvariantError("准备输入或来源已变化。")
            for item in context.evidence:
                dependencies.update(_evidence_dependencies(connection, owner_id=scope.owner_id,
                    evidence_id=item.evidence_id, kind=item.kind, source_ids=set(item.source_ids)))
            if context.assistant_discussion is not None:
                discussion = require_assistant_discussion_current(connection, scope, context.assistant_discussion.snapshot)
                dependencies.update(discussion.source_ids)
                dependencies.update(discussion.style_sample_ids)
            if not _dependencies_available(connection, scope, dependencies):
                raise ReplyContextInvariantError("准备资料已失效。")
            if current["prepared_context"] is not None:
                return
            message_ids = tuple(item["id"] for item in connection.execute(
                f"SELECT m.id FROM public.message AS m WHERE m.owner_id=%s AND m.contact_id=%s AND {valid_source_ref_exists_sql('m')} "
                "ORDER BY m.occurred_at DESC NULLS LAST,m.id DESC LIMIT %s",
                (scope.owner_id, scope.contact_id, HISTORY_SCOPE_LIMIT),
            ).fetchall()) if allows_history(command) else ()
            message_ids = tuple(sorted(set(message_ids) | {item.evidence_id for item in context.evidence if item.kind == "message"}))
            context = replace(context, history_message_ids=message_ids)
            connection.execute(
                "UPDATE public.assistant_session_turn SET prepared_context=%s, "
                "dependency_ids=ARRAY(SELECT DISTINCT unnest(dependency_ids || %s::uuid[])) WHERE id=%s",
                (Jsonb(encode_context(context)), list(dependencies), row["id"]),
            )

    def validate_current(self, context: ReplyContext) -> None:
        self._context.validate_current(context)
