"""单次只读候选列表内复用明确依赖的候选证据，退出后立即释放。"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from notalone.scopes import ContactScope


@dataclass
class _ReadScope:
    connection: Any
    candidates: dict[tuple[UUID, UUID], dict | None] = field(default_factory=dict)


_current: ContextVar[_ReadScope | None] = ContextVar("memory_context_read", default=None)


@contextmanager
def reuse_memory_context(connection):
    """仅用于一个 REPEATABLE READ 只读事务，不跨写入或生成复验阶段。"""
    token = _current.set(_ReadScope(connection))
    try:
        yield
    finally:
        _current.reset(token)


def read_dependency_candidates(connection, scope: ContactScope, dependencies: set[UUID]) -> list[dict]:
    # 先读轻量身份，再读取尚未取得的证据；不同候选共享的多 MB JSON 只解析一次。
    rows = connection.execute(
        "SELECT source_candidate_id AS id FROM public.confirmed_memory "
        "WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[]) "
        "UNION SELECT source_candidate_id AS id FROM public.owner_memory "
        "WHERE owner_id=%s AND id=ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, list(dependencies), scope.owner_id, list(dependencies)),
    ).fetchall()
    identifiers = sorted({row["id"] for row in rows if row["id"] is not None})
    active = _current.get()
    cache = active.candidates if active is not None and active.connection is connection else {}
    missing = [identifier for identifier in identifiers if (scope.owner_id, identifier) not in cache]
    if missing:
        found = connection.execute(
            "SELECT id,correction_evidence,dimension_evidence FROM public.memory_candidate "
            "WHERE owner_id=%s AND id=ANY(%s::uuid[]) ORDER BY id",
            (scope.owner_id, missing),
        ).fetchall()
        cache.update(((scope.owner_id, identifier), None) for identifier in missing)
        cache.update(((scope.owner_id, row["id"]), row) for row in found)
    # 仅内部校验消费这些只读记录；合并函数不会修改原始窗口。
    return [cache[scope.owner_id, identifier] for identifier in identifiers
            if cache[scope.owner_id, identifier] is not None]
