"""将临时 VectorTable 连接到 NotAlone 实验适配器的桥接层。"""

from __future__ import annotations

from typing import Any

from notalone.experiments.pgvector_adapter import VectorHit
from notalone.scopes import ContactScope

from .embedding import LocalChineseEmbedder
from .store import VectorTable


class PgVectorCandidateClient:
    """只返回本地记忆身份和 cosine 相似度，不返回正文。"""

    def __init__(
        self,
        *,
        connection: Any,
        table: VectorTable,
        embedder: LocalChineseEmbedder,
    ) -> None:
        self.connection = connection
        self.table = table
        self.embedder = embedder

    def search(
        self,
        *,
        scope: ContactScope,
        query: str,
        limit: int,
    ) -> tuple[VectorHit, ...]:
        vector = self.embedder.encode(query)
        if len(vector) != 1:
            raise RuntimeError("查询 embedding 返回行数错误")
        candidates = self.table.nearest(
            self.connection,
            owner_id=scope.owner_id,
            contact_id=scope.contact_id,
            embedding=vector[0],
            limit=limit,
        )
        return tuple(
            VectorHit(
                memory_id=item.memory_id,
                scope=ContactScope(item.owner_id, item.contact_id),
                revision=int(item.revision),
                similarity=1.0 - item.distance,
            )
            for item in candidates
        )
