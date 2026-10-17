"""人工决定保护的公开冲突和待确认对照。"""

from dataclasses import dataclass
from uuid import UUID
from notalone.memory.dimension_evidence import DimensionEvidenceChangedError


class MemoryCorrectionConflictError(DimensionEvidenceChangedError):
    """旧证据或变化的人工决定不允许本次确认。"""


@dataclass(frozen=True, slots=True, repr=False)
class CorrectionReview:
    """新证据与已有人工决定的对照；不表示旧决定已经被撤销。"""

    decision_id: UUID
    decision: str
    previous_text: str
    corrected_text: str | None
    new_message_ids: tuple[UUID, ...]
    new_source_ids: tuple[UUID, ...]
    semantic_relation: str
    reason: str = "出现新的规范消息；请核对新依据，原人工决定继续有效。"

    def to_payload(self) -> dict[str, object]:
        return {
            "decision_id": str(self.decision_id), "decision": self.decision,
            "previous_text": self.previous_text, "corrected_text": self.corrected_text,
            "new_message_ids": [str(item) for item in self.new_message_ids],
            "new_source_ids": [str(item) for item in self.new_source_ids],
            "semantic_relation": self.semantic_relation, "reason": self.reason,
        }
