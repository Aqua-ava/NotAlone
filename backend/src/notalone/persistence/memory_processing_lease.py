"""提取任务的事务写入围栏：旧租约不能提交候选、关系或本人记忆。"""

from __future__ import annotations

from contextlib import contextmanager
from copy import copy
from uuid import UUID

from notalone.persistence.background_tasks import BackgroundTaskLeaseError
from notalone.persistence.locks import lock_contact_scope
from notalone.scopes import ContactScope


def assert_extraction_lease(
    connection, *, scope: ContactScope, task_id: UUID, generation: int
) -> None:
    """调用方先取得联系人锁；持有步骤行锁直到写事务提交。"""
    row = connection.execute(
        """
        SELECT 1
        FROM public.background_task AS task
        JOIN public.background_task_step AS step ON step.task_id = task.id
        WHERE task.id = %s AND task.owner_id = %s AND task.contact_id = %s
          AND task.status = 'running' AND step.step_name = 'extract_memory'
          AND step.status = 'running' AND step.lease_generation = %s
          AND step.lease_expires_at > clock_timestamp()
        FOR UPDATE OF task, step
        """,
        (task_id, scope.owner_id, scope.contact_id, generation),
    ).fetchone()
    if row is None:
        raise BackgroundTaskLeaseError("提取任务租约已经失效。")


def fenced_memory_store(store, *, scope: ContactScope, task_id: UUID, generation: int):
    """每次运行独立装配连接工厂；不修改共享仓储、不持锁等待模型。"""
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore

    if not isinstance(store, (PostgresMemoryStore, PostgresOwnerMemoryStore)):
        return store

    @contextmanager
    def connection_factory():
        with store._connect() as connection:
            lock_contact_scope(
                connection, owner_id=scope.owner_id, contact_id=scope.contact_id
            )
            assert_extraction_lease(
                connection, scope=scope, task_id=task_id, generation=generation
            )
            yield connection
            # 查询期间租约也可能到期；提交前再次确认，过期则回滚本事务。
            assert_extraction_lease(
                connection, scope=scope, task_id=task_id, generation=generation
            )

    fenced = copy(store)
    fenced._connection_factory = connection_factory
    return fenced
