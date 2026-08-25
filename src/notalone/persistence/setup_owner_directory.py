"""首启向导 owner 初始化的 PostgreSQL 适配器。

与导入命令的 --initialize-owner 共用同一张 public.owner 表；只提供
向导所需的 owner 列表与幂等创建，不包含微信渠道身份逻辑（渠道身份仍
由导入/前台同步路径处理）。
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg

from notalone.application.setup_service import OwnerDirectory


class OwnerDirectoryPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或正文的持久化错误。"""


class _OwnerRow:
    """owner 目录行：只暴露 id 与 display_name 两个字段。"""

    __slots__ = ("id", "display_name")

    def __init__(self, *, owner_id: UUID, display_name: str) -> None:
        self.id = owner_id
        self.display_name = display_name


class PostgresOwnerDirectory:
    """从 PostgreSQL 读取 owner 目录并幂等创建 owner。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def list_owners(self) -> tuple[Any, ...]:
        """按创建顺序返回全部 owner；空库返回空元组。"""

        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(
                    """
                    SELECT id, display_name
                    FROM public.owner
                    ORDER BY created_at, id
                    """
                ).fetchall()
        except psycopg.Error:
            raise OwnerDirectoryPersistenceError(
                "owner 目录读取失败。"
            ) from None
        return tuple(
            _OwnerRow(owner_id=row[0], display_name=row[1])
            for row in rows
        )

    def create_owner(self, owner_id: UUID, display_name: str) -> Any:
        """幂等创建 owner；已存在时返回既有行，不覆盖展示名称。"""

        if not isinstance(owner_id, UUID):
            raise OwnerDirectoryPersistenceError(
                "owner 初始化参数必须是内部 UUID。"
            )
        if not isinstance(display_name, str) or not display_name.strip():
            raise OwnerDirectoryPersistenceError(
                "owner 展示名称不能为空。"
            )
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    """
                    INSERT INTO public.owner (id, display_name)
                    VALUES (%s, %s)
                    ON CONFLICT (id) DO NOTHING
                    RETURNING id, display_name
                    """,
                    (owner_id, display_name.strip()),
                ).fetchone()
                if row is None:
                    row = connection.execute(
                        """
                        SELECT id, display_name
                        FROM public.owner
                        WHERE id = %s
                        """,
                        (owner_id,),
                    ).fetchone()
        except psycopg.Error:
            raise OwnerDirectoryPersistenceError(
                "owner 初始化失败。"
            ) from None
        if row is None:
            raise OwnerDirectoryPersistenceError(
                "owner 初始化结果不可用。"
            )
        return _OwnerRow(owner_id=row[0], display_name=row[1])


__all__ = [
    "OwnerDirectoryPersistenceError",
    "PostgresOwnerDirectory",
    "OwnerDirectory",
]
