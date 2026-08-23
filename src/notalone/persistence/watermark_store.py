"""PostgreSQL 提取水位存储。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg

from notalone.scopes import ContactScope


class WatermarkPersistenceError(RuntimeError):
    """不暴露 SQL 或连接信息的水位持久化错误。"""


class PostgresWatermarkStore:
    """按联系人保存提取水位；断点重跑从水位之后继续。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def get(self, scope: ContactScope) -> UUID | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT last_message_id
                    FROM public.memory_extraction_watermark
                    WHERE owner_id = %s AND contact_id = %s
                    """,
                    (scope.owner_id, scope.contact_id),
                ).fetchone()
        except Exception as error:
            raise WatermarkPersistenceError("提取水位读取失败。") from error
        return row[0] if row else None

    def set(self, scope: ContactScope, last_message_id: UUID) -> None:
        if not isinstance(last_message_id, UUID):
            raise WatermarkPersistenceError("水位必须指向消息 ID。")
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO public.memory_extraction_watermark (
                        owner_id, contact_id, last_message_id
                    ) VALUES (%s, %s, %s)
                    ON CONFLICT (owner_id, contact_id)
                    DO UPDATE SET
                        last_message_id = EXCLUDED.last_message_id,
                        updated_at = now()
                    """,
                    (scope.owner_id, scope.contact_id, last_message_id),
                )
                connection.commit()
        except Exception as error:
            raise WatermarkPersistenceError("提取水位写入失败。") from error

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._database_url)
