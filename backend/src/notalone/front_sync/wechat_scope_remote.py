"""迁移期同步范围端口：只连接由宿主注入的认证 loopback 服务。"""
from __future__ import annotations

import http.client
import json
import socket
import threading
from datetime import datetime
from urllib.parse import urlsplit
from uuid import UUID

from notalone.persistence.sync_scope import SyncScopeState
from notalone.persistence.history_authorization import (
    HistoryAuthorization, HistoryAuthorizationState,
)


class WechatScopeOwnedByTypeScript(RuntimeError):
    """旧写入口已移交；HTTP 适配层应映射为 503。"""

    def __init__(self) -> None:
        super().__init__("wechat_scope_owned_by_typescript")


class RemoteWechatScope:
    def __init__(self, *, url: str, token: str, owner_id: UUID, account_scope: str) -> None:
        try:
            parsed = urlsplit(url)
            valid = (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
                     and parsed.port is not None and not parsed.username and not parsed.password
                     and not parsed.path and not parsed.query and not parsed.fragment)
        except ValueError:
            valid = False
        if not valid or not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError("wechat_scope_remote_config_invalid")
        self._port = parsed.port
        self._token = token
        self._scope = {"owner_id": str(owner_id), "channel": "wechat", "account_scope": account_scope}
        self._lock = threading.Lock()
        self._connections: set[http.client.HTTPConnection] = set()
        self._closed = False

    def _request(self, operation: str, extra: dict | None = None) -> dict:
        timeout = 14 if operation == "discover" else 3 if operation == "revoke" else 2
        connection = http.client.HTTPConnection("127.0.0.1", self._port, timeout=timeout)
        # 显式连接后若被关闭，发送阶段不得自动重连并越过停读边界。
        connection.auto_open = 0
        with self._lock:
            if self._closed:
                raise RuntimeError("wechat_scope_remote_closed")
            self._connections.add(connection)
        def interrupt() -> None:
            if connection.sock is not None:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()

        deadline = threading.Timer(timeout, interrupt)
        deadline.daemon = True
        deadline.start()
        try:
            connection.connect()
            with self._lock:
                if self._closed:
                    raise ValueError()
            connection.request("POST", f"/api/runtime/wechat-scope/{operation}",
                               body=json.dumps({**self._scope, **(extra or {})}).encode(),
                               headers={"Authorization": f"Bearer {self._token}",
                                        "Content-Type": "application/json"})
            response = connection.getresponse()
            budget = 262144 if operation == "history-bindings" else 65536
            payload = response.read(budget + 1)
            if len(payload) > budget or (operation != "revoke" and response.status != 200):
                raise ValueError()
            if operation == "revoke" and not (200 <= response.status <= 599 and not 300 <= response.status <= 399):
                raise ValueError()
            result = json.loads(payload)
            if not isinstance(result, dict):
                raise ValueError()
            with self._lock:
                if self._closed:
                    raise ValueError()
            return {"status": response.status, "body": result} if operation == "revoke" else result
        except Exception:
            raise RuntimeError("wechat_scope_remote_unavailable") from None
        finally:
            deadline.cancel()
            with self._lock:
                self._connections.discard(connection)
            connection.close()

    def _check_scope(self, *, owner_id: UUID, channel: str, account_scope: str) -> None:
        if {"owner_id": str(owner_id), "channel": channel, "account_scope": account_scope} != self._scope:
            raise ValueError("wechat_scope_remote_identity_mismatch")

    def read(self, **scope) -> SyncScopeState:
        self._check_scope(**scope)
        value = self._request("state")
        try:
            if value["mode"] not in ("selected", "all_private"):
                raise ValueError()
            raw = value["granted_at"]
            at = datetime.fromisoformat(raw.replace("Z", "+00:00")) if raw is not None else None
            if at is not None and at.tzinfo is None:
                raise ValueError()
            return SyncScopeState(value["mode"], at)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise RuntimeError("wechat_scope_remote_invalid_response") from None

    def discover(self, **scope) -> int:
        self._check_scope(**scope)
        value = self._request("discover").get("created")
        if type(value) is not int or not 0 <= value <= 250:
            raise RuntimeError("wechat_scope_remote_invalid_response")
        return value

    def revoke(self, *, contact_id: UUID, binding_id: UUID) -> dict:
        if not isinstance(contact_id, UUID) or not isinstance(binding_id, UUID):
            raise TypeError("绑定和联系人必须是 UUID。")
        return self._request("revoke", {"contact_id": str(contact_id), "binding_id": str(binding_id)})

    def authorized_binding_ids(self, **scope) -> frozenset[UUID]:
        """只接受 TS 已核验范围内的具体绑定，不推断账号级同意。"""
        self._check_scope(**scope)
        value = self._request("history-bindings").get("binding_ids")
        try:
            if not isinstance(value, list) or len(value) > 5000:
                raise ValueError()
            identifiers = []
            for item in value:
                if not isinstance(item, str):
                    raise ValueError()
                identifier = UUID(item)
                if str(identifier) != item:
                    raise ValueError()
                identifiers.append(identifier)
            if len(set(identifiers)) != len(identifiers):
                raise ValueError()
            return frozenset(identifiers)
        except (ValueError, TypeError, AttributeError):
            raise RuntimeError("wechat_scope_remote_invalid_response") from None

    def close(self) -> None:
        with self._lock:
            self._closed = True
            connections = tuple(self._connections)
        for connection in connections:
            if connection.sock is not None:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()


class RemoteHistoryAuthorization:
    """复用范围端口；账号状态仅展示，执行资格始终按具体绑定核验。"""

    def __init__(self, remote: RemoteWechatScope) -> None:
        self._remote = remote

    def read(self, **scope) -> HistoryAuthorization:
        self._remote._check_scope(**scope)
        value = self._remote._request("history-state")
        try:
            if set(value) != {"state", "version", "current_version"}:
                raise ValueError()
            return HistoryAuthorization(
                state=HistoryAuthorizationState(value["state"]),
                version=value["version"], current_version=value["current_version"],
            )
        except (KeyError, TypeError, ValueError):
            raise RuntimeError("wechat_scope_remote_invalid_response") from None

    def decide(self, **kwargs) -> HistoryAuthorization:
        raise WechatScopeOwnedByTypeScript()

    def history_sync_authorized(self, **scope) -> bool:
        # 旧账号级接口不具备表达绑定集合的能力，不能据此创建全范围任务。
        self._remote._check_scope(**scope)
        return False

    def authorized_binding_ids(self, **scope) -> frozenset[UUID]:
        return self._remote.authorized_binding_ids(**scope)
