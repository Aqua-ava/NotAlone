"""变化元数据经正式资料与回复接口保留旧记录未知。"""
import unittest
import psycopg
from psycopg.types.json import Jsonb
from uuid import UUID, uuid4

from notalone.memory_extraction.dimensions import DimensionRelease
from tests.fidelity_http_support import FidelityControlledModel
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server import test_memory_conditions as conditions_support
from tests.integration.server.test_memory_event_updates import EventScriptedModel


class MemoryEvolutionReplyHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = DimensionRelease(gate_enabled=False)
    extraction_model_factory = EventScriptedModel
    reply_model_factory = FidelityControlledModel
    import_condition = conditions_support.MemoryConditionsHttpTest.import_condition

    def test_legacy_memory_and_frozen_reply_keep_evolution_unknown(self):
        imported = self.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。",
            when="2024-02-01T10:00:00+08:00", fact_overrides={"category": "taboo"})
        contact = imported["contact_id"]
        memory = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"][0]
        self.assertIsNone(memory["evolution"])
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat",
            account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "方便时我们再联系。", "basis": "保留出差期间的限定。"})
        status, reply = self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "出差期间不便通话。", "include_relationship_context": True}})
        self.assertEqual(status, 200, reply)
        item = next(item for item in self.reply_model.payloads[-1]["evidence"] if item["kind"] == "confirmed_memory")
        self.assertIsNone(item["evolution"])
        restored = self._get(self._backend(self.owner_id), f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")
        self.assertIsNone(next(item for item in restored["evidence"] if item["kind"] == "confirmed_memory")["evolution"])


class MemoryEvolutionTimelineReplyHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    from tests.integration.server.test_memory_timeline import TimelineModel
    from tests.integration.server.test_memory_event_updates import MemoryEventUpdatesHttpTest
    dimension_release = DimensionRelease(gate_enabled=False)
    extraction_model_factory = TimelineModel
    reply_model_factory = FidelityControlledModel
    import_event = MemoryEventUpdatesHttpTest.import_event
    delete_source = MemoryEventUpdatesHttpTest.delete_source

    def test_historical_evolution_reaches_model_freeze_restore_and_source_deletion(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。", when="2030-04-01T10:00:00+08:00")
        contact = first["contact_id"]
        self.extraction_model.relation_kind = "historical_supplement"
        second = self.import_event(original="我去年住在甲地。", claim="联系人去年住在甲地。", when="2030-05-01T10:00:00+08:00", contact_id=contact)
        rows = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"]
        history = next(row for row in rows if row["text"] == "联系人去年住在甲地。")
        evolution = history["evolution"]
        self.assertEqual(evolution["kind"], "historical_supplement")
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat",
            account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "记得你提过去年住在甲地。", "basis": "保留历史经历，不推定现状。"})
        status, reply = self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "联系人去年住在甲地。", "include_relationship_context": True}})
        self.assertEqual(status, 200, reply)
        actual = next(item for item in self.reply_model.payloads[-1]["evidence"] if item["evidence_id"] == history["memory_id"])
        self.assertEqual(actual["evolution"], evolution)
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        restored = self._get(self._backend(self.owner_id), path)
        self.assertEqual(next(item for item in restored["evidence"] if item["evidence_id"] == history["memory_id"])["evolution"], evolution)
        self.assertNotIn("proof", next(item for item in restored["evidence"] if item["evidence_id"] == history["memory_id"])["evolution"])
        # 合成旧快照缺字段时，只恢复当时未知，不能从当前资料补写。
        with psycopg.connect(self.database_url) as connection:
            snapshot = connection.execute("SELECT context_snapshot FROM public.reply_request WHERE id=%s", (reply["reply_request_id"],)).fetchone()[0]
            for item in snapshot["evidence"]:
                item.pop("evolution", None)
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s", (Jsonb(snapshot), reply["reply_request_id"]))
        legacy = self._get(self._backend(self.owner_id), path)
        self.assertIsNone(next(item for item in legacy["evidence"] if item["evidence_id"] == history["memory_id"])["evolution"])
        self.delete_source(contact, second["source"]["source_id"])
        self.assertEqual(self._backend(self.owner_id).request(path)[0], 404)

    def test_later_conflict_changes_basis_notice_without_rewriting_frozen_evolution(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。", when="2030-04-01T10:00:00+08:00")
        contact = first["contact_id"]
        memory = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"][0]
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat",
            account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "你提到住在乙地。", "basis": "只复述已有来源。"})
        status, reply = self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "联系人目前住在乙地。", "include_relationship_context": True}})
        self.assertEqual(status, 200, reply)
        self.extraction_model.relation_kind = "unresolved_conflict"
        self.import_event(original="我目前住在甲地。", claim="联系人目前住在甲地。", when="2030-04-01T11:00:00+08:00", contact_id=contact)
        current = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"]
        self.assertEqual(next(item for item in current if item["memory_id"] == memory["memory_id"])["evolution"]["kind"], "unresolved_conflict")
        restored = self._get(self._backend(self.owner_id), f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")
        self.assertIsNone(next(item for item in restored["evidence"] if item["evidence_id"] == memory["memory_id"])["evolution"])
        self.assertIn({"evidence_id": memory["memory_id"], "kind": "confirmed_memory", "reason": "memory_revised"}, restored["basis_changes"])

    def test_selected_old_fact_carries_conflict_and_counterevidence_deletion_retires_reply(self):
        first = self.import_event(original="我目前住在蓝海园区。", claim="联系人目前住在蓝海园区。", when="2030-04-01T10:00:00+08:00")
        contact = first["contact_id"]
        previous = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"][0]
        self.extraction_model.relation_kind = "unresolved_conflict"
        second = self.import_event(original="我目前住在青山大厦。", claim="联系人目前住在青山大厦。", when="2030-04-01T11:00:00+08:00", contact_id=contact)
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat",
            account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "关于蓝海园区，想再确认一下。", "basis": "来源存在矛盾，保留未知。"})
        status, reply = self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "蓝海园区", "include_relationship_context": True}})
        self.assertEqual(status, 200, reply)
        evidence = self.reply_model.payloads[-1]["evidence"]
        memories = [item for item in evidence if item["kind"] in {"confirmed_memory", "pending_candidate"}]
        self.assertEqual([item["evidence_id"] for item in memories], [previous["memory_id"]])
        evolution = memories[0]["evolution"]
        self.assertEqual(evolution["kind"], "unresolved_conflict")
        self.assertIn(second["message"]["message_id"], evolution["evidence_message_ids"])
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        restored = self._get(self._backend(self.owner_id), path)
        self.assertEqual(next(item for item in restored["evidence"] if item["evidence_id"] == previous["memory_id"])["evolution"], evolution)
        self.delete_source(contact, second["source"]["source_id"])
        self.assertEqual(self._backend(self.owner_id).request(path)[0], 404)
        current = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"]
        self.assertEqual(next(item for item in current if item["memory_id"] == previous["memory_id"])["status"], "active")

    def test_new_conflict_prevents_reusing_old_layered_summary_but_keeps_bounded_l1(self):
        from unittest.mock import patch
        from langchain_core.messages import SystemMessage
        from notalone.reply.layered_context import LayeredReplyBudget
        from notalone.server.app import create_app
        from notalone.server.reply_wiring import build_reply_service
        from tests.input_budget_support import synthetic_budget_kwargs
        from tests.integration.server.core_business_flow_support import HttpBackend
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        first = self.import_event(original="我们共同参加过蓝海课程。", claim="双方共同参加过蓝海课程。", when="2030-04-01T10:00:00+08:00")
        contact = first["contact_id"]
        memory = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"][0]
        management = LayeredProfileHttpTest.controlled(self)
        layered_path = f"/api/contacts/{contact}/layered-memory"
        state = self._get(management, layered_path)["layered_memory"]
        status, ready = management.request(layered_path + "/enable", {"settings_generation": state["settings_generation"], "purpose_confirmed": True})
        self.assertEqual(status, 200, ready)
        profile = ready["layered_memory"]["profile"]
        self.assertIsNotNone(profile)
        old_summary = profile["entries"][0]["text"]
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat",
            account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.reply_model):
            service = build_reply_service(database_url=self.database_url, owner_id=self.owner_id,
                layered_memory=self.service, layered_reply_budget=LayeredReplyBudget(4, 4, 4000),
                **synthetic_budget_kwargs(self.reply_model))
        replies = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token="synthetic-layered-evolution", reply_service=service), self.owner_id)
        self.addCleanup(replies.close)
        def generate():
            self.reply_model.plans.append({"text": "想聊聊蓝海课程。", "basis": "保留资料的不确定性。"})
            status, reply = replies.request("/api/reply/generate", {"contact_id": contact, "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "蓝海课程", "include_relationship_context": True}})
            self.assertEqual(status, 200, reply)
            return self._get(replies, f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")
        before = generate()
        self.assertEqual(before["layered_context"]["profile_version_id"], profile["version_id"])
        self.assertIn(old_summary, "\n".join(str(message.content) for message in self.reply_model.seen_calls[-1] if isinstance(message, SystemMessage)))
        self.extraction_model.relation_kind = "unresolved_conflict"
        self.import_event(original="我们没有一起学过这些内容。", claim="双方没有共同学习经历。", when="2030-04-01T11:00:00+08:00", contact_id=contact)
        after = generate()
        self.assertIsNone(after["layered_context"], "旧背景与主题目录必须因反证失去生成资格。")
        self.assertNotIn(old_summary, "\n".join(str(message.content) for message in self.reply_model.seen_calls[-1] if isinstance(message, SystemMessage)))
        actual = next(item for item in self.reply_model.payloads[-1]["evidence"] if item["evidence_id"] == memory["memory_id"])
        self.assertEqual(actual["evolution"]["kind"], "unresolved_conflict")

    def test_new_state_reply_does_not_treat_retired_relation_parent_as_used_fact(self):
        first = self.import_event(original="我目前住在蓝海园区。", claim="联系人目前住在蓝海园区。", when="2030-04-01T10:00:00+08:00")
        contact = first["contact_id"]
        previous = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"][0]
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat",
            account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "想聊聊蓝海园区。", "basis": "引用当时资料。"})
        status, old_reply = self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "蓝海园区", "include_relationship_context": True}})
        self.assertEqual(status, 200, old_reply)
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        self.import_event(original="我搬到青山大厦了。", claim="联系人目前住在青山大厦。", when="2030-05-01T10:00:00+08:00", contact_id=contact, action="update", replaced_id=previous["memory_id"])
        rows = self._get(self.backend, f"/api/contacts/{contact}/memories")["memories"]
        self.assertEqual(next(item for item in rows if item["memory_id"] == previous["memory_id"])["status"], "invalidated")
        current = next(item for item in rows if item["status"] == "active")
        old_evidence = self._get(self._backend(self.owner_id), f"/api/contacts/{contact}/replies/{old_reply['reply_request_id']}/evidence")
        self.assertIn("memory_generation_forbidden", [item["reason"] for item in old_evidence.get("basis_changes", [])])
        self.reply_model.plans.append({"text": "想聊聊青山大厦。", "basis": "引用新资料。"})
        status, reply = self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "青山大厦", "include_relationship_context": True}})
        self.assertEqual(status, 200, reply)
        memories = [item for item in self.reply_model.payloads[-1]["evidence"] if item["kind"] == "confirmed_memory"]
        self.assertEqual([item["evidence_id"] for item in memories], [current["memory_id"]])
        restored = self._get(self._backend(self.owner_id), f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")
        self.assertNotIn("memory_generation_forbidden", [item["reason"] for item in restored.get("basis_changes", [])])
        self.delete_source(contact, first["source"]["source_id"])
        self.assertEqual(self._backend(self.owner_id).request(f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")[0], 404)
