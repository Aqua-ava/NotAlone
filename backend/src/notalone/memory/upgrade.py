"""用户明确选择的旧资料比较预算，不表示已授权执行。"""

from dataclasses import dataclass
from uuid import UUID


class UpgradeConflict(RuntimeError):
    """原范围、来源、资料或用户批准已变化。"""


class UpgradeNotFound(RuntimeError):
    """当前已验证范围没有该工作。"""


class UpgradeDeleted(UpgradeConflict):
    """工作内容已清除，旧动作不能恢复。"""


class UpgradeBudgetExceeded(UpgradeConflict):
    """显式总预算已经用尽，恢复不能隐式扩展。"""


class UpgradeAlgorithmChanged(UpgradeConflict):
    """原预览算法或有效配置未知／变化，必须重新明确准备。"""


@dataclass(frozen=True)
class UpgradeScope:
    owner_id: UUID
    kind: str
    contact_id: UUID | None = None

    def __post_init__(self):
        if (not isinstance(self.owner_id, UUID) or self.kind not in ('contact', 'owner')
                or self.kind == 'contact' and not isinstance(self.contact_id, UUID)
                or self.kind == 'owner' and self.contact_id is not None):
            raise ValueError('升级范围必须是单一联系人或独立本人资料。')


@dataclass(frozen=True)
class UpgradeBudget:
    message_limit: int
    batch_size: int
    model_calls: int

    def __post_init__(self) -> None:
        for value, maximum in ((self.message_limit, 200), (self.batch_size, 20), (self.model_calls, 40)):
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError('升级比较预算超出允许范围。')
