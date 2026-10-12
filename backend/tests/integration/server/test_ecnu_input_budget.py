"""生产 ECNU 预算经公开 HTTP 与真实 SDK；传输只返回合成资料。"""

from __future__ import annotations

import asyncio
import json
import os
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import psycopg
from langchain_deepseek import ChatDeepSeek

from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.core_business_flow_support import HttpBackend


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
ECNU_URL = "https://chat.ecnu.edu.cn/open/api/v1"
DRAFT = "合成原句：今晚不参加，祝活动顺利。"


class EcnuInputBudgetHttpTest(FidelityHttpFixture, unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("ECNU 预算验收只允许隔离 _test 数据库。")
        cls.database_url = DATABASE_URL

    def _backend(self, owner_id: UUID) -> HttpBackend:
        if not hasattr(self, "sdk_model"):
            self.sdk_payloads: list[dict] = []
            sync_client = httpx.Client(transport=httpx.MockTransport(self._respond))
            async_client = httpx.AsyncClient(transport=httpx.MockTransport(self._respond))
            self.addCleanup(sync_client.close)
            self.addCleanup(lambda: asyncio.run(async_client.aclose()))
            self.sdk_model = ChatDeepSeek(
                model="ecnu-max", api_key="synthetic-never-sent-key",
                base_url=ECNU_URL, temperature=0, max_retries=0,
                http_client=sync_client, http_async_client=async_client,
                use_responses_api=False,
            )
        # 只替换外部供应商构造边界，生产预算配置与业务存储均实际运行。
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.sdk_model):
            service = build_reply_service(database_url=self.database_url, owner_id=owner_id)
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-ecnu-budget-{owner_id}", reply_service=service,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def _respond(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        self.sdk_payloads.append(payload)
        context = json.loads(next(item["content"] for item in payload["messages"] if item["role"] == "user"))
        evidence = next(item for item in context["evidence"] if item["kind"] == "user_draft")
        output = {"candidates": [{"text": DRAFT, "basis": "保留合成原句。",
                                 "citation_ids": [evidence["evidence_id"]], "risk_notes": []}],
                  "used_skill_version_id": None}
        return httpx.Response(200, json={
            "id": "synthetic-ecnu-completion", "object": "chat.completion", "created": 0,
            "model": "ecnu-max", "choices": [{"index": 0, "finish_reason": "tool_calls",
                "message": {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "synthetic-output-call", "type": "function",
                    "function": {"name": "ReplyRuntimeOutput", "arguments": json.dumps(output)},
                }]}}],
            "usage": {"prompt_tokens": 42, "completion_tokens": 16, "total_tokens": 58},
        })

    def test_short_production_ecnu_request_generates_and_reloads_approximate_receipt(self):
        contact_id, _, _ = self.prepare_contact(self.owner_id, history=False)
        prefix = f"/api/contacts/{contact_id}"
        status, session = self.backend.request(prefix + "/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = prefix + f"/assistant-sessions/{session['session_id']}"
        status, generated = self.backend.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": DRAFT},
        })
        self.assertEqual(status, 200, generated)
        budget = generated["input_budget"]
        self.assertEqual(budget["measurement_kind"], "approximate")
        self.assertEqual(budget["safety_margin_tokens"], 65536)
        self.assertEqual(budget["output_reserve_tokens"], 4096)
        self.assertEqual(budget["context_window_tokens"], 512000)
        self.assertEqual(len(self.sdk_payloads), 1)
        self.assertEqual(self.sdk_payloads[0]["max_tokens"], 4096)
        status, reloaded = self._backend(self.owner_id).request(path)
        self.assertEqual(status, 200, reloaded)
        self.assertEqual(reloaded["turns"][0]["reply"]["input_budget"], budget)
        self.assertEqual(len(self.sdk_payloads), 1)

    def test_long_production_request_is_rejected_and_complete_input_remains_readable(self):
        contact_id, _, _ = self.prepare_contact(self.owner_id, history=False)
        prefix = f"/api/contacts/{contact_id}"
        status, session = self.backend.request(prefix + "/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = prefix + f"/assistant-sessions/{session['session_id']}"
        original = "合成完整讨论。" * 18000
        status, rejected = self.backend.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": original},
        })
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        self.assertEqual(rejected["input_budget"]["measurement_kind"], "approximate")
        self.assertEqual(rejected["input_budget"]["safety_margin_tokens"], 65536)
        self.assertNotIn(original, repr(rejected))
        self.assertEqual(self.sdk_payloads, [])
        status, reloaded = self.backend.request(path)
        self.assertEqual(status, 200, reloaded)
        self.assertEqual(reloaded["turns"][0]["input"]["content"]["draft_text"], original)
        self.assertIsNone(reloaded["turns"][0]["reply"])

    def test_changed_actual_endpoint_is_rejected_before_sdk_request(self):
        contact_id, _, _ = self.prepare_contact(self.owner_id, history=False)
        prefix = f"/api/contacts/{contact_id}"
        status, session = self.backend.request(prefix + "/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = prefix + f"/assistant-sessions/{session['session_id']}"
        self.sdk_model.root_async_client.base_url = "http://127.0.0.1:1/unapproved"
        status, rejected = self.backend.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": DRAFT},
        })
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_unavailable")
        self.assertEqual(self.sdk_payloads, [])
        self.assertEqual(rejected["input_budget"]["safety_margin_tokens"], 65536)


if __name__ == "__main__":
    unittest.main()
