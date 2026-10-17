"""本次明确选择的不可变版本；正文仅作运行内存中的说法参考。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from notalone.reply.context import ReplyContext
from notalone.reply.errors import ReplyInvariantError
from notalone.reply.interface import CandidateMessage, GenerateReply, RewriteDraft


@dataclass(frozen=True, slots=True, repr=False)
class AssistantContinuationReference:
    candidate_id: UUID
    version_id: UUID
    messages: tuple[CandidateMessage, ...]

    @property
    def text(self) -> str:
        return "\n\n".join(message.text for message in self.messages)


@dataclass(frozen=True, slots=True, repr=False, kw_only=True)
class ContinuationGenerateReply(GenerateReply):
    continuation: dict[str, Any]
    continuation_reference: AssistantContinuationReference | None = None

    def __repr__(self) -> str:
        return "ContinuationGenerateReply(<private>)"


def continuation_reference_payload(prepared: ReplyContext) -> dict[str, object] | None:
    """与唯一完整历史逐字匹配，避免原版候选冒充用户选择的编辑版本。"""

    if not isinstance(prepared.command, ContinuationGenerateReply):
        return None
    reference = prepared.command.continuation_reference
    if reference is None:
        return None
    discussion = prepared.assistant_discussion
    if (not isinstance(reference, AssistantContinuationReference)
            or reference.candidate_id != prepared.command.continued_from_candidate_id
            or discussion is None or discussion.scope != prepared.scope):
        raise ReplyInvariantError("本次明确选择的版本未通过历史复验。")
    selected = [item for item in discussion.items if item.kind == "candidate_version"
                and (item.candidate_id, item.version_id) == (reference.candidate_id, reference.version_id)]
    if len(selected) != 1:
        raise ReplyInvariantError("本次明确选择的版本已失效。")
    messages = [{"message_id": str(message.message_id), "text": message.text} for message in reference.messages]
    try:
        captured = json.loads(selected[0].text)
    except (TypeError, ValueError):
        raise ReplyInvariantError("本次明确选择的版本结构无效。") from None
    if not isinstance(captured, dict) or captured.get("messages") != messages:
        raise ReplyInvariantError("本次明确选择的版本内容已改变。")
    is_current_draft = (isinstance(prepared.command.content, RewriteDraft)
                        and prepared.command.content.draft_text == reference.text)
    return {
        "candidate_id": str(reference.candidate_id), "version_id": str(reference.version_id),
        "is_current_draft": is_current_draft,
        **({} if is_current_draft else {"messages": messages}),
        "factual_role": "previous_assistant_candidate", "weight": "low",
        **({"basis_changes": [change.to_payload() for change in selected[0].basis_changes]}
           if selected[0].basis_changes else {}),
        "notice": "这是用户本次明确选择的旧候选版本，只参考说法；本次明确意愿优先，不代表已发送或关系事实。",
    }
