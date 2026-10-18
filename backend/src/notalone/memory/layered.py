"""主题资料的公开合同；生成表达与底层事实分别保存。"""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.scopes import ContactScope, OwnerScope
from notalone.memory.organization_deadline import OrganizationAdapterTimeoutContract, OrganizationCallDeadline


class OrganizationBudgetExhausted(RuntimeError):
    """同一工作的持久调用额度已耗尽；刷新或重启不能重置。"""


class LayeredMemoryConflict(RuntimeError):
    """范围设置或实际输入已变化，旧操作不能生效。"""


@dataclass(frozen=True, slots=True)
class OrganizationBudget:
    """有限共享预算；默认工具维护与显式评测分别装配。"""

    max_memories: int = 12
    # 新增覆盖批大小与已有主题的递归来源输入分别限额。
    max_batch_memories: int = 12
    max_scenarios: int = 4
    max_paragraphs: int = 8
    # 单次实际输入 JSON 与生成标题／目录／正文分别受该字符上限约束。
    max_characters: int = 4000
    max_model_calls: int = 2
    max_profile_entries: int = 4

    def __post_init__(self):
        if any(type(value) is not int or value < 1 for value in self.to_payload().values()):
            raise ValueError("整理预算必须是有限正整数。")
        if not 2 <= self.max_model_calls <= 16:
            raise ValueError("整理模型调用预算须在2至16次之间。")

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
    timeout_contract: OrganizationAdapterTimeoutContract

    def propose(self, *, memories: tuple[OrganizationInput, ...], budget: OrganizationBudget,
                deadline: OrganizationCallDeadline) -> dict:
        """返回有界主题；deadline的剩余秒数必须用于实际传输，禁止隐式重试。

        显式接收scenarios时，旧正文和底层输入一起受预算、来源及世代复验。
        可用scenario_id保留身份、replaces列实际旧version_id；多个输出共享旧版本表示拆分。
        格式：scenarios:[{topic_key,title,hint,paragraphs:[{text,references:[{memory_id,revision}]}]}]。
        """


class ScenarioVerificationPort(Protocol):
    timeout_contract: OrganizationAdapterTimeoutContract

    def verify(self, *, memories: tuple[OrganizationInput, ...], proposal: dict,
               deadline: OrganizationCallDeadline, scenarios: tuple[dict, ...] = ()) -> bool:
        """独立核验主体、否定、时间、条件与范围，明确True才生效。

        全部传输与等待须遵守deadline剩余期限；不以外层等待代替实际超时。
        """


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
    scope: ContactScope | OwnerScope
    settings_generation: int
    organization_generation: int
    scenarios: tuple[ScenarioDirectoryEntry, ...]
    dependency_ids: tuple[UUID, ...]
    profile_version_id: UUID | None = None
    profile_entries: tuple[dict, ...] = ()
    quality_receipt: str | None = None


class LayeredMemoryPort(Protocol):
    def capture(self, scope: ContactScope | OwnerScope) -> LayeredMemorySnapshot | None: ...

    def read_scenario(self, snapshot: LayeredMemorySnapshot, id: UUID,
                      range: tuple[int, int]) -> dict:
        """按冻结版本读取零基、左闭右开的完整段落范围。"""

    def validate(self, snapshot: LayeredMemorySnapshot) -> bool: ...

    def validate_in_transaction(self, connection, snapshot: LayeredMemorySnapshot) -> bool:
        """调用方已持owner锁；复用原连接复验，不另开连接或锁。"""
        ...


class ProfileProposalPort(Protocol):
    timeout_contract: OrganizationAdapterTimeoutContract

    def propose(self, *, scenarios: tuple[dict, ...], memories: tuple[OrganizationInput, ...],
                budget: OrganizationBudget, deadline: OrganizationCallDeadline) -> dict:
        """仅从冻结合法主题及对应底层版本整理entries；每项含时间、不确定性和直接引用。"""


class ProfileVerificationPort(Protocol):
    timeout_contract: OrganizationAdapterTimeoutContract

    def verify(self, *, scenarios: tuple[dict, ...], memories: tuple[OrganizationInput, ...],
               proposal: dict, deadline: OrganizationCallDeadline) -> bool:
        """独立核验稳定／临时、主体、否定、时间、条件及范围；实际传输沿deadline。"""
