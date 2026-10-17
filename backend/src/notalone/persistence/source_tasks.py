"""导入来源目录与持久化删除请求。"""

from uuid import UUID

import psycopg

from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.reply_cleanup import delete_source_replies
from notalone.persistence.source_deletion import (
    PostgresSourceDeletionRepository, SourceDeletionError, SourceNotFoundError,
)
from notalone.tasks.models import DELETE_TASK_STEPS


class SourceDeletionHistoryUnverified(SourceDeletionError):
    """旧删除凭证缺少可核验任务，不能据此宣称已清除正文。"""


class PostgresSourceTasks:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def list_sources(self, owner_id: UUID, contact_id: UUID) -> list[dict[str, object]]:
        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(
                    """
                    SELECT source.id, source.file_name, source.record_count,
                           source.status, task.id, task.status, task.current_step,
                           COALESCE(task.last_error_code, source.deletion_error_code,
                             CASE WHEN source.status = 'deleted' AND task.id IS NULL
                                  THEN 'legacy_deletion_unverified' END)
                    FROM public.source_document AS source
                    LEFT JOIN public.background_task AS task
                      ON task.owner_id = source.owner_id AND task.contact_id = source.contact_id
                     AND task.source_document_id = source.id AND task.task_type = 'delete'
                    WHERE source.owner_id = %s AND source.contact_id = %s
                    ORDER BY source.imported_at DESC, source.id
                    """, (owner_id, contact_id),
                ).fetchall()
        except psycopg.Error:
            raise SourceDeletionError("来源目录读取失败。") from None
        return [dict(zip(
            ("source_id", "file_name", "record_count", "status", "task_id", "task_status", "step", "error_code"),
            (str(row[0]), row[1], row[2], row[3], str(row[4]) if row[4] else None, row[5], row[6], row[7]),
        )) for row in rows]

    def pending_delete_tasks(self, owner_id: UUID, contact_id: UUID) -> tuple[UUID, ...]:
        """只选择本范围已请求的删除，不认领旧升级或其他业务步骤。"""
        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(
                    "SELECT id FROM public.background_task WHERE owner_id=%s AND contact_id=%s "
                    "AND task_type='delete' AND status IN ('queued','running','verifying') "
                    "ORDER BY created_at,id", (owner_id, contact_id),
                ).fetchall()
        except psycopg.Error:
            raise SourceDeletionError("删除任务读取失败。") from None
        return tuple(row[0] for row in rows)

    def request_delete(self, owner_id: UUID, contact_id: UUID, source_id: UUID) -> UUID:
        """范围内先隐藏来源并取消导入，再幂等建立固定删除步骤。"""
        try:
            with psycopg.connect(self._database_url) as connection:
                lock_contact_scope(connection, owner_id=owner_id, contact_id=contact_id)
                lock_owner_scope(connection, owner_id=owner_id)
                source = connection.execute(
                    "SELECT status FROM public.source_document "
                    "WHERE owner_id = %s AND contact_id = %s AND id = %s FOR UPDATE",
                    (owner_id, contact_id, source_id),
                ).fetchone()
                if source is None:
                    raise SourceNotFoundError("指定范围内不存在该来源。")
                if source[0] == "deleted":
                    previous = connection.execute(
                        "SELECT 1 FROM public.background_task WHERE owner_id = %s AND contact_id = %s "
                        "AND source_document_id = %s AND task_type = 'delete'",
                        (owner_id, contact_id, source_id),
                    ).fetchone()
                    if previous is None:
                        raise SourceDeletionHistoryUnverified("旧删除结果需要单独核验。")
                connection.execute(
                    "UPDATE public.source_document SET status = 'delete_requested' "
                    "WHERE owner_id = %s AND contact_id = %s AND id = %s AND status = 'active'",
                    (owner_id, contact_id, source_id),
                )
                # 排队本身即撤回已捕获来源；prepare 尚无 C 时也按完整导航依赖擦除。
                delete_source_replies(connection, owner_id=owner_id, contact_id=contact_id,
                                      removed_ids={source_id}, revoke_running_scope=False)
                PostgresSourceDeletionRepository.cancel_import_tasks(
                    connection, owner_id=owner_id, contact_id=contact_id,
                    source_document_id=source_id,
                )
                from notalone.persistence.memory_upgrade import erase_memory_upgrades
                # 明确删除来源即撤销依赖它的升级；旧租约不再占住本联系人的删除。
                erase_memory_upgrades(connection, owner_id=owner_id, removed_ids={source_id})
                row = connection.execute(
                    """
                    INSERT INTO public.background_task
                        (owner_id, contact_id, source_document_id, task_type, status, current_step, message_count)
                    VALUES (%s, %s, %s, 'delete', 'queued', 'mark_deleted', 0)
                    ON CONFLICT (owner_id, contact_id, source_document_id, task_type)
                    DO UPDATE SET updated_at = background_task.updated_at
                    RETURNING id
                    """, (owner_id, contact_id, source_id),
                ).fetchone()
                task_id = row[0]
                for order, name in DELETE_TASK_STEPS:
                    connection.execute(
                        "INSERT INTO public.background_task_step "
                        "(task_id, step_name, step_order, status, total_count) "
                        "VALUES (%s, %s, %s, 'pending', 0) "
                        "ON CONFLICT (task_id, step_name) DO NOTHING",
                        (task_id, name.value, order),
                    )
                return task_id
        except psycopg.Error:
            raise SourceDeletionError("删除请求保存失败。") from None
