"""票08讨论业务的认证TS薄桥；不保存DSH会话，也不复制另一套业务状态。"""
from __future__ import annotations

import http.client
import json
import socket
import threading
from datetime import datetime
from types import SimpleNamespace
from typing import Any, Mapping
from urllib.parse import urlsplit
from uuid import UUID

from notalone.application.assistant_candidate_carry import (
    CarriedAssistantSession, CarryAssistantCandidate,
)
from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionPersistenceError,
    AssistantSessionRejected, AssistantSessionService, AssistantSessionSnapshot,
    AssistantSessionSummary,
)
from notalone.application.reply_remote import decode_reply_generated
from notalone.persistence.assistant_candidate_versions import (
    AssistantCandidateEditReceipt, AssistantCandidateHistory, AssistantCandidateSelection,
    AssistantCandidateVersion, AssistantCandidateVersionPage, EditAssistantCandidate,
)
from notalone.reply.interface import CandidateMessage, ReplyBasisChange
from notalone.scopes import ContactScope, VerifiedConversationScope


class _RemoteInvalidResponse(RuntimeError):
    pass


def _wire(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {key: _wire(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_wire(item) for item in value]
    return value


class RemoteAssistantDiscussionClient:
    """单次HTTP命令；无自动重试，未知结果留给用户重新读取裁定。"""

    def __init__(self, *, url: str, token: str, owner_id: UUID, timeout: float = 15):
        try:
            parsed = urlsplit(url)
            valid = (
                parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
                and parsed.port is not None and 1 <= parsed.port <= 65535
                and not parsed.username and not parsed.password and not parsed.path
                and not parsed.query and not parsed.fragment
            )
        except ValueError:
            valid = False
        if (not valid or type(token) is not str or len(token) < 32
                or not isinstance(owner_id, UUID) or type(timeout) not in (int, float)
                or not 0 < timeout <= 60):
            raise ValueError("assistant_discussion_remote_config_invalid")
        self._port, self._token, self._owner = parsed.port, token, owner_id
        self._timeout = float(timeout)
        self._lock, self._closed, self._connections = threading.Lock(), False, set()

    @classmethod
    def from_environment(cls, environment: Mapping[str, str], *, owner_id: UUID):
        try:
            return cls(
                url=environment["NOTALONE_REPLY_REMOTE_URL"],
                token=environment["NOTALONE_REPLY_REMOTE_TOKEN"],
                owner_id=owner_id,
            )
        except (KeyError, TypeError, ValueError):
            raise AssistantSessionPersistenceError("讨论业务桥配置无效。") from None

    def call(
        self, scope: ContactScope, action: str, request: dict[str, Any],
        *, session_id: UUID | None = None,
    ) -> Any:
        if not isinstance(scope, ContactScope) or scope.owner_id != self._owner:
            raise AssistantSessionRejected("scope_mismatch")
        payload = _wire({
            "owner_id": scope.owner_id, "contact_id": scope.contact_id,
            **({"session_id": session_id} if session_id is not None else {}),
            "action": action, "request": request,
        })
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > 1048576:
            raise ValueError("assistant_discussion_request_invalid")
        connection = http.client.HTTPConnection("127.0.0.1", self._port, timeout=self._timeout)
        with self._lock:
            if self._closed:
                raise AssistantSessionPersistenceError("讨论业务桥已停止。")
            self._connections.add(connection)
        try:
            connection.connect()
            connection.request(
                "POST", "/internal/discussion", body=encoded,
                headers={
                    "Authorization": "Bearer " + self._token,
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            body = response.read(1048577)
            if (len(body) > 1048576 or response.getheader("Content-Type", "").split(";")[0].strip()
                    != "application/json"):
                raise _RemoteInvalidResponse()
            try:
                result = json.loads(
                    body, object_pairs_hook=self._pairs,
                    parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
                )
            except (ValueError, UnicodeError, TypeError):
                raise _RemoteInvalidResponse() from None
            if response.status != 200:
                self._raise_error(response.status, result)
            if (type(result) is not dict or result.get("owner_id") != payload["owner_id"]
                    or result.get("contact_id") != payload["contact_id"]
                    or "result" not in result):
                raise _RemoteInvalidResponse()
            return result["result"]
        except (OSError, http.client.HTTPException, TimeoutError):
            raise AssistantSessionPersistenceError("讨论业务暂不可用。") from None
        except (ValueError, TypeError, KeyError) as error:
            if isinstance(error, _RemoteInvalidResponse):
                raise AssistantSessionPersistenceError("讨论业务响应无效。") from None
            raise
        finally:
            with self._lock:
                self._connections.discard(connection)
            connection.close()

    @staticmethod
    def _pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    @staticmethod
    def _raise_error(status: int, result: Any) -> None:
        if type(result) is not dict or type(result.get("error")) is not str:
            raise _RemoteInvalidResponse()
        code = result["error"]
        if code == "not_found":
            raise AssistantSessionNotFound("当前范围不存在指定讨论。")
        if code == "discussion_request_invalid":
            raise ValueError("assistant_discussion_request_invalid")
        if code == "discussion_conflict":
            reason = result.get("reason")
            if reason == "assistant_session_input_conflict":
                raise AssistantSessionConflict("讨论输入已变化。")
            if type(reason) is not str:
                raise AssistantSessionConflict("讨论业务发生冲突。")
            raise AssistantSessionRejected(reason)
        raise AssistantSessionPersistenceError("讨论业务暂不可用。")

    def close(self) -> None:
        with self._lock:
            self._closed = True
            connections = tuple(self._connections)
        for connection in connections:
            try:
                if connection.sock is not None:
                    connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()


def _basis_changes(value: Any) -> tuple[ReplyBasisChange, ...]:
    if value is None:
        return ()
    if type(value) is not list:
        raise _RemoteInvalidResponse()
    result = []
    for item in value:
        if (type(item) is not dict
                or set(item) != {"evidence_id", "kind", "reason"}
                or not isinstance(item["kind"], str)
                or not isinstance(item["reason"], str)):
            raise _RemoteInvalidResponse()
        result.append(ReplyBasisChange(UUID(item["evidence_id"]), item["kind"], item["reason"]))
    return tuple(result)


def _candidate_version(item: Any) -> AssistantCandidateVersion:
    if (type(item) is not dict
            or set(item) != {
                "version_id", "version_number", "parent_version_id", "edit_key",
                "text", "messages", "requirements", "created_at",
            }
            or type(item["version_number"]) is not int
            or not isinstance(item["text"], str)
            or not isinstance(item["messages"], list)):
        raise _RemoteInvalidResponse()
    grouped = tuple(
        CandidateMessage(UUID(message["message_id"]), message["text"])
        for message in item["messages"]
        if type(message) is dict and set(message) == {"message_id", "text"}
        and isinstance(message["text"], str)
    )
    if len(grouped) != len(item["messages"]) or not grouped:
        raise _RemoteInvalidResponse()
    return AssistantCandidateVersion(
        UUID(item["version_id"]), item["version_number"],
        UUID(item["parent_version_id"]) if item["parent_version_id"] is not None else None,
        grouped, item["requirements"],
        datetime.fromisoformat(item["created_at"].replace("Z", "+00:00")),
    )


def _candidate_history(scope: ContactScope, value: Any) -> AssistantCandidateHistory:
    if (type(value) is not dict
            or not {
                "session_id", "turn_id", "candidate_id", "candidate_group_id",
                "candidate_number", "default_display_version_id",
                "selected_version_id", "versions",
            } <= set(value)
            or type(value["candidate_number"]) is not int
            or not isinstance(value["versions"], list)):
        raise _RemoteInvalidResponse()
    history = AssistantCandidateHistory(
        UUID(value["session_id"]), UUID(value["turn_id"]), UUID(value["candidate_id"]),
        UUID(value["candidate_group_id"]), value["candidate_number"],
        UUID(value["default_display_version_id"]),
        UUID(value["selected_version_id"]) if value["selected_version_id"] is not None else None,
        tuple(_candidate_version(item) for item in value["versions"]),
        _basis_changes(value.get("basis_changes")),
    )
    return history


def _selection(value: Any) -> AssistantCandidateSelection:
    if (type(value) is not dict
            or set(value) != {
                "selection_id", "selection_number", "session_id", "candidate_id", "version_id",
            }
            or type(value["selection_number"]) is not int):
        raise _RemoteInvalidResponse()
    return AssistantCandidateSelection(
        UUID(value["selection_id"]), value["selection_number"], UUID(value["session_id"]),
        UUID(value["candidate_id"]), UUID(value["version_id"]),
    )


class RemoteAssistantCandidateVersions:
    """公开候选版本协议委托TS；返回原Python业务对象避免改桌面合同。"""

    def __init__(self, client: RemoteAssistantDiscussionClient):
        self._client = client

    def read(self, scope, session_id, candidate_id):
        return _candidate_history(scope, self._client.call(
            scope, "read_candidate", {"candidate_id": str(candidate_id)},
            session_id=session_id,
        ))

    def selected(self, scope, session_id):
        result = self._client.call(scope, "selected_candidate", {}, session_id=session_id)
        if type(result) is not dict or set(result) != {"selection"}:
            raise _RemoteInvalidResponse()
        return None if result["selection"] is None else _selection(result["selection"])

    def edit(self, scope, session_id, candidate_id, command: EditAssistantCandidate):
        return _candidate_history(scope, self._client.call(scope, "edit_candidate", {
            "candidate_id": str(candidate_id), "receipt": False,
            "edit": self._edit_payload(command),
        }, session_id=session_id))

    def edit_receipt(self, scope, session_id, candidate_id, command: EditAssistantCandidate):
        value = self._client.call(scope, "edit_candidate", {
            "candidate_id": str(candidate_id), "receipt": True,
            "edit": self._edit_payload(command),
        }, session_id=session_id)
        if (type(value) is not dict
                or set(value) != {
                    "session_id", "candidate_id", "version_id", "version_number",
                    "edit_key", "parent_version_id",
                }
                or type(value["version_number"]) is not int):
            raise _RemoteInvalidResponse()
        return AssistantCandidateEditReceipt(
            UUID(value["session_id"]), UUID(value["candidate_id"]), UUID(value["version_id"]),
            value["version_number"], UUID(value["edit_key"]), UUID(value["parent_version_id"]),
        )

    def select(self, scope, session_id, candidate_id, version_id, selection_key):
        return _selection(self._client.call(scope, "select_candidate", {
            "candidate_id": str(candidate_id), "version_id": str(version_id),
            "selection_key": str(selection_key),
        }, session_id=session_id))

    def read_page(self, scope, session_id, candidate_id, page_number, through=None):
        history = self.read(scope, session_id, candidate_id)
        if page_number < 0 or page_number >= len(history.versions):
            raise ValueError("候选版本页码无效。")
        version = history.versions[page_number]
        bounded = AssistantCandidateHistory(
            history.session_id, history.turn_id, history.candidate_id,
            history.candidate_group_id, history.candidate_number,
            history.default_display_version_id, None, (version,), history.basis_changes,
        )
        return AssistantCandidateVersionPage(bounded, page_number, len(history.versions))

    @staticmethod
    def _edit_payload(command: EditAssistantCandidate) -> dict[str, Any]:
        return {
            "edit_key": str(command.edit_key),
            "parent_version_id": str(command.parent_version_id),
            "messages": [
                {"message_id": str(message.message_id), "text": message.text}
                for message in command.messages
            ],
            "requirements": command.requirements,
        }


class RemoteAssistantSessionService:
    """只接管讨论CRUD；准备、生成、替换和续答仍委托原会话authority。"""

    def __init__(self, local: AssistantSessionService, client: RemoteAssistantDiscussionClient):
        self._local, self._client = local, client

    def __getattr__(self, name: str):
        return getattr(self._local, name)

    def require_conversation_binding(self, *, owner_id, contact_id):
        self._client.call(ContactScope(owner_id, contact_id), "require_binding", {})

    def default(self, *, owner_id, contact_id):
        result = self._client.call(ContactScope(owner_id, contact_id), "default", {})
        return UUID(result["session_id"])

    def new(self, *, owner_id, contact_id):
        result = self._client.call(ContactScope(owner_id, contact_id), "new", {})
        return UUID(result["session_id"])

    def list_sessions(self, *, owner_id, contact_id):
        result = self._client.call(ContactScope(owner_id, contact_id), "list", {})
        if type(result) is not dict or not isinstance(result.get("sessions"), list):
            raise _RemoteInvalidResponse()
        return tuple(AssistantSessionSummary(
            UUID(item["session_id"]), bool(item["is_current"]),
        ) for item in result["sessions"])

    def select(self, *, owner_id, contact_id, session_id):
        result = self._client.call(
            ContactScope(owner_id, contact_id), "select", {}, session_id=session_id,
        )
        return UUID(result["session_id"])

    def read_session(self, *, owner_id, contact_id, session_id):
        raw = self._client.call(
            ContactScope(owner_id, contact_id), "read", {}, session_id=session_id,
        )
        turns, inputs = [], []
        for item in raw.get("turns", []):
            reply = None
            if item.get("reply") is not None:
                binding = next(
                    (record["conversation_binding_id"] for record in raw.get("inputs", [])
                     if record.get("input_version_id") == item.get("input_version_id")),
                    None,
                )
                if binding is None:
                    raise _RemoteInvalidResponse()
                reply = decode_reply_generated(
                    item["reply"], VerifiedConversationScope(owner_id, contact_id, UUID(binding)),
                )
            turns.append(SimpleNamespace(
                turn_id=UUID(item["turn_id"]), session_id=UUID(raw["session_id"]),
                input_version_id=UUID(item["input_version_id"]), request_key=UUID(item["request_key"]),
                state=item["state"], input=item["input"], reply=reply,
                interruption_reason=item.get("interruption_reason"),
                generation_active=item.get("generation_active"),
                requires_reprepare=item.get("requires_reprepare", False),
            ))
        for item in raw.get("inputs", []):
            inputs.append(SimpleNamespace(
                input_version_id=UUID(item["input_version_id"]), session_id=UUID(raw["session_id"]),
                type=item["type"], conversation_binding_id=UUID(item["conversation_binding_id"]),
                turn_id=UUID(item["turn_id"]) if item.get("turn_id") is not None else None,
                state=item["state"], content=item.get("content"),
                basis_changes=_basis_changes(item.get("basis_changes")),
            ))
        return AssistantSessionSnapshot(
            UUID(raw["session_id"]),
            UUID(raw["current_input_version_id"]) if raw.get("current_input_version_id") is not None else None,
            tuple(turns), tuple(inputs),
        )

    def read(self, *, owner_id, contact_id, session_id):
        return self.read_session(owner_id=owner_id, contact_id=contact_id, session_id=session_id).turns

    def delete(self, *, owner_id, contact_id, session_id):
        result = self._client.call(
            ContactScope(owner_id, contact_id), "delete", {"confirmed": True},
            session_id=session_id,
        )
        if result.get("state") != "deleted" or result.get("session_id") != str(session_id):
            raise AssistantSessionPersistenceError("讨论删除未确认。")

    def record_discussion_input(
        self, *, owner_id, contact_id, session_id, content, expected_input_version_id=None,
        verified_dependencies=(),
    ):
        if verified_dependencies:
            raise AssistantSessionRejected("invalid_discussion_dependencies")
        result = self._client.call(
            ContactScope(owner_id, contact_id), "input", {
                "content": content,
                **({"expected_input_version_id": expected_input_version_id}
                   if expected_input_version_id is not None else {}),
            },
            session_id=session_id,
        )
        return UUID(result["input_version_id"])

    def interrupt(self, *, owner_id, contact_id, session_id, request_key, input_version_id, reason="app_quit"):
        result = self._client.call(
            ContactScope(owner_id, contact_id), "interrupt", {
                "request_key": request_key, "input_version_id": input_version_id,
                **({"reason": reason} if reason != "app_quit" else {}),
            },
            session_id=session_id,
        )
        return AssistantGenerationReceipt(
            UUID(result["session_id"]), UUID(result["turn_id"]), UUID(result["request_key"]),
            UUID(result["input_version_id"]), result["state"], result.get("interruption_reason"),
        )

    def new_with_candidate(self, *, owner_id, contact_id, session_id, command: CarryAssistantCandidate):
        result = self._client.call(
            ContactScope(owner_id, contact_id), "carry", {
                "expected_selection_id": command.expected_selection_id,
                "candidate_id": command.candidate_id,
                "version_id": command.version_id,
            },
            session_id=session_id,
        )
        return CarriedAssistantSession(UUID(result["session_id"]), UUID(result["input_version_id"]))


def build_remote_discussion(
    environment: Mapping[str, str], *, owner_id: UUID, local: AssistantSessionService,
) -> tuple[RemoteAssistantSessionService, RemoteAssistantCandidateVersions, RemoteAssistantDiscussionClient]:
    client = RemoteAssistantDiscussionClient.from_environment(environment, owner_id=owner_id)
    return RemoteAssistantSessionService(local, client), RemoteAssistantCandidateVersions(client), client
