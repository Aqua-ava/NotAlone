"""测试用可计数 psycopg 连接：只统计 SQL 条数，不做耗时 profiling。"""

from __future__ import annotations

import psycopg


class QueryCounter:
    """记录一次被测调用发出的 SQL 文本。"""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def reset(self) -> None:
        self.statements.clear()

    @property
    def count(self) -> int:
        return len(self.statements)

    def matching(self, fragment: str) -> list[str]:
        return [statement for statement in self.statements if fragment in statement]


class CountingConnection(psycopg.Connection):
    """把每条 SQL 记入调用方提供的计数器后委托真实连接执行。"""

    @classmethod
    def connect(cls, conninfo: str = "", *, counter: QueryCounter, **kwargs):
        connection = super().connect(conninfo, **kwargs)
        connection.query_counter = counter
        return connection

    def execute(self, query, params=None, **kwargs):
        counter = getattr(self, "query_counter", None)
        if counter is not None:
            counter.statements.append(statement_text(query))
        return super().execute(query, params, **kwargs)


def statement_text(query) -> str:
    if isinstance(query, str):
        return query
    try:
        return query.as_string(None)
    except Exception:  # pragma: no cover - 组合 SQL 的兜底展示
        return repr(query)


def is_schema_probe(statement: str) -> bool:
    return "pg_attribute" in statement or "information_schema" in statement
