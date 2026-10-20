"""PostgreSQL长期表达偏好；每个持久变更来自明确用户操作。"""

from __future__ import annotations

from hashlib import sha256
import json
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.application.expression_preference_service import (
    ExpressionPreference, ExpressionPreferenceConflict, ExpressionPreferenceDeleted,
    ExpressionPreferenceError, ExpressionPreferenceNotFound, ExpressionPreferenceScope,
    SaveExpressionPreference, UpdateExpressionPreference, DeleteExpressionPreference,
    ExpressionPreferenceSnapshot, ExpressionReplyMode,
)
from notalone.persistence.locks import lock_owner_scope
from notalone.scopes import ContactScope


def _as_preference(row: dict[str, Any]) -> ExpressionPreference:
    if row["status"] != "active":
        raise ExpressionPreferenceDeleted("长期表达偏好已删除。")
    return ExpressionPreference(
        row["id"], ExpressionPreferenceScope(row["owner_id"], row["contact_id"], row["reply_mode"]),
        row["text_content"], row["revision"], row["confirmed_operation_key"],
        row["origin_kind"], row["origin_id"], tuple(row["source_ids"]),
        row["confirmed_at"], row["updated_at"],
    )


def _current_preference(connection: Any, row: dict[str, Any]) -> ExpressionPreference:
    preference = _as_preference(row)
    if not preference.source_ids:
        return preference
    missing = connection.execute(
        """SELECT id FROM unnest(%s::uuid[]) AS dependency(id) WHERE NOT EXISTS (
           SELECT 1 FROM public.source_document WHERE owner_id=%s AND contact_id=%s AND id=dependency.id AND status='active'
           UNION ALL SELECT 1 FROM public.local_wechat_observation WHERE owner_id=%s AND contact_id=%s AND id=dependency.id
           UNION ALL SELECT 1 FROM public.message_source_ref AS ref
             LEFT JOIN public.source_document AS source ON source.id=ref.source_document_id
             LEFT JOIN public.local_wechat_observation AS observation ON observation.id=ref.observation_id
             WHERE ref.owner_id=%s AND ref.contact_id=%s AND ref.message_id=dependency.id
               AND (source.status='active' OR observation.id IS NOT NULL)
        ) LIMIT 1""",
        (list(preference.source_ids), preference.scope.owner_id, preference.scope.contact_id,
         preference.scope.owner_id, preference.scope.contact_id, preference.scope.owner_id, preference.scope.contact_id),
    ).fetchone()
    if missing:
        raise ExpressionPreferenceDeleted("长期偏好的参与来源已失效。")
    return preference


def _read(connection: Any, owner_id: UUID, preference_id: UUID, *, contact_id: UUID | None) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM public.expression_preference WHERE owner_id=%s AND id=%s "
        "AND (contact_id IS NULL OR contact_id=%s)",
        (owner_id, preference_id, contact_id),
    ).fetchone()
    if row is None:
        raise ExpressionPreferenceNotFound("当前用户没有此长期表达偏好。")
    return row


def _bump_revision(connection: Any, owner_id: UUID) -> None:
    connection.execute(
        """INSERT INTO public.expression_preference_state(owner_id,revision) VALUES (%s,1)
           ON CONFLICT(owner_id) DO UPDATE SET revision=expression_preference_state.revision+1""",
        (owner_id,),
    )


def _scope_exists(connection: Any, scope: ExpressionPreferenceScope) -> None:
    if scope.contact_id is not None and connection.execute(
        "SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s", (scope.owner_id, scope.contact_id),
    ).fetchone() is None:
        raise ExpressionPreferenceNotFound("适用联系人不存在。")


def _current_revision(connection: Any, owner_id: UUID) -> int:
    row = connection.execute("SELECT revision FROM public.expression_preference_state WHERE owner_id=%s", (owner_id,)).fetchone()
    return 0 if row is None else row["revision"]


