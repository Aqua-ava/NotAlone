"""实际回复输入模式与有界长期表达偏好的契约。"""

from __future__ import annotations

from uuid import UUID

from notalone.reply.expression_preference_models import ExpressionPreference, ExpressionReplyMode
from notalone.reply.errors import ReplyContextInvariantError
from notalone.reply.interface import ExpressionPreferenceReceipt, GenerateReply, InitiateConversation, ReplyToMessage, RewriteDraft
from notalone.scopes import ContactScope

PREFERENCE_LIMIT = 5
PREFERENCE_CHAR_BUDGET = 1536


def expression_reply_mode(command: GenerateReply) -> ExpressionReplyMode:
    if isinstance(command.content, ReplyToMessage):
        return "reply_to_message"
    if isinstance(command.content, RewriteDraft):
        return "rewrite_draft"
    if isinstance(command.content, InitiateConversation):
        return "initiate_conversation"
    raise ReplyContextInvariantError("表达偏好输入模式无效。")


def require_preference_contract(scope: ContactScope, reply_mode: ExpressionReplyMode,
                                preferences: tuple[ExpressionPreference, ...], revision: int | None) -> None:
    if revision is None and not preferences:
        return
    if type(revision) is not int or revision < 0 or not isinstance(preferences, tuple) or len(preferences) > PREFERENCE_LIMIT:
        raise ReplyContextInvariantError("长期表达偏好快照无效。")
    if any(not isinstance(item, ExpressionPreference) or item.scope.owner_id != scope.owner_id
           or item.scope.contact_id not in {None, scope.contact_id} or item.scope.reply_mode not in {None, reply_mode}
           or not isinstance(item.text, str) or not 1 <= len(item.text.strip()) <= 512
           or type(item.revision) is not int or item.revision < 1 for item in preferences):
        raise ReplyContextInvariantError("长期表达偏好超出本次适用范围。")
    if len({item.preference_id for item in preferences}) != len(preferences) or sum(len(item.text) for item in preferences) > PREFERENCE_CHAR_BUDGET:
        raise ReplyContextInvariantError("长期表达偏好超出有界预算。")


def preference_context_payload(item: ExpressionPreference) -> dict[str, object]:
    return {"preference_id": str(item.preference_id), "revision": item.revision, "text": item.text,
            "scope": {"contact_id": None if item.scope.contact_id is None else str(item.scope.contact_id),
                      "reply_mode": item.scope.reply_mode},
            "factual_role": "expression_preference", "priority": "below_current_intent"}


def preference_receipts(items: tuple[ExpressionPreference, ...]) -> tuple[ExpressionPreferenceReceipt, ...]:
    return tuple(ExpressionPreferenceReceipt(item.preference_id, item.text, item.revision,
                                             item.scope.contact_id, item.scope.reply_mode)
                 for item in sorted(items, key=lambda item: item.preference_id))


def preference_receipt_payload(item: ExpressionPreferenceReceipt) -> dict[str, object]:
    return {"preference_id": str(item.preference_id), "text": item.text, "revision": item.revision,
            "scope": {"contact_id": None if item.contact_id is None else str(item.contact_id),
                      "reply_mode": item.reply_mode}}


def read_preference_receipts(value: object, *, contact_id: UUID) -> tuple[ExpressionPreferenceReceipt, ...]:
    """只解码完成回复的生成快照，不回读当前偏好正文。"""
    if not isinstance(value, list) or len(value) > PREFERENCE_LIMIT:
        raise ValueError("生成时长期偏好回执无效。")
    items = []
    for row in value:
        if not isinstance(row, dict) or set(row) != {"preference_id", "text", "revision", "scope"}:
            raise ValueError("生成时长期偏好回执无效。")
        scope = row["scope"]
        if not isinstance(scope, dict) or set(scope) != {"contact_id", "reply_mode"}:
            raise ValueError("生成时长期偏好范围无效。")
        item = ExpressionPreferenceReceipt(UUID(row["preference_id"]), row["text"], row["revision"],
                                           None if scope["contact_id"] is None else UUID(scope["contact_id"]), scope["reply_mode"])
        if item.contact_id not in {None, contact_id}:
            raise ValueError("生成时长期偏好超出联系人范围。")
        items.append(item)
    if len({item.preference_id for item in items}) != len(items) or sum(len(item.text) for item in items) > PREFERENCE_CHAR_BUDGET:
        raise ValueError("生成时长期偏好超出有界预算。")
    return tuple(sorted(items, key=lambda item: item.preference_id))
