"""回复请求 JSON 的解析与契约校验。

只负责把不可信请求体转成应用层请求（ReplyServiceRequest）；绑定
解析与命令构造在服务层按真实绑定目录完成。校验失败抛
ReplyRequestInvalid，不向界面回显请求内容。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from notalone.application.reply_service import ReplyServiceRequest
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    InitiateConversation,
    ReplyToMessage,
    RewriteDraft,
)


class ReplyRequestInvalid(ValueError):
    """请求体结构或契约无效；不携带请求内容细节。"""


def parse_reply_request(body: bytes) -> tuple[UUID, ReplyServiceRequest]:
    """解析并校验一个回复请求；返回 (contact_id, 请求)。

    任何异常都收敛为 ReplyRequestInvalid。
    """

    try:
        import json

        payload = json.loads(body.decode("utf-8")) if body.strip() else None
    except (UnicodeDecodeError, ValueError):
        raise ReplyRequestInvalid() from None
    if not isinstance(payload, dict):
        raise ReplyRequestInvalid()

    idempotency_key = _uuid_field(payload, "idempotency_key")
    contact_id = _uuid_field(payload, "contact_id")
    content_value = payload.get("content")
    if not isinstance(content_value, dict):
        raise ReplyRequestInvalid()
    content_type = content_value.get("type")
    if content_type == "reply_to_message":
        content = _parse_reply_to_message(content_value)
    elif content_type == "rewrite_draft":
        content = _parse_rewrite_draft(content_value)
    elif content_type == "initiate_conversation":
        purpose = content_value.get("purpose")
        if not isinstance(purpose, str) or not purpose.strip() or len(purpose) > 4096:
            raise ReplyRequestInvalid()
        if content_value.get("target_message_id") is not None:
            raise ReplyRequestInvalid()
        content = InitiateConversation(ConfirmedDirection(purpose, DirectionSource.DIRECT_INPUT))
    else:
        raise ReplyRequestInvalid()

    continued = payload.get("continued_from_candidate_id")
    continued_id = _optional_uuid(continued)
    skill_value = payload.get("skill_version_id")
    skill_id = _optional_uuid(skill_value)
    skill_disabled = payload.get("skill_disabled", False)
    if not isinstance(skill_disabled, bool) or (skill_disabled and skill_id is not None):
        raise ReplyRequestInvalid()
    return contact_id, ReplyServiceRequest(
        idempotency_key=idempotency_key,
        content=content,
        continued_from_candidate_id=continued_id,
        skill_version_id=skill_id,
        skill_disabled=skill_disabled,
    )


def _parse_reply_to_message(content: dict[str, Any]) -> ReplyToMessage:
    target = _uuid_field(content, "target_message_id")
    direction_text = content.get("direction")
    if not isinstance(direction_text, str) or not direction_text.strip():
        raise ReplyRequestInvalid()
    source = content.get("direction_source")
    if source not in ("direct_input", "confirmed_suggestion"):
        source = "direct_input"
    return ReplyToMessage(
        target_message_id=target,
        direction=ConfirmedDirection(
            text=direction_text,
            source=DirectionSource(source),
        ),
    )


def _parse_rewrite_draft(content: dict[str, Any]) -> RewriteDraft:
    draft_text = content.get("draft_text")
    if not isinstance(draft_text, str) or not draft_text.strip():
        raise ReplyRequestInvalid()
    instruction = content.get("user_instruction")
    if instruction is not None and (
        not isinstance(instruction, str) or not instruction.strip()
    ):
        raise ReplyRequestInvalid()
    include_context = content.get("include_relationship_context", False)
    if not isinstance(include_context, bool):
        raise ReplyRequestInvalid()
    draft = RewriteDraft(
        draft_text=draft_text,
        user_instruction=instruction,
        include_relationship_context=include_context,
    )
    if not draft.is_valid():
        raise ReplyRequestInvalid()
    return draft


def _uuid_field(payload: dict[str, Any], name: str) -> UUID:
    value = payload.get(name)
    if not isinstance(value, str):
        raise ReplyRequestInvalid()
    try:
        return UUID(value)
    except ValueError:
        raise ReplyRequestInvalid() from None


def _optional_uuid(value: Any) -> UUID | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ReplyRequestInvalid()
    try:
        return UUID(value)
    except ValueError:
        raise ReplyRequestInvalid() from None
