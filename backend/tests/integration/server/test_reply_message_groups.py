"""候选消息组的公开HTTP契约，真实迁移/PG/生产生成，只替换模型。"""

from __future__ import annotations

import json
import unittest
from uuid import uuid4

import psycopg
from langchain_core.messages import HumanMessage

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, ScriptedCoreModel, tool_response


class MessageGroupModel(ScriptedCoreModel):
    invalid_group: bool = False
    group_separator: str = "\n\n"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(message.content) for message in messages if isinstance(message, HumanMessage))
        parts = ["最近怎么样？", "方便时聊聊就好，不急着安排。"]
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{
                "text": "不属于这组的额外承诺" if self.invalid_group else self.group_separator.join(parts),
                "messages": parts, "basis": "按当前意愿分两条表达，没有额外承诺。",
                "citation_ids": [item["evidence_id"] for item in payload["evidence"]], "risk_notes": [],
            }], "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class ReplyMessageGroupHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = MessageGroupModel

    def _contact(self):
        contact_id, source_id, message_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,%s)",
                               (self.owner_id, contact_id, "合成消息组联系人"))
            connection.execute("INSERT INTO public.source_document (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES (%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1)",
                               (source_id, self.owner_id, contact_id, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message (id,owner_id,contact_id,speaker,message_type,text_content) VALUES (%s,%s,%s,'contact','text','有空一起聊聊吗？')",
                               (message_id, self.owner_id, contact_id))
            connection.execute("INSERT INTO public.message_source_ref (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES (%s,%s,%s,'source_document',%s,'synthetic:1','{}'::jsonb)",
                               (message_id, self.owner_id, contact_id, source_id))
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=contact_id, channel="wechat",
                                     account_scope="synthetic-message-group", conversation_locator=f"synthetic-{contact_id}")
        return contact_id, source_id, message_id

    def test_groups_replay_with_stable_message_identity_in_both_scenes(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                contact_id, _, message_id = self._contact()
                content = {"type": scene, "target_message_id": str(message_id), "direction": "关心近况，不承诺安排"} if scene == "reply_to_message" else {"type": scene, "purpose": "关心近况，不承诺安排"}
                body = {"contact_id": str(contact_id), "idempotency_key": str(uuid4()), "content": content}
                status, result = self.backend.request("/api/reply/generate", body)
                self.assertEqual(status, 200, result)
                self.assertEqual(len(result["candidates"]), 1)
                candidate = result["candidates"][0]
                self.assertEqual(candidate["text"], "最近怎么样？\n\n方便时聊聊就好，不急着安排。")
                self.assertEqual([message["text"] for message in candidate["messages"]], ["最近怎么样？", "方便时聊聊就好，不急着安排。"])
                self.assertEqual(len({message["message_id"] for message in candidate["messages"]}), 2)
                calls = len(self.reply_model.seen_calls)
                reopened = self._backend(self.owner_id)
                self.assertEqual(reopened.request("/api/reply/generate", body), (200, result))
                self.assertEqual(len(self.reply_model.seen_calls), calls)
                self.assertEqual(self.other_backend.request("/api/reply/generate", body)[0], 409)
                self.assertEqual(len(self.reply_model.seen_calls), calls)

    def test_lossless_group_separator_is_normalized_without_changing_words(self):
        contact_id, _, _ = self._contact()
        for separator in ("", "\n"):
            with self.subTest(separator=repr(separator)):
                self.reply_model.group_separator = separator
                status, result = self.backend.request("/api/reply/generate", {
                    "contact_id": str(contact_id), "idempotency_key": str(uuid4()),
                    "content": {"type": "initiate_conversation", "purpose": "关心近况，不承诺安排"},
                })
                self.assertEqual(status, 200, result)
                self.assertEqual(result["candidates"][0]["text"], "最近怎么样？\n\n方便时聊聊就好，不急着安排。")

    def test_group_text_cannot_add_content_outside_its_messages(self):
        self.reply_model.invalid_group = True
        contact_id, _, _ = self._contact()
        status, result = self.backend.request("/api/reply/generate", {
            "contact_id": str(contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "initiate_conversation", "purpose": "关心近况，不承诺安排"},
        })
        self.assertEqual(status, 500, result)
        self.assertEqual(result, {"error": "reply_generation_failed"})
