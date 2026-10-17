"""助手准备回执的有界材料：固定正文、补查身份和既有删除依赖。"""
from dataclasses import replace
from notalone.reply.input_budget import InputBudgetExceededError
from uuid import UUID, uuid4
from notalone.reply.layered_context import require_material
from typing import Any, Callable

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.persistence.reply_overview_navigation import require_current_overview_navigation, navigation_dependency_ids
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.expression_preferences import _require_context_preferences
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.persistence.assistant_session_store import _dependencies_available, _evidence_dependencies, _reply_dependencies
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.reply_basis_changes import require_current_reply_memory
from notalone.persistence.reply_continuation_basis import read_continuation_basis
from notalone.persistence.assistant_discussion_context import require_assistant_discussion_current
from notalone.reply.context import allows_history, ReplyContext, ReplyContextPort, ContinuedReplyCandidate
from notalone.reply.interface import GenerateReply
from notalone.scopes import VerifiedConversationScope
from notalone.reply.errors import ReplyContextInvariantError
from notalone.reply.prepared_context_codec import encode_context, decode_context

# 只保存补查身份，不复制历史正文；模型仍受原次数、条数和字符预算约束。
HISTORY_SCOPE_LIMIT = 500


class PreparedAssistantContext:
    def __init__(self, context: ReplyContextPort, database_url: str, *, layered_memory=None, layered_budget=None, owner_layered_budget=None) -> None:
        self._context, self._database_url = context, database_url
        self._layered_memory, self._layered_budget = layered_memory, layered_budget
        self._owner_layered_budget = owner_layered_budget

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
            lock_owner_scope(connection, owner_id=command.scope.owner_id)
            continued = PostgresReplyStore._resolve_continuation(connection, command, verified_scope)
            message_ids = tuple(item["id"] for item in connection.execute(
                f"SELECT m.id FROM public.message AS m WHERE m.owner_id=%s AND m.contact_id=%s AND {valid_source_ref_exists_sql('m')} "
                "ORDER BY m.occurred_at DESC NULLS LAST,m.id DESC LIMIT %s",
                (command.scope.owner_id, command.scope.contact_id, HISTORY_SCOPE_LIMIT),
            ).fetchall()) if allows_history(command) else ()
        context = (decode_context(row["prepared_context"], command) if row["prepared_context"] is not None else self._context.build(command=command, verified_scope=verified_scope, reply_request_id=uuid4(),
                             continued_candidate=continued, history_message_ids=message_ids))
        self.validate_current(context)
        context = self.fit_budget(context, validate=validate)
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
            historical: set[UUID] = set()
            for item in context.evidence:
                is_historical = item.navigation is not None and item.timing.current_status == "historical"
                target = historical if is_historical else dependencies
                target.update(_evidence_dependencies(connection, owner_id=scope.owner_id,
                    evidence_id=item.evidence_id, kind=item.kind, source_ids=set(item.source_ids),
                    historical=is_historical))
            require_current_overview_navigation(connection, context, PostgresRelationshipOverviewStore(self._database_url))
            require_material(context, self._layered_memory, connection=connection, budget=self._layered_budget, owner_budget=self._owner_layered_budget)
            _require_context_preferences(connection, context)
            dependencies.update(identifier for item in context.expression_preferences
                                for identifier in (item.preference_id, *item.source_ids,
                                    *((item.origin_id,) if item.origin_id is not None else ())))
            require_current_reply_memory(connection, scope, context.evidence)
            if not _dependencies_available(connection, scope, dependencies):
                raise ReplyContextInvariantError("准备资料已失效。")
            if context.assistant_discussion is not None:
                discussion = require_assistant_discussion_current(connection, scope, context.assistant_discussion.snapshot)
                historical.update(discussion.source_ids)
                historical.update(discussion.style_sample_ids)
            if context.continuation_basis is not None:
                basis = read_continuation_basis(connection, scope, command.conversation_binding_id,
                                                 context.continuation_basis.candidate_id)
                if basis != context.continuation_basis:
                    raise ReplyContextInvariantError("准备时历史依据已变化。")
                previous = connection.execute(
                    "SELECT reply_request_id FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s AND id=%s",
                    (scope.owner_id, scope.contact_id, basis.candidate_id),
                ).fetchone()
                historical.update(_reply_dependencies(connection, scope, previous["reply_request_id"]))
            if not _dependencies_available(connection, scope, historical, historical=True):
                raise ReplyContextInvariantError("准备时历史来源已失效。")
            dependencies.update(historical)
            if current["prepared_context"] is not None:
                return
            dependencies.update(UUID(identifier) for identifier in navigation_dependency_ids(context))
            connection.execute(
                "UPDATE public.assistant_session_turn SET prepared_context=%s, "
                "dependency_ids=ARRAY(SELECT DISTINCT unnest(dependency_ids || %s::uuid[])) WHERE id=%s",
                (Jsonb(encode_context(context)), list(dependencies), row["id"]),
            )

    def fit_budget(self, context: ReplyContext, *, validate) -> ReplyContext:
        """仅新准备可省略新增层；已持久冻结的输入容量变化必须重新准备。"""
        try:
            validate(context)
        except InputBudgetExceededError:
            row = self._read(context.command)
            if (context.layered_context is None and context.owner_layered_context is None
                    or row and row["prepared_context"] is not None):
                raise
            # 完整请求仍优先保留用户全文与原L1；每侧有独立的省略状态。
            for prefix in ("owner_", ""):
                if getattr(context, prefix + "layered_context") is None:
                    continue
                context = replace(context, **{prefix + "layered_context": None,
                    prefix + "layered_status": "budget_omitted"})
                try:
                    validate(context)
                    break
                except InputBudgetExceededError:
                    if prefix == "":
                        raise
        return context

    def validate_current(self, context: ReplyContext) -> None:
        self._context.validate_current(context)
