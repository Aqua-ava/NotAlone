"""常驻本地后端服务的 HTTP 应用与回环服务器。"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Mapping
from urllib.parse import urlsplit
from uuid import UUID

from notalone.application.contact_directory import (
    ContactDirectory,
    ContactDirectoryError,
    ContactSummary,
)
from notalone.front_sync.sync_engine import (
    BindingCandidateView,
    FrontSyncCycleReport,
)
from notalone.persistence.contact_directory import PostgresContactDirectory
from notalone.server.event_bus import EventBus, EventSubscription
from notalone.server.sse import encode_sse_frame
from notalone.server.sync_host import SyncControlPort


@dataclass(frozen=True, slots=True)
class Response:
    """进程内 HTTP seam 与真实 HTTP 适配器共用的响应。"""

    status_code: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> object:
        return json.loads(self.body.decode("utf-8"))


@dataclass(frozen=True, slots=True)
class SseResponse:
    """已经通过鉴权、等待事件订阅的 SSE 响应。"""

    status_code: int
    headers: Mapping[str, str]
    subscription: EventSubscription


class BackendApp:
    """只提供本地 API 的无框架 HTTP 应用。"""

    __slots__ = ("_contact_directory", "_events", "_owner_id", "_sync_control", "_token")

    def __init__(
        self,
        *,
        contact_directory: ContactDirectory,
        events: EventBus,
        owner_id: UUID,
        token: str,
        sync_control: SyncControlPort | None = None,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not token:
            raise ValueError("token 不能为空。")
        self._contact_directory = contact_directory
        self._events = events
        self._owner_id = owner_id
        self._sync_control = sync_control
        self._token = token

    @property
    def token(self) -> str:
        """返回供父进程交给界面的连接 token。"""

        return self._token

    @property
    def events(self) -> EventBus:
        """返回供同步引擎和任务执行器发布事件的总线。"""

        return self._events

    def handle(
        self,
        *,
        method: str,
        path: str,
        headers: Mapping[str, str] | None = None,
        body: bytes = b"",
    ) -> Response:
        """处理一个请求；不把 token 或请求正文写入错误响应。"""

        del body
        request_headers = headers or {}
        if not self._authorized(request_headers):
            return _json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        method_upper = method.upper()
        path_value = urlsplit(path).path
        if method_upper == "GET" and path_value == "/api/contacts":
            try:
                contacts = self._contact_directory.list_contacts(self._owner_id)
            except ContactDirectoryError:
                return _json_response(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "contact_list_unavailable"},
                )
            return _json_response(
                HTTPStatus.OK,
                {"contacts": [_contact_payload(contact) for contact in contacts]},
            )
        if path_value.startswith("/api/sync"):
            return self._handle_sync(method=method_upper, path=path_value)
        return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def _handle_sync(self, *, method: str, path: str) -> Response:
        """处理同步控制端点；不做任何请求正文解析，失败关闭。"""

        if path not in {
            "/api/sync/status",
            "/api/sync/enable",
            "/api/sync/disable",
            "/api/sync/check",
        }:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        sync = self._sync_control
        if sync is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "sync_unavailable"}
            )
        if path == "/api/sync/status":
            if method != "GET":
                return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            report = sync.status()
            if report is None:
                return _json_response(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "sync_status_unavailable"},
                )
            return _json_response(HTTPStatus.OK, _sync_status_payload(report))
        if method != "POST":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        try:
            if path == "/api/sync/enable":
                report = sync.enable()
            elif path == "/api/sync/disable":
                report = sync.disable()
            else:
                report = sync.check()
        except Exception:
            # 稳定错误码，不把引擎异常细节回显给界面。
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "sync_control_failed"}
            )
        return _json_response(HTTPStatus.OK, _sync_status_payload(report))

    def open_sse(
        self,
        *,
        path: str,
        headers: Mapping[str, str] | None = None,
    ) -> Response | SseResponse:
        """打开一个经过 token 校验的 SSE 订阅。"""

        request_headers = headers or {}
        if not self._authorized(request_headers):
            return _json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        if urlsplit(path).path != "/api/events":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        last_event_id = _parse_last_event_id(request_headers)
        return SseResponse(
            status_code=int(HTTPStatus.OK),
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
            subscription=self._events.subscribe(
                owner_id=self._owner_id,
                last_event_id=last_event_id,
            ),
        )

    def _authorized(self, headers: Mapping[str, str]) -> bool:
        authorization = _header_value(headers, "Authorization")
        if authorization.startswith("Bearer "):
            supplied = authorization.removeprefix("Bearer ")
        else:
            supplied = _header_value(headers, "X-NotAlone-Token")
        return bool(supplied) and secrets.compare_digest(supplied, self._token)


class BackendServer:
    """把 BackendApp 绑定到回环地址的真实 HTTP 适配器。"""

    __slots__ = ("_app", "_host", "_port", "_http_server")

    def __init__(
        self,
        app: BackendApp,
        *,
        host: str = "127.0.0.1",
        port: int = 0,
    ) -> None:
        if host != "127.0.0.1":
            raise ValueError("本地后端只允许绑定回环地址。")
        if not isinstance(port, int) or not 0 <= port <= 65535:
            raise ValueError("port 必须在 0 到 65535 之间。")
        self._app = app
        self._host = host
        self._port = port
        self._http_server: ThreadingHTTPServer | None = None

    @property
    def address(self) -> tuple[str, int] | None:
        if self._http_server is None:
            return None
        host, port = self._http_server.server_address
        return str(host), int(port)

    def start(self) -> tuple[str, int]:
        """绑定回环地址；返回实际监听地址，port=0 时由系统分配端口。"""

        if self._http_server is not None:
            raise RuntimeError("后端服务已经启动。")
        app = self._app

        class RequestHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if urlsplit(self.path).path == "/api/events":
                    response = app.open_sse(
                        path=self.path,
                        headers={key: value for key, value in self.headers.items()},
                    )
                    if isinstance(response, SseResponse):
                        _serve_sse(self, response)
                    else:
                        _write_response(self, response)
                    return
                _serve_request(self, app)

            def do_POST(self) -> None:  # noqa: N802
                _serve_request(self, app)

            def do_PUT(self) -> None:  # noqa: N802
                _serve_request(self, app)

            def do_PATCH(self) -> None:  # noqa: N802
                _serve_request(self, app)

            def do_DELETE(self) -> None:  # noqa: N802
                _serve_request(self, app)

            def do_OPTIONS(self) -> None:  # noqa: N802
                _serve_request(self, app)

            def do_HEAD(self) -> None:  # noqa: N802
                _serve_request(self, app)

            def log_message(self, format: str, *args: object) -> None:
                del format, args

        self._http_server = ThreadingHTTPServer(
            (self._host, self._port), RequestHandler
        )
        self._http_server.daemon_threads = True
        address = self.address
        if address is None:
            raise RuntimeError("无法确认后端监听地址。")
        return address

    def serve_forever(self) -> None:
        if self._http_server is None:
            self.start()
        assert self._http_server is not None
        self._http_server.serve_forever()

    def shutdown(self) -> None:
        self._app.events.close()
        if self._http_server is not None:
            self._http_server.shutdown()
            self._http_server.server_close()
            self._http_server = None


def create_app(
    *,
    database_url: str,
    owner_id: UUID,
    token: str | None = None,
    events: EventBus | None = None,
    sync_control: SyncControlPort | None = None,
) -> BackendApp:
    """创建服务应用；未显式传 token 时在启动时生成随机 token。"""

    return BackendApp(
        contact_directory=ContactDirectory(PostgresContactDirectory(database_url)),
        events=events or EventBus(),
        owner_id=owner_id,
        token=token or secrets.token_urlsafe(32),
        sync_control=sync_control,
    )


def _serve_request(handler: BaseHTTPRequestHandler, app: BackendApp) -> None:
    response = app.handle(
        method=handler.command,
        path=handler.path,
        headers={key: value for key, value in handler.headers.items()},
    )
    _write_response(handler, response)


def _write_response(handler: BaseHTTPRequestHandler, response: Response) -> None:
    handler.send_response(response.status_code)
    for key, value in response.headers.items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(response.body)


def _serve_sse(handler: BaseHTTPRequestHandler, response: SseResponse) -> None:
    handler.send_response(response.status_code)
    for key, value in response.headers.items():
        handler.send_header(key, value)
    handler.end_headers()
    try:
        while True:
            event = response.subscription.read(timeout=15.0)
            if event is None:
                if response.subscription.closed:
                    break
                handler.wfile.write(b": keep-alive\n\n")
                handler.wfile.flush()
                continue
            handler.wfile.write(encode_sse_frame(event))
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        response.subscription.close()


def _header_value(headers: Mapping[str, str], name: str) -> str:
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value.strip()
    return ""


def _parse_last_event_id(headers: Mapping[str, str]) -> UUID | None:
    value = _header_value(headers, "Last-Event-ID")
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


def _contact_payload(contact: ContactSummary) -> dict[str, object]:
    return {
        "contact_id": str(contact.contact_id),
        "display_name": contact.display_name,
        "data_status": {
            "message_count": contact.data_status.message_count,
            "source_count": contact.data_status.source_count,
        },
    }


def _sync_status_payload(report: FrontSyncCycleReport) -> dict[str, object]:
    """把循环报告投影为状态 API 的稳定 JSON；不含任何消息正文。"""

    return {
        "sync_enabled": report.sync_enabled,
        "phase": report.phase.value,
        "probe_available": report.probe_available,
        "wechat_in_front": report.wechat_in_front,
        "cli_available": report.cli_available,
        "failure_code": report.failure_code,
        "active_contact_id": (
            None if report.active_contact_id is None else str(report.active_contact_id)
        ),
        "active_binding_display_name": report.active_binding_display_name,
        "decision_reason": (
            None if report.decision_reason is None else report.decision_reason.value
        ),
        "batch_message_count": report.batch_message_count,
        "candidates": [_candidate_payload(candidate) for candidate in report.candidates],
    }


def _candidate_payload(candidate: BindingCandidateView) -> dict[str, object]:
    return {
        "username": candidate.username,
        "display_name": candidate.display_name,
        "last_timestamp": candidate.last_timestamp,
    }


def _json_response(status: HTTPStatus, payload: object) -> Response:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    return Response(
        status_code=int(status),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(body)),
        },
        body=body,
    )
