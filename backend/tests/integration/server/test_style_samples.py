"""合成公开 HTTP → 隔离 PostgreSQL 表达样本生命周期。"""

from __future__ import annotations

import unittest
import time
from uuid import uuid4

import psycopg
from psycopg import sql
from langchain_core.messages import HumanMessage
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.persistence.locks import try_acquire_global_worker_lock, release_global_worker_lock

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, ScriptedCoreModel, tool_response


class ObservedGateModel(ScriptedCoreModel):
    entered: object = None

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()

    def wait_for_response(self):
        if len(self.seen_calls) in self.response_gates:
            self.entered.set()
        super().wait_for_response()


class StyleSampleHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    reply_model_factory = ObservedGateModel
    def setUp(self) -> None:
        super().setUp()
        self.contact_id, self.second_contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            for identifier in (self.contact_id, self.second_contact_id):
                connection.execute(
                    "INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成样本联系人')",
                    (self.owner_id, identifier),
                )
        self.path = f"/api/contacts/{self.contact_id}/style-samples"

    def _source_message(self, *, speaker="user", text="合成原始消息"):
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES (%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1)""",
                               (source_id, self.owner_id, self.contact_id, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES (%s,%s,%s,%s,'text',%s)",
                               (message_id, self.owner_id, self.contact_id, speaker, text))
            connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'source_document',%s,'synthetic-1','{}')""",
                               (message_id, self.owner_id, self.contact_id, source_id))
        return source_id, message_id

    def _delete_source(self, source_id):
        source_path = f"/api/contacts/{self.contact_id}/sources/{source_id}"
        status, response = self.backend.request(source_path, method="DELETE")
        self.assertEqual(status, 202, response)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            sources = self._get(self.backend, f"/api/contacts/{self.contact_id}/sources")["sources"]
            source = next(item for item in sources if item["source_id"] == str(source_id))
            self.assertNotEqual(source["task_status"], "failed", source)
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                return
            time.sleep(.02)
        self.fail("合成来源删除未完成。")

    def test_explicit_save_read_delete_and_retry_never_claims_sent(self) -> None:
        self.assertEqual(self._get(self.backend, self.path)["samples"], [])
        body = {"idempotency_key": str(uuid4()), "text": "好的，改天聊。",
                "origin": {"kind": "manual"}}
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["sample"]["sending_status"], "unknown")
        self.assertEqual(saved["sample"]["origin_kind"], "manual")
        self.assertEqual(self._get(self.backend, self.path)["samples"], [saved["sample"]])
        self.assertEqual(self.backend.request(self.path, body), (200, saved))
        other = f"/api/contacts/{self.second_contact_id}/style-samples/{saved['sample']['sample_id']}"
        self.assertEqual(self.backend.request(other, method="DELETE")[0], 404)
        self.assertEqual(self.other_backend.request(self.path)[0], 404)
        item = f"{self.path}/{saved['sample']['sample_id']}"
        self.assertEqual(self.backend.request(item, method="DELETE")[0], 200)
        self.assertEqual(self._get(self.backend, self.path)["samples"], [])
        self.assertEqual(self.backend.request(item)[0], 410)
        self.assertEqual(self.backend.request(self.path, body)[0], 410)
        self.assertEqual(self.backend.request(item, method="DELETE")[0], 200)

    def test_message_origin_cannot_be_laundered_and_source_delete_erases_sample(self):
        source_id, message_id = self._source_message()
        body = {"idempotency_key": str(uuid4()), "text": "编辑后的合成表达",
                "origin": {"kind": "message", "id": str(message_id)}}
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        self.assertEqual(set(saved["sample"]["source_ids"]), {str(source_id), str(message_id)})
        laundering = {"idempotency_key": str(uuid4()), "text": "合成原始消息", "origin": {"kind": "manual"}}
        self.assertEqual(self.backend.request(self.path, laundering)[0], 409)
        self.assertEqual(self.backend.request(self.path.replace(str(self.contact_id), str(self.second_contact_id)), body)[0], 404)
        self.assertEqual(self.backend.request(f"{self.path}/{saved['sample']['sample_id']}", method="DELETE")[0], 200)
        messages = self._get(self.backend, f"/api/contacts/{self.contact_id}/messages")["messages"]
        self.assertEqual([row["message_id"] for row in messages], [str(message_id)])
        body = {**body, "idempotency_key": str(uuid4())}
        self.assertEqual(self.backend.request(self.path, body)[0], 200)
        self._delete_source(source_id)
        self.assertEqual(self._get(self.backend, self.path)["samples"], [])
        self.assertEqual(self.backend.request(self.path, body)[0], 410)
        self.assertEqual(self.backend.request(self.path, {**body, "idempotency_key": str(uuid4())})[0], 404)

    def test_partial_storage_failure_rolls_back_and_can_be_retried(self):
        body = {"idempotency_key": str(uuid4()), "text": "合成删除失败样本", "origin": {"kind": "manual"}}
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""CREATE FUNCTION synthetic_fail_style_delete() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.status='deleted' THEN RAISE EXCEPTION 'synthetic_failure'; END IF; RETURN NEW; END $$""")
            connection.execute("CREATE TRIGGER synthetic_fail_style_delete BEFORE UPDATE ON public.style_sample FOR EACH ROW EXECUTE FUNCTION synthetic_fail_style_delete()")
        item = f"{self.path}/{saved['sample']['sample_id']}"
        try:
            self.assertEqual(self.backend.request(item, method="DELETE")[0], 503)
            self.assertEqual(self._get(self.backend, self.path)["samples"], [saved["sample"]])
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DROP TRIGGER synthetic_fail_style_delete ON public.style_sample")
                connection.execute("DROP FUNCTION synthetic_fail_style_delete()")
        self.assertEqual(self.backend.request(item, method="DELETE")[0], 200)
        self.assertEqual(self._get(self.backend, self.path)["samples"], [])

    def test_observation_source_delete_erases_sample_even_if_message_has_other_source(self):
        source_id, message_id = self._source_message()
        binding = self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                              account_scope="synthetic-account", conversation_locator="synthetic-observation")
        observation_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.local_wechat_observation(id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,last_local_id,last_cursor,record_count,event_count)
                VALUES (%s,%s,%s,%s,'live','synthetic','synthetic-observation',1,'synthetic-1',1,1)""",
                               (observation_id, self.owner_id, self.contact_id, binding.binding_id))
            connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'local_wechat_observation',%s,'synthetic-1','{}')""",
                               (message_id, self.owner_id, self.contact_id, observation_id))
        body = {"idempotency_key": str(uuid4()), "text": "多来源本人合成样本", "origin": {"kind": "message", "id": str(message_id)}}
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        self.assertEqual(set(saved["sample"]["source_ids"]), {str(message_id), str(source_id), str(observation_id)})
        # 现有观察来源删除公共入口；样本及消息结果仍从公开HTTP重读。
        PostgresObservationStore(self.database_url).delete_observation(owner_id=self.owner_id, contact_id=self.contact_id,
                                                                      observation_id=observation_id)
        self.assertEqual(self._get(self.backend, self.path)["samples"], [])
        messages = self._get(self.backend, f"/api/contacts/{self.contact_id}/messages")["messages"]
        self.assertEqual([row["message_id"] for row in messages], [str(message_id)])
        self.assertEqual(self.backend.request(self.path, body)[0], 410)

    def test_delete_requested_source_is_unavailable_before_worker_finishes(self):
        source_id, message_id = self._source_message()
        body = {"idempotency_key": str(uuid4()), "text": "来源待删合成样本", "origin": {"kind": "message", "id": str(message_id)}}
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            try:
                status, deleted = self.backend.request(f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE")
                self.assertEqual(status, 202, deleted)
                self.assertEqual(self._get(self.backend, self.path)["samples"], [])
                self.assertEqual(self.backend.request(f"{self.path}/{saved['sample']['sample_id']}")[0], 410)
                self.assertEqual(self.backend.request(self.path, body)[0], 410)
                self.assertEqual(self.backend.request(self.path, {**body, "idempotency_key": str(uuid4())})[0], 409)
            finally:
                release_global_worker_lock(gate)
        self._delete_source(source_id)

    def test_candidate_origin_keeps_dependencies_and_invalid_candidate_cannot_be_saved(self):
        source_id, message_id = self._source_message(speaker="contact")
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                     account_scope="synthetic-account", conversation_locator="synthetic-conversation")
        self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {"candidates": [{
            "text": "合成候选", "basis": "回应本次消息", "citation_ids": [str(message_id)], "risk_notes": [],
        }], "used_skill_version_id": None}))
        status, reply = self.backend.request("/api/reply/generate", {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "reply_to_message", "target_message_id": str(message_id), "direction": "自然回应"},
        })
        self.assertEqual(status, 200, reply)
        body = {"idempotency_key": str(uuid4()), "text": "用户修改后的合成候选",
                "origin": {"kind": "candidate", "id": reply["candidates"][0]["candidate_id"]}}
        status, saved = self.backend.request(self.path, body)
        self.assertEqual(status, 200, saved)
        self.assertIn(str(source_id), saved["sample"]["source_ids"])
        self._delete_source(source_id)
        self.assertEqual(self._get(self.backend, self.path)["samples"], [])

    def test_each_memory_kind_keeps_actual_raw_sources_and_pending_delete_gate(self):
        for kind in ("confirmed_memory", "owner_memory", "pending_candidate"):
            with self.subTest(kind=kind):
                source_id, message_id = self._source_message()
                second_source_id = uuid4()
                memory_id = uuid4()
                table = "memory_candidate" if kind == "pending_candidate" else kind
                with psycopg.connect(self.database_url) as connection:
                    connection.execute("""INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                        VALUES (%s,%s,%s,'wechat_jsonl','second-synthetic.jsonl',%s,1)""",
                                       (second_source_id, self.owner_id, self.contact_id, uuid4().hex * 2))
                    connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                        VALUES (%s,%s,%s,'source_document',%s,'synthetic-1','{}')""",
                                       (message_id, self.owner_id, self.contact_id, second_source_id))
                    fields = ["id", "owner_id", "text_content", "category", "source_ids"]
                    values = [memory_id, self.owner_id, "合成原始消息", "preference", [message_id]]
                    if kind != "owner_memory":
                        fields.append("contact_id"); values.append(self.contact_id)
                    if kind != "pending_candidate":
                        fields.append("adoption_method"); values.append("manual")
                    connection.execute(sql.SQL("INSERT INTO public.{} ({}) VALUES ({})").format(
                        sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, fields)),
                        sql.SQL(",").join(sql.Placeholder() for _ in fields)), values)
                if not self.bindings.list_active_bindings(owner_id=self.owner_id):
                    self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                                 account_scope="synthetic-account", conversation_locator="synthetic-conversation")
                self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {"candidates": [{
                    "text": "记忆来源合成候选", "basis": "仅保留当前草稿", "citation_ids": [str(self.draft_evidence_id)], "risk_notes": [],
                }], "used_skill_version_id": None}))
                generation_body = {
                    "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                    "content": {"type": "rewrite_draft", "draft_text": "合成原始消息", "include_relationship_context": True},
                }
                status, reply = self.backend.request("/api/reply/generate", generation_body)
                self.assertEqual(status, 200, reply)
                model_input = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage))
                self.assertTrue(any(item["evidence_id"] == str(memory_id) and item["kind"] == kind for item in model_input["evidence"]))
                body = {"idempotency_key": str(uuid4()), "text": f"{kind}衍生合成样本",
                        "origin": {"kind": "candidate", "id": reply["candidates"][0]["candidate_id"]}}
                status, saved = self.backend.request(self.path, body)
                self.assertEqual(status, 200, saved)
                self.assertTrue({str(source_id), str(second_source_id)} <= set(saved["sample"]["source_ids"]))
                with psycopg.connect(self.database_url, autocommit=True) as gate:
                    self.assertTrue(try_acquire_global_worker_lock(gate))
                    try:
                        self.assertEqual(self.backend.request(f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE")[0], 202)
                        self.assertEqual(self.backend.request(f"{self.path}/{saved['sample']['sample_id']}")[0], 410)
                        self.assertEqual(self.backend.request(self.path, body)[0], 410)
                        calls = len(self.reply_model.seen_calls)
                        self.assertNotEqual(self.backend.request("/api/reply/generate", generation_body)[0], 200)
                        self.assertEqual(len(self.reply_model.seen_calls), calls)
                    finally:
                        release_global_worker_lock(gate)
                self._delete_source(source_id)
                self.assertEqual(self.backend.request(f"{self.path}/{saved['sample']['sample_id']}")[0], 410)
                messages = self._get(self.backend, f"/api/contacts/{self.contact_id}/messages")["messages"]
                self.assertIn(str(message_id), [row["message_id"] for row in messages])
                self.assertNotEqual(self.backend.request("/api/reply/generate", generation_body)[0], 200)
                self.assertEqual(len(self.reply_model.seen_calls), calls)

    def test_late_new_message_source_cannot_replace_pre_model_source_snapshot(self):
        source_id, message_id = self._source_message()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.confirmed_memory(owner_id,contact_id,text_content,category,source_ids,adoption_method)
                VALUES (%s,%s,'合成原始消息','preference',%s,'manual')""",
                               (self.owner_id, self.contact_id, [message_id]))
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                     account_scope="synthetic-account", conversation_locator="synthetic-conversation")
        self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {"candidates": [{
            "text": "迟到旧来源结果", "basis": "旧来源表达", "citation_ids": [str(self.draft_evidence_id)], "risk_notes": [],
        }], "used_skill_version_id": None}))
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "合成原始消息", "include_relationship_context": True}}
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.backend.request, "/api/reply/generate", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                with psycopg.connect(self.database_url) as connection:
                    second_source = uuid4()
                    connection.execute("""INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                        VALUES (%s,%s,%s,'wechat_jsonl','late-synthetic.jsonl',%s,1)""",
                                       (second_source, self.owner_id, self.contact_id, uuid4().hex * 2))
                    connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                        VALUES (%s,%s,%s,'source_document',%s,'late-1','{}')""",
                                       (message_id, self.owner_id, self.contact_id, second_source))
                with psycopg.connect(self.database_url, autocommit=True) as worker:
                    self.assertTrue(try_acquire_global_worker_lock(worker))
                    try:
                        self.assertEqual(self.backend.request(f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE")[0], 202)
                        gate.set()
                        status, result = pending.result(timeout=10)
                        self.assertNotEqual(status, 200, result)
                        self.assertNotIn("迟到旧来源结果", json.dumps(result))
                    finally:
                        release_global_worker_lock(worker)
            finally:
                gate.set()
        self._delete_source(source_id)

    def test_supported_manual_owner_memory_without_samples_still_generates(self):
        status, memory = self.backend.request("/api/memories/manual-owner", {"text": "合成原始消息", "category": "preference"})
        self.assertEqual(status, 200, memory)
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                     account_scope="synthetic-account", conversation_locator="synthetic-conversation")
        self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {"candidates": [{
            "text": "普通无样本合成候选", "basis": "保留本次原意", "citation_ids": [str(self.draft_evidence_id)], "risk_notes": [],
        }], "used_skill_version_id": None}))
        body = {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "合成原始消息", "include_relationship_context": True},
        }
        status, reply = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, reply)
        payload = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage))
        self.assertTrue(any(row["kind"] == "owner_memory" for row in payload["evidence"]))
        self.assertEqual(self.backend.request(f"/api/contacts/{self.contact_id}/replies/{reply['reply_request_id']}/evidence")[0], 200)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, reply))
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        status, saved = self.backend.request(self.path, {"idempotency_key": str(uuid4()), "text": "主动保存的独立说法",
            "origin": {"kind": "candidate", "id": reply["candidates"][0]["candidate_id"]}})
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["sample"]["source_ids"], [])

    def test_owner_sentinel_is_not_a_general_unknown_source_exemption(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method)
                VALUES (%s,%s,'合成原始消息','preference',%s,'auto')""", (uuid4(), self.owner_id, [self.owner_id]))
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                     account_scope="synthetic-account", conversation_locator="synthetic-conversation")
        status, result = self.backend.request("/api/reply/generate", {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "合成原始消息", "include_relationship_context": True},
        })
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.reply_model.seen_calls), 0)

    def test_continuation_inherits_raw_snapshot_and_pending_source_blocks_replay_and_continue(self):
        source_id, message_id = self._source_message()
        memory_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method)
                VALUES (%s,%s,%s,'合成原始消息','preference',%s,'manual')""",
                               (memory_id, self.owner_id, self.contact_id, [message_id]))
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                     account_scope="synthetic-account", conversation_locator="synthetic-conversation")
        for text in ("前序来源候选", "后继候选"):
            self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {"candidates": [{
                "text": text, "basis": "保留本次原意", "citation_ids": [str(self.draft_evidence_id)], "risk_notes": [],
            }], "used_skill_version_id": None}))
        base = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "合成原始消息", "include_relationship_context": True}}
        status, first = self.backend.request("/api/reply/generate", base)
        self.assertEqual(status, 200, first)
        model_input = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage))
        self.assertTrue(any(item["evidence_id"] == str(memory_id) for item in model_input["evidence"]))
        child = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                 "continued_from_candidate_id": first["candidates"][0]["candidate_id"],
                 "content": {"type": "rewrite_draft", "draft_text": "继续保留当前意图"}}
        status, second = self.backend.request("/api/reply/generate", child)
        self.assertEqual(status, 200, second)
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            try:
                self.assertEqual(self.backend.request(f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE")[0], 202)
                evidence_path = f"/api/contacts/{self.contact_id}/replies/{second['reply_request_id']}/evidence"
                self.assertEqual(self.backend.request(evidence_path)[0], 404)
                self.assertNotEqual(self.backend.request("/api/reply/generate", child)[0], 200)
                grandchild = {**child, "idempotency_key": str(uuid4()), "continued_from_candidate_id": second["candidates"][0]["candidate_id"]}
                self.assertNotEqual(self.backend.request("/api/reply/generate", grandchild)[0], 200)
                self.assertEqual(len(self.reply_model.seen_calls), 2)
            finally:
                release_global_worker_lock(gate)
        self._delete_source(source_id)

    def test_legacy_parent_cannot_hide_missing_snapshot_behind_new_child_sources(self):
        source_id, message_id = self._source_message()
        _, child_message_id = self._source_message(text="合成独立出行资料")
        with psycopg.connect(self.database_url) as connection:
            for identifier, text in ((message_id, "合成原始消息"), (child_message_id, "合成独立出行资料")):
                connection.execute("""INSERT INTO public.confirmed_memory(owner_id,contact_id,text_content,category,source_ids,adoption_method)
                    VALUES (%s,%s,%s,'preference',%s,'manual')""", (self.owner_id, self.contact_id, text, [identifier]))
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                                     account_scope="synthetic-account", conversation_locator="synthetic-conversation")
        for text in ("旧前序来源候选", "有新来源的后继候选"):
            self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {"candidates": [{
                "text": text, "basis": "保留本次原意", "citation_ids": [str(self.draft_evidence_id)], "risk_notes": [],
            }], "used_skill_version_id": None}))
        parent_body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                       "content": {"type": "rewrite_draft", "draft_text": "合成原始消息", "include_relationship_context": True}}
        status, parent = self.backend.request("/api/reply/generate", parent_body)
        self.assertEqual(status, 200, parent)
        child_body = {**parent_body, "idempotency_key": str(uuid4()),
                      "continued_from_candidate_id": parent["candidates"][0]["candidate_id"],
                      "content": {"type": "rewrite_draft", "draft_text": "合成独立出行资料", "include_relationship_context": True}}
        status, child = self.backend.request("/api/reply/generate", child_body)
        self.assertEqual(status, 200, child)
        payload = next(json.loads(item.content) for item in self.reply_model.seen_calls[-1] if isinstance(item, HumanMessage))
        self.assertTrue(any(item["kind"] == "confirmed_memory" and item["text"] == "合成独立出行资料" for item in payload["evidence"]))
        # 合成049前已有的请求：保留其当时正文/证据，移除当时不存在的raw快照记录。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.reply_original_source_use WHERE reply_request_id=%s", (parent["reply_request_id"],))

        def assert_unavailable():
            for reply, body in ((parent, parent_body), (child, child_body)):
                path = f"/api/contacts/{self.contact_id}/replies/{reply['reply_request_id']}/evidence"
                self.assertEqual(self.backend.request(path)[0], 404)
                self.assertNotEqual(self.backend.request("/api/reply/generate", body)[0], 200)
                continuation = {**child_body, "idempotency_key": str(uuid4()),
                                "continued_from_candidate_id": reply["candidates"][0]["candidate_id"]}
                self.assertNotEqual(self.backend.request("/api/reply/generate", continuation)[0], 200)
                sample = {"idempotency_key": str(uuid4()), "text": "旧候选不能保存的衍生表达",
                          "origin": {"kind": "candidate", "id": reply["candidates"][0]["candidate_id"]}}
                self.assertEqual(self.backend.request(self.path, sample)[0], 409)
            self.assertEqual(len(self.reply_model.seen_calls), 2)

        assert_unavailable()
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            try:
                self.assertEqual(self.backend.request(f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE")[0], 202)
                assert_unavailable()
            finally:
                release_global_worker_lock(gate)
        self._delete_source(source_id)


if __name__ == "__main__":
    unittest.main()
