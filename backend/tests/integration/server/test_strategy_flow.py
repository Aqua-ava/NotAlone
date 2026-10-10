"""聊天策略通过真实 HTTP、正式迁移和隔离 PostgreSQL 的行为验证。"""

from __future__ import annotations

import unittest
from uuid import uuid4
import json

import psycopg

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, ScriptedCoreModel, tool_response,
)
from langchain_core.messages import HumanMessage


class StrategyModel(ScriptedCoreModel):
    """仅模型边界合成；生成结果引用真实输入目的的证据ID。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(message.content) for message in messages if isinstance(message, HumanMessage))
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{
                "text": "最近怎么样，有空聊聊吗？",
                "basis": "按用户明确目的组织开口，没有假定关系或安排。",
                "citation_ids": [payload["evidence"][0]["evidence_id"]], "risk_notes": [],
            }], "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class StrategyHttpFlowTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = StrategyModel

    def test_explicit_purpose_generates_without_fabricating_target(self):
        contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, %s)",
                (self.owner_id, contact_id, "合成策略联系人"),
            )
        self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=contact_id, channel="wechat",
            account_scope="synthetic-strategy", conversation_locator=f"synthetic-{contact_id}",
        )
        body = {
            "contact_id": str(contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "initiate_conversation", "purpose": "想关心近况，不安排见面"},
        }
        status, result = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["candidates"][0]["text"], "最近怎么样，有空聊聊吗？")
        calls = len(self.reply_model.seen_calls)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, result))
        self.assertEqual(len(self.reply_model.seen_calls), calls)
        payload = next(json.loads(message.content) for message in self.reply_model.seen_calls[0] if isinstance(message, HumanMessage))
        self.assertEqual(payload["input_mode"], "initiate_conversation")
        self.assertEqual(payload["confirmed_purpose"], "想关心近况，不安排见面")
        self.assertNotIn("current_text", payload)
        self.assertNotIn("target_message_id", payload)
        self.assertEqual([item["kind"] for item in payload["evidence"]], ["user_purpose"])
        self.assertEqual(self.other_backend.request("/api/reply/generate", {**body, "idempotency_key": str(uuid4())})[0], 409)
        self.assertEqual(len(self.reply_model.seen_calls), calls)

