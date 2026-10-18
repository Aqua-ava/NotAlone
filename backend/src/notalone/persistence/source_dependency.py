"""新ALL记录的迁移能力与同范围活动消息校验。"""
from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg

from notalone.memory import SourceDependencyMode
from notalone.persistence.dimension_evidence import supports_bounded_runtime_evidence
from notalone.persistence.message_sources import valid_source_ref_exists_sql


def dependency_mode(value: Any) -> SourceDependencyMode:
    """缺列投影为NULL的旧记录沿原ANY解释；非法已存值不回退。"""
    return SourceDependencyMode.ANY if value is None else SourceDependencyMode(value)


def ensure_all_sources(
    connection: psycopg.Connection[Any], *, owner_id: UUID,
    source_ids: tuple[UUID, ...], contact_id: UUID | None = None,
) -> None:
    """ALL只接受一个联系人内完整且仍活动的规范消息组。"""
    if not supports_bounded_runtime_evidence(connection):
        raise ValueError("数据库尚未启用有限运行来源依赖。")
    if not source_ids or len(set(source_ids)) != len(source_ids):
        raise ValueError("ALL来源必须是非空且唯一的规范消息集合。")
    rows = connection.execute(
        f"""
        SELECT message.id, message.contact_id FROM public.message AS message
        WHERE message.owner_id=%s AND message.id=ANY(%s)
          AND (%s::uuid IS NULL OR message.contact_id=%s)
          AND {valid_source_ref_exists_sql('message')}
        FOR SHARE OF message
        """,
        (owner_id, list(source_ids), contact_id, contact_id),
    ).fetchall()
    if ({row['id'] for row in rows} != set(source_ids)
            or len({row['contact_id'] for row in rows}) != 1):
        raise PermissionError("ALL来源须为同一范围内全部活动的规范消息。")


def insert_dependency(mode: SourceDependencyMode, *, requires_all_sources=False, connection=None, table=None):
    """旧库保留原协议；完整正文生命周期必须有明确迁移支持。"""
    columns, values, params = ('', '', ())
    if mode is SourceDependencyMode.ALL:
        columns, values, params = ', source_dependency_mode', ', %s', ('all',)
    if requires_all_sources:
        require_lifecycle_schema(connection, table)
        columns += ', requires_all_sources'
        values += ', %s'
        params += (True,)
    return columns, values, params


def require_lifecycle_schema(connection, table):
    if table not in {'memory_candidate', 'confirmed_memory', 'owner_memory'}:
        raise ValueError('全部来源依赖表无效。')
    row = connection.execute("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=%s AND column_name='requires_all_sources') AS available", (table,)).fetchone()
    if not (row['available'] if isinstance(row, dict) else row[0]):
        raise ValueError('数据库尚未启用完整记忆来源生命周期。')
