"""在既有 owner 事务内裁定退出；不另开连接或建立第二条回复 writer。"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.application.assistant_session_service import (
    AssistantSessionNotFound, AssistantSessionPersistenceError, AssistantSessionRejected, AssistantTurn,
)
from notalone.persistence.assistant_generation_replacement import invalidate_running_generation
from notalone.persistence.assistant_session_inputs import require_input_session
from notalone.persistence.assistant_session_store import _dependencies_available
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope


CompleteSavedGeneration = Callable[[Any, ContactScope, UUID, UUID, UUID], AssistantTurn]


def _receipt(turn: dict[str, Any]) -> AssistantGenerationReceipt:
    return AssistantGenerationReceipt(
        session_id=turn["session_id"], turn_id=turn["id"], request_key=turn["idempotency_key"],
        input_version_id=turn["input_version_id"], state=turn["state"],
        interruption_reason=turn["interruption_reason"] if turn["state"] == "failed" else None,
    )


def require_interruption_input(
    connection: Any, scope: ContactScope, session_id: UUID,
    turn_id: UUID, request_key: UUID, input_version_id: UUID,
) -> UUID:
    """终止凭证复验原输入，不要求它仍是 CURRENT，也不恢复正文。"""

    with connection.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            "SELECT input.state, input.input_type, input.conversation_binding_id, input.dependency_ids, "
            "turn.state AS turn_state, turn.conversation_binding_id AS turn_binding_id, "
            "turn.dependency_ids AS turn_dependencies "
            "FROM public.assistant_session_input AS input JOIN public.assistant_session_turn AS turn "
            "ON turn.id = input.turn_id AND turn.input_version_id = input.id "
            "AND turn.owner_id = input.owner_id AND turn.contact_id = input.contact_id "
            "AND turn.session_id = input.session_id "
            "WHERE input.owner_id = %s AND input.contact_id = %s AND input.session_id = %s "
            "AND input.id = %s AND turn.id = %s AND turn.idempotency_key = %s",
            (scope.owner_id, scope.contact_id, session_id, input_version_id, turn_id, request_key),
        ).fetchone()
        if row is None or row["input_type"] != "generation":
            raise AssistantSessionRejected("input_version_stale")
        if row["state"] == "redacted" or row["turn_state"] == "redacted":
            raise AssistantSessionRejected("source_deleted")
        if row["conversation_binding_id"] != row["turn_binding_id"]:
            raise AssistantSessionRejected("binding_changed")
        if not _dependencies_available(cursor, scope.owner_id, set(row["dependency_ids"]) | set(row["turn_dependencies"])):
            raise AssistantSessionRejected("source_unavailable")
        return row["conversation_binding_id"]


def interrupt_generation_in_transaction(
    connection: Any, scope: ContactScope, session_id: UUID,
    request_key: UUID, input_version_id: UUID, *, complete_saved: CompleteSavedGeneration,
) -> AssistantGenerationReceipt:
    """退出凭证只有内部 UUID 和稳定分类；已可靠保存的 C 结果先赢。

    complete_saved 来自原 A Store 的唯一完成 writer，必须复用本连接；
    此模块既不创建候选，也不复制一套完成或 C attempt 写入逻辑。
    """

    if (not isinstance(scope, ContactScope)
            or any(not isinstance(value, UUID) for value in (session_id, request_key, input_version_id))):
        raise AssistantSessionRejected("invalid_generation_interruption")
    lock_owner_scope(connection, owner_id=scope.owner_id)
    with connection.cursor(row_factory=dict_row) as cursor:
        require_input_session(cursor, scope, session_id)
        turn = cursor.execute(
            "SELECT * FROM public.assistant_session_turn WHERE owner_id = %s AND contact_id = %s "
            "AND session_id = %s AND idempotency_key = %s FOR UPDATE",
            (scope.owner_id, scope.contact_id, session_id, request_key),
        ).fetchone()
        if turn is None:
            raise AssistantSessionNotFound("指定会话内不存在生成请求。")
        if turn["input_version_id"] != input_version_id:
            raise AssistantSessionRejected("input_version_stale")
        if turn["state"] == "redacted":
            raise AssistantSessionRejected("source_deleted")
        binding_id = require_interruption_input(
            connection, scope, session_id, turn["id"], request_key, input_version_id,
        )
        request = cursor.execute(
            "SELECT id, state, attempt, conversation_binding_id FROM public.reply_request WHERE owner_id = %s "
            "AND contact_id = %s AND idempotency_key = %s FOR UPDATE",
            (scope.owner_id, scope.contact_id, request_key),
        ).fetchone()
        if request is not None:
            if request["conversation_binding_id"] != binding_id:
                raise AssistantSessionRejected("binding_changed")
            try:
                require_reply_sources_current(cursor, owner_id=scope.owner_id, request_id=request["id"])
            except ReplyStoreInvariantError:
                raise AssistantSessionRejected("source_unavailable") from None
        if request is not None and request["state"] == "completed":
            if turn["interruption_reason"] is not None:
                raise AssistantSessionRejected("generation_interrupted")
            completed = complete_saved(connection, scope, session_id, turn["id"], request["id"])
            if (completed.state != "completed" or completed.reply is None
                    or completed.reply.reply_request_id != request["id"]):
                raise AssistantSessionPersistenceError("已保存回复未可靠恢复到原助手讨论。")
            return AssistantGenerationReceipt(session_id, turn["id"], request_key, input_version_id, "completed")
        if turn["interruption_reason"] == "app_quit":
            invalidated = cursor.execute(
                "SELECT 1 FROM public.reply_invalidated_key WHERE owner_id = %s "
                "AND contact_id = %s AND idempotency_key = %s",
                (scope.owner_id, scope.contact_id, request_key),
            ).fetchone()
            attempt = None if request is None else cursor.execute(
                "SELECT 1 FROM public.reply_attempt WHERE reply_request_id = %s AND number = %s "
                "AND state = 'failed' AND failure_reason = 'app_quit'",
                (request["id"], request["attempt"]),
            ).fetchone()
            if (turn["state"] != "failed" or invalidated is None
                    or request is not None and (request["state"] != "failed" or attempt is None)):
                raise AssistantSessionPersistenceError("退出中断凭证不完整。")
            return _receipt(turn)
        if turn["state"] == "failed" and request is not None and request["state"] == "failed":
            # 历史 failed 不足以证明任务停止；同事务复验 C 最新 attempt 且没有运行租约。
            terminal = cursor.execute(
                "SELECT 1 FROM public.reply_attempt AS attempt "
                "WHERE attempt.reply_request_id = %s AND attempt.number = %s "
                "AND attempt.state IN ('failed', 'expired') "
                "AND attempt.failure_reason IS DISTINCT FROM 'app_quit' AND NOT EXISTS ("
                "SELECT 1 FROM public.reply_attempt AS running "
                "WHERE running.reply_request_id = attempt.reply_request_id AND running.state = 'running')",
                (request["id"], request["attempt"]),
            ).fetchone()
            if terminal is None:
                raise AssistantSessionPersistenceError("失败生成终态尚未可靠确认。")
            return _receipt(turn)
        invalidate_running_generation(
            connection, scope, session_id, turn["id"], input_version_id, invalidation_reason="app_quit",
        )
        changed = cursor.execute(
            "UPDATE public.assistant_session_turn SET interruption_reason = 'app_quit', updated_at = now() "
            "WHERE owner_id = %s AND contact_id = %s AND session_id = %s AND id = %s "
            "AND state = 'failed' AND interruption_reason IS NULL",
            (scope.owner_id, scope.contact_id, session_id, turn["id"]),
        ).rowcount
        if changed != 1:
            raise AssistantSessionPersistenceError("退出中断未可靠记录。")
        turn["state"], turn["interruption_reason"] = "failed", "app_quit"
        return _receipt(turn)
