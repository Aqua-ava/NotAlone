"""后台任务的 PostgreSQL 持久化边界。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from notalone.tasks.models import (
    IMPORT_TASK_STEPS,
    OBSERVATION_TASK_STEPS,
    VERIFY_STEPS,
    BackgroundTask,
    BackgroundTaskStatus,
    BackgroundTaskStep,
    BackgroundTaskStepName,
    BackgroundTaskStepStatus,
    BackgroundTaskType,
    ClaimedBackgroundTaskStep,
    ExtractionRuntimeConfig,
    ExtractionRuntimeMode,
)
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.dimension_evidence import supports_bounded_runtime_evidence


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
        _insert_task_steps(
            connection,
            task_id=task_id,
            steps=IMPORT_TASK_STEPS,
            total_count=message_count,
        )
        return task_id

    @staticmethod
    def create_observation_task(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        message_count: int = 0,
    ) -> UUID:
        """创建或重新排队联系人级 observation 任务。

        观察任务不绑定 ``source_document``。运行中任务只保留一次唤醒，
        终态任务在新的观察到达时重置固定步骤，复用同一个任务身份。
        调用方必须在观察来源提交成功后调用本方法。
        """

        _validate_count(message_count, "message_count")
        # 与 Worker 领取及历史任务创建使用同一联系人锁，避免两个观察批次
        # 同时看到“无任务”后各自插入一个联系人级 observation 任务。
        PostgresBackgroundTaskRepository._lock_scope(
            connection,
            owner_id,
            contact_id,
        )
        active_binding = connection.execute(
            """
            SELECT 1
            FROM public.conversation_binding
            WHERE owner_id = %s AND contact_id = %s AND status = 'active'
            LIMIT 1
            FOR KEY SHARE
            """,
            (owner_id, contact_id),
        ).fetchone()
        if active_binding is None:
            raise BackgroundTaskStateError("联系人没有可用的已确认绑定。")

        existing = connection.execute(
            """
            SELECT id, status
            FROM public.background_task
            WHERE owner_id = %s AND contact_id = %s
              AND task_type = 'observation'
            FOR UPDATE
            """,
            (owner_id, contact_id),
        ).fetchone()
        if existing is None:
            task = connection.execute(
                """
                INSERT INTO public.background_task (
                    owner_id, contact_id, source_document_id,
                    task_type, status, current_step, message_count
                )
                VALUES (%s, %s, NULL, 'observation', 'queued',
                        'extract_memory', %s)
                RETURNING id
                """,
                (owner_id, contact_id, message_count),
            ).fetchone()
            if task is None:
                raise BackgroundTaskPersistenceError("观察任务创建失败。")
            task_id = task[0]
            _insert_task_steps(
                connection,
                task_id=task_id,
                steps=OBSERVATION_TASK_STEPS,
                total_count=message_count,
            )
            return task_id

        task_id, status = existing
        if status in {"succeeded", "failed", "cancelled"}:
            connection.execute(
                """
                UPDATE public.background_task
                SET status = 'queued', current_step = 'extract_memory',
                    message_count = %s, retry_count = 0,
                    last_error_code = NULL, started_at = NULL,
                    finished_at = NULL, observation_pending = false,
                    updated_at = now()
                WHERE id = %s
                """,
                (message_count, task_id),
            )
            connection.execute(
                """
                UPDATE public.background_task_step
                SET status = 'pending', attempt_count = 0,
                    processed_count = 0, total_count = %s,
                    worker_id = NULL, lease_expires_at = NULL,
                    last_error_code = NULL, started_at = NULL,
                    finished_at = NULL, updated_at = now()
                WHERE task_id = %s
                """,
                (message_count, task_id),
            )
        else:
            # queued/running/verifying 只登记最新的非正文计数，不重置租约。
            connection.execute(
                """
                UPDATE public.background_task
                SET message_count = GREATEST(message_count, %s),
                    observation_pending = CASE
                        WHEN status IN ('running', 'verifying') THEN true
                        ELSE observation_pending
                    END,
                    updated_at = now()
                WHERE id = %s
                """,
                (message_count, task_id),
            )
        _insert_task_steps(
            connection,
            task_id=task_id,
            steps=OBSERVATION_TASK_STEPS,
            total_count=message_count,
        )
        return task_id

    def enqueue_observation_message(
        self, *, owner_id: UUID, contact_id: UUID, message_id: UUID,
    ) -> UUID | None:
        """事件仅作提示；以已提交的观察来源与绑定确定任务范围。"""

        try:
            with psycopg.connect(self._database_url, connect_timeout=2) as connection:
                # 调度处在同步通知路径，锁等待不能占住宿主关闭协议。
                connection.execute("SET LOCAL statement_timeout = '250ms'")
                self._lock_scope(connection, owner_id, contact_id)
                observation = connection.execute(
                    """
                    SELECT observation.id, observation.record_count,
                           observation.memory_enqueued_at
                    FROM public.local_wechat_observation AS observation
                    JOIN public.message_source_ref AS ref
                      ON ref.observation_id = observation.id
                     AND ref.owner_id = observation.owner_id
                     AND ref.contact_id = observation.contact_id
                    JOIN public.conversation_binding AS binding
                      ON binding.id = observation.binding_id
                     AND binding.owner_id = observation.owner_id
                     AND binding.contact_id = observation.contact_id
                    WHERE observation.owner_id = %s AND observation.contact_id = %s
                      AND ref.message_id = %s AND binding.status = 'active'
                    ORDER BY observation.created_at DESC, observation.id
                    LIMIT 1
                    FOR SHARE OF observation, ref, binding
                    """,
                    (owner_id, contact_id, message_id),
                ).fetchone()
                if observation is None:
                    return None
                if observation[2] is not None:
                    # 旧批次不重排终态；排队中的配置恢复或唤醒重试复用原任务。
                    task = connection.execute(
                        """
                        SELECT id FROM public.background_task
                        WHERE owner_id = %s AND contact_id = %s
                          AND task_type = 'observation'
                          AND status IN ('queued', 'running', 'verifying')
                        """,
                        (owner_id, contact_id),
                    ).fetchone()
                    return task[0] if task else None
                task_id = self.create_observation_task(
                    connection, owner_id=owner_id, contact_id=contact_id,
                    message_count=observation[1],
                )
                connection.execute(
                    # 取实际登记时刻；事务可能在等待联系人锁之前已经开始。
                    "UPDATE public.local_wechat_observation SET memory_enqueued_at = clock_timestamp() WHERE id = %s",
                    (observation[0],),
                )
                return task_id
        except psycopg.Error:
            raise BackgroundTaskPersistenceError("观察记忆任务排队失败。") from None

    def has_authorized_observation(self, *, owner_id: UUID, contact_id: UUID) -> bool:
        """等待全局锁期间，来源删除或解绑应终止当前唤醒。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                return connection.execute(
                    """
                    SELECT 1 FROM public.local_wechat_observation AS observation
                    JOIN public.conversation_binding AS binding
                      ON binding.id = observation.binding_id
                     AND binding.owner_id = observation.owner_id
                     AND binding.contact_id = observation.contact_id
                    WHERE observation.owner_id = %s AND observation.contact_id = %s
                      AND binding.status = 'active'
                      AND EXISTS (
                          SELECT 1 FROM public.message_source_ref AS ref
                          WHERE ref.observation_id = observation.id
                            AND ref.owner_id = observation.owner_id
                            AND ref.contact_id = observation.contact_id
                      )
                    LIMIT 1
                    """,
                    (owner_id, contact_id),
                ).fetchone() is not None
        except psycopg.Error:
            raise BackgroundTaskPersistenceError("观察记忆任务来源检查失败。") from None

    def retry_pending_observation(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID,
    ) -> bool:
        """本轮失败时，只消费运行中已登记的新批次，不重开无新资料的失败任务。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, owner_id, contact_id)
                task = connection.execute(
                    """
                    SELECT task.message_count FROM public.background_task AS task
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                      AND task_type = 'observation' AND status = 'failed'
                      AND observation_pending
                      AND EXISTS (
                          SELECT 1 FROM public.local_wechat_observation AS observation
                          JOIN public.conversation_binding AS binding
                            ON binding.id = observation.binding_id
                           AND binding.owner_id = observation.owner_id
                           AND binding.contact_id = observation.contact_id
                          WHERE observation.owner_id = task.owner_id
                            AND observation.contact_id = task.contact_id
                            AND observation.memory_enqueued_at >= task.started_at
                            AND binding.status = 'active'
                            AND EXISTS (
                                SELECT 1 FROM public.message_source_ref AS ref
                                WHERE ref.observation_id = observation.id
                                  AND ref.owner_id = task.owner_id
                                  AND ref.contact_id = task.contact_id
                            )
                      )
                    FOR UPDATE OF task
                    """,
                    (owner_id, contact_id, task_id),
                ).fetchone()
                if task is None:
                    return False
                self.create_observation_task(
                    connection, owner_id=owner_id, contact_id=contact_id,
                    message_count=task[0],
                )
                return True
        except psycopg.Error:
            raise BackgroundTaskPersistenceError("观察记忆任务恢复失败。") from None

    def record_queued_reason(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID, error_code: str,
    ) -> None:
        """执行预检查失败只记录最小原因，不领取或改变步骤与重试预算。"""

        if error_code not in {
            "model_configuration_unavailable", "execution_resources_unavailable",
        }:
            raise ValueError("排队原因必须使用非正文错误分类。")
        try:
            with psycopg.connect(self._database_url) as connection:
                connection.execute(
                    f"""
                    UPDATE public.background_task AS task
                    SET last_error_code = %s, updated_at = now()
                    WHERE task.owner_id = %s AND task.contact_id = %s
                      AND task.id = %s AND task.status = 'queued'
                      AND ((task.task_type = 'import' AND EXISTS (
                          SELECT 1 FROM public.source_document AS source
                          WHERE source.id = task.source_document_id
                            AND source.owner_id = task.owner_id
                            AND source.contact_id = task.contact_id
                            AND source.status = 'active'
                      )) OR (task.task_type = 'observation' AND EXISTS (
                          SELECT 1 FROM public.conversation_binding AS binding
                          WHERE binding.owner_id = task.owner_id
                            AND binding.contact_id = task.contact_id
                            AND binding.status = 'active'
                      )) OR ({_learning_task_eligible_sql(connection)}) OR ({_upgrade_task_eligible_sql(connection)}) OR ({_layered_task_eligible_sql(connection)}))
                    """,
                    (error_code, owner_id, contact_id, task_id),
                )
        except psycopg.Error:
            raise BackgroundTaskPersistenceError("排队原因记录失败。") from None

    def has_active_layered_work(self, *, owner_id, contact_id, task_id):
        with psycopg.connect(self._database_url) as connection:
            return bool(connection.execute("SELECT 1 FROM public.layered_memory_job j JOIN public.layered_memory_state s "
                "ON s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id WHERE j.task_id=%s AND j.owner_id=%s "
                "AND j.contact_id IS NOT DISTINCT FROM %s AND j.state='active' AND s.enabled AND j.settings_generation=s.settings_generation",
                (task_id,owner_id,contact_id)).fetchone())

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
                        step.updated_at,
                        to_jsonb(task)->'extraction_runtime_config'
                    FROM public.background_task AS task
                    LEFT JOIN public.background_task_step AS step
                      ON step.task_id = task.id
                    WHERE task.owner_id = %s
                      AND task.contact_id IS NOT DISTINCT FROM %s
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
            extraction_runtime_config=_runtime_config(first[26]),
        )

    def configure_extraction_runtime(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID,
        config: ExtractionRuntimeConfig,
    ) -> ExtractionRuntimeConfig:
        """在提取首次领取前固定配置；与领取沿相同的范围、任务、步骤锁序。"""

        for value, name in ((owner_id, "owner_id"), (contact_id, "contact_id"), (task_id, "task_id")):
            _validate_uuid(value, name)
        if not isinstance(config, ExtractionRuntimeConfig):
            raise ValueError("提取任务配置无效。")
        try:
            with psycopg.connect(self._database_url) as connection:
                self._lock_scope(connection, owner_id, contact_id)
                _require_runtime_config_capability(
                    connection, bounded=config.mode is ExtractionRuntimeMode.BOUNDED_RUNTIME_V1,
                )
                task = connection.execute(
                    """
                    SELECT status, to_jsonb(task)->'extraction_runtime_config'
                    FROM public.background_task AS task
                    WHERE id=%s AND owner_id=%s AND contact_id=%s
                    FOR UPDATE
                    """, (task_id, owner_id, contact_id),
                ).fetchone()
                if task is None or task[0] not in {'queued', 'running'}:
                    raise BackgroundTaskStateError("当前任务不允许选择提取模式。")
                step = connection.execute(
                    """
                    SELECT status, attempt_count, lease_generation, started_at
                    FROM public.background_task_step
                    WHERE task_id=%s AND step_name='extract_memory'
                    FOR UPDATE
                    """, (task_id,),
                ).fetchone()
                if (step is None or step[0] != 'pending' or step[1] != 0
                        or step[2] != 0 or step[3] is not None):
                    raise BackgroundTaskStateError("提取步骤已领取或不允许初始化配置。")
                current = _runtime_config(task[1])
                if current is not None:
                    if current != config:
                        raise BackgroundTaskStateError("提取任务已固定另一运行配置。")
                    return current
                connection.execute(
                    """
                    UPDATE public.background_task
                    SET extraction_runtime_config=%s, updated_at=now()
                    WHERE id=%s
                    """, (Jsonb(config.to_payload()), task_id),
                )
                return config
        except psycopg.Error:
            raise BackgroundTaskPersistenceError("提取任务配置保存失败。") from None

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
        runtime_rule_set_sha256: str | None = None,
    ) -> ClaimedBackgroundTaskStep | None:
        """原子领取一个联系人范围内、顺序合法的步骤租约。"""

        _validate_uuid(owner_id, "owner_id")
        if contact_id is not None:
            _validate_uuid(contact_id, "contact_id")
        elif task_id is None:
            raise ValueError("本人整理领取必须明确任务。")
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
                    f"""
                    SELECT 1
                    FROM public.background_task_step AS step
                    JOIN public.background_task AS task
                      ON task.id = step.task_id
                    LEFT JOIN public.source_document AS source
                      ON source.id = task.source_document_id
                    WHERE task.owner_id = %s
                      AND task.contact_id IS NOT DISTINCT FROM %s
                      AND ((task.task_type = 'import' AND source.status = 'active')
                   OR (task.task_type = 'delete' AND source.status IN
                       ('delete_requested', 'deleting', 'delete_failed', 'deleted'))
                   OR (task.task_type = 'observation' AND EXISTS (
                       SELECT 1
                       FROM public.conversation_binding AS binding
                       WHERE binding.owner_id = task.owner_id
                         AND binding.contact_id = task.contact_id
                         AND binding.status = 'active'
                   ))
                   OR ({_learning_task_eligible_sql(connection)}) OR ({_upgrade_task_eligible_sql(connection)}) OR ({_layered_task_eligible_sql(connection)}))
                      AND step.status = 'running'
                      AND step.lease_expires_at > now()
                    LIMIT 1
                    """,
                    (owner_id, contact_id),
                ).fetchone()
                if active is not None:
                    return None
                candidate = connection.execute(
                    f"""
                    SELECT
                        step.id,
                        task.id,
                        task.owner_id,
                        task.contact_id,
                        task.source_document_id,
                        step.step_name,
                        step.attempt_count,
                        task.message_count,
                        to_jsonb(task)->'extraction_runtime_config'
                    FROM public.background_task_step AS step
                    JOIN public.background_task AS task
                      ON task.id = step.task_id
                    LEFT JOIN public.source_document AS source
                      ON source.id = task.source_document_id
                    WHERE task.owner_id = %s
                      AND task.contact_id IS NOT DISTINCT FROM %s
                      AND ((task.task_type = 'import' AND source.status = 'active')
                   OR (task.task_type = 'delete' AND source.status IN
                       ('delete_requested', 'deleting', 'delete_failed', 'deleted'))
                   OR (task.task_type = 'observation' AND EXISTS (
                       SELECT 1
                       FROM public.conversation_binding AS binding
                       WHERE binding.owner_id = task.owner_id
                         AND binding.contact_id = task.contact_id
                         AND binding.status = 'active'
                   ))
                   OR ({_learning_task_eligible_sql(connection)}) OR ({_upgrade_task_eligible_sql(connection)}) OR ({_layered_task_eligible_sql(connection)}))
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
                runtime_config = _runtime_config(candidate[8])
                if candidate[5] == BackgroundTaskStepName.EXTRACT_MEMORY.value and runtime_config is not None:
                    _require_runtime_config_capability(
                        connection, bounded=runtime_config.mode is ExtractionRuntimeMode.BOUNDED_RUNTIME_V1,
                    )
                    if (runtime_config.mode is ExtractionRuntimeMode.BOUNDED_RUNTIME_V1
                            and runtime_config.rule_set_sha256 != runtime_rule_set_sha256):
                        raise BackgroundTaskStateError("已固定的提取规则当前不可执行。")
                next_attempt = candidate[6] + 1
                lease_expires_at = connection.execute(
                    """
                    UPDATE public.background_task_step
                    SET status = 'running',
                        attempt_count = %s,
                        lease_generation = lease_generation + 1,
                        worker_id = %s,
                        lease_expires_at = now() + %s::interval,
                        last_error_code = NULL,
                        started_at = COALESCE(started_at, now()),
                        updated_at = now()
                    WHERE id = %s
                    RETURNING lease_expires_at, lease_generation
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
                        last_error_code = NULL,
                        current_step = %s,
                        model_version = COALESCE(%s, model_version),
                        rule_version = COALESCE(%s, rule_version),
                        started_at = COALESCE(started_at, clock_timestamp()),
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
                    lease_generation=lease_expires_at[1],
                    extraction_runtime_config=runtime_config,
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
                if claim.name is BackgroundTaskStepName.ORGANIZE_MEMORY:
                    from notalone.persistence.layered_coverage import finish_coverage_receipt
                    finish_coverage_receipt(connection, claim)
                    return
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
                    observation_pending = connection.execute(
                        """
                        SELECT task_type IN ('observation','skill_learning') AND observation_pending, task_type
                        FROM public.background_task
                        WHERE id = %s
                        FOR UPDATE
                        """,
                        (claim.task_id,),
                    ).fetchone()
                    if observation_pending is None:
                        raise BackgroundTaskNotFoundError("指定范围内不存在该后台任务。")
                    requeue_observation = bool(observation_pending[0])
                    if requeue_observation:
                        connection.execute(
                            """
                            UPDATE public.background_task_step
                            SET status = 'pending', attempt_count = 0,
                                processed_count = 0, worker_id = NULL,
                                lease_expires_at = NULL, last_error_code = NULL,
                                started_at = NULL, finished_at = NULL,
                                updated_at = now()
                            WHERE task_id = %s
                            """,
                            (claim.task_id,),
                        )
                    connection.execute(
                        """
                        UPDATE public.background_task
                        SET status = CASE WHEN %s THEN 'queued' ELSE 'succeeded' END,
                            last_error_code = NULL,
                            current_step = CASE WHEN %s
                                THEN %s ELSE %s END,
                            observation_pending = false,
                            started_at = CASE WHEN %s THEN NULL ELSE started_at END,
                            finished_at = CASE WHEN %s THEN NULL ELSE now() END,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (
                            requeue_observation,
                            requeue_observation,
                            'propose_skill' if observation_pending[1] == 'skill_learning' else 'extract_memory',
                            claim.name.value,
                            requeue_observation,
                            requeue_observation,
                            claim.task_id,
                        ),
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
                    SELECT task.status, task.task_type, source.status,
                           EXISTS (
                               SELECT 1
                               FROM public.conversation_binding AS binding
                               WHERE binding.owner_id = task.owner_id
                                 AND binding.contact_id = task.contact_id
                                 AND binding.status = 'active'
                           )
                    FROM public.background_task AS task
                    LEFT JOIN public.source_document AS source
                      ON source.id = task.source_document_id
                     AND source.owner_id = task.owner_id
                     AND source.contact_id = task.contact_id
                    WHERE task.id = %s AND task.owner_id = %s AND task.contact_id = %s
                    FOR UPDATE OF task
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
                ) or (
                    task[1] == BackgroundTaskType.OBSERVATION.value and task[3]
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
        if contact_id is None:
            lock_owner_scope(connection, owner_id=owner_id)
            return
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
              AND task.contact_id IS NOT DISTINCT FROM %s
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
              AND task.contact_id IS NOT DISTINCT FROM %s
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
            f"""
            SELECT step.status, step.worker_id, step.lease_expires_at,
                   step.lease_generation
            FROM public.background_task_step AS step
            JOIN public.background_task AS task ON task.id = step.task_id
            LEFT JOIN public.source_document AS source
              ON source.id = task.source_document_id
            WHERE step.id = %s
              AND step.task_id = %s
              AND task.owner_id = %s
              AND task.contact_id IS NOT DISTINCT FROM %s
              AND task.status IN ('queued', 'running', 'verifying')
              AND ((task.task_type = 'import' AND source.status = 'active')
                   OR (task.task_type = 'delete' AND source.status IN
                       ('delete_requested', 'deleting', 'delete_failed', 'deleted'))
                   OR (task.task_type = 'observation' AND EXISTS (
                       SELECT 1
                       FROM public.conversation_binding AS binding
                       WHERE binding.owner_id = task.owner_id
                         AND binding.contact_id = task.contact_id
                         AND binding.status = 'active'
                   ))
                   OR ({_learning_task_eligible_sql(connection)}) OR ({_upgrade_task_eligible_sql(connection)}) OR ({_layered_task_eligible_sql(connection)}))
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
            or row[3] != claim.lease_generation
        ):
            raise BackgroundTaskLeaseError("后台步骤租约已失效。")


def _runtime_config(raw: object) -> ExtractionRuntimeConfig | None:
    if raw is None:
        return None
    try:
        return ExtractionRuntimeConfig.from_payload(raw)
    except (TypeError, ValueError):
        raise BackgroundTaskStateError("已保存的提取任务配置无效。") from None


def _require_runtime_config_capability(
    connection: psycopg.Connection[Any], *, bounded: bool,
) -> None:
    """只核已安装且已验证的能力，不在任务路径执行DDL或升级旧库。"""

    available = connection.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid='public.background_task'::regclass
              AND attname='extraction_runtime_config' AND NOT attisdropped
              AND atttypid='jsonb'::regtype
        ) AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
            WHERE conrelid='public.background_task'::regclass
              AND conname='background_task_extraction_runtime_config_check'
              AND contype='c' AND convalidated
        )
        """,
    ).fetchone()
    if available is None or not available[0]:
        raise BackgroundTaskStateError("数据库尚不支持指定提取运行模式。")
    if not bounded:
        return
    if not supports_bounded_runtime_evidence(connection):
        raise BackgroundTaskStateError("数据库尚不支持有限运行依据及来源依赖。")


