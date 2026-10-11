"""准备未领取的无正文证明；只有持久化事务可以产生。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    from notalone.application.assistant_session_service import AssistantSessionError


@dataclass(frozen=True, slots=True, repr=False)
class AssistantNoGenerationProof:
    contact_id: UUID
    session_id: UUID
    request_key: UUID


class AssistantPreparationRejected(RuntimeError):
    def __init__(self, failure: AssistantSessionError, proof: AssistantNoGenerationProof) -> None:
        super().__init__("本次准备未领取任何生成。")
        self.failure, self.proof = failure, proof
