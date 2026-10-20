"""明确采用新消息时，完整累计要求沿原HTTP领取和预算，不走公开单次放宽。"""

from __future__ import annotations

import json
import unittest
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import HumanMessage

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server import test_assistant_continuation as continuation_tests


class AssistantMessageAdoptionHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = continuation_tests.ContinuationModel
    _generated = continuation_tests.AssistantContinuationHttpTest._generated
    _command = continuation_tests.AssistantContinuationHttpTest._command
    _display_edited_second = continuation_tests.AssistantContinuationHttpTest._display_edited_second

    def _adopt(self, mode: str):
        requirement = "甲" * 4096
        # 回应由共享夹具创建真实目标消息及 direction；purpose 只属于主动联系合同。
        workspace = mode in ("express", "suggest")
        content = ({"type": "rewrite_draft", "input_kind": "workspace", "workspace_action": mode,
                    "draft_text": "明确拒绝合成邀请。" if mode == "express" else "",
                    "context_text": "用户补充：这次只聊今天。", "excluded_message_ids": [str(uuid4())],
                    "include_relationship_context": True, "user_instruction": "自然一点"}
                   if workspace else None if mode == "reply_to_message" else {
                       "type": mode, "purpose": "明确拒绝合成邀请。", "user_instruction": "自然一点"})
        path, initial, frame = self._display_edited_second(
            requirement, content=content, with_source=workspace or mode == "reply_to_message",
        )
        command = self._command(initial, frame, instruction="第二条简短一点", requirement_changes=[
            {"action": "keep", "previous": requirement},
        ])
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        full = "自然一点；" + requirement + "；简短一点"
        self.assertEqual(continued["effective_input"]["user_instruction"], full)
        self.assertEqual(len(full), 4106)
        contact_id = UUID(path.split("/")[3])
        message_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            source_id = uuid4()
            connection.execute(
                "INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-adopt.jsonl',%s,1)",
                (source_id, self.owner_id, contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                "VALUES (%s,%s,%s,'contact','text','合成新消息：今天的安排已变化。',now())",
                (message_id, self.owner_id, contact_id),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic:adopt','{}'::jsonb)",
                (message_id, self.owner_id, contact_id, source_id),
            )
        new_content = {**continued["effective_input"], "user_instruction": None}
        if mode == "reply_to_message":
            new_content["target_message_id"] = str(message_id)
        before = self._get(self.backend, path)
        body = {"contact_id": str(contact_id), "idempotency_key": str(uuid4()),
                "expected_input_version_id": continued["input_version_id"],
                "adopt_new_message_id": str(message_id), "content": new_content}
        # 普通公开声明不能借已保存长要求放宽4096；本命令不上传长正文。
        status, invalid = self.backend.request(path + "/replies/prepare", {
            **body, "idempotency_key": str(uuid4()), "content": {**new_content, "user_instruction": full},
        })
        self.assertEqual(status, 400, invalid)
        self.assertEqual(self._get(self.backend, path), before)
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.assertEqual(set(prepared), {"session_id", "turn_id", "request_key", "input_version_id", "state"})
        self.assertEqual(prepared["request_key"], body["idempotency_key"])
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        claimed = self._get(self.backend, path)
        self.assertEqual(claimed["turns"][-1]["input"]["content"].get("user_instruction"), full)
        self.assertEqual(claimed["turns"][:2], before["turns"])
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, prepared))
        status, completed = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, completed)
        self.assertEqual(completed["turn_id"], prepared["turn_id"])
        self.assertEqual(completed["input_version_id"], prepared["input_version_id"])
        payload = next(json.loads(message.content) for message in self.reply_model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertEqual(payload["user_instruction"], full)
        if workspace:
            self.assertEqual(payload["input_mode"], "workspace")
            self.assertEqual(payload["workspace_action"], mode)
            self.assertEqual(payload["context_text"], content["context_text"])
            self.assertEqual(claimed["turns"][-1]["input"]["content"], continued["effective_input"])
            self.assertIn(str(message_id), json.dumps(payload))
        else:
            self.assertEqual(payload["confirmed_direction" if mode == "reply_to_message" else "confirmed_purpose"],
                             continued["effective_input"]["direction" if mode == "reply_to_message" else "purpose"])
        budget = completed["input_budget"]
        self.assertTrue(budget["allowed"])
        self.assertEqual(budget["total_tokens"], budget["input_tokens"] + budget["output_reserve_tokens"])
        self.assertEqual(self.backend.request(path + "/replies", body), (200, completed))
        self.assertEqual(len(self.reply_model.seen_calls), 3)
        # 已领取键换关联消息不能获得零领取证明，更不能改已有副本。
        saved = self._get(self.backend, path)
        changed_message = str(uuid4())
        status, conflict = self.backend.request(path + "/replies/prepare", {
            **body, "adopt_new_message_id": changed_message,
            "content": {**new_content, **({"target_message_id": changed_message} if mode == "reply_to_message" else {})},
        })
        self.assertEqual(status, 409, conflict)
        self.assertNotIn("no_generation", conflict)
        self.assertEqual(self._get(self.backend, path), saved)
        # 原replace接缝必须恢复准备中的完整要求，失效旧键与新CURRENT同事务提交。
        held = {**body, "idempotency_key": str(uuid4()), "expected_input_version_id": completed["input_version_id"]}
        status, held_receipt = self.backend.request(path + "/replies/prepare", held)
        self.assertEqual(status, 200, held_receipt)
        replacement = {**body, "idempotency_key": str(uuid4()), "expected_input_version_id": held_receipt["input_version_id"]}
        replacement_body = {"running_request_key": held["idempotency_key"], "replacement": replacement}
        status, replaced = self.backend.request(path + "/replace/prepare", replacement_body)
        self.assertEqual(status, 200, replaced)
        self.assertEqual(self.backend.request(path + "/replace/prepare", replacement_body), (200, replaced))
        latest = self._get(self.backend, path)
        self.assertEqual(latest["current_input_version_id"], replaced["input_version_id"])
        self.assertEqual(latest["turns"][-1]["input"]["content"]["user_instruction"], full)
        self.assertEqual(latest["turns"][-2]["state"], "failed")
        self.assertEqual(len(self.reply_model.seen_calls), 3)
        # GET后原来源待删除但worker未清CURRENT时，新采用须有正式未领取证明。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s", (source_id,))
        invalidated_before = self._get(self.backend, path)
        refused = {**replacement, "idempotency_key": str(uuid4()), "expected_input_version_id": replaced["input_version_id"]}
        status, rejection = self.backend.request(path + "/replies/prepare", refused)
        self.assertEqual(status, 409, rejection)
        self.assertEqual(rejection["no_generation"], {"contact_id": str(contact_id),
            "session_id": path.split("/")[5], "request_key": refused["idempotency_key"], "state": "not_reserved"})
        self.assertEqual(self._get(self.backend, path), invalidated_before)
        self.assertEqual(self.backend.request(path + "/replies", refused)[0], 409)
        self.assertEqual(self._get(self.backend, path), invalidated_before)
        self.assertEqual(len(self.reply_model.seen_calls), 3)

    def test_response_adopts_new_message_with_full_current_requirements(self):
        self._adopt("reply_to_message")

    def test_proactive_adopts_new_message_with_full_current_requirements(self):
        self._adopt("initiate_conversation")

    def test_workspace_express_adopts_new_message_with_full_current_requirements(self):
        self._adopt("express")

    def test_workspace_suggest_adopts_new_message_with_full_current_requirements(self):
        self._adopt("suggest")
