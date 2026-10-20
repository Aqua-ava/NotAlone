"""只读进度查询的范围、来源、分页和固定查询次数回归；仅用合成资料。"""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate
from notalone.persistence.background_tasks import BackgroundTaskNotFoundError
from notalone.persistence.memory_processing import PostgresMemoryProcessingStore


ROOT = Path(__file__).resolve().parents[3]
FIXED_TIME = datetime(2026, 10, 1, tzinfo=timezone.utc)


class MemoryProcessingReadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database_name = f"notalone_progress_{uuid4().hex}_test"
        instance_url = os.environ.get(
            "NOTALONE_TEST_DATABASE_URL", "host=/tmp dbname=notalone_test"
        )
        cls.database_url = make_conninfo(instance_url, dbname=cls.database_name)
        cls.admin = psycopg.connect(instance_url, dbname="postgres", autocommit=True)
        cls.addClassCleanup(cls.admin.close)
        cls.admin.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
                sql.Identifier(cls.database_name)
            )
        )
        cls.addClassCleanup(cls._drop_database)
        migrate(cls.database_url, ROOT / "database/migrations")

    @classmethod
    def _drop_database(cls) -> None:
        cls.admin.execute(
            sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(cls.database_name)
            )
        )

    def setUp(self) -> None:
        self.connection = psycopg.connect(self.database_url, autocommit=True)
        self.addCleanup(self.connection.close)
        self.assertEqual(
            self.connection.execute("SELECT current_database()").fetchone()[0],
            self.database_name,
        )
        self.owner_id, self.other_owner_id = uuid4(), uuid4()
        for owner_id in (self.owner_id, self.other_owner_id):
            self.connection.execute(
                "INSERT INTO public.owner(id,display_name) VALUES (%s,'合成进度用户')",
                (owner_id,),
            )
        self.contact_id = self._contact()
        self.store = PostgresMemoryProcessingStore(self.database_url)

    def _contact(self, *, owner_id: UUID | None = None) -> UUID:
        contact_id = uuid4()
        self.connection.execute(
            "INSERT INTO public.contact(owner_id,id,display_name) "
            "VALUES (%s,%s,'合成进度联系人')",
            (owner_id or self.owner_id, contact_id),
        )
        return contact_id

    def _source(
        self, *, contact_id: UUID | None = None, owner_id: UUID | None = None,
        status: str = "active",
    ) -> UUID:
        source_id = uuid4()
        self.connection.execute(
            "INSERT INTO public.source_document "
            "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status,deleted_at) "
            "VALUES (%s,%s,%s,'wechat_jsonl',%s,%s,0,%s,%s)",
            (source_id, owner_id or self.owner_id, contact_id or self.contact_id,
             None if status == "deleted" else "synthetic.jsonl",
             None if status == "deleted" else uuid4().hex * 2,
             status, FIXED_TIME if status == "deleted" else None),
        )
        return source_id

    def _binding(
        self, contact_id: UUID, *, owner_id: UUID | None = None, active: bool = True,
    ) -> UUID:
        binding_id = uuid4()
        self.connection.execute(
            "INSERT INTO public.conversation_binding "
            "(id,owner_id,contact_id,channel,account_scope,conversation_locator,"
            "status,revoked_at) "
            "VALUES (%s,%s,%s,'wechat','synthetic-account',%s,%s,%s)",
            (binding_id, owner_id or self.owner_id, contact_id, str(binding_id),
             "active" if active else "revoked", None if active else FIXED_TIME),
        )
        return binding_id

    def _observation(
        self, contact_id: UUID, *, owner_id: UUID | None = None,
        enqueued: bool = True, binding_id: UUID | None = None,
    ) -> UUID:
        binding_id = binding_id or self._binding(contact_id, owner_id=owner_id)
        observation_id = uuid4()
        self.connection.execute(
            "INSERT INTO public.local_wechat_observation "
            "(id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,"
            "last_local_id,last_cursor,record_count,memory_enqueued_at) "
            "VALUES (%s,%s,%s,%s,'live','synthetic-test',%s,1,'synthetic-cursor',0,%s)",
            (observation_id, owner_id or self.owner_id, contact_id, binding_id,
             str(binding_id), FIXED_TIME if enqueued else None),
        )
        return observation_id

    def _task(
        self, *, source_id: UUID | None = None, contact_id: UUID | None = None,
        owner_id: UUID | None = None, task_id: UUID | None = None,
        status: str = "queued", updated_at: datetime = FIXED_TIME,
        task_type: str = "import",
    ) -> UUID:
        task_id = task_id or uuid4()
        self.connection.execute(
            "INSERT INTO public.background_task "
            "(id,owner_id,contact_id,source_document_id,task_type,status,current_step,"
            "message_count,created_at,updated_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,'extract_memory',0,%s,%s)",
            (task_id, owner_id or self.owner_id, contact_id or self.contact_id,
             source_id, task_type, status, FIXED_TIME, updated_at),
        )
        return task_id

    def _read_traced(self, *, contact_id: UUID | None = None):
        statements: list[str] = []

        class TracedConnection(psycopg.Connection):
            def execute(connection, query, params=None, **kwargs):
                statement = (
                    query.as_string(connection)
                    if isinstance(query, sql.Composable) else str(query)
                )
                statements.append(statement)
                return super().execute(query, params, **kwargs)

        with patch(
            "notalone.persistence.memory_processing.psycopg.connect",
            TracedConnection.connect,
        ):
            payload = self.store.read(owner_id=self.owner_id, contact_id=contact_id)
        return payload, statements

    def test_owner_progress_reads_all_sources_with_one_data_query(self) -> None:
        for _ in range(12):
            self._task(source_id=self._source())
        for _ in range(3):
            contact_id = self._contact()
            self._observation(contact_id)
            self._task(contact_id=contact_id, task_type="observation")
        payload, statements = self._read_traced()
        self.assertEqual(len(payload["tasks"]), 15)
        self.assertTrue(all(task["action"] == "resume" for task in payload["tasks"]))
        data_queries = [
            statement for statement in statements
            if statement.lstrip().upper().startswith(("SELECT", "WITH"))
        ]
        self.assertLessEqual(len(data_queries), 1, statements)

    def test_import_requires_its_exact_active_source_and_scope(self) -> None:
        expected = {}
        for status in ("active", "delete_requested", "deleting", "delete_failed", "deleted"):
            task_id = self._task(source_id=self._source(status=status))
            expected[str(task_id)] = status == "active"
        other_contact = self._contact()
        other_contact_task = self._task(
            source_id=self._source(contact_id=other_contact), contact_id=other_contact,
        )
        other_owner_contact = self._contact(owner_id=self.other_owner_id)
        self._task(
            owner_id=self.other_owner_id, contact_id=other_owner_contact,
            source_id=self._source(owner_id=self.other_owner_id, contact_id=other_owner_contact),
        )
        self._task(source_id=self._source(), task_type="delete")
        self.assertEqual(
            {task["task_id"] for task in self.store.read(owner_id=self.owner_id)["tasks"]},
            set(expected) | {str(other_contact_task)},
        )
        payload = self.store.read(owner_id=self.owner_id, contact_id=self.contact_id)
        self.assertEqual({task["task_id"] for task in payload["tasks"]}, set(expected))
        for task in payload["tasks"]:
            with self.subTest(task_id=task["task_id"]):
                self.assertEqual(task["action"], "resume" if expected[task["task_id"]] else None)
                self.assertEqual(
                    task["reason_code"],
                    "execution_interrupted" if expected[task["task_id"]] else "source_unavailable",
                )
        with self.assertRaises(BackgroundTaskNotFoundError):
            self.store.read(owner_id=self.owner_id, contact_id=other_owner_contact)

    def test_observation_requires_enqueued_source_and_exact_active_binding_scope(self) -> None:
        expected = {}
        contacts = {kind: self._contact() for kind in (
            "active", "unqueued", "revoked", "missing", "wrong_contact", "wrong_owner"
        )}
        self._observation(contacts["active"])
        self._observation(contacts["unqueued"], enqueued=False)
        revoked = self._binding(contacts["revoked"], active=False)
        self._observation(contacts["revoked"], binding_id=revoked)
        wrong_contact_binding = self._binding(contacts["active"])
        self._observation(contacts["wrong_contact"], binding_id=wrong_contact_binding)
        other_owner_contact = self._contact(owner_id=self.other_owner_id)
        wrong_owner_binding = self._binding(other_owner_contact, owner_id=self.other_owner_id)
        self._observation(contacts["wrong_owner"], binding_id=wrong_owner_binding)
        self._observation(other_owner_contact, owner_id=self.other_owner_id)
        for kind, contact_id in contacts.items():
            task_id = self._task(contact_id=contact_id, task_type="observation", status="cancelled")
            expected[str(task_id)] = kind == "active"
        payload = self.store.read(owner_id=self.owner_id)
        self.assertEqual({task["task_id"] for task in payload["tasks"]}, set(expected))
        for task in payload["tasks"]:
            with self.subTest(task_id=task["task_id"]):
                self.assertEqual(task["status"], "stopped")
                self.assertEqual(task["action"], "restart" if expected[task["task_id"]] else None)
                self.assertEqual(
                    task["reason_code"],
                    "task_cancelled" if expected[task["task_id"]] else "source_unavailable",
                )

    def test_progress_keeps_status_priority_uuid_ties_and_100_101_limit(self) -> None:
        base_id = uuid4().int & ~0xFFFF
        active_ids, finished_ids = [], []
        for number in reversed(range(100)):
            task_id = UUID(int=base_id + number)
            active = number % 2 == 0
            self._task(
                task_id=task_id, source_id=self._source(),
                status="queued" if active else "succeeded",
            )
            (active_ids if active else finished_ids).append(str(task_id))
        expected = sorted(active_ids) + sorted(finished_ids)
        payload = self.store.read(owner_id=self.owner_id)
        self.assertEqual([task["task_id"] for task in payload["tasks"]], expected)
        self.assertFalse(payload["has_more"])
        self._task(task_id=UUID(int=base_id + 101), source_id=self._source(), status="succeeded")
        payload = self.store.read(owner_id=self.owner_id)
        self.assertEqual([task["task_id"] for task in payload["tasks"]], expected)
        self.assertTrue(payload["has_more"])
        # 来源不可用也占原来的分页位置，不得因授权过滤补入第 101 条。
        self.connection.execute(
            "UPDATE public.source_document SET status='delete_requested' WHERE id="
            "(SELECT source_document_id FROM public.background_task WHERE id=%s)",
            (UUID(expected[0]),),
        )
        payload = self.store.read(owner_id=self.owner_id)
        self.assertEqual([task["task_id"] for task in payload["tasks"]], expected)
        self.assertEqual(payload["tasks"][0]["reason_code"], "source_unavailable")
        self.assertTrue(payload["has_more"])

    def test_progress_orders_updated_time_before_uuid_within_status_group(self) -> None:
        old = self._task(source_id=self._source())
        new = self._task(
            source_id=self._source(), updated_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
        )
        terminal = self._task(
            source_id=self._source(), status="failed",
            updated_at=datetime(2026, 10, 3, tzinfo=timezone.utc),
        )
        payload = self.store.read(owner_id=self.owner_id)
        self.assertEqual(
            [task["task_id"] for task in payload["tasks"]],
            [str(new), str(old), str(terminal)],
        )

    def test_read_keeps_running_lease_and_durable_task_states(self) -> None:
        active = self._task(source_id=self._source(), status="running")
        expired = self._task(source_id=self._source(), status="running")
        stopped = self._task(source_id=self._source(), status="cancelled")
        failed = self._task(source_id=self._source(), status="failed")
        for task_id, lease in (
            (active, datetime(2099, 1, 1, tzinfo=timezone.utc)),
            (expired, FIXED_TIME),
        ):
            self.connection.execute(
                "INSERT INTO public.background_task_step "
                "(task_id,step_name,step_order,status,lease_expires_at) "
                "VALUES (%s,'extract_memory',3,'running',%s)",
                (task_id, lease),
            )
        # 已结束步骤残留的未来租约不表示当前仍有执行者。
        self.connection.execute(
            "INSERT INTO public.background_task_step "
            "(task_id,step_name,step_order,status,lease_expires_at) "
            "VALUES (%s,'index',4,'succeeded',%s)",
            (expired, datetime(2099, 1, 1, tzinfo=timezone.utc)),
        )
        tasks = {
            task["task_id"]: task
            for task in self.store.read(owner_id=self.owner_id)["tasks"]
        }
        expected = {
            active: ("extracting", None), expired: ("interrupted", "resume"),
            stopped: ("stopped", "restart"), failed: ("failed", "resume"),
        }
        for task_id, state in expected.items():
            task = tasks[str(task_id)]
            self.assertEqual((task["status"], task["action"]), state)

    def test_deleted_sources_are_rechecked_on_each_read(self) -> None:
        source_id = self._source()
        import_task = self._task(source_id=source_id)
        observation_contact = self._contact()
        observation_id = self._observation(observation_contact)
        observation_task = self._task(contact_id=observation_contact, task_type="observation")
        initial = self.store.read(owner_id=self.owner_id)
        self.assertTrue(all(task["action"] == "resume" for task in initial["tasks"]))
        self.connection.execute(
            "UPDATE public.source_document SET status='delete_requested' WHERE id=%s", (source_id,),
        )
        self.connection.execute(
            "DELETE FROM public.local_wechat_observation WHERE id=%s", (observation_id,),
        )
        after = self.store.read(owner_id=self.owner_id)
        self.assertEqual(
            {task["task_id"] for task in after["tasks"]},
            {str(import_task), str(observation_task)},
        )
        self.assertTrue(all(task["reason_code"] == "source_unavailable" for task in after["tasks"]))
        self.assertTrue(all(task["action"] is None for task in after["tasks"]))
        self.connection.execute("DELETE FROM public.source_document WHERE id=%s", (source_id,))
        self.assertEqual(
            [task["task_id"] for task in self.store.read(owner_id=self.owner_id)["tasks"]],
            [str(observation_task)],
        )

    def test_read_preserves_empty_unplanned_and_persisted_progress_without_writes(self) -> None:
        source_id = self._source()
        unplanned = self._task(source_id=source_id)
        empty = self._task(source_id=self._source())
        completed = self._task(source_id=self._source(), status="succeeded")
        unknown = self._task(source_id=self._source(), status="succeeded")
        for task_id in (empty, completed, unknown):
            self.connection.execute(
                "INSERT INTO public.memory_processing_plan(task_id,owner_id,contact_id,updated_at) "
                "VALUES (%s,%s,%s,%s)",
                (task_id, self.owner_id, self.contact_id, FIXED_TIME),
            )
        for task_id, outcomes in (
            (completed, ("succeeded", "skipped", "unknown", None)),
            (unknown, ("unknown",)),
        ):
            for outcome in outcomes:
                message_id = uuid4()
                self.connection.execute(
                    "INSERT INTO public.message "
                    "(id,owner_id,contact_id,speaker,message_type,text_content) "
                    "VALUES (%s,%s,%s,'contact','text','合成进度消息')",
                    (message_id, self.owner_id, self.contact_id),
                )
                self.connection.execute(
                    "INSERT INTO public.memory_processing_target "
                    "(task_id,message_id,owner_id,contact_id,completed_at,outcome) "
                    "VALUES (%s,%s,%s,%s,%s,%s)",
                    (task_id, message_id, self.owner_id, self.contact_id,
                     FIXED_TIME if outcome else None, outcome),
                )
                if outcome:
                    self.connection.execute(
                        "INSERT INTO public.memory_processing_receipt "
                        "(message_id,owner_id,contact_id,completed_at,outcome) "
                        "VALUES (%s,%s,%s,%s,%s)",
                        (message_id, self.owner_id, self.contact_id, FIXED_TIME, outcome),
                    )
        tables = ("background_task", "background_task_step", "memory_processing_plan",
                  "memory_processing_target", "memory_processing_receipt", "message")

        def snapshot():
            return {
                table: self.connection.execute(
                    sql.SQL("SELECT to_jsonb(r) FROM public.{} r WHERE {} "
                            "ORDER BY to_jsonb(r)::text").format(
                        sql.Identifier(table),
                        sql.SQL("task_id IN (SELECT id FROM public.background_task "
                                "WHERE owner_id=%s)")
                        if table == "background_task_step" else sql.SQL("owner_id=%s"),
                    ),
                    (self.owner_id,),
                ).fetchall()
                for table in tables
            }

        before = snapshot()
        payload, statements = self._read_traced(contact_id=self.contact_id)
        self.assertEqual(snapshot(), before)
        self.assertEqual(
            self.store.read(owner_id=self.owner_id, contact_id=self.contact_id), payload,
        )
        self.assertEqual(snapshot(), before)
        self.assertTrue(any("SET TRANSACTION READ ONLY" in statement for statement in statements))
        tasks = {task["task_id"]: task for task in payload["tasks"]}
        self.assertIsNone(tasks[str(unplanned)]["processed_count"])
        self.assertIsNone(tasks[str(unplanned)]["total_count"])
        for task_id, counts in ((empty, (0, 0)), (completed, (3, 4))):
            task = tasks[str(task_id)]
            self.assertEqual((task["processed_count"], task["total_count"]), counts)
        self.assertEqual(tasks[str(completed)]["reason_code"], "batches_skipped")
        self.assertEqual(tasks[str(unknown)]["reason_code"], "processing_outcome_unknown")
        self.assertEqual(datetime.fromisoformat(tasks[str(completed)]["updated_at"]), FIXED_TIME)
