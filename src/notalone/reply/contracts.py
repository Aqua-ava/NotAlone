"""ReplyGenerator 内部 adapter 契约，不属于调用者 Interface。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from notalone.reply.interface import (
    ConfirmedDirection,
    GenerateReply,
    ReplyGenerated,
    SkillUse,
)
from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True, repr=False)
class ContextEvidence:
    """经范围校验后进入本次上下文的一项证据。"""

    evidence_id: UUID
    kind: Literal["message", "confirmed_memory"]
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
    direction: ConfirmedDirection
    evidence: tuple[ContextEvidence, ...]
    skill_library_revision: int
    previous_unsent_candidates: tuple[PreviousUnsentCandidate, ...] = ()


@dataclass(frozen=True, slots=True, repr=False)
class RuntimeCandidate:
    """模型运行时尚未持久化的候选。"""

    text: str
    basis: str
    citation_ids: tuple[UUID, ...]
    risk_notes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ReplyRuntimeResult:
    """框架 adapter 返回给确定性外壳的结果。"""

    candidates: tuple[RuntimeCandidate, ...]
    used_skill: SkillUse | None


@dataclass(frozen=True, slots=True, repr=False)
class ValidatedReply:
    """已经通过确定性校验、允许持久化的运行结果。"""

    candidates: tuple[RuntimeCandidate, ...]
    used_skill: SkillUse | None


class ReplyStore(Protocol):
    """范围验证、上下文快照和候选持久化 seam。"""

    def prepare(self, command: GenerateReply) -> PreparedReply: ...

    def save(
        self,
        prepared: PreparedReply,
        reply: ValidatedReply,
    ) -> ReplyGenerated: ...


class ReplyRuntime(Protocol):
    """候选模型运行时 seam。"""

    def generate(self, prepared: PreparedReply) -> ReplyRuntimeResult: ...
