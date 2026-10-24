"""公开记忆／偏好管理的独立责任门；不门禁后台提取、裁决或回复检索。"""

from __future__ import annotations

import re
import threading
from urllib.parse import urlsplit


def is_memory_management_request(method: str, path: str) -> bool:
    """与TS管理路由相同；不涵盖processing、overview及后台存储调用。"""
    path = urlsplit(path).path
    if re.fullmatch(r"/api/expression-preferences(?:/[^/]+)?/?", path):
        return True
    if method not in {"GET", "POST"}:
        return False
    return bool(re.fullmatch(
        r"/api/contacts/[^/]+/(?:memories|owner-memories|memory-candidates)"
        r"(?:/[^/]+/(?:versions|confirm|discard|apply-update|correct|delete|revert-auto-update))?",
        path,
    ) or re.fullmatch(
        r"/api/memories/(?:owner(?:/[^/]+/(?:versions|correct|delete|revert-auto-update))?"
        r"|manual-contact|manual-owner)", path,
    ))


class MemoryManagementHandoff:
    """停收与计数同锁；控制请求独立返回状态，不持锁等待HTTP事务。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._accepting = True
        self._active = 0

    def _status_locked(self) -> dict[str, object]:
        state = "running" if self._accepting else "stopping" if self._active else "stopped"
        return {"state": state, "active_requests": self._active}

    def status(self) -> dict[str, object]:
        with self._lock:
            return self._status_locked()

    def stop(self) -> dict[str, object]:
        with self._lock:
            self._accepting = False
            return self._status_locked()

    def start(self) -> dict[str, object] | None:
        with self._lock:
            if not self._accepting and self._active:
                return None
            self._accepting = True
            return self._status_locked()

    def enter(self) -> bool:
        with self._lock:
            if not self._accepting:
                return False
            self._active += 1
            return True

    def leave(self) -> None:
        with self._lock:
            if self._active < 1:
                raise RuntimeError("记忆管理请求计数无效。")
            self._active -= 1
