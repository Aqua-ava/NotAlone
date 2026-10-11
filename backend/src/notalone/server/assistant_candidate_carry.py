"""显式携候选命令只接收真实身份，不接收客户端正文或临时要求。"""

from __future__ import annotations

import json
from uuid import UUID

from notalone.application.assistant_candidate_carry import CarryAssistantCandidate


def parse_candidate_carry_request(body: bytes) -> CarryAssistantCandidate:
    try:
        payload = json.loads(body)
        if (not isinstance(payload, dict)
                or set(payload) != {"expected_selection_id", "candidate_id", "version_id"}
                or any(not isinstance(value, str) for value in payload.values())):
            raise ValueError
        identifiers = {field: UUID(value) for field, value in payload.items()}
        if any(str(identifiers[field]) != value for field, value in payload.items()):
            raise ValueError
        return CarryAssistantCandidate(**identifiers)
    except (TypeError, ValueError, UnicodeDecodeError):
        raise ValueError("携候选请求结构无效。") from None
