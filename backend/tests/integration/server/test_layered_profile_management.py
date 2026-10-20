"""长期背景从公开管理 HTTP 到真实隔离 PG 的合成合同。"""

import unittest
import json
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
from tests.integration.server.layered_manual_support import create_controlled_layered_app
from tests.integration.server.test_layered_memory_management import ControlledProposal, ControlledVerification, EchoProposal


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
    def controlled(self, *, profile_proposer=None, profile_verifier=None, clock=None,
                   scenario_proposer=None, scenario_verifier=None, automatic_maintenance=False, **options):
        self.profile_proposer = profile_proposer or ProfileProposal()
        self.profile_verifier = profile_verifier or ProfileVerification()
        self.scenario_proposer = scenario_proposer or ControlledProposal()
        self.scenario_verifier = scenario_verifier or ControlledVerification()
        self.service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url, clock=clock),
            proposer=self.scenario_proposer, verifier=self.scenario_verifier, synthetic=True,
            profile_proposer=self.profile_proposer, profile_verifier=self.profile_verifier, **options)
        backend = HttpBackend(create_controlled_layered_app(automatic_maintenance=automatic_maintenance,
            database_url=self.database_url, owner_id=self.owner_id,
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

    def test_personal_facts_and_inference_remain_distinct_through_public_read(self):
        class PersonalScenario(EchoProposal):
            def propose(inner, *, memories, scenarios=(), budget, deadline):
                ref = {"memory_id": str(memories[0].memory_id), "revision": memories[0].revision}
                return {"scenarios": [{"topic_key": "learning", "title": "共同学习", "hint": "共同学习经历与可能的兴趣",
                    "paragraphs": [{"text": memories[0].text, "references": [ref], "kind": "fact", "section": "narrative", "basis": "来源直接记载共同课程。", "uncertainty": ""},
                        {"text": "共同学习可能是双方的一项兴趣，单次经历尚不能证明长期偏好。", "references": [ref], "kind": "inference", "section": "implicit_signals", "basis": "双方共同参加过课程。", "uncertainty": "仅一次经历，尚不能确认长期兴趣。"}]}]}
        class PersonalProfile(ProfileProposal):
            def propose(inner, *, scenarios, memories, budget, deadline):
                return {"entries": [{"text": "双方可能有共同学习兴趣，长期性尚不确定。", "references": [{"memory_id": str(memories[0].memory_id), "revision": memories[0].revision}],
                    "kind": "inference", "section": "insights", "basis": "有共同课程经历。", "temporal_status": "uncertain", "uncertainty": "仅一次经历，不能确认稳定特征。"}]}
        contact, source, _ = self.prepare_contact()
        backend = self.controlled(scenario_proposer=PersonalScenario(), profile_proposer=PersonalProfile())
        state = self.enable(backend, contact)
        self.assertEqual(state["status"], "ready", state)
        self.assertEqual([p["kind"] for p in state["scenarios"][0]["paragraphs"]], ["fact", "inference"])
        entry = state["profile"]["entries"][0]
        self.assertEqual((entry["kind"], entry["section"]), ("inference", "insights"))
        self.assertTrue(entry["basis"] and entry["uncertainty"])
        self.delete_source(contact, source)
        deleted = self.read(backend, contact)
        self.assertEqual(deleted["scenarios"], [])
        self.assertIsNone(deleted["profile"])

    def test_personal_correction_preserves_inference_from_independent_new_sources(self):
        from tests.integration.server.test_layered_memory_corrections import LayeredMemoryCorrectionHttpTest
        class PersonalScenario(EchoProposal):
            personal = True
            def propose(inner, *, memories, budget, deadline, corrections=()):
                return {'scenarios': [{'topic_key': 'independent-learning', 'title': '独立经历的可能兴趣', 'hint': '限定的学习兴趣线索',
                    'paragraphs': [{'text': '可能有学习兴趣，尚不能确定。', 'kind': 'inference', 'section': 'implicit_signals',
                        'basis': '仅据本次独立学习经历。', 'uncertainty': '不证明长期偏好。',
                        'references': [{'memory_id': str(memories[0].memory_id), 'revision': memories[0].revision}]}]}]}
        class PersonalProfile(ProfileProposal):
            personal = True
            def propose(inner, *, scenarios, memories, budget, deadline, corrections=()):
                return {'entries': [{'text': '可能有学习兴趣，长期性尚不确定。', 'kind': 'inference', 'section': 'interests',
                    'basis': '仅据独立学习经历。', 'uncertainty': '不证明长期偏好。', 'temporal_status': 'uncertain',
                    'references': [{'memory_id': str(memories[0].memory_id), 'revision': memories[0].revision}]}]}
        class V(ControlledVerification):
            def verify(inner, *, memories, proposal, deadline, corrections=()): return True
        class PV(ProfileVerification):
            def verify(inner, *, scenarios, memories, proposal, deadline, corrections=()): return True
        contact, _, _ = self.prepare_contact()
        original = self.controlled()
        ready = self.enable(original, contact)
        path = f'/api/contacts/{contact}/layered-memory'
        status, result = original.request(path+'/summary-error', LayeredMemoryCorrectionHttpTest.summary_command(self, ready))
        self.assertEqual(status, 200, result)
        self.assertEqual(self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '对方另外参加独立的新学习课程。', 'category': 'common_fact'})[0], 200)
        backend = self.controlled(scenario_proposer=PersonalScenario(), scenario_verifier=V(),
            profile_proposer=PersonalProfile(), profile_verifier=PV())
        status, result = backend.request(path+'/refresh', {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, result)
        current = result['layered_memory']
        self.assertEqual(current['status'], 'ready', current)
        self.assertEqual(current['scenarios'][0]['paragraphs'][0]['kind'], 'inference')
        self.assertEqual(current['profile']['entries'][0]['kind'], 'inference')
        self.assertGreater(current['protected_count'], 0)

    def test_oversized_profile_preserves_valid_prefix_and_reports_excess(self):
        from copy import deepcopy
        import psycopg
        class Extra(ProfileProposal):
            def propose(inner, *, scenarios, memories, budget, deadline):
                result = super().propose(scenarios=scenarios, memories=memories, budget=budget, deadline=deadline)
                result['entries'] = [deepcopy(result['entries'][0]) for _ in range(3)]
                return result
        contact, _, _ = self.prepare_contact()
        backend = self.controlled(profile_proposer=Extra(), budget=OrganizationBudget(
            max_model_calls=4, max_profile_entries=2))
        ready = self.enable(backend, contact)
        self.assertEqual(ready['status'], 'ready', ready)
        self.assertEqual(len(ready['profile']['entries']), 2)
        with psycopg.connect(self.database_url) as connection:
            output = connection.execute('SELECT output_payload FROM layered_profile_batch WHERE owner_id=%s AND contact_id=%s',
                (self.owner_id, contact)).fetchone()[0]
        self.assertEqual(len(output['original']['entries']), 3)
        self.assertEqual(output['rejected'][0]['index'], 2)
        self.assertIn('预算', output['rejected'][0]['reason'])

    def test_incremental_profile_receives_valid_previous_profile(self):
        class Incremental(ProfileProposal):
            def __init__(inner):
                super().__init__()
                inner.previous = []
            def propose(inner, *, scenarios, memories, previous_profile, changed_scenario_ids, budget, deadline):
                inner.previous.append((previous_profile, changed_scenario_ids))
                result = super().propose(scenarios=scenarios, memories=memories, budget=budget, deadline=deadline)
                result['entries'][0].update(kind='inference', section='insights', basis='共同学习是兴趣线索，但不能确认。')
                return result
        contact, _, _ = self.prepare_contact()
        proposer = Incremental()
        backend = self.controlled(profile_proposer=proposer, scenario_proposer=EchoProposal())
        ready = self.enable(backend, contact)
        self.assertEqual(ready['status'], 'ready', ready)
        self.assertIsNone(proposer.previous[0][0])
        _, _, message = self.import_contact('双方还一起参加合成练习。', contact_id=contact,
                                            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.confirm(contact, '双方还一起参加合成练习。', message)
        done = self._get_refresh(backend, contact, self.read(backend, contact))
        self.assertEqual(done['status'], 'ready', done)
        self.assertEqual(proposer.previous[-1][0]['version_id'], ready['profile']['version_id'])
        self.assertTrue(proposer.previous[-1][1])
        self.assertEqual(proposer.previous[-1][0]['entries'][0]['kind'], 'inference')
        self.assertEqual(proposer.previous[-1][0]['entries'][0]['basis'], ready['profile']['entries'][0]['basis'])

    def test_unchanged_scenarios_reuse_profile_without_model_call(self):
        class StableScenario(ControlledProposal):
            def propose(inner, *, memories, scenarios, budget, deadline):
                if scenarios:
                    return {'scenarios': []}
                return super().propose(memories=memories, budget=budget, deadline=deadline)
        contact, _, _ = self.prepare_contact()
        class ContextVerification(ControlledVerification):
            def verify(inner, *, memories, scenarios, proposal, deadline):
                return True
        backend = self.controlled(scenario_proposer=StableScenario(), scenario_verifier=ContextVerification())
        ready = self.enable(backend, contact)
        self.assertEqual(ready['status'], 'ready', ready)
        _, _, message = self.import_contact('一次无长期价值的新消息。', contact_id=contact,
                                            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.confirm(contact, '一次新的短期安排。', message)
        done = self._get_refresh(backend, contact, self.read(backend, contact))
        self.assertIn(done['status'], {'ready', 'paused'}, done)
        self.assertEqual(done['model_calls_used'], 2)
        self.assertEqual(done['profile']['version_id'], ready['profile']['version_id'])
        self.assertEqual(len(self.profile_proposer.inputs), 1)

    def test_deleted_uncited_profile_input_cannot_return_as_previous_profile(self):
        class Recording(ProfileProposal):
            def __init__(inner):
                super().__init__()
                inner.previous = []
            def propose(inner, *, scenarios, memories, previous_profile, changed_scenario_ids, budget, deadline):
                inner.previous.append(previous_profile)
                return super().propose(scenarios=scenarios, memories=memories, budget=budget, deadline=deadline)
        contact, _, _ = self.prepare_contact()
        _, extra_source, message = self.import_contact('未被直接引用的另一项学习背景。', contact_id=contact,
                                                       when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.confirm(contact, '双方分别参加过另一次学习。', message)
        proposer = Recording()
        backend = self.controlled(profile_proposer=proposer)
        ready = self.enable(backend, contact)
        self.assertIsNotNone(ready['profile'])
        self.assertEqual(len(proposer.inputs[0][1]), 2)
        self.delete_source(contact, extra_source)
        state = self.read(backend, contact)
        rebuilt = self._get_refresh(backend, contact, state)
        self.assertEqual(rebuilt['status'], 'ready', rebuilt)
        self.assertIsNone(proposer.previous[-1])
        self.assertNotEqual(rebuilt['profile']['version_id'], ready['profile']['version_id'])

    def test_dirty_does_not_resume_failed_profile_or_refill_paused_budget(self):
        from threading import Event
        for paused in (False, True):
            with self.subTest(paused=paused):
                contact, _, _ = self.prepare_contact()
                class FailOnce(ProfileVerification):
                    def verify(self, *, scenarios, memories, proposal, deadline):
                        value = super().verify(scenarios=scenarios, memories=memories, proposal=proposal, deadline=deadline)
                        if len(self.inputs) == 1:
                            raise RuntimeError('合成画像核验失败')
                        return value
                verifier = FailOnce()
                backend = self.controlled(profile_verifier=verifier, automatic_maintenance=True)
                initial = self.enable(backend, contact)
                if paused:
                    initial = self._get_refresh(backend, contact, initial)
                self.assertEqual(initial['status'], 'paused' if paused else 'failed')
                status, result = self.backend.request('/api/memories/manual-contact', {
                    'contact_id': contact, 'text': '另一次合成学习事实。', 'category': 'common_fact'})
                self.assertEqual(status, 200, result)
                for _ in range(12):
                    state = self.read(backend, contact)
                    self.assertEqual((state['work_id'], state['model_calls_used'], state['model_call_limit']),
                        (initial['work_id'], 4, 4))
                    self.assertEqual(state['status'], initial['status'])
                    Event().wait(.05)
                self.assertEqual(len(verifier.inputs), 1)
                self.assertTrue(state['maintenance_pending'])
                status, _ = backend.request(f'/api/contacts/{contact}/layered-memory/continue', {
                    'settings_generation': state['settings_generation'], 'work_revision': state['work_revision']})
                self.assertEqual(status, 409)
                resumed = self._get_refresh(backend, contact, state)
                self.assertEqual(resumed['status'], 'ready')
                self.assertNotEqual(resumed['work_id'], initial['work_id'])
                self.assertEqual((resumed['covered_count'], resumed['model_calls_used'], resumed['model_call_limit']), (2,4,4))
                backend.close()

    def test_committed_change_automatically_updates_both_layers_in_one_budget(self):
        from threading import Event
        from time import monotonic
        contact, _, _ = self.prepare_contact()
        backend = self.controlled(scenario_proposer=EchoProposal(), automatic_maintenance=True)
        ready = self.enable(backend, contact)
        snapshot = self.service.capture(ContactScope(self.owner_id, UUID(contact)))
        status, result = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '双方还一起参加合成练习。', 'category': 'common_fact'})
        self.assertEqual(status, 200, result)
        deadline = monotonic() + 5
        while monotonic() < deadline:
            updated = self.read(backend, contact)
            if (updated['status'] == 'ready' and updated['covered_count'] == 2
                    and updated['profile'] is not None):
                break
            Event().wait(.05)
        self.assertEqual(updated['status'], 'ready', updated)
        self.assertEqual(updated['covered_count'], 2)
        self.assertNotEqual(updated['profile']['version_id'], ready['profile']['version_id'])
        self.assertEqual(updated['budget']['model_calls_used'], 4)
        self.assertEqual(updated['budget']['model_calls_remaining'], 0)
        self.assertEqual(len(self.profile_proposer.inputs[-1][1]), 2)
        self.assertFalse(self.service.validate(snapshot))

    def test_profile_has_direct_bottom_versions_and_frozen_consistent_directory(self):
        contact, _, memory = self.prepare_contact()
        backend = self.controlled()
        ready = self.enable(backend, contact)
        self.assertEqual((ready["schema_version"], ready["status"]), (2, "ready"))
        self.assertEqual((ready["budget"]["model_calls_used"],ready["budget"]["model_calls_remaining"]),(4,0))
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
        self.assertEqual(repeated["budget"],ready["budget"])

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
                snapshot=self.service.capture(ContactScope(self.owner_id,UUID(contact)))
                self.assertIsNotNone(snapshot,"画像失败仍保留独立合法L2")
                self.assertIsNone(snapshot.profile_version_id)
                self.assertEqual(snapshot.profile_entries,())
                self.assertTrue(self.service.validate(snapshot))

    def test_source_erasure_and_error_retirement_keep_distinct_profile_lifecycles(self):
        for action in ("source","correction"):
            for before in (True,False):
                with self.subTest(action=action,before=before):
                    contact,source,memory = self.prepare_contact()
                    retired = {}
                    def mutate():
                        if retired:
                            return
                        import psycopg
                        with psycopg.connect(self.database_url) as db:
                            for table in ('layered_profile_batch','layered_profile_version','layered_memory_generation'):
                                key = 'organization_generation' if table == 'layered_memory_generation' else 'id'
                                retired[table] = (key, [row[0] for row in db.execute(
                                    f'SELECT {key} FROM public.{table} WHERE owner_id=%s AND contact_id=%s',
                                    (self.owner_id,contact)).fetchall()])
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
                    if action == 'source':
                        self.assertIsNone(current['profile'])
                        self.assertEqual(current['scenarios'], [])
                    self.assertIsNone(self.service.capture(ContactScope(self.owner_id, UUID(contact))),
                                      "来源删除或错误退役后，旧画像均不得继续进入生成")
                    # 来源删除物理清除全部派生输入；错误退役保留既有审计，不恢复生成资格。
                    import psycopg
                    with psycopg.connect(self.database_url) as db:
                        for table, (key, ids) in retired.items():
                            retained = db.execute(f'SELECT count(*) FROM public.{table} WHERE owner_id=%s AND contact_id=%s AND {key}=ANY(%s)',
                                (self.owner_id,contact,ids)).fetchone()[0]
                            self.assertEqual(retained, 0 if action == 'source' else len(ids), table)
                        if action == 'source':
                            for table in ('layered_memory_batch', 'layered_profile_batch'):
                                self.assertFalse(db.execute(f"SELECT 1 FROM public.{table} WHERE owner_id=%s AND contact_id=%s "
                                    "AND input_manifest @> %s::jsonb", (self.owner_id,contact,
                                    json.dumps([{'memory_id':memory['memory_id'],'revision':memory['revision']}]))).fetchone(), table)
                    if action == 'correction':
                        self.assertIsNone(current['profile'], "当前目录撤销旧画像，历史审计仍保留在原版本")
                    backend.close()

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

    def test_queued_l2_set_change_revokes_profile_before_next_worker_publishes(self):
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
        # 同一正式Worker串行：模型期间的新目标先撤销旧claim，待当前Worker释放后再推进L2。
        current=self.read(l2_backend,contact)
        self.assertEqual(current["covered_count"],2,{key:current[key] for key in ("status","error_code","work_id","model_calls_used","current_batch")})
        self.assertIsNone(current["profile"])
        current_versions = [item["version_id"] for item in current["scenarios"]]
        rebuilt = self._get_refresh(backend,contact,current)
        self.assertIsNotNone(rebuilt["profile"])
        self.assertEqual([item["version_id"] for item in rebuilt["scenarios"]],current_versions)
        self.assertEqual(len(self.profile_proposer.inputs[-1][1]),2)

    def test_restart_reclaims_expired_profile_attempt_without_refunding_its_reserved_call(self):
        from datetime import timedelta
        current = [datetime(2026,10,17,tzinfo=timezone.utc)]
        contact,_,_ = self.prepare_contact()
        def expire():
            current[0] += timedelta(seconds=20)
        # 本例用模拟时钟推进租约；真实期限留足数据库预留时间，避免负载改变调用次数。
        backend = self.controlled(clock=lambda: current[0],profile_proposer=ProfileProposal(expire),call_timeout_seconds=2)
        interrupted = self.enable(backend,contact)
        self.assertEqual((interrupted["status"],interrupted["error_code"]),("failed","profile_attempt_interrupted"))
        self.assertIsNone(interrupted["profile"])
        restarted = self.controlled(clock=lambda: current[0],call_timeout_seconds=2)
        recovered = self._get_refresh(restarted,contact,interrupted)
        self.assertEqual((recovered["status"],recovered["error_code"]),("paused","model_call_budget_exhausted"))
        self.assertIsNone(recovered["profile"])
        self.assertEqual((recovered["budget"]["model_calls_used"],recovered["budget"]["model_calls_remaining"]),(4,0))
        again = self._get_refresh(restarted,contact,recovered)
        self.assertEqual(again["profile"],recovered["profile"])
        self.assertEqual(again["organization_generation"],recovered["organization_generation"])

    def test_profile_adapter_transport_timeout_releases_foreground_for_each_semantic_step(self):
        self._profile_timeout_case(total_budget=None, transport_timeout=.2, require_transport=True)

    def test_profile_short_total_budget_does_not_publish_and_releases_foreground(self):
        self._profile_timeout_case(total_budget=.2, transport_timeout=None, require_transport=False)

    def _profile_timeout_case(self, *, total_budget, transport_timeout, require_transport):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from notalone.application.model_priority import ModelPriorityControl
        from notalone.memory.organization_deadline import OrganizationCallTimeout
        for phase in ("proposal", "verification"):
            with self.subTest(phase=phase):
                contact, _, _ = self.prepare_contact()
                started, finished, foreground, timed_out = Event(), Event(), Event(), Event()
                waits = []
                class SlowProfile:
                    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
                    def propose(self, *, scenarios, memories, budget, deadline):
                        return self.transport(deadline)
                    def verify(self, *, scenarios, memories, proposal, deadline):
                        return self.transport(deadline)
                    def transport(self, deadline):
                        started.set()
                        try:
                            remaining = deadline.remaining_seconds()
                            timeout = min(remaining, transport_timeout) if transport_timeout is not None else remaining
                            waits.append(timeout)
                            if not Event().wait(timeout):
                                timed_out.set()
                                raise OrganizationCallTimeout()
                        finally:
                            finished.set()
                slow, priority = SlowProfile(), ModelPriorityControl()
                # 实际传输用独立更严格期限；总预算用例仍包含真实数据库前置步骤。
                # 默认总预算不能被误称为0.2秒总期限，传输期限也不替代生产总期限。
                options = {} if total_budget is None else {"call_timeout_seconds": total_budget}
                backend = self.controlled(profile_proposer=slow if phase == "proposal" else None,
                    profile_verifier=slow if phase == "verification" else None, model_priority=priority, **options)
                def reply():
                    with priority.foreground():
                        foreground.set()
                with ThreadPoolExecutor(max_workers=2) as workers:
                    organizing = workers.submit(self.enable, backend, contact)
                    entered = started.wait(3)
                    if require_transport:
                        self.assertTrue(entered, "实际传输超时回归必须进入指定L3步骤")
                    replying = workers.submit(reply)
                    if entered:
                        self.assertTrue(finished.wait(2), "实际Adapter必须按传输剩余期限到期")
                    self.assertTrue(foreground.wait(1))
                    replying.result(1)
                    state = organizing.result(3)
                self.assertEqual((state["status"], state["error_code"], state["profile"]),
                                 ("failed", "model_call_timeout", None))
                used, limit = state['budget']['model_calls_used'], state['budget']['max_model_calls']
                expected = 3 if phase == "proposal" else 4
                self.assertGreaterEqual(used, 0)
                self.assertLessEqual(used, expected)
                self.assertEqual(state['budget']['model_calls_remaining'], limit - used)
                if entered:
                    self.assertEqual(used, expected, "超时不能返还已预留的模型调用额度")
                if require_transport:
                    self.assertTrue(timed_out.is_set(), "传输必须实际等待到期，不能直接伪造超时")
                    self.assertEqual(len(waits), 1)
                    self.assertGreater(waits[0], 0)
                    self.assertLessEqual(waits[0], transport_timeout)

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
        # 模拟时钟推进20秒使租约过期，真实期限仅为数据库与Adapter保留调度余量。
        backend = self.controlled(clock=lambda: current[0],profile_proposer=ProfileProposal(expire),call_timeout_seconds=2)
        state = self.enable(backend,contact)
        self.assertEqual((state["status"],state["error_code"]),("failed","profile_attempt_interrupted"))
        for _ in range(2):
            state = self._get_refresh(backend,contact,state)
        self.assertEqual((state["status"],state["error_code"],state["profile"]),("paused","model_call_budget_exhausted",None))
        self.assertEqual(len(self.profile_proposer.inputs),2)

    def test_failed_fourth_call_and_restart_cannot_refresh_a_free_profile_budget(self):
        contact,_,_ = self.prepare_contact()
        class FailFirstVerification(ProfileVerification):
            def verify(self, *, scenarios, memories, proposal, deadline):
                result = super().verify(scenarios=scenarios,memories=memories,proposal=proposal,deadline=deadline)
                if len(self.inputs) == 1:
                    raise RuntimeError("合成实际传输失败，已发调用仍消耗额度。")
                return result
        verifier,proposer = FailFirstVerification(),ProfileProposal()
        backend = self.controlled(profile_proposer=proposer,profile_verifier=verifier)
        failed = self.enable(backend,contact)
        self.assertEqual(failed["error_code"],"model_call_failed")
        restarted = self.controlled(profile_proposer=proposer,profile_verifier=verifier)
        for _ in range(2):
            state = self._get_refresh(restarted,contact,failed)
            self.assertEqual((state["status"],state["error_code"],state["profile"]),
                ("paused","model_call_budget_exhausted",None))
            self.assertEqual((state["budget"]["max_model_calls"],state["budget"]["model_calls_used"],
                state["budget"]["model_calls_remaining"]),(4,4,0))
        self.assertEqual((len(proposer.inputs),len(verifier.inputs)),(1,1),"已消耗4次后刷新和重启都不能再发L3调用")

    def test_profile_failed_or_timed_out_dispatches_still_count_across_restart(self):
        from threading import Event
        from notalone.memory.organization_deadline import OrganizationCallTimeout
        for phase in ("proposal","verification"):
            for failure in ("error","timeout"):
                with self.subTest(phase=phase,failure=failure):
                    contact,_,_ = self.prepare_contact()
                    finished = Event()
                    def fail():
                        if failure == "error":
                            finished.set()
                            raise RuntimeError("合成已发请求失败。")
                        finished.set()
                        raise OrganizationCallTimeout()
                    class OnceProposal(ProfileProposal):
                        def propose(self, *, scenarios, memories, budget, deadline):
                            result = super().propose(scenarios=scenarios,memories=memories,budget=budget,deadline=deadline)
                            if phase == "proposal" and len(self.inputs) == 1:
                                fail()
                            return result
                    class OnceVerification(ProfileVerification):
                        def verify(self, *, scenarios, memories, proposal, deadline):
                            result = super().verify(scenarios=scenarios,memories=memories,proposal=proposal,deadline=deadline)
                            if phase == "verification" and len(self.inputs) == 1:
                                fail()
                            return result
                    # 本例检查已发失败的计费；在Adapter边界精确注入传输超时，
                    # 避免数据库预留耗尽极短总期限而使请求根本未发出。
                    # 真实期限与前台许可释放由独立的transport用例覆盖。
                    proposer,verifier = OnceProposal(),OnceVerification()
                    backend = self.controlled(profile_proposer=proposer,profile_verifier=verifier,call_timeout_seconds=2)
                    first = self.enable(backend,contact)
                    self.assertTrue(finished.wait(1))
                    self.assertEqual(first["budget"]["model_calls_used"],3 if phase == "proposal" else 4)
                    self.assertEqual(first["error_code"],"model_call_failed" if failure == "error" else "model_call_timeout")
                    restarted = self.controlled(profile_proposer=proposer,profile_verifier=verifier,call_timeout_seconds=2)
                    state = self._get_refresh(restarted,contact,first)
                    self.assertEqual((state["status"],state["error_code"],state["profile"]),("paused","model_call_budget_exhausted",None))
                    self.assertEqual((state["budget"]["max_model_calls"],state["budget"]["model_calls_used"],state["budget"]["model_calls_remaining"]),(4,4,0))
                    self.assertEqual(len(proposer.inputs)+len(verifier.inputs),2,"L2已花2次；整个目标L3实际调用不能超过余下2次")

    def test_new_legal_target_and_new_enable_epoch_have_independent_finite_budgets(self):
        contact,_,_ = self.prepare_contact()
        class FailVerification(ProfileVerification):
            def verify(self, *, scenarios, memories, proposal, deadline):
                super().verify(scenarios=scenarios,memories=memories,proposal=proposal,deadline=deadline)
                raise RuntimeError("合成首次目标核验失败。")
        backend = self.controlled(profile_verifier=FailVerification())
        failed = self.enable(backend,contact)
        paused = self._get_refresh(backend,contact,failed)
        self.assertEqual(paused["status"],"paused")
        status,result = self.backend.request("/api/memories/manual-contact",{
            "contact_id":contact,"text":"双方后来共同完成了另一次合成学习练习。","category":"common_fact"})
        self.assertEqual(status,200,result)
        healthy = self.controlled()
        rebuilt = self._get_refresh(healthy,contact,paused)
        self.assertEqual((rebuilt["status"],rebuilt["covered_count"]),("ready",2))
        self.assertIsNotNone(rebuilt["profile"])
        self.assertEqual((rebuilt["budget"]["model_calls_used"],rebuilt["budget"]["model_calls_remaining"]),(4,0),"不能把旧目标费用加进新目标")
        status,result = healthy.request(f"/api/contacts/{contact}/layered-memory/disable",{
            "settings_generation":rebuilt["settings_generation"]})
        self.assertEqual(status,200,result)
        enabled = self.enable(healthy,contact)
        self.assertEqual(enabled["status"],"ready")
        self.assertGreater(enabled["settings_generation"],rebuilt["settings_generation"])
        self.assertNotEqual(enabled["work_id"],rebuilt["work_id"])
        self.assertEqual((enabled["budget"]["max_model_calls"],enabled["budget"]["model_calls_used"],enabled["budget"]["model_calls_remaining"]),(4,2,2),"重开复用合法L2，只累计本次L3实际调用")

    def test_two_coverage_batches_and_profile_share_one_cumulative_job_budget(self):
        contact,_,_=self.prepare_contact()
        status,result=self.backend.request('/api/memories/manual-contact',{
            'contact_id':contact,'text':'双方还完成另一项合成练习。','category':'common_fact'})
        self.assertEqual(status,200,result)
        backend=self.controlled(scenario_proposer=EchoProposal(),budget=OrganizationBudget(max_memories=1,max_model_calls=4))
        first=self.enable(backend,contact)
        self.assertEqual((first['status'],first['covered_count'],first['remaining_count']),('paused',1,1))
        self.assertIsNotNone(first['profile'])
        self.assertEqual((first['model_calls_used'],first['model_call_limit'],first['budget']['model_calls_remaining']),(4,4,0))
        snapshot=self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        status,result=backend.request(f'/api/contacts/{contact}/layered-memory/continue',{
            'settings_generation':first['settings_generation'],'work_revision':first['work_revision']})
        self.assertEqual(status,200,result)
        done=result['layered_memory']
        self.assertEqual((done['work_id'],done['current_batch'],done['status'],done['covered_count']),
            (first['work_id'],2,'ready',2))
        self.assertEqual((done['model_calls_used'],done['model_call_limit'],done['budget']['model_calls_remaining']),(8,8,0))
        self.assertIsNotNone(done['profile'])
        self.assertFalse(self.service.validate(snapshot))
        self.assertEqual(len(self.profile_proposer.inputs[-1][1]),2)
        texts={paragraph['text'] for scenario in done['scenarios'] for paragraph in scenario['paragraphs']}
        self.assertIn('双方共同参加过课程。',texts)
        self.assertIn('双方还完成另一项合成练习。',texts)
        self.assertEqual(self._get_refresh(backend,contact,done),done)

    def test_profile_failure_keeps_l2_receipt_until_continue_adds_only_explicit_budget(self):
        contact,_,_=self.prepare_contact()
        class FailedVerification(ProfileVerification):
            def verify(self, *, scenarios, memories, proposal, deadline):
                super().verify(scenarios=scenarios,memories=memories,proposal=proposal,deadline=deadline)
                raise RuntimeError('合成第四次调用失败。')
        backend=self.controlled(profile_verifier=FailedVerification())
        failed=self.enable(backend,contact)
        versions=[row['version_id'] for row in failed['scenarios']]
        self.assertEqual((failed['status'],failed['covered_count'],failed['model_calls_used']),('failed',1,4))
        self.assertIsNone(failed['profile'])
        restarted=self.controlled()
        proposal=self.scenario_proposer
        paused=self._get_refresh(restarted,contact,failed)
        self.assertEqual((paused['status'],paused['model_calls_used'],paused['model_call_limit']),('paused',4,4))
        status,result=restarted.request(f'/api/contacts/{contact}/layered-memory/continue',{
            'settings_generation':paused['settings_generation'],'work_revision':paused['work_revision']})
        self.assertEqual(status,200,result)
        ready=result['layered_memory']
        self.assertEqual((ready['work_id'],ready['status'],ready['current_batch'],ready['model_calls_used'],ready['model_call_limit']),
            (failed['work_id'],'ready',1,6,8))
        self.assertEqual([row['version_id'] for row in ready['scenarios']],versions)
        self.assertEqual(proposal.inputs,[],'已提交L2回执不能在画像恢复时重算')
        self.assertIsNotNone(ready['profile'])

    def test_crash_after_l2_commit_recovers_only_profile_from_persisted_receipt(self):
        import psycopg
        contact,_,_=self.prepare_contact()
        with psycopg.connect(self.database_url) as connection:
            connection.execute('CREATE SEQUENCE synthetic_profile_prepare_fault')
            connection.execute("""CREATE FUNCTION synthetic_interrupt_profile_prepare() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF nextval('synthetic_profile_prepare_fault')=1 THEN RAISE EXCEPTION 'synthetic process interruption'; END IF;
                    RETURN NEW;
                END; $$""")
            connection.execute('CREATE TRIGGER synthetic_profile_prepare BEFORE INSERT ON public.layered_profile_batch '
                'FOR EACH ROW EXECUTE FUNCTION synthetic_interrupt_profile_prepare()')
        backend=self.controlled()
        failed=self.enable(backend,contact)
        self.assertEqual((failed['status'],failed['covered_count'],failed['model_calls_used']),('failed',1,2))
        self.assertIsNone(failed['profile'])
        versions=[row['version_id'] for row in failed['scenarios']]
        restarted=self.controlled()
        ready=self._get_refresh(restarted,contact,failed)
        self.assertEqual((ready['work_id'],ready['status'],ready['current_batch'],ready['model_calls_used'],ready['model_call_limit']),
            (failed['work_id'],'ready',1,4,4))
        self.assertEqual([row['version_id'] for row in ready['scenarios']],versions)
        self.assertEqual(self.scenario_proposer.inputs,[])
        self.assertIsNotNone(ready['profile'])

    def test_reserved_call_before_process_loss_is_counted_once_and_never_refunded(self):
        contact,_,_=self.prepare_contact()
        backend=self.controlled()
        original=self.service._store.reserve_model_call
        def lose_after_reserve(work):
            original(work)
            if hasattr(work,'scenario_version_ids'):
                raise RuntimeError('合成预留提交后进程失联，发送状态未知。')
        self.service._store.reserve_model_call=lose_after_reserve
        interrupted=self.enable(backend,contact)
        self.assertEqual((interrupted['status'],interrupted['covered_count'],interrupted['model_calls_used']),('failed',1,3))
        self.assertEqual(self.profile_proposer.inputs,[])
        restarted=self.controlled()
        exhausted=self._get_refresh(restarted,contact,interrupted)
        self.assertEqual((exhausted['status'],exhausted['model_calls_used'],exhausted['model_call_limit']),('paused',4,4))
        self.assertIsNone(exhausted['profile'])
        self.assertEqual((len(self.scenario_proposer.inputs),len(self.profile_proposer.inputs),len(self.profile_verifier.inputs)),(0,1,0))

    def test_source_erasure_keeps_unaffected_l2_and_clears_recursive_profile(self):
        class SeparateTopics(EchoProposal):
            def propose(self, *, memories, budget, deadline):
                result=super().propose(memories=memories,budget=budget,deadline=deadline)
                result['scenarios'][0]['topic_key']='practice' if '练习' in memories[0].text else 'course'
                return result
        contact,source,_=self.prepare_contact()
        status,result=self.backend.request('/api/memories/manual-contact',{
            'contact_id':contact,'text':'双方共同完成合成练习。','category':'common_fact'})
        self.assertEqual(status,200,result)
        backend=self.controlled(scenario_proposer=SeparateTopics(),budget=OrganizationBudget(max_memories=1,max_model_calls=4))
        first=self.enable(backend,contact)
        status,result=backend.request(f'/api/contacts/{contact}/layered-memory/continue',{
            'settings_generation':first['settings_generation'],'work_revision':first['work_revision']})
        self.assertEqual(status,200,result)
        before=result['layered_memory']
        self.assertEqual(len(before['scenarios']),2)
        self.assertIsNotNone(before['profile'])
        old=self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        self.delete_source(contact,source)
        retained=self.read(backend,contact)
        self.assertEqual((retained['status'],retained['covered_count'],retained['remaining_count']),('stale',1,0))
        self.assertIsNone(retained['profile'])
        self.assertEqual([paragraph['text'] for scenario in retained['scenarios'] for paragraph in scenario['paragraphs']],
            ['双方共同完成合成练习。'])
        self.assertFalse(self.service.validate(old))
        snapshot=self.service.capture(ContactScope(self.owner_id,UUID(contact)))
        self.assertIsNotNone(snapshot)
        self.assertTrue(self.service.validate(snapshot))
        self.assertIsNone(snapshot.profile_version_id)
        self.assertEqual(snapshot.profile_entries,())
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id=%s',
                (self.owner_id,contact)).fetchone()[0],0)

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
