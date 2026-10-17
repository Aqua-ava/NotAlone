"""常驻本地后端服务的 HTTP 应用与回环服务器。"""

from __future__ import annotations

from notalone.reply.errors import (
    ReplyBudgetError, ReplyCandidatesRejectedError, ReplyError, ReplyProviderContextLimitError, ReplyTimeoutError,
)
from notalone.reply.input_budget import InputBudgetExceededError, InputBudgetUnavailableError

import json
import logging
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping
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
from notalone.application.assistant_message_adoption import parse_assistant_reply_request
from notalone.application.source_service import SourceService
from notalone.application.style_sample_service import StyleSampleService
from notalone.persistence.style_sample_store import PostgresStyleSampleStore
from notalone.server.style_samples import handle_style_samples
from notalone.application.expression_preference_service import ExpressionPreferenceService
from notalone.persistence.expression_preferences import PostgresExpressionPreferenceStore
from notalone.server.expression_preferences import handle_expression_preferences
from notalone.server.reply_exploration import handle_exploration
from notalone.persistence.source_tasks import SourceDeletionHistoryUnverified
from notalone.persistence.source_deletion import SourceDeletionError, SourceNotFoundError
from notalone.persistence.background_tasks import (
    BackgroundTaskNotFoundError,
    BackgroundTaskPersistenceError,
    BackgroundTaskStateError,
    PostgresBackgroundTaskRepository,
)
from notalone.application.reply_service import ReplyService, ReplyServiceRequest
from notalone.application.assistant_session_service import (
    AssistantSessionConflict,
    AssistantSessionError,
    AssistantSessionNotFound,
    AssistantSessionPersistenceError,
    AssistantSessionRejected,
    AssistantSessionService,
    AssistantTurn,
)
from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
from notalone.server.assistant_preparation_rejection import preparation_rejection_payload
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.assistant_continuation import PostgresAssistantContinuationStore
from notalone.server.assistant_continuation import handle_continuation
from notalone.server.assistant_interrupted_recovery import handle_interrupted_recovery
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.assistant_candidate_versions import (
    AssistantCandidateVersions, PostgresAssistantCandidateVersions,
)
from notalone.server.assistant_candidate_versions import candidate_versions_path, handle_candidate_versions
from notalone.server.assistant_candidate_carry import parse_candidate_carry_request
from notalone.server.assistant_generation_lifecycle import generation_lifecycle_path, handle_generation_lifecycle
from notalone.application.reply_evidence import ReplyEvidenceService, ReplyEvidenceIncomplete
from notalone.reply.errors import (
    ReplyStoreInvariantError, ReplyPersistenceError, ReplyInProgressError,
    ReplyIdempotencyConflictError,
    ReplyInputInvalidatedError, ReplyContinuationError, ReplyExpressionPreferencesChangedError,
)
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.scopes import ContactScope
from notalone.application.import_service import (
    ImportService,
    TaskHost,
)
from notalone.application.task_service import TaskService
from notalone.tasks.models import ExtractionRuntimeMode
from notalone.application.trace_service import TraceService
from notalone.managed_update_backups import ManagedUpdateBackupError
from notalone.application.model_priority import ModelWorkStopped
from notalone.application.setup_service import OwnerAlreadyConfigured, SetupService
from notalone.application.skill_service import (
    LedgerService,
    SkillImportRejected,
    SkillService,
)
from notalone.application.skill_learning import SkillLearningService
from notalone.persistence.skill_learning import PostgresSkillLearningStore
from notalone.server.skill_learning import handle_skill_learning
from notalone.server.memory_upgrade import handle_memory_upgrade
from notalone.ingest.errors import ImportContentChangedError, ImportPreviewError
from notalone.ingest.import_command import ContactConfirmationError
from notalone.persistence.postgres_repository import (
    ChannelIdentityConflictError,
    ContactNotFoundError,
    ImportPersistenceError,
    OwnerChannelIdentityConflictError,
    OwnerChannelIdentityNotFoundError,
)
from notalone.persistence.source_processing import SourceProcessingWriteError
from notalone.persistence.conversation_repository import (
    ConversationBindingConflictError,
    ConversationBindingNotFoundError,
    PersistedConversationBinding,
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
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.models import (
    ConfirmedMemory,
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.memory.versions import MemoryVersionConflict
from notalone.application.relationship_overview_service import RelationshipOverviewService
from notalone.memory.overview import OverviewUnavailable
from notalone.memory.layered import LayeredMemoryConflict
from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.server.memory_overview import overview_payload
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
from notalone.server.sync_host import SyncControlPort, SyncHostBusy, SyncHostStopped


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
        "_assistant_sessions",
        "_candidate_versions",
        "_contact_directory",
        "_events",
        "_follow_smoke",
        "_import_service",
        "_ledger_service",
        "_memory_service",
        "_overview_service",
        "_layered_memory",
        "_message_stream",
        "_owner_id",
        "_reply_service",
        "_reply_evidence",
        "_runtime_shutdown",
        "_runtime_shutdown_lock",
        "_runtime_stopping",
        "_runtime_stopped",
        "_source_service",
        "_setup_service",
        "_skill_service",
        "_skill_learning",
        "_memory_upgrades",
        "_style_samples",
        "_expression_preferences",
        "_sync_control",
        "_task_host",
        "_task_service",
        "_trace_service",
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
        assistant_sessions: AssistantSessionService | None = None,
        candidate_versions: AssistantCandidateVersions | None = None,
        reply_evidence: ReplyEvidenceService | None = None,
        source_service: SourceService | None = None,
        memory_service: MemoryService | None = None,
        overview_service: RelationshipOverviewService | None = None,
        layered_memory: LayeredMemoryService | None = None,
        import_service: ImportService | None = None,
        task_host: TaskHost | None = None,
        task_service: TaskService | None = None,
        trace_service: TraceService | None = None,
        skill_service: SkillService | None = None,
        skill_learning: SkillLearningService | None = None,
        memory_upgrades=None,
        ledger_service: LedgerService | None = None,
        setup_service: SetupService | None = None,
        style_samples: StyleSampleService | None = None,
        expression_preferences: ExpressionPreferenceService | None = None,
        runtime_shutdown: Callable[[], None] | None = None,
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
        self._overview_service = overview_service
        self._layered_memory = layered_memory
        self._message_stream = message_stream
        self._reply_service = reply_service
        self._assistant_sessions = assistant_sessions
        self._candidate_versions = candidate_versions
        self._reply_evidence = reply_evidence
        self._style_samples = style_samples
        self._expression_preferences = expression_preferences
        self._runtime_shutdown = runtime_shutdown
        self._runtime_shutdown_lock = threading.Lock()
        self._runtime_stopping = threading.Event()
        self._runtime_stopped = threading.Event()
        self._source_service = source_service
        self._owner_id = owner_id
        self._setup_service = setup_service
        self._skill_service = skill_service
        self._skill_learning = skill_learning
        self._memory_upgrades = memory_upgrades
        self._sync_control = sync_control
        self._task_host = task_host
        self._task_service = task_service
        self._trace_service = trace_service
        self._token = token

    @property
    def token(self) -> str:
        """返回供父进程交给界面的连接 token。"""

        return self._token

    @property
    def events(self) -> EventBus:
        """返回供同步引擎和任务执行器发布事件的总线。"""

        return self._events

    def shutdown_runtime(self) -> None:
        """HTTP、信号与公开服务器关闭共用同一次资源收尾。"""

        self._runtime_stopping.set()
        with self._runtime_shutdown_lock:
            if self._runtime_stopped.is_set():
                return
            if self._runtime_shutdown is not None:
                self._runtime_shutdown()
            if self._layered_memory is not None:
                self._layered_memory.stop()
            if self._task_host is not None:
                self._task_host.stop()
            self._runtime_stopped.set()

    def handle(
        self,
        *,
        method: str,
        path: str,
        headers: Mapping[str, str] | None = None,
        body: bytes = b"",
    ) -> Response:
        response = self._handle_request(
            method=method, path=path, headers=headers, body=body
        )
        path_value = urlsplit(path).path
        if (200 <= response.status_code < 300 and method in {'POST', 'PATCH'}
                and '/assistant-session' in path_value and self._skill_learning is not None):
            parts = path_value.strip('/').split('/')
            if len(parts) >= 4 and parts[:2] == ['api', 'contacts']:
                try:
                    self._skill_learning.notify(ContactScope(self._owner_id, UUID(parts[2])))
                except Exception:
                    # 已提交的用户操作不因后续整理调度失败而返回失败；权威读取可恢复。
                    logging.getLogger(__name__).warning('skill_learning_schedule_failed')
        if (_is_trace_path(path) or "/assistant-session" in path_value
                or path_value == "/api/expression-preferences"
                or path_value.startswith("/api/expression-preferences/")
                or path_value.startswith("/api/memories/")
                or path_value == "/api/memories/owner"
                or path_value.startswith("/api/contacts/") and (
                    "/memories" in path_value or "/memory-candidates" in path_value
                    or "/relationship-overview" in path_value or "/layered-memory" in path_value
                )):
            return Response(
                response.status_code,
                {**response.headers, "Cache-Control": "no-store"},
                response.body,
            )
        return response

    def _handle_request(
        self,
        *,
        method: str,
        path: str,
        headers: Mapping[str, str] | None = None,
        body: bytes = b"",
    ) -> Response:
        """处理一个请求；不把 token 或请求正文写入错误响应。

        已认证后的分发整体兜底：任何未预期异常（畸形输入触发的
        ValueError/RecursionError、装配层错误等）返回稳定 500，不把
        内部细节写进响应，也不让 HTTP 线程以无响应关闭收场。
        """

        request_body = bytes(body)
        request_headers = headers or {}
        if not self._authorized(request_headers):
            return _json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        from notalone.application.manual_input_scope import manual_input_contact
        manual_value = _header_value(request_headers, "X-NotAlone-Manual-Contact")
        try:
            manual_id = UUID(manual_value) if manual_value else None
            # 只有具名回复／助手端点使用手动范围；同步端点始终要求真实渠道绑定。
            if manual_id is not None and not urlsplit(path).path.startswith(f"/api/contacts/{manual_id}/assistant-session"):
                raise ValueError()
        except (ValueError, TypeError):
            return _json_response(HTTPStatus.BAD_REQUEST, {"error": "manual_scope_invalid"})
        manual_token = manual_input_contact.set(manual_id)
        try:
            return self._handle_authenticated(
                method=method,
                path=path,
                headers=request_headers,
                body=request_body,
            )
        except ManagedUpdateBackupError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "update_backup_cleanup_required"})
        except (SyncHostStopped, ModelWorkStopped):
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "runtime_stopping"}
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "internal_error"},
            )
        finally:
            manual_input_contact.reset(manual_token)

    def _handle_authenticated(
        self,
        *,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> Response:
        request_body = bytes(body)
        request_headers = headers
        method_upper = method.upper()
        path_value = urlsplit(path).path
        if method_upper == "GET" and path_value == "/api/runtime/status":
            state = (
                "stopped" if self._runtime_stopped.is_set()
                else "stopping" if self._runtime_stopping.is_set() else "running"
            )
            return _json_response(HTTPStatus.OK, {"state": state})
        if method_upper == "POST" and path_value == "/api/runtime/shutdown":
            if self._runtime_shutdown is None:
                return _json_response(
                    HTTPStatus.SERVICE_UNAVAILABLE, {"error": "runtime_unavailable"}
                )
            # 只关闭本次读取资源，不调用 disable，不修改持久同步偏好。
            self.shutdown_runtime()
            return _json_response(HTTPStatus.OK, {"state": "stopped"})
        if self._runtime_stopping.is_set() and not (
            method_upper == "GET"
            and path_value in {"/api/sync/status", "/api/setup/status"}
        ):
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "runtime_stopping"}
            )
        if (
            self._owner_id is None
            and not path_value.startswith("/api/setup")
            and path_value != "/api/settings/credentials"
        ):
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "owner_uninitialized"},
            )
        if method_upper == "POST" and (path_value == "/api/contacts" or path_value.endswith("/manual-confirmation")):
            try:
                payload = json.loads(request_body)
                if path_value == "/api/contacts":
                    if not isinstance(payload, dict) or set(payload) != {"request_id", "display_name"}:
                        raise ValueError()
                    contact = self._contact_directory.create_contact(
                        self._owner_id, UUID(payload["request_id"]), payload["display_name"],
                    )
                    return _json_response(HTTPStatus.CREATED, {"contact": _contact_payload(contact)})
                parts = path_value.split("/")
                if len(parts) != 5 or parts[1:3] != ["api", "contacts"] or payload != {}:
                    raise ValueError()
                self._contact_directory.confirm_manual(self._owner_id, UUID(parts[3]))
                return _json_response(HTTPStatus.OK, {"confirmed": True})
            except (ValueError, TypeError, KeyError):
                return _json_response(HTTPStatus.BAD_REQUEST, {"error": "contact_input_invalid"})
            except ContactDirectoryError:
                return _json_response(HTTPStatus.CONFLICT, {"error": "contact_operation_unavailable"})
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
        if _is_trace_path(path_value):
            return self._handle_trace(
                method=method_upper,
                path=path_value,
                query=urlsplit(path).query,
            )
        if (path_value.startswith("/api/contacts/") and "/layered-memory" in path_value
                or path_value.startswith("/api/memories/owner/layered-memory")):
            return self._handle_layered_memory(method=method_upper, path=path, body=body)
        if path_value.startswith("/api/contacts/") and "/relationship-overview" in path_value:
            return self._handle_overview(method=method_upper, path=path_value)
        if path_value == "/api/memories/owner/overview":
            return self._handle_overview(method=method_upper, path=path_value)
        if path_value == "/api/expression-preferences" or path_value.startswith("/api/expression-preferences/"):
            if self._expression_preferences is None:
                return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "expression_preference_unavailable"})
            status, payload = handle_expression_preferences(
                self._expression_preferences, owner_id=self._owner_id,
                method=method_upper, path=path_value, body=request_body, query=urlsplit(path).query,
            )
            return _json_response(status, payload)
        if path_value.startswith('/api/contacts/') and '/skill-learning' in path_value:
            status, payload = handle_skill_learning(self._skill_learning, owner_id=self._owner_id,
                                                    method=method_upper, path=path_value, body=request_body)
            return _json_response(status, payload, headers={"Cache-Control": "no-store"})
        if path_value == '/api/memory-upgrades' or path_value.startswith('/api/memory-upgrades/'):
            status, payload = handle_memory_upgrade(self._memory_upgrades, owner_id=self._owner_id,
                method=method_upper, path=path_value, query=urlsplit(path).query, body=request_body)
            return _json_response(status, payload, headers={'Cache-Control': 'no-store'})
        if path_value.startswith("/api/contacts/") and "/style-samples" in path_value:
            if self._style_samples is None:
                return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "style_sample_unavailable"})
            status, payload = handle_style_samples(self._style_samples, owner_id=self._owner_id,
                                                   method=method_upper, path=path_value, body=request_body)
            return _json_response(status, payload)
        if path_value.startswith("/api/contacts/") and path_value.endswith("/messages"):
            return self._handle_messages(
                method=method_upper,
                path=path_value,
                query=urlsplit(path).query,
            )
        if path_value.startswith("/api/contacts/") and path_value.endswith("/evidence"):
            return self._handle_reply_evidence(method_upper, path_value)
        if path_value.startswith("/api/contacts/") and "/assistant-session" in path_value:
            return self._handle_assistant_session(method_upper, path_value, request_body, urlsplit(path).query)
        if path_value.startswith("/api/contacts/") and "/sources" in path_value:
            return self._handle_sources(method_upper, path_value)
        if path_value == "/api/reply/explore":
            return self._handle_reply_explore(method=method_upper, body=request_body)
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
            "/api/sync/foreground/observe",
            "/api/sync/priority",
            "/api/sync/backfill/pause",
            "/api/sync/backfill/retry",
            "/api/sync/confirm",
            "/api/sync/confirm-pending",
            "/api/sync/cli-sessions",
            "/api/sync/cli-bindings",
            "/api/sync/cli-bindings/revoke",
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
        if path == "/api/sync/cli-bindings":
            if method != "GET":
                return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            try:
                bindings = sync.cli_bindings()
            except Exception:
                return _json_response(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "cli_bindings_failed"},
                )
            return _json_response(
                HTTPStatus.OK,
                {"bindings": [_cli_binding_payload(binding) for binding in bindings]},
            )
        if method != "POST":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        if path == "/api/sync/foreground/observe":
            return self._handle_foreground_observe(sync=sync, body=body)
        if path == "/api/sync/priority":
            return self._handle_sync_priority(sync=sync, body=body)
        if path == "/api/sync/cli-bindings/confirm":
            return self._handle_cli_bindings_confirm(sync=sync, body=body)
        if path == "/api/sync/cli-bindings/revoke":
            return self._handle_cli_binding_revoke(sync=sync, body=body)
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
            elif path == "/api/sync/backfill/pause":
                report = sync.pause_backfill()
            elif path == "/api/sync/backfill/retry":
                report = sync.retry_backfill()
            else:
                report = sync.check()
        except Exception:
            # 稳定错误码，不把引擎异常细节回显给界面。
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "sync_control_failed"}
            )
        return _json_response(HTTPStatus.OK, _sync_status_payload(report))

    def _handle_foreground_observe(
        self, *, sync: SyncControlPort, body: bytes,
    ) -> Response:
        """固定运行身份的一次只读观察，不接受调用方范围或采集参数。"""

        try:
            payload = json.loads(body.decode("utf-8"))
            if not isinstance(payload, dict) or payload:
                raise ValueError
        except (UnicodeDecodeError, TypeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "foreground_observation_invalid"},
            )
        try:
            observation = sync.observe_foreground()
        except SyncHostBusy:
            return _json_response(
                HTTPStatus.CONFLICT, {"error": "foreground_observation_busy"},
            )
        except SyncHostStopped:
            return _json_response(HTTPStatus.CONFLICT, {"error": "runtime_stopped"})
        except Exception:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "foreground_observation_unavailable"},
            )
        result = {
            "observation_id": str(observation.observation_id),
            "observed_at": observation.observed_at.isoformat(),
            "phase": observation.phase,
            "reason": observation.reason,
            "probe_available": observation.probe_available,
            "wechat_in_front": observation.wechat_in_front,
            "binding_id": str(observation.binding_id) if observation.binding_id else None,
            "contact_id": str(observation.contact_id) if observation.contact_id else None,
        }
        if observation.recognized_name is not None:
            result.update(recognized_name=observation.recognized_name,
                          recognition_confidence=observation.recognition_confidence)
        return _json_response(HTTPStatus.OK, result)

    def _handle_cli_binding_revoke(
        self, *, sync: SyncControlPort, body: bytes,
    ) -> Response:
        """撤销读取授权，保留既有绑定记录和历史资料。"""

        try:
            payload = json.loads(body.decode("utf-8"))
            if (
                not isinstance(payload, dict)
                or set(payload) != {"contact_id", "binding_id"}
            ):
                raise ValueError
            if not all(isinstance(payload[key], str) for key in payload):
                raise ValueError
            contact_id = UUID(payload["contact_id"])
            binding_id = UUID(payload["binding_id"])
        except (UnicodeDecodeError, TypeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "cli_binding_revoke_invalid"},
            )
        try:
            binding = sync.revoke_cli_binding(
                contact_id=contact_id, binding_id=binding_id,
            )
        except ConversationBindingNotFoundError:
            return _json_response(
                HTTPStatus.NOT_FOUND, {"error": "cli_binding_not_found"},
            )
        except SyncHostBusy:
            return _json_response(
                HTTPStatus.CONFLICT, {"error": "cli_binding_revoke_busy"},
            )
        except SyncHostStopped:
            return _json_response(HTTPStatus.CONFLICT, {"error": "runtime_stopped"})
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "cli_binding_revoke_failed"},
            )
        return _json_response(HTTPStatus.OK, _cli_binding_payload(binding))

    def _handle_sync_priority(
        self,
        *,
        sync: SyncControlPort,
        body: bytes,
    ) -> Response:
        """记录当前应用查看联系人，供后台下一轮读取时优先处理。"""

        try:
            payload = json.loads(body.decode("utf-8")) if body.strip() else {}
        except (UnicodeDecodeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "sync_priority_request_invalid"},
            )
        if not isinstance(payload, dict) or "contact_id" not in payload:
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "sync_priority_request_invalid"},
            )
        raw_contact_id = payload["contact_id"]
        if raw_contact_id is None:
            contact_id = None
        elif isinstance(raw_contact_id, str):
            try:
                contact_id = UUID(raw_contact_id)
            except ValueError:
                return _json_response(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "sync_priority_request_invalid"},
                )
        else:
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "sync_priority_request_invalid"},
            )
        try:
            report = sync.set_priority_contact(contact_id)
        except (TypeError, ValueError):
            return _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "sync_priority_request_invalid"},
            )
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "sync_priority_failed"},
            )
        if report is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "sync_status_unavailable"},
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
                observed_display_name = raw.get("observed_display_name")
                if observed_display_name is not None and (
                    not isinstance(observed_display_name, str)
                    or not observed_display_name.strip()
                ):
                    raise ValueError
                selections.append(
                    CliBindingSelection(
                        locator=locator,
                        contact_id=contact_id,
                        display_name=display_name,
                        observed_display_name=observed_display_name,
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

    def _handle_trace(self, *, method: str, path: str, query: str) -> Response:
        owner_id = self._owner_id
        if owner_id is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "owner_uninitialized"},
            )
        parts = path.strip("/").split("/")
        if (
            len(parts) < 4
            or parts[:2] != ["api", "contacts"]
            or parts[3] not in {"memory-traces", "source-processing-traces"}
        ):
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        try:
            scope = ContactScope(owner_id, UUID(parts[2]))
            service = self._trace_service
            if service is None:
                return _json_response(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "trace_unavailable"},
                )
            if len(parts) == 4 and method == "GET":
                values = parse_qs(query, keep_blank_values=True)
                if set(values) - {"limit", "before"} or any(
                    len(items) != 1 for items in values.values()
                ):
                    raise ValueError
                limit = int(values.get("limit", ["100"])[0])
                before = (
                    UUID(values["before"][0]) if "before" in values else None
                )
                payload = service.list_batches(
                    scope, parts[3], limit=limit, before=before
                )
            elif len(parts) == 5 and method in {"GET", "DELETE"} and not query:
                batch_id = UUID(parts[4])
                if method == "GET":
                    payload = service.get_batch(scope, parts[3], batch_id)
                else:
                    payload = service.delete_batch(scope, parts[3], batch_id)
            elif (
                len(parts) == 7
                and parts[4] == "records"
                and method == "GET"
                and not query
            ):
                payload = service.find_record(
                    scope, parts[3], parts[5], UUID(parts[6])
                )
            else:
                return _json_response(
                    HTTPStatus.NOT_FOUND, {"error": "not_found"}
                )
        except LookupError:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        except (ValueError, TypeError):
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "trace_request_invalid"}
            )
        except ManagedUpdateBackupError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "update_backup_cleanup_required"})
        except Exception:
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "trace_operation_failed"},
            )
        return _json_response(HTTPStatus.OK, payload)

    def _handle_sources(self, method: str, path: str) -> Response:
        parts = path.strip("/").split("/")
        is_list = len(parts) == 4 and method == "GET"
        is_delete = len(parts) == 5 and method == "DELETE"
        if len(parts) < 4 or parts[3] != "sources" or not (is_list or is_delete):
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        try:
            contact_id = UUID(parts[2])
            source_id = UUID(parts[4]) if is_delete else None
        except ValueError:
            return _json_response(HTTPStatus.BAD_REQUEST, {"error": "invalid_scope"})
        if self._source_service is None:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "sources_unavailable"})
        try:
            if is_list:
                payload = {"sources": self._source_service.list_sources(self._owner_id, contact_id)}
            else:
                payload = self._source_service.delete(self._owner_id, contact_id, source_id)
        except SourceNotFoundError:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        except SourceDeletionHistoryUnverified:
            return _json_response(HTTPStatus.CONFLICT, {"error": "legacy_deletion_unverified"})
        except (SourceDeletionError, BackgroundTaskPersistenceError):
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "source_state_unavailable"})
        return _json_response(HTTPStatus.OK if is_list else HTTPStatus.ACCEPTED,
                              payload, headers={"Cache-Control": "no-store"})

    def _handle_reply_evidence(self, method: str, path: str) -> Response:
        parts = path.strip("/").split("/")
        if method != "GET" or len(parts) != 6 or parts[3] != "replies":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        try:
            contact_id, request_id = UUID(parts[2]), UUID(parts[4])
        except ValueError:
            return _json_response(HTTPStatus.BAD_REQUEST, {"error": "invalid_scope"})
        if self._reply_evidence is None:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "evidence_unavailable"})
        try:
            payload = self._reply_evidence.read(
                request_id, ContactScope(self._owner_id, contact_id),
            )
        except ReplyStoreInvariantError:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        except ReplyEvidenceIncomplete:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_incomplete"})
        except ReplyPersistenceError:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "evidence_unavailable"})
        return _json_response(HTTPStatus.OK, payload, headers={"Cache-Control": "no-store"})

    def _handle_reply_explore(self, *, method: str, body: bytes) -> Response:
        """只返回短任务理解和方向；不调用候选生成器。"""

        if method != "POST":
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        if self._reply_service is None:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "reply_unavailable"})
        return _json_response(HTTPStatus.CONFLICT, {"error": "exploration_protocol_changed"})

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
        except ReplyInputInvalidatedError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_input_invalidated"})
        except ReplyContinuationError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_continuation_invalid"})
        except ReplyExpressionPreferencesChangedError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "expression_preferences_changed"})
        except ReplyIdempotencyConflictError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_input_conflict"})
        except ModelWorkStopped:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "runtime_stopping"}
            )
        except ReplyTimeoutError:
            return _json_response(
                HTTPStatus.GATEWAY_TIMEOUT, {"error": "reply_timeout"}
            )
        except ReplyBudgetError:
            return _json_response(
                HTTPStatus.BAD_GATEWAY, {"error": "reply_budget_exceeded"}
            )
        except ReplyProviderContextLimitError as error:
            return _json_response(HTTPStatus.CONFLICT, {
                "error": "provider_context_limit", "message": str(error),
            })
        except ReplyCandidatesRejectedError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_candidates_rejected"})
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

    def _handle_assistant_session(self, method: str, path: str, body: bytes, query: str = "") -> Response:
        """默认讨论、单次提交与显式读取；不提供自动恢复或发送能力。"""

        parts = path.strip("/").split("/")
        if len(parts) in (6, 7) and parts[5] == "retry-interrupted":
            recovery_owner = self._owner_id
            if recovery_owner is None:
                return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "owner_uninitialized"})
            status, payload = handle_interrupted_recovery(
                self._assistant_sessions, owner_id=recovery_owner, method=method, path=path, body=body,
                render_turn=_completed_turn_payload,
            )
            return _json_response(HTTPStatus(status), payload, headers={"Cache-Control": "no-store"})
        if len(parts) in (6, 7) and parts[5] == "continue":
            continuation_owner = self._owner_id
            if continuation_owner is None:
                return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "owner_uninitialized"})
            status, payload = handle_continuation(
                self._assistant_sessions, owner_id=continuation_owner, method=method, path=path, body=body,
                render_turn=_completed_turn_payload,
            )
            return _json_response(HTTPStatus(status), payload, headers={"Cache-Control": "no-store"})
        if generation_lifecycle_path(parts) is not None:
            interruption_owner = self._owner_id
            if interruption_owner is None:
                return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "owner_uninitialized"})
            interruption_status, interruption_payload = handle_generation_lifecycle(
                self._assistant_sessions, owner_id=interruption_owner, method=method, path=path, body=body,
            )
            return _json_response(interruption_status, interruption_payload, headers={"Cache-Control": "no-store"})
        if candidate_versions_path(parts) is not None:
            status, payload = handle_candidate_versions(
                self._candidate_versions, owner_id=self._owner_id,
                method=method, path=path, body=body, query=query,
            )
            return _json_response(status, payload, headers={"Cache-Control": "no-store"})
        service = self._assistant_sessions
        if service is None:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "assistant_session_unavailable"})
        if len(parts) >= 6 and parts[5] == "explorations":
            status, payload = handle_exploration(
                self._reply_service.exploration if self._reply_service is not None else None,
                owner_id=self._owner_id, method=method, path=path, body=body, render_turn=_completed_turn_payload,
            )
            return _json_response(status, payload, headers={"Cache-Control": "no-store"})
        try:
            contact_id = UUID(parts[2])
            if parts[3:] == ["assistant-session", "default"] and method == "POST":
                session_id = service.default(owner_id=self._owner_id, contact_id=contact_id)
                return _json_response(HTTPStatus.OK, {"session_id": str(session_id)})
            if parts[3:] == ["assistant-sessions"] and method == "POST":
                if json.loads(body.decode("utf-8")) != {}:
                    raise ReplyRequestInvalid()
                session_id = service.new(owner_id=self._owner_id, contact_id=contact_id)
                return _json_response(HTTPStatus.OK, {"session_id": str(session_id)})
            if parts[3:] == ["assistant-sessions"] and method == "GET":
                sessions = service.list_sessions(owner_id=self._owner_id, contact_id=contact_id)
                return _json_response(HTTPStatus.OK, {
                    "sessions": [{"session_id": str(item.session_id), "is_current": item.is_current}
                                 for item in sessions],
                    "current_session_id": next((str(item.session_id) for item in sessions if item.is_current), None),
                })
            if (len(parts) == 7 and parts[3] == "assistant-sessions"
                    and parts[5:] == ["replies", "prepare"]):
                if method != "POST":
                    return _json_response(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})
                prepare_owner = self._owner_id
                if prepare_owner is None:
                    return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "owner_uninitialized"})
                session_id = UUID(parts[4])
                body_contact, request = parse_assistant_reply_request(body)
                if body_contact != contact_id:
                    raise ReplyRequestInvalid()
                receipt = service.prepare(
                    owner_id=prepare_owner, contact_id=contact_id,
                    session_id=session_id, request=request,
                )
                return _json_response(HTTPStatus.OK, {
                    "session_id": str(receipt.session_id), "turn_id": str(receipt.turn_id),
                    "request_key": str(receipt.request_key),
                    "input_version_id": str(receipt.input_version_id), "state": receipt.state,
                }, headers={"Cache-Control": "no-store"})
            if (len(parts) == 7 and parts[3] == "assistant-sessions"
                    and parts[5:] == ["replace", "prepare"]):
                if method != "POST":
                    return _json_response(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})
                replacement_owner = self._owner_id
                if replacement_owner is None:
                    return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "owner_uninitialized"})
                session_id = UUID(parts[4])
                running_request_key, body_contact, request = _parse_assistant_replacement_request(body)
                if body_contact != contact_id:
                    raise ReplyRequestInvalid()
                receipt = service.prepare_replacement(
                    owner_id=replacement_owner, contact_id=contact_id, session_id=session_id,
                    running_request_key=running_request_key, request=request,
                )
                return _json_response(HTTPStatus.OK, {
                    "session_id": str(receipt.session_id), "turn_id": str(receipt.turn_id),
                    "request_key": str(receipt.request_key),
                    "input_version_id": str(receipt.input_version_id), "state": receipt.state,
                }, headers={"Cache-Control": "no-store"})
            if len(parts) not in (5, 6) or parts[3] != "assistant-sessions":
                return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            session_id = UUID(parts[4])
            if len(parts) == 6 and parts[5] == "new-with-candidate":
                if method != "POST":
                    return _json_response(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})
                carried = service.new_with_candidate(
                    owner_id=self._owner_id, contact_id=contact_id, session_id=session_id,
                    command=parse_candidate_carry_request(body),
                )
                return _json_response(HTTPStatus.OK, {
                    "session_id": str(carried.session_id), "input_version_id": str(carried.input_version_id),
                }, headers={"Cache-Control": "no-store"})
            if len(parts) == 6 and parts[5] == "select" and method == "POST":
                if json.loads(body.decode("utf-8")) != {}:
                    raise ReplyRequestInvalid()
                selected = service.select(owner_id=self._owner_id, contact_id=contact_id, session_id=session_id)
                return _json_response(HTTPStatus.OK, {"session_id": str(selected)})
            if len(parts) == 5 and method == "DELETE":
                confirmation = json.loads(body.decode("utf-8"))
                if (not isinstance(confirmation, dict) or set(confirmation) != {"confirmed"}
                        or confirmation["confirmed"] is not True):
                    raise ReplyRequestInvalid()
                service.delete(owner_id=self._owner_id, contact_id=contact_id, session_id=session_id)
                return _json_response(HTTPStatus.OK, {"session_id": str(session_id), "state": "deleted"})
            if len(parts) == 5 and method == "GET":
                from notalone.server.assistant_session_read import (
                    AssistantSessionReadChanged, assistant_session_read_fragment,
                    parse_assistant_session_read_query,
                )
                read_part = parse_assistant_session_read_query(query)
                snapshot = service.read_session(owner_id=self._owner_id, contact_id=contact_id, session_id=session_id)
                response = _json_response(HTTPStatus.OK, {
                    "session_id": str(session_id),
                    "current_input_version_id": (str(snapshot.current_input_version_id)
                                                  if snapshot.current_input_version_id is not None else None),
                    "turns": [_assistant_turn_payload(turn) for turn in snapshot.turns],
                    "inputs": [_assistant_input_payload(record) for record in snapshot.inputs],
                })
                if read_part is None:
                    return response
                try:
                    fragment = assistant_session_read_fragment(
                        response.body, session_id=session_id,
                        current_input_version_id=snapshot.current_input_version_id, request=read_part,
                    )
                except AssistantSessionReadChanged:
                    source_unavailable = any(turn.state in ("redacted", "unavailable") for turn in snapshot.turns) or any(
                        record.state in ("redacted", "unavailable") for record in snapshot.inputs
                    )
                    return _json_response(HTTPStatus.CONFLICT, {
                        "error": "assistant_session_read_changed",
                        **({"reason": "source_unavailable"} if source_unavailable else {}),
                    }, headers={"Cache-Control": "no-store"})
                return _json_response(HTTPStatus.OK, fragment, headers={"Cache-Control": "no-store"})
            if len(parts) == 6 and parts[5] == "inputs" and method == "POST":
                content, expected = _parse_assistant_discussion_request(body)
                version = service.record_discussion_input(
                    owner_id=self._owner_id, contact_id=contact_id, session_id=session_id,
                    content=content, expected_input_version_id=expected,
                )
                return _json_response(HTTPStatus.OK, {
                    "session_id": str(session_id), "input_version_id": str(version),
                })
            if len(parts) == 6 and parts[5] == "replies" and method == "POST":
                body_contact, request = parse_assistant_reply_request(body)
                if body_contact != contact_id:
                    raise ReplyRequestInvalid()
                turn = service.generate(
                    owner_id=self._owner_id, contact_id=contact_id,
                    session_id=session_id, request=request,
                )
                if turn.reply is None:
                    raise AssistantSessionPersistenceError("未保存完成结果。")
                return _json_response(HTTPStatus.OK, _completed_turn_payload(turn))
            if len(parts) == 6 and parts[5] == "replace" and method == "POST":
                replacement_owner = self._owner_id
                if replacement_owner is None:
                    return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "owner_uninitialized"})
                running_request_key, body_contact, request = _parse_assistant_replacement_request(body)
                if body_contact != contact_id:
                    raise ReplyRequestInvalid()
                turn = service.replace(
                    owner_id=replacement_owner, contact_id=contact_id, session_id=session_id,
                    running_request_key=running_request_key, request=request,
                )
                return _json_response(HTTPStatus.OK, _completed_turn_payload(turn))
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        except AssistantPreparationRejected as error:
            status, payload = preparation_rejection_payload(error)
            return _json_response(HTTPStatus(status), payload, headers={"Cache-Control": "no-store"})
        except (ValueError, IndexError, ReplyRequestInvalid):
            return _json_response(HTTPStatus.BAD_REQUEST, {"error": "assistant_session_request_invalid"})
        except AssistantSessionNotFound:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        except AssistantSessionConflict:
            return _json_response(HTTPStatus.CONFLICT, {"error": "assistant_session_input_conflict"})
        except AssistantSessionRejected as error:
            if error.reason == "reply_unavailable":
                return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "reply_unavailable"})
            return _json_response(HTTPStatus.CONFLICT, {"error": "assistant_session_rejected", "reason": error.reason})
        except ReplyInProgressError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "assistant_session_in_progress"})
        except ReplyInputInvalidatedError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_input_invalidated"})
        except ReplyContinuationError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_continuation_invalid"})
        except ReplyExpressionPreferencesChangedError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "expression_preferences_changed"})
        except ReplyIdempotencyConflictError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "assistant_session_input_conflict"})
        except (AssistantSessionPersistenceError, ReplyPersistenceError):
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "assistant_session_save_failed"})
        except InputBudgetExceededError as error:
            return _json_response(HTTPStatus.CONFLICT, {
                "error": "input_budget_exceeded", "input_budget": error.decision.to_payload(),
            })
        except InputBudgetUnavailableError as error:
            return _json_response(HTTPStatus.CONFLICT, {
                "error": "input_budget_unavailable", "input_budget": error.decision.to_payload(),
            })
        except ReplyProviderContextLimitError as error:
            return _json_response(HTTPStatus.CONFLICT, {
                "error": "provider_context_limit", "message": str(error),
            })
        except ReplyCandidatesRejectedError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "reply_candidates_rejected"})
        except ReplyTimeoutError:
            return _json_response(HTTPStatus.GATEWAY_TIMEOUT, {"error": "reply_timeout"})
        except ReplyBudgetError:
            return _json_response(HTTPStatus.BAD_GATEWAY, {"error": "reply_budget_exceeded"})
        except ReplyError:
            return _json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "reply_generation_failed"})
        except AssistantSessionError:
            return _json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "assistant_session_failed"})

    def _handle_layered_memory(self, *, method: str, path: str, body: bytes) -> Response:
        parts = urlsplit(path).path.strip("/").split("/")
        if (len(parts) not in {4, 5} or parts[3] != "layered-memory"
                or method != ("GET" if len(parts) == 4 else "POST")
                or len(parts) == 5 and parts[4] not in {"enable", "refresh", "disable", "delete", "withdraw-profile", "withdraw-scenario", "pause", "continue", "summary-error"}):
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        if self._layered_memory is None:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "layered_memory_unavailable"})
        try:
            from notalone.scopes import OwnerScope
            scope = OwnerScope(self._owner_id) if parts[:3] == ["api", "memories", "owner"] else ContactScope(self._owner_id, UUID(parts[2]))
            if method == "GET":
                query = parse_qs(urlsplit(path).query, keep_blank_values=True)
                if set(query) - {'mapping_cursor'} or any(len(value) != 1 for value in query.values()):
                    raise ValueError('映射分页参数无效。')
                state = self._layered_memory.read(scope, mapping_cursor=query.get('mapping_cursor', [None])[0])
            else:
                payload = json.loads(body.decode("utf-8"))
                allowed = ({"settings_generation", "purpose_confirmed"} if parts[4] == "enable"
                    else {"settings_generation", "organization_generation", "target_kind", "version_id", "item_index", "reason", "operation_id"} if parts[4] == "summary-error"
                    else {"settings_generation", "organization_generation", "profile_version_id"} if parts[4] == "withdraw-profile"
                    else {"settings_generation", "organization_generation", "scenario_version_id"} if parts[4] == "withdraw-scenario"
                    else {"settings_generation", "work_revision"} if parts[4] in {"pause", "continue"}
                    else {"settings_generation"})
                if (not isinstance(payload, dict) or set(payload) != allowed
                        or type(payload["settings_generation"]) is not int
                        or payload["settings_generation"] < 0
                        or parts[4] == "enable" and payload["purpose_confirmed"] is not True):
                    raise ValueError("整理命令无效。")
                if parts[4] in {"pause", "continue"} and (type(payload["work_revision"]) is not int or payload["work_revision"] < 1):
                    raise ValueError("覆盖工作修订无效。")
                if parts[4] == 'summary-error':
                    if (type(payload['organization_generation']) is not int or payload['organization_generation'] < 0
                            or payload['target_kind'] not in {'scenario', 'profile'}
                            or type(payload['item_index']) is not int or not 0 <= payload['item_index'] < 100
                            or not isinstance(payload['reason'], str) or not 1 <= len(payload['reason'].strip()) <= 500):
                        raise ValueError('整理反馈无效。')
                    UUID(payload['version_id'])
                    UUID(payload['operation_id'])
                    state = self._layered_memory.report_summary_error(scope, payload)
                elif parts[4] == "withdraw-scenario":
                    if type(payload["organization_generation"]) is not int or payload["organization_generation"] < 0:
                        raise ValueError("整理版本无效。")
                    state = self._layered_memory.withdraw_scenario(scope,payload["settings_generation"],
                        payload["organization_generation"],UUID(payload["scenario_version_id"]))
                elif parts[4] == "withdraw-profile":
                    if type(payload["organization_generation"]) is not int or payload["organization_generation"] < 0:
                        raise ValueError("整理版本无效。")
                    state = self._layered_memory.withdraw_profile(scope,payload["settings_generation"],
                        payload["organization_generation"],UUID(payload["profile_version_id"]))
                else:
                    state = self._layered_memory.command(scope, parts[4], payload["settings_generation"], payload.get("work_revision"))
            return _json_response(HTTPStatus.OK, {"layered_memory": state})
        except LayeredMemoryConflict:
            return _json_response(HTTPStatus.CONFLICT, {"error": "layered_memory_changed"})
        except (ValueError, UnicodeError):
            return _json_response(HTTPStatus.BAD_REQUEST, {"error": "layered_memory_request_invalid"})
        except (LookupError, PermissionError):
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "layered_memory_not_found"})
        except Exception:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "layered_memory_unavailable"})

    def _handle_overview(self, *, method: str, path: str) -> Response:
        parts = path.strip("/").split("/")
        owner_scope = path == "/api/memories/owner/overview"
        if method != "GET" or not owner_scope and (len(parts) != 4 or parts[3] != "relationship-overview"):
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        if self._overview_service is None:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "overview_unavailable"})
        try:
            if owner_scope:
                overview = self._overview_service.read_owner(owner_id=self._owner_id)
            else:
                scope_id = UUID(parts[2])
                overview = self._overview_service.read(owner_id=self._owner_id, contact_id=scope_id)
            return _json_response(HTTPStatus.OK, {"overview": overview_payload(
                overview, _owner_memory_payload if owner_scope else _memory_payload,
            )})
        except ValueError:
            return _json_response(HTTPStatus.BAD_REQUEST, {"error": "overview_request_invalid"})
        except (LookupError, PermissionError):
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "overview_not_found"})
        except OverviewUnavailable:
            return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "overview_unavailable"})
        except Exception:
            return _json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "overview_operation_failed"})

    def _handle_memory(self, *, method: str, path: str, body: bytes) -> Response:
        """处理记忆管理端点；失败关闭且不回显正文。"""

        service = self._memory_service
        if service is None:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "memory_unavailable"}
            )
        try:
            return self._dispatch_memory(method=method, path=path, body=body)
        except ManagedUpdateBackupError:
            return _json_response(HTTPStatus.CONFLICT, {"error": "update_backup_cleanup_required"})
        except MemoryRequestInvalid:
            return _json_response(
                HTTPStatus.BAD_REQUEST, {"error": "memory_request_invalid"}
            )
        except MemoryVersionConflict:
            return _json_response(HTTPStatus.CONFLICT, {"error": "memory_version_changed"},
                                  headers={"Cache-Control": "no-store"})
        except MemoryCorrectionConflictError:
            return _json_response(
                HTTPStatus.CONFLICT, {"error": "memory_correction_conflict"}
            )
        except (LookupError, PermissionError):
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "memory_not_found"})
        except Exception:
            # 持久化或领域层异常不能让真实 HTTP 连接直接断开；同时不把
            # SQL、连接信息或记忆正文泄露给客户端。
            return _json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "memory_operation_failed"},
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
        if method == "GET" and path.startswith("/api/memories/owner/") and path.endswith("/versions"):
            memory_id = _uuid_or_raise(_path_tail(path, "/api/memories/owner/", "/versions"), "memory_id")
            return _json_response(HTTPStatus.OK, {"versions": [
                _owner_memory_payload(memory) for memory in service.list_versions(
                    owner_id=owner_id, memory_id=memory_id,
                )
            ]}, headers={"Cache-Control": "no-store"})
        if method == "POST" and path.startswith("/api/memories/owner/") and path.endswith("/revert-auto-update"):
            memory_id = _uuid_or_raise(_path_tail(path, "/api/memories/owner/", "/revert-auto-update"), "memory_id")
            memory = service.revert_auto_update(owner_id=owner_id, memory_id=memory_id,
                                                expected_revision=_memory_revision_or_raise(body))
            return _json_response(HTTPStatus.OK, {"memory": _owner_memory_payload(memory)},
                                  headers={"Cache-Control": "no-store"})
        if method == "POST" and path.startswith("/api/memories/owner/") \
                and path.endswith("/correct"):
            memory_id = _uuid_or_raise(_path_tail(path, "/api/memories/owner/", "/correct"), "memory_id")
            payload = _parse_memory_json(body)
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                raise MemoryRequestInvalid()
            memory = service.correct_owner_memory(
                owner_id=owner_id, memory_id=memory_id, text=text,
                category=_optional_category(payload.get("category")),
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
        if method == "GET" and segment == "memories" and len(parts) == 4 and parts[3] == "versions":
            memory_id = _uuid_or_raise(parts[2], "memory_id")
            return _json_response(HTTPStatus.OK, {"versions": [
                _memory_payload(memory) for memory in service.list_versions(
                    owner_id=owner_id, contact_id=contact_id, memory_id=memory_id,
                )
            ]}, headers={"Cache-Control": "no-store"})
        if method == "POST" and segment == "memory-candidates" and len(parts) == 4:
            candidate_id = _uuid_or_raise(parts[2], "candidate_id")
            action = parts[3]
            if action == "apply-update":
                payload = _parse_memory_json(body)
                if not {"previous_memory_id", "expected_revision"} <= set(payload) or set(payload) - {
                    "previous_memory_id", "expected_revision", "correction_decision_ids",
                }:
                    raise MemoryRequestInvalid()
                previous_id = _uuid_or_raise(payload["previous_memory_id"], "previous_memory_id")
                revision = payload["expected_revision"]
                if type(revision) is not int or revision < 1:
                    raise MemoryRequestInvalid()
                expected = payload.get("correction_decision_ids")
                if expected is not None and not isinstance(expected, list):
                    raise MemoryRequestInvalid()
                decision_ids = (tuple(_uuid_or_raise(item, "correction_decision_ids") for item in expected)
                                if expected is not None else None)
                if decision_ids is not None and len(set(decision_ids)) != len(decision_ids):
                    raise MemoryRequestInvalid()
                memory = service.apply_candidate_update(
                    owner_id=owner_id, contact_id=contact_id, candidate_id=candidate_id,
                    previous_memory_id=previous_id, expected_revision=revision,
                    expected_correction_decision_ids=decision_ids,
                )
                return _json_response(HTTPStatus.OK, {"memory": _owner_memory_payload(memory)
                                      if isinstance(memory, OwnerMemory) else _memory_payload(memory)},
                                      headers={"Cache-Control": "no-store"})
            if action == "confirm":
                payload = _parse_memory_json(body) if body.strip() else {}
                expected = payload.get("correction_decision_ids")
                if expected is not None and not isinstance(expected, list):
                    raise MemoryRequestInvalid()
                decision_ids = (tuple(_uuid_or_raise(item, "correction_decision_ids") for item in expected)
                                if expected is not None else None)
                if decision_ids is not None and len(set(decision_ids)) != len(decision_ids):
                    raise MemoryRequestInvalid()
                memory = service.confirm_candidate(
                    owner_id=owner_id,
                    contact_id=contact_id,
                    candidate_id=candidate_id,
                    **({"expected_correction_decision_ids": decision_ids} if decision_ids is not None else {}),
                )
                return _json_response(
                    HTTPStatus.OK,
                    {
                        "memory": (
                            _owner_memory_payload(memory)
                            if isinstance(memory, OwnerMemory)
                            else _memory_payload(memory)
                        )
                    },
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
            if action == "revert-auto-update":
                memory = service.revert_auto_update(
                    owner_id=owner_id, contact_id=contact_id, memory_id=memory_id,
                    expected_revision=_memory_revision_or_raise(body),
                )
                return _json_response(HTTPStatus.OK, {"memory": _memory_payload(memory)},
                                      headers={"Cache-Control": "no-store"})
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
        needs_host = path == "/api/tasks/run" or (
            path == "/api/tasks/status"
            and "task_id" not in parse_qs(query, keep_blank_values=True)
        )
        needs_task = path.startswith("/api/tasks") and not needs_host
        if (
            (needs_import and self._import_service is None)
            or (needs_host and self._task_host is None)
            or (needs_task and self._task_service is None)
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
        except BackgroundTaskNotFoundError:
            return _json_response(HTTPStatus.NOT_FOUND, {"error": "task_not_found"})
        except BackgroundTaskStateError:
            return _json_response(
                HTTPStatus.CONFLICT, {"error": "task_retry_conflict"},
            )
        except BackgroundTaskPersistenceError:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE, {"error": "task_unavailable"},
            )
        except SourceProcessingWriteError:
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "source_processing_write_failed"},
                headers={"Cache-Control": "no-store"},
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
        task_service = self._task_service
        if owner_id is None:
            raise ImportTaskRequestInvalid()

        if path == "/api/imports/preview":
            if method != "POST" or import_service is None:
                raise ImportTaskRequestInvalid()
            payload = _parse_import_json(body)
            path_value = payload.get("path")
            if not isinstance(path_value, str) or not path_value.strip():
                raise ImportTaskRequestInvalid()
            contact_id = None
            if "contact_id" in payload:
                if not isinstance(payload["contact_id"], str):
                    raise ImportTaskRequestInvalid()
                try:
                    contact_id = UUID(payload["contact_id"])
                except ValueError:
                    raise ImportTaskRequestInvalid() from None
            try:
                preview = import_service.preview(
                    path=path_value,
                    owner_id=owner_id,
                    contact_id=contact_id,
                )
            except (
                ChannelIdentityConflictError,
                ContactNotFoundError,
                OwnerChannelIdentityConflictError,
                OwnerChannelIdentityNotFoundError,
            ):
                return _json_response(
                    HTTPStatus.UNPROCESSABLE_ENTITY,
                    {"error": "import_identity_conflict"},
                )
            except ImportPersistenceError:
                return _json_response(
                    HTTPStatus.UNPROCESSABLE_ENTITY,
                    {"error": "import_preview_failed", "reason": "preview_failed"},
                )
            except (
                FileNotFoundError, ImportPreviewError, OSError, PermissionError,
            ):
                # 文件缺失、不可读或内容校验失败：统一 422 + 稳定码，
                # 具体原因不进入响应（不泄露本机路径或文件内容）。
                return _json_response(
                    HTTPStatus.UNPROCESSABLE_ENTITY,
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
            expected_digest: str | None = None
            if "expected_content_sha256" in payload:
                digest_value = payload["expected_content_sha256"]
                if (
                    not isinstance(digest_value, str)
                    or len(digest_value) != 64
                    or any(
                        character not in "0123456789abcdef"
                        for character in digest_value
                    )
                ):
                    raise ImportTaskRequestInvalid()
                expected_digest = digest_value
            try:
                result = import_service.commit(
                    path=path_value,
                    owner_id=owner_id,
                    selection=selection,
                    expected_content_sha256=expected_digest,
                )
            except ImportContentChangedError:
                return _json_response(
                    HTTPStatus.CONFLICT, {"error": "import_file_changed"},
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
            task_identity: tuple[UUID, UUID] | None = None
            should_defer = task_host is None
            try:
                task_identity = (
                    UUID(str(result["contact_id"])), UUID(str(result["task_id"])),
                )
                if task_host is not None:
                    task_host.wake(
                        owner_id=owner_id, contact_id=task_identity[0],
                        task_id=task_identity[1],
                    )
            except Exception:
                # 消息已经提交，后台执行不可用不能改变导入结果。
                should_defer = True
            if should_defer and task_service is not None and task_identity is not None:
                try:
                    task_service.defer(
                        owner_id=owner_id, contact_id=task_identity[0], task_id=task_identity[1],
                    )
                except Exception:
                    pass
            return _json_response(HTTPStatus.OK, result)

        if path in {"/api/tasks/run", "/api/tasks/retry"}:
            if method != "POST":
                raise ImportTaskRequestInvalid()
            payload = _parse_task_json(body)
            allowed = {"contact_id", "task_id"}
            if path == "/api/tasks/run":
                allowed.add("extraction_runtime_mode")
            if set(payload) - allowed:
                raise ImportTaskRequestInvalid()
            contact_value = payload.get("contact_id")
            if not isinstance(contact_value, str):
                raise ImportTaskRequestInvalid()
            try:
                contact_id = UUID(contact_value)
            except ValueError:
                raise ImportTaskRequestInvalid() from None
            task_id = None
            if "task_id" in payload:
                task_value = payload["task_id"]
                if not isinstance(task_value, str):
                    raise ImportTaskRequestInvalid()
                try:
                    task_id = UUID(task_value)
                except ValueError:
                    raise ImportTaskRequestInvalid() from None
            runtime_mode = None
            if "extraction_runtime_mode" in payload:
                value = payload["extraction_runtime_mode"]
                if task_id is None or type(value) is not str:
                    raise ImportTaskRequestInvalid()
                try:
                    runtime_mode = ExtractionRuntimeMode(value)
                except ValueError:
                    raise ImportTaskRequestInvalid() from None
            if path == "/api/tasks/retry":
                if task_id is None or task_service is None:
                    raise ImportTaskRequestInvalid()
                return _json_response(HTTPStatus.OK, task_service.retry(
                    owner_id=owner_id, contact_id=contact_id, task_id=task_id,
                ))
            if task_host is None:
                raise ImportTaskRequestInvalid()
            start_args = dict(owner_id=owner_id, contact_id=contact_id)
            if task_id is not None:
                if task_service is None:
                    raise ImportTaskRequestInvalid()
                task_service.status(
                    owner_id=owner_id, contact_id=contact_id, task_id=task_id,
                )
                if runtime_mode is not None:
                    try:
                        task_service.configure_runtime(
                            owner_id=owner_id, contact_id=contact_id,
                            task_id=task_id, mode=runtime_mode,
                        )
                    except BackgroundTaskStateError:
                        return _json_response(
                            HTTPStatus.CONFLICT, {"error": "task_runtime_config_conflict"},
                        )
                start_args["task_id"] = task_id
            return _json_response(
                HTTPStatus.OK,
                task_host.start(**start_args),
            )

        if path == "/api/tasks/status":
            if method != "GET":
                raise ImportTaskRequestInvalid()
            query_pairs = parse_qs(query, keep_blank_values=True)
            contact_values = query_pairs.get("contact_id", [])
            if len(contact_values) != 1:
                raise ImportTaskRequestInvalid()
            try:
                contact_id = UUID(contact_values[0])
            except ValueError:
                raise ImportTaskRequestInvalid() from None
            if "task_id" in query_pairs:
                task_values = query_pairs["task_id"]
                if len(task_values) != 1 or task_service is None:
                    raise ImportTaskRequestInvalid()
                try:
                    task_id = UUID(task_values[0])
                except ValueError:
                    raise ImportTaskRequestInvalid() from None
                return _json_response(HTTPStatus.OK, task_service.status(
                    owner_id=owner_id, contact_id=contact_id, task_id=task_id,
                ))
            if task_host is None:
                raise ImportTaskRequestInvalid()
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
                return _json_response(
                    HTTPStatus.OK,
                    service.status(runtime_owner_id=self._owner_id),
                )
            if path == "/api/setup/initialize" and method == "POST":
                payload = _parse_setup_json(body)
                display_name = payload.get("display_name")
                create_only = payload.get("create_only", False)
                if not isinstance(create_only, bool):
                    raise SetupRequestInvalid()
                if not isinstance(display_name, str) or not display_name.strip():
                    raise SetupRequestInvalid()
                try:
                    return _json_response(
                        HTTPStatus.OK,
                        service.initialize_owner(display_name=display_name, create_only=create_only),
                    )
                except ValueError:
                    raise SetupRequestInvalid() from None
            if path == "/api/setup/official-deepseek" and method == "POST":
                payload = _parse_setup_json(body)
                if set(payload) != {"api_key", "confirm_official_defaults"} or payload["confirm_official_defaults"] is not True:
                    raise SetupRequestInvalid()
                try:
                    return _json_response(HTTPStatus.OK, service.use_official_deepseek(api_key=payload["api_key"]))
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
        except OwnerAlreadyConfigured:
            return _json_response(HTTPStatus.CONFLICT, {"error": "owner_already_configured"})
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
        if action == "versions":
            if method != "GET":
                raise SkillRequestInvalid()
            return _json_response(
                HTTPStatus.OK, skills.versions(owner_id=owner_id, skill_id=skill_id)
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
        if self._owner_id is None:
            # 业务事件都带真实 owner；未初始化时订阅会永久空挂，
            # 因此这里与 handle() 的 owner 门禁保持一致。
            return _json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "owner_uninitialized"},
            )
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
        if not supplied:
            return False
        try:
            return secrets.compare_digest(supplied, self._token)
        except TypeError:
            # HTTP 头按 latin-1 解码，可能携带非 ASCII 字符；
            # compare_digest 只接受 ASCII。无法比较的头一律按未认证
            # 处理，得到稳定 401 而不是连接级崩溃。
            return False


class BackendServer:
    """把 BackendApp 绑定到回环地址的真实 HTTP 适配器。"""

    __slots__ = ("_app", "_host", "_port", "_http_server", "_shutdown_lock")

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
        self._shutdown_lock = threading.Lock()

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
        shutdown = self.request_shutdown

        class RequestHandler(BaseHTTPRequestHandler):
            # 半开连接长时间阻塞会拖住线程与事件队列。
            # 有界 socket 超时保证写失败最终被感知；SSE keep-alive
            # 为 15 秒，连接超时保留分钟级余量。
            timeout = 300

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
                _serve_request(self, app, shutdown_after_response=shutdown)

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
        # HTTP 关闭请求和 command finally 可以同时收尾；同一宿主只关闭一次。
        with self._shutdown_lock:
            self._app.shutdown_runtime()
            self._app.events.close()
            if self._http_server is not None:
                self._http_server.shutdown()
                self._http_server.server_close()
                self._http_server = None

    def request_shutdown(self) -> None:
        """让 HTTP 线程或信号处理器请求收尾，不在调用线程重入关闭锁。"""

        threading.Thread(
            target=self.shutdown, name="notalone-runtime-shutdown", daemon=True
        ).start()


def _default_memory_upgrades(database_url, task_host):
    from notalone.application.memory_upgrade import MemoryUpgradeService
    from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
    return MemoryUpgradeService(PostgresMemoryUpgradeStore(database_url), task_host=task_host)


def create_app(
    *,
    database_url: str,
    owner_id: UUID | None,
    token: str | None = None,
    events: EventBus | None = None,
    sync_control: SyncControlPort | None = None,
    message_stream: MessageStream | None = None,
    reply_service: ReplyService | None = None,
    assistant_sessions: AssistantSessionService | None = None,
    candidate_versions: AssistantCandidateVersions | None = None,
    reply_evidence: ReplyEvidenceService | None = None,
    source_service: SourceService | None = None,
    memory_service: MemoryService | None = None,
    overview_service: RelationshipOverviewService | None = None,
    layered_memory: LayeredMemoryService | None = None,
    import_service: ImportService | None = None,
    task_host: TaskHost | None = None,
    task_service: TaskService | None = None,
    trace_service: TraceService | None = None,
    skill_service: SkillService | None = None,
    skill_learning: SkillLearningService | None = None,
    memory_upgrades=None,
    ledger_service: LedgerService | None = None,
    setup_service: SetupService | None = None,
    style_samples: StyleSampleService | None = None,
    expression_preferences: ExpressionPreferenceService | None = None,
    follow_smoke: FollowSmokeController | None = None,
    runtime_shutdown: Callable[[], None] | None = None,
) -> BackendApp:
    """创建服务应用；未显式传 token 时在启动时生成随机 token。"""

    from notalone.persistence.extraction_trace import (
        PostgresExtractionTraceStore,
    )
    from notalone.persistence.source_processing import (
        PostgresSourceProcessingStore,
    )
    from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore

    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore

    contacts = ContactDirectory(PostgresContactDirectory(database_url))
    layered_memory = layered_memory or LayeredMemoryService(PostgresLayeredMemoryStore(database_url))
    if task_host is not None:
        layered_memory.attach_task_host(task_host)
        layered_memory.resume_pending(owner_id)
    else:
        from notalone.tasks.organization_dispatch import EmbeddedOrganizationDispatcher
        layered_memory.attach_dispatcher(EmbeddedOrganizationDispatcher(database_url))
    layered_memory.start_maintenance(owner_id)
    return BackendApp(
        contact_directory=contacts,
        events=events or EventBus(),
        owner_id=owner_id,
        token=token or secrets.token_urlsafe(32),
        sync_control=sync_control,
        follow_smoke=follow_smoke,
        message_stream=message_stream
        or MessageStream(PostgresMessageStream(database_url)),
        reply_service=reply_service,
        assistant_sessions=assistant_sessions or AssistantSessionService(
            store=PostgresAssistantSessionStore(database_url), reply=reply_service,
            catalog=PostgresAssistantSessionCatalog(database_url),
            continuation_store=PostgresAssistantContinuationStore(database_url),
        ),
        candidate_versions=candidate_versions or PostgresAssistantCandidateVersions(database_url),
        reply_evidence=reply_evidence
        or ReplyEvidenceService(PostgresReplyStore(database_url)),
        style_samples=style_samples or StyleSampleService(PostgresStyleSampleStore(database_url)),
        expression_preferences=expression_preferences or ExpressionPreferenceService(
            PostgresExpressionPreferenceStore(database_url),
        ),
        source_service=source_service or SourceService(database_url),
        memory_service=memory_service,
        overview_service=overview_service or RelationshipOverviewService(PostgresRelationshipOverviewStore(database_url)),
        layered_memory=layered_memory,
        import_service=import_service,
        task_host=task_host,
        task_service=task_service
        or TaskService(
            repository=PostgresBackgroundTaskRepository(database_url),
        ),
        trace_service=trace_service
        or TraceService(
            contacts=contacts,
            extraction=PostgresExtractionTraceStore(database_url),
            processing=PostgresSourceProcessingStore(database_url),
        ),
        skill_service=skill_service,
        skill_learning=skill_learning or SkillLearningService(PostgresSkillLearningStore(database_url), task_host=task_host,
            review=reply_service.skill_review if reply_service is not None else None),
        memory_upgrades=memory_upgrades or _default_memory_upgrades(database_url, task_host),
        ledger_service=ledger_service,
        setup_service=setup_service,
        runtime_shutdown=runtime_shutdown,
    )


def _is_trace_path(path: str) -> bool:
    return "/memory-traces" in path or "/source-processing-traces" in path


def _serve_request(
    handler: BaseHTTPRequestHandler,
    app: BackendApp,
    *,
    shutdown_after_response: Callable[[], None] | None = None,
) -> None:
    try:
        body = _read_request_body(handler)
    except _RequestLengthInvalid:
        # 畸形长度不能猜成空体继续处理，否则同一请求会得到不同结果。
        handler.close_connection = True
        _write_response(
            handler,
            _json_response(
                HTTPStatus.BAD_REQUEST,
                {"error": "request_length_invalid"},
                headers={"Connection": "close"},
            ),
        )
        return
    except _RequestBodyTooLarge:
        # 短时、有界排空可降低正常客户端收到 RST 的概率；随后关闭连接。
        handler.close_connection = True
        _write_response(
            handler,
            _json_response(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"error": "request_body_too_large"},
                headers={"Connection": "close"},
            ),
        )
        return
    response = app.handle(
        method=handler.command,
        path=handler.path,
        headers={key: value for key, value in handler.headers.items()},
        body=body,
    )
    try:
        _write_response(handler, response)
        handler.wfile.flush()
    finally:
        if (
            shutdown_after_response is not None
            and handler.command == "POST"
            and urlsplit(handler.path).path == "/api/runtime/shutdown"
            and response.status_code == HTTPStatus.OK
        ):
            # 成功响应已在同步 stop 后产生；先发完响应再退出服务循环。
            # 即使客户端提前断开也照常收尾，不遗留已停读的空宿主。
            shutdown_after_response()


class _RequestBodyTooLarge(Exception):
    """Content-Length 超出上限：统一映射为稳定 413。"""


class _RequestLengthInvalid(Exception):
    """Content-Length 存在但不是合法的非负整数：映射为稳定 400。"""


def _read_request_body(handler: BaseHTTPRequestHandler) -> bytes:
    """按 Content-Length 读取请求体；异常声明映射为稳定 413。

    只允许读取回环本地请求。超过 1 MiB 时短时、有界排空已到达数据，
    再返回 413 并关闭连接；这样不会被只声明长度却不发送 body 的客户端
    长期挂住。
    """

    raw_length = _header_value(handler.headers, "Content-Length")
    if raw_length is None or not str(raw_length).strip():
        # 没有声明长度：按空请求体处理，交给应用层做参数校验。
        return b""
    try:
        length = int(str(raw_length).strip())
    except (ValueError, TypeError):
        raise _RequestLengthInvalid() from None
    if length < 0:
        raise _RequestLengthInvalid()
    if length > 1024 * 1024:
        _drain_available_body(handler, limit=length)
        raise _RequestBodyTooLarge()
    if length == 0:
        return b""
    try:
        return handler.rfile.read(length) or b""
    except OSError:
        return b""


def _drain_available_body(
    handler: BaseHTTPRequestHandler,
    *,
    limit: int,
) -> None:
    """以极短超时丢弃已到达的超限 body，最多读取 8 MiB。"""

    remaining = min(limit, 8 * 1024 * 1024)
    previous_timeout = handler.connection.gettimeout()
    try:
        handler.connection.settimeout(0.1)
        while remaining > 0:
            chunk = handler.rfile.read(min(65536, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
    except OSError:
        return
    finally:
        handler.connection.settimeout(previous_timeout)


def _write_response(handler: BaseHTTPRequestHandler, response: Response) -> None:
    handler.send_response(response.status_code)
    headers = dict(response.headers)
    if _is_trace_path(handler.path):
        headers["Cache-Control"] = "no-store"
    for key, value in headers.items():
        handler.send_header(key, value)
    handler.end_headers()
    if handler.command == "HEAD":
        # HEAD 响应按协议不携带 body。
        return
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
    except OSError:
        # 客户端断开/超时是常态；其他断连方式也要静默收尾。
        # 订阅在 finally 中统一关闭，不让 HTTP 线程以堆栈收场。
        pass
    finally:
        response.subscription.close()
        # SSE 没有 Content-Length；结束订阅时也结束当前响应，不能留在 keep-alive 等下一请求。
        handler.close_connection = True


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
                "cli_backfill_phase": report.cli_backfill_phase,
                "cli_backfill_contact_id": (
                    None
                    if report.cli_backfill_contact_id is None
                    else str(report.cli_backfill_contact_id)
                ),
                "cli_backfill_message_count": report.cli_backfill_message_count,
                "cli_backfill_non_text_count": report.cli_backfill_non_text_count,
                "cli_backfill_last_cursor": report.cli_backfill_last_cursor,
                "cli_backfill_failure_code": report.cli_backfill_failure_code,
                "cli_backfill_total_contacts": report.cli_backfill_total_contacts,
                "cli_backfill_completed_contacts": report.cli_backfill_completed_contacts,
                "cli_backfill_succeeded_contacts": report.cli_backfill_succeeded_contacts,
                "cli_backfill_skipped_contacts": report.cli_backfill_skipped_contacts,
                "cli_backfill_failed_contacts": report.cli_backfill_failed_contacts,
                "cli_backfill_incomplete_contacts": report.cli_backfill_incomplete_contacts,
                "cli_backfill_pending_contacts": report.cli_backfill_pending_contacts,
                "cli_backfill_total_message_count": report.cli_backfill_total_message_count,
                "cli_backfill_total_non_text_count": report.cli_backfill_total_non_text_count,
                "foreground_phase": report.foreground_phase,
                "foreground_failure_code": report.foreground_failure_code,
            }
        )
    return payload


def _cli_binding_payload(binding: PersistedConversationBinding) -> dict[str, object]:
    """授权目录只暴露稳定身份和展示字段，不暴露原始定位证据。"""

    return {
        "binding_id": str(binding.binding_id),
        "contact_id": str(binding.scope.contact_id),
        "conversation_locator": binding.conversation_locator,
        "display_name": binding.display_name,
        "status": binding.status.value,
    }


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


def _completed_turn_payload(turn: AssistantTurn) -> dict[str, object]:
    if turn.reply is None or turn.state != "completed":
        raise AssistantSessionPersistenceError("未保存完成结果。")
    return {**_reply_payload(turn.reply), "session_id": str(turn.session_id), "turn_id": str(turn.turn_id),
            "input_version_id": str(turn.input_version_id), "state": turn.state}


def _reply_payload(reply: ReplyGenerated) -> dict[str, object]:
    """把已持久化的候选回复投影为稳定 JSON；不含会话正文以外内容。"""
    from notalone.reply.expression_preferences import preference_receipt_payload

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
            'version_number': skill.version_number,
            'scope': {'kind': skill.scope_kind,
                      'contact_id': str(skill.scope_contact_id) if skill.scope_contact_id else None,
                      'scene': skill.scope_scene},
            **({'execution_view': skill.execution_view.to_payload()} if skill.execution_view else {}),
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
                "messages": [{"message_id": str(message.message_id), "text": message.text}
                             for message in candidate.message_group],
            }
            for candidate in reply.candidates
        ],
        "context_receipt": {
            "evidence_ids": [
                str(evidence) for evidence in reply.context_receipt.evidence_ids
            ],
            "style_sample_ids": [str(identifier) for identifier in reply.context_receipt.style_sample_ids],
            "expression_preference_ids": [str(identifier) for identifier in reply.context_receipt.expression_preference_ids],
            "expression_preferences": [
                preference_receipt_payload(item) for item in reply.context_receipt.expression_preferences
            ],
        },
        "used_skill": used_skill,
        **({"basis_changes": [change.to_payload() for change in reply.basis_changes]}
           if reply.basis_changes else {}),
        **({"input_budget": reply.input_budget.to_payload()} if reply.input_budget is not None else {}),
    }


