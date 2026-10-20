"""生成中替换的事务入口；只失效本会话的显式旧请求。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from notalone.application.assistant_session_service import (
    AssistantSessionNotFound, AssistantSessionPersistenceError, AssistantSessionRejected,
)
from notalone.persistence.assistant_session_inputs import require_current_input
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.reply_sources import require_reply_sources_current
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope


def invalidate_running_generation(
    connection: Any, scope: ContactScope, session_id: UUID,
    turn_id: UUID, expected_input_version_id: UUID,
    *, invalidation_reason: str = "generation_replaced",
) -> bool:
    """复用调用方事务，不另开连接，也不承诺供应商停止计算。

    成功后讨论与来源依赖继续保留，原键失效凭证只包含内部标识。
    调用方负责把此操作和新输入领取放在同一事务中。
    """

    if (invalidation_reason not in ("generation_replaced", "app_quit", "configuration_reload")
            or not isinstance(scope, ContactScope)
            or any(not isinstance(value, UUID) for value in (
                session_id, turn_id, expected_input_version_id,
            ))):
        raise AssistantSessionRejected("invalid_generation_replacement")
    lock_owner_scope(connection, owner_id=scope.owner_id)
    if invalidation_reason == "generation_replaced":
        require_current_input(connection, scope, session_id, expected_input_version_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        turn = cursor.execute(
            "SELECT input_version_id, idempotency_key, state FROM public.assistant_session_turn "
            "WHERE owner_id = %s AND contact_id = %s AND session_id = %s AND id = %s FOR UPDATE",
            (scope.owner_id, scope.contact_id, session_id, turn_id),
        ).fetchone()
        if turn is None:
            raise AssistantSessionNotFound("指定范围内不存在助手讨论。")
        if turn["input_version_id"] != expected_input_version_id:
            raise AssistantSessionRejected("input_version_stale")
        interruption_binding_id = None
        if invalidation_reason in ("app_quit", "configuration_reload"):
            from notalone.persistence.assistant_generation_lifecycle import require_interruption_input
            interruption_binding_id = require_interruption_input(
                connection, scope, session_id, turn_id, turn["idempotency_key"], expected_input_version_id,
            )
        request = cursor.execute(
            "SELECT id, state, attempt, conversation_binding_id FROM public.reply_request "
            "WHERE owner_id = %s AND contact_id = %s AND idempotency_key = %s FOR UPDATE",
            (scope.owner_id, scope.contact_id, turn["idempotency_key"]),
        ).fetchone()
        if request is not None:
            if invalidation_reason in ("app_quit", "configuration_reload") and request["conversation_binding_id"] != interruption_binding_id:
                raise AssistantSessionRejected("binding_changed")
            try:
                require_reply_sources_current(cursor, owner_id=scope.owner_id, request_id=request["id"])
            except ReplyStoreInvariantError:
                raise AssistantSessionRejected("source_unavailable") from None
        invalidated = cursor.execute(
            "SELECT 1 FROM public.reply_invalidated_key "
            "WHERE owner_id = %s AND contact_id = %s AND idempotency_key = %s",
            (scope.owner_id, scope.contact_id, turn["idempotency_key"]),
        ).fetchone()
        if (turn["state"] == "failed" and invalidated is not None and request is not None
                and request["state"] == "failed" and cursor.execute(
                    "SELECT 1 FROM public.reply_attempt WHERE reply_request_id = %s AND number = %s "
                    "AND state = 'failed' AND failure_reason = %s",
                    (request["id"], request["attempt"], invalidation_reason),
                ).fetchone() is not None):
            return False
        if invalidated is not None:
            raise AssistantSessionRejected("request_deleted")
        # 同键重试不会把历史 failed turn 预写成 running；是否运行以当前回复租约为准。
        if (turn["state"] not in ("running", "failed")
                or (request is None and turn["state"] != "running")
                or (request is not None and request["state"] != "running")):
            raise AssistantSessionRejected("generation_not_running")
        cursor.execute(
            "INSERT INTO public.reply_invalidated_key (owner_id, contact_id, idempotency_key) "
            "VALUES (%s, %s, %s) ON CONFLICT (owner_id, contact_id, idempotency_key) DO NOTHING",
            (scope.owner_id, scope.contact_id, turn["idempotency_key"]),
        )
        if request is not None:
            changed = cursor.execute(
                "UPDATE public.reply_request SET state = 'failed', "
                "lease_expires_at = least(lease_expires_at, now()), updated_at = now() "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s AND state = 'running'",
                (scope.owner_id, scope.contact_id, request["id"]),
            ).rowcount
            if changed != 1:
                raise AssistantSessionPersistenceError("旧回复请求未完整失效。")
            changed = cursor.execute(
                "UPDATE public.reply_attempt SET state = 'failed', failure_reason = %s, "
                "lease_expires_at = least(lease_expires_at, now()) "
                "WHERE reply_request_id = %s AND number = %s AND state = 'running'",
                (invalidation_reason, request["id"], request["attempt"]),
            ).rowcount
            if changed != 1:
                raise AssistantSessionPersistenceError("旧回复租约未完整失效。")
        changed = cursor.execute(
            "UPDATE public.assistant_session_turn SET state = 'failed', updated_at = now() "
            "WHERE owner_id = %s AND contact_id = %s AND session_id = %s AND id = %s "
            "AND state IN ('running', 'failed')",
            (scope.owner_id, scope.contact_id, session_id, turn_id),
        ).rowcount
        if changed != 1:
            raise AssistantSessionPersistenceError("旧助手讨论未完整失效。")
    return True
