"""生产与合成追踪共用的安全失败状态映射。"""

from __future__ import annotations


def failure_status(error_code: str) -> str:
    return {
        "trace_write_failed": "trace_failed",
        "model_work_stopped": "stopped",
        "background_task_lease_invalidated": "scope_invalidated",
        "background_task_scope_invalidated": "scope_invalidated",
        "background_task_guard_failed": "scope_guard_failed",
    }.get(error_code, "business_failed")