def _assistant_turn_payload(turn: AssistantTurn) -> dict[str, object]:
    return {
        "turn_id": str(turn.turn_id), "input_version_id": str(turn.input_version_id),
        "request_key": str(turn.request_key), "state": turn.state, "input": turn.input,
        "interruption_reason": turn.interruption_reason,
        **({"generation_active": turn.generation_active} if turn.generation_active is not None else {}),
        **({"requires_reprepare": True} if turn.requires_reprepare else {}),
        "reply": _reply_payload(turn.reply) if turn.reply is not None else None,
        "basis_changes": [change.to_payload() for change in turn.reply.basis_changes] if turn.reply else [],
        "placeholder": (
            "相关来源已删除" if turn.state == "redacted"
            else "相关来源不可用" if turn.state == "unavailable" else None
        ),
    }


def _assistant_input_payload(record: Any) -> dict[str, object]:
    return {
        "input_version_id": str(record.input_version_id), "type": record.type,
        "conversation_binding_id": str(record.conversation_binding_id),
        "turn_id": str(record.turn_id) if record.turn_id is not None else None,
        "state": record.state, "content": record.content,
        **({"basis_changes": [change.to_payload() for change in record.basis_changes]}
           if record.basis_changes else {}),
        "placeholder": ("相关来源已删除" if record.state == "redacted"
                        else "相关来源不可用" if record.state == "unavailable" else None),
    }


