"""候选回复持久化的内部契约。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from notalone.reply.context import PreparedReply
from notalone.reply.interface import GenerateReply, ReplyGenerated, SkillUse
from notalone.reply.runtime import RuntimeCandidate


@dataclass(frozen=True, slots=True, repr=False)
class ValidatedReply:
    """已经通过确定性校验、允许持久化的运行结果。"""

    candidates: tuple[RuntimeCandidate, ...]
    used_skill: SkillUse | None


class ReplyStore(Protocol):
    """当前纵切的持久化 seam。

    ``prepare`` 暂时仍返回已组装的上下文；正式上下文模块落地后，持久化职责会
    收窄为请求幂等、状态管理和候选结果保存。
    """

    def prepare(self, command: GenerateReply) -> PreparedReply: ...

    def save(
        self,
        prepared: PreparedReply,
        reply: ValidatedReply,
    ) -> ReplyGenerated: ...
