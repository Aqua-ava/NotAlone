"""探索的最小检索快照与来源复验，不拥有会话或当前输入版本。"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime
from hashlib import sha256
from typing import Any, Literal
from uuid import UUID

from notalone.memory.timing import MemoryTiming
from notalone.memory.events import MemoryEvent
from notalone.memory.conditions import MemoryConditions
from notalone.memory.evolution import MemoryEvolution
from notalone.reply.context import ContextEvidence
from notalone.reply.exploration import ExplorationInput, ExplorationStale
from notalone.retrieval.models import RetrievedMemory, RetrievedMessage
from notalone.retrieval.ports import RetrievalPort
from notalone.scopes import ContactScope


def _fingerprint(item: RetrievedMessage | RetrievedMemory) -> str:
    # 查询相关度不是原始资料；按ID复验时只比较正文、身份、版本与来源事实。
    fields = ("scope", "text", "source_ids", "status", "valid_at", "invalid_at")
    fields += (("role", "occurred_at", "session_id") if isinstance(item, RetrievedMessage)
               else ("revision", "adoption_method", "category", "topic", "timing", "event", "conditions", "evolution"))
    source = asdict(item)
    payload = {key: source[key] for key in fields}
    return sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


@dataclass(frozen=True, slots=True, repr=False)
class EvidenceSnapshot:
    scope: ContactScope
    evidence_id: UUID
    kind: Literal["message", "confirmed_memory"]
    text: str
    source_ids: tuple[UUID, ...]
    fingerprint: str
    manual_contact: bool = False
    timing: MemoryTiming = MemoryTiming()
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    event: MemoryEvent | None = None
    conditions: MemoryConditions | None = None
    evolution: MemoryEvolution | None = None
    speaker_role: Literal["owner", "contact", "system", "unknown"] = "unknown"

    def __post_init__(self) -> None:
        if (self.speaker_role not in ("owner", "contact", "system", "unknown")
                or self.kind != "message" and self.speaker_role != "unknown"):
            raise ValueError("探索消息说话人无效。")

    @property
    def model_payload(self) -> dict[str, Any]:
        return {"evidence_id": str(self.evidence_id), "kind": self.kind, "text": self.text,
                **({"speaker_role": self.speaker_role} if self.kind == "message" else {}),
                "source_ids": [str(source) for source in self.source_ids],
                "timing": self.timing.to_payload(),
                "event": self.event.to_payload(current=True) if self.event else None,
                "conditions": self.conditions.to_payload(current=True) if self.conditions else None,
                "evolution": self.evolution.to_payload(current=True) if self.evolution else None,
                "valid_at": self.valid_at.isoformat() if self.valid_at else None,
                "invalid_at": self.invalid_at.isoformat() if self.invalid_at else None}

    @property
    def storage_payload(self) -> dict[str, Any]:
        return {**self.model_payload, "fingerprint": self.fingerprint, "manual_contact": self.manual_contact}

    @property
    def dependency_ids(self) -> set[UUID]:
        sources = set(self.source_ids)
        if self.manual_contact:
            sources.discard(self.scope.contact_id)
        if self.evolution is not None:
            sources.update(self.evolution.evidence_message_ids)
        return {self.evidence_id, *sources}


class ExplorationEvidence:
    """回应使用目标前后各两条，主动使用最近五条，已确认资料最多两条。"""

    def __init__(self, retrieval: RetrievalPort) -> None:
        self._retrieval = retrieval

    def capture(self, scope: ContactScope, content: ExplorationInput) -> tuple[EvidenceSnapshot, ...]:
        target: tuple[RetrievedMessage, ...] = ()
        if content.scene == "reply_to_message":
            target = self._retrieval.search_messages(
                scope=scope, target_message_id=content.target_message_id, limit=1, timeout_ms=1000,
            )
            if len(target) != 1 or target[0].message_id != content.target_message_id:
                raise ExplorationStale("待回应消息已经删除或不可用。")
        recent = self._retrieval.query_messages(
            scope=scope, anchor_message_id=content.target_message_id, before=2, after=2,
            limit=5, timeout_ms=1000,
        )
        memories = self._retrieval.search_confirmed_memories(
            scope=scope, query=(target[0].text if target else content.purpose_hint)[:500], limit=2,
        )
        if len(recent) > 5 or len(memories) > 2:
            raise ExplorationStale("探索材料超出当前任务范围。")
        material: dict[UUID, RetrievedMessage | RetrievedMemory] = {}
        for item in (*target, *recent, *memories):
            if (not isinstance(item, (RetrievedMessage, RetrievedMemory))
                    or item.scope != scope or item.status != "active" or not item.source_ids):
                raise ExplorationStale("探索材料的范围或来源无效。")
            identifier = item.message_id if isinstance(item, RetrievedMessage) else item.memory_id
            material.setdefault(identifier, item)
        if sum(isinstance(item, RetrievedMessage) for item in material.values()) > 5:
            raise ExplorationStale("目标不在最小会话窗口中。")
        return tuple(self._snapshot(item) for item in material.values())

    @staticmethod
    def _snapshot(item: RetrievedMessage | RetrievedMemory) -> EvidenceSnapshot:
        message = isinstance(item, RetrievedMessage)
        return EvidenceSnapshot(
            scope=item.scope, evidence_id=item.message_id if message else item.memory_id,
            kind="message" if message else "confirmed_memory", text=item.text[:1500 if message else 300],
            source_ids=item.source_ids, fingerprint=_fingerprint(item),
            speaker_role=item.role if message else "unknown",
            manual_contact=not message and item.adoption_method == "manual",
            timing=MemoryTiming.from_source_times((item.occurred_at,)) if message else item.timing,
            valid_at=item.valid_at, invalid_at=item.invalid_at,
            event=None if message else item.event, conditions=None if message else item.conditions,
            evolution=(MemoryEvolution.from_payload(item.evolution.to_payload(current=True))
                       if not message and item.evolution else None),
        )

    @staticmethod
    def dependencies(snapshots: tuple[EvidenceSnapshot, ...]) -> set[UUID]:
        return {dependency for item in snapshots for dependency in item.dependency_ids}

    def _current(self, scope: ContactScope, snapshot: EvidenceSnapshot) -> RetrievedMessage | RetrievedMemory:
        if snapshot.scope != scope:
            raise ExplorationStale("探索快照不属于当前联系人。")
        if snapshot.kind == "message":
            current = self._retrieval.search_messages(
                scope=scope, target_message_id=snapshot.evidence_id, limit=1, timeout_ms=1000,
            )
        else:
            current = self._retrieval.search_confirmed_memories(
                scope=scope, memory_ids=(snapshot.evidence_id,), limit=1,
            )
        if (len(current) != 1 or not isinstance(current[0], (RetrievedMessage, RetrievedMemory))
                or current[0].scope != scope
                or self._snapshot(current[0]) != snapshot):
            raise ExplorationStale("探索依据已经删除或改变。")
        return current[0]

    def validate(self, scope: ContactScope, snapshots: tuple[EvidenceSnapshot, ...]) -> None:
        for snapshot in snapshots:
            self._current(scope, snapshot)

    @staticmethod
    def restore(scope: ContactScope, values: list[dict[str, Any]]) -> tuple[EvidenceSnapshot, ...]:
        try:
            if not isinstance(values, list) or len(values) > 14:
                raise ValueError()
            snapshots = []
            for item in values:
                legacy = {"evidence_id", "kind", "text", "source_ids", "fingerprint", "manual_contact"}
                if (set(item) not in (legacy, legacy | {"timing", "valid_at", "invalid_at"},
                                           legacy | {"timing", "valid_at", "invalid_at", "event"}, legacy | {"timing", "valid_at", "invalid_at", "event", "conditions"},
                                           legacy | {"timing", "valid_at", "invalid_at", "event", "conditions", "evolution"},
                                           legacy | {"timing", "valid_at", "invalid_at", "event", "conditions", "evolution", "speaker_role"})
                    or item["kind"] not in ("message", "confirmed_memory")
                    or not isinstance(item["text"], str) or not item["text"].strip()
                    or len(item["text"]) > (1500 if item["kind"] == "message" else 300)
                    or not isinstance(item["source_ids"], list) or not item["source_ids"]
                    or not isinstance(item["manual_contact"], bool)
                    or item["manual_contact"] and item["kind"] != "confirmed_memory"
                    or not isinstance(item["fingerprint"], str) or len(item["fingerprint"]) != 64):
                    raise ValueError()
                snapshots.append(EvidenceSnapshot(scope, UUID(item["evidence_id"]), item["kind"], item["text"],
                                                  tuple(UUID(source) for source in item["source_ids"]),
                                                  item["fingerprint"], item["manual_contact"],
                                                  MemoryTiming.from_payload(item.get("timing")),
                                                  _restore_time(item.get("valid_at")),
                                                  _restore_time(item.get("invalid_at")),
                                                  MemoryEvent.from_payload(item.get("event")), MemoryConditions.from_payload(item.get("conditions")),
                                                  MemoryEvolution.from_payload(item.get("evolution")),
                                                  item.get("speaker_role", "unknown")))
            if len({item.evidence_id for item in snapshots}) != len(snapshots):
                raise ValueError()
            return tuple(snapshots)
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ExplorationStale("探索来源快照无效。") from None

    def generation_dependencies(
        self, scope: ContactScope, snapshots: tuple[EvidenceSnapshot, ...],
    ) -> tuple[ContextEvidence, ...]:
        dependencies = []
        for snapshot in snapshots:
            item = self._current(scope, snapshot)
            dependencies.append(ContextEvidence(
                evidence_id=snapshot.evidence_id, kind=snapshot.kind, text=item.text, scope=scope,
                source_ids=item.source_ids, selection_reason="本次意愿的实际删除依赖，不扩展生成模型材料。",
                status=item.status, valid_at=item.valid_at, invalid_at=item.invalid_at,
                revision=getattr(item, "revision", None),
                speaker_role=item.role if isinstance(item, RetrievedMessage) else "unknown",
                event=getattr(item, "event", None), conditions=getattr(item, "conditions", None),
                evolution=getattr(item, "evolution", None),
                timing=(MemoryTiming.from_source_times((item.occurred_at,))
                        if isinstance(item, RetrievedMessage) else item.timing), model_visible=False,
            ))
        return tuple(dependencies)


def _restore_time(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("探索区间时间无效。")
    result = datetime.fromisoformat(value)
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("探索区间时间缺少时区。")
    return result
