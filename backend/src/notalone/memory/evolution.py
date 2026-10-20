"""有界来源支撑的新旧关系；不代表现实真伪认证。"""
from dataclasses import dataclass, field, replace
from uuid import UUID

KINDS = frozenset({"supplement", "state_change", "error_correction", "historical_supplement", "unresolved_conflict"})
FIELDS = {"version", "kind", "explanation", "related_versions", "evidence_message_ids", "source_supported", "claim_changed", "condition_changed"}

@dataclass(frozen=True, slots=True)
class MemoryEvolution:
    kind: str
    explanation: str
    related_versions: tuple[tuple[UUID, int], ...]
    evidence_message_ids: tuple[UUID, ...]
    source_supported: bool = False
    claim_changed: bool = False
    condition_changed: bool = False
    proof: dict | None = field(default=None, repr=False, compare=False)
    source_current: bool = field(default=True, init=False, compare=False, repr=False)

    def __post_init__(self):
        if self.kind not in KINDS or not isinstance(self.explanation, str) or not 1 <= len(self.explanation.strip()) <= 1000:
            raise ValueError("变化关系或说明无效。")
        if (not 1 <= len(self.related_versions) <= 8 or len({item[0] for item in self.related_versions}) != len(self.related_versions)
                or any(not isinstance(identifier, UUID) or type(revision) is not int or revision < 1 for identifier, revision in self.related_versions)):
            raise ValueError("变化关联版本无效。")
        if (len(self.evidence_message_ids) > 60 or len(set(self.evidence_message_ids)) != len(self.evidence_message_ids)
                or any(not isinstance(item, UUID) for item in self.evidence_message_ids)):
            raise ValueError("变化来源引用无效。")
        if any(type(item) is not bool for item in (self.source_supported, self.claim_changed, self.condition_changed)) or self.source_supported and not self.evidence_message_ids:
            raise ValueError("变化来源支持缺少依据。")

    def to_payload(self, *, current=False, include_proof=False):
        result = {"version": 1, "kind": self.kind, "explanation": self.explanation,
                  "related_versions": [{"memory_id": str(identifier), "revision": revision} for identifier, revision in self.related_versions],
                  "evidence_message_ids": [str(item) for item in self.evidence_message_ids],
                  "source_supported": self.source_supported and (self.source_current or not current),
                  "claim_changed": self.claim_changed, "condition_changed": self.condition_changed}
        if include_proof:
            result["proof"] = self.proof
        return result

    @classmethod
    def from_payload(cls, value):
        if value is None:
            return None
        if not isinstance(value, dict) or set(value) not in (FIELDS, FIELDS | {"proof"}) or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("变化元数据不符合版本一合同。")
        if not isinstance(value["related_versions"], list) or any(not isinstance(item, dict) or set(item) != {"memory_id", "revision"} for item in value["related_versions"]) or not isinstance(value["evidence_message_ids"], list):
            raise ValueError("变化引用结构无效。")
        return cls(value["kind"], value["explanation"], tuple((UUID(item["memory_id"]), item["revision"]) for item in value["related_versions"]),
                   tuple(UUID(item) for item in value["evidence_message_ids"]), value["source_supported"], value["claim_changed"], value["condition_changed"], value.get("proof"))

    def with_current_sources(self, current):
        result = replace(self)
        object.__setattr__(result, "source_current", current)
        return result
