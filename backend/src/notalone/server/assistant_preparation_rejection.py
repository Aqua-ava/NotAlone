"""只渲染事务提交后得到的无正文准备证明。"""

from __future__ import annotations

from typing import Any

from notalone.application.assistant_preparation_rejection import AssistantPreparationRejected
from notalone.application.assistant_session_service import AssistantSessionNotFound, AssistantSessionRejected


def preparation_rejection_payload(error: AssistantPreparationRejected) -> tuple[int, dict[str, Any]]:
    failure = error.failure
    if isinstance(failure, AssistantSessionNotFound):
        status, payload = 404, {"error": "not_found"}
    elif isinstance(failure, AssistantSessionRejected):
        status, payload = 409, {"error": "assistant_session_rejected", "reason": failure.reason}
    else:
        status, payload = 409, {"error": "assistant_session_input_conflict"}
    proof = error.proof
    return status, {**payload, "no_generation": {
        "contact_id": str(proof.contact_id), "session_id": str(proof.session_id),
        "request_key": str(proof.request_key), "state": "not_reserved",
    }}
