"""将权威完整讨论接入一次回复；同连接复验，不持锁调用基底适配器。"""

from __future__ import annotations

from dataclasses import replace
from uuid import UUID

import psycopg

from notalone.persistence.assistant_discussion_context import (
    read_assistant_discussion_in_transaction,
    require_assistant_discussion_current,
)
from notalone.persistence.locks import lock_owner_scope
from notalone.reply.context import (
    ContinuedReplyCandidate,
    ReplyContext,
    ReplyContextPort,
)
from notalone.reply.errors import (
    ReplyContextError,
    ReplyContextInvariantError,
    ReplyStoreInvariantError,
)
from notalone.reply.interface import GenerateReply
from notalone.scopes import VerifiedConversationScope


class PostgresAssistantDiscussionContext:
    """基底负责本轮资料；本适配器只读 A 正文与 CURRENT 身份快照。"""

    def __init__(self, context: ReplyContextPort, *, database_url: str) -> None:
        self._context = context
        self._database_url = database_url

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        reply_request_id: UUID | None = None,
        continued_candidate: ContinuedReplyCandidate | None = None,
    ) -> ReplyContext:
        # C 的样本选择及 B 的探索读取会自开 owner 事务，须先完成并释放。
        context = self._context.build(
            command=command, verified_scope=verified_scope,
            reply_request_id=reply_request_id, continued_candidate=continued_candidate,
        )
        if not isinstance(context, ReplyContext) or context.scope != command.scope or context.command != command:
            raise ReplyContextInvariantError("基底回复上下文与当前请求不一致。")
        try:
            with psycopg.connect(self._database_url) as connection:
                lock_owner_scope(connection, owner_id=context.scope.owner_id)
                discussion = read_assistant_discussion_in_transaction(
                    connection, context.scope, command.idempotency_key,
                )
        except ReplyStoreInvariantError:
            raise ReplyContextInvariantError("助手讨论或当前输入已失效。") from None
        except psycopg.Error:
            raise ReplyContextError("助手讨论读取失败。") from None
        return replace(context, assistant_discussion=discussion)

    def validate_current(self, context: ReplyContext) -> None:
        if not isinstance(context, ReplyContext):
            raise ReplyContextInvariantError("回复上下文快照结构无效。")
        # 不在 A owner 锁内调用可能自开连接的基底 freshness 检查。
        validator = getattr(self._context, "validate_current", None)
        if callable(validator):
            validator(context)
        discussion = context.assistant_discussion
        try:
            with psycopg.connect(self._database_url) as connection:
                lock_owner_scope(connection, owner_id=context.scope.owner_id)
                if discussion is None:
                    # None 只兼容无 A 锚点的旧全局入口，不能忽略已存在的讨论。
                    if read_assistant_discussion_in_transaction(
                        connection, context.scope, context.command.idempotency_key,
                    ) is not None:
                        raise ReplyContextInvariantError("本次回复缺少完整助手讨论。")
                else:
                    if discussion.scope != context.scope or discussion.request_key != context.command.idempotency_key:
                        raise ReplyContextInvariantError("助手讨论不属于当前回复。")
                    require_assistant_discussion_current(connection, context.scope, discussion.snapshot)
        except ReplyStoreInvariantError:
            raise ReplyContextInvariantError("助手讨论或当前输入已失效。") from None
        except psycopg.Error:
            raise ReplyContextError("助手讨论复验失败。") from None
