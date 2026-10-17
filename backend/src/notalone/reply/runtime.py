"""候选回复模型运行时的内部契约。"""

from __future__ import annotations

from dataclasses import dataclass
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable, Protocol
from uuid import UUID

from notalone.reply.context import ContextEvidence, ReplyContext, ToolCallTrace
from notalone.reply.interface import SkillUse
from notalone.reply.input_budget import InputBudgetDecision


_model_request_validator: ContextVar[Callable[[], None] | None] = ContextVar(
    'reply_model_request_validator', default=None,
)


@contextmanager
def model_request_scope(validate: Callable[[], None]):
    """固定外壳实际领取的attempt校验；不从准备快照推导运行租约。"""
    token = _model_request_validator.set(validate)
    try:
        yield
    finally:
        _model_request_validator.reset(token)


def current_model_request_validator() -> Callable[[], None] | None:
    return _model_request_validator.get()


@dataclass(frozen=True, slots=True, repr=False)
class RuntimeCandidate:
    """模型运行时尚未持久化的候选。"""

    text: str
    basis: str
    citation_ids: tuple[UUID, ...]
    risk_notes: tuple[str, ...]
    messages: tuple[str, ...] = ()

    @property
    def message_texts(self) -> tuple[str, ...]:
        return self.messages or (self.text,)

    def has_valid_message_group(self) -> bool:
        return (
            isinstance(self.messages, tuple)
            and 1 <= len(self.message_texts) <= 8
            and len(self.text) <= 65536
            and all(isinstance(text, str) and 0 < len(text.strip()) <= (65536 if len(self.message_texts) == 1 else 8192)
                    for text in self.message_texts)
            and self.text == "\n\n".join(self.message_texts)
        )


@dataclass(frozen=True, slots=True)
class RuntimeUsage:
    """模型运行时上报的外部调用用量与标识。"""

    provider: str
    model_name: str
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class ReplyRuntimeResult:
    """框架 adapter 返回给确定性外壳的结果。"""

    candidates: tuple[RuntimeCandidate, ...]
    used_skill: SkillUse | None
    usage: RuntimeUsage | None = None
    additional_evidence: tuple[ContextEvidence, ...] = ()
    tool_calls: tuple[ToolCallTrace, ...] = ()
    input_budget: InputBudgetDecision | None = None


class ReplyRuntime(Protocol):
    """候选模型运行时 seam。"""

    def generate(self, context: ReplyContext) -> ReplyRuntimeResult: ...
