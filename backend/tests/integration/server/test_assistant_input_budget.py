"""可信预算经公开 HTTP 生成与重读；只替换模型并显式声明合成协议。"""

from __future__ import annotations

import os
import unittest
from dataclasses import replace
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from notalone.application.memory_service import MemoryService
from notalone.application.model_priority import ModelPriorityControl
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.reply.input_budget import BudgetState, InputBudgetDecision
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.fidelity_http_support import FidelityControlledModel, FidelityHttpFixture
from tests.input_budget_support import SyntheticModelCounter, synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend, ScriptedCoreModel, tool_response


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class BudgetHttpModel(FidelityControlledModel):
    """仅在外部模型边界控制工具轮与伪造字段，保留实际请求记录。"""

    search_next: bool = False
    forge_next: bool = False

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.search_next:
            self.search_next = False
            self.responses.append(tool_response(
                "conversation_search", {"query": "合成工具预算", "top_k": 8},
            ))
            return ScriptedCoreModel._generate(self, messages, stop, run_manager, **kwargs)
        result = super()._generate(messages, stop, run_manager, **kwargs)
        if self.forge_next:
            self.forge_next = False
            result.generations[0].message.tool_calls[0]["args"]["input_budget"] = {
                "state": "ready", "input_tokens": 0,
            }
        return result


