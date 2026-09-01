"""联系人记忆目录的确定性投影和 PostgreSQL 持久化边界。"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Iterable
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory.models import MemoryCategory, MemoryTopic
from notalone.scopes import ContactScope
from notalone.persistence.message_sources import valid_source_ref_exists_sql


MAX_INDEX_TOPICS = 20


class ContactMemoryIndexError(RuntimeError):
    """不暴露 SQL、连接信息或记忆正文的目录错误。"""


class ContactMemoryIndexBuildError(ContactMemoryIndexError):
    """确定性目录构建失败。"""


class ContactMemoryIndexPersistenceError(ContactMemoryIndexError):
    """目录数据库操作失败，可由任务重试。"""


class ContactMemoryIndexValidationError(ContactMemoryIndexError):
    """目录投影或引用验证失败。"""


class ContactMemoryIndexStatus(StrEnum):
    """目录当前持久化状态。"""

    ACTIVE = "active"
    STALE = "stale"


@dataclass(frozen=True, slots=True)
class IndexMemoryRef:
    """目录构建所需的最小记忆引用，不含正文。"""

    memory_id: UUID
    category: MemoryCategory
    topic: MemoryTopic


@dataclass(frozen=True, slots=True)
class ContactMemoryIndexTopic:
    """目录中的一个分类/主题入口。"""

    category: MemoryCategory
    topic: MemoryTopic
    topic_summary: str
    memory_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class ContactMemoryIndex:
    """联系人目录的非正文快照。"""

    scope: ContactScope
    built_from_memory_revision: int
    current_memory_revision: int
    status: ContactMemoryIndexStatus
    topics: tuple[ContactMemoryIndexTopic, ...]
    created_at: datetime
    updated_at: datetime
    raw_topics_json: str
    references_valid: bool = True

    @property
    def is_current(self) -> bool:
        return (
            self.status is ContactMemoryIndexStatus.ACTIVE
            and self.built_from_memory_revision == self.current_memory_revision
            and self.references_valid
        )


@dataclass(frozen=True, slots=True)
class IndexBuildResult:
    """一次目录投影的结果。"""

    mode: str
    built_from_memory_revision: int
    topics: tuple[ContactMemoryIndexTopic, ...]

    @property
    def memory_ids(self) -> tuple[UUID, ...]:
        return tuple(
            memory_id
            for topic in self.topics
            for memory_id in topic.memory_ids
        )


@dataclass(frozen=True, slots=True)
class IndexVerificationResult:
    """目录确定性验证结果。"""

    valid: bool
    topics_count: int
    built_from_memory_revision: int | None
    current_memory_revision: int
    error_code: str | None = None


class ContactMemoryIndexBuilder:
    """只按受控分类和 UUID 引用生成稳定目录，不调用模型。"""

    def build(
        self,
        memories: Iterable[IndexMemoryRef],
    ) -> tuple[ContactMemoryIndexTopic, ...]:
        groups: dict[tuple[MemoryCategory, MemoryTopic], set[UUID]] = defaultdict(
            set
        )
        for memory in memories:
            if not isinstance(memory, IndexMemoryRef):
                raise TypeError("目录输入必须是 IndexMemoryRef。")
            groups[(memory.category, memory.topic)].add(memory.memory_id)
        return self.build_from_groups(groups)

    def build_from_groups(
        self,
        groups: dict[tuple[MemoryCategory, MemoryTopic], set[UUID]],
    ) -> tuple[ContactMemoryIndexTopic, ...]:
        ordered_groups = sorted(
            groups.items(),
            key=lambda item: (
                -len(item[1]),
                item[0][0].value,
                item[0][1].value,
            ),
        )[:MAX_INDEX_TOPICS]
        return tuple(
            ContactMemoryIndexTopic(
                category=category,
                topic=topic,
                topic_summary=f"{category.value}:{topic.value}",
                memory_ids=tuple(sorted(memory_ids, key=str)),
            )
            for (category, topic), memory_ids in ordered_groups
        )


class PostgresContactMemoryIndexRepository:
    """从当前有效 confirmed_memory 构建、读取并验证联系人目录。"""

    __slots__ = ("_builder", "_database_url")

    def __init__(
        self,
        database_url: str,
        *,
        builder: ContactMemoryIndexBuilder | None = None,
    ) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url
        self._builder = builder or ContactMemoryIndexBuilder()

    def get(self, scope: ContactScope) -> ContactMemoryIndex | None:
        """读取目录；版本过期由 is_current 明确表示。"""

        _validate_scope(scope)
        try:
            with self._connect() as connection:
                self._ensure_state(connection, scope)
                row = connection.execute(
                    """
                    SELECT
                        state.memory_revision AS current_memory_revision,
                        index.built_from_memory_revision,
                        index.status,
                        index.topics,
                        index.created_at,
                        index.updated_at
                    FROM public.contact_memory_state AS state
                    LEFT JOIN public.contact_memory_index AS index
                      ON index.owner_id = state.owner_id
                     AND index.contact_id = state.contact_id
                    WHERE state.owner_id = %s AND state.contact_id = %s
                    """,
                    (scope.owner_id, scope.contact_id),
                ).fetchone()
                if row is None or row["built_from_memory_revision"] is None:
                    return None
                topics = _topics_from_json(row["topics"])
                references_valid = topics == self._builder.build(
                    self._load_memory_refs(connection, scope)
                )
                return ContactMemoryIndex(
                    scope=scope,
                    built_from_memory_revision=row[
                        "built_from_memory_revision"
                    ],
                    current_memory_revision=row["current_memory_revision"],
                    status=ContactMemoryIndexStatus(row["status"]),
                    topics=topics,
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    raw_topics_json=_topics_json(topics),
                    references_valid=references_valid,
                )
        except ContactMemoryIndexError:
            raise
        except psycopg.Error:
            raise ContactMemoryIndexPersistenceError(
                "联系人记忆目录读取失败。"
            ) from None

    def locate_memory_ids(
        self,
        scope: ContactScope,
        *,
        query: str | None = None,
        limit: int = 20,
    ) -> tuple[UUID, ...] | None:
        """按当前 L2 主题目录定位 L1 ID，不把目录内容当作事实返回。"""

        _validate_scope(scope)
        if query is not None and not isinstance(query, str):
            raise TypeError("目录查询 query 必须是字符串或 None。")
        if not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ValueError("目录导航 limit 超出模块预算。")
        current = self.get(scope)
        if current is None or not current.is_current:
            return None
        tokens = tuple(
            token.lower() for token in query.split() if token.strip()
        ) if query else ()
        selected_topics = (
            current.topics
            if not tokens
            else tuple(
                topic
                for topic in current.topics
                if all(
                    token in (
                        f"{topic.category.value} "
                        f"{topic.topic.value} {topic.topic_summary}"
                    ).lower()
                    for token in tokens
                )
            )
        )
        result: list[UUID] = []
        seen: set[UUID] = set()
        for topic in selected_topics:
            for memory_id in topic.memory_ids:
                if memory_id not in seen:
                    seen.add(memory_id)
                    result.append(memory_id)
                if len(result) >= limit:
                    return tuple(result)
        return tuple(result)

    def rebuild(self, scope: ContactScope) -> IndexBuildResult:
        """在验证前只构造内存投影；写入失败时旧目录保持不变。"""

        _validate_scope(scope)
        try:
            with self._connect() as connection:
                return self._rebuild_in_connection(
                    connection,
                    scope,
                    mode="rebuild",
                )
        except ContactMemoryIndexError:
            raise
        except psycopg.Error:
            raise ContactMemoryIndexPersistenceError(
                "联系人记忆目录重建失败。"
            ) from None

    def incremental_update(
        self,
        scope: ContactScope,
        *,
        changed_memory_ids: tuple[UUID, ...],
    ) -> IndexBuildResult:
        """单条记忆变化优先更新入口；不满足版本条件时完整重建。"""

        _validate_scope(scope)
        if not changed_memory_ids or any(
            not isinstance(memory_id, UUID) for memory_id in changed_memory_ids
        ):
            raise ValueError("目录变化必须携带至少一个 memory_id。")
        if len(changed_memory_ids) != 1:
            return self.rebuild(scope)
        try:
            with self._connect() as connection:
                self._ensure_state(connection, scope)
                state = self._state_for_update(connection, scope)
                current = self._index_row(connection, scope)
                if (
                    current is None
                    or current["built_from_memory_revision"]
                    != state["memory_revision"] - 1
                    or len(_topics_from_json(current["topics"])) >= MAX_INDEX_TOPICS
                ):
                    return self._rebuild_in_connection(
                        connection,
                        scope,
                        mode="rebuild",
                        state=state,
                    )
                topics = _topics_from_json(current["topics"])
                groups = _groups_from_topics(topics)
                changed_id = changed_memory_ids[0]
                for memory_ids in groups.values():
                    memory_ids.discard(changed_id)
                groups = {
                    key: memory_ids
                    for key, memory_ids in groups.items()
                    if memory_ids
                }
                changed = self._load_memory_ref(
                    connection,
                    scope,
                    changed_id,
                )
                if changed is not None:
                    groups.setdefault(
                        (changed.category, changed.topic), set()
                    ).add(changed.memory_id)
                next_topics = self._builder.build_from_groups(groups)
                self._verify_candidate_topics(
                    next_topics,
                    self._builder.build(self._load_memory_refs(connection, scope)),
                )
                self._replace_index(
                    connection,
                    scope,
                    state["memory_revision"],
                    next_topics,
                )
                self._verify_persisted_in_connection(
                    connection,
                    scope,
                    memory_revision=state["memory_revision"],
                    expected_topics=next_topics,
                )
                return IndexBuildResult(
                    mode="incremental",
                    built_from_memory_revision=state["memory_revision"],
                    topics=next_topics,
                )
        except ContactMemoryIndexError:
            raise
        except psycopg.Error:
            raise ContactMemoryIndexPersistenceError(
                "联系人记忆目录增量更新失败。"
            ) from None

    def verify(self, scope: ContactScope) -> IndexVerificationResult:
        """验证目录版本、主题数量和每个引用是否仍指向有效记忆。"""

        _validate_scope(scope)
        try:
            with self._connect() as connection:
                self._ensure_state(connection, scope)
                state = self._state_for_update(connection, scope)
                current = self._index_row(connection, scope)
                if current is None:
                    return IndexVerificationResult(
                        valid=False,
                        topics_count=0,
                        built_from_memory_revision=None,
                        current_memory_revision=state["memory_revision"],
                        error_code="index_missing",
                    )
                topics = _topics_from_json(current["topics"])
                if current["status"] != ContactMemoryIndexStatus.ACTIVE.value:
                    return self._invalid_verification(
                        current, state, len(topics), "index_not_active"
                    )
                if (
                    current["built_from_memory_revision"]
                    != state["memory_revision"]
                ):
                    return self._invalid_verification(
                        current, state, len(topics), "index_stale"
                    )
                expected = self._builder.build(
                    self._load_memory_refs(connection, scope)
                )
                if topics != expected:
                    return self._invalid_verification(
                        current, state, len(topics), "index_reference_invalid"
                    )
                return IndexVerificationResult(
                    valid=True,
                    topics_count=len(topics),
                    built_from_memory_revision=current[
                        "built_from_memory_revision"
                    ],
                    current_memory_revision=state["memory_revision"],
                )
        except ContactMemoryIndexError:
            raise
        except psycopg.Error:
            raise ContactMemoryIndexPersistenceError(
                "联系人记忆目录验证失败。"
            ) from None

    def _rebuild_in_connection(
        self,
        connection: psycopg.Connection[Any],
        scope: ContactScope,
        *,
        mode: str,
        state: dict[str, Any] | None = None,
    ) -> IndexBuildResult:
        self._ensure_state(connection, scope)
        state = state or self._state_for_update(connection, scope)
        refs = self._load_memory_refs(connection, scope)
        try:
            topics = self._builder.build(refs)
        except ContactMemoryIndexError:
            raise
        except Exception as error:
            raise ContactMemoryIndexBuildError(
                "联系人记忆目录确定性构建失败。"
            ) from error
        try:
            expected_topics = self._builder.build(refs)
        except ContactMemoryIndexError:
            raise
        except Exception as error:
            raise ContactMemoryIndexBuildError(
                "联系人记忆目录验证构建失败。"
            ) from error
        self._verify_candidate_topics(topics, expected_topics)
        self._replace_index(
            connection,
            scope,
            state["memory_revision"],
            topics,
        )
        self._verify_persisted_in_connection(
            connection,
            scope,
            memory_revision=state["memory_revision"],
            expected_topics=topics,
        )
        return IndexBuildResult(
            mode=mode,
            built_from_memory_revision=state["memory_revision"],
            topics=topics,
        )

    @staticmethod
    def _replace_index(
        connection: psycopg.Connection[Any],
        scope: ContactScope,
        memory_revision: int,
        topics: tuple[ContactMemoryIndexTopic, ...],
    ) -> None:
        if len(topics) > MAX_INDEX_TOPICS:
            raise ContactMemoryIndexError("联系人记忆目录主题数量超限。")
        connection.execute(
            """
            INSERT INTO public.contact_memory_index (
                owner_id,
                contact_id,
                built_from_memory_revision,
                status,
                topics
            )
            VALUES (%s, %s, %s, 'active', %s)
            ON CONFLICT (owner_id, contact_id)
            DO UPDATE SET
                built_from_memory_revision = EXCLUDED.built_from_memory_revision,
                status = EXCLUDED.status,
                topics = EXCLUDED.topics,
                updated_at = now()
            """,
            (
                scope.owner_id,
                scope.contact_id,
                memory_revision,
                Jsonb(_topics_payload(topics)),
            ),
        )

    @staticmethod
    def _verify_candidate_topics(
        actual: tuple[ContactMemoryIndexTopic, ...],
        expected: tuple[ContactMemoryIndexTopic, ...],
    ) -> None:
        if actual != expected:
            raise ContactMemoryIndexValidationError(
                "联系人记忆目录引用验证失败。"
            )

    def _verify_persisted_in_connection(
        self,
        connection: psycopg.Connection[Any],
        scope: ContactScope,
        *,
        memory_revision: int,
        expected_topics: tuple[ContactMemoryIndexTopic, ...],
    ) -> None:
        current = self._index_row(connection, scope)
        if current is None:
            raise ContactMemoryIndexValidationError(
                "联系人记忆目录写入结果为空。"
            )
        actual_topics = _topics_from_json(current["topics"])
        if (
            current["status"] != ContactMemoryIndexStatus.ACTIVE.value
            or current["built_from_memory_revision"] != memory_revision
        ):
            raise ContactMemoryIndexValidationError(
                "联系人记忆目录版本验证失败。"
            )
        self._verify_candidate_topics(actual_topics, expected_topics)

    @staticmethod
    def _ensure_state(connection: psycopg.Connection[Any], scope: ContactScope) -> None:
        connection.execute(
            """
            INSERT INTO public.contact_memory_state (owner_id, contact_id)
            VALUES (%s, %s)
            ON CONFLICT (owner_id, contact_id) DO NOTHING
            """,
            (scope.owner_id, scope.contact_id),
        )

    @staticmethod
    def _state_for_update(
        connection: psycopg.Connection[Any],
        scope: ContactScope,
    ) -> dict[str, Any]:
        row = connection.execute(
            """
            SELECT owner_id, contact_id, memory_revision
            FROM public.contact_memory_state
            WHERE owner_id = %s AND contact_id = %s
            FOR UPDATE
            """,
            (scope.owner_id, scope.contact_id),
        ).fetchone()
        if row is None:
            raise ContactMemoryIndexError("联系人记忆版本不存在。")
        return row

    @staticmethod
    def _index_row(
        connection: psycopg.Connection[Any],
        scope: ContactScope,
    ) -> dict[str, Any] | None:
        return connection.execute(
            """
            SELECT built_from_memory_revision, status, topics
            FROM public.contact_memory_index
            WHERE owner_id = %s AND contact_id = %s
            FOR UPDATE
            """,
            (scope.owner_id, scope.contact_id),
        ).fetchone()

    @staticmethod
    def _load_memory_refs(
        connection: psycopg.Connection[Any],
        scope: ContactScope,
    ) -> tuple[IndexMemoryRef, ...]:
        rows = connection.execute(
            f"""
            SELECT memory.id, memory.category, memory.topic
            FROM public.confirmed_memory AS memory
            WHERE memory.owner_id = %s
              AND memory.contact_id = %s
              AND memory.status = 'active'
              AND (memory.valid_at IS NULL OR memory.valid_at <= now())
              AND (memory.invalid_at IS NULL OR now() < memory.invalid_at)
              AND (
                  EXISTS (
                      SELECT 1
                      FROM public.source_document AS source
                      WHERE source.owner_id = memory.owner_id
                        AND source.contact_id = memory.contact_id
                        AND source.id = ANY(memory.source_ids)
                        AND source.status = 'active'
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM public.local_wechat_observation AS observation
                      WHERE observation.owner_id = memory.owner_id
                        AND observation.contact_id = memory.contact_id
                        AND observation.id = ANY(memory.source_ids)
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM public.message AS message
                      WHERE message.owner_id = memory.owner_id
                        AND message.contact_id = memory.contact_id
                        AND message.id = ANY(memory.source_ids)
                        AND {valid_source_ref_exists_sql("message")}
                  )
              )
            ORDER BY memory.created_at, memory.id
            """,
            (scope.owner_id, scope.contact_id),
        ).fetchall()
        return tuple(
            IndexMemoryRef(
                memory_id=row["id"],
                category=MemoryCategory(row["category"]),
                topic=MemoryTopic(row["topic"]),
            )
            for row in rows
        )

    @staticmethod
    def _load_memory_ref(
        connection: psycopg.Connection[Any],
        scope: ContactScope,
        memory_id: UUID,
    ) -> IndexMemoryRef | None:
        rows = connection.execute(
            f"""
            SELECT memory.id, memory.category, memory.topic
            FROM public.confirmed_memory AS memory
            WHERE memory.owner_id = %s
              AND memory.contact_id = %s
              AND memory.id = %s
              AND memory.status = 'active'
              AND (memory.valid_at IS NULL OR memory.valid_at <= now())
              AND (memory.invalid_at IS NULL OR now() < memory.invalid_at)
              AND (
                  EXISTS (
                      SELECT 1 FROM public.source_document AS source
                      WHERE source.owner_id = memory.owner_id
                        AND source.contact_id = memory.contact_id
                        AND source.id = ANY(memory.source_ids)
                        AND source.status = 'active'
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM public.local_wechat_observation AS observation
                      WHERE observation.owner_id = memory.owner_id
                        AND observation.contact_id = memory.contact_id
                        AND observation.id = ANY(memory.source_ids)
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM public.message AS message
                      WHERE message.owner_id = memory.owner_id
                        AND message.contact_id = memory.contact_id
                        AND message.id = ANY(memory.source_ids)
                        AND {valid_source_ref_exists_sql("message")}
                  )
              )
            """,
            (scope.owner_id, scope.contact_id, memory_id),
        ).fetchone()
        if rows is None:
            return None
        return IndexMemoryRef(
            memory_id=rows["id"],
            category=MemoryCategory(rows["category"]),
            topic=MemoryTopic(rows["topic"]),
        )

    @staticmethod
    def _invalid_verification(
        current: dict[str, Any],
        state: dict[str, Any],
        topics_count: int,
        error_code: str,
    ) -> IndexVerificationResult:
        return IndexVerificationResult(
            valid=False,
            topics_count=topics_count,
            built_from_memory_revision=current["built_from_memory_revision"],
            current_memory_revision=state["memory_revision"],
            error_code=error_code,
        )

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)


def _validate_scope(scope: ContactScope) -> None:
    if not isinstance(scope, ContactScope):
        raise TypeError("scope 必须是 ContactScope。")


def _topics_payload(
    topics: tuple[ContactMemoryIndexTopic, ...],
) -> list[dict[str, object]]:
    return [
        {
            "category": topic.category.value,
            "topic": topic.topic.value,
            "topic_summary": topic.topic_summary,
            "memory_ids": [str(memory_id) for memory_id in topic.memory_ids],
        }
        for topic in topics
    ]


def _topics_json(topics: tuple[ContactMemoryIndexTopic, ...]) -> str:
    return json.dumps(
        _topics_payload(topics),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )


def _topics_from_json(value: object) -> tuple[ContactMemoryIndexTopic, ...]:
    if not isinstance(value, list) or len(value) > MAX_INDEX_TOPICS:
        raise ContactMemoryIndexError("联系人记忆目录结构无效。")
    topics: list[ContactMemoryIndexTopic] = []
    for item in value:
        if not isinstance(item, dict):
            raise ContactMemoryIndexError("联系人记忆目录主题无效。")
        try:
            memory_ids = tuple(UUID(str(raw_id)) for raw_id in item["memory_ids"])
            topic = ContactMemoryIndexTopic(
                category=MemoryCategory(item["category"]),
                topic=MemoryTopic(item["topic"]),
                topic_summary=str(item["topic_summary"]),
                memory_ids=memory_ids,
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ContactMemoryIndexError("联系人记忆目录主题无效。") from error
        if not topic.topic_summary.strip() or not topic.memory_ids:
            raise ContactMemoryIndexError("联系人记忆目录主题无效。")
        topics.append(topic)
    return tuple(topics)


def _groups_from_topics(
    topics: tuple[ContactMemoryIndexTopic, ...],
) -> dict[tuple[MemoryCategory, MemoryTopic], set[UUID]]:
    return {
        (topic.category, topic.topic): set(topic.memory_ids)
        for topic in topics
    }
