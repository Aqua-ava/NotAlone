"""来源引用删除后的孤儿消息与派生资料清理。

删除一个来源只移除其 message_source_ref 引用；
消息本身与派生资料只在全部有效来源引用都消失后清理。
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from notalone.persistence.message_sources import valid_source_ref_exists_sql


def collect_orphan_message_ids(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
    candidate_message_ids: tuple[UUID, ...] | list[UUID],
) -> tuple[UUID, ...]:
    """在候选消息中找出失去全部有效来源引用的消息。

    有效引用的判定与读路径一致：active 导入来源的引用或 CLI 观察引用。
    """

    if not candidate_message_ids:
        return ()
    rows = connection.execute(
        f"""
        SELECT message.id
        FROM public.message AS message
        WHERE message.owner_id = %s
          AND message.contact_id = %s
          AND message.id = ANY(%s::uuid[])
          AND NOT {valid_source_ref_exists_sql("message")}
        ORDER BY message.id
        """,
        (owner_id, contact_id, list(candidate_message_ids)),
    ).fetchall()
    return tuple(row[0] for row in rows)


def delete_messages(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
    message_ids: tuple[UUID, ...] | list[UUID],
) -> None:
    """删除失去全部来源引用的规范消息；微信身份随外键级联清理。"""

    if not message_ids:
        return
    connection.execute(
        """
        DELETE FROM public.message
        WHERE owner_id = %s AND contact_id = %s AND id = ANY(%s::uuid[])
        """,
        (owner_id, contact_id, list(message_ids)),
    )


def cleanup_derived_data(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
    removed_ids: set[UUID] | frozenset[UUID],
) -> None:
    """收敛或删除引用了已失效来源/消息的派生资料。

    removed_ids 是本次删除中彻底消失的来源 ID 与消息 ID；
    仍被其他来源支持的消息不会出现在其中，其派生引用保持不变。
    """

    source_refs = list(removed_ids)
    from notalone.persistence.memory_events import erase_event_version_dependencies
    erase_event_version_dependencies(connection, owner_id=owner_id, removed_ids=set(removed_ids))
    deleted_memory_ids: list[UUID] = []
    candidates = connection.execute(
        """
        SELECT id, source_ids
        FROM public.memory_candidate
        WHERE owner_id = %s
          AND contact_id = %s
          AND status IN ('pending', 'confirmed')
          AND COALESCE(to_jsonb(memory_candidate)->>'source_dependency_mode','any')='any'
          AND source_ids && %s::uuid[]
        FOR UPDATE
        """,
        (owner_id, contact_id, source_refs),
    ).fetchall()
    for candidate_id, source_ids in candidates:
        remaining_ids = [
            source_id for source_id in source_ids if source_id not in removed_ids
        ]
        if remaining_ids:
            connection.execute(
                """
                UPDATE public.memory_candidate
                SET source_ids = %s, updated_at = now()
                WHERE owner_id = %s AND contact_id = %s AND id = %s
                """,
                (remaining_ids, owner_id, contact_id, candidate_id),
            )
        else:
            connection.execute(
                """
                UPDATE public.memory_candidate
                SET status = 'invalidated', updated_at = now()
                WHERE owner_id = %s AND contact_id = %s AND id = %s
                """,
                (owner_id, contact_id, candidate_id),
            )

    memories = connection.execute(
        """
        SELECT id, source_ids, supersedes_memory_id, to_jsonb(confirmed_memory)->>'source_dependency_mode'
        FROM public.confirmed_memory
        WHERE owner_id = %s
          AND contact_id = %s
          AND status = 'active'
          AND source_ids && %s::uuid[]
        FOR UPDATE
        """,
        (owner_id, contact_id, source_refs),
    ).fetchall()
    if memories:
        for memory_id, source_ids, supersedes_memory_id, dependency_mode in memories:
            remaining_ids = [] if dependency_mode == "all" else [
                source_id
                for source_id in source_ids
                if source_id not in removed_ids
            ]
            # 手动修正仍沿用旧依据；所有派生版本都不能删掉引用后保留正文。
            if supersedes_memory_id is not None:
                remaining_ids = []
            if remaining_ids:
                connection.execute(
                    """
                    UPDATE public.confirmed_memory
                    SET source_ids = %s,
                        revision = revision + 1,
                        updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    (remaining_ids, owner_id, contact_id, memory_id),
                )
            else:
                deleted_memory_ids.append(memory_id)
                connection.execute(
                    """
                    UPDATE public.confirmed_memory
                    SET status = 'deleted',
                        invalid_at = COALESCE(invalid_at, now()),
                        revision = revision + 1,
                        updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    (owner_id, contact_id, memory_id),
                )
        connection.execute(
            """
            INSERT INTO public.contact_memory_state (
                owner_id, contact_id, memory_revision
            ) VALUES (%s, %s, 1)
            ON CONFLICT (owner_id, contact_id)
            DO UPDATE SET
                memory_revision = contact_memory_state.memory_revision + 1,
                updated_at = now()
            """,
            (owner_id, contact_id),
        )
    owner_memories = connection.execute(
        """
        SELECT id, source_ids, supersedes_memory_id
        FROM public.owner_memory
        WHERE owner_id = %s
          AND status = 'active'
          AND COALESCE(to_jsonb(owner_memory)->>'source_dependency_mode','any')='any'
          AND source_ids && %s::uuid[]
        FOR UPDATE
        """,
        (owner_id, source_refs),
    ).fetchall()
    for memory_id, source_ids, supersedes_memory_id in owner_memories:
        remaining_ids = [
            source_id for source_id in source_ids if source_id not in removed_ids
        ]
        if supersedes_memory_id is not None:
            remaining_ids = []
        if remaining_ids:
            connection.execute(
                """
                UPDATE public.owner_memory
                SET source_ids = %s,
                    revision = revision + 1,
                    updated_at = now()
                WHERE owner_id = %s AND id = %s
                """,
                (remaining_ids, owner_id, memory_id),
            )
        else:
            connection.execute(
                """
                UPDATE public.owner_memory
                SET status = 'deleted',
                    revision = revision + 1,
                    updated_at = now()
                WHERE owner_id = %s AND id = %s
                """,
                (owner_id, memory_id),
            )

    index_row = connection.execute(
        """
        SELECT topics
        FROM public.contact_memory_index
        WHERE owner_id = %s AND contact_id = %s
        FOR UPDATE
        """,
        (owner_id, contact_id),
    ).fetchone()
    if index_row is not None and memories:
        removed_set = set(deleted_memory_ids)
        topics = []
        for topic in index_row[0]:
            memory_ids = [
                memory_id
                for memory_id in topic["memory_ids"]
                if UUID(str(memory_id)) not in removed_set
            ]
            if memory_ids:
                topics.append({**topic, "memory_ids": memory_ids})
        connection.execute(
            """
            UPDATE public.contact_memory_index
            SET topics = %s,
                status = 'stale',
                updated_at = now()
            WHERE owner_id = %s AND contact_id = %s
            """,
            (Jsonb(topics), owner_id, contact_id),
        )
