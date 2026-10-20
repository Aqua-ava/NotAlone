"""联系人物理清理的事务入口；不是产品聊天或联系人管理 Tool。"""

from uuid import UUID

import psycopg

from notalone.managed_update_backups import erase_managed_update_backups
from notalone.persistence.expression_preferences import _erase_preferences
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.media_store import erase_source_media
from notalone.scopes import ContactScope


def delete_contact(database_url: str, scope: ContactScope) -> bool:
    """只清理显式给定范围；当前产品没有整体联系人删除 HTTP 入口。"""
    with psycopg.connect(database_url) as connection:
        lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
        lock_owner_scope(connection, owner_id=scope.owner_id)
        present = connection.execute('SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s',
                                     (scope.owner_id, scope.contact_id)).fetchone() is not None
        media = connection.execute(
            'SELECT source_document_id,message_id FROM public.media_attempt WHERE owner_id=%s AND contact_id=%s',
            (scope.owner_id, scope.contact_id),
        ).fetchall()
        media_tombstone = connection.execute(
            'SELECT 1 FROM public.media_request_tombstone WHERE owner_id=%s AND contact_id=%s LIMIT 1',
            (scope.owner_id, scope.contact_id),
        ).fetchone() is not None
        if not present and not media and not media_tombstone:
            return False
        erase_managed_update_backups(connection)
        removed_ids = _contact_dependency_ids(connection, scope)
        removed_ids.update(_erase_contact_media(connection, scope, media))
        _erase_contact_sources(connection, scope, removed_ids)
        from notalone.persistence.memory_upgrade import erase_memory_upgrades
        from notalone.persistence.skill_learning import erase_skill_learning
        # FK级联前清除其他联系人下实际引用这些身份的工作副本，不等待下一次GET。
        erase_memory_upgrades(connection, owner_id=scope.owner_id, removed_ids=removed_ids)
        erase_skill_learning(connection, owner_id=scope.owner_id, removed_ids=removed_ids)
        rows = connection.execute(
            "SELECT id,status FROM public.expression_preference WHERE owner_id=%s AND contact_id=%s",
            (scope.owner_id, scope.contact_id),
        ).fetchall()
        _erase_preferences(connection, owner_id=scope.owner_id,
                           identifiers=[identifier for identifier, status in (
                               (row['id'], row['status']) if isinstance(row, dict) else row for row in rows
                           ) if status == 'active'])
        # 去除联系人身份，保留owner级无正文墓碑和旧操作键，拒绝原global操作重放。
        connection.execute(
            "UPDATE public.expression_preference SET contact_id=NULL WHERE owner_id=%s AND contact_id=%s",
            (scope.owner_id, scope.contact_id),
        )
        # 来源删除保留的请求防重凭证不能在联系人删除后继续携带该联系人身份。
        connection.execute(
            'DELETE FROM public.media_request_tombstone WHERE owner_id=%s AND contact_id=%s',
            (scope.owner_id, scope.contact_id),
        )
        return connection.execute(
            "DELETE FROM public.contact WHERE owner_id=%s AND id=%s",
            (scope.owner_id, scope.contact_id),
        ).rowcount == 1


def _erase_contact_media(
    connection: psycopg.Connection, scope: ContactScope, rows: list[tuple[UUID, UUID]],
) -> set[UUID]:
    """只清已持久登记的本范围归属，清单不能先被联系人级联丢弃。"""
    sources = {row[0] for row in rows}
    removed_ids = sources | {row[1] for row in rows}
    for source_id in sources:
        erase_source_media(connection, scope=scope, source_document_id=source_id)
    return removed_ids


def _erase_contact_sources(
    connection: psycopg.Connection, scope: ContactScope, removed_ids: set[UUID],
) -> None:
    """同连接复用来源／观察删除原语；依赖身份须在业务级联前仍完整。"""
    from notalone.persistence.extraction_trace import erase_source_traces
    from notalone.persistence.source_processing import erase_source_processing
    from notalone.persistence.source_memory_erasure import collect_all_source_memory_ids, erase_source_memories
    from notalone.persistence.reply_cleanup import delete_source_replies

    from notalone.persistence.expression_preferences import erase_source_expression_preferences
    from notalone.persistence.message_cleanup import cleanup_derived_data

    erase_source_traces(connection, owner_id=scope.owner_id, removed_ids=removed_ids)
    sources = connection.execute(
        'SELECT id FROM public.source_document WHERE owner_id=%s AND contact_id=%s '
        'UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=%s AND contact_id=%s',
        (scope.owner_id, scope.contact_id, scope.owner_id, scope.contact_id),
    ).fetchall()
    for row in sources:
        erase_source_processing(connection, scope=scope, source_id=row[0])
    all_memory_ids = collect_all_source_memory_ids(
        connection, owner_id=scope.owner_id, contact_id=scope.contact_id, removed_ids=removed_ids,
    )
    # 旧ANY资料也可能只捕获本人资料ID；在清来源和候选FK前收集将被物理删除的身份。
    erased_owner_ids = {row[0] for row in connection.execute(
        "SELECT id FROM public.owner_memory WHERE owner_id=%s AND source_ids && %s::uuid[] "
        "AND (source_ids <@ %s::uuid[] OR supersedes_memory_id IS NOT NULL) FOR UPDATE",
        (scope.owner_id, list(removed_ids), list(removed_ids)),
    ).fetchall()}
    dependent_ids = removed_ids | all_memory_ids | erased_owner_ids
    delete_source_replies(connection, owner_id=scope.owner_id,
                          contact_id=scope.contact_id, removed_ids=dependent_ids)
    erase_source_expression_preferences(connection, owner_id=scope.owner_id, removed_ids=dependent_ids)
    cleanup_derived_data(connection, owner_id=scope.owner_id,
                         contact_id=scope.contact_id, removed_ids=removed_ids)
    erase_source_memories(connection, owner_id=scope.owner_id,
                          contact_id=scope.contact_id, removed_ids=removed_ids)


def _contact_dependency_ids(connection: psycopg.Connection, scope: ContactScope) -> set[UUID]:
    """只读取将被本范围级联移除的身份，不读取私人正文或扩展到其他联系人。"""
    tables = ('source_document', 'message', 'local_wechat_observation', 'memory_candidate',
              'confirmed_memory', 'memory_correction_decision', 'assistant_session',
              'assistant_session_input', 'assistant_session_turn', 'assistant_candidate_version',
              'assistant_candidate_selection', 'reply_request', 'reply_candidate', 'reply_skill')
    removed = {scope.contact_id}
    for table in tables:
        # 表名来自封闭集合，范围参数沿原contact→owner事务锁。
        removed.update(row['id'] if isinstance(row, dict) else row[0] for row in connection.execute(
            f'SELECT id FROM public.{table} WHERE owner_id=%s AND contact_id=%s',
            (scope.owner_id, scope.contact_id),
        ).fetchall())
    removed.update(row['id'] if isinstance(row, dict) else row[0] for row in connection.execute(
        'SELECT version.id FROM public.reply_skill_version AS version JOIN public.reply_skill AS skill '
        'ON skill.id=version.skill_id WHERE skill.owner_id=%s AND skill.contact_id=%s',
        (scope.owner_id, scope.contact_id),
    ).fetchall())
    return removed
