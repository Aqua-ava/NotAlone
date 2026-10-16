"""后台任务的合成验收等待；测试截止不等于生产任务失败。"""

from collections import deque
import json
import math
import sys
import time
from threading import Event
from typing import Any, NoReturn
from urllib.parse import urlencode


# 覆盖30秒租约接管及锁忙退避；仅为测试防挂预算，不规定产品完成时效。
BACKGROUND_TASK_WAIT_SECONDS = 60.0
_TERMINAL_STATES = {"succeeded", "failed", "cancelled"}
_POLL_SECONDS = 0.05
_DIAGNOSTIC_SECONDS = 1.0


class TaskWaitError(AssertionError):
    """保留停止宿主、释放合成门之前的公开任务与宿主状态。"""

    def __init__(self, reason: str, *, task: dict[str, Any], host: dict[str, Any],
                 history: list[dict[str, Any]], elapsed: float) -> None:
        self.reason = reason
        self.task, self.host = task, host
        self.history, self.elapsed = history, elapsed
        details = {"reason": reason, "elapsed": round(elapsed, 3),
                   "task": task, "host": host, "progress": history}
        super().__init__("后台任务验收未达到预期：" + json.dumps(details, ensure_ascii=False))


class TaskWaitTimeout(TaskWaitError):
    """测试总预算耗尽；保留原任务状态，不取消、不重试、不宣布业务失败。"""


def wait_for_task(backend: Any, imported: dict[str, Any], expected: str, *,
                  timeout: float = BACKGROUND_TASK_WAIT_SECONDS) -> dict[str, Any]:
    return _wait(backend, imported, expected=expected, checkpoint=None,
                 timeout=timeout, notice_after=10.0)


def wait_for_task_checkpoint(backend: Any, imported: dict[str, Any], checkpoint: Event, *,
                             timeout: float = BACKGROUND_TASK_WAIT_SECONDS) -> dict[str, Any]:
    """等待受控写入边界，同时识别提前结束或失败的原任务。"""

    return _wait(backend, imported, expected=None, checkpoint=checkpoint,
                 timeout=timeout, notice_after=8.0)


def _wait(backend: Any, imported: dict[str, Any], *, expected: str | None,
          checkpoint: Event | None, timeout: float, notice_after: float) -> dict[str, Any]:
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("测试等待预算必须大于零。")
    started = time.monotonic()
    deadline = started + timeout
    history: deque[dict[str, Any]] = deque(maxlen=8)
    task: dict[str, Any] = {}
    noticed = False
    query = urlencode({"contact_id": imported["contact_id"], "task_id": imported["task_id"]})
    host_path = "/api/tasks/status?" + urlencode({"contact_id": imported["contact_id"]})

    def read_host(*, timeout: float = _DIAGNOSTIC_SECONDS) -> dict[str, Any]:
        try:
            return _read(backend, host_path, timeout=timeout)
        except Exception as error:
            return {"diagnostic_error": type(error).__name__}

    def fail(reason: str, error_type: type[TaskWaitError] = TaskWaitError) -> NoReturn:
        # 诊断额外最多一次1秒HTTP，不随进度延长总等待；发生在夹具收尾之前。
        raise error_type(reason, task=task, host=read_host(), history=list(history),
                         elapsed=time.monotonic() - started)

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail("test_deadline_exceeded", TaskWaitTimeout)
        if checkpoint is not None and checkpoint.is_set():
            return task
        try:
            task = _read(backend, "/api/tasks/status?" + query, timeout=min(10.0, remaining))
        except Exception as error:
            if time.monotonic() >= deadline:
                fail("test_deadline_exceeded", TaskWaitTimeout)
            fail("task_status_unavailable:" + type(error).__name__)
        progress = {key: task.get(key) for key in ("status", "step", "retry_count", "error_code")}
        progress["steps"] = [
            {key: step.get(key) for key in ("name", "status", "attempt_count", "processed_count")}
            for step in task.get("steps", [])
        ]
        if not history or progress != history[-1]:
            history.append(progress)
        if time.monotonic() >= deadline:
            fail("test_deadline_exceeded", TaskWaitTimeout)
        if checkpoint is not None and checkpoint.is_set():
            return task
        if checkpoint is None and task["status"] == expected:
            if noticed:
                print(f"后台任务超过旧等待点后达到预期：{task['task_id']} {expected}", file=sys.stderr)
            return task
        if task["status"] in _TERMINAL_STATES:
            fail("checkpoint_not_reached" if checkpoint is not None else "unexpected_terminal_state")
        elapsed = time.monotonic() - started
        if not noticed and elapsed >= notice_after:
            noticed = True
            print("后台任务超过旧测试等待点，继续在总预算内观察：" + json.dumps(
                {"task_id": imported["task_id"], "task": progress,
                 "host": read_host(timeout=min(_DIAGNOSTIC_SECONDS, deadline - time.monotonic()))},
                ensure_ascii=False), file=sys.stderr)
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(_POLL_SECONDS, remaining))


def _read(backend: Any, path: str, *, timeout: float) -> dict[str, Any]:
    status, payload = backend.request(path, timeout=timeout)
    if status != 200:
        raise AssertionError(f"任务状态接口返回HTTP {status}。")
    return payload
