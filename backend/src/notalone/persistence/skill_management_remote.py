"""迁移期Skill同步RPC：固定宿主端口、内部凭据和owner，无本地回退。"""
from __future__ import annotations

import http.client
import json
import math
import socket
import threading
from uuid import UUID


class SkillManagementRemoteUnavailable(RuntimeError):
    """固定错误码；不暴露凭据、响应正文或本机路径。"""

    def __init__(self):
        super().__init__('skill_management_remote_unavailable')


class _Request:
    def __init__(self, port: int, timeout: float):
        self.connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        # 仅允许下方显式connect；取消清空socket后send不得自动重连并执行写请求。
        self.connection.auto_open = 0
        self.transport: socket.socket | None = None
        self.cancelled = threading.Event()

    def interrupt(self):
        self.cancelled.set()
        # HTTP/1.0响应会清空connection.sock；保留传输引用才能打断慢速正文。
        transport = self.transport or self.connection.sock
        if transport is not None:
            try:
                transport.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.connection.close()


class RemoteSkillManagement:
    """仅宿主装配配置；业务调用synchronize不接收URL、owner或令牌。

    internal_token必须是宿主单独生成的内部凭据，不能复用公开API令牌。
    HTTPConnection直接连接固定IPv4地址，不使用环境代理或跟随重定向。
    """

    def __init__(self, *, port: int, internal_token: str, owner_id: UUID,
                 timeout_seconds: float = 10.0):
        if (type(port) is not int or not 1 <= port <= 65535
                or not isinstance(owner_id, UUID)
                or not isinstance(internal_token, str) or not 32 <= len(internal_token) <= 1024
                or any(ord(c) < 33 or ord(c) > 126 for c in internal_token)
                or type(timeout_seconds) not in (float, int)
                or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 30):
            raise ValueError('skill_management_remote_config_invalid')
        self._port = port
        self._token = internal_token
        self._body = json.dumps({'owner_id': str(owner_id)}).encode('utf-8')
        self._timeout = timeout_seconds
        self._lock = threading.Lock()
        self._requests: set[_Request] = set()
        self._closed = False

    def synchronize(self) -> int:
        request = _Request(self._port, self._timeout)
        with self._lock:
            if self._closed:
                raise SkillManagementRemoteUnavailable()
            self._requests.add(request)
        deadline = threading.Timer(self._timeout, request.interrupt)
        deadline.daemon = True
        response = None
        deadline.start()
        try:
            request.connection.connect()
            request.transport = request.connection.sock
            if request.cancelled.is_set():
                request.interrupt()
                raise SkillManagementRemoteUnavailable()
            request.connection.request(
                'POST', '/api/runtime/skill-management/synchronize', body=self._body,
                headers={'Authorization': f'Bearer {self._token}',
                         'Content-Type': 'application/json', 'Connection': 'close'},
            )
            response = request.connection.getresponse()
            if (response.status != 200
                    or response.getheader('Content-Type', '').split(';')[0].strip().lower() != 'application/json'
                    or response.getheader('Content-Encoding') not in (None, 'identity')):
                raise ValueError()
            length = response.getheader('Content-Length')
            transfer = response.getheader('Transfer-Encoding')
            if (sum(len(k) + len(v) for k, v in response.getheaders()) > 8192
                    # 内部RPC只接受定长或关闭定界，避免trailer绕过响应预算。
                    or transfer is not None
                    or length is not None and (transfer is not None
                        or not length.isascii() or not length.isdecimal() or int(length) > 4096)):
                raise ValueError()
            payload = response.read(4097)
            if length is not None and len(payload) != int(length):
                raise ValueError()
            if len(payload) > 4096:
                raise ValueError()
            result = json.loads(payload.decode('utf-8'), object_pairs_hook=_unique_object)
            if (type(result) is not dict or set(result) != {'revision'}
                    or type(result['revision']) is not int
                    or not 0 <= result['revision'] <= 2147483647):
                raise ValueError()
            with self._lock:
                if self._closed or request.cancelled.is_set():
                    raise ValueError()
                return result['revision']
        except Exception:
            raise SkillManagementRemoteUnavailable() from None
        finally:
            deadline.cancel()
            if response is not None:
                response.close()
            request.connection.close()
            with self._lock:
                self._requests.discard(request)

    def close(self) -> None:
        """拒绝新请求并打断在途请求；由宿主在storage关闭前调用。"""
        with self._lock:
            self._closed = True
            requests = tuple(self._requests)
        for request in requests:
            request.interrupt()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result
