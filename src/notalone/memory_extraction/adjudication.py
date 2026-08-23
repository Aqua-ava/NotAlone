"""写入裁决：同事件演变的判定与版本化失效（ADD/UPDATE/NOOP/KEEP）。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol
from uuid import UUID


class AdjudicationAction(StrEnum):
    """写入裁决的四种动作。"""

    ADD = "add"
    UPDATE = "update"
    NOOP = "noop"
    KEEP = "keep"


@dataclass(frozen=True, slots=True)
class SimilarMemory:
    """参与裁决的一条相似旧记忆。"""

    memory_id: UUID
    text: str
    topic: str


@dataclass(frozen=True, slots=True)
class AdjudicationDecision:
    """一次裁决的结果动作与被取代的旧记忆。"""

    action: AdjudicationAction
    replaced_memory_id: UUID | None = None
    model_name: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


class AdjudicationRuntime(Protocol):
    """把新候选与相似旧记忆裁决为动作的模型运行时 seam。"""

    def adjudicate(
        self, *, candidate_text: str, similar: tuple[SimilarMemory, ...]
    ) -> AdjudicationDecision: ...


def similarity(candidate_text: str, existing_text: str) -> float:
    """字符 bigram Jaccard 相似度，用于裁决前的粗筛。"""

    left = _bigrams(candidate_text)
    right = _bigrams(existing_text)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _bigrams(text: str) -> frozenset[str]:
    normalized = "".join(text.split()).lower()
    if len(normalized) < 2:
        return frozenset({normalized}) if normalized else frozenset()
    return frozenset(
        normalized[index : index + 2] for index in range(len(normalized) - 1)
    )
