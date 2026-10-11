"""持久探索公开操作；owner来自认证宿主，输入UUID来自助手会话。"""

import json
from typing import Any, Callable, Literal, overload
from uuid import UUID

from notalone.application.assistant_session_service import AssistantSessionError, AssistantSessionRejected, AssistantTurn
from notalone.application.model_priority import ModelWorkStopped
from notalone.application.reply_exploration import ReplyExplorationService
from notalone.reply.errors import ReplyError
from notalone.reply.exploration import ExplorationError, ExplorationInput
from notalone.reply.input_budget import InputBudgetExceededError, InputBudgetUnavailableError
from notalone.scopes import ContactScope


def _json(body: bytes, allowed: set[str]) -> dict[str, Any]:
    payload = json.loads(body)
    if not isinstance(payload, dict) or not set(payload) <= allowed:
        raise ValueError
    return payload


@overload
def _uuid(payload: dict[str, Any], field: str, *, optional: Literal[False] = False) -> UUID: ...


@overload
def _uuid(payload: dict[str, Any], field: str, *, optional: Literal[True]) -> UUID | None: ...


def _uuid(payload: dict[str, Any], field: str, *, optional: bool = False) -> UUID | None:
    value = payload.get(field)
    if optional and value is None:
        return None
    if not isinstance(value, str):
        raise ValueError
    return UUID(value)


def _text(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field, "")
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError
    return value.strip()


def _content(payload: Any) -> ExplorationInput:
    if not isinstance(payload, dict):
        raise ValueError
    kind = payload.get("type")
    primary = {"target_message_id"} if kind == "response_exploration" else {"purpose_hint"}
    if kind not in ("response_exploration", "purpose_exploration") or not set(payload) <= {
        "type", "correction", "requirements", "skill_mode", "skill_version_id", *primary,
    }:
        raise ValueError
    return ExplorationInput(
        "reply_to_message" if kind == "response_exploration" else "initiate_conversation",
        target_message_id=_uuid(payload, "target_message_id") if kind == "response_exploration" else None,
        purpose_hint=_text(payload, "purpose_hint"), correction=_text(payload, "correction"),
        requirements=_text(payload, "requirements"), skill_mode=payload.get("skill_mode", "auto"),
        skill_version_id=_uuid(payload, "skill_version_id", optional=True),
    )


def handle_exploration(
    service: ReplyExplorationService | None, *, owner_id: UUID, method: str, path: str, body: bytes,
    render_turn: Callable[[AssistantTurn], dict[str, Any]],
) -> tuple[int, dict[str, Any]]:
    if service is None:
        return 503, {"error": "exploration_unavailable"}
    parts = path.strip("/").split("/")
    try:
        if (len(parts) not in (6, 7, 8) or parts[:2] != ["api", "contacts"]
                or parts[3] != "assistant-sessions" or parts[5] != "explorations"):
            return 404, {"error": "not_found"}
        scope, session_id = ContactScope(owner_id, UUID(parts[2])), UUID(parts[4])
        if len(parts) == 6 and method == "POST":
            request = _json(body, {"content", "operation_key", "expected_input_version_id", "previous_id", "automatic", "change_group"})
            for flag in ("automatic", "change_group"):
                if flag in request and not isinstance(request[flag], bool):
                    raise ValueError
            result = service.open(scope=scope, session_id=session_id, content=_content(request.get("content")),
                                  operation_key=_uuid(request, "operation_key"),
                                  expected_input_version_id=_uuid(request, "expected_input_version_id", optional=True),
                                  previous_id=_uuid(request, "previous_id", optional=True),
                                  automatic=request.get("automatic", False), change_group=request.get("change_group", False))
        elif len(parts) == 7 and method == "GET":
            result = service.read(scope=scope, exploration_id=UUID(parts[6]))
            if result["session_id"] != str(session_id):
                raise ExplorationError("探索不属于当前助手会话。")
        elif len(parts) == 8 and method == "POST":
            exploration_id = UUID(parts[6])
            action = parts[7]
            if action in ("confirm", "prepare-confirm"):
                request = _json(body, {"input_version_id", "suggestion_id", "direct_intent"})
                result = service.confirm(scope=scope, session_id=session_id, exploration_id=exploration_id,
                                         input_version_id=_uuid(request, "input_version_id"),
                                         suggestion_id=_uuid(request, "suggestion_id", optional=True),
                                         direct_intent=_text(request, "direct_intent") if "direct_intent" in request else None,
                                         prepare_only=action == "prepare-confirm")
            elif action == "reconfirm":
                request = _json(body, {"input_version_id", "expected_input_version_id", "request_key", "suggestion_id", "direct_intent"})
                result = service.reconfirm(scope=scope, session_id=session_id, exploration_id=exploration_id,
                                           input_version_id=_uuid(request, "input_version_id"),
                                           expected_input_version_id=_uuid(request, "expected_input_version_id"),
                                           request_key=_uuid(request, "request_key"),
                                           suggestion_id=_uuid(request, "suggestion_id", optional=True),
                                           direct_intent=_text(request, "direct_intent") if "direct_intent" in request else None)
            elif action in ("answer", "prepare-answer"):
                request = _json(body, {"input_version_id", "question_id", "answer", "operation_key"})
                result = service.answer(scope=scope, session_id=session_id, exploration_id=exploration_id,
                                        input_version_id=_uuid(request, "input_version_id"), question_id=_uuid(request, "question_id"),
                                        answer=_text(request, "answer"), operation_key=_uuid(request, "operation_key"),
                                        prepare_only=action == "prepare-answer")
            elif action == "stop":
                request = _json(body, {"input_version_id"})
                service.require_session(scope=scope, session_id=session_id, exploration_id=exploration_id)
                service.stop(scope=scope, exploration_id=exploration_id, input_version_id=_uuid(request, "input_version_id"))
                result = {"kind": "paused", "exploration_id": str(exploration_id), "input_version_id": request["input_version_id"]}
            else:
                return 404, {"error": "not_found"}
        else:
            return 405, {"error": "method_not_allowed"}
        if result["kind"] == "generated":
            result = {**result, "turn": render_turn(result["turn"])}
        elif result["kind"] == "prepared":
            receipt = result["generation"]
            result = {**result, "generation": {
                "session_id": str(receipt.session_id), "turn_id": str(receipt.turn_id),
                "request_key": str(receipt.request_key), "input_version_id": str(receipt.input_version_id),
                "state": receipt.state,
            }}
        return 200, result
    except (ValueError, TypeError, KeyError, AttributeError):
        return 400, {"error": "exploration_request_invalid"}
    except (InputBudgetExceededError, InputBudgetUnavailableError) as error:
        return 409, {"error": "exploration_rejected", "input_budget": error.decision.to_payload()}
    except (ExplorationError, AssistantSessionRejected):
        return 409, {"error": "exploration_rejected"}
    except (AssistantSessionError, ReplyError, ModelWorkStopped):
        return 503, {"error": "exploration_failed"}
