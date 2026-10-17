"""主题资料的公开合同；生成表达与底层事实分别保存。"""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.scopes import ContactScope


class LayeredMemoryConflict(RuntimeError):
    """范围设置或实际输入已变化，旧操作不能生效。"""


@dataclass(frozen=True, slots=True)
class OrganizationBudget:
    """显式受控预算；尚未标定为生产默认。"""

    max_memories: int = 12
    max_scenarios: int = 4
    max_paragraphs: int = 8
    # 单次实际输入 JSON 与生成标题／目录／正文分别受该字符上限约束。
    max_characters: int = 4000
    max_model_calls: int = 2

    def __post_init__(self):
        if any(type(value) is not int or value < 1 for value in self.to_payload().values()):
            raise ValueError("整理预算必须是有限正整数。")
        if self.max_model_calls != 2:
            raise ValueError("首批只支持一次提案和一次独立核验。")

    def to_payload(self) -> dict:
        return {name: getattr(self, name) for name in self.__dataclass_fields__}


@dataclass(frozen=True, slots=True, repr=False)
class OrganizationInput:
    memory_id: UUID
    revision: int
    text: str
    provenance_kind: str
    timing: dict
    event: dict | None
    category: str
    valid_at: str | None
    invalid_at: str | None

    def to_payload(self) -> dict:
        return {"memory_id": str(self.memory_id), "revision": self.revision, "text": self.text,
                "provenance_kind": self.provenance_kind, "timing": self.timing, "event": self.event,
                "category": self.category, "valid_at": self.valid_at, "invalid_at": self.invalid_at}


class ScenarioProposalPort(Protocol):
    def propose(self, *, memories: tuple[OrganizationInput, ...], budget: OrganizationBudget) -> dict:
        """返回 scenarios:[{topic_key,title,hint,paragraphs:[{text,references:[{memory_id,revision}]}]}]。"""


class ScenarioVerificationPort(Protocol):
    def verify(self, *, memories: tuple[OrganizationInput, ...], proposal: dict) -> bool:
        """独立逐次核验主体、否定、时间、条件与范围；明确 True 才能生效。"""


@dataclass(frozen=True, slots=True, repr=False)
class ScenarioDirectoryEntry:
    scenario_id: UUID
    version_id: UUID
    title: str
    hint: str
    paragraph_count: int


@dataclass(frozen=True, slots=True, repr=False)
class LayeredMemorySnapshot:
    schema_version: int
    scope: ContactScope
    settings_generation: int
    organization_generation: int
    scenarios: tuple[ScenarioDirectoryEntry, ...]
    dependency_ids: tuple[UUID, ...]


class LayeredMemoryPort(Protocol):
    def capture(self, scope: ContactScope) -> LayeredMemorySnapshot | None: ...

    def read_scenario(self, snapshot: LayeredMemorySnapshot, id: UUID,
                      range: tuple[int, int]) -> dict:
        """按冻结版本读取零基、左闭右开的完整段落范围。"""

    def validate(self, snapshot: LayeredMemorySnapshot) -> bool: ...
