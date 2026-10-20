"""记忆任务的来源范围、完成回执与只读进度投影。"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from notalone.application.import_service import TaskHost

import psycopg
from psycopg.rows import dict_row

from notalone.persistence.background_tasks import (
    BackgroundTaskNotFoundError,
    BackgroundTaskStateError,
)
from notalone.persistence.locks import lock_contact_scope
from notalone.persistence.message_sources import active_source_ref_sql


class PostgresMemoryProcessingStore:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    @staticmethod
    def _source_allowed(connection: psycopg.Connection, task: dict[str, Any]) -> bool:
        if task["task_type"] == "import":
            return bool(
                connection.execute(
                    "SELECT 1 FROM public.source_document WHERE id=%s AND owner_id=%s AND contact_id=%s AND status='active'",
                    (task["source_document_id"], task["owner_id"], task["contact_id"]),
                ).fetchone()
            )
        return bool(
            connection.execute(
                (
                    "SELECT 1 FROM public.local_wechat_observation o JOIN "
                    "public.conversation_binding b ON b.id=o.binding_id AND "
                    "b.owner_id=o.owner_id AND b.contact_id=o.contact_id WHERE "
                    "o.owner_id=%s AND o.contact_id=%s AND b.status='active' AND "
                    "o.memory_enqueued_at IS NOT NULL"
                ),
                (task["owner_id"], task["contact_id"]),
            ).fetchone()
        )

    def targets(
        self, *, owner_id: UUID, contact_id: UUID, task_id: UUID
    ) -> tuple[tuple[UUID, ...], tuple[UUID, ...], int]:
        """首次只冻结本来源可提取消息；观察任务的新一轮可追加已授权批次。"""
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_contact_scope(connection, owner_id=owner_id, contact_id=contact_id)
            task = connection.execute(
                (
                    "SELECT * FROM public.background_task WHERE id=%s AND owner_id=%s AND "
                    "contact_id=%s AND task_type IN ('import','observation') FOR UPDATE"
                ),
                (task_id, owner_id, contact_id),
            ).fetchone()
            if task is None:
                raise BackgroundTaskNotFoundError("记忆任务不存在。")
            source_allowed = self._source_allowed(connection, task)
            # 来源已经删空的旧观察轮次可结束为空操作；不读取未登记批次。
            if task["task_type"] == "observation" and not source_allowed:
                source_allowed = bool(
                    connection.execute(
                        "SELECT 1 FROM public.conversation_binding WHERE owner_id=%s AND contact_id=%s AND status='active'",
                        (owner_id, contact_id),
                    ).fetchone()
                )
            if task["status"] not in ("running", "queued") or not source_allowed:
                raise BackgroundTaskStateError("任务来源不可用。")
            lease = connection.execute(
                (
                    "SELECT lease_generation FROM public.background_task_step WHERE "
                    "task_id=%s AND step_name='extract_memory' AND status='running' AND "
                    "lease_expires_at>now()"
                ),
                (task_id,),
            ).fetchone()
            if lease is None:
                raise BackgroundTaskStateError("任务没有有效提取租约。")
            inserted = connection.execute(
                (
                    "INSERT INTO public.memory_processing_plan(task_id,owner_id,contact_id)"
                    " VALUES (%s,%s,%s) ON CONFLICT DO NOTHING RETURNING task_id"
                ),
                (task_id, owner_id, contact_id),
            ).fetchone()
            context_rows = connection.execute(
                f"""
                SELECT DISTINCT m.id FROM public.message m
                JOIN public.message_source_ref ref ON ref.message_id=m.id AND ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id
                LEFT JOIN public.local_wechat_observation observation ON observation.id=ref.observation_id
                WHERE m.owner_id=%s AND m.contact_id=%s AND m.speaker IN ('user','contact')
                  AND m.occurred_at IS NOT NULL AND length(btrim(COALESCE(NULLIF(m.text_content,''),m.media_placeholder,'')))>0
                  AND {active_source_ref_sql()}
                  AND ((%s='import' AND ref.source_document_id=%s)
                    OR (%s='observation' AND observation.memory_enqueued_at IS NOT NULL
                      AND EXISTS (SELECT 1 FROM public.conversation_binding b WHERE b.id=observation.binding_id AND b.owner_id=observation.owner_id AND b.contact_id=observation.contact_id AND b.status='active')))
                """,
                (
                    owner_id,
                    contact_id,
                    task["task_type"],
                    task["source_document_id"],
                    task["task_type"],
                ),
            ).fetchall()
            context_ids = tuple(row["id"] for row in context_rows)
            if inserted:
                target_ids = context_ids
                if task["task_type"] == "observation":
                    # 旧任务首次显式恢复沿用既有水位；新观察在入队时已冻结自身目标。
                    boundary = connection.execute(
                        """SELECT m.occurred_at,m.created_at,m.id
                        FROM public.memory_extraction_watermark w
                        JOIN public.message m ON m.id=w.last_message_id
                          AND m.owner_id=w.owner_id AND m.contact_id=w.contact_id
                        WHERE w.owner_id=%s AND w.contact_id=%s""",
                        (owner_id, contact_id),
                    ).fetchone()
                    if boundary is not None:
                        target_rows = connection.execute(
                            """SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s
                            AND id=ANY(%s) AND (occurred_at,created_at,id)>(%s,%s,%s)""",
                            (
                                owner_id,
                                contact_id,
                                list(context_ids),
                                boundary["occurred_at"],
                                boundary["created_at"],
                                boundary["id"],
                            ),
                        ).fetchall()
                        target_ids = tuple(row["id"] for row in target_rows)
                connection.execute(
                    """
                    INSERT INTO public.memory_processing_target(task_id,message_id,owner_id,contact_id)
                    SELECT %s,m.id,m.owner_id,m.contact_id FROM public.message m WHERE m.owner_id=%s AND m.contact_id=%s AND m.id=ANY(%s)
                      AND NOT EXISTS (SELECT 1 FROM public.memory_processing_receipt done WHERE done.message_id=m.id AND done.owner_id=m.owner_id AND done.contact_id=m.contact_id)
                    ON CONFLICT DO NOTHING
                    """,
                    (task_id, owner_id, contact_id, list(target_ids)),
                )
            connection.execute(
                (
                    "UPDATE public.memory_processing_target x SET "
                    "completed_at=r.completed_at,outcome=r.outcome FROM "
                    "public.memory_processing_receipt r WHERE x.task_id=%s AND "
                    "x.message_id=r.message_id AND x.owner_id=r.owner_id AND "
                    "x.contact_id=r.contact_id AND x.completed_at IS NULL"
                ),
                (task_id,),
            )
            rows = connection.execute(
                "SELECT message_id FROM public.memory_processing_target WHERE task_id=%s AND completed_at IS NULL",
                (task_id,),
            ).fetchall()
            return (
                tuple(row["message_id"] for row in rows),
                context_ids,
                lease["lease_generation"],
            )

    def read(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID | None = None,
        host: TaskHost | None = None,
    ) -> dict[str, object]:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            connection.execute("SET TRANSACTION READ ONLY")
            if (
                contact_id is not None
                and not connection.execute(
                    "SELECT 1 FROM public.contact WHERE owner_id=%s AND id=%s",
                    (owner_id, contact_id),
                ).fetchone()
            ):
                raise BackgroundTaskNotFoundError("联系人不存在。")
            rows = connection.execute(
                """
                SELECT t.*,p.task_id AS planned,p.updated_at AS progress_at,
                    (SELECT count(*) FROM public.memory_processing_target x WHERE x.task_id=t.id) AS total,
                    (SELECT count(*) FROM public.memory_processing_target x WHERE x.task_id=t.id AND x.completed_at IS NOT NULL) AS processed,
                    (SELECT count(*) FROM public.memory_processing_target x WHERE x.task_id=t.id AND x.outcome='skipped') AS skipped,
                    (SELECT count(*) FROM public.memory_processing_target x WHERE x.task_id=t.id AND x.outcome='unknown') AS unknown,
                    (SELECT max(s.lease_expires_at) FROM public.background_task_step s WHERE s.task_id=t.id AND s.status='running') AS lease
                FROM public.background_task t LEFT JOIN public.memory_processing_plan p ON p.task_id=t.id
                WHERE t.owner_id=%s AND (%s::uuid IS NULL OR t.contact_id=%s) AND t.task_type IN ('import','observation')
                ORDER BY CASE WHEN t.status IN ('queued','running','verifying') THEN 0 ELSE 1 END,t.updated_at DESC,t.id
                LIMIT 101
                """,
                (owner_id, contact_id, contact_id),
            ).fetchall()
            tasks = []
            for row in rows[:100]:
                source_allowed = self._source_allowed(connection, row)
                scheduled = (
                    host.processing_state(
                        owner_id=owner_id,
                        contact_id=row["contact_id"],
                        task_id=row["id"],
                    )
                    if host
                    else None
                )
                live_lease = row["lease"] is not None and row["lease"] > datetime.now(
                    timezone.utc
                )
                raw = row["status"]
                reason = row["last_error_code"]
                action = None
                if raw == "succeeded":
                    state = "completed"
                    if row["skipped"]:
                        reason = "batches_skipped"
                    elif row["unknown"]:
                        reason = "processing_outcome_unknown"
                elif raw == "cancelled":
                    state = "stopped"
                    reason = reason or "task_cancelled"
                    action = "restart"
                elif raw == "failed":
                    state = "failed"
                    action = "resume"
                elif live_lease or scheduled == "active":
                    state = "extracting"
                elif scheduled == "queued":
                    state = "queued"
                else:
                    state = "interrupted"
                    reason = reason or "execution_interrupted"
                    action = "resume"
                if not source_allowed:
                    action = None
                    reason = "source_unavailable"
                tasks.append(
                    dict(
                        task_id=str(row["id"]),
                        contact_id=str(row["contact_id"]),
                        task_type=row["task_type"],
                        status=state,
                        phase=row["current_step"],
                        processed_count=row["processed"] if row["planned"] else None,
                        total_count=row["total"] if row["planned"] else None,
                        created_count=None,
                        updated_count=None,
                        updated_at=(
                            row["progress_at"] or row["updated_at"]
                        ).isoformat(),
                        reason_code=reason,
                        action=action,
                    )
                )
            return dict(
                scope="contact" if contact_id else "owner",
                contact_id=str(contact_id) if contact_id else None,
                tasks=tasks,
                has_more=len(rows) > 100,
            )

    def resume(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID | None,
        task_id: UUID,
        action: str,
        host: TaskHost | None,
    ) -> dict[str, object]:
        if host is None:
            raise BackgroundTaskStateError("任务执行器不可用。")
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            # 本人页仍从任务的真实联系人确定锁及授权范围。
            task = connection.execute(
                (
                    "SELECT * FROM public.background_task WHERE id=%s AND owner_id=%s AND "
                    "(%s::uuid IS NULL OR contact_id=%s) AND task_type IN "
                    "('import','observation')"
                ),
                (task_id, owner_id, contact_id, contact_id),
            ).fetchone()
            if task is None:
                raise BackgroundTaskNotFoundError("记忆任务不存在。")
            contact_id = task["contact_id"]
            lock_contact_scope(connection, owner_id=owner_id, contact_id=contact_id)
            task = connection.execute(
                "SELECT * FROM public.background_task WHERE id=%s FOR UPDATE",
                (task_id,),
            ).fetchone()
            if not self._source_allowed(connection, task):
                raise BackgroundTaskStateError("任务来源不可用。")
            live = connection.execute(
                "SELECT 1 FROM public.background_task_step WHERE task_id=%s AND status='running' AND lease_expires_at>now()",
                (task_id,),
            ).fetchone()
            scheduled = host.processing_state(
                owner_id=owner_id, contact_id=contact_id, task_id=task_id
            )
            if live or scheduled:
                return dict(task_id=str(task_id), status="busy")
            if task["status"] == "succeeded":
                return dict(task_id=str(task_id), status="completed")
            if (task["status"] == "cancelled") != (action == "restart"):
                raise BackgroundTaskStateError("任务状态与恢复动作不匹配。")
            connection.execute(
                """UPDATE public.background_task_step SET status='pending',attempt_count=0,
                worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,finished_at=NULL,updated_at=now()
                WHERE task_id=%s AND status<>'succeeded'""",
                (task_id,),
            )
            next_step = connection.execute(
                (
                    "SELECT step_name FROM public.background_task_step WHERE task_id=%s AND"
                    " status<>'succeeded' ORDER BY step_order LIMIT 1"
                ),
                (task_id,),
            ).fetchone()
            if next_step is None:
                raise BackgroundTaskStateError("任务无可继续步骤。")
            connection.execute(
                (
                    "UPDATE public.background_task SET "
                    "status='queued',current_step=%s,last_error_code=NULL,finished_at=NULL,retry_count=retry_count+1,updated_at=now()"
                    " WHERE id=%s"
                ),
                (next_step["step_name"], task_id),
            )
        result = host.wake(owner_id=owner_id, contact_id=contact_id, task_id=task_id)
        return dict(
            task_id=str(task_id),
            status="busy" if result["status"] == "busy" else "queued",
        )


def complete_processing_batch(
    connection: psycopg.Connection, scope, trace_id: UUID, *, outcome: str
) -> None:
    """与批次结束/水位提交同事务记账，失败或重复结束不会增加完成量。"""
    row = connection.execute(
        (
            "SELECT payload FROM public.memory_extraction_trace_event WHERE trace_id=%s AND"
            " owner_id=%s AND contact_id=%s AND stage='window' ORDER BY position LIMIT 1"
        ),
        (trace_id, scope.owner_id, scope.contact_id),
    ).fetchone()
    if row is None:
        return
    payload = row[0]
    ids = [UUID(value) for value in payload.get("target_message_ids", [])]
    if not ids:
        return
    runtime = payload.get("task_runtime", {})
    task_id = runtime.get("task_id")
    if task_id and runtime.get("lease_generation") is not None:
        from notalone.persistence.memory_processing_lease import assert_extraction_lease

        assert_extraction_lease(
            connection,
            scope=scope,
            task_id=UUID(task_id),
            generation=runtime["lease_generation"],
        )
    connection.execute(
        (
            "INSERT INTO "
            "public.memory_processing_receipt(message_id,owner_id,contact_id,outcome) "
            "SELECT id,owner_id,contact_id,%s FROM public.message WHERE owner_id=%s AND "
            "contact_id=%s AND id=ANY(%s) ON CONFLICT DO NOTHING"
        ),
        (outcome, scope.owner_id, scope.contact_id, ids),
    )
    if task_id:
        connection.execute(
            (
                "UPDATE public.memory_processing_target x SET completed_at=now(),outcome=%s"
                " FROM public.background_task t WHERE x.task_id=t.id AND t.owner_id=%s AND "
                "t.contact_id=%s AND x.task_id=%s AND x.message_id=ANY(%s) AND "
                "x.completed_at IS NULL"
            ),
            (outcome, scope.owner_id, scope.contact_id, task_id, ids),
        )
        connection.execute(
            "UPDATE public.memory_processing_plan SET updated_at=now() WHERE task_id=%s",
            (task_id,),
        )


def enroll_observation_targets(
    connection,
    *,
    owner_id: UUID,
    contact_id: UUID,
    task_id: UUID,
    observation_id: UUID,
    include_legacy_pending: bool = False,
) -> None:
    """新批次精确登记；旧未完成任务首次迁移只保留水位之后的授权目标。"""
    inserted = connection.execute(
        "INSERT INTO public.memory_processing_plan(task_id,owner_id,contact_id) "
        "VALUES (%s,%s,%s) ON CONFLICT DO NOTHING RETURNING task_id",
        (task_id, owner_id, contact_id),
    ).fetchone()
    if inserted and include_legacy_pending:
        connection.execute(
            """
            INSERT INTO public.memory_processing_target(task_id,message_id,owner_id,contact_id)
            SELECT DISTINCT %s,m.id,m.owner_id,m.contact_id
            FROM public.message m
            JOIN public.message_source_ref ref ON ref.message_id=m.id
              AND ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id
            JOIN public.local_wechat_observation o ON o.id=ref.observation_id
              AND o.owner_id=m.owner_id AND o.contact_id=m.contact_id
            JOIN public.conversation_binding b ON b.id=o.binding_id
              AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
            LEFT JOIN public.memory_extraction_watermark w ON w.owner_id=m.owner_id
              AND w.contact_id=m.contact_id
            LEFT JOIN public.message boundary ON boundary.id=w.last_message_id
              AND boundary.owner_id=m.owner_id AND boundary.contact_id=m.contact_id
            WHERE m.owner_id=%s AND m.contact_id=%s AND b.status='active'
              AND o.memory_enqueued_at IS NOT NULL
              AND m.speaker IN ('user','contact') AND m.occurred_at IS NOT NULL
              AND length(btrim(COALESCE(NULLIF(m.text_content,''),m.media_placeholder,'')))>0
              AND (boundary.id IS NULL OR (m.occurred_at,m.created_at,m.id)>
                   (boundary.occurred_at,boundary.created_at,boundary.id))
              AND NOT EXISTS (
                  SELECT 1 FROM public.memory_processing_receipt r WHERE r.message_id=m.id
                    AND r.owner_id=m.owner_id AND r.contact_id=m.contact_id
              )
            ON CONFLICT DO NOTHING
            """,
            (task_id, owner_id, contact_id),
        )
    connection.execute(
        """INSERT INTO public.memory_processing_target(task_id,message_id,owner_id,contact_id)
        SELECT DISTINCT %s,m.id,m.owner_id,m.contact_id
        FROM public.message m
        JOIN public.message_source_ref ref ON ref.message_id=m.id AND ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id
        JOIN public.local_wechat_observation o ON o.id=ref.observation_id AND o.owner_id=m.owner_id AND o.contact_id=m.contact_id
        JOIN public.conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
        WHERE m.owner_id=%s AND m.contact_id=%s AND o.id=%s AND b.status='active'
          AND m.speaker IN ('user','contact') AND m.occurred_at IS NOT NULL
          AND length(btrim(COALESCE(NULLIF(m.text_content,''),m.media_placeholder,'')))>0
          AND NOT EXISTS (SELECT 1 FROM public.memory_processing_receipt r WHERE r.message_id=m.id AND r.owner_id=m.owner_id AND r.contact_id=m.contact_id)
        ON CONFLICT DO NOTHING""",
        (task_id, owner_id, contact_id, observation_id),
    )
