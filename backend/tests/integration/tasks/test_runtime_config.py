"""指定任务配置的隔离数据库接缝，不连接业务库或调用模型。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import os
from pathlib import Path
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.ingest.normalizer import normalize_document
from notalone.persistence.background_tasks import (
    BackgroundTaskStateError, PostgresBackgroundTaskRepository,
)
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.tasks.models import (
    BackgroundTaskStepName, ExtractionRuntimeConfig, ExtractionRuntimeMode,
)


ROOT = Path(__file__).resolve().parents[3]


class RuntimeConfigPersistenceTest(unittest.TestCase):
    def setUp(self):
        self.database_name = f"notalone_runtime_config_{uuid4().hex}_test"
        instance = os.environ.get("NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test")
        self.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        self.database_url = make_conninfo(instance, dbname=self.database_name)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(self.database_name),
        ))
        self.addCleanup(self.drop_database)
        migrate(self.database_url, ROOT / "database/migrations")
        self.owner_id, self.contact_id, self.worker_id = uuid4(), uuid4(), uuid4()
        self.scope = {"owner_id": self.owner_id, "contact_id": self.contact_id}
        self.repository = PostgresBackgroundTaskRepository(self.database_url)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id, display_name) VALUES(%s, '合成任务用户')", (self.owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成任务联系人')", (self.owner_id, self.contact_id))
            connection.execute("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES(%s,'wechat','wxid_synthetic_owner','合成用户')", (self.owner_id,))
        batch = normalize_document(read_jsonl(ROOT / "tests/fixtures/valid_single_contact.jsonl"))
        self.task_id = PostgresIngestRepository(self.database_url).import_document(
            owner_id=self.owner_id, document=batch,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact_id)),
        ).task_id
        self.bounded = ExtractionRuntimeConfig(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1, "a" * 64)
        self.legacy = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)

    def drop_database(self):
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.database_name)))
        finally:
            self.admin.close()

    def configure(self, config):
        return self.repository.configure_extraction_runtime(**self.scope, task_id=self.task_id, config=config)

    def task(self):
        return self.repository.get_task(**self.scope, task_id=self.task_id)

    def claim(self, **options):
        return self.repository.claim_next_step(
            **self.scope, task_id=self.task_id, worker_id=self.worker_id,
            lease_duration=timedelta(seconds=30), **options,
        )

    def finish_parse_and_normalize(self):
        for name in (BackgroundTaskStepName.PARSE, BackgroundTaskStepName.NORMALIZE):
            claim = self.claim()
            self.assertEqual(claim.name, name)
            self.repository.complete_step(claim, processed_count=6)

    def test_initialization_is_scoped_idempotent_and_does_not_claim(self):
        self.assertIsNone(self.task().extraction_runtime_config)
        self.assertEqual(self.configure(self.bounded), self.bounded)
        self.assertEqual(self.configure(self.bounded), self.bounded)
        self.assertEqual(self.task().extraction_runtime_config, self.bounded)
        self.assertTrue(all(step.attempt_count == 0 for step in self.task().steps))
        with self.assertRaises(BackgroundTaskStateError):
            self.configure(self.legacy)
        with self.assertRaises(BackgroundTaskStateError):
            self.repository.configure_extraction_runtime(owner_id=self.owner_id, contact_id=uuid4(), task_id=self.task_id, config=self.legacy)
        self.assertEqual(self.task().extraction_runtime_config, self.bounded)

    def test_rule_mismatch_rejects_before_extract_lease_and_claim_carries_saved_value(self):
        self.configure(self.bounded)
        self.finish_parse_and_normalize()
        before = self.task()
        for wrong in (None, "b" * 64):
            with self.subTest(wrong=wrong), self.assertRaises(BackgroundTaskStateError):
                self.claim(runtime_rule_set_sha256=wrong)
            self.assertEqual(self.task(), before)
        claim = self.claim(runtime_rule_set_sha256="a" * 64)
        self.assertEqual(claim.extraction_runtime_config, self.bounded)
        self.assertEqual(claim.name, BackgroundTaskStepName.EXTRACT_MEMORY)
        with self.assertRaises(BackgroundTaskStateError):
            self.configure(self.bounded)

    def test_retry_cannot_reinitialize_configuration_after_attempt_reset(self):
        self.configure(self.bounded)
        self.finish_parse_and_normalize()
        claim = self.claim(runtime_rule_set_sha256="a" * 64)
        self.repository.fail_step(claim, error_code="synthetic_failure", retryable=False)
        task = self.repository.retry_failed_task(**self.scope, task_id=self.task_id)
        self.assertEqual(task.extraction_runtime_config, self.bounded)
        self.assertEqual(task.steps[2].attempt_count, 0)
        for config in (self.bounded, self.legacy):
            with self.subTest(config=config), self.assertRaises(BackgroundTaskStateError):
                self.configure(config)
        recovered = self.claim(runtime_rule_set_sha256="a" * 64)
        self.assertEqual(recovered.extraction_runtime_config, self.bounded)
        self.assertGreater(recovered.lease_generation, claim.lease_generation)

    def test_missing_column_keeps_legacy_read_and_rejects_explicit_write(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("ALTER TABLE public.background_task DROP COLUMN IF EXISTS extraction_runtime_config")
        before = self.task()
        self.assertIsNone(before.extraction_runtime_config)
        for config in (self.legacy, self.bounded):
            with self.subTest(config=config), self.assertRaises(BackgroundTaskStateError):
                self.configure(config)
        self.assertEqual(self.task(), before)
        self.assertEqual(self.claim().name, BackgroundTaskStepName.PARSE)

    def test_requeued_legacy_snapshot_cannot_initialize_after_first_generation(self):
        self.finish_parse_and_normalize()
        claim = self.claim()
        self.repository.fail_step(claim, error_code="synthetic_failure", retryable=False)
        self.repository.retry_failed_task(**self.scope, task_id=self.task_id)
        # 合成重排快照：其他首次标记已重置，单独验证不可逆generation。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.background_task_step SET status='pending',started_at=NULL WHERE id=%s", (claim.step_id,))
        for config in (self.legacy, self.bounded):
            with self.subTest(config=config), self.assertRaises(BackgroundTaskStateError):
                self.configure(config)
        self.assertIsNone(self.task().extraction_runtime_config)

    def test_concurrent_incompatible_initialization_has_exactly_one_winner(self):
        def attempt(config):
            try:
                return self.configure(config)
            except BackgroundTaskStateError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(attempt, (self.bounded, self.legacy)))
        self.assertEqual(values.count(None), 1)
        self.assertEqual(self.task().extraction_runtime_config, next(value for value in values if value is not None))

    def test_task_without_extract_step_cannot_select_mode(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.background_task_step WHERE task_id=%s AND step_name='extract_memory'", (self.task_id,))
        with self.assertRaises(BackgroundTaskStateError):
            self.configure(self.bounded)
        self.assertIsNone(self.task().extraction_runtime_config)

    def test_missing_memory_capability_refuses_bounded_before_config_write(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("ALTER TABLE public.memory_candidate DROP CONSTRAINT memory_candidate_dimension_evidence_version4_check")
        before = self.task()
        with self.assertRaises(BackgroundTaskStateError):
            self.configure(self.bounded)
        self.assertEqual(self.task(), before)
        self.assertEqual(self.configure(self.legacy), self.legacy)
