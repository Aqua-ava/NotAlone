"""生成领取与退出的无正文身份；执行仍由既有助手会话边界负责。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.application.reply_service import ReplyServiceRequest


@dataclass(frozen=True, slots=True, repr=False)
class AssistantGenerationReceipt:
    session_id: UUID
    turn_id: UUID
    request_key: UUID
    input_version_id: UUID
    state: str
    interruption_reason: str | None = None


@dataclass(frozen=True, slots=True, repr=False)
class AssistantPreparationFormatReceipt:
    generation: AssistantGenerationReceipt
    format_status: str


class AssistantGenerationLifecyclePort(Protocol):
    def preparation_format(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request_key: UUID, input_version_id: UUID,
    ) -> AssistantPreparationFormatReceipt: ...
    def prepare(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt: ...

    def interrupt(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request_key: UUID, input_version_id: UUID, reason: str = "app_quit",
    ) -> AssistantGenerationReceipt: ...
