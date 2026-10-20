"""公开 HTTP 验证真实进度、中断投影和显式恢复；仅使用合成资料。"""

from tests.integration.server.test_failed_task_recovery import TaskRecoveryHttpFixture
from tests.integration.server.core_business_flow_support import tool_response
import psycopg
from uuid import UUID


class MemoryProcessingProgressHttpTest(TaskRecoveryHttpFixture):
    def test_progress_read_is_inert_and_resume_survives_host_restart(self):
        imported = self._import()
        route = f"/api/contacts/{imported['contact_id']}/memory-processing"
        status, payload = self.backend.request(route)
        self.assertEqual(status, 200, payload)
        task = payload["tasks"][0]
        self.assertEqual(task["status"], "interrupted")
        self.assertEqual(task["action"], "resume")
        self.assertIsNone(task["total_count"])
        self.assertEqual(self._task(imported)["status"], "queued")
        self.assertEqual(len(self.model.seen_calls), 0)
        self.model.unavailable = False
        self.model.responses.extend(
            [tool_response("MemoryExtractionOutput", {"facts": []})] * 20
        )
        status, result = self.backend.request(
            route + "/resume", {"task_id": imported["task_id"], "action": "resume"}
        )
        self.assertEqual(status, 200, result)
        self._wait(imported, "succeeded")
        status, payload = self.backend.request(route)
        self.assertEqual(payload["tasks"][0]["status"], "completed")
        self.assertEqual(payload["tasks"][0]["processed_count"], 2)
        self.assertEqual(payload["tasks"][0]["total_count"], 2)
        status, owner = self.backend.request("/api/owner/memory-processing")
        self.assertEqual(status, 200, owner)
        self.assertEqual(owner["scope"], "owner")
        self.assertEqual(owner["tasks"][0]["contact_id"], imported["contact_id"])

    def test_restart_is_explicit_scoped_and_rejects_deleted_source(self):
        imported = self._import()
        other = self._import()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.background_task SET status='cancelled' WHERE id=%s",
                (imported["task_id"],),
            )
            connection.execute(
                "UPDATE public.background_task_step SET status='cancelled' WHERE task_id=%s",
                (imported["task_id"],),
            )
        route = f"/api/contacts/{imported['contact_id']}/memory-processing"
        status, payload = self.backend.request(route)
        self.assertEqual(payload["tasks"][0]["status"], "stopped")
        self.assertEqual(payload["tasks"][0]["action"], "restart")
        status, payload = self.backend.request(
            route + "/resume", {"task_id": imported["task_id"], "action": "resume"}
        )
        self.assertEqual(status, 409, payload)
        status, payload = self.backend.request(
            f"/api/contacts/{other['contact_id']}/memory-processing/resume",
            {"task_id": imported["task_id"], "action": "restart"},
        )
        self.assertEqual(status, 404, payload)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.source_document SET status='delete_requested' WHERE id=(SELECT source_document_id FROM public.background_task WHERE id=%s)",
                (imported["task_id"],),
            )
        status, payload = self.backend.request(
            route + "/resume", {"task_id": imported["task_id"], "action": "restart"}
        )
        self.assertEqual(status, 409, payload)
        status, payload = self.backend.request(route)
        self.assertIsNone(payload["tasks"][0]["action"])
        self.assertEqual(payload["tasks"][0]["reason_code"], "source_unavailable")
        self.assertEqual(len(self.model.seen_calls), 0)

    def test_restart_uses_only_original_source_and_repeated_click_is_idempotent(self):
        imported = self._import()
        waiting = self._import(contact_id=imported["contact_id"])
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.background_task SET status='cancelled' WHERE id=%s",
                (imported["task_id"],),
            )
            connection.execute(
                "UPDATE public.background_task_step SET status='cancelled' WHERE task_id=%s",
                (imported["task_id"],),
            )
        self.model.unavailable = False
        self.model.responses.extend(
            [tool_response("MemoryExtractionOutput", {"facts": []})] * 20
        )
        route = f"/api/contacts/{imported['contact_id']}/memory-processing/resume"
        status, payload = self.backend.request(
            route, {"task_id": imported["task_id"], "action": "restart"}
        )
        self.assertEqual(status, 200, payload)
        status, payload = self.backend.request(
            route, {"task_id": imported["task_id"], "action": "restart"}
        )
        self.assertEqual(status, 200, payload)
        self._wait(imported, "succeeded")
        self.assertEqual(self._task(waiting)["status"], "queued")
        status, payload = self.backend.request(route.removesuffix("/resume"))
        item = next(
            row for row in payload["tasks"] if row["task_id"] == imported["task_id"]
        )
        self.assertEqual(item["total_count"], 2)
        self.assertEqual(item["processed_count"], 2)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_completed_batches_survive_failure_and_resume_keeps_context(self):
        import json
        from pathlib import Path
        from unittest.mock import patch
        from tests.integration.server.test_failed_task_recovery import RecoverableModel

        original = self._import()
        records = [
            json.loads(line) for line in Path(original["path"]).read_text().splitlines()
        ]
        many = []
        for number in range(42):
            row = dict(records[number % 2])
            row["id"] = {
                **row["id"],
                "local_id": 900000 + number,
                "server_id_str": f"progress-many-{self.owner_id}-{number}",
            }
            row["time_iso"] = f"2026-08-13T10:{number:02d}:00+08:00"
            row["create_time"] = 1786586400 + number * 60
            many.append(row)
        path = Path(self.temporary.name) / "progress-many.jsonl"
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in many))
        status, imported = self.queued_backend.request(
            "/api/imports/commit",
            {"path": str(path), "contact_id": original["contact_id"]},
        )
        self.assertEqual(status, 200, imported)
        # 从原始导入来源独立确定目标，不用待测进度表构造期望。
        with psycopg.connect(self.database_url) as connection:
            expected_target_ids = {
                str(row[0])
                for row in connection.execute(
                    "SELECT DISTINCT ref.message_id FROM public.message_source_ref ref "
                    "JOIN public.background_task task ON "
                    "task.source_document_id=ref.source_document_id AND "
                    "task.owner_id=ref.owner_id AND task.contact_id=ref.contact_id "
                    "WHERE task.id=%s AND task.owner_id=%s AND task.contact_id=%s",
                    (imported["task_id"], self.owner_id, imported["contact_id"]),
                ).fetchall()
            }
        self.assertEqual(len(expected_target_ids), 42)
        self.model.unavailable = False
        self.model.responses.extend(
            [tool_response("MemoryExtractionOutput", {"facts": []})] * 20
        )
        generate = RecoverableModel._generate

        def stop_after_first(model, *args, **kwargs):
            if len(model.seen_calls) >= 1:
                raise RuntimeError("合成服务中断")
            return generate(model, *args, **kwargs)

        route = f"/api/contacts/{imported['contact_id']}/memory-processing"
        with patch.object(RecoverableModel, "_generate", stop_after_first):
            status, payload = self.backend.request(
                route + "/resume", {"task_id": imported["task_id"], "action": "resume"}
            )
            self.assertEqual(status, 200, payload)
            self._wait(imported, "failed")
        status, payload = self.backend.request(route)
        task = next(
            item for item in payload["tasks"] if item["task_id"] == imported["task_id"]
        )
        self.assertEqual((task["processed_count"], task["total_count"]), (10, 42))
        # 新建宿主读取同一数据库；GET 仍显示原来的批次进度。
        restarted = self._backend(self.owner_id)
        status, payload = restarted.request(route)
        task = next(
            item for item in payload["tasks"] if item["task_id"] == imported["task_id"]
        )
        self.assertEqual(task["processed_count"], 10)
        status, payload = restarted.request(
            route + "/resume", {"task_id": imported["task_id"], "action": "resume"}
        )
        self.assertEqual(status, 200, payload)
        self._wait(imported, "succeeded")
        status, payload = restarted.request(route)
        task = next(
            item for item in payload["tasks"] if item["task_id"] == imported["task_id"]
        )
        self.assertEqual((task["processed_count"], task["total_count"]), (42, 42))
        self.assertEqual(len(self.model.seen_calls), 5)
        with psycopg.connect(self.database_url) as connection:
            windows = connection.execute(
                "SELECT e.payload FROM public.memory_extraction_trace_event e JOIN public.memory_extraction_trace t ON t.trace_id=e.trace_id WHERE e.owner_id=%s AND e.stage='window' AND e.payload->'task_runtime'->>'task_id'=%s AND t.status='succeeded' ORDER BY t.started_at",
                (self.owner_id, imported["task_id"]),
            ).fetchall()
        self.assertEqual(len(windows), 5)
        self.assertEqual(windows[1][0]["context_before_count"], 5)
        self.assertEqual(
            [window[0]["target_count"] for window in windows], [10, 10, 10, 10, 2]
        )
        self.assertEqual(
            [len(window[0]["target_message_ids"]) for window in windows],
            [10, 10, 10, 10, 2],
        )
        target_ids = [
            message_id
            for window in windows
            for message_id in window[0]["target_message_ids"]
        ]
        self.assertEqual(len(target_ids), 42)
        self.assertEqual(set(target_ids), expected_target_ids)
        first_ids = set(windows[0][0]["target_message_ids"])
        self.assertFalse(first_ids.intersection(windows[1][0]["target_message_ids"]))


