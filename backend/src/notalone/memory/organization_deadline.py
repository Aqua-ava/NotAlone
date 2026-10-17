"""整理Adapter的实际传输期限合同；声明不能认证任意Python实现守约。"""

from dataclasses import dataclass
import math
import time
from typing import Literal


class OrganizationCallTimeout(RuntimeError):
    """实际语义调用或调用方等待已耗尽同一个有限期限。"""


@dataclass(frozen=True, slots=True)
class OrganizationCallDeadline:
    expires_at: float

    def __post_init__(self) -> None:
        if (not isinstance(self.expires_at, (int, float)) or isinstance(self.expires_at, bool)
                or not math.isfinite(self.expires_at)):
            raise ValueError("整理期限必须是有限单调时钟值。")

    def remaining_seconds(self) -> float:
        remaining = self.expires_at - time.monotonic()
        if remaining <= 0:
            raise OrganizationCallTimeout()
        return remaining

    def check(self) -> None:
        self.remaining_seconds()


@dataclass(frozen=True, slots=True)
class OrganizationAdapterTimeoutContract:
    """准入声明；Adapter须把剩余期限执行到实际传输，不能只限制外层等待。

    每次只允许一次传输尝试，不启用SDK的隐式重试。所有连接、读取和等待共用
    单调时钟绝对期限；实际SDK装配必须另行证明这些设置确实执行，声明本身不
    证明实现守约或真实质量。任意挂死的Python注入无法靠线程期限强行中断。
    """

    transport_kind: Literal["synthetic", "sdk"]
    version: int = 1
    deadline_mode: str = "monotonic_total"
    max_transport_attempts: int = 1

    def __post_init__(self) -> None:
        if (self.transport_kind not in {"synthetic", "sdk"} or type(self.version) is not int
                or self.version != 1 or self.deadline_mode != "monotonic_total"
                or type(self.max_transport_attempts) is not int or self.max_transport_attempts != 1):
            raise ValueError("整理Adapter期限合同无效。")


SYNTHETIC_ORGANIZATION_TIMEOUT = OrganizationAdapterTimeoutContract("synthetic")
