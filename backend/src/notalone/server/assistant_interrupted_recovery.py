"""仅接受中断身份的公开恢复入口，准备与执行沿同一 canonical 命令。"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, Protocol
from uuid import UUID

from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.application.assistant_interrupted_recovery import RecoverInterruptedAssistantGeneration, parse_interrupted_recovery
from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionPersistenceError, AssistantSessionRejected, AssistantTurn,
)
from notalone.application.reply_request import ReplyRequestInvalid
from notalone.reply.errors import ReplyIdempotencyConflictError, ReplyInProgressError, ReplyPersistenceError, ReplyTimeoutError
from notalone.reply.input_budget import InputBudgetExceededError, InputBudgetUnavailableError
from notalone.server.assistant_preparation_rejection import preparation_rejection_payload


class InterruptedRecoveryService(Protocol):
    def prepare_interrupted(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantGenerationReceipt: ...

    def recover_interrupted(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantTurn: ...


def handle_interrupted_recovery(
    service: InterruptedRecoveryService | None, *, owner_id: UUID, method: str, path: str, body: bytes,
    render_turn: Callable[[AssistantTurn], dict[str, Any]],
) -> tuple[int, dict[str, Any]]:
    parts = path.strip("/").split("/")
    if (len(parts) not in (6, 7) or parts[:2] != ["api", "contacts"] or parts[3] != "assistant-sessions"
            or parts[5] != "retry-interrupted" or len(parts) == 7 and parts[6] != "prepare"):
        return 404, {"error": "not_found"}
    if method != "POST":
        return 405, {"error": "method_not_allowed"}
    if service is None:
        return 503, {"error": "assistant_session_unavailable"}
    try:
        contact_id, session_id = UUID(parts[2]), UUID(parts[4])
        command = parse_interrupted_recovery(json.loads(body))
        if len(parts) == 7:
            receipt = service.prepare_interrupted(owner_id=owner_id, contact_id=contact_id, session_id=session_id, command=command)
            return 200, {"session_id": str(receipt.session_id), "turn_id": str(receipt.turn_id),
                         "input_version_id": str(receipt.input_version_id), "request_key": str(receipt.request_key),
                         "state": receipt.state}
        turn = service.recover_interrupted(owner_id=owner_id, contact_id=contact_id, session_id=session_id, command=command)
        if turn.input is None or turn.reply is None:
            raise AssistantSessionPersistenceError("恢复结果尚未可靠保存。")
        return 200, {**render_turn(turn), "restored_input": turn.input}
    except AssistantPreparationRejected as error:
        return preparation_rejection_payload(error)
    except (ReplyRequestInvalid, ValueError, TypeError):
        return 400, {"error": "assistant_session_request_invalid"}
    except AssistantSessionNotFound:
        return 404, {"error": "not_found"}
    except (AssistantSessionConflict, ReplyIdempotencyConflictError):
        return 409, {"error": "assistant_session_input_conflict"}
    except AssistantSessionRejected as error:
        return 409, {"error": "assistant_session_rejected", "reason": error.reason}
    except ReplyInProgressError:
        return 409, {"error": "assistant_session_in_progress"}
    except (InputBudgetExceededError, InputBudgetUnavailableError) as error:
        return 409, {"error": "input_budget_exceeded" if isinstance(error, InputBudgetExceededError) else "input_budget_unavailable",
                     "input_budget": error.decision.to_payload()}
    except (AssistantSessionPersistenceError, ReplyPersistenceError):
        return 503, {"error": "assistant_session_save_failed"}
    except ReplyTimeoutError:
        return 504, {"error": "reply_timeout"}
