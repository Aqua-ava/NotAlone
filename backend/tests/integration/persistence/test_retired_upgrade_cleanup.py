"""退役升级的历史副本仍随来源、联系人删除清空，无需旧 HTTP 入口。"""

import unittest
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.persistence.contact_deletion import delete_contact
from notalone.scopes import ContactScope
from tests.integration.persistence import test_all_source_deletion as source_fixture


class RetiredUpgradeCleanupTest(unittest.TestCase):
    def setUp(self):
        self.fixture = source_fixture.AllSourceDeletionTest()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()

    def _seed_history(self, contact, source, message):
        """直接植入旧版持久化状态，不调用退役服务或生成模型。"""
        f = self.fixture
        job, batch, task, trace = (uuid4() for _ in range(4))
        body = Jsonb({'text': '合成历史升级副本'})
        with psycopg.connect(f.url) as connection:
            connection.execute(
                "INSERT INTO public.memory_upgrade_job "
                "(id,owner_id,contact_id,scope_kind,operation_key,message_limit,batch_size,model_call_limit) "
                "VALUES (%s,%s,%s,'contact',%s,1,1,2)",
                (job, f.owner, contact, uuid4()),
            )
            connection.execute(
                "INSERT INTO public.background_task "
                "(id,owner_id,contact_id,task_type,status,current_step,message_count) "
                "VALUES (%s,%s,%s,'memory_upgrade','queued','preview_upgrade',1)",
                (task, f.owner, contact),
            )
            connection.execute(
                "INSERT INTO public.memory_extraction_trace "
                "(trace_id,owner_id,contact_id,run_id,batch_key) VALUES (%s,%s,%s,%s,%s)",
                (trace, f.owner, contact, batch, str(batch)),
            )
            for position, stage in enumerate(('window', 'recovery_reconciliation'), 1):
                connection.execute(
                    "INSERT INTO public.memory_extraction_trace_event "
                    "(event_id,trace_id,owner_id,contact_id,position,stage,payload) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (uuid4(), trace, f.owner, contact, position, stage, body),
                )
            connection.execute(
                "INSERT INTO public.memory_upgrade_batch "
                "(id,job_id,owner_id,contact_id,task_id,trace_id,batch_number,state,message_ids,"
                "source_generation,memory_generation,extracted_outcome,comparison,adjudications,"
                "applied_records,dependency_ids) "
                "VALUES (%s,%s,%s,%s,%s,%s,1,'ready',%s,%s,%s,%s,%s,%s,%s,%s)",
                (batch, job, f.owner, contact, task, trace, [message], body, body, body,
                 body, body, body, [source, message]),
            )
        return job, batch, task, trace

    def _snapshot(self, history):
        with psycopg.connect(self.fixture.url) as connection:
            batch = connection.execute(
                'SELECT to_jsonb(b) FROM public.memory_upgrade_batch b WHERE id=%s',
                (history[1],),
            ).fetchone()
            events = connection.execute(
                'SELECT payload FROM public.memory_extraction_trace_event WHERE trace_id=%s ORDER BY position',
                (history[3],),
            ).fetchall()
        return batch, events

    def _assert_erased(self, history, *, contact_deleted=False):
        with psycopg.connect(self.fixture.url) as connection:
            row = connection.execute(
                "SELECT state,message_ids,source_generation,memory_generation,extracted_outcome,"
                "comparison,adjudications,applied_records,dependency_ids,trace_id "
                "FROM public.memory_upgrade_batch WHERE id=%s", (history[1],),
            ).fetchone()
            self.assertEqual(row, None if contact_deleted else
                             ('invalidated', [], {}, None, None, None, None, None, [], None))
            self.assertEqual(connection.execute(
                'SELECT count(*) FROM public.memory_extraction_trace_event WHERE trace_id=%s',
                (history[3],),
            ).fetchone()[0], 0)
            if not contact_deleted:
                self.assertEqual(connection.execute(
                    'SELECT status FROM public.background_task WHERE id=%s', (history[2],),
                ).fetchone(), ('cancelled',))
            if contact_deleted:
                self.assertIsNone(connection.execute(
                    'SELECT id FROM public.memory_upgrade_job WHERE id=%s', (history[0],),
                ).fetchone())

    def test_source_deletion_erases_comparison_and_recovery_without_old_get(self):
        f = self.fixture
        target = self._seed_history(f.contact, f.target_source, f.target)
        unrelated = self._seed_history(f.contact, f.context_source, f.context)
        before = self._snapshot(unrelated)
        for _ in range(2):
            f._delete(f.target_source)
            self._assert_erased(target)
            self.assertEqual(self._snapshot(unrelated), before)

    def test_contact_deletion_erases_history_and_preserves_other_contact(self):
        f = self.fixture
        target = self._seed_history(f.contact, f.target_source, f.target)
        unrelated = self._seed_history(f.other, uuid4(), uuid4())
        before = self._snapshot(unrelated)
        scope = ContactScope(f.owner, f.contact)
        self.assertTrue(delete_contact(f.url, scope))
        self._assert_erased(target, contact_deleted=True)
        self.assertEqual(self._snapshot(unrelated), before)
        self.assertFalse(delete_contact(f.url, scope))
        self._assert_erased(target, contact_deleted=True)
