"""真实 HTTP 和外部合成模型的到达顺序检查；不启动或替代 App 验收。"""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from uuid import uuid4

import psycopg

from import_http_check import ImportSubmissionHttpCheck


class ImportPriorityHttpCheck(ImportSubmissionHttpCheck):
    def reply_body(self):
        return {"idempotency_key": str(uuid4()), "contact_id": self.contact_ids[0],
                "content": {"type": "rewrite_draft", "draft_text": "我会晚一点回复你。",
                            "include_relationship_context": False}}

    def test_late_http_does_not_keep_completed_single_batch_running(self):
        active = self.extraction_model.block_call(0)
        reply_gate = self.reply_model.pause_next_response()
        imported, _ = self.import_file()
        self.assertTrue(active.entered.wait(5))
        active.release.set()
        self.wait_task(imported, "succeeded")
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.backend.request, "/api/reply/generate", self.reply_body())
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                state = self.task(imported)["status"]
                calls = len(self.extraction_model.seen_calls)
                self.assertEqual((state, calls), ("succeeded", 2))
                print(json.dumps({"late_http": {"task": state, "background_calls": calls}}), flush=True)
            finally:
                reply_gate.set()
                self.release_extraction()
            self.assertEqual(pending.result(timeout=10)[0], 200)

    def test_staged_batches_yield_after_delayed_foreground_arrival(self):
        path = self.prepare_priority_import()
        reply_gate = self.reply_model.pause_next_response()
        status, imported = self.backend.request("/api/imports/commit", {
            "path": str(path), "new_contact_name": "合成优先级联系人",
        })
        self.assertEqual(status, 200, imported)
        self.assertEqual(imported["imported_count"], 46)
        self.assertTrue(self.extraction_model.gates[0].entered.wait(5))
        # 固定晚到变量：先让第二次后台调用真实开始，再提交回复 HTTP。
        self.release_active_extraction()
        self.assertTrue(self.extraction_model.gates[1].entered.wait(5))
        with ThreadPoolExecutor(max_workers=1) as executor:
            request_started = threading.Event()

            def request_reply():
                request_started.set()
                return self.backend.request("/api/reply/generate", self.reply_body())

            pending = executor.submit(request_reply)
            try:
                self.assertTrue(request_started.wait(5))
                for _ in range(2):
                    if self.reply_model.entered.is_set():
                        break
                    index = len(self.extraction_model.seen_calls)
                    self.release_active_extraction()
                    # 同 App 用例一样只观察模型边界；任一下一次调用进入即是反馈。
                    for _ in range(500):
                        if self.reply_model.entered.wait(0.01) or self.extraction_model.gates[index].entered.is_set():
                            break
                    else:
                        self.fail("回复和下一次后台模型均未进入。")
                self.assertTrue(self.reply_model.entered.is_set())
                calls = len(self.extraction_model.seen_calls)
                self.assertLess(calls, 4)
                self.release_extraction()
                self.assertEqual(self.observe_next_extraction(), {
                    "next_extraction_entered": False, "extraction_calls": calls,
                })
                self.assertEqual(self.task(imported)["status"], "running")
                print(json.dumps({"foreground_held": {"task": "running", "background_calls": calls,
                                  "next_provider_entered": False}}), flush=True)
            finally:
                reply_gate.set()
                self.release_extraction()
            status, result = pending.result(timeout=10)
            self.assertEqual(status, 200, result)
            self.assertEqual(result["candidates"][0]["text"], "我会晚一点回复你。")
        self.wait_task(imported, "succeeded")
        self.assertEqual(len(self.extraction_model.seen_calls), 4)
        print(json.dumps({"foreground_released": {"task": "succeeded", "background_calls": 4}}), flush=True)
        outbound = json.dumps([str(message.content) for messages in self.reply_model.seen_calls
                               for message in messages], ensure_ascii=False)
        self.assertNotIn("茉莉茶", outbound)
        self.assertNotIn("另一用户联系人", outbound)
        self.assertFalse(any("send" in name for name in self.reply_model.bound_tool_names))


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="notalone-import-priority-http-") as directory:
        current = Path(directory)
        os.environ.update({
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_ENV_FILE": str(current / "synthetic.env"),
            "NOTALONE_BACKEND_INFO": str(current / "backend.info"),
            "NOTALONE_DATABASE_URL": "", "NOTALONE_OWNER_ID": "",
            "NOTALONE_DEEPSEEK_API_KEY": "", "DEEPSEEK_API_KEY": "",
            "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false",
            "NOTALONE_DEEPSEEK_BASE_URL": "http://127.0.0.1:1",
            "NOTALONE_WECHAT_CLI": str(current / "unavailable-cli"),
            "NOTALONE_SYNC_PROBE": str(current / "unavailable-probe"),
        })
        # 只跑本次两个排序检查，不重复已过的导入业务回归。
        suite = unittest.TestSuite(ImportPriorityHttpCheck(name) for name in (
            "test_late_http_does_not_keep_completed_single_batch_running",
            "test_staged_batches_yield_after_delayed_foreground_arrival",
        ))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        with psycopg.connect("host=/tmp dbname=postgres") as admin:
            remaining = admin.execute("SELECT count(*) FROM pg_database WHERE datname = %s",
                                      (ImportPriorityHttpCheck.database_name,)).fetchone()[0]
        print(f"本轮隔离数据库残留：{remaining}", flush=True)
        if not result.wasSuccessful() or remaining:
            raise SystemExit(1)
