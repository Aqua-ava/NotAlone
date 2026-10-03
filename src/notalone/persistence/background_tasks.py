"""后台任务的 PostgreSQL 持久化边界。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from uuid import UUID

import psycopg

from notalone.tasks.models import (
    IMPORT_TASK_STEPS,
    VERIFY_STEPS,
    BackgroundTask,
    BackgroundTaskStatus,
    BackgroundTaskStep,
    BackgroundTaskStepName,
    BackgroundTaskStepStatus,
    BackgroundTaskType,
    ClaimedBackgroundTaskStep,
)
from notalone.persistence.locks import lock_contact_scope


MAX_AUTOMATIC_ATTEMPTS = 3
TERMINAL_TASK_RETENTION = timedelta(days=90)


class BackgroundTaskPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或聊天内容的任务持久化错误。"""


class BackgroundTaskNotFoundError(BackgroundTaskPersistenceError):
    """指定联系人范围内不存在该后台任务。"""


class BackgroundTaskLeaseError(BackgroundTaskPersistenceError):
    """Worker 的步骤租约已失效或不属于当前 Worker。"""


class BackgroundTaskStateError(BackgroundTaskPersistenceError):
    """后台任务当前状态不允许该操作。"""


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
                        task.retry_count,
                        task.last_error_code,
                        task.model_version,
                        task.rule_version,
                        task.created_at,
                        task.updated_at,
                        step.id,
                        step.step_name,
                        step.step_order,
                        step.status,
                        step.attempt_count,
                        step.processed_count,
                        step.total_count,
                        step.worker_id,
                        step.lease_expires_at,
                        step.last_error_code,
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
                step_id=row[14],
                task_id=first[0],
                name=BackgroundTaskStepName(row[15]),
                order=row[16],
                status=BackgroundTaskStepStatus(row[17]),
                attempt_count=row[18],
                processed_count=row[19],
                total_count=row[20],
                worker_id=row[21],
                lease_expires_at=row[22],
                last_error_code=row[23],
                created_at=row[24],
                updated_at=row[25],
            )
            for row in rows
            if row[14] is not None
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
            retry_count=first[8],
            last_error_code=first[9],
            model_version=first[10],
            rule_version=first[11],
            created_at=first[12],
            updated_at=first[13],
            steps=steps,
        )

    def claim_next_step(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        worker_id: UUID,
        task_id: UUID | None = None,
        lease_duration: timedelta,
        supported_steps: Iterable[BackgroundTaskStepName] = (
            BackgroundTaskStepName.PARSE,
            BackgroundTaskStepName.NORMALIZE,
            BackgroundTaskStepName.EXTRACT_MEMORY,
        ),
        model_version: str | None = None,
        rule_version: str | None = None,
    ) -> ClaimedBackgroundTaskStep | None:
        """原子领取一个联系人范围内、顺序合法的步骤租约。"""

        _validate_uuid(owner_id, "owner_id")
        _validate_uuid(contact_id, "contact_id")
        _validate_uuid(worker_id, "worker_id")
        if task_id is not None:
            _validate_uuid(task_id, "task_id")
        _validate_lease_duration(lease_duration)
        step_names = tuple(
            step.value
            for step in supported_steps
            if isinstance(step, BackgroundTaskStepName)
        )
        if not step_names:
            return None
        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, owner_id, contact_id)
                self._expire_leases(connection, owner_id, contact_id)
                active = connection.execute(
                    """
                    SELECT 1
                    FROM public.background_task_step AS step
                    JOIN public.background_task AS task
                      ON task.id = step.task_id
                    JOIN public.source_document AS source
                      ON source.id = task.source_document_id
                    WHERE task.owner_id = %s
                      AND task.contact_id = %s
                      AND ((task.task_type = 'import' AND source.status = 'active')
                   OR (task.task_type = 'delete' AND source.status IN
                       ('delete_requested', 'deleting', 'delete_failed', 'deleted')))
                      AND step.status = 'running'
                      AND step.lease_expires_at > now()
                    LIMIT 1
                    """,
                    (owner_id, contact_id),
                ).fetchone()
                if active is not None:
                    return None
                candidate = connection.execute(
                    """
                    SELECT
                        step.id,
                        task.id,
                        task.owner_id,
                        task.contact_id,
                        task.source_document_id,
                        step.step_name,
                        step.attempt_count,
                        task.message_count
                    FROM public.background_task_step AS step
                    JOIN public.background_task AS task
                      ON task.id = step.task_id
                    JOIN public.source_document AS source
                      ON source.id = task.source_document_id
                    WHERE task.owner_id = %s
                      AND task.contact_id = %s
                      AND ((task.task_type = 'import' AND source.status = 'active')
                   OR (task.task_type = 'delete' AND source.status IN
                       ('delete_requested', 'deleting', 'delete_failed', 'deleted')))
                      AND task.status IN ('queued', 'running', 'verifying')
                      AND (%s::uuid IS NULL OR task.id = %s)
                      AND step.status IN ('pending', 'retryable')
                      AND step.step_name = ANY(%s::text[])
                      AND (
                          step.status = 'pending'
                          OR step.attempt_count < %s
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM public.background_task_step AS prior
                          WHERE prior.task_id = step.task_id
                            AND prior.step_order < step.step_order
                            AND prior.status <> 'succeeded'
                      )
                    ORDER BY task.created_at, task.id, step.step_order
                    LIMIT 1
                    FOR UPDATE OF task, step
                    """,
                    (owner_id, contact_id, task_id, task_id,
                     list(step_names), MAX_AUTOMATIC_ATTEMPTS),
                ).fetchone()
                if candidate is None:
                    return None
                next_attempt = candidate[6] + 1
                lease_expires_at = connection.execute(
                    """
                    UPDATE public.background_task_step
                    SET status = 'running',
                        attempt_count = %s,
                        worker_id = %s,
                        lease_expires_at = now() + %s::interval,
                        last_error_code = NULL,
                        started_at = COALESCE(started_at, now()),
                        updated_at = now()
                    WHERE id = %s
                    RETURNING lease_expires_at
                    """,
                    (
                        next_attempt,
                        worker_id,
                        _as_postgres_interval(lease_duration),
                        candidate[0],
                    ),
                ).fetchone()
                if lease_expires_at is None:
                    raise BackgroundTaskPersistenceError(
                        "后台步骤租约写入失败。"
                    )
                task_status = (
                    "verifying"
                    if candidate[5] in VERIFY_STEPS
                    else "running"
                )
                connection.execute(
                    """
                    UPDATE public.background_task
                    SET status = %s,
                        current_step = %s,
                        model_version = COALESCE(%s, model_version),
                        rule_version = COALESCE(%s, rule_version),
                        started_at = COALESCE(started_at, now()),
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (
                        task_status,
                        candidate[5],
                        model_version,
                        rule_version,
                        candidate[1],
                    ),
                )
                return ClaimedBackgroundTaskStep(
                    task_id=candidate[1],
                    owner_id=candidate[2],
                    contact_id=candidate[3],
                    source_document_id=candidate[4],
                    step_id=candidate[0],
                    name=BackgroundTaskStepName(candidate[5]),
                    worker_id=worker_id,
                    attempt_count=next_attempt,
                    message_count=candidate[7],
                    lease_expires_at=lease_expires_at[0],
                )
        except BackgroundTaskPersistenceError:
            raise
        except psycopg.Error:
            raise BackgroundTaskPersistenceError(
                "后台步骤领取失败。"
            ) from None

    def complete_step(
        self,
        claim: ClaimedBackgroundTaskStep,
        *,
        processed_count: int,
        total_count: int | None = None,
    ) -> None:
        """在有效租约内完成一步，并推进父任务到下一固定步骤。"""

        _validate_count(processed_count, "processed_count")
        if total_count is not None:
            _validate_count(total_count, "total_count")
        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, claim.owner_id, claim.contact_id)
                self._assert_valid_claim(connection, claim)
                updated = connection.execute(
                    """
                    UPDATE public.background_task_step
                    SET status = 'succeeded',
                        processed_count = %s,
                        total_count = COALESCE(%s, total_count),
                        worker_id = NULL,
                        lease_expires_at = NULL,
                        finished_at = now(),
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (processed_count, total_count, claim.step_id),
                ).rowcount
                if updated != 1:
                    raise BackgroundTaskPersistenceError(
                        "后台步骤完成状态写入失败。"
                    )
                next_step = connection.execute(
                    """
                    SELECT step_name
                    FROM public.background_task_step
                    WHERE task_id = %s AND status <> 'succeeded'
                    ORDER BY step_order
                    LIMIT 1
                    """,
                    (claim.task_id,),
                ).fetchone()
                if next_step is None:
                    if claim.name not in VERIFY_STEPS:
                        raise BackgroundTaskStateError(
                            "固定步骤缺少 verify。"
                        )
                    connection.execute(
                        """
                        UPDATE public.background_task
                        SET status = 'succeeded',
                            last_error_code = NULL,
                            current_step = %s,
                            finished_at = now(),
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (claim.name.value, claim.task_id),
                    )
                else:
                    next_status = (
                        "verifying"
                        if next_step[0] in VERIFY_STEPS
                        else "running"
                    )
                    connection.execute(
                        """
                        UPDATE public.background_task
                        SET status = %s,
                            current_step = %s,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (next_status, next_step[0], claim.task_id),
                    )
        except BackgroundTaskPersistenceError:
            raise
        except psycopg.Error:
            raise BackgroundTaskPersistenceError(
                "后台步骤完成失败。"
            ) from None

    def renew_step_lease(
        self,
        claim: ClaimedBackgroundTaskStep,
        *,
        lease_duration: timedelta,
    ) -> datetime:
        """在当前有效租约内续期，并返回新的过期时间。"""

        _validate_lease_duration(lease_duration)
        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, claim.owner_id, claim.contact_id)
                self._assert_valid_claim(connection, claim)
                row = connection.execute(
                    """
                    UPDATE public.background_task_step
                    SET lease_expires_at = now() + %s::interval,
                        updated_at = now()
                    WHERE id = %s
                      AND task_id = %s
                      AND worker_id = %s
                      AND status = 'running'
                    RETURNING lease_expires_at
                    """,
                    (
                        _as_postgres_interval(lease_duration),
                        claim.step_id,
                        claim.task_id,
                        claim.worker_id,
                    ),
                ).fetchone()
                if row is None:
                    raise BackgroundTaskLeaseError("后台步骤租约续期失败。")
                return row[0]
        except BackgroundTaskPersistenceError:
            raise
        except psycopg.Error:
            raise BackgroundTaskPersistenceError(
                "后台步骤租约续期失败。"
            ) from None

    def check_step_lease(self, claim: ClaimedBackgroundTaskStep) -> None:
        """模型调用前后复验原步骤、来源与租约，不改变步骤状态。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, claim.owner_id, claim.contact_id)
                self._assert_valid_claim(connection, claim)
        except BackgroundTaskPersistenceError:
            raise
        except psycopg.Error:
            raise BackgroundTaskPersistenceError("后台步骤租约检查失败。") from None

    def pause_step(self, claim: ClaimedBackgroundTaskStep) -> bool:
        """协作停止只返还本次尝试；原租约到期后仍由原恢复路径领取。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, claim.owner_id, claim.contact_id)
                self._assert_valid_claim(connection, claim)
                updated = connection.execute(
                    """
                    UPDATE public.background_task_step
                    SET attempt_count = attempt_count - 1, updated_at = now()
                    WHERE id = %s AND task_id = %s AND worker_id = %s
                      AND status = 'running' AND attempt_count = %s
                      AND attempt_count > 0
                    """,
                    (claim.step_id, claim.task_id, claim.worker_id, claim.attempt_count),
                )
                return updated.rowcount == 1
        except BackgroundTaskPersistenceError:
            raise
        except psycopg.Error:
            raise BackgroundTaskPersistenceError("后台步骤停止记账失败。") from None

    def fail_step(
        self,
        claim: ClaimedBackgroundTaskStep,
        *,
        error_code: str,
        retryable: bool,
    ) -> BackgroundTaskStepStatus:
        """记录稳定错误分类，并按自动重试上限决定下一状态。"""

        _validate_error_code(error_code)
        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, claim.owner_id, claim.contact_id)
                self._assert_valid_claim(connection, claim)
                next_status = (
                    BackgroundTaskStepStatus.RETRYABLE
                    if retryable and claim.attempt_count < MAX_AUTOMATIC_ATTEMPTS
                    else BackgroundTaskStepStatus.FAILED
                )
                connection.execute(
                    """
                    UPDATE public.background_task_step
                    SET status = %s,
                        worker_id = NULL,
                        lease_expires_at = NULL,
                        last_error_code = %s,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (next_status.value, error_code, claim.step_id),
                )
                task_status = (
                    "running"
                    if next_status is BackgroundTaskStepStatus.RETRYABLE
                    else "failed"
                )
                connection.execute(
                    """
                    UPDATE public.background_task
                    SET status = %s,
                        retry_count = retry_count + 1,
                        last_error_code = %s,
                        finished_at = CASE
                            WHEN %s = 'failed' THEN now()
                            ELSE NULL
                        END,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (task_status, error_code, task_status, claim.task_id),
                )
                return next_status
        except BackgroundTaskPersistenceError:
            raise
        except psycopg.Error:
            raise BackgroundTaskPersistenceError(
                "后台步骤失败状态写入失败。"
            ) from None

    def retry_failed_task(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        task_id: UUID,
    ) -> BackgroundTask:
        """复用失败任务身份，保留成功步骤并重置失败步骤的自动重试轮次。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, owner_id, contact_id)
                task = connection.execute(
                    """
                    SELECT task.status, task.task_type, source.status
                    FROM public.background_task AS task
                    JOIN public.source_document AS source
                      ON source.id = task.source_document_id
                     AND source.owner_id = task.owner_id
                     AND source.contact_id = task.contact_id
                    WHERE task.id = %s AND task.owner_id = %s AND task.contact_id = %s
                    FOR UPDATE OF task, source
                    """,
                    (task_id, owner_id, contact_id),
                ).fetchone()
                if task is None:
                    raise BackgroundTaskNotFoundError(
                        "指定范围内不存在该后台任务。"
                    )
                if task[0] != BackgroundTaskStatus.FAILED.value:
                    raise BackgroundTaskStateError(
                        "只有 failed 任务可以手动重试。"
                    )
                source_allowed = (
                    task[1] == BackgroundTaskType.IMPORT.value and task[2] == "active"
                ) or (
                    task[1] == BackgroundTaskType.DELETE.value and task[2] in {
                        "delete_requested", "deleting", "delete_failed", "deleted",
                    }
                )
                if not source_allowed:
                    raise BackgroundTaskStateError("来源当前状态不允许恢复该任务。")
                connection.execute(
                    """
                    UPDATE public.background_task_step
                    SET status = CASE
                            WHEN status = 'failed' THEN 'retryable'
                            ELSE status
                        END,
                        attempt_count = CASE
                            WHEN status = 'failed' THEN 0
                            ELSE attempt_count
                        END,
                        worker_id = NULL,
                        lease_expires_at = NULL,
                        last_error_code = CASE
                            WHEN status = 'failed' THEN NULL
                            ELSE last_error_code
                        END,
                        finished_at = CASE
                            WHEN status = 'failed' THEN NULL
                            ELSE finished_at
                        END,
                        updated_at = now()
                    WHERE task_id = %s
                    """,
                    (task_id,),
                )
                next_step = connection.execute(
                    """
                    SELECT step_name
                    FROM public.background_task_step
                    WHERE task_id = %s AND status <> 'succeeded'
                    ORDER BY step_order
                    LIMIT 1
                    """,
                    (task_id,),
                ).fetchone()
                if next_step is None:
                    raise BackgroundTaskStateError(
                        "失败任务缺少可重试步骤。"
                    )
                connection.execute(
                    """
                    UPDATE public.background_task
                    SET status = 'queued',
                        current_step = %s,
                        retry_count = retry_count + 1,
                        last_error_code = NULL,
                        finished_at = NULL,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (next_step[0], task_id),
                )
        except BackgroundTaskPersistenceError:
            raise
        except psycopg.Error:
            raise BackgroundTaskPersistenceError(
                "后台任务手动重试失败。"
            ) from None
        return self.get_task(
            owner_id=owner_id,
            contact_id=contact_id,
            task_id=task_id,
        )

    def cleanup_terminal_tasks(
        self,
        *,
        now: datetime | None = None,
        retention: timedelta = TERMINAL_TASK_RETENTION,
    ) -> int:
        """清理超过留存期的终态任务及步骤，不触碰来源或记忆。"""

        if now is None:
            now = datetime.now(timezone.utc)
        if now.tzinfo is None:
            raise ValueError("清理时间必须是带时区的 datetime。")
        if not isinstance(retention, timedelta) or retention <= timedelta(0):
            raise ValueError("任务留存期必须是正时间段。")
        cutoff = now - retention
        try:
            with psycopg.connect(self._database_url) as connection:
                deleted = connection.execute(
                    """
                    DELETE FROM public.background_task
                    WHERE status IN ('succeeded', 'failed', 'cancelled')
                      AND COALESCE(finished_at, updated_at) < %s
                    RETURNING id
                    """,
                    (cutoff,),
                ).fetchall()
                return len(deleted)
        except psycopg.Error:
            raise BackgroundTaskPersistenceError(
                "后台任务留存清理失败。"
            ) from None

    @staticmethod
    def _lock_scope(
        connection: psycopg.Connection[Any],
        owner_id: UUID,
        contact_id: UUID,
    ) -> None:
        lock_contact_scope(
            connection,
            owner_id=owner_id,
            contact_id=contact_id,
        )

    @staticmethod
    def _expire_leases(
        connection: psycopg.Connection[Any],
        owner_id: UUID,
        contact_id: UUID,
    ) -> None:
        connection.execute(
            """
            UPDATE public.background_task_step AS step
            SET status = CASE
                    WHEN step.attempt_count >= %s THEN 'failed'
                    ELSE 'retryable'
                END,
                worker_id = NULL,
                lease_expires_at = NULL,
                last_error_code = 'lease_expired',
                updated_at = now()
            FROM public.background_task AS task
            WHERE task.id = step.task_id
              AND task.owner_id = %s
              AND task.contact_id = %s
              AND step.status = 'running'
              AND step.lease_expires_at <= now()
            """,
            (MAX_AUTOMATIC_ATTEMPTS, owner_id, contact_id),
        )
        connection.execute(
            """
            UPDATE public.background_task AS task
            SET status = 'failed',
                last_error_code = 'lease_expired',
                finished_at = now(),
                updated_at = now()
            WHERE task.owner_id = %s
              AND task.contact_id = %s
              AND task.status IN ('queued', 'running', 'verifying')
              AND EXISTS (
                  SELECT 1
                  FROM public.background_task_step AS step
                  WHERE step.task_id = task.id
                    AND step.status = 'failed'
                    AND step.last_error_code = 'lease_expired'
              )
            """,
            (owner_id, contact_id),
        )

    @staticmethod
    def _assert_valid_claim(
        connection: psycopg.Connection[Any],
        claim: ClaimedBackgroundTaskStep,
    ) -> None:
        row = connection.execute(
            """
            SELECT step.status, step.worker_id, step.lease_expires_at
            FROM public.background_task_step AS step
            JOIN public.background_task AS task ON task.id = step.task_id
            JOIN public.source_document AS source
              ON source.id = task.source_document_id
            WHERE step.id = %s
              AND step.task_id = %s
              AND task.owner_id = %s
              AND task.contact_id = %s
              AND task.status IN ('queued', 'running', 'verifying')
              AND ((task.task_type = 'import' AND source.status = 'active')
                   OR (task.task_type = 'delete' AND source.status IN
                       ('delete_requested', 'deleting', 'delete_failed', 'deleted')))
            FOR UPDATE OF task, step
            """,
            (
                claim.step_id,
                claim.task_id,
                claim.owner_id,
                claim.contact_id,
            ),
        ).fetchone()
        if row is None:
            raise BackgroundTaskNotFoundError("指定范围内不存在该后台步骤。")
        if (
            row[0] != BackgroundTaskStepStatus.RUNNING.value
            or row[1] != claim.worker_id
            or row[2] is None
            or row[2] <= datetime.now(timezone.utc)
        ):
            raise BackgroundTaskLeaseError("后台步骤租约已失效。")


def _validate_uuid(value: UUID, label: str) -> None:
    if not isinstance(value, UUID):
        raise TypeError(f"{label} 必须是 UUID。")


def _validate_lease_duration(value: timedelta) -> None:
    if not isinstance(value, timedelta) or value <= timedelta(0):
        raise ValueError("后台任务租约必须是正时间段。")


def _validate_count(value: int, label: str) -> None:
    if not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} 必须是非负整数。")


def _validate_error_code(value: str) -> None:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 64
        or any(character.isspace() for character in value)
    ):
        raise ValueError("后台任务错误分类无效。")


def _as_postgres_interval(value: timedelta) -> str:
    seconds = value.total_seconds()
    return f"{seconds:g} seconds"
