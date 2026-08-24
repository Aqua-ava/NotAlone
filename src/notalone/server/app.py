"""常驻本地后端服务的 HTTP 应用与回环服务器。"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Mapping
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from notalone.application.contact_directory import (
    ContactDirectory,
    ContactDirectoryError,
    ContactSummary,
)
from notalone.application.message_stream import (
    MessageStream,
    MessageStreamContactNotFound,
    StreamedMessage,
)
from notalone.application.reply_request import (
    ReplyRequestInvalid,
    parse_reply_request,
)
from notalone.application.reply_service import ReplyService
from notalone.front_sync.sync_engine import (
    BindingCandidateView,
    BindingConfirmationError,
    FrontSyncCycleReport,
)
from notalone.persistence.contact_directory import PostgresContactDirectory
from notalone.persistence.message_stream import PostgresMessageStream
from notalone.reply.interface import ReplyGenerated
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

    __slots__ = (
        "_contact_directory",
        "_events",
        "_message_stream",
        "_owner_id",
        "_reply_service",
        "_sync_control",
        "_token",
    )

    def __init__(
        self,
        *,
        contact_directory: ContactDirectory,
        events: EventBus,
        owner_id: UUID,
        token: str,
        sync_control: SyncControlPort | None = None,
        message_stream: MessageStream | None = None,
        reply_service: ReplyService | None = None,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not token:
            raise ValueError("token 不能为空。")
        self._contact_directory = contact_directory
        self._events = events
        self._message_stream = message_stream
        self._reply_service = reply_service
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

        request_body = bytes(body)
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
        if path_value.startswith("/api/contacts/") and path_value.endswith("/messages"):
            return self._handle_messages(
                method=method_upper,
                path=path_value,
                query=urlsplit(path).query,
            )
        if path_value == "/api/reply/generate":
            return self._handle_reply_generate(
                method=method_upper,
                body=request_body,
            )
        if path_value.startswith("/api/sync"):
            return self._handle_sync(
                method=method_upper,
                path=path_value,
                body=request_body,
            )
        return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def _handle_messages(self, *, method: str, path: str, query: str) -> Response:
        """处理 /api/contacts/{contact_id}/messages：分页读取消息流。"""

        if method != "GET":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        stream = self._message_stream
        prefix = "/api/contacts/"
        suffix = "/messages"
        contact_value = path[len(prefix):-len(suffix)]
        try:
            contact_id = UUID(contact_value)
        except ValueError:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "contact_not_found"})

        parameters = _parse_query(query)
        try:
            limit = int(parameters.get("limit", "") or "50")
        except ValueError:
            limit = -1
        before_value = parameters.get("before", "")
        if before_value:
            try:
                before_message_id = UUID(before_value)
            except ValueError:
                return _json_response(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid_message_query"}
                )
        else:
            before_message_id = None
        try:
            page = stream.page_messages(
                owner_id=self._owner_id,
                contact_id=contact_id,
                limit=limit,
                before_message_id=before_message_id,
            )
        except MessageStreamContactNotFound:
            return _json_response(
                HTTPStatus.NOT_FOUND, {"error": "contact_not_found"}
            )
        except (TypeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "invalid_message_query"}
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "message_stream_unavailable"},
            )
        return _json_response(
            HTTPStatus.OK,
            {
                "messages": [
                    _message_payload(message) for message in page.messages
                ],
                "next_cursor": (
                    None
                    if page.next_cursor is None
                    else str(page.next_cursor)
                ),
            },
        )

    def _handle_sync(self, *, method: str, path: str, body: bytes) -> Response:
        """处理同步控制端点；confirm 读取严格 JSON 请求体，失败关闭。"""

        if path not in {
            "/api/sync/status",
            "/api/sync/enable",
            "/api/sync/disable",
            "/api/sync/check",
            "/api/sync/confirm",
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
        if path == "/api/sync/confirm":
            return self._handle_sync_confirm(sync=sync, body=body)
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

    def _handle_sync_confirm(
        self,
        *,
        sync: SyncControlPort,
        body: bytes,
    ) -> Response:
        """解析一次性绑定确认请求；参数缺失或冲突时失败关闭。"""

        try:
            payload = json.loads(body.decode("utf-8")) if body.strip() else {}
        except (UnicodeDecodeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "binding_confirmation_invalid"}
            )
        if not isinstance(payload, dict):
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "binding_confirmation_invalid"}
            )
        contact_value = payload.get("contact_id")
        locator = payload.get("locator")
        if isinstance(contact_value, str):
            try:
                contact_id = UUID(contact_value)
            except ValueError:
                contact_id = None
        else:
            contact_id = None
        if contact_id is None or not isinstance(locator, str) or not locator.strip():
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "binding_confirmation_invalid"}
            )
        try:
            report = sync.confirm(contact_id=contact_id, locator=locator)
        except BindingConfirmationError as error:
            return _json_response(
                HTTPStatus.CONFLICT,
                {"error": "binding_confirmation_rejected", "reason": error.code},
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "binding_confirm_failed"},
            )
        return _json_response(HTTPStatus.OK, _sync_status_payload(report))

    def _handle_reply_generate(self, *, method: str, body: bytes) -> Response:
        """处理候选回复生成请求；失败关闭且不回显请求正文。"""

        if method != "POST":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        service = self._reply_service
        if service is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "reply_unavailable"}
            )
        try:
            contact_id, request = parse_reply_request(body)
        except ReplyRequestInvalid:
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "reply_request_invalid"}
            )

        try:
            result = service.generate(
                owner_id=self._owner_id,
                contact_id=contact_id,
                request=request,
            )
        except Exception:
            # 生成/持久化阶段的基础设施异常：5xx，不用 409 伪装成冲突。
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "reply_generation_failed"},
            )
        if result.rejected:
            return _json_response(
                HTTPStatus.CONFLICT,
                {
                    "error": "reply_rejected",
                    "reason": result.reason or "unknown",
                },
            )
        reply = result.reply
        if reply is None:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "reply_generation_failed"},
            )
        return _json_response(HTTPStatus.OK, _reply_payload(reply))

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
    message_stream: MessageStream | None = None,
    reply_service: ReplyService | None = None,
) -> BackendApp:
    """创建服务应用；未显式传 token 时在启动时生成随机 token。"""

    return BackendApp(
        contact_directory=ContactDirectory(PostgresContactDirectory(database_url)),
        events=events or EventBus(),
        owner_id=owner_id,
        token=token or secrets.token_urlsafe(32),
        sync_control=sync_control,
        message_stream=message_stream or MessageStream(PostgresMessageStream(database_url)),
        reply_service=reply_service,
    )


def _serve_request(handler: BaseHTTPRequestHandler, app: BackendApp) -> None:
    response = app.handle(
        method=handler.command,
        path=handler.path,
        headers={key: value for key, value in handler.headers.items()},
        body=_read_request_body(handler),
    )
    _write_response(handler, response)


def _read_request_body(handler: BaseHTTPRequestHandler) -> bytes:
    """按 Content-Length 读取请求体；缺失或无法解析时按空体处理。

    只允许读取回环本地请求；Content-Length 异常（负数/超大）按空体
    处理，避免无界读入。
    """

    try:
        length = int(_header_value(handler.headers, "Content-Length"))
    except (ValueError, TypeError):
        return b""
    if length < 0 or length > 1024 * 1024:
        return b""
    if length == 0:
        return b""
    try:
        return handler.rfile.read(length) or b""
    except (OSError, ConnectionError):
        return b""


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


def _reply_payload(reply: ReplyGenerated) -> dict[str, object]:
    """把已持久化的候选回复投影为稳定 JSON；不含会话正文以外内容。"""

    used_skill = None
    if reply.used_skill is not None:
        skill = reply.used_skill
        used_skill = {
            "skill_id": str(skill.skill_id),
            "version_id": str(skill.version_id),
            "name": skill.name,
            "selection_method": skill.selection_method,
            "selection_reason": skill.selection_reason,
            "resource_paths": list(skill.resource_paths),
            "load_state": skill.load_state,
        }
    return {
        "reply_request_id": str(reply.reply_request_id),
        "candidates": [
            {
                "candidate_id": str(candidate.candidate_id),
                "text": candidate.text,
                "basis": candidate.basis,
                "citation_ids": [str(citation) for citation in candidate.citation_ids],
                "risk_notes": list(candidate.risk_notes),
            }
            for candidate in reply.candidates
        ],
        "context_receipt": {
            "evidence_ids": [
                str(evidence) for evidence in reply.context_receipt.evidence_ids
            ],
        },
        "used_skill": used_skill,
    }


def _message_payload(message: StreamedMessage) -> dict[str, object]:
    """把消息流投影转为稳定 JSON；正文与媒体占位分开，不冒充。"""

    quoted = None
    if message.quoted is not None:
        quoted = {
            "text": message.quoted.text,
            "target_message_id": (
                None
                if message.quoted.target_message_id is None
                else str(message.quoted.target_message_id)
            ),
        }
    return {
        "message_id": str(message.message_id),
        "speaker": message.speaker,
        "message_type": message.message_type,
        "text": message.text,
        "media_placeholder": message.media_placeholder,
        "occurred_at": _format_timestamp(message.occurred_at),
        "quoted": quoted,
    }


def _format_timestamp(value: datetime | None) -> str | None:
    """与 SSE 契约一致的秒级 UTC 时间戳；空值返回 None。"""

    if value is None:
        return None
    utc_value = value.astimezone(timezone.utc)
    return utc_value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_query(query: str) -> dict[str, str]:
    """解析查询字符串；支持 URL 解码与 '+'，重复键取最后一个。"""

    result: dict[str, str] = {}
    for key, values in parse_qs(
        query,
        keep_blank_values=True,
        encoding="utf-8",
    ).items():
        if values:
            result[key] = values[-1]
    return result


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
