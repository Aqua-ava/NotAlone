"""明确采用新消息的受限声明；累计要求只从当前持久输入恢复。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from notalone.application.reply_request import ReplyRequestInvalid, parse_reply_request
from notalone.application.reply_service import ReplyServiceRequest
from notalone.reply.interface import InitiateConversation, ReplyToMessage


@dataclass(frozen=True, slots=True, repr=False, kw_only=True)
class AssistantMessageAdoptionRequest(ReplyServiceRequest):
    adopt_new_message_id: UUID
    submission: dict[str, Any]


def parse_assistant_reply_request(body: bytes) -> tuple[UUID, ReplyServiceRequest]:
    """普通声明继续原4096限额；具名采用命令不得上传或覆盖继承要求。"""

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ReplyRequestInvalid() from None
    if not isinstance(payload, dict) or "adopt_new_message_id" not in payload:
        return parse_reply_request(body)
    allowed = {"contact_id", "idempotency_key", "content", "expected_input_version_id", "adopt_new_message_id",
               "skill_version_id", "skill_disabled", "continued_from_candidate_id", "suggestion", "scene"}
    content = payload.get("content")
    if (set(payload) - allowed or not isinstance(content, dict)
            or content.get("user_instruction") is not None or content.get("suggestion") is not None
            or payload.get("suggestion") is not None or payload.get("continued_from_candidate_id") is not None
            or content.get("type") not in ("reply_to_message", "initiate_conversation")):
        raise ReplyRequestInvalid()
    content_fields = {"type", "understanding_correction", "user_instruction", "clarification_answer", "suggestion"}
    content_fields.update({"direction", "direction_source", "target_message_id"}
                          if content["type"] == "reply_to_message" else {"purpose", "purpose_source"})
    if set(content) - content_fields:
        raise ReplyRequestInvalid()
    marker = payload["adopt_new_message_id"]
    if not isinstance(marker, str):
        raise ReplyRequestInvalid()
    try:
        message_id = UUID(marker)
    except ValueError:
        raise ReplyRequestInvalid() from None
    contact_id, request = parse_reply_request(body)
    if (request.expected_input_version_id is None
            or not isinstance(request.content, (ReplyToMessage, InitiateConversation))
            or isinstance(request.content, ReplyToMessage) and request.content.target_message_id != message_id):
        raise ReplyRequestInvalid()
    return contact_id, AssistantMessageAdoptionRequest(
        idempotency_key=request.idempotency_key, content=request.content,
        skill_version_id=request.skill_version_id, skill_disabled=request.skill_disabled,
        scene=request.scene,
        expected_input_version_id=request.expected_input_version_id,
        adopt_new_message_id=message_id, submission=payload,
    )
