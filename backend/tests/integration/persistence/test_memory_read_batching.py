"""记忆列表/召回读取批量化与结构探针缓存的查询次数回归。

断言基于可计数连接，只做静态查询次数（SQL 语句数）对比；不做
耗时 profiling。查询次数断言与数据量无关才是批处理的判据。
"""

from __future__ import annotations

from uuid import UUID

from psycopg.rows import dict_row

from notalone.memory import AdoptionMethod
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from tests.integration.persistence.query_counting import (
    CountingConnection,
    QueryCounter,
    is_schema_probe,
)
from tests.integration.persistence.test_memory_timing import PostgresMemoryTimingTest


class MemoryReadBatchingTest(PostgresMemoryTimingTest):
    """每条列表/召回路径的 SQL 条数不随行数增长。"""

    def _counted_store(self) -> tuple[PostgresMemoryStore, QueryCounter]:
        counter = QueryCounter()
        store = PostgresMemoryStore(
            self.database_url,
            connection_factory=lambda: CountingConnection.connect(
                self.database_url, row_factory=dict_row, counter=counter,
            ),
        )
        return store, counter

    def _counted_owner_store(self) -> tuple[PostgresOwnerMemoryStore, QueryCounter]:
        counter = QueryCounter()
        store = PostgresOwnerMemoryStore(
            self.database_url,
            connection_factory=lambda: CountingConnection.connect(
                self.database_url, row_factory=dict_row, counter=counter,
            ),
        )
        return store, counter

    def _confirm_memories(self, count: int) -> list[UUID]:
        memory_ids = []
        for index in range(count):
            candidate = self.store.create_candidate(self._candidate((self.first,)))
            memory = self.store.confirm(
                scope=self.scope, candidate_id=candidate.candidate_id,
                adoption_method=AdoptionMethod.MANUAL,
            )
            memory_ids.append(memory.memory_id)
        return memory_ids

    def _confirm_owner_memories(self, count: int) -> list[UUID]:
        owner_store = PostgresOwnerMemoryStore(self.database_url)
        memory_ids = []
        for index in range(count):
            candidate = self.store.create_candidate(
                self._candidate((self.first,), subject=self._self_subject()),
            )
            memory = owner_store.confirm_candidate(
                candidate=candidate, adoption_method=AdoptionMethod.MANUAL,
            )
            memory_ids.append(memory.memory_id)
        return memory_ids

    @staticmethod
    def _self_subject():
        from notalone.memory import FactSubject

        return FactSubject.SELF

    def test_list_confirmed_query_count_is_independent_of_row_count(self) -> None:
        self._confirm_memories(1)
        store, counter = self._counted_store()
        store.list_confirmed(self.scope)
        one_row = counter.count

        self._confirm_memories(4)
        store, counter = self._counted_store()
        self.assertEqual(len(store.list_confirmed(self.scope)), 5)
        five_rows = counter.count

        self.assertEqual(five_rows, one_row)

    def test_owner_list_active_query_count_is_independent_of_row_count(self) -> None:
        self._confirm_owner_memories(1)
        store, counter = self._counted_owner_store()
        store.list_active(self.scope.owner_id)
        one_row = counter.count

        self._confirm_owner_memories(4)
        store, counter = self._counted_owner_store()
        self.assertEqual(len(store.list_active(self.scope.owner_id)), 5)
        five_rows = counter.count

        self.assertEqual(five_rows, one_row)

    def test_repeated_memory_reads_do_not_repeat_schema_probes(self) -> None:
        self._confirm_memories(2)
        store, counter = self._counted_store()
        store.list_confirmed(self.scope)
        counter.reset()
        store.list_confirmed(self.scope)

        self.assertEqual([s for s in counter.statements if is_schema_probe(s)], [])

    def test_repeated_owner_reads_do_not_repeat_schema_probes(self) -> None:
        self._confirm_owner_memories(2)
        store, counter = self._counted_owner_store()
        store.list_active(self.scope.owner_id)
        counter.reset()
        store.list_active(self.scope.owner_id)

        self.assertEqual([s for s in counter.statements if is_schema_probe(s)], [])
