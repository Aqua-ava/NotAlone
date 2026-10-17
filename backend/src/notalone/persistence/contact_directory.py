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

    def create_contact(self, owner_id: UUID, request_id: UUID, display_name: str) -> ContactSummary:
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    "INSERT INTO public.contact (id, owner_id, display_name) VALUES (%s,%s,%s) "
                    "ON CONFLICT (owner_id,id) DO NOTHING RETURNING id,display_name",
                    (request_id, owner_id, display_name),
                ).fetchone()
                if row is None:
                    row = connection.execute(
                        "SELECT id,display_name FROM public.contact WHERE owner_id=%s AND id=%s",
                        (owner_id, request_id),
                    ).fetchone()
                if row is None or row[1] != display_name:
                    raise ContactDirectoryError("本次创建未确认，请刷新联系人后重试。")
        except psycopg.Error:
            raise ContactDirectoryError("联系人创建失败。") from None
        return ContactSummary(row[0], row[1], ContactDataStatus(0, 0))

    def confirm_manual(self, owner_id: UUID, contact_id: UUID) -> None:
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    "INSERT INTO public.manual_contact_confirmation (owner_id,contact_id) "
                    "SELECT owner_id,id FROM public.contact WHERE owner_id=%s AND id=%s "
                    "ON CONFLICT (owner_id,contact_id) DO UPDATE SET confirmed_at=now() RETURNING id",
                    (owner_id, contact_id),
                ).fetchone()
                if row is None:
                    raise ContactDirectoryError("本次联系人不存在，请刷新后重新选择。")
        except psycopg.Error:
            raise ContactDirectoryError("手动输入联系人确认失败。") from None
