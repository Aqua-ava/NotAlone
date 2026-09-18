"""用真实数据库锁等待建立并发测试屏障。"""

import time

import psycopg


def wait_for_blocked_operations(
    database_url: str, blocker_pids: set[int], count: int
) -> set[int]:
    deadline = time.monotonic() + 5
    with psycopg.connect(database_url, autocommit=True) as connection:
        while time.monotonic() < deadline:
            rows = connection.execute(
                """
                SELECT pid FROM pg_stat_activity
                WHERE pg_blocking_pids(pid) && %s::integer[]
                """,
                (list(blocker_pids),),
            ).fetchall()
            if len(rows) >= count:
                return {row[0] for row in rows}
            time.sleep(0.01)
    raise AssertionError("并发操作未在限定时间内进入数据库锁等待。")
