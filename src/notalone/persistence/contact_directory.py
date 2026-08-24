"""联系人目录的 PostgreSQL 读取适配器。"""

from __future__ import annotations

from uuid import UUID

import psycopg

from notalone.application.contact_directory import (
    ContactDataStatus,
    ContactDirectoryError,
    ContactSummary,
)
from notalone.persistence.message_sources import valid_source_ref_exists_sql


class PostgresContactDirectory:
    """从 PostgreSQL 读取 owner 范围内的联系人目录。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def list_contacts(self, owner_id: UUID) -> tuple[ContactSummary, ...]:
        """按创建顺序返回 owner 的联系人及当前有效数据统计。"""

        message_source_exists = valid_source_ref_exists_sql("message")
        query = f"""
            SELECT
                contact.id,
                contact.display_name,
                (
                    SELECT count(*)
                    FROM public.message AS message
                    WHERE message.owner_id = contact.owner_id
                      AND message.contact_id = contact.id
                      AND {message_source_exists}
                ) AS message_count,
                (
                    SELECT count(*)
                    FROM public.source_document AS source
                    WHERE source.owner_id = contact.owner_id
                      AND source.contact_id = contact.id
                      AND source.status = 'active'
                ) + (
                    SELECT count(*)
                    FROM public.local_wechat_observation AS observation
                    WHERE observation.owner_id = contact.owner_id
                      AND observation.contact_id = contact.id
                ) AS source_count
            FROM public.contact AS contact
            WHERE contact.owner_id = %s
            ORDER BY contact.created_at, contact.id
        """
        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(query, (owner_id,)).fetchall()
        except psycopg.Error:
            raise ContactDirectoryError("联系人列表读取失败。") from None
        return tuple(
            ContactSummary(
                contact_id=row[0],
                display_name=row[1],
                data_status=ContactDataStatus(
                    message_count=int(row[2]),
                    source_count=int(row[3]),
                ),
            )
            for row in rows
        )
