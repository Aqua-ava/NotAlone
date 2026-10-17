"""调用方有限等待；已发适配器不可强行中断，迟到结果不进入发布路径。"""

from queue import Empty, Queue
from threading import Event, Thread


class OrganizationCallTimeout(RuntimeError):
    """本次语义调用超过已声明的有限等待。"""


def bounded_organization_call(call, *, priority, guard, timeout_seconds):
    results = Queue(maxsize=1)
    abandoned = Event()

    def check():
        if abandoned.is_set():
            raise OrganizationCallTimeout()
        guard()

    def run():
        try:
            # 许可随实际调用结束才释放；调用方超时不声称中断 SDK。
            with priority.background_scope(check):
                with priority.background_call():
                    value = call()
                priority.wait_for_foreground()
            results.put((True, value))
        except Exception as error:
            results.put((False, error))

    Thread(target=run, daemon=True, name="notalone-organization-call").start()
    try:
        succeeded, value = results.get(timeout=timeout_seconds)
    except Empty:
        abandoned.set()
        raise OrganizationCallTimeout() from None
    if not succeeded:
        raise value
    return value
