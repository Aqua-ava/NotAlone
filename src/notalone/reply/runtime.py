"""候选回复模型运行时的内部契约。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.reply.context import PreparedReply
from notalone.reply.interface import SkillUse


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


class ReplyRuntime(Protocol):
    """候选模型运行时 seam。"""

    def generate(self, prepared: PreparedReply) -> ReplyRuntimeResult: ...
