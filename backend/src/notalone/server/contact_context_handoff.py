"""具名联系人上下文 HTTP 责任门；短事务排空不代表后台租约已移交。"""

from __future__ import annotations

import threading
import re
from urllib.parse import urlsplit


def is_contact_context_request(method: str, path: str) -> bool:
    path = urlsplit(path).path
    if method == "GET" and path == "/api/contacts":
        return True
    parts = path.split("/")
    if len(parts) != 5 or parts[1:3] != ["api", "contacts"] or not parts[3]:
        return False
    return (method == "GET" and parts[4] in {
        "messages", "sources", "relationship-overview",
    }) or (method == "POST" and parts[4] == "manual-confirmation")


class ContactContextHandoff:
    """停收与计数使用同一锁，控制请求不持锁等待业务请求。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._accepting = True
        self._active = 0
        self._target: tuple[str, str] | None = None

    def status(self) -> dict[str, object]:
        with self._lock:
            return self._status_locked()

    def _status_locked(self) -> dict[str, object]:
        state = "running" if self._accepting else "stopping" if self._active else "stopped"
        return {"state": state, "active_requests": self._active}

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
            self._active -= 1

    def configure(self, payload: object) -> None:
        """由已认证宿主指定唯一回环目标，不允许通过配置读取其他地址。"""
        if not isinstance(payload, dict) or set(payload) != {"address", "token"}:
            raise ValueError("联系人上下文目标无效。")
        address, token = payload["address"], payload["token"]
        match = re.fullmatch(r"127\.0\.0\.1:([0-9]{1,5})", address) if isinstance(address, str) else None
        if (match is None or not 1 <= int(match[1]) <= 65535
                or not isinstance(token, str) or not token or len(token) > 1024
                or any(ord(character) < 33 or ord(character) > 126 for character in token)):
            raise ValueError("联系人上下文目标无效。")
        with self._lock:
            self._target = (address, token)

    def overview_target(self) -> tuple[str, str] | None:
        """本地读取原子计入排空；移交后只返回显式目标，没有自动回退。"""
        with self._lock:
            if self._accepting:
                self._active += 1
                return None
            if self._active or self._target is None:
                raise RuntimeError("联系人上下文责任尚未就绪。")
            return self._target

    def read_transferred_overview(self, target, scope):
        from notalone.server.contact_overview_proxy import read_transferred_overview
        return read_transferred_overview(target, scope)
