"""提取结果的自动采纳外壳：主体分流、置信度门槛、删除指纹与重复抑制。"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

from notalone.memory.models import (
    AdoptionMethod,
    MemoryCandidate,
    MemoryCandidateStatus,
)
from notalone.memory.ports import MemoryPort, OwnerMemoryPort
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import FactSubject
from notalone.memory.models import OwnerMemory, ConfirmedMemoryStatus
from notalone.scopes import ContactScope


DEFAULT_CONFIDENCE_THRESHOLD = 0.7


@dataclass(frozen=True, slots=True)
class AdoptionStats:
    """一次采纳的统计：采纳、待定、重复跳过、删除指纹跳过与外壳拒绝。"""

    adopted: int = 0
    pending: int = 0
    skipped_duplicate: int = 0
    skipped_deleted: int = 0
    rejected_by_contract: int = 0


class MemoryAdoption:
    """把通过证据契约的候选按主体分流落库。"""

    __slots__ = (
        "_memory_port",
        "_owner_memory_port",
        "_threshold",
    )

    def __init__(
        self,
        *,
        memory_port: MemoryPort,
        owner_memory_port: OwnerMemoryPort | None = None,
        confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    ) -> None:
        if memory_port is None:
            raise TypeError("必须显式注入联系人级记忆 port。")
        if not 0.0 < confidence_threshold <= 1.0:
            raise ValueError("置信度门槛必须在 0 到 1 之间。")
        self._memory_port = memory_port
        self._owner_memory_port = owner_memory_port
        self._threshold = confidence_threshold

    def adopt(self, scope: ContactScope, outcome: ExtractionOutcome) -> AdoptionStats:
        """按主体分流落库并返回统计；整体失败时不产生任何写入。"""

        if outcome.failure_reason is not None:
            return AdoptionStats(rejected_by_contract=outcome.rejected_count)

        contact_texts = self._active_texts(scope)
        owner_texts = self._owner_active_texts(scope.owner_id)
        deleted_contact = self._normalize_all(
            self._memory_port.deleted_texts(scope)
        )
        deleted_owner = self._normalize_all(
            self._owner_deleted_texts(scope.owner_id)
        )

        adopted = pending = duplicate = deleted_skip = 0
        for fact in outcome.accepted:
            normalized = _normalize(fact.text)
            if normalized in deleted_contact or normalized in deleted_owner:
                deleted_skip += 1
                continue
            active_pool = (
                owner_texts if fact.subject is FactSubject.SELF else contact_texts
            )
            if normalized in active_pool:
                duplicate += 1
                continue
            if fact.confidence < self._threshold:
                self._memory_port.create_candidate(
                    MemoryCandidate(
                        candidate_id=uuid4(),
                        scope=scope,
                        text=fact.text,
                        category=fact.category,
                        source_ids=fact.source_message_ids,
                        topic=fact.topic,
                        status=MemoryCandidateStatus.PENDING,
                        valid_at=fact.valid_at,
                        invalid_at=fact.invalid_at,
                    )
                )
                pending += 1
                continue
            if fact.subject is FactSubject.SELF:
                self._create_owner_memory(scope, fact)
                owner_texts.add(normalized)
            else:
                candidate = self._memory_port.create_candidate(
                    MemoryCandidate(
                        candidate_id=uuid4(),
                        scope=scope,
                        text=fact.text,
                        category=fact.category,
                        source_ids=fact.source_message_ids,
                        topic=fact.topic,
                        valid_at=fact.valid_at,
                        invalid_at=fact.invalid_at,
                    )
                )
                self._memory_port.confirm(
                    scope=scope,
                    candidate_id=candidate.candidate_id,
                    adoption_method=AdoptionMethod.AUTO,
                )
                contact_texts.add(normalized)
            adopted += 1
        return AdoptionStats(
            adopted=adopted,
            pending=pending,
            skipped_duplicate=duplicate,
            skipped_deleted=deleted_skip,
            rejected_by_contract=outcome.rejected_count,
        )

    def _active_texts(self, scope: ContactScope) -> set[str]:
        return {
            _normalize(memory.text)
            for memory in self._memory_port.list_confirmed(scope)
        }

    def _owner_active_texts(self, owner_id: UUID) -> set[str]:
        if self._owner_memory_port is None:
            return set()
        return {
            _normalize(memory.text)
            for memory in self._owner_memory_port.list_active(owner_id)
        }

    def _owner_deleted_texts(self, owner_id: UUID) -> tuple[str, ...]:
        if self._owner_memory_port is None:
            return ()
        return self._owner_memory_port.deleted_texts(owner_id)

    def _create_owner_memory(self, scope: ContactScope, fact) -> None:
        if self._owner_memory_port is None:
            raise TypeError("self 主体事实需要注入 owner 级记忆 port。")
        self._owner_memory_port.create(
            OwnerMemory(
                memory_id=uuid4(),
                owner_id=scope.owner_id,
                text=fact.text,
                category=fact.category,
                topic=fact.topic,
                source_ids=fact.source_message_ids,
                adoption_method=AdoptionMethod.AUTO,
                status=ConfirmedMemoryStatus.ACTIVE,
                valid_at=fact.valid_at,
                invalid_at=fact.invalid_at,
            )
        )

    @staticmethod
    def _normalize_all(texts) -> tuple[str, ...]:
        return tuple(_normalize(text) for text in texts)


def _normalize(text: str) -> str:
    return "".join(text.split()).lower()