def _validate_uuid(value: UUID, label: str) -> None:
    if not isinstance(value, UUID):
        raise TypeError(f"{label} 必须是 UUID。")


def _insert_task_steps(
    connection: psycopg.Connection[Any],
    *,
    task_id: UUID,
    steps: Iterable[tuple[BackgroundTaskStepName, int]],
    total_count: int,
) -> None:
    """幂等写入固定任务步骤模板。"""

    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO public.background_task_step (
                task_id, step_name, step_order, status, total_count
            )
            VALUES (%s, %s, %s, 'pending', %s)
            ON CONFLICT (task_id, step_name) DO NOTHING
            """,
            [
                (task_id, step_name, step_order, total_count)
                for step_name, step_order in steps
            ],
        )


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


def _learning_task_eligible_sql(connection) -> str:
    """旧迁移阶段保持原任务合同；安装063后才接入学习用途授权。"""

    row = connection.execute("SELECT to_regclass('public.skill_learning_scope')").fetchone()
    if row is None or row[0] is None:
        return "false"
    return """task.task_type = 'skill_learning' AND EXISTS (
        SELECT 1 FROM public.skill_learning_scope AS setting
        JOIN public.conversation_binding AS binding
          ON binding.owner_id=setting.owner_id AND binding.contact_id=setting.contact_id
        WHERE setting.owner_id=task.owner_id AND setting.contact_id=task.contact_id
          AND setting.enabled AND binding.status='active'
    )"""


def _upgrade_task_eligible_sql(connection) -> str:
    """只执行同scope显式工作中的固定步骤，旧迁移基线不引用新表。"""
    row = connection.execute("SELECT to_regclass('public.memory_upgrade_job')").fetchone()
    if row is None or row[0] is None:
        return "false"
    return """task.task_type='memory_upgrade' AND EXISTS (
        SELECT 1 FROM public.memory_upgrade_batch b JOIN public.memory_upgrade_job j
        ON j.id=b.job_id AND j.owner_id=b.owner_id
        JOIN public.conversation_binding binding ON binding.owner_id=b.owner_id AND binding.contact_id=b.contact_id
        WHERE b.task_id=task.id AND b.owner_id=task.owner_id AND b.contact_id=task.contact_id
          AND j.state='active' AND b.state IN ('queued','ready','apply_queued','applied')
          AND (j.scope_kind='owner' OR j.contact_id=b.contact_id) AND binding.status='active'
    )"""


def _layered_task_eligible_sql(connection) -> str:
    if connection.execute("SELECT to_regclass('public.layered_memory_job')").fetchone()[0] is None:
        return "false"
    return """task.task_type='layered_memory' AND EXISTS (
        SELECT 1 FROM public.layered_memory_job j JOIN public.layered_memory_state s
        ON s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id
        WHERE j.task_id=task.id AND j.owner_id=task.owner_id AND j.contact_id IS NOT DISTINCT FROM task.contact_id
        AND s.enabled AND s.settings_generation=j.settings_generation AND j.state='active')"""
