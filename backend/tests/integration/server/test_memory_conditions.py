"""合成条件通过正式导入、独立核验与公开读取。"""
import json
import time
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
import psycopg
from psycopg.types.json import Jsonb
from datetime import datetime
from pathlib import Path
from uuid import uuid4, UUID
from tests.fidelity_http_support import FidelityControlledModel
from notalone.memory_extraction.dimensions import DimensionRelease
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, tool_response
from tests.integration.server import test_memory_event_updates as events

class MemoryConditionsHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = DimensionRelease(gate_enabled=False)
    extraction_model_factory = events.EventScriptedModel
    reply_model_factory = FidelityControlledModel
    delete_source = events.MemoryEventUpdatesHttpTest.delete_source

    def import_condition(
        self, *, original: str, claim: str, when: str,
        contact_id: str | None = None, subject: str = "contact",
        action: str = "keep", replaced_id: str | None = None,
        expect_failure: bool = False,
        fact_overrides: dict | None = None, additional_fact_overrides: tuple[dict, ...] = (),
        acknowledgement: str = "合成记录：已收到。",
        condition_supported: bool | None = True,
        event_spec: dict | None = None, event_verification: dict | None = None,
        additional_event_specs: tuple[dict, ...] = (),
        additional_fact_uses_all_sources: bool = False,
    ) -> dict:
        """用实际导入入口提交合成来源，模型响应在系统边界准备。"""
        timestamp = datetime.fromisoformat(when)
        if not hasattr(self, "event_locators"):
            self.event_locators = {}
        locator = self.event_locators.get(contact_id, f"wxid_synthetic_{uuid4().hex}")
        path = Path(self.temporary.name) / f"event-{uuid4().hex}.jsonl"
        records = []
        for number, from_me, text in (
            (1, subject == "self", original), (2, subject != "self", acknowledgement),
        ):
            records.append({
                "id": {"local_id": number, "server_id_str": uuid4().hex,
                       "talker": locator},
                "create_time": int(timestamp.timestamp()),
                "is_from_me": from_me, "kind": "text",
                "sender": "合成用户" if from_me else "合成事件联系人",
                "sender_wxid": (
                    f"wxid_synthetic_{self.backend.token}" if from_me else locator
                ),
                "text": text, "time": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "time_iso": when,
            })
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records),
                        encoding="utf-8")
        gate = self.extraction_model.pause_next_response()
        status, imported = self.backend.request("/api/imports/commit", {
            "path": str(path), **({"contact_id": contact_id} if contact_id else
                                  {"new_contact_name": "合成事件联系人"}),
        })
        self.assertEqual(status, 200, imported)
        contact_id = imported["contact_id"]
        self.event_locators[contact_id] = locator
        messages = self._get(self.backend, f"/api/contacts/{contact_id}/messages")["messages"]
        message = next(item for item in messages if item["text"] == original)
        source = next(item for item in self._get(
            self.backend, f"/api/contacts/{contact_id}/sources",
        )["sources"] if item["file_name"] == path.name)
        fact = {
            "text": claim, "category": "relationship_note", "subject": subject,
            "topic": "other", "source_message_ids": [message["message_id"]],
            "confidence": 0.95, "risk_flags": [], "valid_at": None,
            "invalid_at": None, "speech_act": "assertion",
            "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "合成来源中的直接陈述。",
        }
        if event_spec is not None:
            position = {"message_id": message["message_id"], "char_start": 0,
                        "char_end": len(original)}
            fact["event"] = {
                "version": 1, "stage": event_spec["stage"],
                "stage_evidence": [position],
                "occurrence_start": event_spec.get("occurrence_start"),
                "occurrence_end": event_spec.get("occurrence_end"),
                "occurrence_evidence": [position] if event_spec.get("occurrence_start") else [],
            }
        fact["conditions"] = {"version": 1, "items": [{"text": "出差期间", "evidence": [{"message_id": message["message_id"], "char_start": original.index("出差期间"), "char_end": original.index("出差期间") + 4}]}]}
        facts = [{**fact, **(fact_overrides or {})}, *({**fact, **extra} for extra in additional_fact_overrides)]
        for extra in additional_event_specs:
            facts.append({**fact, "event": {**fact["event"], **extra}})
        if additional_fact_uses_all_sources:
            facts[-1]["source_message_ids"] = [item["message_id"] for item in messages]
        scripts = [
            tool_response("MemoryExtractionOutput", {"facts": facts}),
            tool_response("SourceVerificationOutput", {"results": [{
                "candidate_index": index, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": message["message_id"], "quote": original}],
                **({"condition_verification": [{"index": 0, "verdict": "supported" if condition_supported else "uncertain", "evidence": facts[index]["conditions"]["items"][0]["evidence"]}]} if condition_supported is not None else {}),
                **({"event_verification": {**event_verification,
                    "stage_evidence": facts[index]["event"]["stage_evidence"],
                    "occurrence_evidence": facts[index]["event"]["occurrence_evidence"],
                }} if event_verification is not None else {}),
            } for index in range(len(facts))]}),
        ]
        if (len(messages) > 2 or len(facts) > 1
                or subject == "self" and self._get(self.backend, "/api/memories/owner")["memories"]):
            scripts.append(tool_response("MemoryAdjudicationOutput", {
                "action": action, "replaced_memory_id": replaced_id,
            }))
        self.extraction_model.responses.extend(scripts)
        gate.set()
        if expect_failure:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = self._get(self.backend, f"/api/tasks/status?contact_id={contact_id}")
                if state["status"] == "finished":
                    self.assertEqual(state["progress"]["status"], "failed", state)
                    break
                time.sleep(0.02)
            else:
                self.fail("合成故障任务未在时限内结束。")
        else:
            self._wait_finished(self.backend, contact_id)
        return {**imported, "message": message, "source": source, "scripts": scripts, "records": records}

    def test_condition_is_independently_verified_and_kept_without_a_deadline(self):
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", fact_overrides={"category": "taboo"})
        rows = self._get(self.backend, f"/api/contacts/{imported['contact_id']}/memories")["memories"]
        self.assertEqual(len(rows), 1)
        memory = rows[0]
        self.assertEqual(memory["conditions"]["items"][0]["text"], "出差期间")
        self.assertTrue(memory["conditions"]["items"][0]["source_supported"])
        self.assertIsNone(memory["invalid_at"])
        self.assertEqual(memory["timing"]["current_status"], "current_unverified")

    def test_owner_condition_reaches_model_frozen_reply_and_source_deletion(self):
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", subject="self", fact_overrides={"category": "taboo"})
        contact = imported["contact_id"]
        memory = self._get(self.backend, "/api/memories/owner")["memories"][0]
        self.assertTrue(memory["conditions"]["items"][0]["source_supported"])
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        layered_backend = LayeredProfileHttpTest.controlled(self)
        layered_path = "/api/memories/owner/layered-memory"
        state = self._get(layered_backend, layered_path)["layered_memory"]
        status, layered = layered_backend.request(layered_path + "/enable", {"settings_generation": state["settings_generation"], "purpose_confirmed": True})
        self.assertEqual(status, 200, layered)
        for ref in (layered["layered_memory"]["scenarios"][0]["paragraphs"][0]["references"][0], layered["layered_memory"]["profile"]["entries"][0]["references"][0]):
            self.assertEqual(ref["conditions"], memory["conditions"])
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat", account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "方便时我们再联系。", "basis": "保留出差期间的限定。"})
        status, reply = self.backend.request("/api/reply/generate", {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "出差期间不便通话。", "include_relationship_context": True}})
        self.assertEqual(status, 200, reply)
        item = next(item for item in self.reply_model.payloads[-1]["evidence"] if item["kind"] == "owner_memory")
        self.assertEqual(item["conditions"], memory["conditions"])
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        restored = self._get(self._backend(self.owner_id), path)
        self.assertEqual(next(item for item in restored["evidence"] if item["kind"] == "owner_memory")["conditions"], memory["conditions"])
        # 升级前已完成快照缺条件，恢复只保留当时未知。
        with psycopg.connect(self.database_url) as connection:
            snapshot = connection.execute("SELECT context_snapshot FROM public.reply_request WHERE id=%s", (reply["reply_request_id"],)).fetchone()[0]
            for item in snapshot["evidence"]:
                item.pop("conditions", None)
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s", (Jsonb(snapshot), reply["reply_request_id"]))
        legacy = self._get(self._backend(self.owner_id), path)
        self.assertIsNone(next(item for item in legacy["evidence"] if item["kind"] == "owner_memory")["conditions"])
        self.delete_source(contact, imported["source"]["source_id"])
        self.assertEqual(self._backend(self.owner_id).request(path)[0], 404)

    def test_manual_correction_preserves_unknown_condition_and_explicit_clear(self):
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", fact_overrides={"category": "taboo"})
        prefix = f"/api/contacts/{imported['contact_id']}"
        original = self._get(self.backend, prefix + "/memories")["memories"][0]
        status, result = self.backend.request(prefix + f"/memories/{original['memory_id']}/correct", {"text": "出差期间晚上不便通话。"})
        self.assertEqual(status, 200, result)
        changed = result["memory"]
        self.assertEqual(changed["conditions"]["items"][0]["text"], "出差期间")
        self.assertFalse(changed["conditions"]["items"][0]["source_supported"])
        status, result = self.backend.request(prefix + f"/memories/{changed['memory_id']}/correct", {"text": "晚上不便通话。", "conditions": None})
        self.assertEqual(status, 200, result)
        self.assertIsNone(result["memory"]["conditions"])

    def test_general_text_support_does_not_certify_conditions(self):
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", condition_supported=None)
        self.assertEqual(self._get(self.backend, f"/api/contacts/{imported['contact_id']}/memories")["memories"], [])

    def test_cross_contact_condition_position_is_rejected(self):
        first = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00")
        foreign = {"version": 1, "items": [{"text": "出差期间", "evidence": [{"message_id": first["message"]["message_id"], "char_start": 0, "char_end": 4}]}]}
        second = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2025-02-01T10:00:00+08:00", fact_overrides={"conditions": foreign})
        self.assertEqual(self._get(self.backend, f"/api/contacts/{second['contact_id']}/memories")["memories"], [])
        self.assertEqual(len(self._get(self.backend, f"/api/contacts/{first['contact_id']}/memories")["memories"]), 1)

    def test_condition_change_during_generation_rejects_late_reply(self):
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", fact_overrides={"category": "taboo"})
        contact = imported["contact_id"]
        memory = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"][0]
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat", account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "方便再联系。", "basis": "保留限定。"})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor() as executor:
            future = executor.submit(self.backend.request, "/api/reply/generate", {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "出差期间不便通话。", "include_relationship_context": True}})
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct", {"text": "出差期间不便通话。", "conditions": None})
                self.assertEqual(status, 200, corrected)
            finally:
                gate.set()
            status, result = future.result(timeout=10)
        self.assertNotEqual(status, 200, result)
        self.assertNotIn("candidates", result)

    def test_pending_condition_can_be_manually_adopted_without_becoming_source_verified(self):
        from notalone.tasks.worker import PostgresMemoryExtractionRunner
        def runner(*args, **kwargs):
            return PostgresMemoryExtractionRunner(*args, **kwargs, automatic=False)
        with patch("tests.integration.server.core_business_flow_support.PostgresMemoryExtractionRunner", runner):
            self.backend = self._backend(self.owner_id)
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", condition_supported=None)
        prefix = f"/api/contacts/{imported['contact_id']}"
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        self.assertFalse(pending["conditions"]["items"][0]["source_supported"])
        status, result = self.backend.request(prefix + f"/memory-candidates/{pending['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["memory"]["adoption_method"], "manual")
        self.assertEqual(result["memory"]["conditions"], pending["conditions"])
        self.assertEqual(result["memory"]["timing"]["current_status"], "current_unverified")

    def test_manual_owner_new_condition_never_reuses_old_support(self):
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", subject="self")
        memory = self._get(self.backend, "/api/memories/owner")["memories"][0]
        status, result = self.backend.request(f"/api/memories/owner/{memory['memory_id']}/correct", {"text": "开会期间不便通话。", "conditions": {"version": 1, "items": [{"text": "开会期间", "evidence": []}]}})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["memory"]["conditions"]["items"], [{"text": "开会期间", "evidence": [], "source_supported": False}])