class MemoryProcessingUpgradeHttpTest(TaskRecoveryHttpFixture):
    @classmethod
    def setUpClass(cls):
        import tempfile
        from pathlib import Path
        from tests.integration.server.core_business_flow_support import ROOT

        cls.old_migrations = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.old_migrations.cleanup)
        cls.migrations_directory = Path(cls.old_migrations.name)
        for migration in (ROOT / "database/migrations").glob("*.sql"):
            if int(migration.name.split("_", 1)[0]) <= 90:
                (cls.migrations_directory / migration.name).symlink_to(migration)
        super().setUpClass()

    def test_initial_schema_upgrade_preserves_progress_and_source_deletion_cascades(
        self,
    ):
        import os
        import subprocess
        import sys
        from tests.integration.server.core_business_flow_support import ROOT

        imported = self._import()
        with psycopg.connect(self.database_url) as connection:
            messages = connection.execute(
                "SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s ORDER BY id",
                (self.owner_id, imported["contact_id"]),
            ).fetchall()
            connection.execute(
                "INSERT INTO public.memory_processing_plan(task_id) VALUES (%s)",
                (imported["task_id"],),
            )
            for index, (message_id,) in enumerate(messages):
                connection.execute(
                    "INSERT INTO public.memory_processing_target(task_id,message_id,completed_at) VALUES (%s,%s,CASE WHEN %s THEN now() ELSE NULL END)",
                    (imported["task_id"], message_id, index == 0),
                )
            connection.execute(
                "INSERT INTO public.memory_processing_receipt(message_id) VALUES (%s)",
                (messages[0][0],),
            )
        env = {
            **os.environ,
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_DATABASE_URL": self.database_url,
        }
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "notalone.database_migrations",
                "--migrations",
                str(ROOT / "database/migrations"),
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        status, payload = self.backend.request(
            f"/api/contacts/{imported['contact_id']}/memory-processing"
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(
            (
                payload["tasks"][0]["processed_count"],
                payload["tasks"][0]["total_count"],
            ),
            (1, 2),
        )
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute(
                "SELECT owner_id,contact_id,outcome FROM public.memory_processing_receipt WHERE message_id=%s",
                (messages[0][0],),
            ).fetchone()
            self.assertEqual(
                row, (self.owner_id, UUID(imported["contact_id"]), "unknown")
            )
            source_id = connection.execute(
                "SELECT source_document_id FROM public.background_task WHERE id=%s",
                (imported["task_id"],),
            ).fetchone()[0]
        status, deletion = self.backend.request(
            f"/api/contacts/{imported['contact_id']}/sources/{source_id}",
            method="DELETE",
        )
        self.assertEqual(status, 202, deletion)
        self._wait({**imported, "task_id": deletion["task_id"]}, "succeeded")
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM public.memory_processing_target WHERE task_id=%s",
                    (imported["task_id"],),
                ).fetchone()[0],
                0,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM public.memory_processing_receipt WHERE owner_id=%s",
                    (self.owner_id,),
                ).fetchone()[0],
                0,
            )
