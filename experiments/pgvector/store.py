"""实验专用 pgvector 候选导航表。

表中只有候选导航所需的本地身份和 embedding 元数据，不保存关系记忆正文。
任何候选都必须由后续适配器回到 NotAlone 权威 `confirmed_memory` 复验。
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
from typing import Any, Iterable, Sequence
from uuid import UUID


TABLE_NAME = "pgvector_memory_candidates"
MODEL_ID = "BAAI/bge-small-zh-v1.5"
DIMENSIONS = 512


def content_hash(text: str) -> str:
    """返回正文的 SHA-256；正文不写入候选表。"""

    if not isinstance(text, str):
        raise TypeError("content_hash 只接受文字")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class VectorMemoryRecord:
    """待写入向量表的本地记忆身份与 embedding。"""

    memory_id: UUID
    owner_id: UUID
    contact_id: UUID
    revision: str
    content_hash: str
    model_id: str
    model_revision: str
    dimensions: int
    embedding: tuple[float, ...]


@dataclass(frozen=True)
class CandidateVector:
    """近邻查询返回的候选导航信息。"""

    memory_id: UUID
    owner_id: UUID
    contact_id: UUID
    revision: str
    content_hash: str
    model_id: str
    model_revision: str
    dimensions: int
    distance: float


class VectorTable:
    """创建、写入和查询实验向量表。"""

    table_name = TABLE_NAME

    def __init__(self, *, dimensions: int = DIMENSIONS, model_id: str = MODEL_ID) -> None:
        if dimensions <= 0:
            raise ValueError("向量维度必须为正整数")
        self.dimensions = dimensions
        self.model_id = model_id
        self.index_method = "exact"

    def initialize(self, connection: Any, *, hnsw: bool = True) -> dict[str, Any]:
        """创建扩展、表和索引；HNSW 不支持时回退到精确查询。"""

        self._execute(
            connection,
            "CREATE EXTENSION IF NOT EXISTS vector",
        )
        self._execute(
            connection,
            f"""
            CREATE TABLE IF NOT EXISTS {self.table_name} (
                row_id BIGSERIAL PRIMARY KEY,
                memory_id UUID NOT NULL,
                owner_id UUID NOT NULL,
                contact_id UUID NOT NULL,
                revision TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                model_id TEXT NOT NULL,
                model_revision TEXT NOT NULL,
                dimensions INTEGER NOT NULL CHECK (dimensions = {self.dimensions}),
                embedding VECTOR({self.dimensions}) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (memory_id, revision, model_id, model_revision)
            )
            """,
        )
        self._execute(
            connection,
            f"""
            CREATE INDEX IF NOT EXISTS {self.table_name}_scope_idx
            ON {self.table_name} (owner_id, contact_id)
            """,
        )
        # 保留扩展、表和范围索引；若旧 pgvector 不支持 HNSW，回滚只影响
        # HNSW 尝试，不能把已经创建的实验表一起回滚掉。
        self._commit(connection)
        self.index_method = "exact"
        hnsw_error: str | None = None
        if hnsw:
            try:
                self._execute(
                    connection,
                    f"""
                    CREATE INDEX IF NOT EXISTS {self.table_name}_embedding_hnsw_idx
                    ON {self.table_name} USING hnsw (embedding vector_cosine_ops)
                    """,
                )
                self.index_method = "hnsw"
            except Exception as exc:  # noqa: BLE001 - 版本能力差异要留证据
                connection.rollback()
                hnsw_error = f"{type(exc).__name__}: {exc}"
        self._commit(connection)
        extension = self.extension_info(connection)
        return {
            "table": self.table_name,
            "dimensions": self.dimensions,
            "index_method": self.index_method,
            "hnsw_error": hnsw_error,
            "extension": extension,
        }

    def extension_info(self, connection: Any) -> dict[str, Any]:
        """读取 vector 扩展版本；不可用时抛出清晰错误。"""

        rows = self._fetchall(
            connection,
            "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
        )
        if not rows:
            raise RuntimeError("当前临时数据库未启用 vector 扩展")
        return {"name": "vector", "version": str(rows[0][0])}

    def insert(self, connection: Any, records: Iterable[VectorMemoryRecord]) -> int:
        """写入导航向量；同一 memory revision/model 幂等更新。"""

        rows = list(records)
        for record in rows:
            self._validate_record(record)
        if not rows:
            return 0
        sql = f"""
            INSERT INTO {self.table_name}
                (memory_id, owner_id, contact_id, revision, content_hash,
                 model_id, model_revision, dimensions, embedding)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)
            ON CONFLICT (memory_id, revision, model_id, model_revision)
            DO UPDATE SET owner_id = EXCLUDED.owner_id,
                          contact_id = EXCLUDED.contact_id,
                          content_hash = EXCLUDED.content_hash,
                          dimensions = EXCLUDED.dimensions,
                          embedding = EXCLUDED.embedding
        """
        cursor = connection.cursor()
        try:
            for record in rows:
                cursor.execute(sql, self._params(record))
        finally:
            cursor.close()
        self._commit(connection)
        return len(rows)

    def nearest(
        self,
        connection: Any,
        *,
        owner_id: UUID,
        contact_id: UUID,
        embedding: Sequence[float],
        limit: int = 5,
        max_distance: float | None = None,
    ) -> tuple[CandidateVector, ...]:
        """先按 owner/contact 过滤，再做 cosine 近邻候选导航。"""

        if limit <= 0:
            return ()
        vector = tuple(float(value) for value in embedding)
        if len(vector) != self.dimensions or not all(math.isfinite(value) for value in vector):
            raise ValueError("查询 embedding 维度或数值无效")
        params: list[Any] = [
            str(owner_id),
            str(contact_id),
            self.model_id,
            self.dimensions,
        ]
        where = (
            "owner_id = %s AND contact_id = %s AND model_id = %s "
            "AND dimensions = %s"
        )
        if max_distance is not None:
            if max_distance < 0:
                raise ValueError("max_distance 不能为负数")
            where += " AND embedding <=> %s::vector <= %s"
            params.extend([self._vector(vector), max_distance])
        query_params = [
            self._vector(vector),
            *params,
            self._vector(vector),
            limit,
        ]
        rows = self._fetchall(
            connection,
            f"""
            SELECT memory_id, owner_id, contact_id, revision, content_hash,
                   model_id, model_revision, dimensions,
                   embedding <=> %s::vector AS distance
            FROM {self.table_name}
            WHERE {where}
            ORDER BY embedding <=> %s::vector, memory_id, revision
            LIMIT %s
            """,
            # First placeholder is SELECT distance, then WHERE scope/query,
            # then ORDER BY query. Keep this explicit to prevent scope drift.
            query_params,
        )
        return tuple(
            CandidateVector(
                memory_id=UUID(str(row[0])),
                owner_id=UUID(str(row[1])),
                contact_id=UUID(str(row[2])),
                revision=str(row[3]),
                content_hash=str(row[4]),
                model_id=str(row[5]),
                model_revision=str(row[6]),
                dimensions=int(row[7]),
                distance=float(row[8]),
            )
            for row in rows
        )

    def count(self, connection: Any) -> int:
        rows = self._fetchall(connection, f"SELECT COUNT(*) FROM {self.table_name}")
        return int(rows[0][0])

    def drop(self, connection: Any) -> None:
        self._execute(connection, f"DROP TABLE IF EXISTS {self.table_name}")
        self._commit(connection)

    def _validate_record(self, record: VectorMemoryRecord) -> None:
        if record.dimensions != self.dimensions:
            raise ValueError("记录 dimensions 与向量表不一致")
        if record.model_id != self.model_id:
            raise ValueError("记录 model_id 与向量表不一致")
        if len(record.embedding) != self.dimensions:
            raise ValueError("记录 embedding 维度不一致")
        if not all(math.isfinite(float(value)) for value in record.embedding):
            raise ValueError("记录 embedding 含非有限数值")
        if len(record.content_hash) != 64:
            raise ValueError("content_hash 必须是 SHA-256 十六进制摘要")

    @staticmethod
    def _vector(values: Sequence[float]) -> str:
        return "[" + ",".join(format(float(value), ".9g") for value in values) + "]"

    def _params(self, record: VectorMemoryRecord) -> tuple[Any, ...]:
        return (
            str(record.memory_id),
            str(record.owner_id),
            str(record.contact_id),
            record.revision,
            record.content_hash,
            record.model_id,
            record.model_revision,
            record.dimensions,
            self._vector(record.embedding),
        )

    @staticmethod
    def _execute(connection: Any, query: str, params: Sequence[Any] | None = None) -> None:
        cursor = connection.cursor()
        try:
            cursor.execute(query, params or ())
        finally:
            cursor.close()

    @staticmethod
    def _fetchall(
        connection: Any,
        query: str,
        params: Sequence[Any] | None = None,
    ) -> list[tuple[Any, ...]]:
        cursor = connection.cursor()
        try:
            cursor.execute(query, params or ())
            return list(cursor.fetchall())
        finally:
            cursor.close()

    @staticmethod
    def _commit(connection: Any) -> None:
        connection.commit()