def _parse_assistant_replacement_request(body: bytes) -> tuple[UUID, UUID, ReplyServiceRequest]:
    replacement = json.loads(body.decode("utf-8"))
    if (not isinstance(replacement, dict)
            or set(replacement) != {"running_request_key", "replacement"}
            or not isinstance(replacement["running_request_key"], str)
            or not isinstance(replacement["replacement"], dict)):
        raise ReplyRequestInvalid()
    running_request_key = UUID(replacement["running_request_key"])
    body_contact, request = parse_assistant_reply_request(
        json.dumps(replacement["replacement"], ensure_ascii=False).encode("utf-8"),
    )
    if request.idempotency_key == running_request_key:
        raise ReplyRequestInvalid()
    return running_request_key, body_contact, request


def _parse_assistant_discussion_request(body: bytes) -> tuple[dict[str, Any], UUID | None]:
    from notalone.persistence.assistant_session_inputs import normalize_discussion_content
    try:
        payload = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ReplyRequestInvalid() from None
    if not isinstance(payload, dict) or set(payload) - {"content", "expected_input_version_id"}:
        raise ReplyRequestInvalid()
    expected = payload.get("expected_input_version_id")
    if expected is not None:
        if not isinstance(expected, str):
            raise ReplyRequestInvalid()
        try:
            expected = UUID(expected)
        except ValueError:
            raise ReplyRequestInvalid() from None
    try:
        content = normalize_discussion_content(payload.get("content"))
    except AssistantSessionRejected:
        raise ReplyRequestInvalid() from None
    return content, expected


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


