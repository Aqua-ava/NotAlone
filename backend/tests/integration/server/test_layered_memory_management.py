"""主题资料从公开管理 HTTP 穿过真实隔离库；模型边界仅接收合成资料。"""

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.memory.layered import OrganizationBudget
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import HttpBackend

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class LayeredMemoryManagementHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_unknown_quality_keeps_confirmed_contact_scope_closed_to_models(self):
        contact, _, _ = self.import_contact("合成联系人范围。")
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方共同参加合成课程。", "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        path = f"/api/contacts/{contact}/layered-memory"
        status, result = self.backend.request(path)
        self.assertEqual(status, 200, result)
        state = result["layered_memory"]
        self.assertEqual((state["enabled"], state["quality_status"], state["eligible_count"]),
                         (False, "unknown", 1))
        status, enabled = self.backend.request(path + "/enable", {
            "settings_generation": state["settings_generation"], "purpose_confirmed": True,
        })
        self.assertEqual(status, 200, enabled)
        self.assertEqual(enabled["layered_memory"]["status"], "blocked")
        self.assertEqual(enabled["layered_memory"]["scenarios"], [])
        self.assertEqual(self._get(self.backend, path)["layered_memory"]["status"], "blocked")

    def controlled(self, *, proposer=None, verifier=None, budget=None, clock=None, call_timeout_seconds=30):
        self.proposal = proposer or ControlledProposal()
        self.verification = verifier or ControlledVerification()
        self.service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url, clock=clock),
            proposer=self.proposal, verifier=self.verification, synthetic=True,
            budget=budget or OrganizationBudget(), call_timeout_seconds=call_timeout_seconds)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token="synthetic-layered-token", layered_memory=self.service), self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def enable(self, backend, contact):
        path = f"/api/contacts/{contact}/layered-memory"
        state = self._get(backend, path)["layered_memory"]
        status, result = backend.request(path + "/enable", {
            "settings_generation": state["settings_generation"], "purpose_confirmed": True,
        })
        self.assertEqual(status, 200, result)
        return result["layered_memory"]

    def test_finite_batch_publishes_traceable_system_document_and_reuses_unchanged_work(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        original = self.confirm(contact, "双方共同参加过课程。", message)
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方共同完成合成练习。", "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        backend = self.controlled(budget=OrganizationBudget(max_memories=1))
        state = self.enable(backend, contact)
        self.assertEqual((state["status"], state["covered_count"], state["remaining_count"]), ("ready", 1, 1))
        document = state["scenarios"][0]
        self.assertEqual(document["title"], "共同学习经历")
        self.assertTrue(document["system_generated"])
        self.assertEqual(document["paragraphs"][0]["text"], "双方共同参加过课程。")
        reference = document["paragraphs"][0]["references"][0]
        self.assertEqual((reference["memory_id"], reference["revision"]),
                         (original["memory_id"], original["revision"]))
        self.assertEqual(reference["provenance_kind"], "source_supported")
        self.assertEqual(reference["timing"]["current_status"], "current_unverified")
        self.assertEqual(len(self.proposal.inputs), 1)
        path = f"/api/contacts/{contact}/layered-memory"
        status, repeated = backend.request(path + "/refresh", {"settings_generation": state["settings_generation"]})
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated["layered_memory"]["scenarios"], state["scenarios"])
        self.assertEqual(len(self.proposal.inputs), 1)


    def test_deleting_an_uncited_input_erases_body_history_and_batch_artifacts(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        _, hidden_source, hidden_message = self.import_contact("合成背景：双方曾一起做练习。", contact_id=contact,
            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.confirm(contact, "双方曾一起做练习。", hidden_message)
        backend = self.controlled()
        ready = self.enable(backend, contact)
        self.assertEqual(ready["covered_count"], 2)
        self.assertEqual(len(ready["scenarios"][0]["paragraphs"][0]["references"]), 1)
        self.delete_source(contact, hidden_source)
        state = self._get(backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"]
        self.assertEqual(state["scenarios"], [])
        self.assertEqual(state["status"], "stale")
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            artifacts = connection.execute("SELECT count(*) FROM public.layered_memory_batch "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id,contact)).fetchone()[0]
        self.assertEqual(artifacts, 0, "完整删除依赖包括实际读入但未引用的输入、输出及历史")


    def test_disabled_documents_remain_viewable_delete_erases_artifacts_and_stale_aba_request_fails(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        memory = self.confirm(contact, "双方共同参加过课程。", message)
        backend = self.controlled()
        ready = self.enable(backend, contact)
        path = f"/api/contacts/{contact}/layered-memory"
        status, disabled = backend.request(path + "/disable", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, disabled)
        self.assertEqual(disabled["layered_memory"]["scenarios"], ready["scenarios"])
        status, repeated = backend.request(path + "/disable", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated, disabled)
        restored = self.enable(backend, contact)
        self.assertGreater(restored["settings_generation"], ready["settings_generation"])
        self.assertEqual(restored["scenarios"][0]["scenario_id"], ready["scenarios"][0]["scenario_id"])
        status, stale = backend.request(path + "/delete", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 409, stale)
        status, deleted = backend.request(path + "/delete", {"settings_generation": restored["settings_generation"]})
        self.assertEqual(status, 200, deleted)
        self.assertFalse(deleted["layered_memory"]["enabled"])
        self.assertEqual(deleted["layered_memory"]["scenarios"], [])
        self.assertEqual(self.overview(contact)["entries"][0]["memory"]["memory_id"], memory["memory_id"])
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.layered_memory_batch WHERE owner_id=%s "
                "AND contact_id=%s", (self.owner_id,contact)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_unknown_pending_and_other_contact_material_never_enter_actual_model_input(self):
        import psycopg
        from uuid import uuid4
        from notalone.memory.models import MemoryCandidate, MemoryCategory
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.scopes import ContactScope
        contact, _, message = self.import_contact("合成来历未知资料。")
        unknown = self.confirm(contact,"这条旧资料缺失原始证明。",message)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL WHERE id="
                "(SELECT source_candidate_id FROM public.confirmed_memory WHERE id=%s)", (unknown["memory_id"],))
        PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(candidate_id=uuid4(),
            scope=ContactScope(self.owner_id,UUID(contact)),text="尚未采纳的资料。",
            category=MemoryCategory.COMMON_FACT,source_ids=(message,)))
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact,"text": "双方共同参加过课程。","category": "common_fact",
        })
        self.assertEqual(status,200,manual)
        other, _, _ = self.import_contact("另一联系人隔离范围。")
        self.backend.request("/api/memories/manual-contact", {
            "contact_id": other,"text": "另一联系人私人资料。","category": "common_fact",
        })
        backend = self.controlled()
        ready = self.enable(backend,contact)
        self.assertEqual(ready["eligible_count"],1)
        self.assertEqual([item.text for item in self.proposal.inputs[0]], ["双方共同参加过课程。"])
        self.assertEqual(self.proposal.inputs[0][0].provenance_kind,"manual_entry")
        self.assertFalse(self._get(backend,f"/api/contacts/{other}/layered-memory")["layered_memory"]["enabled"])
        foreign = self._backend(uuid4())
        status, result = foreign.request(f"/api/contacts/{contact}/layered-memory")
        self.assertEqual(status,404,result)

    def test_non_finite_adapter_is_failed_with_a_bounded_wait_and_late_output_discarded(self):
        from threading import Event
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        release = Event()
        self.addCleanup(release.set)
        proposer = GatedProposal(release)
        backend = self.controlled(proposer=proposer, call_timeout_seconds=0.02)
        state = self.enable(backend, contact)
        self.assertEqual((state["status"],state["error_code"]), ("failed","model_call_timeout"))
        release.set()
        self.assertTrue(proposer.finished.wait(2))
        current = self._get(backend,f"/api/contacts/{contact}/layered-memory")["layered_memory"]
        self.assertEqual(current["scenarios"], [])
        self.assertEqual(current["status"], "failed")

    def test_complete_verification_input_over_budget_never_calls_verifier_or_publishes(self):
        contact, _, _ = self.import_contact("合成范围：核验输入也须有界。")
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "合成" * 1250, "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        verifier = RecordingVerification()
        backend = self.controlled(proposer=EchoProposal(), verifier=verifier)
        state = self.enable(backend, contact)
        self.assertEqual((state["status"], state["error_code"]),
                         ("failed", "verification_input_budget_exceeded"))
        self.assertEqual(verifier.inputs, [])
        self.assertEqual((state["scenarios"], state["covered_count"], state["remaining_count"]), ([], 0, 1))
        self.assertEqual(state["organization_generation"], 0)
        self.assertEqual(len(self.proposal.inputs), 1, "提案记忆和生成文字各自合法，但完整核验输入超限")
        self.assertEqual(self._get(backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"], state)

    def test_oversized_single_memory_pauses_without_sending_unbounded_model_input(self):
        contact, _, _ = self.import_contact("合成范围：有限输入。")
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "合成资料。" * 1000, "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)
        backend = self.controlled()
        state = self.enable(backend, contact)
        self.assertEqual((state["status"], state["error_code"], state["remaining_count"]),
                         ("failed", "input_budget_exceeded", 1))
        self.assertEqual(self.proposal.inputs, [])

    def test_late_verification_after_delete_and_reenable_cannot_cross_settings_aba(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        path = f"/api/contacts/{contact}/layered-memory"
        def delete_and_reenable():
            state = self._get(self.backend, path)["layered_memory"]
            status, deleted = self.backend.request(path+"/delete", {"settings_generation": state["settings_generation"]})
            self.assertEqual(status, 200, deleted)
            self.enable(self.backend, contact)
        backend = self.controlled(verifier=HookVerification(delete_and_reenable))
        state = self.enable(backend, contact)
        self.assertEqual(state["status"], "blocked")
        self.assertEqual(state["scenarios"], [])
        self.assertGreaterEqual(state["settings_generation"], 3)
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.layered_memory_batch WHERE owner_id=%s "
                "AND contact_id=%s", (self.owner_id,contact)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_clock_boundary_invalidates_a_frozen_current_paragraph_and_refresh_preserves_history(self):
        from notalone.scopes import ContactScope
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message,
            valid_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
            invalid_at=datetime(2099, 1, 2, tzinfo=timezone.utc))
        now = [datetime(2099, 1, 1, tzinfo=timezone.utc)]
        backend = self.controlled(clock=lambda: now[0])
        ready = self.enable(backend, contact)
        snapshot = self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        self.assertTrue(self.service.validate(snapshot))
        now[0] = datetime(2099, 1, 3, tzinfo=timezone.utc)
        self.assertFalse(self.service.validate(snapshot))
        path = f"/api/contacts/{contact}/layered-memory"
        self.assertEqual(self._get(backend,path)["layered_memory"]["status"], "stale")
        status, refreshed = backend.request(path+"/refresh", {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, refreshed)
        reference = refreshed["layered_memory"]["scenarios"][0]["paragraphs"][0]["references"][0]
        self.assertEqual(reference["timing"]["current_status"], "historical")
        self.assertEqual(datetime.fromisoformat(self.proposal.inputs[-1][0].invalid_at),
                         datetime(2099, 1, 2, tzinfo=timezone.utc))

    def test_public_read_port_freezes_one_generation_and_revokes_snapshot_on_disable(self):
        from notalone.scopes import ContactScope
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        backend = self.controlled()
        ready = self.enable(backend, contact)
        scope = ContactScope(self.owner_id, UUID(contact))
        snapshot = self.service.capture(scope)
        self.assertEqual(snapshot.organization_generation, ready["organization_generation"])
        self.assertTrue(self.service.validate(snapshot))
        document = self.service.read_scenario(snapshot, UUID(ready["scenarios"][0]["scenario_id"]), (0, 1))
        self.assertEqual(document["paragraphs"][0]["text"], "双方共同参加过课程。")
        self.assertEqual(document["version_id"], ready["scenarios"][0]["version_id"])
        status, disabled = backend.request(f"/api/contacts/{contact}/layered-memory/disable", {
            "settings_generation": ready["settings_generation"],
        })
        self.assertEqual(status, 200, disabled)
        self.assertFalse(self.service.validate(snapshot))
        self.assertIsNone(self.service.capture(scope))
        with self.assertRaises(Exception):
            self.service.read_scenario(snapshot, UUID(ready["scenarios"][0]["scenario_id"]), (0, 1))

    def test_empty_and_independent_verification_rejection_have_distinct_visible_states(self):
        contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
        backend = self.controlled(verifier=RejectVerification())
        empty = self.enable(backend, contact)
        self.assertEqual((empty["status"], empty["scenarios"]), ("empty", []))
        self.confirm(contact, "双方共同参加过课程。", message)
        status, failed = backend.request(f"/api/contacts/{contact}/layered-memory/refresh", {
            "settings_generation": empty["settings_generation"],
        })
        self.assertEqual(status, 200, failed)
        self.assertEqual(failed["layered_memory"]["status"], "failed")
        self.assertEqual(failed["layered_memory"]["error_code"], "faithfulness_rejected")
        self.assertEqual(failed["layered_memory"]["scenarios"], [])

    def test_correction_before_or_after_publish_cannot_restore_invalidated_body(self):
        for during_proposal in (False, True):
            with self.subTest(during_proposal=during_proposal):
                contact, _, message = self.import_contact("合成经历：双方共同参加过课程。")
                memory = self.confirm(contact, "双方共同参加过课程。", message)
                correction = lambda: self.backend.request(
                    f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct",
                    {"text": "双方分别上过课程，尚未共同参加。"})
                proposer = HookProposal(correction if during_proposal else None)
                backend = self.controlled(proposer=proposer)
                ready = self.enable(backend, contact)
                if not during_proposal:
                    self.assertEqual(ready["status"], "ready")
                    status, result = correction()
                    self.assertEqual(status, 200, result)
                state = self._get(backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"]
                self.assertEqual(state["scenarios"], [])
                self.assertEqual(state["status"], "stale")


class ControlledProposal:
    def __init__(self):
        self.inputs = []

    def propose(self, *, memories, budget):
        self.inputs.append(memories)
        return {"scenarios": [{"topic_key": "shared-learning", "title": "共同学习经历",
            "hint": "共同课程与学习经历", "paragraphs": [{"text": "双方共同参加过课程。",
            "references": [{"memory_id": str(memories[0].memory_id), "revision": memories[0].revision}]}]}]}


class ControlledVerification:
    def verify(self, *, memories, proposal):
        return True


class RejectVerification:
    def verify(self, *, memories, proposal):
        return False


class HookProposal(ControlledProposal):
    def __init__(self, hook):
        super().__init__()
        self.hook = hook

    def propose(self, *, memories, budget):
        proposal = super().propose(memories=memories, budget=budget)
        if self.hook:
            self.hook()
        return proposal


class HookVerification:
    def __init__(self, hook):
        self.hook = hook

    def verify(self, *, memories, proposal):
        self.hook()
        return True


class GatedProposal(ControlledProposal):
    def __init__(self, release):
        from threading import Event
        super().__init__()
        self.release, self.finished = release, Event()

    def propose(self, *, memories, budget):
        self.release.wait(3)
        try:
            return super().propose(memories=memories,budget=budget)
        finally:
            self.finished.set()


class EchoProposal(ControlledProposal):
    def propose(self, *, memories, budget):
        proposal = super().propose(memories=memories, budget=budget)
        proposal["scenarios"][0]["paragraphs"][0]["text"] = memories[0].text
        return proposal


class RecordingVerification:
    def __init__(self):
        self.inputs = []

    def verify(self, *, memories, proposal):
        self.inputs.append((memories, proposal))
        return True
