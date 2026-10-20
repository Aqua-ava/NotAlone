"""明确长期偏好的公开 HTTP、隔离 PostgreSQL 与实际回复行为。"""

from __future__ import annotations

import unittest
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from urllib.request import Request, urlopen

import psycopg
from langchain_core.messages import HumanMessage

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, ScriptedCoreModel, tool_response,
)


class PreferenceAwareModel(ScriptedCoreModel):
    """外部模型边界按公开载荷做可控选择；不证明真人语义质量。"""
    entered: object = None

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()

    def wait_for_response(self):
        if len(self.seen_calls) in self.response_gates:
            self.entered.set()
        super().wait_for_response()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
        preferences = payload.get("expression_preferences", [])
        if payload.get("user_instruction") == "这次详细说明，保留两句话。":
            text = "好的，收到安排。我会再核对具体内容。"
        elif preferences:
            text = "好。"
        else:
            text = "好的，收到安排，我会再核对具体内容。"
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": text, "basis": "保留本次原意并组织说法",
                            "citation_ids": [payload["evidence"][0]["evidence_id"]], "risk_notes": []}],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


class ExpressionPreferencesHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    dimension_release = None
    reply_model_factory = PreferenceAwareModel

    def setUp(self) -> None:
        super().setUp()
        self.contact_id, self.second_contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            for identifier in (self.contact_id, self.second_contact_id):
                connection.execute(
                    "INSERT INTO public.contact(owner_id,id,display_name) "
                    "VALUES (%s,%s,'偏好验收合成联系人')",
                    (self.owner_id, identifier),
                )
        self.path = "/api/expression-preferences"
        self.list_path = f"{self.path}?contact_id={self.contact_id}"

    def test_private_preference_directory_cannot_be_cached_after_deletion(self) -> None:
        request = Request(
            self.backend.base_url + self.list_path,
            headers={"Authorization": f"Bearer {self.backend.token}"},
        )
        with urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")

    def test_explicit_save_is_retrievable_idempotent_and_owner_isolated(self) -> None:
        self.assertEqual(self._get(self.backend, self.list_path)["preferences"], [])
        operation_key = str(uuid4())
        body = {
            "operation_key": operation_key,
            "text": "平时少用感叹号。",
            "scope": {"contact_id": None, "reply_mode": None},
            "origin": {"kind": "manual"},
            "confirm_long_term": True,
        }
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        preference = saved["preference"]
        self.assertEqual(preference["text"], "平时少用感叹号。")
        self.assertEqual(preference["scope"], body["scope"])
        self.assertEqual(preference["confirmed_operation_key"], operation_key)
        self.assertEqual(preference["origin"], {"kind": "manual"})
        self.assertEqual(self._get(self.backend, self.list_path)["preferences"], [preference])
        self.assertEqual(self.backend.request(self.path, body), (200, saved))
        self.assertEqual(self._get(self.other_backend, self.path)["preferences"], [])
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        self.assertEqual(self.backend.request(item), (200, saved))
        self.assertEqual(self.other_backend.request(item)[0], 404)
        self.assertEqual(self.backend.request(self.path, {**body, "text": "换个要求"})[0], 409)
        self.assertEqual(self.backend.request(self.path, {**body, "operation_key": str(uuid4()), "confirm_long_term": False})[0], 400)
        self.assertEqual(self.backend.request(self.path, {key: value for key, value in body.items() if key != "confirm_long_term"})[0], 400)
        self.assertEqual(self.backend.request(self.path, {**body, "confirm_long_term": "以后也许"})[0], 400)
        self.assertEqual(self._get(self.backend, self.list_path)["preferences"], [preference])

    def test_user_can_change_scope_and_delete_without_old_operations_restoring_text(self) -> None:
        body = {
            "operation_key": str(uuid4()), "text": "长期使用短句。",
            "scope": {"contact_id": None, "reply_mode": None},
            "origin": {"kind": "manual"}, "confirm_long_term": True,
        }
        saved = self.backend.request(self.path, body)[1]["preference"]
        item = f"{self.path}/{saved['preference_id']}?contact_id={self.contact_id}"
        update = {
            "operation_key": str(uuid4()), "expected_revision": saved["revision"],
            "text": "对这位联系人改写时保留称呼。",
            "scope": {"contact_id": str(self.contact_id), "reply_mode": "rewrite_draft"},
            "confirm_long_term": True,
        }
        status, changed = self.backend.request(item, update, method="PATCH")
        self.assertEqual(status, 200, changed)
        preference = changed["preference"]
        self.assertEqual(preference["scope"], update["scope"])
        self.assertEqual(preference["text"], update["text"])
        self.assertEqual(preference["revision"], 2)
        self.assertEqual(preference["confirmed_operation_key"], update["operation_key"])
        self.assertEqual(self.backend.request(item, update, method="PATCH"), (200, changed))
        stale = {**update, "operation_key": str(uuid4()), "text": "旧版本不能覆盖新要求。"}
        self.assertEqual(self.backend.request(item, stale, method="PATCH")[0], 409)
        self.assertEqual(self.backend.request(self.path, body)[0], 409)
        restored = self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored, self.list_path)["preferences"], [preference])
        deletion = {"operation_key": str(uuid4()), "expected_revision": 2}
        self.assertEqual(self.other_backend.request(item, deletion, method="DELETE")[0], 404)
        self.assertEqual(restored.request(item, deletion, method="DELETE"), (200, {"state": "deleted"}))
        self.assertEqual(restored.request(item, deletion, method="DELETE"), (200, {"state": "deleted"}))
        self.assertEqual(self._get(self.backend, self.list_path)["preferences"], [])
        self.assertEqual(self.backend.request(item)[0], 410)
        self.assertEqual(self.backend.request(self.path, body)[0], 410)
        self.assertEqual(self.backend.request(item, update, method="PATCH")[0], 410)

    def test_directory_and_item_reads_are_filtered_by_selected_contact_before_returning_text(self) -> None:
        global_preference = self._save("本人全局可管理的合成要求。")
        first = self._save("甲联系人专属正文。", contact_id=self.contact_id)
        second = self._save("乙联系人专属正文不得进入甲范围。", contact_id=self.second_contact_id)
        selected = f"?contact_id={self.contact_id}"
        first_path = self.path + selected
        self.assertCountEqual(self.backend.request(first_path)[1]["preferences"], [global_preference, first])
        self.assertEqual(self.backend.request(self.path), (200, {"preferences": [global_preference]}))
        self.assertCountEqual(self.backend.request(f"{self.path}?contact_id={self.second_contact_id}")[1]["preferences"],
                              [global_preference, second])
        unknown = str(uuid4())
        self.assertEqual(self.backend.request(f"{self.path}?contact_id={unknown}"),
                         (404, {"error": "expression_preference_not_found"}))
        self.assertEqual(self.other_backend.request(first_path), (404, {"error": "expression_preference_not_found"}))
        second_item = f"{self.path}/{second['preference_id']}"
        self.assertEqual(self.backend.request(second_item), (404, {"error": "expression_preference_not_found"}))
        self.assertEqual(self.backend.request(second_item + selected), (404, {"error": "expression_preference_not_found"}))
        change = {"operation_key": str(uuid4()), "expected_revision": 1, "text": "跨范围更改不能成功。",
                  "scope": {"contact_id": str(self.contact_id), "reply_mode": None}, "confirm_long_term": True}
        self.assertEqual(self.backend.request(second_item + selected, change, method="PATCH"),
                         (404, {"error": "expression_preference_not_found"}))
        self.assertEqual(self.backend.request(second_item + selected, {"operation_key": str(uuid4()), "expected_revision": 1}, method="DELETE"),
                         (404, {"error": "expression_preference_not_found"}))
        restored = self._production_backend(self.owner_id)
        self.assertCountEqual(restored.request(first_path)[1]["preferences"], [global_preference, first])
        self.assertEqual(restored.request(second_item + selected), (404, {"error": "expression_preference_not_found"}))

    def test_unknown_selected_contact_cannot_create_global_preference(self) -> None:
        body = {"operation_key": str(uuid4()), "text": "无有效选中联系人时不能保存的合成要求。",
                "scope": {"contact_id": None, "reply_mode": None}, "origin": {"kind": "manual"}, "confirm_long_term": True}
        self.assertEqual(self.backend.request(f"{self.path}?contact_id={uuid4()}", body),
                         (404, {"error": "expression_preference_not_found"}))
        self.assertEqual(self.other_backend.request(self.list_path, body),
                         (404, {"error": "expression_preference_not_found"}))
        self.assertEqual(self.backend.request(self.path), (200, {"preferences": []}))
        self.assertEqual(self.other_backend.request(self.path), (200, {"preferences": []}))

    def _save(self, text, *, contact_id=None, reply_mode=None, origin=None):
        body = {"operation_key": str(uuid4()), "text": text,
                "scope": {"contact_id": None if contact_id is None else str(contact_id), "reply_mode": reply_mode},
                "origin": origin or {"kind": "manual"}, "confirm_long_term": True}
        status, response = self.backend.request(self.path, body)
        self.assertEqual(status, 200, response)
        return response["preference"]

    def _bind(self, contact_id):
        self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=contact_id, channel="wechat",
            account_scope="synthetic-preference-account", conversation_locator=f"synthetic-{contact_id}",
        )

    def _generate(self, contact_id, *, instruction=None, include_relationship_context=False):
        body = {"contact_id": str(contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "好的，收到安排，我会再核对具体内容。",
                            "user_instruction": instruction,
                            "include_relationship_context": include_relationship_context}}
        status, response = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, response)
        payload = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage))
        return response, payload, body

    def test_next_reply_reads_applicable_preferences_and_current_instruction_wins(self) -> None:
        self._bind(self.contact_id)
        self._bind(self.second_contact_id)
        baseline, _, _ = self._generate(self.contact_id)
        self.assertEqual(baseline["candidates"][0]["text"], "好的，收到安排，我会再核对具体内容。")
        global_preference = self._save("平时尽量用短句。")
        specific = self._save("对这位联系人改写时也尽量简短。", contact_id=self.contact_id, reply_mode="rewrite_draft")
        self._save("只在主动联系时使用这个合成要求。", contact_id=self.contact_id, reply_mode="initiate_conversation")
        short, payload, _ = self._generate(self.contact_id)
        self.assertEqual(short["candidates"][0]["text"], "好。")
        self.assertEqual({row["preference_id"] for row in payload["expression_preferences"]},
                         {global_preference["preference_id"], specific["preference_id"]})
        self.assertEqual(set(short["context_receipt"]["expression_preference_ids"]),
                         {global_preference["preference_id"], specific["preference_id"]})
        self.assertEqual(payload["fidelity_contract"]["priority"][:3],
                         ["current_explicit_intent", "expression_instruction", "long_term_expression_preference"])
        current, payload, _ = self._generate(self.contact_id, instruction="这次详细说明，保留两句话。")
        self.assertEqual(current["candidates"][0]["text"], "好的，收到安排。我会再核对具体内容。")
        self.assertEqual(current["context_receipt"]["expression_preference_ids"], [])
        self.assertNotIn("expression_preferences", payload)
        self.assertEqual(payload["user_instruction"], "这次详细说明，保留两句话。")
        self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], "好的，收到安排，我会再核对具体内容。")
        other, payload, _ = self._generate(self.second_contact_id)
        self.assertEqual(other["candidates"][0]["text"], "好。")
        self.assertEqual([row["preference_id"] for row in payload["expression_preferences"]], [global_preference["preference_id"]])
        self.assertEqual(len(self._get(self.backend, self.list_path)["preferences"]), 3)

    def test_deleting_preference_clears_derived_reply_and_old_key_cannot_restore_it(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("长期偏好删除后不能恢复的合成要求。")
        reply, _, body = self._generate(self.contact_id)
        evidence_path = f"/api/contacts/{self.contact_id}/replies/{reply['reply_request_id']}/evidence"
        self.assertEqual(self.backend.request(evidence_path)[0], 200)
        deletion = {"operation_key": str(uuid4()), "expected_revision": preference["revision"]}
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        self.assertEqual(self.backend.request(item, deletion, method="DELETE")[0], 200)
        self.assertEqual(self.backend.request(evidence_path)[0], 404)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        continuation = {**body, "idempotency_key": str(uuid4()),
                        "continued_from_candidate_id": reply["candidates"][0]["candidate_id"]}
        self.assertEqual(self.backend.request("/api/reply/generate", continuation), (409, {"error": "reply_continuation_invalid"}))
        restored = self._production_backend(self.owner_id)
        self.assertEqual(restored.request(evidence_path)[0], 404)
        self.assertEqual(restored.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        fresh, payload, _ = self._generate(self.contact_id)
        self.assertNotEqual(fresh["candidates"][0]["text"], "好。")
        self.assertEqual(payload.get("expression_preferences", []), [])

    def _source_message(self):
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                """INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                   VALUES (%s,%s,%s,'wechat_jsonl','synthetic-preference.jsonl',%s,1)""",
                (source_id, self.owner_id, self.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES (%s,%s,%s,'user','text','合成的表达讨论。')",
                (message_id, self.owner_id, self.contact_id),
            )
            connection.execute(
                """INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                   VALUES (%s,%s,%s,'source_document',%s,'synthetic-1','{}')""",
                (message_id, self.owner_id, self.contact_id, source_id),
            )
        return source_id, message_id

    def _delete_source(self, source_id):
        path = f"/api/contacts/{self.contact_id}/sources"
        status, response = self.backend.request(f"{path}/{source_id}", method="DELETE")
        self.assertEqual(status, 202, response)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            source = next(row for row in self._get(self.backend, path)["sources"] if row["source_id"] == str(source_id))
            self.assertNotEqual(source["task_status"], "failed", source)
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                return
            time.sleep(.02)
        self.fail("合成来源删除未完成。")

    def test_source_linked_preference_keeps_origin_and_source_delete_erases_all_derived_content(self) -> None:
        source_id, message_id = self._source_message()
        self._bind(self.contact_id)
        origin = {"kind": "message", "id": str(message_id)}
        preference = self._save("用户明确长期保存的来源相关表达要求。", contact_id=self.contact_id, origin=origin)
        self.assertEqual(preference["origin"], origin)
        self.assertEqual(set(preference["source_ids"]), {str(source_id), str(message_id)})
        reply, _, _ = self._generate(self.contact_id)
        evidence_path = f"/api/contacts/{self.contact_id}/replies/{reply['reply_request_id']}/evidence"
        self._delete_source(source_id)
        self.assertEqual(self._get(self.backend, self.list_path)["preferences"], [])
        self.assertEqual(self.backend.request(f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}")[0], 410)
        self.assertEqual(self.backend.request(evidence_path)[0], 404)
        late = {"operation_key": str(uuid4()), "text": "不能用已删来源重建的长期要求。",
                "scope": {"contact_id": str(self.contact_id), "reply_mode": None},
                "origin": origin, "confirm_long_term": True}
        self.assertEqual(self.backend.request(self.path, late)[0], 404)
        restored = self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored, self.list_path)["preferences"], [])

    def test_delete_during_model_response_rejects_late_result_and_recovery(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("正在生成时删除的长期要求。")
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "合成的本次草稿。"}}
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.backend.request, "/api/reply/generate", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5), "模型前实际依赖未准备完成。")
                item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
                deletion = {"operation_key": str(uuid4()), "expected_revision": preference["revision"]}
                self.assertEqual(self.backend.request(item, deletion, method="DELETE")[0], 200)
            finally:
                gate.set()
            self.assertEqual(pending.result(timeout=10), (409, {"error": "expression_preferences_changed"}))
        self.assertEqual(self.backend.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        restored = self._production_backend(self.owner_id)
        self.assertEqual(restored.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        self.assertEqual(self._get(restored, self.list_path)["preferences"], [])

    def test_current_assistant_requirement_skips_preferences_and_preserves_independent_history(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("平时用短句，本次明确详细说明时服从本次要求。")
        status, session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "好的，收到安排，我会再核对具体内容。",
                            "user_instruction": "这次详细说明，保留两句话。"}}
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        status, generated = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], prepared["turn_id"])
        self.assertEqual(generated["candidates"][0]["text"], "好的，收到安排。我会再核对具体内容。")
        self.assertEqual(generated["context_receipt"]["expression_preference_ids"], [])
        payload = next(json.loads(item.content) for call in reversed(self.reply_model.seen_calls)
                       for item in call if isinstance(item, HumanMessage)
                       and json.loads(item.content).get("generation_stage") != "candidate_fidelity_review")
        self.assertNotIn("expression_preferences", payload)
        self.assertEqual(payload["user_instruction"], body["content"]["user_instruction"])
        self.assertEqual(self._get(self.backend, path)["turns"][0]["reply"]["reply_request_id"], generated["reply_request_id"])
        deletion = {"operation_key": str(uuid4()), "expected_revision": preference["revision"]}
        self.assertEqual(self.backend.request(f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}", deletion, method="DELETE")[0], 200)
        snapshot = self._get(self.backend, path)
        self.assertEqual(snapshot["turns"][0]["state"], "completed")
        self.assertEqual(snapshot["turns"][0]["reply"]["reply_request_id"], generated["reply_request_id"])
        self.assertEqual(self.backend.request(path + "/replies", body), (200, generated))
        restored = self._production_backend(self.owner_id)
        self.assertEqual(self._get(restored, path), snapshot)
        self.assertEqual(restored.request(path + "/replies", body), (200, generated))

    def test_generation_preference_receipt_keeps_readable_original_snapshot_after_update_and_recovery(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("生成时用户要求保留称呼并使用短句。", contact_id=self.contact_id, reply_mode="rewrite_draft")
        status, session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "合成本次草稿，不含长期要求。"}}
        status, generated = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        expected = [{key: preference[key] for key in ("preference_id", "text", "scope", "revision")}]
        self.assertEqual(generated["context_receipt"]["expression_preferences"], expected)
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        changed = {"operation_key": str(uuid4()), "expected_revision": 1, "text": "修改后只用于主动联系的新要求。",
                   "scope": {"contact_id": str(self.contact_id), "reply_mode": "initiate_conversation"}, "confirm_long_term": True}
        self.assertEqual(self.backend.request(item, changed, method="PATCH")[0], 200)
        restored = self._production_backend(self.owner_id)
        turn = self._get(restored, path)["turns"][0]
        self.assertEqual(turn["reply"]["context_receipt"]["expression_preferences"], expected)
        self.assertEqual(restored.request(path + "/replies", body), (200, generated))
        self.assertEqual(restored.request(item)[1]["preference"]["text"], changed["text"])
        self.assertEqual(restored.request(item, {"operation_key": str(uuid4()), "expected_revision": 2}, method="DELETE")[0], 200)
        erased = self._get(self._production_backend(self.owner_id), path)
        self.assertEqual(erased["turns"][0]["state"], "redacted")
        self.assertIsNone(erased["turns"][0]["reply"])
        self.assertNotIn(preference["text"], json.dumps(erased, ensure_ascii=False))

    def test_multiturn_recovery_returns_each_generation_preference_snapshot_and_delete_erases_both(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("第一轮生成时的合成要求：保留称呼。", contact_id=self.contact_id, reply_mode="rewrite_draft")
        status, session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "第一轮用户明确草稿。"}}
        status, first = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, first)
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        update = {"operation_key": str(uuid4()), "expected_revision": 1, "text": "第二轮生成时的合成要求：用短句。",
                  "scope": {"contact_id": None, "reply_mode": None}, "confirm_long_term": True}
        status, changed = self.backend.request(item, update, method="PATCH")
        self.assertEqual(status, 200, changed)
        status, second = self.backend.request(path + "/replies", {
            **body, "idempotency_key": str(uuid4()), "expected_input_version_id": first["input_version_id"],
            "content": {"type": "rewrite_draft", "draft_text": "第二轮用户明确的新草稿。"},
        })
        self.assertEqual(status, 200, second)
        restored = self._production_backend(self.owner_id)
        turns = self._get(restored, path)["turns"]
        self.assertEqual(len(turns), 2)
        for turn, reply, expected in zip(turns, (first, second), (preference, changed["preference"]), strict=True):
            self.assertEqual(turn["reply"]["reply_request_id"], reply["reply_request_id"])
            self.assertEqual(turn["reply"]["context_receipt"]["expression_preferences"], [
                {key: expected[key] for key in ("preference_id", "text", "scope", "revision")},
            ])
        self.assertEqual(restored.request(item, {"operation_key": str(uuid4()), "expected_revision": 2}, method="DELETE")[0], 200)
        erased = self._get(self._production_backend(self.owner_id), path)
        self.assertTrue(all(turn["state"] == "redacted" and turn["reply"] is None for turn in erased["turns"]))
        for text in (preference["text"], update["text"]):
            self.assertNotIn(text, json.dumps(erased, ensure_ascii=False))


    def test_contact_deletion_erases_cross_contact_preference_derivatives(self) -> None:
        from notalone.persistence.contact_deletion import delete_contact
        from notalone.scopes import ContactScope

        self._bind(self.second_contact_id)
        independent, _, _ = self._generate(self.second_contact_id)
        original = {"operation_key": str(uuid4()), "text": "最初属于全局的明确合成要求。",
                    "scope": {"contact_id": None, "reply_mode": None},
                    "origin": {"kind": "manual"}, "confirm_long_term": True}
        global_path = f"{self.path}?contact_id={self.second_contact_id}"
        status, saved = self.backend.request(global_path, original)
        self.assertEqual(status, 200, saved)
        preference = saved["preference"]
        reply, _, reply_command = self._generate(self.second_contact_id)
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        self.assertEqual(self.backend.request(item, {
            "operation_key": str(uuid4()), "expected_revision": 1, "text": "现在只用于甲的合成要求。",
            "scope": {"contact_id": str(self.contact_id), "reply_mode": None}, "confirm_long_term": True,
        }, method="PATCH")[0], 200)
        scope = ContactScope(self.owner_id, self.contact_id)
        self.assertFalse(delete_contact(self.database_url, ContactScope(self.other_owner_id, self.contact_id)))
        tombstone = self._save("已删除的甲范围合成偏好。", contact_id=self.contact_id)
        self.assertEqual(self.backend.request(f"{self.path}/{tombstone['preference_id']}?contact_id={self.contact_id}", {
            "operation_key": str(uuid4()), "expected_revision": 1,
        }, method="DELETE")[0], 200)
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DELETE FROM public.contact WHERE owner_id=%s AND id=%s", (self.owner_id, self.contact_id))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE FUNCTION synthetic_contact_delete_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$")
            connection.execute("CREATE TRIGGER synthetic_contact_delete_fault BEFORE DELETE ON public.contact FOR EACH ROW EXECUTE FUNCTION synthetic_contact_delete_fault()")
        try:
            with self.assertRaises(psycopg.Error):
                delete_contact(self.database_url, scope)
            self.assertEqual(self.backend.request(item)[0], 200)
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DROP TRIGGER synthetic_contact_delete_fault ON public.contact")
        self.assertTrue(delete_contact(self.database_url, scope))
        self.assertFalse(delete_contact(self.database_url, scope))
        restored = self._production_backend(self.owner_id)
        self.assertEqual(restored.request("/api/reply/generate", reply_command)[0], 409)
        evidence = f"/api/contacts/{self.second_contact_id}/replies/{independent['reply_request_id']}/evidence"
        self.assertEqual(restored.request(evidence)[0], 200)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.expression_preference WHERE owner_id=%s AND contact_id=%s", (self.owner_id, self.contact_id)).fetchone()[0], 0)
        self.assertEqual(restored.request(global_path, original), (410, {"error": "expression_preference_deleted"}))

    def test_owner_deletion_clears_contact_preferences_without_fk_order_failure(self) -> None:
        self._save("账户删除时也须清理的合成偏好。", contact_id=self.contact_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=%s", (self.owner_id,))
            self.assertEqual(connection.execute("SELECT count(*) FROM public.expression_preference WHERE owner_id=%s", (self.owner_id,)).fetchone()[0], 0)



    def test_previous_candidate_keeps_preference_dependency_when_current_mode_no_longer_applies(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("历史继续候选的明确长期要求。", contact_id=self.contact_id, reply_mode="rewrite_draft")
        first, _, body = self._generate(self.contact_id)
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        self.assertEqual(self.backend.request(item, {
            "operation_key": str(uuid4()), "expected_revision": 1, "text": preference["text"],
            "scope": {"contact_id": str(self.contact_id), "reply_mode": "initiate_conversation"}, "confirm_long_term": True,
        }, method="PATCH")[0], 200)
        continuation = {**body, "idempotency_key": str(uuid4()),
                        "continued_from_candidate_id": first["candidates"][0]["candidate_id"]}
        status, second = self.backend.request("/api/reply/generate", continuation)
        self.assertEqual(status, 200, second)
        self.assertEqual(second["context_receipt"]["expression_preference_ids"], [])
        payload = next(json.loads(row.content) for row in self.reply_model.seen_calls[-1] if isinstance(row, HumanMessage))
        previous = [row for row in payload["evidence"] if row["kind"] == "continued_candidate"]
        self.assertEqual([row["text"] for row in previous], [first["candidates"][0]["text"]])
        self.assertEqual(self.backend.request(item, {"operation_key": str(uuid4()), "expected_revision": 2}, method="DELETE")[0], 200)
        restored = self._production_backend(self.owner_id)
        self.assertEqual(restored.request("/api/reply/generate", continuation), (409, {"error": "reply_input_invalidated"}))



    def test_active_session_history_keeps_preference_dependency_after_scope_change(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("历史候选使用的明确长期要求。", contact_id=self.contact_id, reply_mode="rewrite_draft")
        status, session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "第一轮合成明确草稿。"}}
        status, first = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, first)
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        change = {"operation_key": str(uuid4()), "expected_revision": 1, "text": preference["text"],
                  "scope": {"contact_id": str(self.contact_id), "reply_mode": "initiate_conversation"}, "confirm_long_term": True}
        self.assertEqual(self.backend.request(item, change, method="PATCH")[0], 200)
        next_body = {**body, "idempotency_key": str(uuid4()), "expected_input_version_id": first["input_version_id"],
                     "content": {"type": "rewrite_draft", "draft_text": "当前独立意图优先的第二轮草稿。"}}
        status, second = self.backend.request(path + "/replies", next_body)
        self.assertEqual(status, 200, second)
        self.assertEqual(second["context_receipt"]["expression_preference_ids"], [])
        payload = next(json.loads(row.content) for row in self.reply_model.seen_calls[-1] if isinstance(row, HumanMessage))
        self.assertIn(first["candidates"][0]["text"], json.dumps(payload["assistant_discussion"], ensure_ascii=False))
        self.assertEqual(self.backend.request(item, {"operation_key": str(uuid4()), "expected_revision": 2}, method="DELETE")[0], 200)
        restored = self._production_backend(self.owner_id)
        remaining = self._get(restored, path)
        self.assertTrue(all(turn["state"] == "redacted" and turn["reply"] is None for turn in remaining["turns"]))
        self.assertNotEqual(restored.request(path + "/replies", next_body)[0], 200)

    def test_persistence_fault_rolls_back_save_and_delete_then_same_operation_recovers(self) -> None:
        body = {"operation_key": str(uuid4()), "text": "失败后原动作重试的合成要求。",
                "scope": {"contact_id": None, "reply_mode": None}, "origin": {"kind": "manual"}, "confirm_long_term": True}
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""CREATE FUNCTION synthetic_preference_fault() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'synthetic preference persistence failure'; END $$""")
            connection.execute("CREATE TRIGGER synthetic_preference_save_fault BEFORE INSERT ON public.expression_preference_operation "
                               "FOR EACH ROW EXECUTE FUNCTION synthetic_preference_fault()")
        try:
            self.assertEqual(self.backend.request(self.path, body), (503, {"error": "expression_preference_unavailable"}))
            self.assertEqual(self._get(self.backend, self.list_path)["preferences"], [])
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DROP TRIGGER synthetic_preference_save_fault ON public.expression_preference_operation")
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.backend.request(self.path, body), (200, saved))
        self._bind(self.contact_id)
        reply, _, reply_body = self._generate(self.contact_id)
        evidence = f"/api/contacts/{self.contact_id}/replies/{reply['reply_request_id']}/evidence"
        item = f"{self.path}/{saved['preference']['preference_id']}?contact_id={self.contact_id}"
        deletion = {"operation_key": str(uuid4()), "expected_revision": 1}
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE TRIGGER synthetic_preference_delete_fault BEFORE UPDATE ON public.expression_preference "
                               "FOR EACH ROW WHEN (NEW.status='deleted') EXECUTE FUNCTION synthetic_preference_fault()")
        try:
            self.assertEqual(self.backend.request(item, deletion, method="DELETE"), (503, {"error": "expression_preference_unavailable"}))
            self.assertEqual(self.backend.request(item), (200, saved))
            self.assertEqual(self.backend.request(evidence)[0], 200)
            self.assertEqual(self.backend.request("/api/reply/generate", reply_body), (200, reply))
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DROP TRIGGER synthetic_preference_delete_fault ON public.expression_preference")
                connection.execute("DROP FUNCTION synthetic_preference_fault()")
        self.assertEqual(self.backend.request(item, deletion, method="DELETE"), (200, {"state": "deleted"}))
        self.assertEqual(self.backend.request(item, deletion, method="DELETE"), (200, {"state": "deleted"}))
        self.assertEqual(self.backend.request(evidence)[0], 404)
        self.assertEqual(self._get(self._production_backend(self.owner_id), self.list_path)["preferences"], [])

    def test_source_delete_during_model_response_rejects_late_result_and_same_key(self) -> None:
        self._bind(self.contact_id)
        source_id, message_id = self._source_message()
        preference = self._save("仅由合成消息明确保存的长期要求。", contact_id=self.contact_id,
                                origin={"kind": "message", "id": str(message_id)})
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "合成本次草稿。"}}
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.backend.request, "/api/reply/generate", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                self._delete_source(source_id)
            finally:
                gate.set()
            self.assertEqual(pending.result(timeout=10), (409, {"error": "expression_preferences_changed"}))
        self.assertEqual(self.backend.request(f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"),
                         (410, {"error": "expression_preference_deleted"}))
        restored = self._production_backend(self.owner_id)
        self.assertEqual(restored.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        self.assertEqual(self._get(restored, self.list_path)["preferences"], [])

    def test_update_during_model_response_rejects_old_snapshot_and_retry_reads_new_version(self) -> None:
        self._bind(self.contact_id)
        preference = self._save("更新前的明确长期要求。")
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "合成本次草稿。"}}
        gate = self.reply_model.pause_next_response()
        update = {"operation_key": str(uuid4()), "expected_revision": 1, "text": "更新后用户明确的新要求。",
                  "scope": {"contact_id": None, "reply_mode": None}, "confirm_long_term": True}
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.backend.request, "/api/reply/generate", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, changed = self.backend.request(f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}", update, method="PATCH")
                self.assertEqual(status, 200, changed)
            finally:
                gate.set()
            self.assertEqual(pending.result(timeout=10), (409, {"error": "expression_preferences_changed"}))
        restored = self._production_backend(self.owner_id)
        status, recovered = restored.request("/api/reply/generate", body)
        self.assertEqual(status, 200, recovered)
        self.assertEqual(recovered["context_receipt"]["expression_preference_ids"], [preference["preference_id"]])
        payload = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage))
        self.assertEqual(payload["expression_preferences"][0]["text"], update["text"])
        self.assertEqual(payload["expression_preferences"][0]["revision"], 2)
        self.assertEqual(self._get(restored, self.list_path)["preferences"], [changed["preference"]])

    def test_prepared_manual_preference_is_erased_before_any_reply_request(self) -> None:
        self._assert_prepared_preference_erasure(message_origin=False)

    def test_prepared_message_preference_source_is_erased_before_any_reply_request(self) -> None:
        self._assert_prepared_preference_erasure(message_origin=True)

    def _assert_prepared_preference_erasure(self, *, message_origin):
        self._bind(self.contact_id)
        if message_origin:
            source_id, message_id = self._source_message()
            preference = self._save("来源参与准备但没有实际生成的合成偏好。", contact_id=self.contact_id,
                                    origin={"kind": "message", "id": str(message_id)})
        else:
            preference = self._save("只参与准备但没有实际生成的手录偏好。")
        status, session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "不依赖偏好正文的本次独立草稿。"}}
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,)).fetchone()[0], 0)
        if message_origin:
            self._delete_source(source_id)
        else:
            item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
            self.assertEqual(self.backend.request(item, {"operation_key": str(uuid4()), "expected_revision": 1}, method="DELETE")[0], 200)
        # 在任何GET恢复之前核验固定正文，不允许延迟读取时才清空。
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute("SELECT prepared_context,input_payload FROM public.assistant_session_turn WHERE id=%s", (receipt['turn_id'],)).fetchone()
            self.assertEqual(row, (None, None))
            payloads = connection.execute("SELECT content FROM public.assistant_session_input WHERE owner_id=%s", (self.owner_id,)).fetchall()
            self.assertNotIn(preference['text'], json.dumps(payloads, ensure_ascii=False))
        restarted = self._production_backend(self.owner_id)
        self.assertNotEqual(restarted.request(path + "/replies", body)[0], 200)
        self.assertEqual(self.reply_model.seen_calls, [])

    def test_prepared_preference_restart_keeps_exact_receipt_and_update_requires_explicit_reprepare(self):
        self._bind(self.contact_id)
        preference = self._save("准备时明确保存的原版本合成偏好。")
        status, session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "准备后重启仍须保留本次草稿。"}}
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        restarted = self._production_backend(self.owner_id)
        status, generated = restarted.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], receipt["turn_id"])
        self.assertEqual(generated["context_receipt"]["expression_preferences"][0]["text"], preference["text"])
        calls_after_generation = len(self.reply_model.seen_calls)
        self.assertEqual(calls_after_generation, 1)
        self.assertEqual(self.reply_model.review_calls, 0)
        second_body = {**body, "idempotency_key": str(uuid4())}
        status, second = restarted.request(path + "/replies/prepare", second_body)
        self.assertEqual(status, 200, second)
        item = f"{self.path}/{preference['preference_id']}?contact_id={self.contact_id}"
        update = {"operation_key": str(uuid4()), "expected_revision": 1,
                  "text": "后来明确修改的新版本合成偏好。", "scope": preference["scope"], "confirm_long_term": True}
        self.assertEqual(restarted.request(item, update, method="PATCH")[0], 200)
        status, rejected = restarted.request(path + "/replies", second_body)
        self.assertEqual((status, rejected), (409, {"error": "assistant_session_rejected",
                                                   "reason": "prepared_context_reprepare_required"}))
        self.assertEqual(len(self.reply_model.seen_calls), calls_after_generation)
        fresh_body = {**body, "idempotency_key": str(uuid4())}
        self.assertEqual(restarted.request(path + "/replies/prepare", fresh_body)[0], 200)
        status, fresh = restarted.request(path + "/replies", fresh_body)
        self.assertEqual(status, 200, fresh)
        self.assertEqual(fresh["context_receipt"]["expression_preferences"][0]["revision"], 2)
        self.assertEqual(fresh["context_receipt"]["expression_preferences"][0]["text"], update["text"])
