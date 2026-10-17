"""候选版本公开入口；正文、来源及实际选择均复用既有存储权威。"""

from __future__ import annotations

import json
from urllib.parse import parse_qs
from uuid import UUID

from notalone.persistence.assistant_candidate_versions import (
    AssistantCandidateEditReceipt,
    AssistantCandidateHistory,
    AssistantCandidateSelection,
    AssistantCandidateVersionConflict,
    AssistantCandidateVersionError,
    AssistantCandidateVersionNotFound,
    AssistantCandidateVersionPage,
    AssistantCandidateVersionPersistenceError,
    AssistantCandidateVersions,
    EditAssistantCandidate,
)
from notalone.reply.interface import CandidateMessage
from notalone.scopes import ContactScope


def _edit_command(body: bytes) -> EditAssistantCandidate:
    payload = json.loads(body)
    required = {"edit_key", "parent_version_id", "messages"}
    if (not isinstance(payload, dict) or not required <= set(payload)
            or set(payload) - required - {"requirements"}
            or not isinstance(payload["edit_key"], str)
            or not isinstance(payload["parent_version_id"], str)
            or not isinstance(payload["messages"], list)
            or any(not isinstance(message, dict) or set(message) != {"message_id", "text"}
                   or not isinstance(message["message_id"], str)
                   or not isinstance(message["text"], str) for message in payload["messages"])):
        raise ValueError
    return EditAssistantCandidate(
        UUID(payload["edit_key"]), UUID(payload["parent_version_id"]),
        tuple(CandidateMessage(UUID(message["message_id"]), message["text"])
              for message in payload["messages"]),
        payload.get("requirements"),
    )


def _history_payload(history: AssistantCandidateHistory) -> dict[str, object]:
    return {
        "session_id": str(history.session_id),
        "turn_id": str(history.turn_id),
        "candidate_id": str(history.candidate_id),
        "candidate_group_id": str(history.candidate_group_id),
        "candidate_number": history.candidate_number,
        "default_display_version_id": str(history.default_display_version_id),
        "selected_version_id": (str(history.selected_version_id)
                                if history.selected_version_id is not None else None),
        **({"basis_changes": [change.to_payload() for change in history.basis_changes]}
           if history.basis_changes else {}),
        "versions": [{
            "version_id": str(version.version_id),
            "version_number": version.version_number,
            "parent_version_id": (str(version.parent_version_id)
                                  if version.parent_version_id is not None else None),
            "text": version.text,
            "messages": [{"message_id": str(message.message_id), "text": message.text}
                         for message in version.messages],
            "requirements": version.requirements,
            "created_at": version.created_at.isoformat(),
        } for version in history.versions],
    }


def _selection_payload(selection: AssistantCandidateSelection) -> dict[str, object]:
    return {
        "selection_id": str(selection.selection_id),
        "selection_number": selection.selection_number,
        "session_id": str(selection.session_id),
        "candidate_id": str(selection.candidate_id),
        "version_id": str(selection.version_id),
    }


def _page_payload(page: AssistantCandidateVersionPage) -> dict[str, object]:
    payload = _history_payload(page.history)
    del payload["selected_version_id"]
    # 正式 052/053 限制整组正文和要求；每页完整一版，最坏 JSON 转义仍低于 1 MiB。
    payload.update(page_number=page.page_number, version_count=page.version_count,
                   next_page=(page.page_number + 1 if page.page_number + 1 < page.version_count else None))
    return payload


def _edit_receipt_payload(receipt: AssistantCandidateEditReceipt) -> dict[str, object]:
    return {"session_id": str(receipt.session_id), "candidate_id": str(receipt.candidate_id),
            "version_id": str(receipt.version_id), "version_number": receipt.version_number,
            "edit_key": str(receipt.edit_key), "parent_version_id": str(receipt.parent_version_id)}


def _select(
    store: AssistantCandidateVersions, scope: ContactScope, session_id: UUID, body: bytes,
) -> dict[str, object]:
    payload = json.loads(body)
    if (not isinstance(payload, dict)
            or set(payload) != {"selection_key", "candidate_id", "version_id"}
            or any(not isinstance(value, str) for value in payload.values())):
        raise ValueError
    return _selection_payload(store.select(
        scope, session_id, UUID(payload["candidate_id"]), UUID(payload["version_id"]),
        UUID(payload["selection_key"]),
    ))


def candidate_versions_path(parts: list[str]) -> str | None:
    """统一识别候选版本和选择路径，供宿主分派与独立 handler 复用。"""

    if parts[:2] != ["api", "contacts"] or len(parts) < 4 or parts[3] != "assistant-sessions":
        return None
    if len(parts) == 8 and parts[5] == "candidates" and parts[7] == "versions":
        return "versions"
    if len(parts) == 6 and parts[5] == "selections":
        return "selections"
    return None


def handle_candidate_versions(
    store: AssistantCandidateVersions | None, *, owner_id: UUID,
    method: str, path: str, body: bytes, query: str = "",
) -> tuple[int, dict[str, object]]:
    parts = path.strip("/").split("/")
    route = candidate_versions_path(parts)
    if route is None:
        return 404, {"error": "not_found"}
    if store is None:
        return 503, {"error": "assistant_candidate_version_unavailable"}
    try:
        scope = ContactScope(owner_id, UUID(parts[2]))
        session_id = UUID(parts[4])
        parameters = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
        if any(len(values) != 1 for values in parameters.values()):
            raise ValueError
        if route == "versions" and method == "GET":
            if parameters:
                if (set(parameters) - {"page", "through"} or "page" not in parameters
                        or not parameters["page"][0].isascii() or not parameters["page"][0].isdigit()):
                    raise ValueError
                number = int(parameters["page"][0])
                through = UUID(parameters["through"][0]) if "through" in parameters else None
                return 200, _page_payload(store.read_page(scope, session_id, UUID(parts[6]), number, through))
            return 200, _history_payload(store.read(scope, session_id, UUID(parts[6])))
        if route == "versions" and method == "POST":
            if parameters:
                if parameters != {"receipt": ["1"]}:
                    raise ValueError
                return 200, _edit_receipt_payload(store.edit_receipt(
                    scope, session_id, UUID(parts[6]), _edit_command(body),
                ))
            return 200, _history_payload(store.edit(
                scope, session_id, UUID(parts[6]), _edit_command(body),
            ))
        if parameters:
            raise ValueError
        if route == "selections" and method == "GET":
            selection = store.selected(scope, session_id)
            return 200, {"selection": (_selection_payload(selection)
                                      if selection is not None else None)}
        if route == "selections" and method == "POST":
            return 200, _select(store, scope, session_id, body)
        return 405, {"error": "method_not_allowed"}
    except (ValueError, TypeError):
        return 400, {"error": "assistant_candidate_version_request_invalid"}
    except AssistantCandidateVersionNotFound:
        return 404, {"error": "not_found"}
    except AssistantCandidateVersionConflict as error:
        return 409, {"error": "assistant_candidate_version_conflict", "reason": error.reason}
    except AssistantCandidateVersionPersistenceError:
        return 503, {"error": "assistant_candidate_version_save_failed"}
    except AssistantCandidateVersionError:
        return 503, {"error": "assistant_candidate_version_unavailable"}
