"""后端服务的进程内测试客户端。"""

from __future__ import annotations

from collections.abc import Mapping

from notalone.server.app import BackendApp, Response


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