def _json_response(
    status: HTTPStatus,
    payload: object,
    *,
    headers: Mapping[str, str] | None = None,
) -> Response:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    merged = {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body)),
        **(headers or {}),
    }
    return Response(
        status_code=int(status),
        headers=merged,
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


def _memory_revision_or_raise(body: bytes) -> int:
    payload = _parse_memory_json(body)
    revision = payload.get("expected_revision")
    if set(payload) != {"expected_revision"} or type(revision) is not int or revision < 1:
        raise MemoryRequestInvalid()
    return revision


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


def _parse_task_json(body: bytes) -> dict[str, object]:
    """任务配置拒绝重复键与非有限值，不能静默选择冲突输入的最后一个。"""

    def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ImportTaskRequestInvalid()
            result[key] = value
        return result

    def nonfinite(_: str) -> object:
        raise ImportTaskRequestInvalid()

    try:
        payload = json.loads(
            body.decode("utf-8"), object_pairs_hook=unique, parse_constant=nonfinite,
        )
    except (UnicodeDecodeError, ValueError):
        raise ImportTaskRequestInvalid() from None
    if type(payload) is not dict:
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
    from notalone.application.memory_projection import source_dependency_fields

    return {
        **source_dependency_fields(memory),
        "memory_id": str(memory.memory_id),
        "level": "owner",
        "text": memory.text,
        "category": memory.category.value,
        "topic": memory.topic.value,
        "adoption_method": memory.adoption_method.value,
        "status": memory.status.value,
        "revision": memory.revision,
        "supersedes_memory_id": (
            str(memory.supersedes_memory_id)
            if memory.supersedes_memory_id is not None else None
        ),
        "source_ids": [str(source_id) for source_id in memory.source_ids],
        "source_candidate_id": (
            str(memory.source_candidate_id)
            if memory.source_candidate_id is not None
            else None
        ),
        "confidence": memory.confidence,
        "risk_flags": list(memory.risk_flags),
        "timing": memory.timing.to_payload(),
        "event": memory.event.to_payload(current=True) if memory.event is not None else None,
        "version_evidence": memory.version_evidence.to_payload() if memory.version_evidence else None,
        "version_evidence_source_current": bool(memory.version_evidence and memory.version_evidence.source_current),
        "can_revert_auto_update": memory.can_revert_auto_update,
        "valid_at": _iso_or_none(memory.valid_at),
        "invalid_at": _iso_or_none(memory.invalid_at),
    }


def _memory_payload(memory: ConfirmedMemory) -> dict[str, object]:
    from notalone.application.memory_projection import source_dependency_fields

    return {
        **source_dependency_fields(memory),
        "memory_id": str(memory.memory_id),
        "level": "contact",
        "contact_id": str(memory.scope.contact_id),
        "text": memory.text,
        "category": memory.category.value,
        "topic": memory.topic.value,
        "adoption_method": memory.adoption_method.value,
        "status": memory.status.value,
        "revision": memory.revision,
        "source_ids": [str(source_id) for source_id in memory.source_ids],
        "confidence": memory.confidence,
        "risk_flags": list(memory.risk_flags),
        "supersedes_memory_id": (
            str(memory.supersedes_memory_id)
            if memory.supersedes_memory_id is not None
            else None
        ),
        "timing": memory.timing.to_payload(),
        "event": memory.event.to_payload(current=True) if memory.event is not None else None,
        "version_evidence": memory.version_evidence.to_payload() if memory.version_evidence else None,
        "version_evidence_source_current": bool(memory.version_evidence and memory.version_evidence.source_current),
        "can_revert_auto_update": memory.can_revert_auto_update,
        "valid_at": _iso_or_none(memory.valid_at),
        "invalid_at": _iso_or_none(memory.invalid_at),
    }


def _iso_or_none(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _memory_candidate_payload(candidate: MemoryCandidate) -> dict[str, object]:
    from notalone.application.memory_projection import bounded_dimension_states, source_dependency_fields

    payload: dict[str, object] = {
        **source_dependency_fields(candidate),
        "candidate_id": str(candidate.candidate_id),
        "text": candidate.text,
        "category": candidate.category.value,
        "topic": candidate.topic.value,
        "subject": candidate.subject.value,
        "status": candidate.status.value,
        "source_ids": [str(source_id) for source_id in candidate.source_ids],
        "confidence": candidate.confidence,
        "risk_flags": list(candidate.risk_flags),
        "failure_reason": candidate.failure_reason,
        "timing": candidate.timing.to_payload(),
        "event": candidate.event.to_payload(current=True) if candidate.event is not None else None,
        "valid_at": _iso_or_none(candidate.valid_at),
        "invalid_at": _iso_or_none(candidate.invalid_at),
    }
    if candidate.alternatives:
        payload["alternatives"] = list(candidate.alternatives)
    if candidate.correction_review:
        payload["correction_review"] = [review.to_payload() for review in candidate.correction_review]
    if candidate.interpretation_reason.strip():
        payload["interpretation_reason"] = candidate.interpretation_reason
    if candidate.dimension_evidence is not None:
        payload["dimension_evidence"] = candidate.dimension_evidence.to_payload()
        payload["dimension_evidence_source_current"] = (
            candidate.dimension_evidence.source_bound
        )
    if "source_dependency_mode" in payload:
        payload["dimension_evidence_dimensions"] = bounded_dimension_states(candidate)
    return payload
