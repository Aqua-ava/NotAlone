"""结构能力探针的正向缓存。

迁移账本机制下，正常运行时结构能力恒为真；每次读写都重新查询
`pg_attribute`/`information_schema` 只是热路径上的固定开销。这里缓存
「已确认存在」的结果，并保持旧库语义不变：

- 只缓存正向结果；缺失或空结果每次重新探测，旧库/未迁移库保持
  fail-closed，且迁移完成后的进程无需重启即可读到新结构。
- 缓存按数据库身份（host/port/dbname/user）键控；拿不到身份的连接
  （游标包装、测试替身、连接池代理）一律不缓存。
- 探针抛出的异常不缓存，原样上抛。

缓存只影响重复探测次数，不改变任何缺列分支的行为。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

# 值按数据库身份分组，进程内正常运行时数据库结构不会回退。
_CACHE: dict[tuple[str, ...], Any] = {}


def database_identity(connection: Any) -> tuple[str, ...] | None:
    """返回结构缓存键；无法确认数据库身份时返回 None（不缓存）。"""

    info = getattr(connection, "info", None)
    if info is None:
        return None
    fields = []
    for name in ("host", "port", "dbname", "user"):
        value = getattr(info, name, None)
        if value is None and name != "host":
            return None
        fields.append("" if value is None else str(value))
    return tuple(fields)


def schema_cached_value(
    connection: Any, key: str, probe: Callable[[], Any],
) -> Any:
    """缓存探针的「确认存在」结果；缺失/空结果不缓存。"""

    identity = database_identity(connection)
    if identity is None:
        return probe()
    cache_key = (*identity, key)
    if cache_key in _CACHE:
        return _CACHE[cache_key]
    value = probe()
    if value:
        _CACHE[cache_key] = value
    return value


def schema_capability(
    connection: Any, key: str, probe: Callable[[], bool],
) -> bool:
    """布尔型结构能力探针的正向缓存包装。"""

    return bool(schema_cached_value(connection, key, probe))


def reset_schema_capabilities() -> None:
    """清空进程内缓存；只供测试在隔离数据库之间复用。"""

    _CACHE.clear()
