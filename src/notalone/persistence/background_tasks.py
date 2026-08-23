"""后台任务的 PostgreSQL 持久化边界。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg

from notalone.tasks.models import (
    IMPORT_TASK_STEPS,
    BackgroundTask,
    BackgroundTaskStatus,
    BackgroundTaskStep,
    BackgroundTaskStepName,
    BackgroundTaskStepStatus,
    BackgroundTaskType,
)


class BackgroundTaskPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或聊天内容的任务持久化错误。"""


class BackgroundTaskNotFoundError(BackgroundTaskPersistenceError):
    """指定联系人范围内不存在该后台任务。"""


class PostgresBackgroundTaskRepository:
    """创建任务模板并读取不含正文的任务状态。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    @staticmethod
    def create_import_task(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        source_document_id: UUID,
        message_count: int,
    ) -> UUID:
        """在调用方事务中幂等创建导入任务和固定步骤。"""

        task = connection.execute(
            """
            INSERT INTO public.background_task (
                owner_id,
                contact_id,
                source_document_id,
                task_type,
                status,
                current_step,
                message_count
            )
            VALUES (%s, %s, %s, 'import', 'queued', 'parse', %s)
            ON CONFLICT (
                owner_id,
                contact_id,
                source_document_id,
                task_type
            ) DO NOTHING
            RETURNING id
            """,
            (
                owner_id,
                contact_id,
                source_document_id,
                message_count,
            ),
        ).fetchone()
        if task is None:
            task = connection.execute(
                """
                SELECT id
                FROM public.background_task
                WHERE owner_id = %s
                  AND contact_id = %s
                  AND source_document_id = %s
                  AND task_type = 'import'
                FOR UPDATE
                """,
                (owner_id, contact_id, source_document_id),
            ).fetchone()
        if task is None:
            raise RuntimeError("无法确认导入任务状态。")

        task_id = task[0]
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO public.background_task_step (
                    task_id,
                    step_name,
                    step_order,
                    status,
                    total_count
                )
                VALUES (%s, %s, %s, 'pending', %s)
                ON CONFLICT (task_id, step_name) DO NOTHING
                """,
                [
                    (task_id, step_name, step_order, message_count)
                    for step_name, step_order in IMPORT_TASK_STEPS
                ],
            )
        return task_id

    def get_task(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        task_id: UUID,
    ) -> BackgroundTask:
        """读取一个联系人范围内的任务及其步骤状态。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(
                    """
                    SELECT
                        task.id,
                        task.owner_id,
                        task.contact_id,
                        task.source_document_id,
                        task.task_type,
                        task.status,
                        task.current_step,
                        task.message_count,
                        task.created_at,
                        task.updated_at,
                        step.id,
                        step.step_name,
                        step.step_order,
                        step.status,
                        step.attempt_count,
                        step.processed_count,
                        step.total_count,
                        step.created_at,
                        step.updated_at
                    FROM public.background_task AS task
                    LEFT JOIN public.background_task_step AS step
                      ON step.task_id = task.id
                    WHERE task.owner_id = %s
                      AND task.contact_id = %s
                      AND task.id = %s
                    ORDER BY step.step_order NULLS LAST
                    """,
                    (owner_id, contact_id, task_id),
                ).fetchall()
        except psycopg.Error:
            raise BackgroundTaskPersistenceError(
                "后台任务状态读取失败。"
            ) from None

        if not rows:
            raise BackgroundTaskNotFoundError("指定范围内不存在该后台任务。")

        first = rows[0]
        steps = tuple(
            BackgroundTaskStep(
                step_id=row[10],
                task_id=first[0],
                name=BackgroundTaskStepName(row[11]),
                order=row[12],
                status=BackgroundTaskStepStatus(row[13]),
                attempt_count=row[14],
                processed_count=row[15],
                total_count=row[16],
                created_at=row[17],
                updated_at=row[18],
            )
            for row in rows
            if row[10] is not None
        )
        return BackgroundTask(
            task_id=first[0],
            owner_id=first[1],
            contact_id=first[2],
            source_document_id=first[3],
            task_type=BackgroundTaskType(first[4]),
            status=BackgroundTaskStatus(first[5]),
            current_step=BackgroundTaskStepName(first[6]),
            message_count=first[7],
            created_at=first[8],
            updated_at=first[9],
            steps=steps,
        )