def _require_snapshot(connection: Any, scope: ContactScope, reply_mode: ExpressionReplyMode,
                      snapshot: ExpressionPreferenceSnapshot) -> None:
    if _current_revision(connection, scope.owner_id) != snapshot.revision:
        raise ExpressionPreferenceConflict("长期表达偏好修订已变化。")
    for item in snapshot.preferences:
        current = _current_preference(connection, _read(connection, scope.owner_id, item.preference_id, contact_id=scope.contact_id))
        if current != item or current.scope.contact_id not in {None, scope.contact_id} or current.scope.reply_mode not in {None, reply_mode}:
            raise ExpressionPreferenceConflict("本次使用的长期表达偏好已变化。")


def _require_context_preferences(connection: Any, context: Any) -> None:
    from notalone.reply.expression_preferences import expression_reply_mode, require_preference_contract
    from notalone.reply.errors import ReplyExpressionPreferencesChangedError

    require_preference_contract(context.scope, expression_reply_mode(context.command),
                                context.expression_preferences, context.expression_preference_revision)
    if context.expression_preference_revision is None:
        return
    try:
        _require_snapshot(connection, context.scope, expression_reply_mode(context.command), ExpressionPreferenceSnapshot(
            context.expression_preference_revision, context.expression_preferences,
        ))
    except ExpressionPreferenceError:
        raise ReplyExpressionPreferencesChangedError("长期表达偏好或来源已变化，不能提交旧结果。") from None


def capture_reply_expression_preferences(connection: Any, request: Any, context: Any) -> None:
    """模型调用前，在owner锁内捕获实际使用版本与整体修订。"""
    if context.expression_preference_revision is None and not context.expression_preferences:
        return
    _require_context_preferences(connection, context)
    connection.execute("DELETE FROM public.reply_expression_preference_use WHERE reply_request_id=%s", (request.request_id,))
    for item in context.expression_preferences:
        connection.execute(
            """INSERT INTO public.reply_expression_preference_use(
               reply_request_id,preference_id,owner_id,contact_id,preference_revision) VALUES (%s,%s,%s,%s,%s)""",
            (request.request_id, item.preference_id, request.scope.owner_id, request.scope.contact_id, item.revision),
        )
    connection.execute("UPDATE public.reply_request SET expression_preference_revision=%s WHERE id=%s",
                       (context.expression_preference_revision, request.request_id))


def require_captured_reply_expression_preferences(connection: Any, request: Any, context: Any) -> None:
    """提交事务再次核当前范围、修订与模型前实际使用身份。"""
    from notalone.reply.errors import ReplyStoreInvariantError

    if context.expression_preference_revision is None and not context.expression_preferences:
        return
    _require_context_preferences(connection, context)
    row = connection.execute("SELECT expression_preference_revision FROM public.reply_request WHERE id=%s", (request.request_id,)).fetchone()
    captured = {(row["preference_id"], row["preference_revision"]) for row in connection.execute(
        "SELECT preference_id,preference_revision FROM public.reply_expression_preference_use WHERE reply_request_id=%s AND owner_id=%s AND contact_id=%s",
        (request.request_id, request.scope.owner_id, request.scope.contact_id),
    ).fetchall()}
    if row is None or row["expression_preference_revision"] != context.expression_preference_revision or captured != {
        (item.preference_id, item.revision) for item in context.expression_preferences
    }:
        raise ReplyStoreInvariantError("长期表达偏好不符合模型前的实际使用记录。")


def erase_source_expression_preferences(connection: Any, *, owner_id: UUID, removed_ids: set[UUID]) -> None:
    """来源删除没有独立留存例外；清正文、操作摘要及实际回复依赖。"""
    rows = connection.execute(
        "SELECT id FROM public.expression_preference WHERE owner_id=%s AND status='active' AND source_ids && %s::uuid[]",
        (owner_id, list(removed_ids)),
    ).fetchall()
    identifiers = [row["id"] if isinstance(row, dict) else row[0] for row in rows]
    _erase_preferences(connection, owner_id=owner_id, identifiers=identifiers)