class AssistantInputBudgetHttpTest(FidelityHttpFixture, unittest.TestCase):
    """借用 runner 自有随机测试库，业务只通过生产 HTTP 端点观察。"""

    reply_model_factory = BudgetHttpModel

    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            database_name = connection.execute("SELECT current_database()").fetchone()[0]
        if not database_name.endswith("_test"):
            raise RuntimeError("预算 HTTP 验收只允许隔离 _test 数据库。")
        cls.database_url = DATABASE_URL

    def _backend(self, owner_id: UUID) -> HttpBackend:
        return self._budget_backend(owner_id)[0]

    def _budget_backend(
        self, owner_id: UUID, *, capacity: int = 100000, unknown: bool = False,
        counters: list[SyntheticModelCounter | None] | None = None,
    ) -> tuple[HttpBackend, list[InputBudgetDecision]]:
        """每个 startup 显式绑定同一合成模型；collector 仅供测试观察。"""

        decisions: list[InputBudgetDecision] = []
        priority = ModelPriorityControl()
        configuration = synthetic_budget_kwargs(
            self.reply_model, capacity=capacity, output_reserve=100,
        )
        if unknown:
            configuration["input_budget_profile"] = replace(
                configuration["input_budget_profile"], context_window_tokens=None,
                output_reserve_tokens=None, measurement_kind=None, measurement_id=None,
            )
            configuration["input_token_counter"] = None
        if counters is not None:
            counters.append(configuration["input_token_counter"])
        with patch(
            "notalone.server.reply_wiring.build_deepseek_model",
            return_value=self.reply_model,
        ):
            service = build_reply_service(
                database_url=self.database_url, owner_id=owner_id,
                model_priority=priority, on_input_budget=decisions.append,
                **configuration,
            )
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-input-budget-{owner_id}", reply_service=service,
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(self.database_url),
                owner_memory=PostgresOwnerMemoryStore(self.database_url),
            ), runtime_shutdown=priority.stop,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend, decisions

    def _session(self, backend: HttpBackend) -> tuple[str, str]:
        contact_id, _, _ = self.prepare_contact(self.owner_id, history=False)
        status, session = backend.request(
            f"/api/contacts/{contact_id}/assistant-session/default", {},
        )
        self.assertEqual(status, 200, session)
        return contact_id, (
            f"/api/contacts/{contact_id}/assistant-sessions/{session['session_id']}"
        )

    def _tool_source(self, contact_id: str) -> None:
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-budget.jsonl',%s,1)",
                (source_id, self.owner_id, contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message "
                "(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                "VALUES (%s,%s,%s,'contact','text',%s,now())",
                (message_id, self.owner_id, contact_id, "合成工具预算：完整已授权资料。" * 100),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic:budget','{}'::jsonb)",
                (message_id, self.owner_id, contact_id, source_id),
            )

    @staticmethod
    def _body(contact_id: str, draft: str) -> dict:
        return {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": draft},
        }

    def _plan(self, text: str) -> None:
        self.reply_model.plans = [{"text": text, "basis": "保留合成原句立场。"}]

    def _corrupt_receipt(self, contact_id: str, request_id: str, value) -> None:
        # 持久化边界的明确损坏夹具；不替换业务存储或从私有表判断结果。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.reply_request SET context_snapshot = "
                "jsonb_set(context_snapshot, '{input_budget}', %s) "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (Jsonb(value), self.owner_id, contact_id, request_id),
            )

    def test_unknown_measurement_returns_explicit_metadata_and_zero_model_calls(self):
        backend, decisions = self._budget_backend(self.owner_id, unknown=True)
        contact_id, path = self._session(backend)
        draft = "合成未核实预算原句，不可静默放行。"

        status, rejected = backend.request(path + "/replies", self._body(contact_id, draft))

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_unavailable")
        self.assertEqual(len(decisions), 1)
        self.assertEqual(rejected["input_budget"], decisions[0].to_payload())
        self.assertEqual(rejected["input_budget"]["state"], "unavailable")
        self.assertFalse(rejected["input_budget"]["allowed"])
        self.assertIsNone(rejected["input_budget"]["input_tokens"])
        self.assertNotIn(draft, str(rejected))
        self.assertEqual(self.reply_model.seen_model_payloads, [])
        status, saved = backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "failed")
        self.assertEqual(saved["turns"][0]["input"]["content"]["draft_text"], draft)
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(len(decisions), 1)

    def test_initial_hard_limit_rejects_with_zero_calls_and_preserves_readable_input(self):
        backend, decisions = self._budget_backend(self.owner_id, capacity=101)
        contact_id, path = self._session(backend)
        draft = "合成超限原句，完整保留历史，不自动摘要。"

        status, rejected = backend.request(path + "/replies", self._body(contact_id, draft))

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        self.assertEqual(rejected["input_budget"], decisions[0].to_payload())
        self.assertEqual(rejected["input_budget"]["state"], "exceeded")
        self.assertGreater(rejected["input_budget"]["total_tokens"], 101)
        self.assertNotIn(draft, str(rejected))
        self.assertEqual(self.reply_model.seen_model_payloads, [])
        status, saved = backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["input"]["content"]["draft_text"], draft)
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(len(decisions), 1)

    def test_legacy_generate_keeps_its_existing_budget_gateway_contract(self):
        backend, decisions = self._budget_backend(self.owner_id, capacity=101)
        contact_id, _ = self._session(backend)

        status, rejected = backend.request(
            "/api/reply/generate", self._body(contact_id, "合成旧端点预算。"),
        )

        self.assertEqual((status, rejected), (502, {"error": "reply_budget_exceeded"}))
        self.assertEqual(len(decisions), 1)
        self.assertEqual(self.reply_model.seen_model_payloads, [])

    def test_warning_receipt_is_returned_and_durably_read_under_new_hard_limit(self):
        draft = "合成预算原句：今晚不参加，祝活动顺利。"
        self.reply_model.plans = [{"text": draft, "basis": "保留合成原句立场。"}]
        baseline, baseline_decisions = self._budget_backend(self.owner_id)
        contact_id, baseline_path = self._session(baseline)
        status, baseline_reply = baseline.request(
            baseline_path + "/replies", self._body(contact_id, draft),
        )
        self.assertEqual(status, 200, baseline_reply)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        self.assertEqual(len(baseline_decisions), 1)
        capacity = baseline_decisions[0].total_tokens + 1

        near, near_decisions = self._budget_backend(self.owner_id, capacity=capacity)
        contact_id, path = self._session(near)
        self.reply_model.plans = [{"text": draft, "basis": "保留合成原句立场。"}]
        status, generated = near.request(path + "/replies", self._body(contact_id, draft))

        self.assertEqual(status, 200, generated)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 2)
        self.assertEqual(len(near_decisions), 1)
        self.assertEqual(near_decisions[0].state, BudgetState.WARNING)
        self.assertEqual(near_decisions[0].total_tokens, capacity - 1)
        expected = near_decisions[0].to_payload()
        self.assertIn("input_budget", generated)
        self.assertEqual(generated["input_budget"], expected)

        # 新 startup 的硬限配置不能重算或抹去旧回执，读取历史不得调用模型。
        over, over_decisions = self._budget_backend(self.owner_id, capacity=101)
        status, saved = over.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(len(saved["turns"]), 1)
        turn = saved["turns"][0]
        self.assertEqual(turn["state"], "completed")
        self.assertEqual(turn["input"]["content"]["draft_text"], draft)
        self.assertEqual(turn["reply"]["input_budget"], expected)
        self.assertEqual(turn["reply"]["candidates"], generated["candidates"])
        self.assertEqual(over_decisions, [])
        self.assertEqual(len(self.reply_model.seen_model_payloads), 2)

    def test_replay_preserves_receipt_after_startup_profile_becomes_unknown(self):
        backend, decisions = self._budget_backend(self.owner_id)
        contact_id, path = self._session(backend)
        body = self._body(contact_id, "合成重放原句：今晚不参加。")
        self._plan(body["content"]["draft_text"])
        status, generated = backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["input_budget"], decisions[-1].to_payload())

        unknown, later = self._budget_backend(self.owner_id, unknown=True)
        status, replayed = unknown.request(path + "/replies", body)

        self.assertEqual(status, 200, replayed)
        self.assertEqual(replayed, generated)
        self.assertEqual(later, [])
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        self.assertEqual(unknown.request(path)[1]["turns"][0]["reply"]["input_budget"],
                         generated["input_budget"])

    def test_legacy_absence_is_read_and_replayed_without_inventing_a_receipt(self):
        backend, _ = self._budget_backend(self.owner_id)
        contact_id, path = self._session(backend)
        body = self._body(contact_id, "合成旧结果原句：预算回执未保存。")
        self._plan(body["content"]["draft_text"])
        status, generated = backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.reply_request SET context_snapshot=context_snapshot-'input_budget' "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (self.owner_id, contact_id, generated["reply_request_id"]),
            )
        unknown, decisions = self._budget_backend(self.owner_id, unknown=True)

        status, saved = unknown.request(path)
        self.assertEqual(status, 200, saved)
        self.assertNotIn("input_budget", saved["turns"][0]["reply"])
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], generated["candidates"])
        status, replayed = unknown.request(path + "/replies", body)

        self.assertEqual(status, 200, replayed)
        self.assertNotIn("input_budget", replayed)
        self.assertEqual(replayed["candidates"], generated["candidates"])
        self.assertEqual(decisions, [])
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)

    def test_corrupt_receipt_is_explicitly_rejected_without_model_or_body_leak(self):
        backend, _ = self._budget_backend(self.owner_id)
        contact_id, path = self._session(backend)
        body = self._body(contact_id, "合成损坏回执原句，不能出现在错误里。")
        self._plan(body["content"]["draft_text"])
        status, generated = backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        original = generated["input_budget"]
        later, decisions = self._budget_backend(self.owner_id)
        for corrupt in (
            {**original, "input_tokens": True},
            {**original, "request_body": body["content"]["draft_text"]},
            None,
        ):
            with self.subTest(payload_type=type(corrupt).__name__):
                self._corrupt_receipt(contact_id, generated["reply_request_id"], corrupt)
                self.assertEqual(later.request(path),
                                 (503, {"error": "assistant_session_save_failed"}))
                status, rejected = later.request(path + "/replies", body)
                self.assertEqual(status, 503, rejected)
                self.assertNotIn(body["content"]["draft_text"], str(rejected))
                self.assertNotIn("input_budget", rejected)
                self.assertEqual(decisions, [])
                self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        self._corrupt_receipt(contact_id, generated["reply_request_id"], original)
        self.assertEqual(later.request(path)[1]["turns"][0]["reply"]["input_budget"], original)

    def test_tool_material_exceeds_limit_before_second_actual_model_call(self):
        draft = "今晚不参加，祝活动顺利。"

        def prepare(backend):
            contact_id, path = self._session(backend)
            self._tool_source(contact_id)
            body = self._body(contact_id, draft)
            body["content"]["include_relationship_context"] = True
            self._plan(draft)
            self.reply_model.search_next = True
            return path, body

        baseline, baseline_decisions = self._budget_backend(self.owner_id)
        path, body = prepare(baseline)
        status, completed = baseline.request(path + "/replies", body)
        self.assertEqual(status, 200, completed)
        self.assertEqual(len(baseline_decisions), 2)
        self.assertEqual(completed["input_budget"], baseline_decisions[-1].to_payload())
        self.assertGreater(baseline_decisions[-1].total_tokens,
                           baseline_decisions[0].total_tokens + 100)

        limited, decisions = self._budget_backend(
            self.owner_id, capacity=baseline_decisions[0].total_tokens + 100,
        )
        path, body = prepare(limited)
        calls_before = len(self.reply_model.seen_model_payloads)
        status, rejected = limited.request(path + "/replies", body)

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        self.assertEqual(rejected["input_budget"], decisions[-1].to_payload())
        self.assertEqual(len(decisions), 2)
        self.assertTrue(decisions[0].allowed)
        self.assertFalse(decisions[-1].allowed)
        self.assertEqual(len(self.reply_model.seen_model_payloads), calls_before + 1)
        status, saved = limited.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["input"]["content"]["draft_text"], draft)
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(len(decisions), 2)

    def test_model_forgery_cannot_return_or_save_a_budget_receipt(self):
        backend, decisions = self._budget_backend(self.owner_id)
        contact_id, path = self._session(backend)
        draft = "合成伪造预算候选，应被拒绝。"
        self._plan(draft)
        self.reply_model.forge_next = True

        status, rejected = backend.request(path + "/replies", self._body(contact_id, draft))

        self.assertEqual(status, 500, rejected)
        self.assertNotIn("input_budget", rejected)
        self.assertNotIn(draft, str(rejected))
        self.assertEqual(len(decisions), 1)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        status, saved = backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "failed")
        self.assertIsNone(saved["turns"][0]["reply"])

    def test_candidate_transaction_failure_does_not_publish_a_partial_receipt(self):
        backend, decisions = self._budget_backend(self.owner_id)
        contact_id, path = self._session(backend)
        body = self._body(contact_id, "合成原子保存原句。")
        self._plan(body["content"]["draft_text"])
        name = f"synthetic_budget_fault_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS "
                "'BEGIN RAISE EXCEPTION ''synthetic_budget_commit_failure''; END;'"
            ).format(name=sql.Identifier(name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {name} BEFORE UPDATE OF state ON public.reply_request "
                "FOR EACH ROW WHEN (NEW.owner_id={owner}::uuid AND NEW.state='completed') "
                "EXECUTE FUNCTION public.{name}()"
            ).format(name=sql.Identifier(name), owner=sql.Literal(str(self.owner_id))))
        try:
            self.assertEqual(backend.request(path + "/replies", body),
                             (503, {"error": "assistant_session_save_failed"}))
            status, saved = backend.request(path)
            self.assertEqual(status, 200, saved)
            self.assertEqual(saved["turns"][0]["state"], "failed")
            self.assertIsNone(saved["turns"][0]["reply"])
            self.assertEqual(len(self.reply_model.seen_model_payloads), 1)
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.reply_request")
                                   .format(name=sql.Identifier(name)))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()")
                                   .format(name=sql.Identifier(name)))
        self._plan(body["content"]["draft_text"])

        status, retried = backend.request(path + "/replies", body)

        self.assertEqual(status, 200, retried)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 2)
        self.assertEqual(retried["input_budget"], decisions[-1].to_payload())
        self.assertEqual(backend.request(path)[1]["turns"][0]["reply"]["input_budget"],
                         retried["input_budget"])

    def test_deleted_session_does_not_expose_saved_receipt_or_repeat_model_work(self):
        backend, decisions = self._budget_backend(self.owner_id)
        contact_id, path = self._session(backend)
        body = self._body(contact_id, "合成删除预算会话。")
        self._plan(body["content"]["draft_text"])
        status, generated = backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertIn("input_budget", generated)

        self.assertEqual(backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(backend.request(path), (404, {"error": "not_found"}))
        self.assertEqual(backend.request(path + "/replies", body),
                         (404, {"error": "not_found"}))
        self.assertEqual(len(decisions), 1)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 1)


if __name__ == "__main__":
    unittest.main()
