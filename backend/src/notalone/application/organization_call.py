"""同一绝对期限贯穿排队与实际Adapter；等待超时不冒充SDK中断。"""

import inspect
from queue import Empty, Queue
from threading import Event, Thread
import time

from notalone.memory.organization_deadline import (
    OrganizationAdapterTimeoutContract, OrganizationCallDeadline, OrganizationCallTimeout,
)


def require_adapter_timeout_contract(adapter, operation, *, synthetic):
    contract = getattr(adapter, "timeout_contract", None)
    if (not isinstance(contract, OrganizationAdapterTimeoutContract)
            or synthetic and contract.transport_kind != "synthetic"):
        raise ValueError("整理Adapter须有当前范围获准的实际传输期限合同。")
    method = getattr(adapter, operation, None)
    if not callable(method):
        raise ValueError("整理Adapter缺少公开调用。")
    parameter = inspect.signature(method).parameters.get("deadline")
    if parameter is None or parameter.kind != inspect.Parameter.KEYWORD_ONLY or parameter.default is not inspect.Parameter.empty:
        raise ValueError("整理Adapter必须显式接收实际传输的deadline。")


def bounded_organization_call(call, *, priority, guard, timeout_seconds):
    results = Queue(maxsize=1)
    abandoned = Event()
    # 排队、来源guard和实际传输共享预算；取得许可后不重新计时。
    deadline = OrganizationCallDeadline(time.monotonic() + timeout_seconds)

    def check():
        if abandoned.is_set():
            raise OrganizationCallTimeout()
        deadline.check()
        guard()
        deadline.check()

    def run():
        try:
            # 许可随实际调用结束才释放；调用方超时不声称中断 SDK。
            with priority.background_scope(check):
                with priority.background_call():
                    deadline.check()
                    value = call(deadline)
                priority.wait_for_foreground()
            results.put((True, value))
        except Exception as error:
            results.put((False, error))

    Thread(target=run, daemon=True, name="notalone-organization-call").start()
    try:
        succeeded, value = results.get(timeout=deadline.remaining_seconds())
    except (Empty, OrganizationCallTimeout):
        abandoned.set()
        raise OrganizationCallTimeout() from None
    if not succeeded:
        raise value
    return value
