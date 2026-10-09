"""待确认候选进入检索轨前必须满足的共享谓词。

内存适配器与 PostgreSQL 适配器共用这里的一份 Python 谓词，避免两个实现
各自漂移。权威路径仍然是 store 侧 SQL：``list_pending_candidates`` 只按
``status = 'pending'`` 过滤，``confirmed_memory`` 的来源校验由
``PostgresMemoryStore`` 的 SQL 完成。这里的谓词只做复验，口径必须与 SQL
一致，且 fail closed：状态不是 pending、超出联系人范围、落在有效期之外
（半开区间 ``[valid_at, invalid_at)``）或没有任何可用来源的候选，都不得
进入回复上下文。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime
from uuid import UUID

from notalone.memory import MemoryCandidate, MemoryCandidateStatus
from notalone.retrieval.errors import RetrievalInvariantError
from notalone.scopes import ContactScope


def select_current_pending_candidates(
    candidates: Iterable[MemoryCandidate],
    *,
    scope: ContactScope,
    now: datetime,
    candidate_ids: tuple[UUID, ...] | None = None,
    available_source_ids: Callable[[tuple[UUID, ...]], frozenset[UUID]] | None = None,
) -> tuple[MemoryCandidate, ...]:
    """返回可以进入待确认候选轨的候选。

    ``available_source_ids`` 是来源可用性读取器：调用方把候选引用到的
    全部来源 ID 一次性交给它，返回值是其中仍然可用的子集。传入 ``None``
    表示该适配器没有来源可用性模型（合成内存 store），绝不表示「来源都
    不可用」；两条检索路径都传同一个读取器时可见集合必须一致。

    读取器抛错时不吞异常：来源核验失败必须让整条检索轨失败，不能把
    「核验不了」降级成「没有候选」。
    """

    rows = tuple(candidates)
    current = tuple(
        candidate
        for candidate in rows
        if candidate.scope == scope
        and candidate.status is MemoryCandidateStatus.PENDING
        and (candidate.valid_at is None or candidate.valid_at <= now)
        and (candidate.invalid_at is None or now < candidate.invalid_at)
        and (candidate_ids is None or candidate.candidate_id in candidate_ids)
    )
    if available_source_ids is None or not current:
        return current

    requested = tuple(
        dict.fromkeys(
            source_id
            for candidate in current
            for source_id in candidate.source_ids
        )
    )
    available = frozenset(available_source_ids(requested))
    if any(not isinstance(source_id, UUID) for source_id in available):
        raise RetrievalInvariantError("待确认候选来源核验结果结构无效。")
    return tuple(
        candidate
        for candidate in current
        if any(source_id in available for source_id in candidate.source_ids)
    )