def _erase_preferences(connection: Any, *, owner_id: UUID, identifiers: list[UUID]) -> None:
    """调用方持有owner锁；两个删除入口共用同一事务的完整擦除顺序。"""
    from notalone.persistence.reply_cleanup import delete_source_replies
    from notalone.persistence.skill_learning import erase_skill_learning

    if not identifiers:
        return
    # 学习可能尚无reply_request；在同一owner删除事务直接擦全部参与副本。
    erase_skill_learning(connection, owner_id=owner_id, removed_ids=set(identifiers))
    delete_source_replies(connection, owner_id=owner_id, contact_id=None,
                          removed_ids=set(identifiers), revoke_running_scope=False)
    connection.execute(
        """UPDATE public.expression_preference SET status='deleted',text_content=NULL,
           origin_kind=NULL,origin_id=NULL,source_ids='{}',reply_mode=NULL,revision=revision+1,
           deleted_at=now(),updated_at=now() WHERE owner_id=%s AND id=ANY(%s::uuid[])""",
        (owner_id, identifiers),
    )
    connection.execute(
        "UPDATE public.expression_preference_operation SET input_digest=NULL WHERE owner_id=%s AND preference_id=ANY(%s::uuid[])",
        (owner_id, identifiers),
    )
    _bump_revision(connection, owner_id)




class PostgresExpressionPreferenceStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def select_applicable(self, scope: ContactScope, reply_mode: ExpressionReplyMode) -> ExpressionPreferenceSnapshot:
        from notalone.reply.expression_preferences import PREFERENCE_LIMIT, PREFERENCE_CHAR_BUDGET

        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                connection.execute("SET LOCAL statement_timeout='500ms'")
                lock_owner_scope(connection, owner_id=scope.owner_id)
                _scope_exists(connection, ExpressionPreferenceScope(scope.owner_id, scope.contact_id))
                revision = _current_revision(connection, scope.owner_id)
                rows = connection.execute(
                    """SELECT * FROM public.expression_preference WHERE owner_id=%s AND status='active'
                       AND (contact_id IS NULL OR contact_id=%s) AND (reply_mode IS NULL OR reply_mode=%s)
                       ORDER BY (contact_id IS NOT NULL) DESC,(reply_mode IS NOT NULL) DESC,updated_at DESC,id LIMIT 50""",
                    (scope.owner_id, scope.contact_id, reply_mode),
                ).fetchall()
                preferences, used = [], 0
                for row in rows:
                    try:
                        item = _current_preference(connection, row)
                    except ExpressionPreferenceDeleted:
                        continue
                    if len(item.text) + used > PREFERENCE_CHAR_BUDGET:
                        continue
                    preferences.append(item)
                    used += len(item.text)
                    if len(preferences) == PREFERENCE_LIMIT:
                        break
                return ExpressionPreferenceSnapshot(revision, tuple(preferences))
        except psycopg.Error:
            raise ExpressionPreferenceError("长期表达偏好读取失败。") from None

    def validate_snapshot(self, scope: ContactScope, reply_mode: ExpressionReplyMode, snapshot: ExpressionPreferenceSnapshot) -> None:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                _require_snapshot(connection, scope, reply_mode, snapshot)
        except psycopg.Error:
            raise ExpressionPreferenceError("长期表达偏好复验失败。") from None

    def save(self, command: SaveExpressionPreference, *, contact_id: UUID | None = None) -> ExpressionPreference:
        scope = command.scope
        digest = sha256(json.dumps({
            "text": command.text.strip(), "contact_id": str(scope.contact_id),
            "reply_mode": scope.reply_mode, "origin_kind": command.origin_kind,
            "origin_id": str(command.origin_id),
        }, sort_keys=True).encode()).hexdigest()
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                _scope_exists(connection, ExpressionPreferenceScope(scope.owner_id, contact_id))
                if contact_id is not None and scope.contact_id not in {None, contact_id}:
                    raise ExpressionPreferenceConflict("保存目标不属于当前联系人范围。")
                existing = connection.execute(
                    "SELECT * FROM public.expression_preference_operation "
                    "WHERE owner_id=%s AND operation_key=%s",
                    (scope.owner_id, command.operation_key),
                ).fetchone()
                if existing is not None:
                    state = connection.execute(
                        "SELECT status,revision FROM public.expression_preference WHERE owner_id=%s AND id=%s",
                        (scope.owner_id, existing["preference_id"]),
                    ).fetchone()
                    if state is None:
                        raise ExpressionPreferenceNotFound("用户操作关联偏好已失效。")
                    if state["status"] == "deleted":
                        raise ExpressionPreferenceDeleted("用户操作关联偏好已删除。")
                    if existing["kind"] != "save" or existing["input_digest"] != digest or existing["result_revision"] != state["revision"]:
                        raise ExpressionPreferenceConflict("用户操作键已用于其他偏好。")
                    preference = _current_preference(connection, _read(connection, scope.owner_id, existing["preference_id"], contact_id=scope.contact_id))
                    return preference
                _scope_exists(connection, scope)
                sources = []
                if command.origin_kind == "message":
                    if scope.contact_id is None:
                        raise ExpressionPreferenceConflict("联系人来源的偏好须限定同一联系人。")
                    if connection.execute(
                        "SELECT 1 FROM public.message WHERE owner_id=%s AND contact_id=%s AND id=%s",
                        (scope.owner_id, scope.contact_id, command.origin_id),
                    ).fetchone() is None:
                        raise ExpressionPreferenceNotFound("偏好来源消息不存在。")
                    refs = connection.execute(
                        """SELECT ref.source_document_id,ref.observation_id,source.status FROM public.message_source_ref AS ref
                           LEFT JOIN public.source_document AS source ON source.id=ref.source_document_id
                           WHERE ref.owner_id=%s AND ref.contact_id=%s AND ref.message_id=%s""",
                        (scope.owner_id, scope.contact_id, command.origin_id),
                    ).fetchall()
                    if not refs:
                        raise ExpressionPreferenceNotFound("偏好来源消息没有活动来源。")
                    if any(row["source_document_id"] is not None and row["status"] != "active" for row in refs):
                        raise ExpressionPreferenceConflict("偏好来源正在删除，不能保存。")
                    sources = sorted({command.origin_id, *(row["source_document_id"] or row["observation_id"] for row in refs)}, key=str)
                row = connection.execute(
                    """INSERT INTO public.expression_preference(
                        owner_id,contact_id,reply_mode,text_content,confirmed_operation_key,
                        origin_kind,origin_id,source_ids)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                    (scope.owner_id, scope.contact_id, scope.reply_mode, command.text.strip(),
                     command.operation_key, command.origin_kind, command.origin_id, sources),
                ).fetchone()
                if row is None:
                    raise ExpressionPreferenceError("保存偏好未返回记录。")
                connection.execute(
                    """INSERT INTO public.expression_preference_operation(
                        owner_id,operation_key,preference_id,kind,input_digest,result_revision)
                       VALUES (%s,%s,%s,'save',%s,1)""",
                    (scope.owner_id, command.operation_key, row["id"], digest),
                )
                _bump_revision(connection, scope.owner_id)
                return _as_preference(row)
        except psycopg.Error:
            raise ExpressionPreferenceError("长期表达偏好保存失败。") from None

    def list(self, owner_id: UUID, *, contact_id: UUID | None = None) -> tuple[ExpressionPreference, ...]:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                _scope_exists(connection, ExpressionPreferenceScope(owner_id, contact_id))
                rows = connection.execute(
                    "SELECT * FROM public.expression_preference WHERE owner_id=%s "
                    "AND (contact_id IS NULL OR contact_id=%s) AND status='active' ORDER BY confirmed_at,id",
                    (owner_id, contact_id),
                ).fetchall()
                preferences = []
                for row in rows:
                    try:
                        preferences.append(_current_preference(connection, row))
                    except ExpressionPreferenceDeleted:
                        continue
                return tuple(preferences)
        except psycopg.Error:
            raise ExpressionPreferenceError("长期表达偏好读取失败。") from None

    def read(self, owner_id: UUID, preference_id: UUID, *, contact_id: UUID | None = None) -> ExpressionPreference:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                _scope_exists(connection, ExpressionPreferenceScope(owner_id, contact_id))
                return _current_preference(connection, _read(connection, owner_id, preference_id, contact_id=contact_id))
        except psycopg.Error:
            raise ExpressionPreferenceError("长期表达偏好读取失败。") from None

    def update(self, preference_id: UUID, command: UpdateExpressionPreference, *, contact_id: UUID | None = None) -> ExpressionPreference:
        scope = command.scope
        digest = sha256(json.dumps({
            "preference_id": str(preference_id), "expected_revision": command.expected_revision,
            "text": command.text.strip(), "contact_id": str(scope.contact_id), "reply_mode": scope.reply_mode,
        }, sort_keys=True).encode()).hexdigest()
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                _scope_exists(connection, ExpressionPreferenceScope(scope.owner_id, contact_id))
                current = _current_preference(connection, _read(connection, scope.owner_id, preference_id, contact_id=contact_id))
                if scope.contact_id not in {None, contact_id}:
                    raise ExpressionPreferenceConflict("修改目标不属于当前联系人范围。")
                existing = connection.execute(
                    "SELECT * FROM public.expression_preference_operation WHERE owner_id=%s AND operation_key=%s",
                    (scope.owner_id, command.operation_key),
                ).fetchone()
                if existing is not None:
                    if (existing["kind"], existing["preference_id"], existing["input_digest"], existing["result_revision"]) != (
                        "update", preference_id, digest, current.revision,
                    ):
                        raise ExpressionPreferenceConflict("用户操作已被其他版本取代。")
                    return current
                if current.revision != command.expected_revision:
                    raise ExpressionPreferenceConflict("长期偏好已变化，请刷新后修改。")
                _scope_exists(connection, scope)
                if current.origin_kind == "message" and scope.contact_id != current.scope.contact_id:
                    raise ExpressionPreferenceConflict("有联系人来源的偏好不能移到其他范围。")
                row = connection.execute(
                    """UPDATE public.expression_preference SET text_content=%s,contact_id=%s,reply_mode=%s,
                       revision=revision+1,confirmed_operation_key=%s,updated_at=now()
                       WHERE owner_id=%s AND id=%s RETURNING *""",
                    (command.text.strip(), scope.contact_id, scope.reply_mode, command.operation_key,
                     scope.owner_id, preference_id),
                ).fetchone()
                connection.execute(
                    """INSERT INTO public.expression_preference_operation(
                       owner_id,operation_key,preference_id,kind,input_digest,result_revision)
                       VALUES (%s,%s,%s,'update',%s,%s)""",
                    (scope.owner_id, command.operation_key, preference_id, digest, row["revision"]),
                )
                _bump_revision(connection, scope.owner_id)
                return _as_preference(row)
        except psycopg.Error:
            raise ExpressionPreferenceError("长期表达偏好修改失败。") from None

    def delete(self, owner_id: UUID, preference_id: UUID, command: DeleteExpressionPreference, *, contact_id: UUID | None = None) -> None:
        from notalone.managed_update_backups import erase_managed_update_backups

        digest = sha256(json.dumps({"preference_id": str(preference_id), "expected_revision": command.expected_revision},
                                  sort_keys=True).encode()).hexdigest()
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=owner_id)
                _scope_exists(connection, ExpressionPreferenceScope(owner_id, contact_id))
                row = _read(connection, owner_id, preference_id, contact_id=contact_id)
                existing = connection.execute(
                    "SELECT * FROM public.expression_preference_operation WHERE owner_id=%s AND operation_key=%s",
                    (owner_id, command.operation_key),
                ).fetchone()
                if existing is not None:
                    if (existing["kind"], existing["preference_id"], existing["input_digest"]) != ("delete", preference_id, digest):
                        raise ExpressionPreferenceConflict("用户操作键已用于其他操作。")
                    erase_managed_update_backups(connection)
                    return
                current = _as_preference(row)
                if current.revision != command.expected_revision:
                    raise ExpressionPreferenceConflict("长期偏好已变化，请刷新后删除。")
                erase_managed_update_backups(connection)
                _erase_preferences(connection, owner_id=owner_id, identifiers=[preference_id])
                connection.execute(
                    """INSERT INTO public.expression_preference_operation(
                       owner_id,operation_key,preference_id,kind,input_digest,result_revision)
                       VALUES (%s,%s,%s,'delete',%s,%s)""",
                    (owner_id, command.operation_key, preference_id, digest, current.revision + 1),
                )
        except psycopg.Error:
            raise ExpressionPreferenceError("长期表达偏好删除失败。") from None
