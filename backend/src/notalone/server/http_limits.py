"""回环 HTTP 的读取截止时间与连接资源约束。"""

from __future__ import annotations

import io
import math
import socket
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import monotonic


@dataclass(frozen=True, slots=True)
class HttpRequestLimits:
    """正文允许 1 MiB；本地读取预算与 SSE 写超时分开计时。"""

    header_seconds: float = 5.0
    body_seconds: float = 10.0
    write_seconds: float = 5.0
    max_connections: int = 32

    def __post_init__(self) -> None:
        for seconds in (self.header_seconds, self.body_seconds, self.write_seconds):
            if not math.isfinite(seconds) or seconds <= 0:
                raise ValueError("HTTP 超时必须为有限正数。")
        if (not isinstance(self.max_connections, int)
                or isinstance(self.max_connections, bool) or self.max_connections < 1):
            raise ValueError("HTTP 并发连接上限必须为正整数。")


class _DeadlineReader(io.RawIOBase):
    def __init__(self, connection: socket.socket, seconds: float) -> None:
        super().__init__()
        self._connection = connection
        self.deadline = monotonic() + seconds

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: bytearray) -> int:
        remaining = self.deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("HTTP 读取截止时间已到。")
        # 每次底层 recv 都重算剩余时间；零星字节不能重置总预算。
        self._connection.settimeout(remaining)
        return self._connection.recv_into(buffer)


class LimitedRequestHandler(BaseHTTPRequestHandler):
    """沿用标准 HTTP 解析器，只替换其有截止时间的输入流。"""

    limits = HttpRequestLimits()

    def setup(self) -> None:
        super().setup()
        self.rfile.close()
        self._input = _DeadlineReader(self.connection, self.limits.header_seconds)
        self.rfile = io.BufferedReader(self._input)

    def handle(self) -> None:
        try:
            super().handle()
        except (ConnectionError, TimeoutError):
            # 本地客户端取消或超时不把原始请求／堆栈写进日志。
            self.close_connection = True

    def parse_request(self) -> bool:
        try:
            return super().parse_request()
        finally:
            self.connection.settimeout(self.limits.write_seconds)

    def begin_body_read(self, seconds: float | None = None) -> None:
        self._input.deadline = monotonic() + (
            self.limits.body_seconds if seconds is None else seconds
        )

    def end_body_read(self) -> None:
        self.connection.settimeout(self.limits.write_seconds)


class LimitedHTTPServer(ThreadingHTTPServer):
    """只为有额度的连接创建线程，关闭时回收本宿主的所有套接字。"""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], handler: type[LimitedRequestHandler],
                 limits: HttpRequestLimits) -> None:
        self._slots = threading.BoundedSemaphore(limits.max_connections)
        self._active_lock = threading.Lock()
        self._active: set[socket.socket] = set()
        super().__init__(address, handler)

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        if not self._slots.acquire(blocking=False):
            try:
                request.settimeout(0.1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\n"
                                b"Connection: close\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        with self._active_lock:
            self._active.add(request)
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._release(request)
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._release(request)

    def _release(self, request: socket.socket) -> None:
        with self._active_lock:
            self._active.discard(request)
        self._slots.release()

    def server_close(self) -> None:
        with self._active_lock:
            active = tuple(self._active)
        for request in active:
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        super().server_close()
