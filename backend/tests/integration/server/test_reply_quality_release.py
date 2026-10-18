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

    def test_installed_pair_runs_same_l1_through_public_http_and_actual_sdk_capture(self):
        from notalone.experiments.reply_comparison import (
            InstalledReplyHttpAdapter, build_manifest, installed_l1_version, run_reply_comparison)
        from notalone.reply.adapters.reply_comparison_capture import ReplyComparisonCapture
        from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
        from notalone.reply.quality import build_reply_contract, reply_model_configuration
        contact, _, _, ready, _ = self.prepare_layered_reply()
        self.assertEqual(self.backend.request(f'/api/contacts/{contact}/manual-confirmation', {})[0], 200)
        budget = LayeredReplyBudget(4, 4, 4000)
        prototype = build_deepseek_model(api_key='synthetic-offline-unused', max_retries=0,
            base_url='https://api.deepseek.com', extra_body={'thinking': {'type': 'disabled'}})
        self.addCleanup(prototype.root_client.close)
        self.addCleanup(lambda: asyncio.run(prototype.root_async_client.close()))
        scope = {'owner_id': str(self.owner_id), 'contact_id': contact, 'confirmed': True,
                 'confirmation_receipt': {'kind': 'manual'}}
        case = {'case_id': 'controlled-public-pair', 'scope_kind': 'contact',
            'organization_review': {'reviewer_kind': 'agent', 'decision': 'approved'},
            'organization_output_sha256': content_digest(ready), 'input_package': {'scope': scope,
            'request': self.rewrite_body(contact, '聊聊共同课程。'),
            'l1_version': installed_l1_version(self.database_url, scope)}}
        contract = build_reply_contract(prototype, build_deepseek_input_budget(prototype)[0], budget, None)
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
            contact_budget=budget, owner_budget=None, layered_memory=self.service)
        bundle = run_reply_comparison(manifest=manifest, cases=[case], capture=capture, invoke_arm=adapter)
        self.assertEqual([arm['status'] for arm in bundle['arms']], ['succeeded', 'succeeded'],
            [{key: row[key] for key in ('arm', 'status', 'error')} for row in bundle['arms']])
        self.assertEqual(bundle['budget_receipt']['reserved_requests'], 2)
        baseline, layered = bundle['arms']
        self.assertIsNone(baseline['evidence']['reply_evidence']['layered_context'])
        self.assertIsNotNone(layered['evidence']['reply_evidence']['layered_context'])
        self.assertEqual(baseline['evidence']['l1_budget'], layered['evidence']['l1_budget'])
