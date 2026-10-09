"""PostgresRetrieval 的有界查询契约：超时必须真正下发到语句级配置。

用假连接替身验证，不连接数据库。
"""

from __future__ import annotations

import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from uuid import uuid4

from notalone.persistence.retrieval import PostgresRetrieval
from notalone.scopes import ContactScope


class RecordingConnection:
    """记录执行过的 SQL 与参数，查询一律返回空结果。"""

    def __init__(self) -> None:
        self.statements: list[tuple[str, object]] = []

    def execute(self, statement: str, parameters: object = None):
        self.statements.append((statement, parameters))
        return _RecordingCursor()

    def cursor(self) -> "_RecordingCursor":
        return _RecordingCursor()


class _RecordingCursor:
    def execute(self, statement: str, parameters: object = None):
        del statement, parameters
        return self

    def fetchall(self) -> list[object]:
        return []

    def fetchone(self) -> None:
        return None

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None


class PostgresRetrievalTimeoutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(owner_id=uuid4(), contact_id=uuid4())
        self.connection = RecordingConnection()
        original = PostgresRetrieval._connect
        self.addCleanup(setattr, PostgresRetrieval, "_connect", original)

        @contextmanager
        def fake_connect(_self):
            yield self.connection

        PostgresRetrieval._connect = fake_connect  # type: ignore[method-assign]

    def _retrieval(self) -> PostgresRetrieval:
        return PostgresRetrieval("postgresql:///unused")

    def _timeout_statements(self) -> list[str]:
        return [
            str(parameters)
            for statement, parameters in self.connection.statements
            if "statement_timeout" in statement
        ]

    def test_explicit_timeout_is_applied_to_the_statement(self) -> None:
        self._retrieval().search_messages(
            scope=self.scope, target_message_id=uuid4(), limit=1, timeout_ms=500,
        )
        self.assertEqual(self._timeout_statements(), ["('500ms',)"])

    def test_missing_timeout_leaves_the_session_default(self) -> None:
        self._retrieval().search_messages(
            scope=self.scope, target_message_id=uuid4(), limit=1,
        )
        self.assertEqual(self._timeout_statements(), [])

    def test_reply_context_sites_pass_a_bounded_timeout(self) -> None:
        from notalone.reply.context import RETRIEVAL_TIMEOUT_MS

        self.assertIsInstance(RETRIEVAL_TIMEOUT_MS, int)
        self.assertGreater(RETRIEVAL_TIMEOUT_MS, 0)
        self.assertLessEqual(RETRIEVAL_TIMEOUT_MS, 1500)
        self.assertEqual(self._timeout_statements(), [])

    def test_invalid_timeout_is_rejected_before_connecting(self) -> None:
        with self.assertRaises(ValueError):
            self._retrieval().search_messages(
                scope=self.scope, timeout_ms=0,
            )
        self.assertEqual(self.connection.statements, [])


if __name__ == "__main__":
    unittest.main()
