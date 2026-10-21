"""结构能力探针缓存：正向结果缓存、旧库/未知连接保持 fail-closed。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from notalone.persistence.schema_capabilities import (
    reset_schema_capabilities,
    schema_cached_value,
    schema_capability,
)


def _identity_connection(dbname: str = "notalone_test") -> SimpleNamespace:
    return SimpleNamespace(info=SimpleNamespace(
        dbname=dbname, host="/tmp", port=5432, user="synthetic",
    ))


class SchemaCapabilityCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        reset_schema_capabilities()
        self.addCleanup(reset_schema_capabilities)

    def test_positive_result_is_cached_per_database(self) -> None:
        connection = _identity_connection()
        calls: list[str] = []

        def probe() -> bool:
            calls.append("probe")
            return True

        self.assertTrue(schema_capability(connection, "memory_candidate.event", probe))
        self.assertTrue(schema_capability(connection, "memory_candidate.event", probe))
        self.assertEqual(calls, ["probe"])

    def test_missing_result_is_not_cached_so_old_schema_stays_fail_closed(self) -> None:
        connection = _identity_connection()
        calls: list[str] = []

        def probe() -> bool:
            calls.append("probe")
            return False

        self.assertFalse(schema_capability(connection, "memory_candidate.event", probe))
        self.assertFalse(schema_capability(connection, "memory_candidate.event", probe))
        self.assertEqual(calls, ["probe", "probe"])

    def test_probe_failure_is_not_cached_and_propagates(self) -> None:
        connection = _identity_connection()
        calls: list[str] = []

        def failing_probe() -> bool:
            calls.append("failing")
            raise RuntimeError("系统表不可读")

        with self.assertRaises(RuntimeError):
            schema_capability(connection, "memory_candidate.event", failing_probe)
        self.assertTrue(schema_capability(
            connection, "memory_candidate.event",
            lambda: calls.append("ok") or True,
        ))
        self.assertEqual(calls, ["failing", "ok"])

    def test_connection_without_identity_is_never_cached(self) -> None:
        connection = object()
        calls: list[str] = []

        def probe() -> bool:
            calls.append("probe")
            return True

        self.assertTrue(schema_capability(connection, "memory_candidate.event", probe))
        self.assertTrue(schema_capability(connection, "memory_candidate.event", probe))
        self.assertEqual(calls, ["probe", "probe"])

    def test_different_databases_do_not_share_cache(self) -> None:
        first = _identity_connection("notalone_a_test")
        second = _identity_connection("notalone_b_test")
        calls: list[str] = []

        def probe() -> bool:
            calls.append("probe")
            return True

        self.assertTrue(schema_capability(first, "memory_candidate.event", probe))
        self.assertTrue(schema_capability(second, "memory_candidate.event", probe))
        self.assertEqual(calls, ["probe", "probe"])

    def test_truthy_probe_values_are_cached_and_empty_values_are_not(self) -> None:
        connection = _identity_connection()
        calls: list[str] = []

        def columns() -> frozenset[str]:
            calls.append("probe")
            return frozenset({"event", "conditions"})

        self.assertEqual(
            schema_cached_value(connection, "memory_candidate.columns", columns),
            frozenset({"event", "conditions"}),
        )
        self.assertEqual(
            schema_cached_value(connection, "memory_candidate.columns", columns),
            frozenset({"event", "conditions"}),
        )
        self.assertEqual(calls, ["probe"])

        empty_calls: list[str] = []

        def missing() -> frozenset[str]:
            empty_calls.append("probe")
            return frozenset()

        self.assertEqual(
            schema_cached_value(connection, "missing.columns", missing), frozenset(),
        )
        self.assertEqual(
            schema_cached_value(connection, "missing.columns", missing), frozenset(),
        )
        self.assertEqual(empty_calls, ["probe", "probe"])


if __name__ == "__main__":
    unittest.main()
