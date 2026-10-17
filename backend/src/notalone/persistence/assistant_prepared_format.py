"""旧准备格式只在原身份与租约可靠核对后封键，绝不重建上下文。"""

from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from notalone.persistence.assistant_continuation import _request_from_input
from notalone.reply.prepared_context_codec import PreparedContextFormatError, decode_context
from notalone.scopes import ContactScope


def requires_reprepare(row: dict[str, Any], scope: ContactScope, *, connection: Any | None = None) -> bool:
    if row.get("prepared_context") is None or row.get("input_payload") is None:
        return False
    try:
        request = _request_from_input(scope, row["idempotency_key"], row["input_payload"])
        command = request.build_command(owner_id=scope.owner_id, contact_id=scope.contact_id,
                                        binding_id=row["conversation_binding_id"])
        context = decode_context(row["prepared_context"], command)
    except (PreparedContextFormatError, TypeError, ValueError, KeyError):
        return True
    if connection is not None:
        # 政策变化同时推进目录修订；旧许可先沿原终态/租约门封键，再显式准备。
        with connection.cursor(row_factory=dict_row) as cursor:
            library = cursor.execute('SELECT revision FROM public.skill_library WHERE owner_id=%s',
                                     (scope.owner_id,)).fetchone()
        if (library['revision'] if library else 0) != context.skill_library_revision:
            return True
        from notalone.persistence.expression_preferences import _require_context_preferences
        from notalone.reply.errors import ReplyExpressionPreferencesChangedError
        try:
            _require_context_preferences(connection, context)
        except ReplyExpressionPreferencesChangedError:
            return True
    return False


def check_prepared_format(connection: Any, scope: ContactScope, session_id: UUID,
                          request_key: UUID, *, complete_saved: Any) -> str | None:
    """调用方持有 owner 锁；返回拒绝原因，必须提交之后才抛公开错误。"""
    from notalone.persistence.assistant_generation_lifecycle import require_interruption_input

    turn = connection.execute(
        "SELECT * FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s "
        "AND session_id=%s AND idempotency_key=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, session_id, request_key),
    ).fetchone()
    if turn is None or turn["state"] in ("redacted", "unavailable") or not requires_reprepare(turn, scope, connection=connection):
        return None
    binding_id = require_interruption_input(connection, scope, session_id, turn["id"],
                                             request_key, turn["input_version_id"])
    request = connection.execute(
        "SELECT id,state,attempt,conversation_binding_id FROM public.reply_request "
        "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, request_key),
    ).fetchone()
    if request is None:
        if turn["reply_request_id"] is not None or turn["state"] == "completed":
            return "prepared_context_generation_unconfirmed"
    else:
        if (request["conversation_binding_id"] != binding_id
                or turn["reply_request_id"] not in (None, request["id"])):
            return "prepared_context_generation_unconfirmed"
        from notalone.application.assistant_session_service import AssistantSessionRejected
        from notalone.persistence.style_sample_store import require_reply_sources_current
        from notalone.reply.errors import ReplyStoreInvariantError
        try:
            require_reply_sources_current(connection, owner_id=scope.owner_id,
                                          request_id=request["id"], historical=True)
        except ReplyStoreInvariantError:
            raise AssistantSessionRejected("source_unavailable") from None
        attempts = connection.execute(
            "SELECT number,state FROM public.reply_attempt WHERE reply_request_id=%s ORDER BY number FOR UPDATE",
            (request["id"],),
        ).fetchall()
        if any(item["state"] == "running" for item in attempts):
            return "prepared_context_generation_running"
        latest = next((item for item in attempts if item["number"] == request["attempt"]), None)
        terminal_attempt_states = {
            "completed": ("completed",), "failed": ("failed", "expired"), "expired": ("expired",),
        }.get(request["state"], ())
        if (latest is None or any(item["number"] > request["attempt"] for item in attempts)
                or latest["state"] not in terminal_attempt_states):
            return "prepared_context_generation_unconfirmed"
        if request["state"] == "completed":
            complete_saved(connection, scope, session_id, turn["id"], request["id"])
            return None
    # 零 C 或可靠失败才能封旧键；原正文、编辑、输入 UUID 与所有历史 attempt 保持。
    connection.execute(
        "INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES (%s,%s,%s) "
        "ON CONFLICT (owner_id,contact_id,idempotency_key) DO NOTHING",
        (scope.owner_id, scope.contact_id, request_key),
    )
    connection.execute(
        "UPDATE public.assistant_session_turn SET state='failed',updated_at=now() "
        "WHERE id=%s AND state IN ('running','failed')", (turn["id"],),
    )
    return "prepared_context_reprepare_required"
