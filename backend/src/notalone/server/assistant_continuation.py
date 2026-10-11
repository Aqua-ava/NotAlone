"""持续要求的公开入口；澄清先于领取与模型调用。"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, Protocol
from uuid import UUID

from notalone.application.assistant_continuation import (
    AssistantContinuationClarification, ContinueAssistantSession, parse_continuation,
)
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionError, AssistantSessionNotFound,
    AssistantSessionPersistenceError, AssistantSessionRejected, AssistantTurn,
)
from notalone.reply.errors import ReplyIdempotencyConflictError, ReplyInProgressError, ReplyPersistenceError, ReplyTimeoutError
from notalone.reply.input_budget import InputBudgetExceededError, InputBudgetUnavailableError


class ContinuationService(Protocol):
    def continue_completed(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: ContinueAssistantSession,
    ) -> AssistantTurn: ...


def handle_continuation(
    service: ContinuationService | None, *, owner_id: UUID, method: str, path: str, body: bytes,
    render_turn: Callable[[AssistantTurn], dict[str, Any]],
) -> tuple[int, dict[str, Any]]:
    parts = path.strip("/").split("/")
    if (len(parts) != 6 or parts[:2] != ["api", "contacts"]
            or parts[3] != "assistant-sessions" or parts[5] != "continue"):
        return 404, {"error": "not_found"}
    if method != "POST":
        return 405, {"error": "method_not_allowed"}
    if service is None:
        return 503, {"error": "assistant_session_unavailable"}
    try:
        command = parse_continuation(json.loads(body))
        turn = service.continue_completed(owner_id=owner_id, contact_id=UUID(parts[2]),
                                          session_id=UUID(parts[4]), command=command)
        if turn.reply is None or turn.input is None or "continuation" not in turn.input:
            raise AssistantSessionPersistenceError("持续要求尚未可靠保存。")
        return 200, {**render_turn(turn), "continuation": turn.input["continuation"],
                     "effective_input": turn.input["content"]}
    except AssistantContinuationClarification as error:
        return 409, {"error": "assistant_continuation_clarification_required", "clarification": {
            "reason": error.reason, "requirements": list(error.requirements),
            "requirement_options": [{"requirement": option.requirement, "origin": option.origin,
                                     "actions": list(option.actions)} for option in error.requirement_options],
            "requirement_actions": list(dict.fromkeys(
                action for option in error.requirement_options for action in option.actions
            )),
        }}
    except (ValueError, TypeError):
        return 400, {"error": "assistant_continuation_request_invalid"}
    except AssistantSessionNotFound:
        return 404, {"error": "not_found"}
    except (AssistantSessionConflict, ReplyIdempotencyConflictError):
        return 409, {"error": "assistant_session_input_conflict"}
    except AssistantSessionRejected as error:
        return 409, {"error": "assistant_session_rejected", "reason": error.reason}
    except ReplyInProgressError:
        return 409, {"error": "assistant_session_in_progress"}
    except InputBudgetExceededError as error:
        return 409, {"error": "input_budget_exceeded", "input_budget": error.decision.to_payload()}
    except InputBudgetUnavailableError as error:
        return 409, {"error": "input_budget_unavailable", "input_budget": error.decision.to_payload()}
    except (AssistantSessionPersistenceError, ReplyPersistenceError):
        return 503, {"error": "assistant_session_save_failed"}
    except ReplyTimeoutError:
        return 504, {"error": "reply_timeout"}
    except AssistantSessionError:
        return 500, {"error": "assistant_session_failed"}
