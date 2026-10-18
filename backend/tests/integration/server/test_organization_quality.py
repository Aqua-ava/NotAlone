"""质量状态沿管理HTTP与真实隔离PostgreSQL读取，受控模型不签发资格。"""
import unittest

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class OrganizationQualityHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_unknown_quality_has_versioned_contract_and_cannot_be_granted_by_enable(self):
        path = '/api/memories/owner/layered-memory'
        state = self._get(self.backend, path)['layered_memory']
        self.assertEqual(state['quality']['organization']['status'], 'unknown')
        self.assertIn('no_evaluation_report', state['quality']['organization']['reasons'])
        self.assertIsNotNone(state['quality']['organization']['contract_id'])
        self.assertFalse(state['quality']['automatic_use_allowed'])
        status, result = self.backend.request(path + '/enable', {
            'settings_generation': 0, 'purpose_confirmed': True, 'verified': True})
        self.assertEqual(status, 400, result)
        self.assertFalse(self._get(self.backend, path)['layered_memory']['enabled'])

    def test_prepared_public_input_uses_actual_versions_and_minimum_scope_projection(self):
        status, added = self.backend.request('/api/memories/manual-owner', {
            'text': '据2024年手录，合成本人曾参加课程；现在情况未知。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        memory = added['memory']
        status, prepared = self.backend.request('/api/memories/owner/layered-memory/quality-input', {
            'memory_versions': [{'memory_id': memory['memory_id'], 'revision': memory['revision']}]})
        self.assertEqual(status, 200, prepared)
        item = prepared['quality_input']['model_input']['memories'][0]
        self.assertEqual(set(item), {'memory_id', 'revision', 'text', 'timing'})
        self.assertEqual(item['text'], '据2024年手录，合成本人曾参加课程；现在情况未知。')
        self.assertEqual(prepared['quality_input']['construction'][0]['provenance_kind'], 'manual_entry')
        self.assertEqual(prepared['quality_input']['review_status'], 'unknown')
        self.assertFalse(prepared['quality_input']['quality_verified'])

    def test_prepared_input_is_deleted_with_its_unreferenced_actual_input(self):
        selected = []
        for text in ('合成本人喜欢清晨学习。', '合成本人周末散步。'):
            status, result = self.backend.request('/api/memories/manual-owner', {'text': text, 'category': 'common_fact'})
            self.assertEqual(status, 200, result)
            selected.append({'memory_id': result['memory']['memory_id'], 'revision': result['memory']['revision']})
        status, result = self.backend.request('/api/memories/owner/layered-memory/quality-input', {'memory_versions': selected})
        self.assertEqual(status, 200, result)
        path = '/api/layered-memory/quality-inputs/' + result['quality_input']['case_id']
        self.assertEqual(self.backend.request(path)[0], 200)
        status, result = self.backend.request('/api/memories/owner/' + selected[1]['memory_id'] + '/delete', {})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.backend.request(path)[0], 404)

    def prepare_owner_input(self, text='合成本人喜欢清晨学习。'):
        status, result = self.backend.request('/api/memories/manual-owner', {'text': text, 'category': 'common_fact'})
        self.assertEqual(status, 200, result)
        status, result = self.backend.request('/api/memories/owner/layered-memory/quality-input', {
            'memory_versions': [{'memory_id': result['memory']['memory_id'], 'revision': result['memory']['revision']}]})
        self.assertEqual(status, 200, result)
        return result['quality_input']

    def test_public_evaluation_report_stays_unknown_without_actual_model_and_human_review(self):
        prepared = self.prepare_owner_input()
        status, result = self.backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [prepared['case_id']], 'max_http_attempts': 6,
            'dataset_version': '合成工程一例', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        report = result['quality_report']
        self.assertEqual(report['organization']['status'], 'unknown')
        self.assertEqual(report['case_count'], 1)
        self.assertEqual(report['http_attempts_used'], 0)
        self.assertIn('actual_model_evidence_missing', report['organization']['reasons'])
        status, bad = self.backend.request('/api/layered-memory/quality-runs/' + report['report_id'] + '/verify', {'verified': True})
        self.assertEqual(status, 404, bad)
        status, result = self.backend.request('/api/layered-memory/quality-runs/' + report['report_id'])
        self.assertEqual(status, 200, result)
        self.assertFalse(result['quality_report']['automatic_use_allowed'])

    def test_withdrawing_actual_context_erases_quality_copies_before_any_get(self):
        import psycopg
        from tests.integration.server.test_layered_memory_management import LayeredMemoryManagementHttpTest
        contact, _, _ = self.import_contact('合成主题撤回的来源。')
        status, added = self.backend.request('/api/memories/manual-contact', {'contact_id': contact,
            'text': '双方有合成读书经历。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        management = LayeredMemoryManagementHttpTest.controlled(self)
        base = f'/api/contacts/{contact}/layered-memory'
        status, enabled = management.request(base + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, enabled)
        ready = enabled['layered_memory']
        status, prepared = management.request(base + '/quality-input', {'memory_versions': [{
            'memory_id': added['memory']['memory_id'], 'revision': added['memory']['revision']}]})
        self.assertEqual(status, 200, prepared)
        self.assertTrue(prepared['quality_input']['model_input']['scenarios'])
        status, run = management.request('/api/layered-memory/quality-runs', {'case_ids': [prepared['quality_input']['case_id']],
            'max_http_attempts': 6, 'dataset_version': '实际旧主题参与依赖', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, run)
        status, withdrawn = management.request(base + '/withdraw-scenario', {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'], 'scenario_version_id': ready['scenarios'][0]['version_id']})
        self.assertEqual(status, 200, withdrawn)
        with psycopg.connect(self.database_url) as connection:
            self.assertFalse(connection.execute('SELECT 1 FROM public.organization_quality_case WHERE owner_id=%s', (self.owner_id,)).fetchone())
            self.assertFalse(connection.execute('SELECT 1 FROM public.organization_quality_run WHERE owner_id=%s', (self.owner_id,)).fetchone())
        self.assertEqual(management.request('/api/layered-memory/quality-inputs/' + prepared['quality_input']['case_id'])[0], 404)
        self.assertEqual(management.request('/api/layered-memory/quality-runs/' + run['quality_report']['report_id'])[0], 404)

    def test_agent_annotations_are_recorded_without_becoming_human_quality(self):
        prepared = self.prepare_owner_input()
        memory = prepared['model_input']['memories'][0]
        annotation = {'input_sha256': prepared['input_sha256'], 'reviewer': {'kind': 'agent', 'name': '工程合成审阅'},
            'dimension': 'stability', 'scenario_key': 'synthetic-unique-1', 'decision': 'approved',
            'supported_claims': [{'claim_id': 's1', 'text': memory['text'],
                'references': [{'memory_id': memory['memory_id'], 'revision': memory['revision']}],
                'allowed_layers': ['l2', 'l3'], 'required_qualifiers': []}],
            'prohibited_claims': [], 'independence_notes': '单一合成场景，未声明人工审阅。',
            'empty_support_policy': 'normal', 'verifier_challenges': {}}
        path = '/api/layered-memory/quality-inputs/' + prepared['case_id']
        status, result = self.backend.request(path + '/annotations', annotation)
        self.assertEqual(status, 200, result)
        self.assertEqual(result['quality_input']['review_status'], 'unknown')
        self.assertFalse(result['quality_input']['quality_verified'])
        annotation['input_sha256'] = '0' * 64
        self.assertEqual(self.backend.request(path + '/annotations', annotation)[0], 409)

    def controlled_evaluation(self, *, empty_profile=False, empty_scenarios=False, gate_profile=None, suite_budget=None, entity_sizes=None, request_padding=0, no_response=False, strict_literal_verifier=False):
        import json
        import httpx
        from types import SimpleNamespace
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.application.organization_evaluation import OrganizationEvaluationRuntime
        from notalone.memory.organization_sdk import DeepSeekOrganizationProposal, DeepSeekOrganizationVerification
        from notalone.memory.organization_quality import OrganizationQualityService, OrganizationQualityContract, content_digest
        from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend

        def respond(request):
            if no_response:
                raise httpx.ReadTimeout('合成无响应；不调用外网。', request=request)
            payload = json.loads(request.content)
            data = json.loads(payload['messages'][1]['content'])
            memory = data['memories'][0]
            ref = {'memory_id': memory['memory_id'], 'revision': memory['revision']}
            if data.get('layer') in {'l2', 'l3'} and 'proposal' in data:
                result = {'supported': True, 'reasons': []}
                proposal = data['proposal']
                if strict_literal_verifier:
                    texts = [item['text'] for item in proposal.get('entries', [])] + [paragraph['text']
                        for scenario in proposal.get('scenarios', []) for paragraph in scenario['paragraphs']]
                    result['supported'] = all(text in {m['text'] for m in data['memories']} for text in texts)
                if data['layer'] == 'l3':
                    # 仅返回合成合同夹具，不把来源存在或此固定判定当成语义资格。
                    sources = {(m['memory_id'], m['revision']): m for m in data['memories']}
                    result['entries'] = []
                    for index, entry in enumerate(proposal['entries']):
                        quotes = [{**reference, 'quote': sources[(reference['memory_id'], reference['revision'])]['text']}
                                  for reference in entry['references']]
                        result['entries'].append({'entry_index': index, 'entry_sha256': content_digest(entry),
                            'references': entry['references'], 'supported': result['supported'], 'profile_eligible': result['supported'],
                            'temporal_basis': 'historical' if entry['temporal_status'] == 'historical' else 'current_unverified',
                            'temporal_references': [], 'basis': '合成资料仅保留原有时间限定。',
                            'claims': [{'text': entry['text'], 'sources': quotes, 'subject_role': 'relationship',
                                'subject_basis': '合成合同夹具的关系资料主体。', 'supported': result['supported'],
                                'profile_eligible': result['supported'], 'eligibility_basis': '仅供工程合同回归，不声明真实语义审阅。'}]})
            elif '从主题和底层' in payload['messages'][0]['content']:
                if gate_profile:
                    gate_profile[0].set()
                    gate_profile[1].wait(5)
                result = {'entries': [] if empty_profile else [{'text': memory['text'], 'references': [ref],
                    'temporal_status': 'uncertain',
                    'uncertainty': '当前状态按原资料保留，未额外核实。'}]}
            else:
                result = {'scenarios': [{'topic_key': 'supplement-' + memory['memory_id'] if data.get('corrections') else 'study',
                    'title': '已核对的补充资料' if data.get('corrections') else '合成学习',
                    'hint': '独立资料的原文背景。' if data.get('corrections') else '合成学习资料',
                    'paragraphs': [{'text': memory['text'], 'references': [ref]}]}]}
                if empty_scenarios:
                    result = {'scenarios': []}
            response = httpx.Response(200, json={'model': 'synthetic-boundary', 'choices': [{'message': {'content': json.dumps(result)}}]})
            if entity_sizes is not None:
                entity_sizes.append({'request_entity_bytes': len(request.content), 'request_entity_characters': len(request.content.decode('utf-8')),
                    'response_entity_bytes': len(response.content), 'response_entity_characters': len(response.content.decode('utf-8')),
                    'generated_content_characters': len(json.dumps(result))})
            return response
        transport = OrganizationQualityHTTPTransport(httpx.MockTransport(respond))
        client = httpx.Client(transport=transport)
        self.addCleanup(client.close)
        class BoundaryModel:
            def bind(self, **options):
                return self
            def invoke(self, messages):
                response = client.post('https://synthetic.invalid/chat/completions', json={
                    'model': 'synthetic-boundary', **({'padding': 'x' * request_padding} if request_padding else {}), 'messages': [{'role': 'system' if i == 0 else 'user', 'content': m.content} for i, m in enumerate(messages)]})
                content = response.json()['choices'][0]['message']['content']
                return SimpleNamespace(content=content, response_metadata={'finish_reason': 'stop'})
        contract = OrganizationQualityContract()
        model = BoundaryModel()
        ports = [cls(model, layer=layer, budget=contract.budget, transport=transport) for cls, layer in (
            (DeepSeekOrganizationProposal, 'l2'), (DeepSeekOrganizationVerification, 'l2'),
            (DeepSeekOrganizationProposal, 'l3'), (DeepSeekOrganizationVerification, 'l3'))]
        runtime = OrganizationEvaluationRuntime(scenario_proposer=ports[0], scenario_verifier=ports[1],
            profile_proposer=ports[2], profile_verifier=ports[3], suite_budget=suite_budget,
            source_ref='quality-local' if suite_budget is not None else None)
        store = PostgresLayeredMemoryStore(self.database_url)
        quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract, evaluation_runtime=runtime)
        service = LayeredMemoryService(store, quality=quality)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-quality', layered_memory=service), self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def test_bootstrap_and_restart_keep_one_physical_attempt_budget_and_never_grant_real_quality(self):
        prepared = self.prepare_owner_input()
        backend = self.controlled_evaluation()
        status, result = backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [prepared['case_id']], 'max_http_attempts': 2,
            'dataset_version': '受控传输额度两次', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        path = '/api/layered-memory/quality-runs/' + result['quality_report']['report_id']
        status, frozen = backend.request(path + '/execute', {'allow_unreviewed_smoke': False})
        self.assertEqual(status, 409, frozen)
        status, result = backend.request(path + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, result)
        report = result['quality_report']
        self.assertEqual((report['http_attempts_used'], report['failure_count'], len(report['attempts'])), (2, 1, 2))
        self.assertEqual(report['transport_kind'], 'synthetic')
        self.assertEqual(report['organization']['status'], 'failed')
        self.assertFalse(report['automatic_use_allowed'])
        restarted = self.controlled_evaluation()
        status, resumed = restarted.request(path + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, resumed)
        self.assertEqual(resumed['quality_report']['http_attempts_used'], 2)
        self.assertEqual(self._get(restarted, '/api/memories/owner/layered-memory')['layered_memory']['quality_status'], 'failed')

    def test_attempts_measure_complete_entities_and_rejected_request_has_no_physical_send(self):
        sizes = []
        prepared = self.prepare_owner_input()
        backend = self.controlled_evaluation(entity_sizes=sizes)
        def execute(case, server, label):
            status, created = server.request('/api/layered-memory/quality-runs', {'case_ids': [case['case_id']],
                'max_http_attempts': 6, 'dataset_version': label, 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
            self.assertEqual(status, 200, created)
            status, executed = server.request('/api/layered-memory/quality-runs/' + created['quality_report']['report_id'] + '/execute', {'allow_unreviewed_smoke': True})
            self.assertEqual(status, 200, executed)
            return executed['quality_report']
        report = execute(prepared, backend, '完整HTTP实体大小')
        self.assertEqual(report['failure_count'], 0, report['failures'])
        self.assertEqual(len(sizes), 4)
        for actual, measured in zip(report['attempts'], sizes):
            self.assertEqual({key: actual['measurements'][key] for key in measured}, measured)
            self.assertEqual(actual['measurements']['response_measurement'], 'decoded_http_entity_utf8')
        blocked = self.prepare_owner_input('另有独立合成预算资料。')
        blocked_sizes = []
        oversized = self.controlled_evaluation(entity_sizes=blocked_sizes, request_padding=5000)
        rejected = execute(blocked, oversized, '发送前完整请求拒绝')
        self.assertEqual(rejected['http_attempts_used'], 0)
        self.assertEqual(blocked_sizes, [])
        self.assertEqual(rejected['failures'][0]['error_code'], 'actual_request_budget_exceeded')
        evidence = rejected['cases'][0]['stage_evidence']['budget_rejections'][0]
        self.assertGreater(evidence['request_entity_characters'], evidence['limit_characters'])
        self.assertFalse(evidence['http_attempt_reserved'])
        self.assertIsNone(evidence['response_entity_characters'])
        self.assertIsNone(evidence['generated_content_characters'])

    def test_no_response_attempt_consumes_budget_and_keeps_result_unknown(self):
        prepared = self.prepare_owner_input()
        backend = self.controlled_evaluation(no_response=True)
        status, created = backend.request('/api/layered-memory/quality-runs', {'case_ids': [prepared['case_id']],
            'max_http_attempts': 1, 'dataset_version': '合成无响应边界', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        status, executed = backend.request('/api/layered-memory/quality-runs/' + created['quality_report']['report_id'] + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, executed)
        report = executed['quality_report']
        self.assertEqual(report['http_attempts_used'], 1)
        self.assertEqual(len(report['attempts']), 1)
        self.assertEqual(report['attempts'][0]['outcome'], 'unknown')
        self.assertIsNone(report['attempts'][0]['response_payload'])
        self.assertIsNone(report['attempts'][0]['measurements']['response_entity_bytes'])
        self.assertIsNone(report['attempts'][0]['measurements']['generated_content_characters'])

    def test_contact_model_boundary_preserves_its_distinct_allowlist_and_actual_provenance(self):
        from tests.integration.server.test_layered_memory_management import LayeredMemoryManagementHttpTest
        contact, _, _ = self.import_contact('合成联系人的公开资料。')
        status, added = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '合成联系人偏好提前安排课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        backend = LayeredMemoryManagementHttpTest.controlled(self)
        status, result = backend.request(f'/api/contacts/{contact}/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        self.assertEqual(set(self.proposal.inputs[0][0].to_payload()), {'memory_id', 'revision', 'text', 'provenance_kind', 'timing', 'event', 'category', 'valid_at', 'invalid_at'})
        self.assertEqual(self.proposal.inputs[0][0].to_payload()['provenance_kind'], 'manual_entry')

    def test_model_prompt_schema_purpose_organization_budget_and_evaluation_changes_invalidate_report(self):
        from dataclasses import replace
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.memory.organization_quality import OrganizationQualityContract, ReplyQualityContract, OrganizationQualityService
        from notalone.memory.layered import OrganizationBudget
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        prepared = self.prepare_owner_input()
        status, created = self.backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [prepared['case_id']], 'max_http_attempts': 6,
            'dataset_version': '精确合同变化', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        original = OrganizationQualityContract(budget=OrganizationBudget())
        for field, changed in [('request_model', 'new-candidate'), ('rules_version', 'new-rules'),
                ('prompt_version', 'new-prompt'), ('schema_version', 'new-schema'), ('purpose_version', 'new-purpose'),
                ('budget', OrganizationBudget(max_model_calls=4, max_characters=4500)), ('evaluation_version', 'new-evaluation')]:
            with self.subTest(field=field):
                store = PostgresLayeredMemoryStore(self.database_url)
                quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=replace(original, **{field: changed}))
                backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
                    token='synthetic-quality-contract', layered_memory=LayeredMemoryService(store, quality=quality)), self.owner_id)
                try:
                    stage = self._get(backend, '/api/memories/owner/layered-memory')['layered_memory']['quality']['organization']
                    self.assertIn('contract_changed', stage['reasons'])
                    self.assertEqual(stage['status'], 'unknown')
                finally:
                    backend.close()
        store = PostgresLayeredMemoryStore(self.database_url)
        quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=original,
            reply_contract=ReplyQualityContract(budget_version='reply-budget-only-change'))
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-quality-contract', layered_memory=LayeredMemoryService(store, quality=quality)), self.owner_id)
        self.addCleanup(backend.close)
        stage = self._get(backend, '/api/memories/owner/layered-memory')['layered_memory']['quality']['organization']
        self.assertNotIn('contract_changed', stage['reasons'])
        self.assertEqual(stage['contract_id'], original.identity)

    def test_temporary_information_can_leave_profile_empty_without_becoming_long_term_fact(self):
        prepared = self.prepare_owner_input('合成本人计划下周参加课程，尚无发生记录。')
        backend = self.controlled_evaluation(empty_profile=True)
        status, created = backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [prepared['case_id']], 'max_http_attempts': 6,
            'dataset_version': '计划不长期化', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        path = '/api/layered-memory/quality-runs/' + created['quality_report']['report_id']
        status, result = backend.request(path + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, result)
        report = result['quality_report']
        self.assertEqual(report['failure_count'], 0, report['failures'])
        self.assertEqual(report['cases'][0]['output']['l3'], {'entries': []})
        self.assertEqual(report['http_attempts_used'], 4)
        self.assertEqual(report['organization']['status'], 'unknown')

    def test_empty_l2_result_marks_normal_l3_not_applicable_without_fabricating_calls(self):
        prepared = self.prepare_owner_input('合成资料仅为无主体的条件片段，不能支持事实。')
        backend = self.controlled_evaluation(empty_scenarios=True)
        status, created = backend.request('/api/layered-memory/quality-runs', {'case_ids': [prepared['case_id']],
            'max_http_attempts': 6, 'dataset_version': '无支持主题的确定拒绝', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        status, result = backend.request('/api/layered-memory/quality-runs/' + created['quality_report']['report_id'] + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, result)
        report = result['quality_report']
        self.assertEqual(report['failure_count'], 0, report['failures'])
        self.assertEqual(report['cases'][0]['output']['l2'], {'scenarios': []})
        self.assertEqual(report['cases'][0]['output']['l3'], {'entries': []})
        self.assertFalse(report['cases'][0]['stage_evidence']['l3_checkpoint']['normal_call_required'])
        self.assertEqual(report['http_attempts_used'], 2)
        self.assertEqual(report['phase_counts']['l3_proposal']['executed_cases'], 0)
        self.assertEqual(report['phase_counts']['l3_proposal']['not_applicable_cases'], 1)
        self.assertEqual(report['organization']['status'], 'unknown')
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
        from notalone.memory.layered import OrganizationBudget
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        calls = []
        class EmptyProposal:
            timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
            def propose(self, *, memories, budget, deadline, scenarios=(), corrections=()):
                calls.append('l2_proposal')
                return {'scenarios': []}
        class Verification:
            timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
            def verify(self, *, memories, proposal, deadline, scenarios=(), corrections=()):
                calls.append('verification')
                return True
        class NoProfile:
            timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
            def propose(self, *, memories, scenarios, budget, deadline, corrections=()):
                raise AssertionError('无主题的正式路径不能假造L3调用。')
        service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url), synthetic=True,
            proposer=EmptyProposal(), verifier=Verification(), profile_proposer=NoProfile(), profile_verifier=Verification(),
            budget=OrganizationBudget(max_model_calls=4))
        production = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-empty-production', layered_memory=service), self.owner_id)
        self.addCleanup(production.close)
        status, enabled = production.request('/api/memories/owner/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, enabled)
        self.assertEqual(enabled['layered_memory']['scenarios'], [])
        self.assertIsNone(enabled['layered_memory']['profile'])
        self.assertEqual(calls, ['l2_proposal', 'verification'])

    def test_l3_challenge_executes_with_explicit_adversarial_input_when_normal_l3_is_not_applicable(self):
        prepared = self.prepare_owner_input('合成资料只有待定条件，不能支持具体事实。')
        ref = {key: prepared['model_input']['memories'][0][key] for key in ('memory_id', 'revision')}
        wrong = '合成当事人已经永远定居火星。'
        annotation = {'input_sha256': prepared['input_sha256'], 'reviewer': {'kind': 'agent', 'name': '工程挑战夹具'},
            'dimension': 'condition', 'scenario_key': 'synthetic-adversarial-na', 'decision': 'approved',
            'supported_claims': [], 'prohibited_claims': [{'claim_id': 'p1', 'text': wrong, 'reason': '实际资料不支持。'}],
            'independence_notes': '自有合成工程路径，不是人工质量结论。', 'empty_support_policy': 'reject',
            'verifier_challenges': {'l2': {'expected_supported': False, 'proposal': {'scenarios': [
                {'topic_key': 'synthetic-challenge', 'title': '合成挑战', 'hint': '合成错误候选',
                    'paragraphs': [{'text': wrong, 'references': [ref]}]}]}},
                'l3': {'expected_supported': False, 'proposal': {'entries': [
                    {'text': wrong, 'references': [ref], 'temporal_status': 'stable', 'uncertainty': ''}]}}}}
        backend = self.controlled_evaluation(empty_scenarios=True, strict_literal_verifier=True)
        self.assertEqual(backend.request('/api/layered-memory/quality-inputs/' + prepared['case_id'] + '/annotations', annotation)[0], 200)
        status, created = backend.request('/api/layered-memory/quality-runs', {'case_ids': [prepared['case_id']],
            'max_http_attempts': 6, 'dataset_version': '正常L3不适用时独立错误挑战', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        status, result = backend.request('/api/layered-memory/quality-runs/' + created['quality_report']['report_id'] + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, result)
        report = result['quality_report']
        self.assertEqual(report['failure_count'], 0, report['failures'])
        self.assertEqual(report['http_attempts_used'], 4)
        self.assertEqual(report['phase_counts']['l3_proposal']['not_applicable_cases'], 1)
        self.assertEqual(report['phase_counts']['l3_challenge']['executed_cases'], 1)
        case = report['cases'][0]
        self.assertEqual(case['stage_evidence']['l3_checkpoint']['model_input']['memories'], [])
        challenge = case['stage_evidence']['l3_challenge_input']
        self.assertEqual(challenge['kind'], 'adversarial_verification')
        self.assertFalse(challenge['normal_production_call'])
        self.assertEqual(challenge['model_input']['memories'], prepared['model_input']['memories'])
        actual = next(item for item in report['attempts'] if item['phase'] == 'l3_challenge')
        import json
        from notalone.memory.organization_quality import content_digest
        expected = {**challenge['model_input'], 'verification_targets': [
            {'entry_index': index, 'entry_sha256': content_digest(entry)}
            for index, entry in enumerate(challenge['model_input']['proposal']['entries'])]}
        self.assertEqual(json.loads(actual['request_payload']['messages'][1]['content']), expected)
        self.assertNotIn('expected_supported', actual['request_payload']['messages'][1]['content'])
        self.assertEqual(report['organization']['status'], 'unknown')

    def test_quality_input_deeply_equals_all_four_production_ports_for_each_scope(self):
        for owner in (True, False):
            with self.subTest(owner=owner):
                self.assert_all_ports_match(owner)

    def test_owner_l2_feedback_preserves_full_four_port_input(self):
        self.assert_all_ports_match(True, 'l2')

    def test_owner_l3_feedback_preserves_full_four_port_input(self):
        self.assert_all_ports_match(True, 'l3')

    def test_contact_l2_feedback_preserves_full_four_port_input(self):
        self.assert_all_ports_match(False, 'l2')

    def test_contact_l3_feedback_preserves_full_four_port_input(self):
        self.assert_all_ports_match(False, 'l3')

    def test_pending_owner_fact_is_excluded_from_all_four_actual_port_inputs(self):
        self.assert_all_ports_match(True, 'l2', fact_pending=True)

    def test_pending_contact_fact_is_excluded_from_all_four_actual_port_inputs(self):
        self.assert_all_ports_match(False, 'l3', fact_pending=True)

    def test_empty_l2_with_retained_owner_theme_matches_actual_l3_subset(self):
        self.assert_all_ports_match(True, empty_second=True)

    def test_empty_l2_with_retained_contact_theme_matches_actual_l3_subset(self):
        self.assert_all_ports_match(False, empty_second=True)

    def assert_all_ports_match(self, owner, feedback_layer=None, fact_pending=False, empty_second=False):
        from copy import deepcopy
        from datetime import datetime
        from uuid import UUID
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.application.organization_evaluation import OrganizationEvaluationRuntime
        from notalone.memory.organization_quality import OrganizationQualityService, OrganizationQualityContract
        from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
        from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        contact, _, _ = self.import_contact('合成联系人的学习资料。')
        base = '/api/memories/owner/layered-memory' if owner else f'/api/contacts/{contact}/layered-memory'
        fields = {} if owner else {'contact_id': contact}
        captured = {}
        from threading import Event
        fourth_input_received = Event()
        def record(key, memories, scenarios, corrections, **extra):
            captured[key] = deepcopy({'memories': [m.to_payload() for m in memories],
                'scenarios': list(scenarios), 'corrections': list(corrections), **extra})
        class Proposal:
            timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
            def __init__(self, layer):
                self.layer = layer
            def propose(self, *, memories, budget, deadline, scenarios=(), corrections=()):
                record(self.layer + '_propose', memories, scenarios, corrections, budget=budget.to_payload())
                ref = {'memory_id': str(memories[0].memory_id), 'revision': memories[0].revision}
                if self.layer == 'l2':
                    if empty_second and scenarios:
                        return {'scenarios': []}
                    return {'scenarios': [{'topic_key': 'supplement-' + str(memories[0].memory_id) if corrections else 'study', 'title': '已核对的补充资料' if corrections else '合成学习', 'hint': '独立资料的原文背景。' if corrections else '学习背景',
                        'paragraphs': [{'text': memories[0].text, 'references': [ref]}]}]}
                return {'entries': [{'text': memories[0].text, 'references': [ref],
                    'temporal_status': 'uncertain' if corrections else 'stable', 'uncertainty': '当前状态按原资料保留，未额外核实。' if corrections else ''}]}
        class Verification:
            timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT
            def __init__(self, layer):
                self.layer = layer
            def verify(self, *, memories, proposal, deadline, scenarios=(), corrections=()):
                record(self.layer + '_verify', memories, scenarios, corrections, proposal=proposal)
                if self.layer == 'l3':
                    fourth_input_received.set()
                return True
        status, added = self.backend.request('/api/memories/manual-owner' if owner else '/api/memories/manual-contact',
            {**fields, 'text': '合成范围有长期学习习惯。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        initial_memory = added['memory']
        contract = OrganizationQualityContract()
        store = PostgresLayeredMemoryStore(self.database_url)
        ports = (Proposal('l2'), Verification('l2'), Proposal('l3'), Verification('l3'))
        runtime = OrganizationEvaluationRuntime(scenario_proposer=ports[0], scenario_verifier=ports[1],
            profile_proposer=ports[2], profile_verifier=ports[3])
        quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract, evaluation_runtime=runtime)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-full-port-projection', layered_memory=LayeredMemoryService(store, quality=quality)), self.owner_id)
        self.addCleanup(backend.close)
        ready = None
        if feedback_layer or empty_second:
            setup_service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url), synthetic=True,
                budget=contract.budget, proposer=ports[0], verifier=ports[1], profile_proposer=ports[2], profile_verifier=ports[3])
            setup_backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
                token='synthetic-feedback-setup', layered_memory=setup_service), self.owner_id)
            self.addCleanup(setup_backend.close)
            status, initial = setup_backend.request(base + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
            self.assertEqual(status, 200, initial)
            ready = initial['layered_memory']
            from uuid import uuid4
            command = {'settings_generation': ready['settings_generation'],
                'organization_generation': ready['organization_generation'], 'target_kind': 'scenario' if feedback_layer == 'l2' else 'profile',
                'version_id': ready['scenarios'][0]['version_id'] if feedback_layer == 'l2' else ready['profile']['version_id'], 'item_index': 0}
            if fact_pending:
                command['memory_id'] = added['memory']['memory_id']
            else:
                command.update(reason='合成评测要求阻止旧总结复活。', operation_id=str(uuid4()))
            if feedback_layer:
                status, feedback = setup_backend.request(base + ('/fact-error' if fact_pending else '/summary-error'), command)
                self.assertEqual(status, 200, feedback)
            setup_backend.close()
            setup_service.stop()
            status, added = self.backend.request('/api/memories/manual-owner' if owner else '/api/memories/manual-contact',
                {**fields, 'text': '合成范围新增独立练习事实。', 'category': 'common_fact'})
            self.assertEqual(status, 200, added)
            captured.clear()
        versions = [{key: added['memory'][key] for key in ('memory_id', 'revision')}]
        if empty_second:
            versions.append({key: initial_memory[key] for key in ('memory_id', 'revision')})
        status, prepared = backend.request(base + '/quality-input', {'memory_versions': versions})
        self.assertEqual(status, 200, prepared)
        if feedback_layer:
            self.assertEqual(prepared['quality_input']['model_input']['scenarios'], [])
            if fact_pending:
                self.assertEqual(prepared['quality_input']['model_input']['corrections'], [])
                self.assertEqual(len(prepared['quality_input']['guard_snapshot']['fact_pending']), 1)
            else:
                self.assertTrue(prepared['quality_input']['model_input']['corrections'])
            self.assertEqual({m['memory_id'] for m in prepared['quality_input']['model_input']['memories']}, {added['memory']['memory_id']})
        status, created = backend.request('/api/layered-memory/quality-runs', {'case_ids': [prepared['quality_input']['case_id']],
            'max_http_attempts': 6, 'dataset_version': '完整四Port投影深等', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        status, executed = backend.request('/api/layered-memory/quality-runs/' + created['quality_report']['report_id'] + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, executed)
        report = executed['quality_report']
        self.assertEqual(report['failure_count'], 0, report['failures'])
        evaluated = deepcopy(captured)
        self.assertEqual(evaluated['l2_propose']['scenarios'], evaluated['l2_verify']['scenarios'])
        evidence = report['cases'][0]['stage_evidence']['l3_checkpoint']
        self.assertFalse(evidence['published_to_product'])
        document = evidence['documents'][0]
        fixed_ids = iter([UUID(document['version_id'])])
        fixed_clock = datetime.fromisoformat(document['updated_at'])
        actual_store = PostgresLayeredMemoryStore(self.database_url, clock=lambda: fixed_clock,
            scenario_version_id_factory=lambda: next(fixed_ids))
        service = LayeredMemoryService(actual_store, synthetic=True, budget=contract.budget,
            proposer=ports[0], verifier=ports[1], profile_proposer=ports[2], profile_verifier=ports[3])
        captured.clear()
        fourth_input_received.clear()
        production = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-full-port-production', layered_memory=service), self.owner_id)
        self.addCleanup(production.close)
        status, enabled = production.request(base + ('/refresh' if ready else '/enable'),
            {'settings_generation': ready['settings_generation']} if ready else {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, enabled)
        self.assertTrue(fourth_input_received.wait(5), enabled)
        self.assertEqual(set(captured), {'l2_propose', 'l2_verify', 'l3_propose', 'l3_verify'})
        self.assertEqual(captured, evaluated)

    def test_running_partial_output_cannot_receive_a_complete_human_review(self):
        from threading import Event, Thread
        from notalone.memory.organization_quality import content_digest
        prepared = self.prepare_owner_input()
        entered, release = Event(), Event()
        backend = self.controlled_evaluation(gate_profile=(entered, release))
        status, created = backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [prepared['case_id']], 'max_http_attempts': 6,
            'dataset_version': '运行中部分输出不能提前审阅', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        path = '/api/layered-memory/quality-runs/' + created['quality_report']['report_id']
        results = []
        thread = Thread(target=lambda: results.append(backend.request(path + '/execute', {'allow_unreviewed_smoke': True})))
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            report = self._get(backend, path)['quality_report']
            case = report['cases'][0]
            refs = [{'memory_id': prepared['model_input']['memories'][0]['memory_id'], 'revision': 1}]
            partial_review = {'output_sha256': content_digest(case['output']), 'reviewer': {'kind': 'human', 'name': '合成协议审阅者'},
                'decision': 'approved', 'claims': [{'path': item['path'], 'supported': True, 'references': refs,
                    'critical_errors': [], 'notes': '合成结构测试，不代表真实人工质量。'} for item in case['review_items']],
                'projection_passed': True, 'verifier_challenges_reviewed': True}
            status, result = backend.request('/api/layered-memory/quality-inputs/' + prepared['case_id'] + '/review', partial_review)
            self.assertEqual(status, 409, result)
        finally:
            release.set()
            thread.join(7)
        self.assertFalse(thread.is_alive())
        final = self._get(backend, path)['quality_report']
        self.assertIsNone(final['cases'][0]['output_review'])
        self.assertIn('human_output_review_missing', final['organization']['reasons'])

    def test_trusted_source_unavailable_is_unknown_and_same_database_source_is_rejected(self):
        from uuid import uuid4
        from notalone.application.organization_qualification import PostgresOrganizationQualificationSource
        from notalone.memory.organization_quality import OrganizationQualityService
        from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        store = PostgresOrganizationQualityStore(PostgresLayeredMemoryStore(self.database_url))
        source = PostgresOrganizationQualificationSource(database_url=self.database_url,
            expected_database=self.database_url.split('dbname=')[1], owner_id=self.owner_id, run_id=uuid4())
        with self.assertRaisesRegex(ValueError, '隔离'):
            OrganizationQualityService(store, qualification_source=source)
        missing = PostgresOrganizationQualificationSource(database_url='host=/tmp dbname=notalone_quality_absent_test',
            expected_database='notalone_quality_absent_test', owner_id=self.owner_id, run_id=uuid4())
        quality = OrganizationQualityService(store, qualification_source=missing)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-source-unavailable', layered_memory=LayeredMemoryService(store._layered, quality=quality)), self.owner_id)
        self.addCleanup(backend.close)
        state = self._get(backend, '/api/memories/owner/layered-memory')['layered_memory']
        self.assertEqual(state['quality_status'], 'unknown')
        self.assertIn('qualification_source_unavailable', state['quality']['organization']['reasons'])
        status, result = backend.request('/api/memories/owner/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['layered_memory']['status'], 'blocked')

    def test_feedback_invalidates_old_quality_input_and_new_snapshot_uses_real_guard_context(self):
        from uuid import uuid4
        from tests.integration.server.test_layered_memory_corrections import CorrectionProposal, CorrectionVerification
        from tests.integration.server.test_layered_memory_management import LayeredMemoryManagementHttpTest
        contact, _, _ = self.import_contact('合成纠错主题资料。')
        status, original = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '双方共同参加过合成课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, original)
        backend = LayeredMemoryManagementHttpTest.controlled(self, proposer=CorrectionProposal(), verifier=CorrectionVerification())
        base = f'/api/contacts/{contact}/layered-memory'
        status, enabled = backend.request(base + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, enabled)
        ready = enabled['layered_memory']
        status, prepared = backend.request(base + '/quality-input', {'memory_versions': [{
            'memory_id': original['memory']['memory_id'], 'revision': original['memory']['revision']}]})
        self.assertEqual(status, 200, prepared)
        case_path = '/api/layered-memory/quality-inputs/' + prepared['quality_input']['case_id']
        status, result = backend.request(base + '/summary-error', {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'], 'target_kind': 'scenario',
            'version_id': ready['scenarios'][0]['version_id'], 'item_index': 0, 'reason': '合成总结含义错误。', 'operation_id': str(uuid4())})
        self.assertEqual(status, 200, result)
        self.assertEqual(backend.request(case_path)[0], 404)
        status, added = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '双方另有独立合成练习事实。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        status, current = backend.request(base + '/quality-input', {'memory_versions': [{
            'memory_id': added['memory']['memory_id'], 'revision': added['memory']['revision']}]})
        self.assertEqual(status, 200, current)
        frozen = current['quality_input']
        self.assertEqual(frozen['guard_snapshot']['correction_revision'], 1)
        self.assertEqual(frozen['guard_snapshot']['feedback_targets'][0]['target_kind'], 'scenario')
        self.assertEqual(set(frozen['model_input']['corrections'][0]), {'feedback_id', 'rejected_text', 'reason', 'rule'})
        status, refreshed = backend.request(base + '/refresh', {'settings_generation': ready['settings_generation']})
        self.assertEqual(status, 200, refreshed)
        self.assertEqual(list(self.proposal.corrections[-1]), frozen['model_input']['corrections'])
        self.assertEqual([m.to_payload() for m in self.proposal.inputs[-1]], frozen['model_input']['memories'])
        self.assertEqual({m['memory_id'] for m in frozen['model_input']['memories']}, {added['memory']['memory_id']})

    def test_physical_transport_uses_same_persistent_suite_after_service_restart(self):
        import os
        from pathlib import Path
        from notalone.memory.organization_quality import content_digest
        from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget, SUITE_SCHEMA
        prepared = self.prepare_owner_input()
        backend = self.controlled_evaluation()
        status, created = backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [prepared['case_id']], 'max_http_attempts': 2,
            'dataset_version': '真实transport共享suite额度', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        report = created['quality_report']
        fixture = {'scenario_key': 'transport-scope-1', 'dimension': 'stability', 'scope_kind': 'owner',
            'feedback_mode': 'baseline', 'feedback_layer': None, 'source_ref': {'key': 'quality-local',
                'database_url_env': 'NOTALONE_TEST_DATABASE_URL', 'expected_database': os.environ['NOTALONE_EXPECTED_TEST_DATABASE']},
            'owner_id': str(self.owner_id), 'run_id': report['report_id'], 'case_id': prepared['case_id'],
            'input_sha256': prepared['input_sha256'], 'annotation_sha256': content_digest(None), 'allocated_attempts': 2}
        directory = Path(self.temporary.name) / 'transport-suite'
        quota = PersistentSuiteBudget.create(directory, {'schema_version': SUITE_SCHEMA, 'dataset_version': '受控transport测试',
            'contract_id': report['contract_id'], 'max_http_attempts': 2, 'fixtures': [fixture]})
        path = '/api/layered-memory/quality-runs/' + report['report_id']
        bounded = self.controlled_evaluation(suite_budget=quota)
        status, result = bounded.request(path + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['quality_report']['http_attempts_used'], 2)
        self.assertEqual(quota.snapshot()['used_attempts'], 2)
        self.assertTrue(all(row['result']['request_route'] == 'https://synthetic.invalid/chat/completions'
                            for row in quota.snapshot()['reservations']))
        resumed = self.controlled_evaluation(suite_budget=PersistentSuiteBudget.open(directory))
        status, result = resumed.request(path + '/execute', {'allow_unreviewed_smoke': True})
        self.assertEqual(status, 200, result)
        self.assertEqual(quota.snapshot()['used_attempts'], 2)
        self.assertFalse(result['quality_report']['automatic_use_allowed'])

    def test_feedback_source_erasure_clears_running_quality_copies_and_late_receipts(self):
        import psycopg
        from datetime import datetime, timezone
        from threading import Event, Thread
        from uuid import uuid4
        from tests.integration.server.test_layered_memory_corrections import CorrectionProposal, CorrectionVerification
        from tests.integration.server.test_layered_memory_management import LayeredMemoryManagementHttpTest
        contact, source_a, message_a = self.import_contact('合成反馈保护的原依据。')
        self.confirm(contact, '双方有合成学习经历。', message_a)
        _, source_b, message_b = self.import_contact('合成反馈保护的比较依据。', contact_id=contact,
            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        self.confirm(contact, '双方有合成练习经历。', message_b)
        management = LayeredMemoryManagementHttpTest.controlled(self, proposer=CorrectionProposal(), verifier=CorrectionVerification())
        base = f'/api/contacts/{contact}/layered-memory'
        status, enabled = management.request(base + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, enabled)
        ready = enabled['layered_memory']
        status, result = management.request(base + '/summary-error', {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'], 'target_kind': 'scenario',
            'version_id': ready['scenarios'][0]['version_id'], 'item_index': 0,
            'reason': '合成删除必须清除这份反馈正文。', 'operation_id': str(uuid4())})
        self.assertEqual(status, 200, result)
        status, added = self.backend.request('/api/memories/manual-contact', {'contact_id': contact,
            'text': '双方另有独立合成课程事实。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        entered, release = Event(), Event()
        evaluation = self.controlled_evaluation(gate_profile=(entered, release))
        versions = [{'memory_id': added['memory']['memory_id'], 'revision': added['memory']['revision']}]
        status, prepared = evaluation.request(base + '/quality-input', {'memory_versions': versions})
        self.assertEqual(status, 200, prepared)
        case_path = '/api/layered-memory/quality-inputs/' + prepared['quality_input']['case_id']
        status, created = evaluation.request('/api/layered-memory/quality-runs', {'case_ids': [prepared['quality_input']['case_id']],
            'max_http_attempts': 6, 'dataset_version': '删除反馈参与来源和迟到回执', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        run_path = '/api/layered-memory/quality-runs/' + created['quality_report']['report_id']
        results = []
        worker = Thread(target=lambda: results.append(evaluation.request(run_path + '/execute', {'allow_unreviewed_smoke': True})))
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            self.delete_source(contact, source_b)
            self.assertNotEqual(evaluation.request(case_path)[0], 200)
            self.assertNotEqual(evaluation.request(run_path)[0], 200)
            with psycopg.connect(self.database_url) as connection:
                for table in ('organization_quality_case', 'organization_quality_run', 'organization_quality_attempt'):
                    self.assertEqual(connection.execute(f'SELECT count(*) FROM public.{table}').fetchone()[0], 0, table)
        finally:
            release.set()
            worker.join(7)
        self.assertFalse(worker.is_alive())
        restarted = self.controlled_evaluation()
        self.assertEqual(restarted.request(case_path)[0], 404)
        self.assertEqual(restarted.request(run_path)[0], 404)
        status, guarded = restarted.request(base + '/quality-input', {'memory_versions': versions})
        self.assertEqual(status, 200, guarded)
        item = guarded['quality_input']
        self.assertEqual(item['guard_snapshot']['feedback_targets'][0]['state'], 'erased_guard')
        self.assertIsNone(item['model_input']['corrections'][0]['rejected_text'])
        self.assertIsNone(item['model_input']['corrections'][0]['reason'])
        self.delete_source(contact, source_a)
        self.assertEqual(restarted.request('/api/layered-memory/quality-inputs/' + item['case_id'])[0], 404)
        with psycopg.connect(self.database_url) as connection:
            self.assertFalse(connection.execute('SELECT 1 FROM public.organization_quality_case WHERE owner_id=%s', (self.owner_id,)).fetchone())

    def test_explicit_fact_preparation_binds_true_owner_transition_once_and_erases_copies(self):
        self.assert_fact_preparation_path(owner=True)

    def test_explicit_fact_preparation_binds_true_contact_transition_once_and_erases_copies(self):
        self.assert_fact_preparation_path(owner=False)

    def test_ordinary_prepared_run_never_collects_fact_correction_history(self):
        self.assert_fact_preparation_path(owner=False, registered=False)

    def test_explicit_withdrawal_during_pending_never_recreates_fact_receipt(self):
        self.assert_fact_preparation_path(owner=True, withdraw=True)

    def test_disable_during_pending_never_recreates_fact_receipt(self):
        self.assert_fact_preparation_path(owner=False, disable=True)

    def test_withdrawing_consumed_origin_clears_consumer_report_and_late_receipts(self):
        self.assert_fact_preparation_path(owner=True, withdraw_consumed=True)

    def test_observation_erasure_clears_fact_preparation_and_pending_quality_copies(self):
        from uuid import UUID, uuid4
        import psycopg
        from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
        from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
        contact, _, message = self.import_contact('合成双来源的课程资料。')
        binding = PostgresConversationBindingRepository(self.database_url).create_binding(owner_id=self.owner_id,
            contact_id=UUID(contact), channel='wechat', account_scope='synthetic-quality-observation',
            conversation_locator=self.contact_locators[contact])
        observations = PostgresObservationStore(self.database_url)
        observed = observations.record_batch(owner_id=self.owner_id, contact_id=UUID(contact), binding_id=binding.binding_id,
            mode=ObservationMode.LIVE, cli_version='synthetic-cli', conversation_locator=self.contact_locators[contact],
            last_local_id=10, last_cursor='synthetic:10', record_count=1)
        reference = uuid4()
        # 自有合成规范消息的双来源装配；不运行CLI或读取微信。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.message_source_ref(id,message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) "
                "VALUES(%s,%s,%s,%s,'local_wechat_observation',%s,'synthetic:10','{}')",
                (reference, message, self.owner_id, UUID(contact), observed.observation_id))
        memory = self.confirm(contact, '双方共同参加过合成课程。', message)
        backend = self.qualified_controlled()
        base = f'/api/contacts/{contact}/layered-memory'
        status, result = backend.request(base + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        ready = result['layered_memory']
        status, initial = backend.request(base + '/quality-input', {'memory_versions': [{'memory_id': memory['memory_id'], 'revision': memory['revision']}]})
        self.assertEqual(status, 200, initial)
        status, prepared = backend.request('/api/layered-memory/quality-runs', {'case_ids': [initial['quality_input']['case_id']],
            'max_http_attempts': 1, 'dataset_version': 'fact-correction-path-preparation-v1', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, prepared)
        self.assertEqual(backend.request(base + '/fact-error', {'settings_generation': ready['settings_generation'],
            'organization_generation': ready['organization_generation'], 'target_kind': 'scenario',
            'version_id': ready['scenarios'][0]['version_id'], 'item_index': 0, 'memory_id': memory['memory_id']})[0], 200)
        status, added = self.backend.request('/api/memories/manual-contact', {'contact_id': contact,
            'text': '有另一条独立合法合成资料。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        status, pending = backend.request(base + '/quality-input', {'memory_versions': [
            {key: added['memory'][key] for key in ('memory_id', 'revision')}]})
        self.assertEqual(status, 200, pending)
        guard = pending['quality_input']['guard_snapshot']['fact_pending'][0]
        self.assertIn(str(observed.observation_id), guard['observation_ids'])
        self.assertIn(str(reference), guard['source_ref_ids'])
        with psycopg.connect(self.database_url) as connection:
            intent = connection.execute('SELECT dependency_ids FROM public.organization_quality_fact_intent WHERE owner_id=%s', (self.owner_id,)).fetchone()
            self.assertIn(observed.observation_id, intent[0])
            self.assertIn(reference, intent[0])
        observations.delete_observation(owner_id=self.owner_id, contact_id=UUID(contact), observation_id=observed.observation_id)
        with psycopg.connect(self.database_url) as connection:
            for table in ('organization_quality_fact_intent', 'organization_quality_case', 'organization_quality_run'):
                self.assertEqual(connection.execute(f'SELECT count(*) FROM public.{table} WHERE owner_id=%s', (self.owner_id,)).fetchone()[0], 0)
        self.assertEqual(backend.request('/api/layered-memory/quality-inputs/' + pending['quality_input']['case_id'])[0], 404)

    def assert_fact_preparation_path(self, *, owner, registered=True, withdraw=False, disable=False, withdraw_consumed=False):
        import json
        import psycopg
        contact, _, _ = self.import_contact('合成事实路径的联系人。')
        fields = {} if owner else {'contact_id': contact}
        manual = '/api/memories/manual-owner' if owner else '/api/memories/manual-contact'
        base = '/api/memories/owner/layered-memory' if owner else f'/api/contacts/{contact}/layered-memory'
        memories = '/api/memories/owner' if owner else f'/api/contacts/{contact}/memories'
        original = '合成当事人每周五参加陶艺。'
        corrected = '合成当事人每周三参加陶艺。'
        status, added = self.backend.request(manual, {**fields, 'text': original, 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        old = added['memory']
        management = self.qualified_controlled()
        status, enabled = management.request(base + '/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, enabled)
        ready = enabled['layered_memory']
        status, initial = management.request(base + '/quality-input', {'memory_versions': [{'memory_id': old['memory_id'], 'revision': old['revision']}]})
        self.assertEqual(status, 200, initial)
        status, run = management.request('/api/layered-memory/quality-runs', {'case_ids': [initial['quality_input']['case_id']],
            'max_http_attempts': 1, 'dataset_version': 'fact-correction-path-preparation-v1' if registered else '普通合成评测准备',
            'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, run)
        if registered:
            self.assertEqual(run['quality_report']['preparation']['state'], 'armed')
            self.assertFalse(run['quality_report']['preparation']['human_review'])
            evaluation = self.controlled_evaluation()
            self.assertEqual(evaluation.request('/api/layered-memory/quality-runs/' + run['quality_report']['report_id'] + '/execute', {'allow_unreviewed_smoke': True})[0], 409)
        command = {'settings_generation': ready['settings_generation'], 'organization_generation': ready['organization_generation'],
            'target_kind': 'scenario', 'version_id': ready['scenarios'][0]['version_id'], 'item_index': 0, 'memory_id': old['memory_id']}
        status, reported = management.request(base + '/fact-error', command)
        self.assertEqual(status, 200, reported)
        self.assertEqual(management.request('/api/layered-memory/quality-inputs/' + initial['quality_input']['case_id'])[0], 404)
        self.assertEqual(management.request('/api/layered-memory/quality-runs/' + run['quality_report']['report_id'])[0], 404)
        self.assertEqual(management.request(base + '/quality-input', {'memory_versions': [{'memory_id': old['memory_id'], 'revision': old['revision']}]})[0], 409)
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute('SELECT to_jsonb(v) FROM public.organization_quality_fact_intent v WHERE owner_id=%s', (self.owner_id,)).fetchall()
            self.assertEqual(len(rows), 1 if registered else 0)
            if registered:
                self.assertEqual(rows[0][0]['state'], 'pending')
                self.assertNotIn(original, json.dumps(rows[0][0], ensure_ascii=False))
        if withdraw:
            self.assertEqual(management.request('/api/layered-memory/quality-runs/' + run['quality_report']['report_id'], method='DELETE')[0], 200)
        if disable:
            self.assertEqual(management.request(base + '/disable', {'settings_generation': ready['settings_generation']})[0], 200)
        if withdraw or disable:
            with psycopg.connect(self.database_url) as connection:
                self.assertFalse(connection.execute('SELECT 1 FROM public.organization_quality_fact_intent WHERE owner_id=%s', (self.owner_id,)).fetchone())
        status, result = self.backend.request(memories + '/' + old['memory_id'] + '/correct', {'text': corrected})
        self.assertEqual(status, 200, result)
        new = result['memory']
        status, final = management.request(base + '/quality-input', {'memory_versions': [{'memory_id': new['memory_id'], 'revision': new['revision']}]})
        self.assertEqual(status, 200, final)
        facts = final['quality_input']['stage_evidence']['fact_corrections']
        self.assertEqual(len(facts), 1)
        if registered and not withdraw and not disable:
            receipt = facts[0]['fact_error_receipt']
            self.assertEqual(receipt['state'], 'consumed')
            self.assertEqual(receipt['origin_run_id'], run['quality_report']['report_id'])
            self.assertEqual(receipt['old_memory_id'], old['memory_id'])
            self.assertEqual(receipt['replacement_memory_id'], new['memory_id'])
            if withdraw_consumed:
                evaluation = self.controlled_evaluation()
                status, consumer = evaluation.request('/api/layered-memory/quality-runs', {'case_ids': [final['quality_input']['case_id']],
                    'max_http_attempts': 6, 'dataset_version': '合成已消费用途清理', 'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
                self.assertEqual(status, 200, consumer)
                consumer_run = consumer['quality_report']['report_id']
                self.assertEqual(evaluation.request('/api/layered-memory/quality-runs/' + consumer_run + '/execute', {'allow_unreviewed_smoke': True})[0], 200)
                with psycopg.connect(self.database_url) as connection:
                    attempt_id = connection.execute('SELECT id FROM public.organization_quality_attempt WHERE run_id=%s LIMIT 1', (consumer_run,)).fetchone()[0]
                self.assertEqual(management.request('/api/layered-memory/quality-runs/' + run['quality_report']['report_id'], method='DELETE')[0], 200)
                with psycopg.connect(self.database_url) as connection:
                    for table in ('organization_quality_case', 'organization_quality_run', 'organization_quality_attempt'):
                        self.assertEqual(connection.execute(f'SELECT count(*) FROM public.{table}').fetchone()[0], 0)
                from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
                from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
                PostgresOrganizationQualityStore(PostgresLayeredMemoryStore(self.database_url)).finish_attempt(
                    self.owner_id, attempt_id, response={'late': corrected}, outcome='succeeded', duration_ms=1)
                self.assertEqual(evaluation.request('/api/layered-memory/quality-runs/' + consumer_run)[0], 404)
                self.assertEqual(management.request('/api/layered-memory/quality-inputs/' + final['quality_input']['case_id'])[0], 404)
                return
            status, repeated = management.request(base + '/quality-input', {'memory_versions': [{'memory_id': new['memory_id'], 'revision': new['revision']}]})
            self.assertEqual(status, 200, repeated)
            self.assertIsNone(repeated['quality_input']['stage_evidence']['fact_corrections'][0]['fact_error_receipt'])
        else:
            self.assertIsNone(facts[0]['fact_error_receipt'])
        self.assertEqual(self.backend.request(memories + '/' + new['memory_id'] + '/delete', {})[0], 200)
        self.assertEqual(management.request('/api/layered-memory/quality-inputs/' + final['quality_input']['case_id'])[0], 404)
        with psycopg.connect(self.database_url) as connection:
            self.assertFalse(connection.execute('SELECT 1 FROM public.organization_quality_fact_intent WHERE owner_id=%s', (self.owner_id,)).fetchone())

    def qualified_controlled(self, *, revoke_after_verification=False, reject_at_writer=False, initially_valid=True):
        from contextlib import contextmanager
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.memory.layered import LayeredMemoryConflict
        from notalone.memory.organization_quality import OrganizationQualityService, content_digest
        from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        from tests.integration.server.test_layered_memory_management import EchoProposal, HookVerification
        from tests.integration.server.test_layered_profile_management import ProfileProposal, ProfileVerification
        class ControlledQualificationBoundary:
            valid = True
            def validate_target(self, database_url):
                if not database_url.endswith('_test'):
                    raise ValueError('受控资格fixture仅允许自有隔离库。')
            def resolve(self, contract, connection=None):
                return {'stage': {'status': 'verified' if self.valid else 'unknown',
                    'reasons': [] if self.valid else ['input_invalidated'], 'contract_id': contract.identity,
                    'report_id': 'controlled-receipt-never-real-evidence'},
                    'receipt': content_digest({'contract': contract.identity, 'fixture_valid': self.valid}), 'model_identities': []}
            @contextmanager
            def hold(self, contract, snapshot):
                if reject_at_writer:
                    self.valid = False
                current = self.resolve(contract)
                if not self.valid or current['receipt'] != snapshot['receipt']:
                    raise LayeredMemoryConflict('受控来源在writer前撤销，仅验证工程失效链。')
                yield
        source = ControlledQualificationBoundary()
        source.valid = initially_valid
        self.controlled_qualification_source = source
        store = PostgresLayeredMemoryStore(self.database_url)
        quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), qualification_source=source)
        def hook():
            if revoke_after_verification:
                source.valid = False
        self.controlled_qualified_service = LayeredMemoryService(store, synthetic=True, synthetic_quality_required=True,
            quality=quality, proposer=EchoProposal(), verifier=HookVerification(hook),
            profile_proposer=ProfileProposal(), profile_verifier=ProfileVerification())
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='controlled-required-quality', layered_memory=self.controlled_qualified_service), self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def test_source_restored_after_start_automatically_maintains_new_l1_and_revocation_stops_again(self):
        from threading import Event
        import psycopg
        status, first = self.backend.request('/api/memories/manual-owner', {'text': '合成本人有共同课程经历。', 'category': 'common_fact'})
        self.assertEqual(status, 200, first)
        initial = self.qualified_controlled()
        self.assertEqual(initial.request('/api/memories/owner/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})[0], 200)
        initial.close()
        restored = self.qualified_controlled(initially_valid=False)
        service, source = self.controlled_qualified_service, self.controlled_qualification_source
        finished = Event()
        service._profile_proposer.hook = finished.set
        self.assertEqual(len(service._proposer.inputs), 0)
        status, added = self.backend.request('/api/memories/manual-owner', {'text': '合成本人另有新的练习经历。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        self.assertFalse(finished.wait(.7))
        self.assertEqual(len(service._proposer.inputs), 0)
        source.valid = True
        self.assertTrue(finished.wait(5), '来源恢复后无需人工刷新或重启，即应补维护。')
        ready = restored.request('/api/memories/owner/layered-memory')[1]['layered_memory']
        self.assertTrue(ready['scenarios'])
        self.assertFalse(ready['quality']['automatic_use_allowed'])
        self.assertEqual(ready['quality']['reply']['status'], 'unknown')
        self.assertTrue(any(item.memory_id.hex == added['memory']['memory_id'].replace('-', '')
            for batch in service._proposer.inputs for item in batch))
        source.valid = False
        before = len(service._proposer.inputs)
        self.assertEqual(self.backend.request('/api/memories/manual-owner', {'text': '合成本人又有一项新资料。', 'category': 'common_fact'})[0], 200)
        finished.clear()
        self.assertFalse(finished.wait(.7))
        self.assertEqual(len(service._proposer.inputs), before)
        service.start_maintenance(self.owner_id)
        service.start_maintenance(self.owner_id)
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                "AND application_name='notalone-layered-change-feed'").fetchone()[0]
            self.assertEqual(count, 1)

    def test_required_organization_qualification_can_organize_while_reply_layers_stay_closed(self):
        from uuid import UUID
        from notalone.scopes import ContactScope
        contact, _, _ = self.import_contact('合成必需资格流程。')
        status, added = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact, 'text': '双方共同参加过合成课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        backend = self.qualified_controlled()
        status, result = backend.request(f'/api/contacts/{contact}/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        state = result['layered_memory']
        self.assertEqual(state['status'], 'ready')
        self.assertTrue(state['scenarios'])
        self.assertIsNotNone(state['profile'])
        self.assertEqual(state['quality_status'], 'synthetic')
        self.assertFalse(state['quality']['automatic_use_allowed'])
        self.assertEqual(state['quality']['reply']['status'], 'unknown')
        self.assertIsNone(self.controlled_qualified_service.capture(ContactScope(self.owner_id, UUID(contact))))
        memories = self._get(self.backend, f'/api/contacts/{contact}/memories')['memories']
        self.assertEqual([m['memory_id'] for m in memories], [added['memory']['memory_id']])

    def test_required_qualification_revoked_after_model_or_at_writer_never_publishes(self):
        for writer in (False, True):
            with self.subTest(writer=writer):
                contact, _, _ = self.import_contact('合成资格撤回并发。')
                status, added = self.backend.request('/api/memories/manual-contact', {
                    'contact_id': contact, 'text': '双方共同参加过合成课程。', 'category': 'common_fact'})
                self.assertEqual(status, 200, added)
                backend = self.qualified_controlled(revoke_after_verification=not writer, reject_at_writer=writer)
                status, result = backend.request(f'/api/contacts/{contact}/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})
                self.assertEqual(status, 200, result)
                self.assertEqual(result['layered_memory']['scenarios'], [])
                self.assertIsNone(result['layered_memory']['profile'])
                self.assertFalse(result['layered_memory']['quality']['automatic_use_allowed'])


from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OrganizationQualityReplyHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    qualified_controlled = OrganizationQualityHttpTest.qualified_controlled

    def test_organization_qualified_reply_unknown_keeps_actual_reply_l1_without_new_layers(self):
        from notalone.reply.layered_context import LayeredReplyBudget
        contact, _, _ = self.import_contact('合成独立资格的回复资料。')
        status, added = self.backend.request('/api/memories/manual-contact', {'contact_id': contact,
            'text': '双方共同参加过合成课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        management = self.qualified_controlled()
        status, result = management.request(f'/api/contacts/{contact}/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        ready = result['layered_memory']
        self.assertTrue(ready['scenarios'])
        self.assertIsNotNone(ready['profile'])
        self.layered_reply_options = {'layered_memory': self.controlled_qualified_service,
            'layered_reply_budget': LayeredReplyBudget(4, 4, 4000)}
        self.activate_replies(contact)
        self.reply_model.plans.append({'text': '聊聊一起参加的课程。', 'basis': '仅按本次实际提供的底层资料。', 'cite_kinds': ['confirmed_memory']})
        status, turn = self.backend.request(self.reply_path(contact) + '/replies', self.rewrite_body(contact, '聊聊合成课程。'))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertIsNone(evidence['layered_context'])
        self.assertEqual(evidence['layered_scenario_reads'], [])
        self.assertTrue(any(item['kind'] == 'confirmed_memory' for item in evidence['evidence']))
        self.assertNotIn(ready['scenarios'][0]['version_id'], str(self.reply_model.payloads))
        self.assertNotIn(ready['profile']['version_id'], str(self.reply_model.payloads))
