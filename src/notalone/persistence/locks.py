"""PostgreSQL 事务级领域锁。"""

from __future__ import annotations

from typing import Any
from uuid import UUID


GLOBAL_WORKER_LOCK_NAME = "notalone:global-worker"


def lock_contact_scope(
    connection: Any,
    *,
    owner_id: UUID,
    contact_id: UUID,
) -> None:
    """串行化一个 owner/contact 范围内的记忆、任务和来源操作。"""

    connection.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
        (f"contact:{owner_id}:{contact_id}",),
    )


def lock_owner_scope(connection: Any, *, owner_id: UUID) -> None:
    """串行化 owner 级记忆与来源派生清理。"""

    connection.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
        (f"owner:{owner_id}",),
    )


def try_acquire_global_worker_lock(connection: Any) -> bool:
    """尝试取得当前进程唯一的全局 Worker 会话锁。"""

    row = connection.execute(
        "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))",
        (GLOBAL_WORKER_LOCK_NAME,),
    ).fetchone()
    return bool(row and row[0])


def release_global_worker_lock(connection: Any) -> None:
    """释放当前连接持有的全局 Worker 会话锁。"""

    connection.execute(
        "SELECT pg_advisory_unlock(hashtextextended(%s, 0))",
        (GLOBAL_WORKER_LOCK_NAME,),
    )
