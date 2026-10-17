"""显式退出的严格 HTTP 合同；沿用已领取的无正文身份。"""

from __future__ import annotations

import json
from http import HTTPStatus
from typing import Any
from uuid import UUID

from notalone.application.assistant_generation_lifecycle import (
    AssistantGenerationLifecyclePort, AssistantGenerationReceipt,
)
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionError, AssistantSessionNotFound,
    AssistantSessionPersistenceError, AssistantSessionRejected,
)
from notalone.application.reply_request import ReplyRequestInvalid


def generation_lifecycle_path(parts: list[str]) -> str | None:
    if len(parts) < 6 or parts[:2] != ["api", "contacts"] or parts[3] != "assistant-sessions":
        return None
    if len(parts) == 6 and parts[5] in ("interrupt", "preparation-format"):
        return parts[5]
    return None


def _uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise ReplyRequestInvalid()
    try:
        return UUID(value)
    except ValueError:
        raise ReplyRequestInvalid() from None


def parse_interruption_request(body: bytes, *, allow_reason: bool = True) -> tuple[UUID, UUID, str]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ReplyRequestInvalid() from None
    if not isinstance(payload, dict) or set(payload) not in ({"request_key", "input_version_id"}, {"request_key", "input_version_id", "reason"}):
        raise ReplyRequestInvalid()
    if not allow_reason and "reason" in payload:
        raise ReplyRequestInvalid()
    reason = payload.get("reason", "app_quit")
    if reason not in ("app_quit", "configuration_reload"):
        raise ReplyRequestInvalid()
    return _uuid(payload["request_key"]), _uuid(payload["input_version_id"]), reason


def interruption_receipt_payload(receipt: AssistantGenerationReceipt) -> dict[str, Any]:
    return {"session_id": str(receipt.session_id), "turn_id": str(receipt.turn_id),
            "request_key": str(receipt.request_key), "input_version_id": str(receipt.input_version_id),
            "state": receipt.state, "interruption_reason": receipt.interruption_reason}


def handle_generation_lifecycle(
    service: AssistantGenerationLifecyclePort | None, *, owner_id: UUID,
    method: str, path: str, body: bytes,
) -> tuple[HTTPStatus, dict[str, Any]]:
    parts = path.strip("/").split("/")
    action = generation_lifecycle_path(parts)
    if action is None:
        return HTTPStatus.NOT_FOUND, {"error": "not_found"}
    if method != "POST":
        return HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"}
    if service is None:
        return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "assistant_session_unavailable"}
    try:
        contact_id, session_id = _uuid(parts[2]), _uuid(parts[4])
        request_key, input_version_id, reason = parse_interruption_request(body, allow_reason=action != "preparation-format")
        if action == "preparation-format":
            checked = service.preparation_format(owner_id=owner_id, contact_id=contact_id, session_id=session_id,
                                                  request_key=request_key, input_version_id=input_version_id)
            payload = interruption_receipt_payload(checked.generation)
            payload.pop("interruption_reason")
            return HTTPStatus.OK, {**payload, "format_status": checked.format_status}
        receipt = service.interrupt(owner_id=owner_id, contact_id=contact_id, session_id=session_id,
                                    request_key=request_key, input_version_id=input_version_id, **({"reason": reason} if reason != "app_quit" else {}))
        return HTTPStatus.OK, interruption_receipt_payload(receipt)
    except ReplyRequestInvalid:
        return HTTPStatus.BAD_REQUEST, {"error": "assistant_session_request_invalid"}
    except AssistantSessionNotFound:
        return HTTPStatus.NOT_FOUND, {"error": "not_found"}
    except AssistantSessionConflict:
        return HTTPStatus.CONFLICT, {"error": "assistant_session_input_conflict"}
    except AssistantSessionRejected as error:
        return HTTPStatus.CONFLICT, {"error": "assistant_session_rejected", "reason": error.reason}
    except AssistantSessionPersistenceError:
        return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "assistant_session_save_failed"}
    except AssistantSessionError:
        return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "assistant_session_failed"}
