"""联系人物理清理的事务入口；不是产品聊天或联系人管理 Tool。"""

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.expression_preferences import _erase_preferences
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.scopes import ContactScope


def delete_contact(database_url: str, scope: ContactScope) -> bool:
    """只清理显式给定范围；当前产品没有整体联系人删除 HTTP 入口。"""
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
        lock_owner_scope(connection, owner_id=scope.owner_id)
        if connection.execute('SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s',
                              (scope.owner_id, scope.contact_id)).fetchone() is None:
            return False
        removed_ids = _contact_dependency_ids(connection, scope)
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
                           identifiers=[row['id'] for row in rows if row['status'] == 'active'])
        # 去除联系人身份，保留owner级无正文墓碑和旧操作键，拒绝原global操作重放。
        connection.execute(
            "UPDATE public.expression_preference SET contact_id=NULL WHERE owner_id=%s AND contact_id=%s",
            (scope.owner_id, scope.contact_id),
        )
        return connection.execute(
            "DELETE FROM public.contact WHERE owner_id=%s AND id=%s",
            (scope.owner_id, scope.contact_id),
        ).rowcount == 1


def _contact_dependency_ids(connection, scope):
    """只读取将被本范围级联移除的身份，不读取私人正文或扩展到其他联系人。"""
    tables = ('source_document', 'message', 'local_wechat_observation', 'memory_candidate',
              'confirmed_memory', 'memory_correction_decision', 'assistant_session',
              'assistant_session_input', 'assistant_session_turn', 'assistant_candidate_version',
              'assistant_candidate_selection', 'reply_request', 'reply_candidate', 'reply_skill')
    removed = {scope.contact_id}
    for table in tables:
        # 表名来自封闭集合，范围参数沿原contact→owner事务锁。
        removed.update(row['id'] for row in connection.execute(
            f'SELECT id FROM public.{table} WHERE owner_id=%s AND contact_id=%s',
            (scope.owner_id, scope.contact_id),
        ).fetchall())
    removed.update(row['id'] for row in connection.execute(
        'SELECT version.id FROM public.reply_skill_version AS version JOIN public.reply_skill AS skill '
        'ON skill.id=version.skill_id WHERE skill.owner_id=%s AND skill.contact_id=%s',
        (scope.owner_id, scope.contact_id),
    ).fetchall())
    return removed
