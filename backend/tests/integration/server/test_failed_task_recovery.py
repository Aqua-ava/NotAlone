"""通过公开 HTTP/CLI 验证失败原任务的显式恢复。

自建并清理专用测试库，夹具仅含合成资料；只有外部模型返回被脚本化。
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.application.import_service import ImportService, TaskHost
from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.contact_memory_index import PostgresContactMemoryIndexRepository
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.persistence.locks import (
    release_global_worker_lock, try_acquire_global_worker_lock,
)
from notalone.server.app import create_app
from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner
from notalone.tasks.command import worker_main
from tests.integration.server.core_business_flow_support import (
    ROOT, HttpBackend, ScriptedCoreModel, tool_response,
)


class RecoverableModel(ScriptedCoreModel):
    """脚本化外部服务暂时不可用，恢复后返回合法的空提取结果。"""

    unavailable: bool = True

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.unavailable:
            raise RuntimeError("合成模型暂时不可用。")
        tools = kwargs.get("tools", [])
        if tools and tools[0]["function"]["name"] == "DirectMemoryExtractionOutput":
            # 默认 CLI 已使用直接提取；空结果仍经真实任务重试与完成路径。
            self.responses[len(self.seen_calls)] = tool_response("DirectMemoryExtractionOutput", {"scenes": []})
        elif tools and tools[0]["function"]["name"] == "GroundedMemoryLabels":
            # 显式历史协议保留原非记忆标签夹具。
            schema = tools[0]["function"]["parameters"]["properties"]["units"]["properties"]
            labels = {unit: {"kind": "not_memory", "subject": "contact", "topic": "other",
                "dependency": None, "unresolved": False, "confidence": 0.95,
                "sensitivity": "none", **({"event": None} if "event" in item["properties"] else {})}
                for unit, item in schema.items()}
            self.responses[len(self.seen_calls)] = tool_response("GroundedMemoryLabels", {"units": labels})
        return super()._generate(messages, stop, run_manager, **kwargs)


class FailedTaskRecoveryHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database_name = f"notalone_task_recovery_{uuid4().hex}_test"
        cls.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        cls.addClassCleanup(cls.admin.close)
        cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(cls.database_name),
        ))
        cls.addClassCleanup(cls._drop_database)
        cls.database_url = f"host=/tmp dbname={cls.database_name}"
        env = dict(os.environ)
        env.update({"NOTALONE_DISABLE_DOTENV": "1",
                    "NOTALONE_DATABASE_URL": cls.database_url})
        migration = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations",
             str(ROOT / "database/migrations")],
            cwd=ROOT, env=env, text=True, capture_output=True, timeout=60,
        )
        if migration.returncode:
            raise RuntimeError(f"恢复测试库迁移失败：{migration.stderr}")

    @classmethod
    def _drop_database(cls) -> None:
        cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
            sql.Identifier(cls.database_name),
        ))

    def setUp(self) -> None:
        self.owner_id, self.other_owner_id = uuid4(), uuid4()
        self.model = RecoverableModel()
        self.contact_locators: dict[str, str] = {}
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.lock_connections: list[psycopg.Connection] = []
        self.addCleanup(self._close_connections)
        with psycopg.connect(self.database_url) as connection:
            for owner_id in (self.owner_id, self.other_owner_id):
                connection.execute(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (owner_id, "恢复测试合成用户"),
                )
                connection.execute(
                    "INSERT INTO public.skill_library (owner_id, revision) VALUES (%s, 0)",
                    (owner_id,),
                )
        self.backend = self._backend(self.owner_id)
        # 无模型宿主的真实 HTTP 服务只准备旧队列，恢复由当前宿主显式执行。
        self.queued_backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=self.owner_id,
            token=f"synthetic-queued-{self.owner_id}",
            import_service=ImportService(repository=PostgresIngestRepository(self.database_url)),
        ), self.owner_id)
        self.addCleanup(self.queued_backend.close)

    def _close_connections(self) -> None:
        for connection in self.lock_connections:
            connection.close()

    def _backend(self, owner_id: UUID) -> HttpBackend:
        def lock_connection():
            connection = psycopg.connect(self.database_url, autocommit=True)
            self.lock_connections.append(connection)
            return connection

        extraction = PostgresMemoryExtractionRunner(
            self.database_url, runtime=LangChainExtractionRuntime(model=self.model),
            provider="synthetic", model_name="scripted-recovery-test",
            # 本用例只替换模型边界、保留真实采纳链路，因此显式放行全部维度；
            # 默认收紧（空放行表）由 tests/unit/memory_extraction/test_adoption.py 覆盖。
            dimension_release=RELEASE_ALL_DIMENSIONS,
        )
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-recovery-{owner_id}",
            import_service=ImportService(repository=PostgresIngestRepository(self.database_url)),
            task_host=TaskHost(
                worker_builder=lambda: BackgroundTaskWorker(
                    repository=PostgresBackgroundTaskRepository(self.database_url),
                    extraction_runner=extraction,
                    index_repository=PostgresContactMemoryIndexRepository(self.database_url),
                    deletion_repository=PostgresSourceDeletionRepository(self.database_url),
                ),
                lock_connection_builder=lock_connection,
                event_publisher=lambda update: None,
                task_repository=PostgresBackgroundTaskRepository(self.database_url),
            ),
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def _import(
        self, *, contact_id: str | None = None, backend: HttpBackend | None = None,
    ) -> dict[str, Any]:
        locator = (self.contact_locators[contact_id] if contact_id else
                   f"wxid_synthetic_{uuid4().hex}")
        nonce = uuid4().hex
        local_offset = int(nonce[:8], 16) * 10
        path = Path(self.temporary.name) / f"{nonce}.jsonl"
        records = [{
            "id": {"local_id": local_offset + number, "server_id_str": f"{nonce}-{number}",
                   "talker": locator},
            "create_time": 1786500000 + 60 * number,
            "is_from_me": from_me, "kind": "text",
            "sender": "合成用户" if from_me else "合成联系人",
            "sender_wxid": f"wxid_owner_{self.owner_id}" if from_me else locator,
            "text": text, "time": f"2026-08-12 10:0{number}:00",
            "time_iso": f"2026-08-12T10:0{number}:00+08:00",
        } for number, from_me, text in (
            (1, False, "这是一条恢复测试合成消息。"),
            (2, True, "好的。"),
        )]
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records),
                        encoding="utf-8")
        payload = {"path": str(path)}
        if contact_id is None:
            payload["new_contact_name"] = "恢复测试合成联系人"
        else:
            payload["contact_id"] = contact_id
        status, imported = (backend or self.queued_backend).request(
            "/api/imports/commit", payload,
        )
        self.assertEqual(status, 200, imported)
        self.contact_locators[imported["contact_id"]] = locator
        imported["path"] = str(path)
        return imported

    def _task(self, imported: dict[str, Any], *, backend=None) -> dict[str, Any]:
        status, task = (backend or self.backend).request(
            f"/api/tasks/status?contact_id={imported['contact_id']}&task_id={imported['task_id']}",
        )
        self.assertEqual(status, 200, task)
        return task

    def _wait(self, imported: dict[str, Any], expected: str) -> dict[str, Any]:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            task = self._task(imported)
            if task["status"] == expected:
                return task
            time.sleep(0.03)
        self.fail(f"任务未达到预期状态 {expected}：{task}")

    def _fail_import(self) -> dict[str, Any]:
        imported = self._import(backend=self.backend)
        self.assertIn("task_id", imported, "导入提交必须返回原后台任务身份。")
        status, started = self.backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        })
        self.assertEqual(status, 200, started)
        self.assertIn(started["status"], {"started", "busy"})
        failed = self._wait(imported, "failed")
        self.assertEqual(failed["retry_count"], 3)
        self.assertEqual([(step["name"], step["status"], step["attempt_count"])
                          for step in failed["steps"][:3]],
                         [("parse", "succeeded", 1), ("normalize", "succeeded", 1),
                          ("extract_memory", "failed", 3)])
        # 持久失败先于宿主线程收尾；确保下一次恢复确实可以取得执行范围。
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, host = self.backend.request(
                f"/api/tasks/status?contact_id={imported['contact_id']}",
            )
            self.assertEqual(status, 200, host)
            if host["status"] == "finished":
                break
            time.sleep(0.02)
        self.assertEqual(host["status"], "finished", host)
        return imported

    def test_http_recovers_original_failed_task_and_skips_successful_steps(self) -> None:
        imported = self._fail_import()
        original = self._task(imported)
        # 以公开接口补交较早的来源，夹具调整创建时间以复现任务排队顺序。
        waiting = self._import(contact_id=imported["contact_id"])
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.background_task SET created_at = now() - interval '1 day' WHERE id = %s",
                (UUID(waiting["task_id"]),),
            )
        status, recovered = self.backend.request("/api/tasks/retry", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        })
        self.assertEqual((status, recovered),
                         (200, {"task_id": imported["task_id"], "status": "queued"}))
        self.assertEqual(self._task(imported)["retry_count"], 4)
        self.model.unavailable = False
        self.model.responses.append(tool_response("MemoryExtractionOutput", {"facts": []}))
        status, started = self.backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        })
        self.assertEqual((status, started), (200, {"status": "started"}))
        completed = self._wait(imported, "succeeded")
        self.assertEqual(completed["task_id"], original["task_id"])
        self.assertEqual([step["attempt_count"] for step in completed["steps"]], [1, 1, 1, 1, 1])
        self.assertEqual(self._task(waiting)["status"], "queued")

    def test_import_recovery_rejects_sources_in_deletion_path(self) -> None:
        imported = self._fail_import()
        status, sources = self.backend.request(
            f"/api/contacts/{imported['contact_id']}/sources",
        )
        self.assertEqual(status, 200, sources)
        source_id = UUID(sources["sources"][0]["source_id"])
        for source_status in ("delete_requested", "deleting", "delete_failed"):
            with self.subTest(source_status=source_status):
                # 状态夹具模拟删除在各阶段停下，业务断言仍从 HTTP 读取。
                with psycopg.connect(self.database_url) as connection:
                    connection.execute("UPDATE public.source_document SET status = %s WHERE id = %s",
                                       (source_status, source_id))
                self.assertEqual(self.backend.request("/api/tasks/retry", {
                    "contact_id": imported["contact_id"], "task_id": imported["task_id"],
                }), (409, {"error": "task_retry_conflict"}))
                task = self._task(imported)
                self.assertEqual(task["status"], "failed")
                self.assertEqual(task["retry_count"], 3)
                self.assertEqual(task["steps"][2]["attempt_count"], 3)
        # deleted 必须由真实删除产生，不能用状态更新冒充正文已清除。
        status, deletion = self.backend.request(
            f"/api/contacts/{imported['contact_id']}/sources/{source_id}", method="DELETE",
        )
        self.assertEqual(status, 202, deletion)
        self._wait({**imported, "task_id": deletion["task_id"]}, "succeeded")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.background_task SET status = 'failed' WHERE id = %s",
                               (UUID(imported["task_id"]),))
        self.assertEqual(self.backend.request("/api/tasks/retry", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (409, {"error": "task_retry_conflict"}))

    def _cli(self, imported: dict[str, Any], *, model_error=False) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        factory_options = {"side_effect": RuntimeError("合成模型配置不可用。")}
        if not model_error:
            factory_options = {"return_value": self.model}
        with patch.dict(os.environ, {
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.owner_id),
        }), patch("notalone.memory_extraction.cli_support.build_deepseek_model", **factory_options), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = worker_main(["--contact-id", imported["contact_id"],
                                "--retry-task-id", imported["task_id"]])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_cli_recovers_failed_original_task_through_public_command(self) -> None:
        imported = self._fail_import()
        waiting = self._import(contact_id=imported["contact_id"])
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.background_task SET created_at = now() - interval '1 day' WHERE id = %s",
                (UUID(waiting["task_id"]),),
            )
        self.model.unavailable = False
        self.model.responses.append(tool_response("MemoryExtractionOutput", {"facts": []}))
        code, stdout, stderr = self._cli(imported)
        self.assertEqual(code, 0, stdout + stderr)
        self.assertIn("status=succeeded", stdout)
        self.assertIn("steps=3", stdout)
        task = self._task(imported)
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(task["retry_count"], 4)
        self.assertEqual([step["attempt_count"] for step in task["steps"]], [1, 1, 1, 1, 1])
        self.assertEqual(self._task(waiting)["status"], "queued")

    def test_cli_precheck_and_global_busy_preserve_failed_task(self) -> None:
        imported = self._fail_import()
        before = self._task(imported)
        code, stdout, stderr = self._cli(imported, model_error=True)
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("Worker 准备失败", stderr)
        self.assertEqual(self._task(imported), before)
        with psycopg.connect(self.database_url, autocommit=True) as holder:
            self.assertTrue(try_acquire_global_worker_lock(holder))
            try:
                code, stdout, stderr = self._cli(imported)
            finally:
                release_global_worker_lock(holder)
        self.assertEqual((code, stderr), (0, ""))
        self.assertIn("status=busy", stdout)
        self.assertEqual(self._task(imported), before)

    def test_http_recovery_is_scoped_and_durable_across_host_restart(self) -> None:
        imported = self._fail_import()
        before = self._task(imported)
        # 不装配任务宿主也能读取/恢复持久任务，且不会隐式执行。
        reopened = HttpBackend(create_app(
            database_url=self.database_url, owner_id=self.owner_id,
            token=f"synthetic-reopened-{self.owner_id}",
        ), self.owner_id)
        self.addCleanup(reopened.close)
        self.assertEqual(self._task(imported, backend=reopened), before)
        status, progress = self.backend.request(
            f"/api/tasks/status?contact_id={imported['contact_id']}",
        )
        self.assertEqual(status, 200, progress)
        self.assertEqual(progress["progress"]["task_id"], imported["task_id"])
        other_backend = self._backend(self.other_owner_id)
        other_contact = self._import()
        for backend, contact_id, task_id in (
            (other_backend, imported["contact_id"], imported["task_id"]),
            (self.backend, other_contact["contact_id"], imported["task_id"]),
            (self.backend, imported["contact_id"], str(uuid4())),
        ):
            with self.subTest(contact_id=contact_id, task_id=task_id):
                payload = {"contact_id": contact_id, "task_id": task_id}
                for path in ("/api/tasks/retry", "/api/tasks/run"):
                    self.assertEqual(backend.request(path, payload),
                                     (404, {"error": "task_not_found"}))
                self.assertEqual(backend.request(
                    f"/api/tasks/status?contact_id={contact_id}&task_id={task_id}",
                ), (404, {"error": "task_not_found"}))
        self.assertEqual(self._task(imported), before)
        self.assertEqual(other_backend.request(
            f"/api/tasks/status?contact_id={imported['contact_id']}",
        ), (200, {"status": "idle", "progress": None}))
        self.assertEqual(reopened.request("/api/tasks/retry", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (200, {"task_id": imported["task_id"], "status": "queued"}))
        self.assertEqual(self._task(imported)["status"], "queued")

    def test_nonfailed_tasks_are_not_recovered(self) -> None:
        imported = self._import()
        for task_status in ("queued", "running", "verifying", "succeeded", "cancelled"):
            with self.subTest(task_status=task_status):
                with psycopg.connect(self.database_url) as connection:
                    connection.execute("UPDATE public.background_task SET status = %s WHERE id = %s",
                                       (task_status, UUID(imported["task_id"])))
                before = self._task(imported)
                self.assertEqual(self.backend.request("/api/tasks/retry", {
                    "contact_id": imported["contact_id"], "task_id": imported["task_id"],
                }), (409, {"error": "task_retry_conflict"}))
                self.assertEqual(self._task(imported), before)

    def test_manual_recovery_has_three_attempts_in_each_round(self) -> None:
        imported = self._fail_import()
        self.assertEqual(self.backend.request("/api/tasks/retry", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (200, {"task_id": imported["task_id"], "status": "queued"}))
        self.assertEqual(self._task(imported)["steps"][2]["attempt_count"], 0)
        status, started = self.backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        })
        self.assertEqual((status, started), (200, {"status": "started"}))
        failed_again = self._wait(imported, "failed")
        self.assertEqual(failed_again["retry_count"], 7)
        self.assertEqual([step["attempt_count"] for step in failed_again["steps"]], [1, 1, 3, 0, 0])

    def test_cli_rejects_wrong_contact_missing_and_nonfailed_tasks(self) -> None:
        imported = self._fail_import()
        before = self._task(imported)
        other = self._import()
        for target, error_code in (
            ({**imported, "contact_id": other["contact_id"]}, "task_not_found"),
            ({**imported, "task_id": str(uuid4())}, "task_not_found"),
            (other, "task_retry_conflict"),
        ):
            with self.subTest(error_code=error_code):
                code, stdout, stderr = self._cli(target)
                self.assertEqual(code, 2)
                self.assertEqual(stdout, "")
                self.assertIn(error_code, stderr)
        self.assertEqual(self._task(imported), before)

    def test_failed_delete_verification_recovers_after_actual_source_deletion(self) -> None:
        imported = self._import()
        status, sources = self.backend.request(
            f"/api/contacts/{imported['contact_id']}/sources",
        )
        self.assertEqual(status, 200, sources)
        source_id = sources["sources"][0]["source_id"]
        status, deletion = self.backend.request(
            f"/api/contacts/{imported['contact_id']}/sources/{source_id}", method="DELETE",
        )
        self.assertEqual(status, 202, deletion)
        deletion_task = {**imported, "task_id": deletion["task_id"]}
        self._wait(deletion_task, "succeeded")
        # 正文已由真实删除清除，模拟随后的确定性验证失败，保留四个成功步骤。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.background_task SET status = 'failed', current_step = 'verify_not_retrievable', "
                "retry_count = 1, last_error_code = 'source_delete_failed' WHERE id = %s",
                (UUID(deletion["task_id"]),),
            )
            connection.execute(
                "UPDATE public.background_task_step SET status = 'failed', "
                "last_error_code = 'source_delete_failed' WHERE task_id = %s AND step_name = 'verify_not_retrievable'",
                (UUID(deletion["task_id"]),),
            )
        self.assertEqual(self.backend.request("/api/tasks/retry", {
            "contact_id": imported["contact_id"], "task_id": deletion["task_id"],
        }), (200, {"task_id": deletion["task_id"], "status": "queued"}))
        self.assertEqual(self._task(deletion_task)["steps"][-1]["attempt_count"], 0)
        status, started = self.backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": deletion["task_id"],
        })
        self.assertEqual((status, started), (200, {"status": "started"}))
        completed = self._wait(deletion_task, "succeeded")
        self.assertEqual(completed["retry_count"], 2)
        self.assertEqual([step["attempt_count"] for step in completed["steps"]], [1, 1, 1, 1, 1])
        status, messages = self.backend.request(f"/api/contacts/{imported['contact_id']}/messages")
        self.assertEqual((status, messages["messages"]), (200, []))
        status, sources = self.backend.request(f"/api/contacts/{imported['contact_id']}/sources")
        self.assertEqual(status, 200, sources)
        self.assertEqual(sources["sources"][0]["status"], "deleted")

    def test_task_requests_reject_malformed_identity(self) -> None:
        imported = self._import()
        for task_id in (None, "", "invalid-task", 42):
            with self.subTest(task_id=task_id):
                self.assertEqual(self.backend.request("/api/tasks/retry", {
                    "contact_id": imported["contact_id"], "task_id": task_id,
                }), (400, {"error": "import_request_invalid"}))
        for suffix in ("task_id=", "task_id=invalid-task",
                       f"task_id={imported['task_id']}&task_id="):
            with self.subTest(query=suffix):
                self.assertEqual(self.backend.request(
                    f"/api/tasks/status?contact_id={imported['contact_id']}&{suffix}",
                ), (400, {"error": "import_request_invalid"}))


if __name__ == "__main__":
    unittest.main()
