"""长期背景从公开管理 HTTP 到真实隔离 PG 的合成合同。"""

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.memory.layered import OrganizationBudget
from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import HttpBackend
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server.test_layered_memory_management import ControlledProposal, ControlledVerification


class ProfileProposal:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self, hook=None):
        self.inputs = []
        self.hook = hook

    def propose(self, *, scenarios, memories, budget, deadline):
        deadline.check()
        self.inputs.append((scenarios, memories))
        if self.hook:
            self.hook()
        return {"entries": [{"text": "双方有共同学习经历；目前是否持续共同学习尚未核实。",
            "temporal_status": "uncertain", "uncertainty": "当前持续情况未核实。",
            "references": [{"memory_id": str(memories[0].memory_id), "revision": memories[0].revision}]}]}


class ProfileVerification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self, supported=True, hook=None):
        self.supported, self.hook = supported, hook
        self.inputs = []

    def verify(self, *, scenarios, memories, proposal, deadline):
        deadline.check()
        self.inputs.append((scenarios, memories, proposal))
        if self.hook:
            self.hook()
        return self.supported


class LayeredProfileHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def controlled(self, *, profile_proposer=None, profile_verifier=None, clock=None, **options):
        self.profile_proposer = profile_proposer or ProfileProposal()
        self.profile_verifier = profile_verifier or ProfileVerification()
        self.service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url, clock=clock),
            proposer=ControlledProposal(), verifier=ControlledVerification(), synthetic=True,
            profile_proposer=self.profile_proposer, profile_verifier=self.profile_verifier, **options)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token="synthetic-profile-token", layered_memory=self.service), self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def prepare_contact(self):
        contact, source, message = self.import_contact("双方共同参加过合成课程。")
        memory = self.confirm(contact, "双方共同参加过课程。", message)
        return contact, source, memory

    def read(self, backend, contact):
        return self._get(backend, f"/api/contacts/{contact}/layered-memory")["layered_memory"]

    def enable(self, backend, contact):
        status, result = backend.request(f"/api/contacts/{contact}/layered-memory/enable", {
            "settings_generation": self.read(backend, contact)["settings_generation"], "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        return result["layered_memory"]

    def test_profile_has_direct_bottom_versions_and_frozen_consistent_directory(self):
        contact, _, memory = self.prepare_contact()
        backend = self.controlled()
        ready = self.enable(backend, contact)
        self.assertEqual((ready["schema_version"], ready["status"]), (2, "ready"))
        profile = ready["profile"]
        self.assertTrue(profile["system_generated"])
        entry = profile["entries"][0]
        self.assertEqual((entry["temporal_status"], entry["uncertainty"]),
                         ("uncertain", "当前持续情况未核实。"))
        reference = entry["references"][0]
        self.assertEqual((reference["memory_id"], reference["revision"]), (memory["memory_id"], memory["revision"]))
        self.assertEqual(reference["timing"]["current_status"], "current_unverified")
        snapshot = self.service.capture(ContactScope(self.owner_id, UUID(contact)))
        self.assertEqual(snapshot.schema_version, 2)
        self.assertEqual(str(snapshot.profile_version_id), profile["version_id"])
        self.assertEqual(snapshot.profile_entries, tuple(profile["entries"]))
        self.assertTrue(self.service.validate(snapshot))
        document = self.service.read_scenario(snapshot, UUID(ready["scenarios"][0]["scenario_id"]), (0, 1))
        self.assertEqual(document["organization_generation"], snapshot.organization_generation)
        self.assertEqual(document["version_id"], str(snapshot.scenarios[0].version_id))
        self.assertEqual([item.text for item in self.profile_proposer.inputs[0][1]], ["双方共同参加过课程。"])
        self.assertEqual(self.profile_proposer.inputs[0][0][0]["version_id"], document["version_id"])
        repeated = self._get_refresh(backend, contact, ready)
        self.assertEqual(repeated["profile"], profile)
        self.assertEqual(repeated["organization_generation"], ready["organization_generation"])

    def _get_refresh(self, backend, contact, state):
        status, result = backend.request(f"/api/contacts/{contact}/layered-memory/refresh", {
            "settings_generation": state["settings_generation"]})
        self.assertEqual(status, 200, result)
        return result["layered_memory"]

    def test_withdraw_current_profile_is_version_bound_idempotent_and_does_not_restore_old(self):
        contact, _, _ = self.prepare_contact()
        backend = self.controlled()
        ready = self.enable(backend,contact)
        frozen = self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        payload = {"settings_generation": ready["settings_generation"],
            "organization_generation": ready["organization_generation"],"profile_version_id": ready["profile"]["version_id"]}
        path = f"/api/contacts/{contact}/layered-memory/withdraw-profile"
        for _ in range(2):
            status,result = backend.request(path,payload)
            self.assertEqual(status,200,result)
            self.assertIsNone(result["layered_memory"]["profile"])
            self.assertEqual(result["layered_memory"]["scenarios"],ready["scenarios"])
        self.assertFalse(self.service.validate(frozen))
        refreshed = self._get_refresh(backend,contact,result["layered_memory"])
        self.assertIsNone(refreshed["profile"],"撤回后不自动搬回旧版或重新生成同一版本")
        self.assertEqual(refreshed["organization_generation"],ready["organization_generation"]+1)

    def test_uncited_recursive_input_deletion_erases_profile_and_all_new_artifacts(self):
        contact, _, _ = self.prepare_contact()
        _, source, message = self.import_contact("合成未引用背景：双方曾分别完成学习练习。",contact_id=contact,
            when=datetime(2024,2,1,tzinfo=timezone.utc))
        self.confirm(contact,"双方曾分别完成学习练习。",message)
        backend = self.controlled()
        ready = self.enable(backend,contact)
        self.assertEqual(len(self.profile_proposer.inputs[0][1]),2)
        self.assertEqual(len(ready["profile"]["entries"][0]["references"]),1)
        frozen = self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        self.delete_source(contact,source)
        current = self.read(backend,contact)
        self.assertEqual((current["status"],current["scenarios"],current["profile"]),("stale",[],None))
        self.assertFalse(self.service.validate(frozen))
        import psycopg
        with psycopg.connect(self.database_url) as db:
            for table in ("layered_profile_batch","layered_profile_version","layered_memory_generation"):
                count = db.execute(f"SELECT count(*) FROM public.{table} WHERE owner_id=%s AND contact_id=%s",
                    (self.owner_id,contact)).fetchone()[0]
                self.assertEqual(count,0,table)

    def test_profile_rejection_and_illegal_direct_reference_never_become_background(self):
        for invalid in (False,True):
            with self.subTest(invalid_reference=invalid):
                contact,_,_ = self.prepare_contact()
                proposer = ProfileProposal()
                if invalid:
                    original = proposer.propose
                    def bad(**arguments):
                        result = original(**arguments)
                        result["entries"][0]["references"][0]["revision"] = 999
                        return result
                    # 期限参数是准入合同的一部分，不能通过通用kwargs掩盖。
                    class BadProposal:
                        timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
                        def propose(self, *, scenarios, memories, budget, deadline):
                            return bad(scenarios=scenarios,memories=memories,budget=budget,deadline=deadline)
                    proposer = BadProposal()
                backend = self.controlled(profile_proposer=proposer,profile_verifier=ProfileVerification(False))
                state = self.enable(backend,contact)
                self.assertEqual(state["status"],"failed")
                self.assertEqual(state["error_code"],"profile_proposal_invalid" if invalid else "profile_faithfulness_rejected")
                self.assertIsNone(state["profile"])
                self.assertIsNone(self.service.capture(ContactScope(self.owner_id,UUID(contact))))

    def test_source_or_correction_before_and_after_profile_commit_erases_every_version(self):
        for action in ("source","correction"):
            for before in (True,False):
                with self.subTest(action=action,before=before):
                    contact,source,memory = self.prepare_contact()
                    def mutate():
                        if action == "source":
                            self.delete_source(contact,source)
                        else:
                            status,result = self.backend.request(f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct",
                                {"text": "双方分别学习，尚未共同参加课程。"})
                            self.assertEqual(status,200,result)
                    verifier = ProfileVerification(hook=mutate if before else None)
                    backend = self.controlled(profile_verifier=verifier)
                    ready = self.enable(backend,contact)
                    if not before:
                        self.assertIsNotNone(ready["profile"])
                        mutate()
                    current = self.read(backend,contact)
                    self.assertEqual((current["status"],current["profile"],current["scenarios"]),("stale",None,[]))
                    import psycopg
                    with psycopg.connect(self.database_url) as db:
                        for table in ("layered_profile_batch","layered_profile_version","layered_memory_generation"):
                            self.assertEqual(db.execute(f"SELECT count(*) FROM public.{table} WHERE owner_id=%s AND contact_id=%s",
                                (self.owner_id,contact)).fetchone()[0],0,table)

    def test_late_profile_after_disable_or_delete_cannot_cross_reenable_aba(self):
        for action in ("disable","delete"):
            with self.subTest(action=action):
                contact,_,_ = self.prepare_contact()
                backend = None
                def control():
                    self.profile_verifier.hook = None
                    current = self.read(backend,contact)
                    status,result = backend.request(f"/api/contacts/{contact}/layered-memory/{action}",
                        {"settings_generation": current["settings_generation"]})
                    self.assertEqual(status,200,result)
                backend = self.controlled(profile_verifier=ProfileVerification(hook=control))
                disabled = self.enable(backend,contact)
                self.assertFalse(disabled["enabled"])
                self.assertIsNone(disabled["profile"])
                restored = self.enable(backend,contact)
                self.assertGreater(restored["settings_generation"],disabled["settings_generation"])
                self.assertIsNotNone(restored["profile"])
                status,result = backend.request(f"/api/contacts/{contact}/layered-memory/delete",
                    {"settings_generation": disabled["settings_generation"]})
                self.assertEqual(status,409,result)
                self.assertEqual(self.read(backend,contact)["profile"],restored["profile"])

    def test_changed_l2_complete_set_during_profile_cannot_be_overwritten_by_old_result(self):
        contact,_,_ = self.prepare_contact()
        l2_service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url),proposer=ControlledProposal(),
            verifier=ControlledVerification(),synthetic=True,budget=OrganizationBudget(max_model_calls=4))
        l2_backend = HttpBackend(create_app(database_url=self.database_url,owner_id=self.owner_id,
            token="synthetic-l2-change",layered_memory=l2_service),self.owner_id)
        self.addCleanup(l2_backend.close)
        def change():
            self.profile_proposer.hook = None
            status,result = self.backend.request("/api/memories/manual-contact",{
                "contact_id": contact,"text": "双方还共同完成过合成练习。","category": "common_fact"})
            self.assertEqual(status,200,result)
            current = self.read(l2_backend,contact)
            self._get_refresh(l2_backend,contact,current)
        backend = self.controlled(profile_proposer=ProfileProposal(change))
        state = self.enable(backend,contact)
        self.assertIsNone(state["profile"],"旧L3不能覆盖模型期间发布的新完整L2集合")
        self.assertEqual(state["covered_count"],2)
        current_versions = [item["version_id"] for item in state["scenarios"]]
        rebuilt = self._get_refresh(backend,contact,state)
        self.assertIsNotNone(rebuilt["profile"])
        self.assertEqual([item["version_id"] for item in rebuilt["scenarios"]],current_versions)
        self.assertEqual(len(self.profile_proposer.inputs[-1][1]),2)

    def test_restart_reclaims_expired_profile_attempt_and_repeated_receipt_does_not_duplicate(self):
        from datetime import timedelta
        current = [datetime(2026,10,17,tzinfo=timezone.utc)]
        contact,_,_ = self.prepare_contact()
        def expire():
            current[0] += timedelta(seconds=20)
        backend = self.controlled(clock=lambda: current[0],profile_proposer=ProfileProposal(expire),call_timeout_seconds=.2)
        interrupted = self.enable(backend,contact)
        self.assertEqual(interrupted["status"],"updating")
        self.assertIsNone(interrupted["profile"])
        restarted = self.controlled(clock=lambda: current[0],call_timeout_seconds=.2)
        recovered = self._get_refresh(restarted,contact,interrupted)
        self.assertEqual(recovered["status"],"ready")
        self.assertIsNotNone(recovered["profile"])
        again = self._get_refresh(restarted,contact,recovered)
        self.assertEqual(again["profile"],recovered["profile"])
        self.assertEqual(again["organization_generation"],recovered["organization_generation"])

    def test_profile_actual_transport_timeout_releases_foreground_for_each_semantic_step(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from notalone.application.model_priority import ModelPriorityControl
        from notalone.memory.organization_deadline import OrganizationCallTimeout
        for phase in ("proposal","verification"):
            with self.subTest(phase=phase):
                contact,_,_ = self.prepare_contact()
                started,finished,foreground = Event(),Event(),Event()
                class SlowProfile:
                    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
                    def propose(self, *, scenarios, memories, budget, deadline):
                        return self.transport(deadline)
                    def verify(self, *, scenarios, memories, proposal, deadline):
                        return self.transport(deadline)
                    def transport(self, deadline):
                        started.set()
                        try:
                            if not Event().wait(deadline.remaining_seconds()):
                                raise OrganizationCallTimeout()
                        finally:
                            finished.set()
                slow,priority = SlowProfile(),ModelPriorityControl()
                backend = self.controlled(profile_proposer=slow if phase == "proposal" else None,
                    profile_verifier=slow if phase == "verification" else None,call_timeout_seconds=.2,model_priority=priority)
                def reply():
                    with priority.foreground():
                        foreground.set()
                with ThreadPoolExecutor(max_workers=2) as workers:
                    organizing = workers.submit(self.enable,backend,contact)
                    self.assertTrue(started.wait(3))
                    replying = workers.submit(reply)
                    self.assertTrue(finished.wait(2),"实际Adapter必须按剩余deadline到期")
                    self.assertTrue(foreground.wait(1))
                    replying.result(1)
                    state = organizing.result(3)
                self.assertEqual((state["status"],state["error_code"],state["profile"]),("failed","model_call_timeout",None))

    def test_profile_verification_complete_payload_has_independent_input_limit(self):
        contact,_,_ = self.prepare_contact()
        class LargeProfile(ProfileProposal):
            def propose(self, *, scenarios, memories, budget, deadline):
                result = super().propose(scenarios=scenarios,memories=memories,budget=budget,deadline=deadline)
                result["entries"][0]["text"] = "合成背景" * 760
                return result
        verifier = ProfileVerification()
        backend = self.controlled(profile_proposer=LargeProfile(),profile_verifier=verifier)
        state = self.enable(backend,contact)
        self.assertEqual((state["status"],state["error_code"],state["profile"]),
            ("failed","profile_verification_input_budget_exceeded",None))
        self.assertEqual(verifier.inputs,[])

    def test_repeated_expired_profile_work_stops_with_bounded_visible_failure(self):
        from datetime import timedelta
        current = [datetime(2026,10,17,tzinfo=timezone.utc)]
        contact,_,_ = self.prepare_contact()
        def expire():
            current[0] += timedelta(seconds=20)
        backend = self.controlled(clock=lambda: current[0],profile_proposer=ProfileProposal(expire),call_timeout_seconds=.2)
        state = self.enable(backend,contact)
        self.assertEqual(state["status"],"updating")
        for _ in range(2):
            state = self._get_refresh(backend,contact,state)
        self.assertEqual((state["status"],state["error_code"],state["profile"]),("failed","profile_retry_exhausted",None))
        self.assertEqual(len(self.profile_proposer.inputs),2)
