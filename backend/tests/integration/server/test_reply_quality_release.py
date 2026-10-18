"""11正式装配与资格撤销沿公开HTTP、真实PG和离线供应商协议验证。"""
import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx
from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.application.reply_qualification import ReplyReadConfiguration
from notalone.memory.organization_quality import OrganizationQualityService, ReplyQualityContract, content_digest
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.layered_context import LayeredReplyBudget
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.integration.server.core_business_flow_support import HttpBackend
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server.test_layered_reply_context import LayeredReplyHttpTest as LayeredSupport


class ReplyQualityReleaseHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    controlled = LayeredSupport.controlled
    enable = LayeredSupport.enable
    read = LayeredSupport.read
    prepare_layered_reply = LayeredSupport.prepare_layered_reply

    def sdk_backend(self, layer_service, *, on_send=None):
        self.actual_calls = []
        def respond(request):
            payload = json.loads(request.content)
            self.actual_calls.append(payload)
            if on_send:
                on_send()
            current = next(json.loads(message['content']) for message in reversed(payload['messages'])
                           if message['role'] == 'user')
            primary = next(item for item in current['evidence'] if item['kind'] == 'user_draft')
            args = {'candidates': [{'text': current['draft_text'], 'basis': '保留本次草稿。',
                    'citation_ids': [primary['evidence_id']], 'risk_notes': []}], 'used_skill_version_id': None}
            return httpx.Response(200, json={'id': 'offline-reply', 'object': 'chat.completion', 'created': 0,
                'model': 'deepseek-flash', 'system_fingerprint': 'offline-fixed', 'choices': [{'index': 0,
                'message': {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'out', 'type': 'function',
                    'function': {'name': 'ReplyRuntimeOutput', 'arguments': json.dumps(args)}}]},
                'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}})
        sync = httpx.Client(transport=httpx.MockTransport(respond), follow_redirects=False)
        async_client = httpx.AsyncClient(transport=httpx.MockTransport(respond), follow_redirects=False)
        self.addCleanup(sync.close)
        self.addCleanup(lambda: asyncio.run(async_client.aclose()))
        model = build_deepseek_model(api_key='synthetic-offline-unused', max_retries=0,
            model_name='deepseek-flash', base_url='https://api.deepseek.com',
            extra_body={'thinking': {'type': 'disabled'}}, http_client=sync, http_async_client=async_client)
        with patch('notalone.server.reply_wiring.build_deepseek_model', return_value=model):
            service = build_reply_service(database_url=self.database_url, owner_id=self.owner_id,
                layered_memory=layer_service, layered_reply_budget=LayeredReplyBudget(4, 4, 4000))
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token='synthetic-reply-quality', reply_service=service, layered_memory=layer_service), self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def test_actual_operator_reply_contract_is_visible_and_unknown_keeps_original_l1(self):
        contact, _, _, _, path = self.prepare_layered_reply()
        production = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url))
        production.reply_configuration = ReplyReadConfiguration({'directory': str(Path(self.temporary.name) / 'missing'),
            'contact_budget': {'profile_entries': 4, 'directory_entries': 4, 'characters': 4000}, 'owner_budget': None})
        self.backend = self.sdk_backend(production)
        state = self._get(self.backend, f'/api/contacts/{contact}/layered-memory')['layered_memory']
        self.assertEqual(state['quality']['reply']['status'], 'unknown')
        self.assertNotEqual(state['quality']['reply']['contract_id'], ReplyQualityContract().identity)
        self.assertFalse(state['quality']['automatic_use_allowed'])
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '聊聊共同课程。'))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertIsNone(evidence['layered_context'])
        self.assertTrue(any(item['kind'] == 'confirmed_memory' for item in evidence['evidence']))
        self.assertEqual(evidence['retrieval']['budgets']['contact_memory']['limit'], 5)
        self.assertEqual(len(self.actual_calls), 1)
        self.assertNotIn('<relationship_background>', str(self.actual_calls))

    def test_replaced_qualification_invalidates_prepare_and_model_result_before_commit(self):
        contact, _, _, _, path = self.prepare_layered_reply()
        class Source:
            receipt = 'controlled-initial'
            def resolve(self, contract, **kwargs):
                identities = [{'request_model': 'deepseek-flash', 'response_model': 'deepseek-flash',
                    'system_fingerprint': 'offline-fixed', 'request_route': 'https://api.deepseek.com/chat/completions'}]
                return {'stage': {'status': 'verified', 'contract_id': contract.identity, 'report_id': 'controlled'},
                        'receipt': self.receipt, 'model_identities': identities}
        source = Source()
        quality = OrganizationQualityService(qualification_source=Source())
        quality.configure_reply(ReplyQualityContract(), source)
        production = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url), quality=quality)
        from types import SimpleNamespace
        production.reply_configuration = SimpleNamespace(source=source,
            contact_budget=LayeredReplyBudget(4, 4, 4000), owner_budget=None)
        self.backend = self.sdk_backend(production)
        body = self.rewrite_body(contact, '聊聊共同课程。')
        status, prepared = self.backend.request(path + '/replies/prepare', body)
        self.assertEqual(status, 200, prepared)
        source.receipt = 'replacement'
        status, result = self.backend.request(path + '/replies', body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(self.actual_calls, [])
        self.backend = self.sdk_backend(production, on_send=lambda: setattr(source, 'receipt', 'changed-after-send'))
        fresh = self.rewrite_body(contact, '聊聊共同课程。')
        status, result = self.backend.request(path + '/replies', fresh)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.actual_calls), 1)
        self.assertNotIn('changed-after-send', str(self._get(self.backend, path)))

    def _run_installed_pair(self, *, mutation=None, expected_scope='contact'):
        from copy import deepcopy
        from uuid import uuid4
        from notalone.experiments.reply_comparison import (
            InstalledReplyHttpAdapter, build_manifest, capture_installation_state,
            installed_l1_version, run_reply_comparison, validate_installation_binding)
        from notalone.reply.adapters.reply_comparison_capture import ReplyComparisonCapture
        from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
        from notalone.reply.quality import build_reply_contract, reply_model_configuration
        contact, _, management, ready, _ = self.prepare_layered_reply()
        self.assertEqual(self.backend.request(f'/api/contacts/{contact}/manual-confirmation', {})[0], 200)
        if mutation == 'extra_scope' or expected_scope == 'owner':
            self.manual_owner('本人合成学习经历。')
        if expected_scope == 'owner':
            self.assertEqual(management.request(f'/api/contacts/{contact}/layered-memory/delete',
                {'settings_generation': ready['settings_generation']})[0], 200)
            self.assertEqual(management.request('/api/memories/owner/layered-memory/enable',
                {'settings_generation': 0, 'purpose_confirmed': True})[0], 200)
        budget = LayeredReplyBudget(4, 4, 4000)
        prototype = build_deepseek_model(api_key='synthetic-offline-unused', max_retries=0,
            base_url='https://api.deepseek.com', extra_body={'thinking': {'type': 'disabled'}})
        self.addCleanup(prototype.root_client.close)
        self.addCleanup(lambda: asyncio.run(prototype.root_async_client.close()))
        scope = {'owner_id': str(self.owner_id), 'contact_id': contact, 'confirmed': True,
                 'confirmation_receipt': {'kind': 'manual'}}
        state = capture_installation_state(self.service, scope, expected_scopes=[expected_scope])[expected_scope]
        original = {'l2': {'scenarios': [{key: item[key] for key in ('title', 'hint', 'paragraphs')}
                                        for item in deepcopy(state['scenarios'])]},
                    'l3': {'entries': deepcopy(state['profile_entries'])},
                    'l2_verification': True, 'l3_verification': True, 'l2_challenge': False, 'l3_challenge': False}
        mapping = {}
        def original_references(value):
            if isinstance(value, list):
                for item in value:
                    original_references(item)
            elif isinstance(value, dict):
                if 'memory_id' in value:
                    target = (value['memory_id'], value['revision'])
                    mapping.setdefault(target, {'original_memory_id': str(uuid4()), 'original_revision': 7,
                        'installed_memory_id': target[0], 'installed_revision': target[1]})
                    value.clear()
                    value.update(memory_id=mapping[target]['original_memory_id'], revision=7)
                else:
                    for item in value.values():
                        original_references(item)
        original_references(original)
        binding = {'schema_version': 'controlled-layered-installation-v1', 'expected_scopes': [expected_scope],
            'original_output': original, 'reference_mapping': list(mapping.values()),
            'installed': {expected_scope: state}}
        case = {'case_id': 'controlled-public-pair', 'scope_kind': expected_scope,
            'organization_review': {'reviewer_kind': 'agent', 'decision': 'approved'},
            'organization_output_sha256': content_digest(original), 'installation_binding': binding,
            'input_package': {'scope': scope,
            'request': self.rewrite_body(contact, '聊聊共同课程。'),
            'l1_version': installed_l1_version(self.database_url, scope)}}
        validate_installation_binding(binding, case['organization_output_sha256'], case['organization_review'])
        contract = build_reply_contract(prototype, build_deepseek_input_budget(prototype)[0], budget, budget)
        manifest = build_manifest(contract=contract, model_configuration=reply_model_configuration(prototype),
            dataset_version='controlled-public-pair-v1', cases=[case])
        def respond(request):
            current = next(json.loads(item['content']) for item in reversed(json.loads(request.content)['messages'])
                           if item['role'] == 'user')
            citation = next(item['evidence_id'] for item in current['evidence'] if item['kind'] == 'user_draft')
            args = {'candidates': [{'text': current['draft_text'], 'basis': '保留本次草稿。',
                    'citation_ids': [citation], 'risk_notes': []}], 'used_skill_version_id': None}
            return httpx.Response(200, json={'id': 'pair', 'object': 'chat.completion', 'created': 0,
                'model': 'deepseek-flash', 'system_fingerprint': 'offline-fixed', 'choices': [{'index': 0,
                'message': {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'out', 'type': 'function',
                    'function': {'name': 'ReplyRuntimeOutput', 'arguments': json.dumps(args)}}]},
                'finish_reason': 'tool_calls'}]})
        private_home = patch.object(Path, 'home', return_value=Path(self.temporary.name))
        private_home.start()
        self.addCleanup(private_home.stop)
        capture = ReplyComparisonCapture(Path(self.temporary.name) / 'paired', manifest,
            synthetic_transport=httpx.MockTransport(respond))
        model = build_deepseek_model(api_key='synthetic-offline-unused', max_retries=0,
            base_url='https://api.deepseek.com', extra_body={'thinking': {'type': 'disabled'}},
            http_client=capture.http_client, http_async_client=capture.http_async_client)
        adapter = InstalledReplyHttpAdapter.from_installed_database(database_url=self.database_url,
            expected_database=self.database_url.split('dbname=')[-1], model=model, capture=capture,
            contact_budget=budget, owner_budget=budget, layered_memory=self.service)
        def invoke(item, arm, key, recorder):
            if arm == 'layered' and mutation == 'replacement':
                import psycopg
                from psycopg.types.json import Jsonb
                changed = deepcopy(state['profile_entries'])
                changed[0]['text'] = '实际已替换为未获本例支持审阅的候选。'
                with psycopg.connect(self.database_url) as connection:
                    connection.execute('UPDATE public.layered_profile_version SET entries=%s WHERE id=%s',
                        (Jsonb(changed), state['profile_version_id']))
            if arm == 'layered' and mutation == 'extra_scope':
                self.assertEqual(management.request('/api/memories/owner/layered-memory/enable',
                    {'settings_generation': 0, 'purpose_confirmed': True})[0], 200)
            return adapter(item, arm, key, recorder)
        bundle = run_reply_comparison(manifest=manifest, cases=[case], capture=capture, invoke_arm=invoke)
        return bundle, contract

    def test_installed_pair_runs_same_l1_through_public_http_and_actual_sdk_capture(self):
        bundle, contract = self._run_installed_pair()
        self.assertEqual([arm['status'] for arm in bundle['arms']], ['succeeded', 'succeeded'],
            [{key: row[key] for key in ('arm', 'status', 'error')} for row in bundle['arms']])
        self.assertEqual(bundle['budget_receipt']['reserved_requests'], 2)
        baseline, layered = bundle['arms']
        self.assertIsNone(baseline['evidence']['reply_evidence']['layered_context'])
        self.assertIsNotNone(layered['evidence']['reply_evidence']['layered_context'])
        self.assertIsNone(layered['evidence']['reply_evidence']['owner_layered_context'])
        self.assertEqual(layered['evidence']['installation_receipt']['uncovered_scopes'], ['owner'])
        self.assertEqual(baseline['evidence']['l1_budget'], layered['evidence']['l1_budget'])
        from notalone.reply.quality import comparison_report
        reasons = comparison_report(bundle, contract)['stage']['reasons']
        self.assertNotIn('reply_output_capture_changed', reasons)
        self.assertNotIn('reply_installation_binding_incomplete', reasons)

    def test_owner_only_installed_pair_does_not_require_contact_material(self):
        bundle, contract = self._run_installed_pair(expected_scope='owner')
        self.assertEqual([arm['status'] for arm in bundle['arms']], ['succeeded', 'succeeded'],
            [row['error'] for row in bundle['arms']])
        layered = bundle['arms'][1]
        self.assertIsNone(layered['evidence']['reply_evidence']['layered_context'])
        self.assertIsNotNone(layered['evidence']['reply_evidence']['owner_layered_context'])
        self.assertEqual(layered['evidence']['installation_receipt']['uncovered_scopes'], ['contact'])
        from notalone.reply.quality import comparison_report
        reasons = comparison_report(bundle, contract)['stage']['reasons']
        self.assertNotIn('reply_output_capture_changed', reasons)
        self.assertNotIn('reply_installation_binding_incomplete', reasons)

    def test_replaced_installed_candidate_blocks_layered_arm_before_provider_call(self):
        bundle, _ = self._run_installed_pair(mutation='replacement')
        self.assertEqual([arm['status'] for arm in bundle['arms']], ['succeeded', 'blocked'])
        self.assertEqual(bundle['arms'][1]['error']['kind'], 'installed_layered_material_changed')
        self.assertFalse(any(call['arm'] == 'layered' for call in bundle['calls']))

    def test_unapproved_other_scope_blocks_layered_arm_before_provider_call(self):
        bundle, _ = self._run_installed_pair(mutation='extra_scope')
        self.assertEqual([arm['status'] for arm in bundle['arms']], ['succeeded', 'blocked'])
        self.assertEqual(bundle['arms'][1]['error']['kind'], 'unexpected_installed_layered_scope')
        self.assertFalse(any(call['arm'] == 'layered' for call in bundle['calls']))
