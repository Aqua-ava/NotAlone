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
from notalone.application.import_service import (
    ImportService,
    TaskHost,
)
from notalone.application.setup_service import SetupService
from notalone.application.skill_service import (
    LedgerService,
    SkillImportRejected,
    SkillService,
)
from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.import_command import ContactConfirmationError
from notalone.persistence.postgres_repository import ImportPersistenceError
from notalone.persistence.conversation_repository import (
    ConversationBindingConflictError,
)
from notalone.persistence.skill_library import (
    SkillDeletedError,
    SkillLibraryPersistenceError,
    SkillNotFoundError,
    SkillVersionNotFoundError,
)
from notalone.application.memory_service import (
    ManualMemoryEntry,
    MemoryService,
)
from notalone.memory.models import (
    ConfirmedMemory,
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.front_sync.sync_engine import (
    BindingCandidateView,
    BindingConfirmationError,
    FrontSyncCycleReport,
)
from notalone.front_sync.cli_binding import (
    CliBindingCandidateView,
    CliBindingSelection,
)
from notalone.persistence.contact_directory import PostgresContactDirectory
from notalone.persistence.message_stream import PostgresMessageStream
from notalone.reply.interface import ReplyGenerated
from notalone.server.event_bus import EventBus, EventSubscription
from notalone.server.follow_smoke import (
    FollowSmokeContactSnapshot,
    FollowSmokeController,
    FollowSmokeRejected,
    FollowSmokeRequestInvalid,
    FollowSmokeStatus,
)
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


class MemoryRequestInvalid(ValueError):
    """记忆请求结构或契约无效；不携带请求内容细节。"""


class ImportTaskRequestInvalid(ValueError):
    """导入或任务请求结构或契约无效；不携带请求内容细节。"""


class SkillRequestInvalid(ValueError):
    """Skill 管理请求结构或契约无效；不携带请求内容细节。"""


class SetupRequestInvalid(ValueError):
    """首启向导请求结构或契约无效；不携带请求内容细节。"""


class BackendApp:
    """只提供本地 API 的无框架 HTTP 应用。"""

    __slots__ = (
        "_contact_directory",
        "_events",
        "_follow_smoke",
        "_import_service",
        "_ledger_service",
        "_memory_service",
        "_message_stream",
        "_owner_id",
        "_reply_service",
        "_setup_service",
        "_skill_service",
        "_sync_control",
        "_task_host",
        "_token",
    )

    def __init__(
        self,
        *,
        contact_directory: ContactDirectory,
        events: EventBus,
        owner_id: UUID | None,
        token: str,
        sync_control: SyncControlPort | None = None,
        follow_smoke: FollowSmokeController | None = None,
        message_stream: MessageStream | None = None,
        reply_service: ReplyService | None = None,
        memory_service: MemoryService | None = None,
        import_service: ImportService | None = None,
        task_host: TaskHost | None = None,
        skill_service: SkillService | None = None,
        ledger_service: LedgerService | None = None,
        setup_service: SetupService | None = None,
    ) -> None:
        if owner_id is not None and not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not token:
            raise ValueError("token 不能为空。")
        self._contact_directory = contact_directory
        self._events = events
        self._follow_smoke = follow_smoke
        self._import_service = import_service
        self._ledger_service = ledger_service
        self._memory_service = memory_service
        self._message_stream = message_stream
        self._reply_service = reply_service
        self._owner_id = owner_id
        self._setup_service = setup_service
        self._skill_service = skill_service
        self._sync_control = sync_control
        self._task_host = task_host
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
        if (
            self._owner_id is None
            and not path_value.startswith("/api/setup")
            and path_value != "/api/settings/credentials"
        ):
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "owner_uninitialized"},
            )
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
        if path_value.startswith("/api/memories") or (
            path_value.startswith("/api/contacts/")
            and (
                "/memories" in path_value
                or "/memory-candidates" in path_value
            )
        ):
            return self._handle_memory(
                method=method_upper,
                path=path_value,
                body=request_body,
            )
        if path_value.startswith("/api/imports") or path_value.startswith("/api/tasks"):
            return self._handle_import_task(
                method=method_upper,
                path=path_value,
                query=urlsplit(path).query,
                body=request_body,
            )
        if path_value == "/api/ledger/summary":
            return self._handle_ledger(method=method_upper)
        if path_value.startswith("/api/skills"):
            return self._handle_skill(
                method=method_upper,
                path=path_value,
                body=request_body,
            )
        if path_value == "/api/settings/credentials":
            if method_upper != "GET":
                return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            import os

            configured = bool(
                os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "").strip()
            )
            return _json_response(
                HTTPStatus.OK,
                {
                    "provider": "deepseek",
                    "configured": configured,
                },
            )
        if path_value.startswith("/api/setup"):
            return self._handle_setup(
                method=method_upper,
                path=path_value,
                body=request_body,
            )
        if path_value.startswith("/api/sync/follow-smoke"):
            return self._handle_follow_smoke(
                method=method_upper,
                path=path_value,
                body=request_body,
            )
        if path_value.startswith("/api/sync"):
            return self._handle_sync(
                method=method_upper,
                path=path_value,
                body=request_body,
            )
        return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def _handle_follow_smoke(
        self,
        *,
        method: str,
        path: str,
        body: bytes,
    ) -> Response:
        """处理 App 人工验证端点；只返回状态和检查点元数据。"""

        paths = {
            "/api/sync/follow-smoke/status": "status",
            "/api/sync/follow-smoke/start": "start",
            "/api/sync/follow-smoke/stop": "stop",
            "/api/sync/follow-smoke/interrupt": "interrupt",
            "/api/sync/follow-smoke/checkpoint": "checkpoint",
        }
        action = paths.get(path)
        if action is None:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        controller = self._follow_smoke
        if controller is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "follow_smoke_unavailable"},
            )
        if action == "status":
            if method != "GET":
                return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            try:
                return _json_response(
                    HTTPStatus.OK,
                    _follow_smoke_payload(controller.status()),
                )
            except Exception:
                return _json_response(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "follow_smoke_failed"},
                )
        if method != "POST":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        try:
            if action == "start":
                result = controller.start()
            elif action == "stop":
                result = controller.stop()
            elif action == "interrupt":
                result = controller.interrupt()
            else:
                payload = _parse_follow_smoke_json(body)
                result = controller.checkpoint(payload.get("label"))
        except FollowSmokeRequestInvalid:
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "follow_smoke_request_invalid"},
            )
        except FollowSmokeRejected as error:
            return _json_response(
                HTTPStatus.CONFLICT,
                {"error": "follow_smoke_rejected", "reason": error.code},
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "follow_smoke_failed"},
            )
        return _json_response(HTTPStatus.OK, _follow_smoke_payload(result))

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
            "/api/sync/confirm-pending",
            "/api/sync/cli-sessions",
            "/api/sync/cli-bindings/confirm",
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
        if path == "/api/sync/cli-sessions":
            if method != "GET":
                return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            list_sessions = getattr(sync, "cli_sessions", None)
            if not callable(list_sessions):
                return _json_response(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "cli_sessions_unavailable"},
                )
            try:
                sessions = list_sessions()
            except Exception:
                return _json_response(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "cli_sessions_failed"},
                )
            return _json_response(
                HTTPStatus.OK,
                {"sessions": [_cli_session_payload(session) for session in sessions]},
            )
        if method != "POST":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        if path == "/api/sync/cli-bindings/confirm":
            return self._handle_cli_bindings_confirm(sync=sync, body=body)
        if path in {"/api/sync/confirm", "/api/sync/confirm-pending"}:
            return self._handle_sync_confirm(
                sync=sync,
                body=body,
                pending=path == "/api/sync/confirm-pending",
            )
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

    def _handle_cli_bindings_confirm(
        self,
        *,
        sync: SyncControlPort,
        body: bytes,
    ) -> Response:
        """解析 CLI 私聊批量绑定；所有选择一次性提交且不回显会话正文。"""

        try:
            payload = json.loads(body.decode("utf-8")) if body.strip() else {}
        except (UnicodeDecodeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "cli_binding_request_invalid"},
            )
        if not isinstance(payload, dict):
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "cli_binding_request_invalid"},
            )
        raw_selections = payload.get("selections")
        if not isinstance(raw_selections, list) or len(raw_selections) > 5000:
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "cli_binding_request_invalid"},
            )
        selections: list[CliBindingSelection] = []
        try:
            for raw in raw_selections:
                if not isinstance(raw, dict):
                    raise ValueError
                locator = raw.get("locator")
                if not isinstance(locator, str) or not locator.strip():
                    raise ValueError
                contact_value = raw.get("contact_id")
                if contact_value is None:
                    contact_id = None
                elif isinstance(contact_value, str):
                    contact_id = UUID(contact_value)
                else:
                    raise ValueError
                display_name = raw.get("display_name")
                if display_name is not None and (
                    not isinstance(display_name, str) or not display_name.strip()
                ):
                    raise ValueError
                selections.append(
                    CliBindingSelection(
                        locator=locator,
                        contact_id=contact_id,
                        display_name=display_name,
                    )
                )
        except (TypeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "cli_binding_request_invalid"},
            )

        confirm = getattr(sync, "confirm_cli_bindings", None)
        if not callable(confirm):
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "cli_binding_unavailable"},
            )
        try:
            report = confirm(tuple(selections))
        except ConversationBindingConflictError:
            return _json_response(
                HTTPStatus.CONFLICT,
                {"error": "cli_binding_rejected", "reason": "binding_conflict"},
            )
        except ValueError:
            # CLI 列表可能在用户确认前变化；要求界面重新读取，不暴露定位细节。
            return _json_response(
                HTTPStatus.CONFLICT,
                {"error": "cli_binding_rejected", "reason": "selection_stale"},
            )
        except TypeError:
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "cli_binding_request_invalid"},
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "cli_binding_failed"},
            )
        return _json_response(HTTPStatus.OK, _sync_status_payload(report))

    def _handle_sync_confirm(
        self,
        *,
        sync: SyncControlPort,
        body: bytes,
        pending: bool = False,
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
            if pending:
                report = sync.confirm_pending(
                    contact_id=contact_id,
                    locator=locator,
                )
            else:
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

    def _handle_memory(self, *, method: str, path: str, body: bytes) -> Response:
        """处理记忆管理端点；失败关闭且不回显正文。"""

        service = self._memory_service
        if service is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "memory_unavailable"}
            )
        try:
            return self._dispatch_memory(method=method, path=path, body=body)
        except MemoryRequestInvalid:
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "memory_request_invalid"}
            )

    def _dispatch_memory(self, *, method: str, path: str, body: bytes) -> Response:
        """按路径分发记忆管理请求。"""

        owner_id = self._owner_id
        service = self._memory_service

        if method == "GET" and path == "/api/memories/owner":
            return _json_response(
                HTTPStatus.OK,
                {
                    "memories": [
                        _owner_memory_payload(memory)
                        for memory in service.list_owner_memories(owner_id=owner_id)
                    ]
                },
            )
        if method == "POST" and path == "/api/memories/manual-contact":
            payload = _parse_memory_json(body)
            contact_id = _uuid_or_raise(payload.get("contact_id"), "contact_id")
            entry = _manual_entry_or_raise(payload)
            memory = service.add_manual_contact_memory(
                owner_id=owner_id,
                contact_id=contact_id,
                entry=ManualMemoryEntry(
                    text=entry["text"],
                    category=entry["category"],
                    topic=entry["topic"],
                ),
            )
            return _json_response(
                HTTPStatus.OK, {"memory": _memory_payload(memory)}
            )
        if method == "POST" and path == "/api/memories/manual-owner":
            payload = _parse_memory_json(body)
            entry = _manual_entry_or_raise(payload)
            memory = service.add_manual_owner_memory(
                owner_id=owner_id,
                entry=ManualMemoryEntry(
                    text=entry["text"],
                    category=entry["category"],
                    topic=entry["topic"],
                ),
            )
            return _json_response(
                HTTPStatus.OK, {"memory": _owner_memory_payload(memory)}
            )
        if method == "POST" and path.startswith("/api/memories/owner/") \
                and path.endswith("/delete"):
            memory_id = _uuid_or_raise(_path_tail(path, "/api/memories/owner/", "/delete"), "memory_id")
            memory = service.delete_owner_memory(
                owner_id=owner_id, memory_id=memory_id
            )
            return _json_response(
                HTTPStatus.OK, {"memory": _owner_memory_payload(memory)}
            )

        # 联系人级端点：/api/contacts/{contact_id}/...
        parts = path.removeprefix("/api/contacts/").split("/")
        if len(parts) < 2:
            raise MemoryRequestInvalid()
        contact_id = _uuid_or_raise(parts[0], "contact_id")
        segment = parts[1]
        if method == "GET" and segment == "memories" and len(parts) == 2:
            return _json_response(
                HTTPStatus.OK,
                {
                    "memories": [
                        _memory_payload(memory)
                        for memory in service.list_contact_memories(
                            owner_id=owner_id, contact_id=contact_id
                        )
                    ]
                },
            )
        if method == "GET" and segment == "memory-candidates" and len(parts) == 2:
            return _json_response(
                HTTPStatus.OK,
                {
                    "candidates": [
                        _memory_candidate_payload(candidate)
                        for candidate in service.list_pending(
                            owner_id=owner_id, contact_id=contact_id
                        )
                    ]
                },
            )
        if method == "POST" and segment == "memory-candidates" and len(parts) == 4:
            candidate_id = _uuid_or_raise(parts[2], "candidate_id")
            action = parts[3]
            if action == "confirm":
                memory = service.confirm_candidate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    candidate_id=candidate_id,
                )
                return _json_response(
                    HTTPStatus.OK, {"memory": _memory_payload(memory)}
                )
            if action == "discard":
                candidate = service.discard_candidate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    candidate_id=candidate_id,
                )
                return _json_response(
                    HTTPStatus.OK, {"candidate_id": str(candidate.candidate_id)}
                )
            raise MemoryRequestInvalid()
        if method == "POST" and segment == "memories" and len(parts) == 4:
            memory_id = _uuid_or_raise(parts[2], "memory_id")
            action = parts[3]
            if action == "delete":
                memory = service.delete_contact_memory(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    memory_id=memory_id,
                )
                return _json_response(
                    HTTPStatus.OK, {"memory": _memory_payload(memory)}
                )
            if action == "correct":
                payload = _parse_memory_json(body)
                text = payload.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise MemoryRequestInvalid()
                category = _optional_category(payload.get("category"))
                memory = service.correct_memory(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    memory_id=memory_id,
                    text=text,
                    category=category,
                )
                return _json_response(
                    HTTPStatus.OK, {"memory": _memory_payload(memory)}
                )
            raise MemoryRequestInvalid()
        raise MemoryRequestInvalid()

    def _handle_import_task(
        self,
        *,
        method: str,
        path: str,
        query: str,
        body: bytes,
    ) -> Response:
        """处理导入与任务触发端点；失败关闭且不回显正文。"""

        # 服务装配缺失（数据库/模型配置故障）是服务端状态：503，
        # 不把配置问题伪装成客户端请求错误。
        needs_import = path.startswith("/api/imports")
        needs_task = path.startswith("/api/tasks")
        if (
            (needs_import and self._import_service is None)
            or (needs_task and self._task_host is None)
        ):
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "import_task_unavailable"},
            )
        try:
            return self._dispatch_import_task(
                method=method, path=path, query=query, body=body
            )
        except ImportTaskRequestInvalid:
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "import_request_invalid"}
            )

    def _dispatch_import_task(
        self,
        *,
        method: str,
        path: str,
        query: str,
        body: bytes,
    ) -> Response:
        """按路径分发导入与任务请求。"""

        owner_id = self._owner_id
        import_service = self._import_service
        task_host = self._task_host

        if path == "/api/imports/preview":
            if method != "POST" or import_service is None:
                raise ImportTaskRequestInvalid()
            payload = _parse_import_json(body)
            path_value = payload.get("path")
            if not isinstance(path_value, str) or not path_value.strip():
                raise ImportTaskRequestInvalid()
            try:
                preview = import_service.preview(path=path_value)
            except (FileNotFoundError, ImportPreviewError, OSError, PermissionError):
                # 文件缺失、不可读或内容校验失败：统一 422 + 稳定码，
                # 具体原因不进入响应（不泄露本机路径或文件内容）。
                return _json_response(
                    422,
                    {
                        "error": "import_preview_failed",
                        "reason": "preview_failed",
                    },
                )
            return _json_response(HTTPStatus.OK, preview)

        if path == "/api/imports/commit":
            if method != "POST" or import_service is None:
                raise ImportTaskRequestInvalid()
            payload = _parse_import_json(body)
            path_value = payload.get("path")
            if not isinstance(path_value, str) or not path_value.strip():
                raise ImportTaskRequestInvalid()
            contact_value = payload.get("contact_id")
            new_name_value = payload.get("new_contact_name")
            has_contact = bool(
                isinstance(contact_value, str) and contact_value.strip()
            )
            has_new = bool(
                isinstance(new_name_value, str) and new_name_value.strip()
            )
            if has_contact == has_new:
                # 必须二选一；不能同时提供。
                raise ImportTaskRequestInvalid()
            from notalone.ingest.models import (
                ExistingContactSelection,
                NewContactSelection,
            )

            if has_contact:
                try:
                    contact_id = UUID(contact_value)
                except ValueError:
                    raise ImportTaskRequestInvalid() from None
                selection = ExistingContactSelection(contact_id=contact_id)
            else:
                selection = NewContactSelection(display_name=new_name_value)
            try:
                result = import_service.commit(
                    path=path_value,
                    owner_id=owner_id,
                    selection=selection,
                )
            except (
                ImportPreviewError,
                ContactConfirmationError,
                ImportPersistenceError,
            ):
                # 业务拒绝（归属冲突/联系人缺失/校验失败）：409 + 稳定码。
                return _json_response(
                    HTTPStatus.CONFLICT,
                    {"error": "import_commit_failed"},
                )
            return _json_response(HTTPStatus.OK, result)

        if path == "/api/tasks/run":
            if method != "POST" or task_host is None:
                raise ImportTaskRequestInvalid()
            payload = _parse_import_json(body)
            contact_value = payload.get("contact_id")
            if not isinstance(contact_value, str):
                raise ImportTaskRequestInvalid()
            try:
                contact_id = UUID(contact_value)
            except ValueError:
                raise ImportTaskRequestInvalid() from None
            return _json_response(
                HTTPStatus.OK,
                task_host.start(owner_id=owner_id, contact_id=contact_id),
            )

        if path == "/api/tasks/status":
            if method != "GET" or task_host is None:
                raise ImportTaskRequestInvalid()
            query_pairs = parse_qs(query)
            contact_values = query_pairs.get("contact_id", [])
            if len(contact_values) != 1:
                raise ImportTaskRequestInvalid()
            try:
                contact_id = UUID(contact_values[0])
            except ValueError:
                raise ImportTaskRequestInvalid() from None
            return _json_response(
                HTTPStatus.OK,
                task_host.current(owner_id=owner_id, contact_id=contact_id),
            )

        raise ImportTaskRequestInvalid()

    def _handle_setup(self, *, method: str, path: str, body: bytes) -> Response:
        """处理首启向导端点；失败关闭且不回显正文与密钥。"""

        service = self._setup_service
        if service is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "setup_unavailable"}
            )
        try:
            if path == "/api/setup/status" and method == "GET":
                return _json_response(HTTPStatus.OK, service.status())
            if path == "/api/setup/initialize" and method == "POST":
                payload = _parse_setup_json(body)
                display_name = payload.get("display_name")
                if not isinstance(display_name, str) or not display_name.strip():
                    raise SetupRequestInvalid()
                try:
                    return _json_response(
                        HTTPStatus.OK,
                        service.initialize_owner(display_name=display_name),
                    )
                except ValueError:
                    raise SetupRequestInvalid() from None
            if path == "/api/setup/credentials" and method == "POST":
                payload = _parse_setup_json(body)
                provider = payload.get("provider")
                api_key = payload.get("api_key")
                if provider != "deepseek" or not isinstance(api_key, str) or not api_key.strip():
                    raise SetupRequestInvalid()
                try:
                    return _json_response(
                        HTTPStatus.OK,
                        service.write_credentials(api_key=api_key),
                    )
                except ValueError:
                    raise SetupRequestInvalid() from None
            raise SetupRequestInvalid()
        except SetupRequestInvalid:
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "setup_request_invalid"}
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "setup_operation_failed"},
            )

    def _handle_ledger(self, *, method: str) -> Response:
        """处理台账概览端点；只投影元数据，不含正文。"""

        ledger = self._ledger_service
        if method != "GET":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        if ledger is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "ledger_unavailable"},
            )
        try:
            return _json_response(
                HTTPStatus.OK, ledger.summary(owner_id=self._owner_id)
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "ledger_summary_failed"},
            )

    def _handle_skill(self, *, method: str, path: str, body: bytes) -> Response:
        """处理 Skill 管理端点；失败关闭且不回显正文。"""

        owner_id = self._owner_id
        skills = self._skill_service

        if skills is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "skill_unavailable"}
            )
        try:
            return self._dispatch_skill(
                method=method, path=path, body=body
            )
        except SkillRequestInvalid:
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "skill_request_invalid"}
            )
        except SkillNotFoundError:
            return _json_response(
                HTTPStatus.NOT_FOUND,
                {"error": "skill_not_found", "reason": "skill_not_found"},
            )
        except SkillDeletedError:
            return _json_response(
                HTTPStatus.CONFLICT,
                {"error": "skill_deleted", "reason": "skill_deleted"},
            )
        except SkillVersionNotFoundError:
            return _json_response(
                HTTPStatus.NOT_FOUND,
                {
                    "error": "skill_version_not_found",
                    "reason": "skill_version_not_found",
                },
            )
        except SkillLibraryPersistenceError:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "skill_persistence_failed"},
            )

    def _dispatch_skill(self, *, method: str, path: str, body: bytes) -> Response:
        """按路径分发 Skill 管理请求。"""

        owner_id = self._owner_id
        skills = self._skill_service

        if path == "/api/skills" and method == "GET":
            return _json_response(
                HTTPStatus.OK, skills.list(owner_id=owner_id)
            )
        if path == "/api/skills/import":
            if method != "POST":
                raise SkillRequestInvalid()
            payload = _parse_skill_json(body)
            package_path = payload.get("package_path")
            if not isinstance(package_path, str) or not package_path.strip():
                raise SkillRequestInvalid()
            try:
                result = skills.import_skill(
                    owner_id=owner_id, package_path=package_path
                )
            except SkillImportRejected:
                return _json_response(
                    HTTPStatus.CONFLICT,
                    {"error": "skill_import_rejected", "reason": "package_invalid"},
                )
            return _json_response(HTTPStatus.OK, result)

        parts = path.removeprefix("/api/skills/").split("/")
        if len(parts) != 2:
            raise SkillRequestInvalid()
        try:
            skill_id = UUID(parts[0])
        except ValueError:
            raise SkillRequestInvalid() from None
        action = parts[1]
        if action == "preview":
            if method != "GET":
                raise SkillRequestInvalid()
            return _json_response(
                HTTPStatus.OK, skills.preview(owner_id=owner_id, skill_id=skill_id)
            )
        if method != "POST":
            raise SkillRequestInvalid()
        if action == "enable":
            return _json_response(
                HTTPStatus.OK, skills.enable(owner_id=owner_id, skill_id=skill_id)
            )
        if action == "disable":
            return _json_response(
                HTTPStatus.OK, skills.disable(owner_id=owner_id, skill_id=skill_id)
            )
        if action == "delete":
            return _json_response(
                HTTPStatus.OK, skills.delete(owner_id=owner_id, skill_id=skill_id)
            )
        if action == "rollback":
            payload = _parse_skill_json(body)
            version_value = payload.get("version_id")
            if not isinstance(version_value, str):
                raise SkillRequestInvalid()
            try:
                version_id = UUID(version_value)
            except ValueError:
                raise SkillRequestInvalid() from None
            return _json_response(
                HTTPStatus.OK,
                skills.rollback(
                    owner_id=owner_id,
                    skill_id=skill_id,
                    version_id=version_id,
                ),
            )
        raise SkillRequestInvalid()

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
    owner_id: UUID | None,
    token: str | None = None,
    events: EventBus | None = None,
    sync_control: SyncControlPort | None = None,
    message_stream: MessageStream | None = None,
    reply_service: ReplyService | None = None,
    memory_service: MemoryService | None = None,
    import_service: ImportService | None = None,
    task_host: TaskHost | None = None,
    skill_service: SkillService | None = None,
    ledger_service: LedgerService | None = None,
    setup_service: SetupService | None = None,
    follow_smoke: FollowSmokeController | None = None,
) -> BackendApp:
    """创建服务应用；未显式传 token 时在启动时生成随机 token。"""

    return BackendApp(
        contact_directory=ContactDirectory(PostgresContactDirectory(database_url)),
        events=events or EventBus(),
        owner_id=owner_id,
        token=token or secrets.token_urlsafe(32),
        sync_control=sync_control,
        follow_smoke=follow_smoke,
        message_stream=message_stream or MessageStream(PostgresMessageStream(database_url)),
        reply_service=reply_service,
        memory_service=memory_service,
        import_service=import_service,
        task_host=task_host,
        skill_service=skill_service,
        ledger_service=ledger_service,
        setup_service=setup_service,
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

    payload: dict[str, object] = {
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
    if report.sync_mode != "foreground":
        payload.update(
            {
                "sync_mode": report.sync_mode,
                "cli_sync_phase": report.cli_sync_phase,
                "cli_sync_mode": report.cli_sync_mode,
                "cli_stream_active": report.cli_stream_active,
                "cli_bound_count": report.cli_bound_count,
                "cli_pending_count": report.cli_pending_count,
                "cli_batch_message_count": report.cli_batch_message_count,
                "cli_failure_code": report.cli_failure_code,
                "foreground_phase": report.foreground_phase,
                "foreground_failure_code": report.foreground_failure_code,
            }
        )
    return payload


def _cli_session_payload(session: CliBindingCandidateView) -> dict[str, object]:
    """把 CLI 私聊候选投影为不含消息正文的批量绑定 JSON。"""

    return {
        "username": session.username,
        "display_name": session.display_name,
        "last_timestamp": session.last_timestamp,
        "bound_contact_id": session.bound_contact_id,
    }


def _follow_smoke_payload(status: FollowSmokeStatus) -> dict[str, object]:
    """把人工验证状态投影为只含元数据的稳定 JSON。"""

    report = status.report
    return {
        "active": status.active,
        "follow_enabled": status.runtime.enabled,
        "follow_stream_active": status.runtime.stream_active,
        "follow_process_id": status.runtime.process_id,
        "follow_mode": status.runtime.mode,
        "follow_watermark": status.runtime.watermark,
        "sync_enabled": None if report is None else report.sync_enabled,
        "phase": None if report is None else report.phase.value,
        "probe_available": None if report is None else report.probe_available,
        "wechat_in_front": None if report is None else report.wechat_in_front,
        "cli_available": None if report is None else report.cli_available,
        "failure_code": None if report is None else report.failure_code,
        "active_contact_id": (
            None
            if report is None or report.active_contact_id is None
            else str(report.active_contact_id)
        ),
        "active_binding_display_name": (
            None if report is None else report.active_binding_display_name
        ),
        "batch_message_count": None if report is None else report.batch_message_count,
        "last_valid_observation": (
            None
            if status.last_valid_observation is None
            else {
                "observed_at": _format_timestamp(
                    status.last_valid_observation.observed_at
                ),
                "contact_id": str(status.last_valid_observation.contact_id),
                "display_name": status.last_valid_observation.display_name,
                "watermark": status.last_valid_observation.watermark,
                "batch_message_count": (
                    status.last_valid_observation.batch_message_count
                ),
            }
        ),
        "contacts": [
            _follow_smoke_contact_payload(contact) for contact in status.contacts
        ],
        "checkpoints": [
            {
                "label": checkpoint.label,
                "recorded_at": _format_timestamp(checkpoint.recorded_at),
                "contacts": [
                    _follow_smoke_contact_payload(contact)
                    for contact in checkpoint.contacts
                ],
            }
            for checkpoint in status.checkpoints
        ],
    }


def _follow_smoke_contact_payload(
    contact: FollowSmokeContactSnapshot,
) -> dict[str, object]:
    """投影联系人级验证统计，不携带名称、正文或原始载荷。"""

    return {
        "contact_id": str(contact.contact_id),
        "bound": contact.bound,
        "message_count": contact.message_count,
        "observation_ref_count": contact.observation_ref_count,
        "watermark": contact.watermark,
        "latest_mode": contact.latest_mode,
        "duplicate_identities": contact.duplicate_identities,
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


# ----------------------------------------------------------------------
# 记忆端点辅助
# ----------------------------------------------------------------------


def _parse_memory_json(body: bytes) -> dict[str, object]:
    """解析记忆请求体；任何异常收敛为 MemoryRequestInvalid。"""

    try:
        payload = json.loads(body.decode("utf-8")) if body.strip() else None
    except (UnicodeDecodeError, ValueError):
        raise MemoryRequestInvalid() from None
    if not isinstance(payload, dict):
        raise MemoryRequestInvalid()
    return payload


def _parse_skill_json(body: bytes) -> dict[str, object]:

    try:
        payload = json.loads(body.decode("utf-8")) if body.strip() else None
    except (UnicodeDecodeError, ValueError):
        raise SkillRequestInvalid() from None
    if not isinstance(payload, dict):
        raise SkillRequestInvalid()
    return payload


def _parse_setup_json(body: bytes) -> dict[str, object]:
    """解析首启向导请求体；任何异常收敛为 SetupRequestInvalid。"""

    try:
        payload = json.loads(body.decode("utf-8")) if body.strip() else None
    except (UnicodeDecodeError, ValueError):
        raise SetupRequestInvalid() from None
    if not isinstance(payload, dict):
        raise SetupRequestInvalid()
    return payload


def _parse_import_json(body: bytes) -> dict[str, object]:
    """解析导入/任务请求体；任何异常收敛为 ImportTaskRequestInvalid。"""

    try:
        payload = json.loads(body.decode("utf-8")) if body.strip() else None
    except (UnicodeDecodeError, ValueError):
        raise ImportTaskRequestInvalid() from None
    if not isinstance(payload, dict):
        raise ImportTaskRequestInvalid()
    return payload


def _parse_follow_smoke_json(body: bytes) -> dict[str, object]:
    """解析固定的人工验证请求体，不保留或回显未知内容。"""

    try:
        payload = json.loads(body.decode("utf-8")) if body.strip() else None
    except (UnicodeDecodeError, ValueError):
        raise FollowSmokeRequestInvalid() from None
    if not isinstance(payload, dict):
        raise FollowSmokeRequestInvalid()
    return payload


def _uuid_or_raise(value: object, name: str) -> UUID:
    if not isinstance(value, str):
        raise MemoryRequestInvalid()
    try:
        return UUID(value)
    except ValueError:
        raise MemoryRequestInvalid() from None


def _manual_entry_or_raise(payload: dict[str, object]) -> dict[str, object]:
    """解析 {text, category, topic?}；校验失败抛 MemoryRequestInvalid。"""

    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise MemoryRequestInvalid()
    category_value = payload.get("category")
    if not isinstance(category_value, str):
        raise MemoryRequestInvalid()
    try:
        category = MemoryCategory(category_value)
    except ValueError:
        raise MemoryRequestInvalid() from None
    topic = MemoryTopic.OTHER
    topic_value = payload.get("topic")
    if topic_value is not None:
        if not isinstance(topic_value, str):
            raise MemoryRequestInvalid()
        try:
            topic = MemoryTopic(topic_value)
        except ValueError:
            raise MemoryRequestInvalid() from None
    return {"text": text, "category": category, "topic": topic}


def _optional_category(value: object) -> MemoryCategory | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise MemoryRequestInvalid()
    try:
        return MemoryCategory(value)
    except ValueError:
        raise MemoryRequestInvalid() from None


def _path_tail(path: str, prefix: str, suffix: str) -> str:
    return path[len(prefix): -len(suffix)] if path.endswith(suffix) else ""


def _owner_memory_payload(memory: OwnerMemory) -> dict[str, object]:
    return {
        "memory_id": str(memory.memory_id),
        "level": "owner",
        "text": memory.text,
        "category": memory.category.value,
        "topic": memory.topic.value,
        "adoption_method": memory.adoption_method.value,
        "status": memory.status.value,
        "valid_at": _iso_or_none(memory.valid_at),
        "invalid_at": _iso_or_none(memory.invalid_at),
    }


def _memory_payload(memory: ConfirmedMemory) -> dict[str, object]:
    return {
        "memory_id": str(memory.memory_id),
        "level": "contact",
        "contact_id": str(memory.scope.contact_id),
        "text": memory.text,
        "category": memory.category.value,
        "topic": memory.topic.value,
        "adoption_method": memory.adoption_method.value,
        "status": memory.status.value,
        "revision": memory.revision,
        "valid_at": _iso_or_none(memory.valid_at),
        "invalid_at": _iso_or_none(memory.invalid_at),
    }


def _iso_or_none(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _memory_candidate_payload(candidate: MemoryCandidate) -> dict[str, object]:
    return {
        "candidate_id": str(candidate.candidate_id),
        "text": candidate.text,
        "category": candidate.category.value,
        "topic": candidate.topic.value,
        "status": candidate.status.value,
    }
