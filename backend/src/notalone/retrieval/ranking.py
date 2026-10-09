"""关系记忆候选的确定性评分排序。"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from uuid import UUID

from notalone.retrieval.lexical import (
    LexicalToken,
    build_query_tokens,
    score_tokens,
)
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedOwnerMemory,
    RetrievedPendingCandidate,
)


def recall_owner_memories(
    memories: tuple[RetrievedOwnerMemory, ...],
    *,
    query: str | None,
    limit: int,
) -> tuple[RetrievedOwnerMemory, ...]:
    """按 query 为 owner 记忆评分召回；query 为 None 时保持复验语义。"""

    if not isinstance(memories, tuple) or any(
        not isinstance(memory, RetrievedOwnerMemory) for memory in memories
    ):
        raise TypeError("owner 记忆候选必须是 RetrievedOwnerMemory 元组。")
    if query is None:
        return memories[:limit]
    if not isinstance(query, str):
        raise TypeError("owner 记忆检索 query 必须是字符串或 None。")
    query_tokens = build_query_tokens(query)
    if not query_tokens:
        return ()
    return rank_owner_memories(memories, query_tokens=query_tokens, limit=limit)


def rank_owner_memories(
    memories: tuple[RetrievedOwnerMemory, ...],
    *,
    query_tokens: tuple[LexicalToken, ...],
    limit: int,
) -> tuple[RetrievedOwnerMemory, ...]:
    """写入 owner 记忆的相关性与命中词，并按同一词典序返回前 limit 条。"""

    if not isinstance(memories, tuple) or any(
        not isinstance(memory, RetrievedOwnerMemory) for memory in memories
    ):
        raise TypeError("owner 记忆候选必须是 RetrievedOwnerMemory 元组。")
    if not isinstance(limit, int) or limit < 1:
        raise ValueError("owner 记忆排序预算无效。")
    scored = tuple(
        replace(
            memory,
            relevance_score=result.score,
            matched_terms=result.matched_terms,
        )
        for memory in memories
        for result in (score_tokens(query_tokens, memory.text),)
    )
    return tuple(
        sorted(
            scored,
            key=lambda memory: _memory_ranking_key(
                memory.relevance_score,
                manual_adoption=memory.adoption_method == "manual",
                confidence=memory.confidence,
                valid_at=memory.valid_at,
                memory_id=memory.memory_id,
            ),
        )[:limit]
    )


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
    return tuple(
        sorted(
            scored,
            key=lambda memory: _memory_ranking_key(
                memory.relevance_score,
                manual_adoption=memory.adoption_method == "manual",
                confidence=memory.confidence,
                valid_at=memory.valid_at,
                memory_id=memory.memory_id,
            ),
        )[:limit]
    )


def recall_pending_candidates(
    candidates: tuple[RetrievedPendingCandidate, ...],
    *,
    query: str | None,
    limit: int,
) -> tuple[RetrievedPendingCandidate, ...]:
    """按 query 评分召回待确认候选；query 为 None 时保持复验语义。"""

    if not isinstance(candidates, tuple) or any(
        not isinstance(candidate, RetrievedPendingCandidate)
        for candidate in candidates
    ):
        raise TypeError("待确认候选必须是 RetrievedPendingCandidate 元组。")
    if query is None:
        return candidates[:limit]
    if not isinstance(query, str):
        raise TypeError("待确认候选检索 query 必须是字符串或 None。")
    query_tokens = build_query_tokens(query)
    if not query_tokens:
        return ()
    return rank_pending_candidates(
        candidates,
        query_tokens=query_tokens,
        limit=limit,
    )


def rank_pending_candidates(
    candidates: tuple[RetrievedPendingCandidate, ...],
    *,
    query_tokens: tuple[LexicalToken, ...],
    limit: int,
) -> tuple[RetrievedPendingCandidate, ...]:
    """写入相关性与命中词，并按同一词典序返回前 limit 条待确认候选。"""

    if not isinstance(candidates, tuple) or any(
        not isinstance(candidate, RetrievedPendingCandidate)
        for candidate in candidates
    ):
        raise TypeError("待确认候选必须是 RetrievedPendingCandidate 元组。")
    if not isinstance(limit, int) or limit < 1:
        raise ValueError("待确认候选排序预算无效。")
    scored = tuple(
        replace(
            candidate,
            relevance_score=result.score,
            matched_terms=result.matched_terms,
        )
        for candidate in candidates
        for result in (score_tokens(query_tokens, candidate.text),)
    )
    return tuple(
        sorted(
            scored,
            key=lambda candidate: _memory_ranking_key(
                candidate.relevance_score,
                # 待确认候选尚未采纳，明确按「非人工采纳」排序，不冒充采纳方式。
                manual_adoption=False,
                confidence=candidate.confidence,
                valid_at=candidate.valid_at,
                memory_id=candidate.candidate_id,
            ),
        )[:limit]
    )


def _memory_ranking_key(
    score: float | None,
    *,
    manual_adoption: bool,
    confidence: float,
    valid_at: datetime | None,
    memory_id: UUID,
) -> tuple[object, ...]:
    """可解释的词典序键：先相关度，再人工采纳、置信度、时间与标识。

    ``manual_adoption`` 显式表达「这条命中是否由人工采纳」。待确认候选
    还没有采纳方式，传入 ``False`` 表示它不属于人工采纳，而不是伪造一个
    采纳方式字面量。
    """

    return (
        -(score or 0.0),
        not manual_adoption,
        -confidence,
        valid_at is None,
        -(valid_at.timestamp() if valid_at is not None else 0.0),
        str(memory_id),
    )
