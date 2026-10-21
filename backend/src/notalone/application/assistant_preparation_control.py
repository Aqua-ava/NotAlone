"""准备阶段的协作取消；线程和最终持久化事务共用同一控制。"""

from contextvars import ContextVar
from contextlib import contextmanager
from dataclasses import dataclass, field
import threading
import time


class AssistantPreparationStopped(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__("助手准备已停止。")
        self.reason = reason


@dataclass(slots=True)
class AssistantPreparationControl:
    deadline: float
    _cancelled: threading.Event = field(default_factory=threading.Event)
    _reason: str = "cancelled"
    _write_lock: threading.RLock = field(default_factory=threading.RLock)
    _prepared: bool = False

    def cancel(self, reason: str = "cancelled") -> None:
        # 只与最后写入及提交串行；构建资料和来源复验不持有此锁。
        with self._write_lock:
            if not self._prepared and not self._cancelled.is_set():
                self._reason = reason
                self._cancelled.set()

    def check(self) -> None:
        if self._prepared:
            return
        if self._cancelled.is_set():
            raise AssistantPreparationStopped(self._reason)
        if time.monotonic() >= self.deadline:
            raise AssistantPreparationStopped("deadline")


assistant_preparation_control: ContextVar[AssistantPreparationControl | None] = ContextVar(
    "assistant_preparation_control", default=None,
)


def check_assistant_preparation() -> None:
    control = assistant_preparation_control.get()
    if control is not None:
        control.check()


@contextmanager
def assistant_preparation_write_guard():
    """取消先到时拒写；写入先到时在取消确认前完成事务提交。"""
    control = assistant_preparation_control.get()
    if control is None:
        yield
        return
    with control._write_lock:
        control.check()
        yield


def finish_assistant_preparation_write() -> None:
    """只能在最终写入已提交且控制锁尚未释放时调用。"""
    control = assistant_preparation_control.get()
    if control is not None:
        control._prepared = True
