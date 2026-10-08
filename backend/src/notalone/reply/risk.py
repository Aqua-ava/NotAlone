"""候选回复上下文的确定性风险提示边界。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar, Protocol


class RiskHintPort(Protocol):
    """只读评估本次输入是否需要用户核实的提示。"""

    def assess(self, text: str) -> tuple[str, ...]:
        """返回提示文本，不阻塞记忆写入或候选生成。"""


@dataclass(frozen=True, slots=True)
class DeterministicRiskHints:
    """v1 的最小规则适配器，不依赖模型或联系人资料。"""

    RULES: ClassVar[tuple[tuple[str, tuple[str, ...]], ...]] = (
        ("转账", ("转账", "汇款")),
        ("验证码", ("验证码",)),
        ("地址", ("地址",)),
        ("借款", ("借款", "借钱")),
        ("承诺", ("承诺",)),
        ("见面安排", ("见面", "约见")),
        ("关系冲突", ("冲突", "吵架", "分手")),
    )

    def assess(self, text: str) -> tuple[str, ...]:
        if not isinstance(text, str):
            raise TypeError("风险提示输入必须是文本。")
        return tuple(
            f"请核实{label}相关内容。"
            for label, terms in self.RULES
            if any(term in text for term in terms)
        )
