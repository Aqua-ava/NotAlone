"""关系记忆候选的确定性评分排序。"""

from __future__ import annotations

from dataclasses import replace

from notalone.retrieval.lexical import (
    LexicalToken,
    build_query_tokens,
    score_tokens,
)
from notalone.retrieval.models import RetrievedMemory


def recall_memories(
    memories: tuple[RetrievedMemory, ...],
    *,
    query: str | None,
    limit: int,
) -> tuple[RetrievedMemory, ...]:
    """按 query 评分召回；query 为 None 时保持复验语义，不做评分。"""

    if not isinstance(memories, tuple) or any(
        not isinstance(memory, RetrievedMemory) for memory in memories
    ):
        raise TypeError("关系记忆候选必须是 RetrievedMemory 元组。")
    if query is None:
        return memories[:limit]
    if not isinstance(query, str):
        raise TypeError("关系记忆检索 query 必须是字符串或 None。")
    query_tokens = build_query_tokens(query)
    if not query_tokens:
        return ()
    return rank_memories(memories, query_tokens=query_tokens, limit=limit)


def rank_memories(
    memories: tuple[RetrievedMemory, ...],
    *,
    query_tokens: tuple[LexicalToken, ...],
    limit: int,
) -> tuple[RetrievedMemory, ...]:
    """写入相关性与命中词，并按可解释词典序返回前 limit 条。"""

    if not isinstance(memories, tuple) or any(
        not isinstance(memory, RetrievedMemory) for memory in memories
    ):
        raise TypeError("关系记忆候选必须是 RetrievedMemory 元组。")
    if not isinstance(limit, int) or limit < 1:
        raise ValueError("关系记忆排序预算无效。")
    scored = tuple(
        replace(
            memory,
            relevance_score=result.score,
            matched_terms=result.matched_terms,
        )
        for memory in memories
        for result in (score_tokens(query_tokens, memory.text),)
    )
    return tuple(sorted(scored, key=_memory_ranking_key)[:limit])


def _memory_ranking_key(memory: RetrievedMemory) -> tuple[object, ...]:
    valid_at = memory.valid_at
    return (
        -(memory.relevance_score or 0.0),
        memory.adoption_method != "manual",
        -memory.confidence,
        valid_at is None,
        -(valid_at.timestamp() if valid_at is not None else 0.0),
        str(memory.memory_id),
    )
