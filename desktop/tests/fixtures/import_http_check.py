"""不启动桌面的真实 HTTP/PG 夹具自检，不能替代 App 验收。"""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time
import unittest
from uuid import uuid4

import psycopg

from import_backend import DesktopImportFixture
from import_http_runner import run_import_http_suite


class ImportSubmissionHttpCheck(DesktopImportFixture):
    def task(self, imported):
        return self._get(self.backend, f"/api/tasks/status?contact_id={imported['contact_id']}"
                         f"&task_id={imported['task_id']}")

    def wait_task(self, imported, expected):
        deadline = time.monotonic() + 15
        task = {}
        while time.monotonic() < deadline:
            task = self.task(imported)
            if task["status"] == expected:
                return task
            time.sleep(0.02)
        self.fail(f"原任务未进入 {expected}：{task}")

    def import_file(self):
        path = self.synthetic_file()
        status, preview = self.backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        body = {"path": str(path), "new_contact_name": "HTTP合成导入联系人",
                "expected_content_sha256": preview["content_sha256"]}
        status, imported = self.backend.request("/api/imports/commit", body)
        self.assertEqual(status, 200, imported)
        return imported, body

    def test_atomic_first_import_replay_and_final_task_steps(self):
        path = self.synthetic_file()
        before = self._get(self.backend, "/api/contacts")
        status, rejected = self.backend.request("/api/imports/commit", {
            "path": str(path), "contact_id": str(uuid4()),
        })
        self.assertEqual((status, rejected), (409, {"error": "import_commit_failed"}))
        self.assertEqual(self._get(self.backend, "/api/contacts"), before)
        # 新本人渠道标识仍可确认，证明失败事务未留下首次身份。
        path.write_text(path.read_text(encoding="utf-8").replace(f"wxid_import_owner_{self.owner_id}", f"wxid_after_rollback_{self.owner_id}"), encoding="utf-8")
        status, preview = self.backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        body = {"path": str(path), "new_contact_name": "回滚后合成联系人",
                "expected_content_sha256": preview["content_sha256"]}
        status, first = self.backend.request("/api/imports/commit", body)
        self.assertEqual(status, 200, first)
        self.assertEqual(first["imported_count"], 6)
        status, repeated = self.backend.request("/api/imports/commit", {
            "path": body["path"], "contact_id": first["contact_id"],
            "expected_content_sha256": body["expected_content_sha256"],
        })
        self.assertEqual(status, 200, repeated)
        self.assertEqual((repeated["contact_id"], repeated["task_id"], repeated["skipped_duplicates"]),
                         (first["contact_id"], first["task_id"], 6))
        task = self.wait_task(first, "succeeded")
        self.assertEqual([step["name"] for step in task["steps"]], ["parse", "normalize", "extract_memory", "index", "verify"])
        self.assertTrue(all(step["status"] == "succeeded" for step in task["steps"]))
        self.assertEqual(len(self._get(self.backend, f"/api/contacts/{first['contact_id']}/sources")["sources"]), 1)
        self.assertEqual(len(self._get(self.backend, f"/api/contacts/{first['contact_id']}/messages")["messages"]), 6)
        self.assertEqual(self.other_backend.request(
            f"/api/tasks/status?contact_id={first['contact_id']}&task_id={first['task_id']}"),
            (404, {"error": "task_not_found"}))

    def test_preview_content_change_is_rejected_before_data_writes(self):
        path = self.synthetic_file()
        status, preview = self.backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        before = self._get(self.backend, "/api/contacts")
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        rows[0]["text"] = "预览后变动的合成内容。"
        path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        self.assertEqual(self.backend.request("/api/imports/commit", {
            "path": str(path), "new_contact_name": "文件变动测试",
            "expected_content_sha256": preview["content_sha256"],
        }), (409, {"error": "import_file_changed"}))
        self.assertEqual(self._get(self.backend, "/api/contacts"), before)

    def test_original_failed_task_recovers_without_repeating_successful_steps(self):
        self.extraction_model.errors = {index: RuntimeError("合成模型不可用") for index in range(3)}
        imported, _ = self.import_file()
        failed = self.wait_task(imported, "failed")
        self.assertEqual(failed["error_code"], "memory_extraction_failed")
        self.assertEqual([step["attempt_count"] for step in failed["steps"][:3]], [1, 1, 3])
        self.assertEqual(self.backend.request("/api/tasks/retry", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (200, {"task_id": imported["task_id"], "status": "queued"}))
        self.assertEqual(self.task(imported)["status"], "queued")
        self.assertEqual(self.backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (200, {"status": "started"}))
        recovered = self.wait_task(imported, "succeeded")
        self.assertEqual(recovered["task_id"], failed["task_id"])
        self.assertEqual(recovered["steps"][:2], failed["steps"][:2])

    def test_same_new_contact_confirmation_replays_after_lost_response_and_concurrently(self):
        imported, body = self.import_file()
        status, repeated = self.backend.request("/api/imports/commit", body)
        contacts = self._get(self.backend, "/api/contacts")["contacts"]
        sources = self._get(self.backend, f"/api/contacts/{imported['contact_id']}/sources")["sources"]
        messages = self._get(self.backend, f"/api/contacts/{imported['contact_id']}/messages")["messages"]
        print(json.dumps({"same_body_replay": {"first_status": 200, "second_status": status,
              "second_result": repeated, "new_contact_count": len(contacts) - 2,
              "source_count": len(sources), "message_count": len(messages)}}), flush=True)
        self.assertEqual(status, 200, repeated)
        self.assertEqual((repeated["contact_id"], repeated["task_id"], repeated["skipped_duplicates"]),
                         (imported["contact_id"], imported["task_id"], 6))
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = [future.result(timeout=10) for future in [
                executor.submit(self.backend.request, "/api/imports/commit", body)
                for _ in range(2)
            ]]
        self.assertTrue(all(status == 200 and payload["task_id"] == imported["task_id"]
                            for status, payload in responses), responses)
        self.assertEqual((len(contacts), len(sources), len(messages)), (3, 1, 6))

    def test_concurrent_first_new_contact_confirmation_creates_once(self):
        path = self.synthetic_file()
        status, preview = self.backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        body = {"path": str(path), "new_contact_name": "同次并发新建",
                "expected_content_sha256": preview["content_sha256"]}
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda _: self.backend.request("/api/imports/commit", body), range(2)))
        self.assertEqual([status for status, _ in responses], [200, 200], responses)
        first, second = [payload for _, payload in responses]
        self.assertEqual((first["contact_id"], first["task_id"]), (second["contact_id"], second["task_id"]))
        self.assertEqual(sorted(payload["imported_count"] for _, payload in responses), [0, 6])
        self.assertEqual(len(self._get(self.backend, "/api/contacts")["contacts"]), 3)
        self.assertEqual(len(self._get(self.backend, f"/api/contacts/{first['contact_id']}/sources")["sources"]), 1)
        self.assertEqual(len(self._get(self.backend, f"/api/contacts/{first['contact_id']}/messages")["messages"]), 6)

    def import_counts(self):
        with psycopg.connect(self.database_url) as connection:
            return {table: connection.execute(f"SELECT count(*) FROM public.{table} WHERE owner_id = %s",
                                               (self.owner_id,)).fetchone()[0]
                    for table in ("contact", "channel_identity", "source_document", "import_confirmation", "message", "background_task")}

    def assert_replay_rejected(self, body, label):
        before = self.import_counts()
        result = self.backend.request("/api/imports/commit", body)
        self.assertEqual(result, (409, {"error": "import_commit_failed"}), label)
        self.assertEqual(self.import_counts(), before, label)
        print(json.dumps({"replay_guard": label, "status": result[0], "writes": 0}), flush=True)

    def test_new_contact_replay_guards_name_file_owner_source_and_identity(self):
        imported, body = self.import_file()
        self.wait_task(imported, "succeeded")
        self.assert_replay_rejected(dict(body, new_contact_name="变更后的名称"), "request_name_changed")
        changed = self.synthetic_file("different.jsonl")
        changed.write_text(changed.read_text(encoding="utf-8").replace("茉莉茶", "普洱茶"), encoding="utf-8")
        status, preview = self.backend.request("/api/imports/preview", {"path": str(changed)})
        self.assertEqual(status, 200, preview)
        self.assert_replay_rejected(dict(body, path=str(changed), expected_content_sha256=preview["content_sha256"]),
                                    "same_name_different_file")
        other_before = self._get(self.other_backend, "/api/contacts")
        self.assertEqual(self.other_backend.request("/api/imports/commit", body), (409, {"error": "import_commit_failed"}))
        self.assertEqual(self._get(self.other_backend, "/api/contacts"), other_before)
        print(json.dumps({"replay_guard": "other_owner", "status": 409, "writes": 0}), flush=True)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.contact SET display_name = '用户已改名' WHERE owner_id = %s AND id = %s",
                               (self.owner_id, imported["contact_id"]))
        self.assert_replay_rejected(body, "current_contact_name_changed")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.contact SET display_name = %s WHERE owner_id = %s AND id = %s",
                               (body["new_contact_name"], self.owner_id, imported["contact_id"]))
            connection.execute("UPDATE public.source_document SET status = 'delete_requested' WHERE owner_id = %s AND contact_id = %s",
                               (self.owner_id, imported["contact_id"]))
        self.assert_replay_rejected(body, "source_not_active")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status = 'active' WHERE owner_id = %s AND contact_id = %s",
                               (self.owner_id, imported["contact_id"]))
            connection.execute("UPDATE public.channel_identity SET status = 'revoked' WHERE owner_id = %s AND contact_id = %s",
                               (self.owner_id, imported["contact_id"]))
        self.assert_replay_rejected(body, "identity_revoked")

    def test_original_manual_select_never_becomes_new_contact_replay(self):
        path = self.synthetic_file()
        contact_id = self.contact_ids[0]
        status, imported = self.backend.request("/api/imports/commit", {"path": str(path), "contact_id": contact_id})
        self.assertEqual(status, 200, imported)
        self.wait_task(imported, "succeeded")
        status, preview = self.backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        self.assert_replay_rejected({"path": str(path), "new_contact_name": "合成联系人甲",
                                    "expected_content_sha256": preview["content_sha256"]}, "original_manual_select")

    def test_replay_rechecks_concurrent_source_and_identity_changes(self):
        imported, body = self.import_file()
        self.wait_task(imported, "succeeded")
        before = self.import_counts()
        for table, status in (("source_document", "delete_requested"), ("channel_identity", "revoked")):
            with self.subTest(table=table), psycopg.connect(self.database_url) as connection:
                # 只安排真实行锁与合法状态变动；业务结果仍观察公开 HTTP。
                connection.execute(f"UPDATE public.{table} SET status = %s WHERE owner_id = %s AND contact_id = %s",
                                   (status, self.owner_id, imported["contact_id"]))
                with ThreadPoolExecutor(max_workers=1) as executor:
                    pending = executor.submit(self.backend.request, "/api/imports/commit", body)
                    try:
                        time.sleep(0.2)
                        self.assertFalse(pending.done())
                    finally:
                        connection.commit()
                    self.assertEqual(pending.result(timeout=10), (409, {"error": "import_commit_failed"}))
                self.assertEqual(self.import_counts(), before)
                if table == "source_document":
                    connection.execute("UPDATE public.source_document SET status = 'active' WHERE owner_id = %s AND contact_id = %s",
                                       (self.owner_id, imported["contact_id"]))
                print(json.dumps({"concurrent_replay_guard": table, "status": 409, "writes": 0}), flush=True)

    def test_reply_during_import_holds_priority_and_keeps_draft_scope(self):
        active = self.extraction_model.block_call(0)
        following = self.extraction_model.block_call(1)
        reply_gate = self.reply_model.pause_next_response()
        imported, _ = self.import_file()
        self.assertTrue(active.entered.wait(5))
        self.assertEqual(self.task(imported)["status"], "running")
        body = {"idempotency_key": str(uuid4()), "contact_id": self.contact_ids[0],
                "content": {"type": "rewrite_draft", "draft_text": "我会晚一点回复你。",
                            "include_relationship_context": False}}
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.backend.request, "/api/reply/generate", body)
            self.assertFalse(self.reply_model.entered.wait(0.3))
            active.release.set()
            self.assertTrue(self.reply_model.entered.wait(5))
            self.assertFalse(following.entered.is_set())
            reply_gate.set()
            status, reply = pending.result(timeout=10)
            self.assertEqual(status, 200, reply)
            self.assertEqual(reply["candidates"][0]["text"], "我会晚一点回复你。")
            self.assertTrue(following.entered.wait(5))
            following.release.set()
        self.wait_task(imported, "succeeded")
        outbound = json.dumps([str(message.content) for messages in self.reply_model.seen_calls for message in messages], ensure_ascii=False)
        self.assertNotIn("茉莉茶", outbound)
        self.assertNotIn("另一用户联系人", outbound)
        self.assertFalse(any("send" in name for name in self.reply_model.bound_tool_names))


if __name__ == "__main__":
    run_import_http_suite(
        unittest.defaultTestLoader.loadTestsFromTestCase(ImportSubmissionHttpCheck),
        ImportSubmissionHttpCheck,
        directory_prefix="notalone-import-http-",
    )
