"""类型化持续输入身份；公开继续策略只引用这里的唯一类型与提交函数。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from notalone.application.reply_service import ReplyServiceRequest
from notalone.reply.assistant_continuation_reference import AssistantContinuationReference, ContinuationGenerateReply
from notalone.reply.interface import GenerateReply


class AssistantContinuationInvalid(ValueError):
    """无效命令只返回固定错误，不回显正文。"""


@dataclass(frozen=True, slots=True, repr=False, kw_only=True)
class AssistantContinuationReplyRequest(ReplyServiceRequest):
    continuation: dict[str, Any]
    reference: AssistantContinuationReference | None = None

    def build_command(self, *, owner_id: UUID, contact_id: UUID, binding_id: UUID) -> GenerateReply | None:
        command = ReplyServiceRequest.build_command(self, owner_id=owner_id, contact_id=contact_id, binding_id=binding_id)
        if command is None:
            return command
        return ContinuationGenerateReply(
            idempotency_key=command.idempotency_key, scope=command.scope,
            conversation_binding_id=command.conversation_binding_id, content=command.content,
            continued_from_candidate_id=command.continued_from_candidate_id, skill=command.skill,
            scene=command.scene,
            continuation=self.continuation,
            continuation_reference=self.reference,
        )

    def __repr__(self) -> str:
        return "AssistantContinuationReplyRequest(<private>)"


def continuation_digest_input(request: ReplyServiceRequest | GenerateReply, normalized: str) -> str:
    """只扩展A输入身份；C规范化及事实/来源守卫保持单一实现。"""

    if not isinstance(request, (AssistantContinuationReplyRequest, ContinuationGenerateReply)):
        return normalized
    return json.dumps({"reply": normalized, "continuation": request.continuation},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def continuation_commit_input(command: GenerateReply, normalized: str, payload: object) -> str:
    """提交仍使用C规范化结果，A身份须与同事务内的实际领取记录一致。"""

    metadata = payload.get("continuation") if isinstance(payload, dict) else None
    typed = isinstance(command, ContinuationGenerateReply)
    if metadata is None and not typed:
        return normalized
    if (not isinstance(command, ContinuationGenerateReply)
            or not isinstance(metadata, dict) or command.continuation != metadata):
        raise AssistantContinuationInvalid("持续要求输入身份已失效。")
    reference = command.continuation_reference
    if reference is None:
        if metadata.get("candidate_id") is not None or metadata.get("version_id") is not None:
            raise AssistantContinuationInvalid("持续要求候选版本已失效。")
    elif (not isinstance(reference, AssistantContinuationReference)
          or str(reference.candidate_id) != metadata.get("candidate_id")
          or str(reference.version_id) != metadata.get("version_id")
          or reference.candidate_id != command.continued_from_candidate_id):
        raise AssistantContinuationInvalid("持续要求候选版本已失效。")
    return continuation_digest_input(command, normalized)


def continuation_input_payload(request: ReplyServiceRequest, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, AssistantContinuationReplyRequest):
        return payload
    return {**payload, "continuation": request.continuation}
