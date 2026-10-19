"""不透明 CLI 位置的持久化回归；所有资料均为合成联系人与消息。"""

from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg

from notalone.persistence.observation_store import ObservationMode, ObservationWatermarkError, ObservationPersistenceError, PostgresObservationStore
from tests.integration.persistence import test_observation_store as observations


class OpaqueObservationCursorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        observations.PostgresObservationStoreTest.setUpClass()
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            ready = connection.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_schema='public' "
                "AND table_name='local_wechat_observation' AND column_name='commit_order'"
            ).fetchone()
        if ready is None:
            raise unittest.SkipTest("不透明游标回归需要已执行 088 的隔离测试库。")

    def setUp(self):
        self.fixture = observations.PostgresObservationStoreTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.store = self.fixture.store
        self.scope = {'owner_id': self.fixture.owner_id, 'contact_id': self.fixture.contact_a}

    def record(self, local_id, cursor, *, since_id=None, since_cursor=None):
        return self.store.record_batch_with_messages(
            **self.scope, binding_id=self.fixture.binding_a.binding_id,
            mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic-opaque',
            conversation_locator='wxid_observation_a',
            last_local_id=local_id, last_cursor=cursor,
            since_local_id=since_id, since_cursor=since_cursor,
            record_count=0, messages=(), event_count=1, non_text_count=1,
            cursor_ordered=True,
        )

    def test_descending_local_ids_follow_opaque_cursor_and_reliable_commit_order(self):
        self.record(389, 'opaque:page-a')
        second = self.record(379, 'opaque:page-b', since_id=389, since_cursor='opaque:page-a')
        self.assertEqual(second.observation.last_cursor, 'opaque:page-b')
        self.assertEqual(self.store.read_cursor(**self.scope).last_cursor, 'opaque:page-b')
        reliable = self.store.read_reliable_cursor(
            **self.scope, binding_id=self.fixture.binding_a.binding_id,
        )
        self.assertEqual(reliable.last_cursor, 'opaque:page-b')

    def test_repeated_local_id_ranges_are_distinct_pages_and_old_retry_cannot_rewind(self):
        first = self.record(3, 'opaque:a')
        self.record(2, 'opaque:b', since_id=3, since_cursor='opaque:a')
        self.record(3, 'opaque:c', since_id=2, since_cursor='opaque:b')
        last = self.record(2, 'opaque:d', since_id=3, since_cursor='opaque:c')
        retry = self.record(3, 'opaque:a')
        self.assertEqual(first.observation.observation_id, retry.observation.observation_id)
        self.assertNotEqual(first.observation.observation_id, last.observation.observation_id)
        self.assertEqual(self.store.read_cursor(**self.scope).last_cursor, 'opaque:d')
        recovered = PostgresObservationStore(observations.TEST_DATABASE_URL)
        self.assertEqual(recovered.read_reliable_cursor(
            **self.scope, binding_id=self.fixture.binding_a.binding_id,
        ).last_cursor, 'opaque:d')

    def test_stale_new_page_is_rejected_and_does_not_become_reliable(self):
        self.record(3, 'opaque:a')
        self.record(2, 'opaque:b', since_id=3, since_cursor='opaque:a')
        with self.assertRaises(ObservationWatermarkError):
            self.record(8, 'opaque:stale', since_id=3, since_cursor='opaque:a')
        self.assertEqual(self.store.read_reliable_cursor(
            **self.scope, binding_id=self.fixture.binding_a.binding_id,
        ).last_cursor, 'opaque:b')

    def test_concurrent_pages_from_same_start_allow_only_one_commit(self):
        self.record(3, 'opaque:a')
        def advance(cursor):
            try:
                self.record(2, cursor, since_id=3, since_cursor='opaque:a')
                return cursor
            except ObservationWatermarkError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(advance, ['opaque:b', 'opaque:c']))
        succeeded = [cursor for cursor in results if cursor is not None]
        self.assertEqual(len(succeeded), 1)
        self.assertEqual(self.store.read_cursor(**self.scope).last_cursor, succeeded[0])

    def test_missing_cursor_can_continue_from_last_reliable_source(self):
        self.record(3, 'opaque:a')
        self.store.rewind_cursor(
            **self.scope, binding_id=self.fixture.binding_a.binding_id, target=None,
        )
        self.record(2, 'opaque:b', since_id=3, since_cursor='opaque:a')
        self.assertEqual(self.store.read_cursor(**self.scope).last_cursor, 'opaque:b')

    def test_cursor_write_failure_rolls_back_source_and_retries_same_page(self):
        self.record(3, 'opaque:a')
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            connection.execute("ALTER TABLE public.wechat_observation_cursor ADD CONSTRAINT synthetic_cursor_write_failure CHECK (last_cursor <> 'opaque:failure') NOT VALID")
        try:
            with self.assertRaises(ObservationPersistenceError):
                self.record(2, 'opaque:failure', since_id=3, since_cursor='opaque:a')
            self.assertEqual(self.store.read_cursor(**self.scope).last_cursor, 'opaque:a')
            self.assertEqual(self.store.read_reliable_cursor(
                **self.scope, binding_id=self.fixture.binding_a.binding_id,
            ).last_cursor, 'opaque:a')
        finally:
            with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
                connection.execute("ALTER TABLE public.wechat_observation_cursor DROP CONSTRAINT synthetic_cursor_write_failure")
        self.record(2, 'opaque:failure', since_id=3, since_cursor='opaque:a')
        self.assertEqual(self.store.read_cursor(**self.scope).last_cursor, 'opaque:failure')

    def test_rewind_rejects_snapshot_that_became_stale(self):
        self.record(3, 'opaque:a')
        target = self.store.read_cursor(**self.scope)
        self.record(2, 'opaque:b', since_id=3, since_cursor='opaque:a')
        with self.assertRaises(ObservationWatermarkError):
            self.store.rewind_cursor(
                **self.scope, binding_id=self.fixture.binding_a.binding_id,
                target=target, expected_cursor='opaque:a',
            )
        self.assertEqual(self.store.read_cursor(**self.scope).last_cursor, 'opaque:b')

    def test_migration_preserves_existing_derived_data_without_updating_sources(self):
        observation = self.record(389, 'opaque:legacy').observation
        batch_id, version_id = uuid4(), uuid4()
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            # 在隔离测试库恢复新增排序列前的形状；DDL 不触发来源 UPDATE。
            connection.execute("ALTER TABLE public.local_wechat_observation DROP COLUMN commit_order CASCADE")
            connection.execute(
                """INSERT INTO public.layered_memory_batch (
                    id, owner_id, contact_id, settings_generation, work_key, status,
                    input_manifest, input_payload, output_payload, dependency_ids, created_at
                ) VALUES (%s,%s,%s,0,'synthetic-upgrade','succeeded','{}','{}','{}',%s,now())""",
                (batch_id, self.fixture.owner_id, self.fixture.contact_a, [observation.observation_id]),
            )
            connection.execute(
                """INSERT INTO public.scenario_document_version (
                    id, owner_id, contact_id, scenario_id, batch_id, organization_generation,
                    schema_version, title, hint, paragraphs, created_at
                ) VALUES (%s,%s,%s,%s,%s,0,1,'合成主题','合成提示','[]',now())""",
                (version_id, self.fixture.owner_id, self.fixture.contact_a, uuid4(), batch_id),
            )
            connection.execute(
                """INSERT INTO public.relationship_overview_projection (
                    owner_id, scope_kind, contact_id, projection_revision,
                    memory_ids, source_ids, manifest, built_at
                ) VALUES (%s,'contact',%s,%s,'{}',%s,
                    '{"version":1,"memory_revision":0,"memories":[]}',now())""",
                (self.fixture.owner_id, self.fixture.contact_a, 'a'*64, [observation.observation_id]),
            )
        migration = (Path(__file__).resolve().parents[3] / 'database/migrations/088_cli_opaque_cursor_order.sql').read_text()
        with psycopg.connect(observations.TEST_DATABASE_URL, autocommit=True) as connection:
            connection.execute(migration)
            connection.execute(migration)
            retained = connection.execute(
                """SELECT
                    EXISTS(SELECT 1 FROM public.layered_memory_batch WHERE id=%s),
                    EXISTS(SELECT 1 FROM public.scenario_document_version WHERE id=%s),
                    EXISTS(SELECT 1 FROM public.relationship_overview_projection WHERE owner_id=%s AND contact_id=%s)
                """, (batch_id, version_id, self.fixture.owner_id, self.fixture.contact_a),
            ).fetchone()
            self.assertEqual(retained, (True, True, True))
            self.assertIsNone(connection.execute(
                "SELECT commit_order FROM public.local_wechat_observation WHERE id=%s",
                (observation.observation_id,),
            ).fetchone()[0])
        self.assertEqual(self.store.read_reliable_cursor(
            **self.scope, binding_id=self.fixture.binding_a.binding_id,
        ).last_cursor, 'opaque:legacy')
