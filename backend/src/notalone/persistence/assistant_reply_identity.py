"""原 owner 交易中复验 A 领取的持续输入身份，不接公开生成路径。"""

from __future__ import annotations

from typing import Any

from notalone.application.assistant_continuation_identity import (
    AssistantContinuationInvalid, continuation_commit_input,
)
from notalone.reply.errors import ReplyIdempotencyConflictError, ReplyStoreInvariantError
from notalone.reply.interface import GenerateReply
from notalone.scopes import VerifiedConversationScope


def prepare_assistant_reply_start(
    connection: Any, command: GenerateReply, verified_scope: VerifiedConversationScope,
    normalized_input: str,
) -> None:
    """原owner事务内只复验A领取身份；合法旧重放继续由C裁定来源及租约。"""

    from notalone.persistence.assistant_session_store import _digest

    turn = connection.execute(
        "SELECT conversation_binding_id,input_digest,input_payload,state "
        "FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s "
        "AND idempotency_key=%s FOR SHARE",
        (verified_scope.owner_id, verified_scope.contact_id, command.idempotency_key),
    ).fetchone()
    if turn is not None and turn["state"] == "redacted":
        raise ReplyStoreInvariantError("助手会话来源已失效。")
    try:
        normalized = continuation_commit_input(
            command, normalized_input, turn["input_payload"] if turn is not None else None,
        )
    except AssistantContinuationInvalid:
        raise ReplyIdempotencyConflictError("请求键已用于不同的持续要求身份。") from None
    if turn is None:
        return
    if (turn["conversation_binding_id"] != verified_scope.conversation_binding_id
            or command.conversation_binding_id != verified_scope.conversation_binding_id
            or turn["input_digest"] != _digest(verified_scope.conversation_binding_id, normalized)):
        raise ReplyIdempotencyConflictError("请求键已用于不同的助手会话输入。")
