"""明确长期表达偏好的应用服务与持久化端口。"""
from __future__ import annotations

from typing import Protocol
from uuid import UUID
from notalone.scopes import ContactScope
from notalone.reply.expression_preference_models import (
    EXPRESSION_REPLY_MODES, ExpressionReplyMode, ExpressionPreferenceScope,
    ExpressionPreference, ExpressionPreferenceSnapshot, SaveExpressionPreference,
    UpdateExpressionPreference, DeleteExpressionPreference, ExpressionPreferenceError,
    ExpressionPreferenceNotFound, ExpressionPreferenceDeleted, ExpressionPreferenceConflict,
)

class ExpressionPreferencePort(Protocol):
    """用户管理与后续有界读取共用独立偏好身份，不包含Skill权限。"""

    def save(self, command: SaveExpressionPreference, *, contact_id: UUID | None = None) -> ExpressionPreference: ...
    def list(self, owner_id: UUID, *, contact_id: UUID | None = None) -> tuple[ExpressionPreference, ...]: ...
    def read(self, owner_id: UUID, preference_id: UUID, *, contact_id: UUID | None = None) -> ExpressionPreference: ...
    def update(self, preference_id: UUID, command: UpdateExpressionPreference, *, contact_id: UUID | None = None) -> ExpressionPreference: ...
    def delete(self, owner_id: UUID, preference_id: UUID, command: DeleteExpressionPreference, *, contact_id: UUID | None = None) -> None: ...
    def select_applicable(self, scope: ContactScope, reply_mode: ExpressionReplyMode) -> ExpressionPreferenceSnapshot: ...
    def validate_snapshot(self, scope: ContactScope, reply_mode: ExpressionReplyMode, snapshot: ExpressionPreferenceSnapshot) -> None: ...


class ExpressionPreferenceService:
    def __init__(self, store: ExpressionPreferencePort) -> None:
        self._store = store

    def save(self, command: SaveExpressionPreference, *, contact_id: UUID | None = None) -> ExpressionPreference:
        return self._store.save(command, contact_id=contact_id)

    def list(self, owner_id: UUID, *, contact_id: UUID | None = None) -> tuple[ExpressionPreference, ...]:
        return self._store.list(owner_id, contact_id=contact_id)

    def read(self, owner_id: UUID, preference_id: UUID, *, contact_id: UUID | None = None) -> ExpressionPreference:
        return self._store.read(owner_id, preference_id, contact_id=contact_id)

    def update(self, preference_id: UUID, command: UpdateExpressionPreference, *, contact_id: UUID | None = None) -> ExpressionPreference:
        return self._store.update(preference_id, command, contact_id=contact_id)

    def delete(self, owner_id: UUID, preference_id: UUID, command: DeleteExpressionPreference, *, contact_id: UUID | None = None) -> None:
        self._store.delete(owner_id, preference_id, command, contact_id=contact_id)
