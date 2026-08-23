"""后台任务维护命令。"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import timedelta

from notalone.persistence.background_tasks import (
    TERMINAL_TASK_RETENTION,
    BackgroundTaskPersistenceError,
    PostgresBackgroundTaskRepository,
)
from notalone.runtime_config import load_project_env


def _positive_days(value: str) -> int:
    try:
        days = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("留存天数必须是正整数。") from None
    if days <= 0:
        raise argparse.ArgumentTypeError("留存天数必须是正整数。")
    return days


def cleanup_main(argv: list[str] | None = None) -> int:
    """清理超过留存期的终态后台任务，只输出删除数量。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-task-cleanup",
        description="清理超过留存期的终态后台任务元数据。",
    )
    parser.add_argument(
        "--retention-days",
        type=_positive_days,
        default=TERMINAL_TASK_RETENTION.days,
    )
    args = parser.parse_args(argv)
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    if not database_url:
        print("缺少 NOTALONE_DATABASE_URL 环境变量。", file=sys.stderr)
        return 2
    try:
        deleted = PostgresBackgroundTaskRepository(
            database_url
        ).cleanup_terminal_tasks(
            retention=timedelta(days=args.retention_days)
        )
    except BackgroundTaskPersistenceError:
        print("后台任务清理失败。", file=sys.stderr)
        return 1
    print(f"deleted={deleted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cleanup_main())
