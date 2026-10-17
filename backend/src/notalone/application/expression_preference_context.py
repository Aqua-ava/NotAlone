"""将独立偏好读取接入既有回复上下文，不改变当前用户意图。"""

from __future__ import annotations

from dataclasses import replace

from notalone.application.expression_preference_service import (
    ExpressionPreferenceConflict, ExpressionPreferenceDeleted, ExpressionPreferenceError,
    ExpressionPreferenceNotFound, ExpressionPreferencePort, ExpressionPreferenceSnapshot,
)
from notalone.reply.context import ReplyContext, ReplyContextPort
from notalone.reply.errors import ReplyContextError, ReplyExpressionPreferencesChangedError
from notalone.reply.expression_preferences import expression_reply_mode, require_preference_contract
from notalone.reply.interface import RewriteDraft


class ExpressionPreferenceContext:
    def __init__(self, context: ReplyContextPort, preferences: ExpressionPreferencePort) -> None:
        self._context = context
        self._preferences = preferences

    def build(self, **kwargs) -> ReplyContext:
        context = self._context.build(**kwargs)
        try:
            snapshot = self._preferences.select_applicable(context.scope, expression_reply_mode(context.command))
        except ExpressionPreferenceError:
            raise ReplyContextError("长期表达偏好读取失败。") from None
        require_preference_contract(context.scope, expression_reply_mode(context.command), snapshot.preferences, snapshot.revision)
        content = context.command.content
        # 本次要求非空时不注入长期偏好；整体修订仍拦截在途变化。
        preferences = (() if isinstance(content, RewriteDraft) and content.user_instruction
                       and content.user_instruction.strip() else snapshot.preferences)
        return replace(context, expression_preferences=preferences, expression_preference_revision=snapshot.revision)

    def validate_current(self, context: ReplyContext) -> None:
        self._context.validate_current(context)
        mode = expression_reply_mode(context.command)
        require_preference_contract(context.scope, mode, context.expression_preferences, context.expression_preference_revision)
        try:
            self._preferences.validate_snapshot(context.scope, mode, ExpressionPreferenceSnapshot(
                context.expression_preference_revision, context.expression_preferences,
            ))
        except (ExpressionPreferenceConflict, ExpressionPreferenceDeleted, ExpressionPreferenceNotFound):
            raise ReplyExpressionPreferencesChangedError("长期表达偏好或来源已变化，请重新生成。") from None
        except ExpressionPreferenceError:
            raise ReplyContextError("长期表达偏好复验失败。") from None
