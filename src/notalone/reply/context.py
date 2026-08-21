"""候选回复上下文的内部数据契约。

本文件只描述一次回复运行已经准备好的上下文，不负责选择或检索资料。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from notalone.reply.interface import ConfirmedDirection, GenerateReply, RewriteDraft
from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True, repr=False)
class ContextEvidence:
    """经范围校验后进入本次上下文的一项证据。"""

    evidence_id: UUID
    kind: Literal["message", "confirmed_memory", "user_draft"]
    text: str
    scope: ContactScope


@dataclass(frozen=True, slots=True, repr=False)
class PreviousUnsentCandidate:
    """同一已验证桌面会话中上一轮未发送候选的精简引用。"""

    candidate_id: UUID
    scope: ContactScope
    conversation_binding_id: UUID
    text: str


@dataclass(frozen=True, slots=True, repr=False)
class PreparedReply:
    """持久化 adapter 完成范围验证和上下文组装后的请求。"""

    reply_request_id: UUID
    command: GenerateReply
    scope: ContactScope
    current_text: str
    direction: ConfirmedDirection | None
    evidence: tuple[ContextEvidence, ...]
    skill_library_revision: int
    previous_unsent_candidates: tuple[PreviousUnsentCandidate, ...] = ()

    def has_relationship_memory_for_rewrite(self) -> bool:
        """当前改写上下文是否混入了长期关系记忆。"""

        return (
            isinstance(self.command.content, RewriteDraft)
            and any(item.kind == "confirmed_memory" for item in self.evidence)
        )


# ``ReplyContext`` 是统一输入模式共用的上下文名称；旧的
# ``PreparedReply`` 名称暂时保留，供已有 Runtime/Store adapter 兼容迁移。
ReplyContext = PreparedReply
