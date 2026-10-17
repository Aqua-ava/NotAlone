"""把现行采纳决定预演为比较项；所有写入口只写端侧临时动作。"""

from dataclasses import dataclass, replace
from uuid import UUID, uuid5

from notalone.memory.candidates import same_pending_identity
from notalone.memory.models import (
    AdoptionMethod, ConfirmedMemory, ConfirmedMemoryStatus, MemoryCandidate, MemoryCandidateStatus, OwnerMemory,
)
from notalone.memory.ports import MemoryPort, OwnerMemoryPort
from notalone.memory.versions import MemoryVersionConflict
from notalone.memory_extraction.adoption import AdoptionStats, MemoryAdoption
from notalone.scopes import ContactScope


@dataclass(frozen=True)
class UpgradeAction:
    kind: str
    candidate: MemoryCandidate
    previous: ConfirmedMemory | OwnerMemory | None = None
    result_memory_id: UUID | None = None


@dataclass(frozen=True)
class UpgradeComparison:
    actions: tuple[UpgradeAction, ...]
    stats: AdoptionStats
    current: tuple[ConfirmedMemory | OwnerMemory, ...] = ()


class _ContactPreview:
    """显式只读委托；没有通配委托，未来新增写方法不会意外落库。"""

    def __init__(self, source: MemoryPort, scope: ContactScope):
        self.source, self.scope = source, scope
        self.candidates: dict = {}
        self.actions: dict = {}

    def _scope(self, scope):
        if scope != self.scope:
            raise ValueError('比较不能跨联系人范围。')

    def list_confirmed(self, scope, *, include_expired=False):
        self._scope(scope)
        return self.source.list_confirmed(scope, include_expired=include_expired)

    def list_pending_candidates(self, scope):
        self._scope(scope)
        original = self.source.list_pending_candidates(scope)
        return (*original, *(item for item in self.candidates.values() if item.status is MemoryCandidateStatus.PENDING))

    def deleted_texts(self, scope):
        self._scope(scope)
        return self.source.deleted_texts(scope)

    def assess_correction(self, candidate):
        self._scope(candidate.scope)
        assess = getattr(self.source, 'assess_correction', None)
        return assess(candidate) if callable(assess) else candidate

    def create_candidate(self, candidate):
        self._scope(candidate.scope)
        for existing in self.source.list_pending_candidates(self.scope):
            if same_pending_identity(existing, candidate):
                return existing
        candidate = self.assess_correction(candidate)
        self.candidates[candidate.candidate_id] = candidate
        self.actions[candidate.candidate_id] = UpgradeAction('pending', candidate)
        return candidate

    def get_candidate(self, *, scope, candidate_id):
        self._scope(scope)
        if candidate_id in self.candidates:
            return self.candidates[candidate_id]
        return self.source.get_candidate(scope=scope, candidate_id=candidate_id)

    def confirm(self, *, scope, candidate_id, adoption_method, expected_previous=None, **kwargs):
        self._scope(scope)
        if candidate_id not in self.candidates:
            raise MemoryVersionConflict('既有待确认记录由原审核入口处理。')
        candidate = self.candidates[candidate_id]
        self._record(candidate, adoption_method, expected_previous)
        return ConfirmedMemory(scope=scope, **_memory_fields(candidate, expected_previous))

    def _record(self, candidate, adoption_method, previous):
        if adoption_method is not AdoptionMethod.AUTO or previous and previous.adoption_method is not AdoptionMethod.AUTO:
            raise MemoryVersionConflict('比较不得覆盖人工决定。')
        self.actions[candidate.candidate_id] = UpgradeAction('auto_update' if previous else 'auto_add', candidate, previous,
                                                          uuid5(candidate.candidate_id, 'upgrade_memory'))
        self.candidates[candidate.candidate_id] = replace(candidate, status=MemoryCandidateStatus.CONFIRMED)


class _OwnerPreview:
    def __init__(self, source: OwnerMemoryPort, contact: _ContactPreview):
        self.source, self.contact = source, contact

    def _owner(self, owner_id):
        if owner_id != self.contact.scope.owner_id:
            raise ValueError('比较不能跨用户范围。')

    def list_active(self, owner_id, *, include_expired=False):
        self._owner(owner_id)
        return self.source.list_active(owner_id, include_expired=include_expired)

    def deleted_texts(self, owner_id):
        self._owner(owner_id)
        return self.source.deleted_texts(owner_id)

    def confirm_candidate(self, *, candidate, adoption_method, expected_previous=None, **kwargs):
        self.contact._scope(candidate.scope)
        self.contact._record(candidate, adoption_method, expected_previous)
        return OwnerMemory(owner_id=candidate.scope.owner_id, **_memory_fields(candidate, expected_previous))


def _memory_fields(candidate, previous):
    return dict(memory_id=uuid5(candidate.candidate_id, 'upgrade_memory'), text=candidate.text, category=candidate.category, topic=candidate.topic,
        source_ids=tuple(dict.fromkeys((*(previous.source_ids if previous else ()), *candidate.source_ids))),
        source_candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.AUTO,
        status=ConfirmedMemoryStatus.ACTIVE,
        valid_at=candidate.valid_at, invalid_at=candidate.invalid_at, confidence=candidate.confidence,
        risk_flags=candidate.risk_flags, timing=candidate.timing, event=candidate.event,
        revision=previous.revision+1 if previous else 1,
        supersedes_memory_id=previous.memory_id if previous else None)


def preview_upgrade(scope, outcome, *, memory_port, owner_memory_port=None,
                    adjudication_runtime=None, dimension_release=None, candidate_namespace=None,
                    target_kind='contact') -> UpgradeComparison:
    contact = _ContactPreview(memory_port, scope)
    owner = _OwnerPreview(owner_memory_port, contact) if owner_memory_port else None
    stats = MemoryAdoption(memory_port=contact, owner_memory_port=owner,
        adjudication_runtime=adjudication_runtime, dimension_release=dimension_release,
        candidate_namespace=candidate_namespace).adopt(scope, outcome)
    current = (owner_memory_port.list_active(scope.owner_id, include_expired=True)
               if target_kind == 'owner' and owner_memory_port is not None
               else memory_port.list_confirmed(scope, include_expired=True))
    return UpgradeComparison(tuple(contact.actions.values()), stats, tuple(current))
