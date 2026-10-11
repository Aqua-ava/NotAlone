"""中断恢复只接受原身份；正文由唯一会话 authority 重建。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from notalone.application.reply_request import ReplyRequestInvalid


@dataclass(frozen=True, slots=True, repr=False)
class RecoverInterruptedAssistantGeneration:
    original_turn_id: UUID
    original_input_version_id: UUID
    request_key: UUID

    def origin(self) -> dict[str, str]:
        return {"original_turn_id": str(self.original_turn_id),
                "original_input_version_id": str(self.original_input_version_id)}


def parse_interrupted_recovery(value: Any) -> RecoverInterruptedAssistantGeneration:
    fields = ("original_turn_id", "original_input_version_id", "request_key")
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ReplyRequestInvalid()
    try:
        if any(not isinstance(value[field], str) for field in fields):
            raise ValueError()
        return RecoverInterruptedAssistantGeneration(*(UUID(value[field]) for field in fields))
    except (ValueError, TypeError):
        raise ReplyRequestInvalid() from None
