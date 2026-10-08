"""后端服务的进程内测试客户端。"""

from __future__ import annotations

from collections.abc import Mapping

from notalone.server.app import BackendApp, Response, SseResponse
from notalone.server.event_bus import EventSubscription
from notalone.server.sse import encode_sse_frame


class InProcessClient:
    """直接调用服务应用，不创建网络监听或子进程。"""

    __slots__ = ("_app",)

    def __init__(self, app: BackendApp) -> None:
        self._app = app

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes = b"",
    ) -> Response:
        return self._app.handle(
            method=method,
            path=path,
            headers=headers,
            body=body,
        )

    def get(
        self,
        path: str,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> Response:
        return self.request("GET", path, headers=headers)

    def open_sse(
        self,
        path: str,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> "InProcessSseStream | Response":
        response = self._app.open_sse(path=path, headers=headers)
        if isinstance(response, Response):
            return response
        return InProcessSseStream(
            subscription=response.subscription,
            status_code=response.status_code,
            headers=response.headers,
        )


class InProcessSseStream:
    """直接读取进程内订阅，不建立网络连接。"""

    __slots__ = ("_subscription", "status_code", "headers")

    def __init__(
        self,
        *,
        subscription: EventSubscription,
        status_code: int,
        headers: Mapping[str, str],
    ) -> None:
        self._subscription = subscription
        self.status_code = status_code
        self.headers = headers

    def read(self, timeout: float | None = None) -> bytes | None:
        event = self._subscription.read(timeout=timeout)
        return None if event is None else encode_sse_frame(event)

    def close(self) -> None:
        self._subscription.close()
