"""仅在真实 HTTP 与公开关闭边界验证模型优先级和可恢复停机。"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import threading
import time
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from langchain_core.outputs import ChatGeneration, ChatResult

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, ScriptedCoreModel, tool_response,
)


@dataclass
class ModelGate:
    """在外部模型边界控制已经开始的一次调用。"""

    entered: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)


class ControlledCoreModel(ScriptedCoreModel):
    gates: dict[int, ModelGate] = {}
    errors: dict[int, Exception] = {}

    def __init__(self):
        super().__init__()
        self.gates = {}
        self.errors = {}

    def block_call(self, index: int) -> ModelGate:
        gate = self.gates[index] = ModelGate()
        return gate

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        del stop, run_manager, kwargs
        self.wait_for_response()
        index = len(self.seen_calls)
        self.seen_calls.append(messages)
        gate = self.gates.get(index)
        if gate is not None:
            gate.entered.set()
            if not gate.release.wait(60):
                raise TimeoutError("合成模型控制未在时限内释放。")
        if index in self.errors:
            raise self.errors[index]
        if index >= len(self.responses):
            raise AssertionError("合成模型脚本耗尽。")
        return ChatResult(generations=[ChatGeneration(message=self.responses[index])])


class ModelPriorityLifecycleHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    extraction_model_factory = ControlledCoreModel
    reply_model_factory = ControlledCoreModel
    production_model_wiring = True

    def setUp(self):
        super().setUp()
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.addCleanup(self.executor.shutdown, wait=True)
        self.addCleanup(self._release_models)

    def _release_models(self):
        self._release_response_gates()
        for model in (self.extraction_model, self.reply_model):
            for gate in model.gates.values():
                gate.release.set()

    def _import(self, backend, label, tea):
        # 启动与停机案例先布置其模型门闩，再放行导入已经触发的调用。
        return super()._import(backend, label, tea, hold_model_response=True)

    def _reply_body(self, imported):
        self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": "好呀，聊聊茶。", "basis": "回应当前消息。",
                            "citation_ids": [imported["target"]["message_id"]],
                            "risk_notes": []}], "used_skill_version_id": None,
        }))
        return {"contact_id": imported["contact_id"], "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message",
                            "target_message_id": imported["target"]["message_id"],
                            "direction": "自然回应"}}

    def _task(self, backend, imported):
        return self._get(backend, f"/api/tasks/status?contact_id={imported['contact_id']}"
                        f"&task_id={imported['task_id']}")

    def _wait_task(self, backend, imported, status, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            task = self._task(backend, imported)
            if task["status"] == status:
                return task
            threading.Event().wait(0.02)
        self.fail(f"原任务未进入 {status}：{task}")

    def _prepare_adjudication(self, imported, *, two_facts=False):
        self.assertEqual(self.backend.request("/api/memories/manual-contact", {
            "contact_id": imported["contact_id"], "text": "联系人很喜欢茉莉茶。",
            "category": "preference", "topic": "other",
        })[0], 200)
        if two_facts:
            fact = self.extraction_model.responses[0].tool_calls[0]["args"]["facts"][0]
            verified = self.extraction_model.responses[1].tool_calls[0]["args"]["results"][0]
            self.extraction_model.responses[0] = tool_response("MemoryExtractionOutput", {
                "facts": [fact, {**fact, "text": "联系人平时喜欢茉莉茶。"}],
            })
            self.extraction_model.responses[1] = tool_response("SourceVerificationOutput", {
                "results": [verified, {**verified, "candidate_index": 1}],
            })
        self.extraction_model.responses.extend([
            tool_response("MemoryAdjudicationOutput", {
                "action": "add", "replaced_memory_id": None,
            }) for _ in range(2 if two_facts else 1)
        ])

    def _assert_foreground_priority(self, imported, active_index, next_index):
        active = self.extraction_model.block_call(active_index)
        following = self.extraction_model.block_call(next_index)
        reply_gate = self.reply_model.block_call(0)
        body = self._reply_body(imported)
        self._start_import_worker(self.backend, imported)
        self.assertTrue(active.entered.wait(5))
        reply = self.executor.submit(self.backend.request, "/api/reply/generate", body)
        self.assertFalse(reply_gate.entered.wait(0.3))
        active.release.set()
        self.assertTrue(reply_gate.entered.wait(5))
        self.assertFalse(following.entered.is_set())
        reply_gate.release.set()
        status, payload = reply.result(timeout=5)
        self.assertEqual(status, 200, payload)
        self.assertTrue(following.entered.wait(5))
        following.release.set()
        self._wait_finished(self.backend, imported["contact_id"])

    def test_reply_has_priority_after_source_verification(self):
        imported = self._import(self.backend, "核验优先", "茉莉茶")
        self._prepare_adjudication(imported)
        self._assert_foreground_priority(imported, 1, 2)

    def test_reply_has_priority_between_adjudication_calls(self):
        imported = self._import(self.backend, "裁决优先", "茉莉茶")
        self._prepare_adjudication(imported, two_facts=True)
        self._assert_foreground_priority(imported, 2, 3)

    def test_adjudication_result_waits_for_reply_before_changing_memory(self):
        imported = self._import(self.backend, "裁决结果交接", "茉莉茶")
        self._prepare_adjudication(imported)
        adjudication = self.extraction_model.block_call(2)
        reply_gate = self.reply_model.block_call(0)
        body = self._reply_body(imported)
        self._start_import_worker(self.backend, imported)
        self.assertTrue(adjudication.entered.wait(5))
        reply = self.executor.submit(self.backend.request, "/api/reply/generate", body)
        self.assertFalse(reply_gate.entered.wait(0.3))
        adjudication.release.set()
        self.assertTrue(reply_gate.entered.wait(5))
        # 前台模型被明确保持运行，观察期间后台旧裁决不能使其依据失效。
        deadline = time.monotonic() + 0.3
        while time.monotonic() < deadline:
            memories = self._get(
                self.backend, f"/api/contacts/{imported['contact_id']}/memories",
            )["memories"]
            self.assertEqual([row["text"] for row in memories], ["联系人很喜欢茉莉茶。"])
            threading.Event().wait(0.02)
        reply_gate.release.set()
        status, payload = reply.result(timeout=5)
        self.assertEqual(status, 200, payload)
        self._wait_task(self.backend, imported, "succeeded")
        memories = self._get(
            self.backend, f"/api/contacts/{imported['contact_id']}/memories",
        )["memories"]
        self.assertEqual({row["text"] for row in memories},
                         {"联系人很喜欢茉莉茶。", "联系人喜欢茉莉茶。"})

    def test_foreground_wait_longer_than_runtime_and_request_lease_still_succeeds(self):
        extraction = self.extraction_model.block_call(0)
        imported = self._import(self.backend, "长等待", "茉莉茶")
        body = self._reply_body(imported)
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        started = time.monotonic()
        reply = self.executor.submit(self.backend.request, "/api/reply/generate", body, timeout=45)
        # 特意跨过正式 runtime 的 20 秒和正式请求租约的 30 秒。
        timer = threading.Timer(31.5, extraction.release.set)
        timer.start()
        self.addCleanup(timer.cancel)
        status, payload = reply.result(timeout=40)
        self.assertGreater(time.monotonic() - started, 30)
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, payload))
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self._wait_finished(self.backend, imported["contact_id"])

    def test_background_error_releases_priority_and_keeps_real_failure_budget(self):
        extraction = self.extraction_model.block_call(0)
        retry_extraction = self.extraction_model.block_call(1)
        reply_gate = self.reply_model.block_call(0)
        imported = self._import(self.backend, "后台失败", "茉莉茶")
        original = self.extraction_model.responses[0]
        self.extraction_model.responses.insert(1, original)
        self.extraction_model.errors[0] = RuntimeError("合成模型服务不可用。")
        body = self._reply_body(imported)
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        reply = self.executor.submit(self.backend.request, "/api/reply/generate", body)
        self.assertFalse(reply_gate.entered.wait(0.3))
        extraction.release.set()
        self.assertTrue(reply_gate.entered.wait(5))
        self.assertFalse(retry_extraction.entered.wait(1.2))
        reply_gate.release.set()
        self.assertEqual(reply.result(timeout=5)[0], 200)
        self.assertTrue(retry_extraction.entered.wait(5))
        retry_extraction.release.set()
        task = self._wait_task(self.backend, imported, "succeeded")
        self.assertEqual(task["retry_count"], 1)
        self.assertEqual(task["steps"][2]["attempt_count"], 2)

    def test_failed_foreground_releases_background_and_allows_next_reply(self):
        extraction = self.extraction_model.block_call(0)
        verification = self.extraction_model.block_call(1)
        reply_gate = self.reply_model.block_call(0)
        imported = self._import(self.backend, "回复失败", "茉莉茶")
        body = self._reply_body(imported)
        self.reply_model.errors[0] = RuntimeError("合成回复模型不可用。")
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        reply = self.executor.submit(self.backend.request, "/api/reply/generate", body)
        self.assertFalse(reply_gate.entered.wait(0.3))
        extraction.release.set()
        self.assertTrue(reply_gate.entered.wait(5))
        self.assertFalse(verification.entered.is_set())
        reply_gate.release.set()
        self.assertEqual(reply.result(timeout=5)[0], 500)
        self.assertTrue(verification.entered.wait(5))
        verification.release.set()
        self._wait_task(self.backend, imported, "succeeded")
        self.assertEqual(self.backend.request("/api/reply/generate", self._reply_body(imported))[0], 200)

    def test_source_deleted_while_background_waits_prevents_next_model_call(self):
        extraction = self.extraction_model.block_call(0)
        verification = self.extraction_model.block_call(1)
        reply_gate = self.reply_model.block_call(0)
        imported = self._import(self.backend, "等待删除", "茉莉茶")
        body = self._reply_body(imported)
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        reply = self.executor.submit(self.backend.request, "/api/reply/generate", body)
        self.assertFalse(reply_gate.entered.wait(0.3))
        extraction.release.set()
        self.assertTrue(reply_gate.entered.wait(5))
        contact_id = imported["contact_id"]
        self.assertEqual(self.backend.request(
            f"/api/contacts/{contact_id}/sources/{imported['source']['source_id']}", method="DELETE",
        )[0], 202)
        self.assertEqual(self._task(self.backend, imported)["status"], "cancelled")
        reply_gate.release.set()
        self.assertNotEqual(reply.result(timeout=5)[0], 200)
        self.assertFalse(verification.entered.wait(0.3))
        self.assertEqual(len(self.extraction_model.seen_calls), 1)
        self.assertEqual(self._get(self.backend, f"/api/contacts/{contact_id}/memories")["memories"], [])

    def test_shutdown_releases_global_lock_and_lease_recovery_keeps_three_failures(self):
        extraction = self.extraction_model.block_call(0)
        imported = self._import(self.backend, "租约恢复", "茉莉茶")
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        started = time.monotonic()
        self.backend.server.shutdown()
        self.assertLess(time.monotonic() - started, 5.0)
        # 同一旧模型仍阻塞时，另一联系人的实际 Worker 已可取得全局锁。
        reopened = self._backend(self.owner_id)
        self.extraction_model.responses[1:] = []
        another = self._import(reopened, "锁释放", "乌龙茶")
        self._start_import_worker(reopened, another)
        self._wait_task(reopened, another, "succeeded")
        extraction.release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            task = self._task(reopened, imported)
            if task["steps"][2]["attempt_count"] == 0:
                break
            threading.Event().wait(0.02)
        self.assertEqual(task["status"], "running")
        self.assertEqual(task["steps"][2]["attempt_count"], 0)
        self.assertEqual(task["retry_count"], 0)
        self.assertEqual([step["attempt_count"] for step in task["steps"][:2]], [1, 1])
        threading.Event().wait(31)
        next_index = len(self.extraction_model.seen_calls)
        self.extraction_model.errors.update({
            index: RuntimeError("合成恢复后的模型失败。")
            for index in range(next_index, next_index + 3)
        })
        reopened.request("/api/tasks/run", {"contact_id": imported["contact_id"],
                                            "task_id": imported["task_id"]})
        failed = self._wait_task(reopened, imported, "failed")
        self.assertEqual(failed["retry_count"], 3)
        self.assertEqual(failed["steps"][2]["attempt_count"], 3)
        self.assertEqual([step["attempt_count"] for step in failed["steps"][:2]], [1, 1])
        self.assertEqual(len(self.extraction_model.seen_calls) - next_index, 3)

    def test_reply_waits_for_active_extraction_then_holds_priority_until_complete(self):
        imported = self._import(self.backend, "优先级", "茉莉茶")
        self._assert_foreground_priority(imported, 0, 1)

    def test_shutdown_wakes_waiting_reply_and_discards_late_background_result(self):
        extraction = self.extraction_model.block_call(0)
        verification = self.extraction_model.block_call(1)
        reply_gate = self.reply_model.block_call(0)
        imported = self._import(self.backend, "停机", "乌龙茶")
        body = self._reply_body(imported)
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        reply = self.executor.submit(self.backend.request, "/api/reply/generate", body)
        self.assertFalse(reply_gate.entered.wait(0.3))
        started = time.monotonic()
        shutdown = self.executor.submit(self.backend.request, "/api/runtime/shutdown", {})
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if self._get(self.backend, "/api/runtime/status")["state"] == "stopping":
                break
            threading.Event().wait(0.02)
        self.assertEqual(self.backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"],
        }), (503, {"error": "runtime_stopping"}))
        self.assertEqual(self.backend.request("/api/reply/generate", body),
                         (503, {"error": "runtime_stopping"}))
        self.assertEqual(shutdown.result(timeout=5), (200, {"state": "stopped"}))
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(reply.result(timeout=1),
                         (503, {"error": "runtime_stopping"}))
        reopened = self._backend(self.owner_id)
        contact_id = imported["contact_id"]
        path = f"/api/tasks/status?contact_id={contact_id}&task_id={imported['task_id']}"
        self.assertEqual(self._get(reopened, path)["status"], "running")
        extraction.release.set()
        self.assertFalse(verification.entered.wait(0.3), "停止后又开始来源核验。")
        self.assertFalse(reply_gate.entered.is_set())
        self.assertEqual(self._get(reopened, f"/api/contacts/{contact_id}/memories")["memories"], [])
        state = self._get(reopened, path)
        self.assertNotEqual(state["status"], "succeeded", state)

    def test_stopped_late_extraction_retains_one_minimal_outbound_record(self):
        extraction = self.extraction_model.block_call(0)
        imported = self._import(self.backend, "停止台账", "茉莉茶")
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        extraction.release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self._task(reopened, imported)["steps"][2]["attempt_count"] == 0:
                break
            threading.Event().wait(0.02)
        summary = self._get(reopened, "/api/ledger/summary")
        self.assertEqual(summary["total_calls"], 1, summary)
        self.assertEqual(summary["outcome_counts"], {"run_failed": 1})
        self.assertEqual(summary["recent"][0]["contact_id"], imported["contact_id"])

    def test_stopped_late_adjudication_retains_all_actual_call_records(self):
        imported = self._import(self.backend, "裁决停止台账", "茉莉茶")
        self._prepare_adjudication(imported)
        adjudication = self.extraction_model.block_call(2)
        self._start_import_worker(self.backend, imported)
        self.assertTrue(adjudication.entered.wait(5))
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        adjudication.release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self._task(reopened, imported)["steps"][2]["attempt_count"] == 0:
                break
            threading.Event().wait(0.02)
        summary = self._get(reopened, "/api/ledger/summary")
        self.assertEqual(summary["total_calls"], 3, summary)
        self.assertEqual(summary["outcome_counts"], {"succeeded": 1, "run_failed": 2})
        memories = self._get(reopened, f"/api/contacts/{imported['contact_id']}/memories")["memories"]
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0]["adoption_method"], "manual")

    def test_model_error_returning_after_shutdown_still_consumes_failure_budget(self):
        extraction = self.extraction_model.block_call(0)
        imported = self._import(self.backend, "停止后真实失败", "茉莉茶")
        self.extraction_model.errors[0] = RuntimeError("合成实际模型失败。")
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        extraction.release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            task = self._task(reopened, imported)
            if task["retry_count"] == 1:
                break
            threading.Event().wait(0.02)
        self.assertEqual(task["retry_count"], 1)
        self.assertEqual(task["steps"][2]["attempt_count"], 1)
        self.assertEqual(task["steps"][2]["status"], "retryable")
        self.assertEqual(len(self.extraction_model.seen_calls), 1)
        summary = self._get(reopened, "/api/ledger/summary")
        self.assertEqual(summary["total_calls"], 1)
        self.assertEqual(summary["outcome_counts"], {"run_failed": 1})

    def test_rejected_foreground_context_releases_priority_without_model_call(self):
        extraction = self.extraction_model.block_call(0)
        verification = self.extraction_model.block_call(1)
        imported = self._import(self.backend, "回复拒绝", "茉莉茶")
        body = self._reply_body(imported)
        body["content"]["target_message_id"] = str(uuid4())
        self._start_import_worker(self.backend, imported)
        self.assertTrue(extraction.entered.wait(5))
        rejected = self.executor.submit(self.backend.request, "/api/reply/generate", body)
        self.assertFalse(verification.entered.wait(0.3))
        extraction.release.set()
        self.assertEqual(rejected.result(timeout=5)[0], 500)
        self.assertEqual(len(self.reply_model.seen_calls), 0)
        self.assertTrue(verification.entered.wait(5))
        verification.release.set()
        self._wait_task(self.backend, imported, "succeeded")
        self.assertEqual(self.backend.request("/api/reply/generate", self._reply_body(imported))[0], 200)

    def test_watermark_failure_after_model_ledger_does_not_count_extraction_twice(self):
        imported = self._import(self.backend, "水位失败台账", "茉莉茶")
        # 模型脚本全部先准备；实际 PostgreSQL 触发器只拒绝本联系人的首次写入。
        self.extraction_model.responses.extend(list(self.extraction_model.responses))
        name = "priority_watermark_" + uuid4().hex
        sequence_name = name + "_seq"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL("CREATE SEQUENCE {}").format(sql.Identifier(sequence_name)))
            connection.execute(sql.SQL("""
                CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.owner_id::text = TG_ARGV[0] AND NEW.contact_id::text = TG_ARGV[1] THEN
                        IF nextval({}::regclass) = 1 THEN
                            RAISE EXCEPTION '合成水位首次写入失败' USING ERRCODE = '40001';
                        END IF;
                    END IF;
                    RETURN NEW;
                END;
                $$
            """).format(sql.Identifier(name), sql.Literal(sequence_name)))
            connection.execute(sql.SQL("""
                CREATE TRIGGER {} BEFORE INSERT OR UPDATE ON public.memory_extraction_watermark
                FOR EACH ROW EXECUTE FUNCTION {}({}, {})
            """).format(sql.Identifier(name), sql.Identifier(name),
                        sql.Literal(str(self.owner_id)), sql.Literal(imported["contact_id"])))

        def remove_failure():
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL(
                    "DROP TRIGGER IF EXISTS {} ON public.memory_extraction_watermark"
                ).format(sql.Identifier(name)))
                connection.execute(sql.SQL("DROP FUNCTION IF EXISTS {}()").format(sql.Identifier(name)))
                connection.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(sql.Identifier(sequence_name)))

        self.addCleanup(remove_failure)
        self._start_import_worker(self.backend, imported)
        task = self._wait_task(self.backend, imported, "succeeded")
        self.assertEqual(task["retry_count"], 1)
        self.assertEqual(task["steps"][2]["attempt_count"], 2)
        self.assertEqual(len(self.extraction_model.seen_calls), 4)
        summary = self._get(self.backend, "/api/ledger/summary")
        self.assertEqual(summary["total_calls"], 4, summary)
        self.assertEqual(summary["outcome_counts"], {"succeeded": 4})
        self.assertEqual(len(self._get(self.backend,
            f"/api/contacts/{imported['contact_id']}/memories")["memories"]), 1)


if __name__ == "__main__":
    unittest.main()
