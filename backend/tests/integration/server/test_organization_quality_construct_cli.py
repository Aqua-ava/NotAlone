"""构造 CLI 穿过真实 create_app、HTTP 与隔离 PostgreSQL。"""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server.core_business_flow_support import ScriptedCoreModel, HttpBackend, tool_response


class SyntheticSourceConstructionModel(ScriptedCoreModel):
    """只为本轮明确合成原文返回提案与逐字核验，不触及持久层。"""

    source_texts: tuple[str, ...] = ()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        from langchain_core.outputs import ChatGeneration, ChatResult

        self.seen_calls.append(messages)
        content = str(messages[-1].content)
        if '[message_id=' in content:
            facts = []
            for identifier, text in re.findall(
                r'\[target\] \[message_id=([^\]]+)\] occurred_at=\S+ sender=contact: (.*)', content,
            ):
                if text not in self.source_texts:
                    continue
                facts.append({'text': text, 'category': 'common_fact', 'subject': 'contact',
                              'topic': 'other', 'source_message_ids': [identifier], 'confidence': 0.95,
                              'risk_flags': [], 'valid_at': None, 'invalid_at': None,
                              'speech_act': 'assertion', 'assertion_status': 'asserted',
                              'figurative_type': 'literal', 'alternatives': [],
                              'interpretation_reason': '本例合成原文逐字提供。'})
            response = tool_response('MemoryExtractionOutput', {'facts': facts})
        else:
            payload = json.loads(content)
            if 'candidates' in payload:
                results = []
                for candidate in payload['candidates']:
                    source = next(message for message in payload['messages']
                                  if message['message_id'] == candidate['source_message_ids'][0])
                    if source['text'] not in self.source_texts:
                        raise AssertionError('受控来源核验只接受本轮明确合成正文。')
                    results.append({'candidate_index': candidate['candidate_index'], 'verdict': 'supported',
                                    'issues': [], 'evidence': [{'message_id': source['message_id'],
                                                              'quote': source['text']}]})
                response = tool_response('SourceVerificationOutput', {'results': results})
            else:
                response = tool_response('MemoryAdjudicationOutput', {'action': 'add', 'replaced_memory_id': None})
        return ChatResult(generations=[ChatGeneration(message=response)])


def source_construction_backend(fixture, model):
    """重放冻结评测的历史人工确认合同，真实应用、Worker与来源核验保持不变。"""
    import psycopg
    from notalone.application.import_service import ImportService, TaskHost
    from notalone.application.memory_service import MemoryService
    from notalone.application.model_priority import ModelPriorityControl
    from notalone.memory_extraction.adapters import LangChainExtractionRuntime
    from notalone.memory_extraction.dimensions import DimensionRelease
    from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
    from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
    from notalone.persistence.contact_memory_index import PostgresContactMemoryIndexRepository
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
    from notalone.persistence.outbound_ledger import PostgresOutboundLedger
    from notalone.persistence.postgres_repository import PostgresIngestRepository
    from notalone.server.app import create_app
    from notalone.server.event_bus import EventBus
    from notalone.server.event_models import BackendEvent
    from notalone.scopes import ContactScope
    from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner
    from datetime import datetime, timezone

    database_url, events, priority = fixture.database_url, EventBus(), ModelPriorityControl()
    ledger = PostgresOutboundLedger(database_url)
    runner = PostgresMemoryExtractionRunner(
        database_url, runtime=LangChainExtractionRuntime(model=model),
        verification_runtime=LangChainSourceVerificationRuntime(model=model, ledger=ledger, provider='synthetic'),
        ledger=ledger, provider='synthetic', model_name='synthetic-source-construction',
        dimension_release=DimensionRelease(), automatic=False,
    )

    def connect_lock():
        connection = psycopg.connect(database_url, autocommit=True)
        fixture.addCleanup(connection.close)
        return connection

    def progress(update):
        events.publish(BackendEvent.task_progress(
            scope=ContactScope(update.owner_id, update.contact_id), occurred_at=datetime.now(timezone.utc),
            task_id=update.task_id, step=update.step, status=update.status,
            processed_count=update.processed_count, attempt_count=update.attempt_count, retry_count=update.retry_count))

    host = TaskHost(
        worker_builder=lambda: BackgroundTaskWorker(
            repository=PostgresBackgroundTaskRepository(database_url), extraction_runner=runner,
            index_repository=PostgresContactMemoryIndexRepository(database_url), model_priority=priority),
        lock_connection_builder=connect_lock, event_publisher=progress,
        model_priority=priority, task_repository=PostgresBackgroundTaskRepository(database_url))
    backend = HttpBackend(create_app(
        database_url=database_url, owner_id=fixture.owner_id, token='synthetic-source-construction-token',
        events=events, task_host=host, setup_service=fixture.setup,
        import_service=ImportService(repository=PostgresIngestRepository(database_url)),
        memory_service=MemoryService(contact_memory=PostgresMemoryStore(database_url),
                                     owner_memory=PostgresOwnerMemoryStore(database_url))), fixture.owner_id)
    fixture.addCleanup(priority.stop)
    fixture.addCleanup(host.stop, timeout=5)
    fixture.addCleanup(backend.close)
    return backend


class OrganizationQualityConstructionCliHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def invoke(self, *arguments):
        backend_root = Path(__file__).resolve().parents[3]
        environment = dict(os.environ, PYTHONPATH=str(backend_root / 'src'),
                           NOTALONE_SYNTHETIC_CONSTRUCTION_TOKEN=self.backend.token,
                           NOTALONE_DISABLE_DOTENV='1', PYTHON_DOTENV_DISABLED='1')
        result = subprocess.run(
            [sys.executable, '-m', 'notalone.experiments.organization_quality_construct', *arguments],
            cwd=backend_root, env=environment, capture_output=True, text=True, timeout=45,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_cli_plan_and_apply_bind_both_scopes_with_production_time_projection(self):
        directory = Path(self.temporary.name)
        dataset = directory / 'dataset.jsonl'
        rows = []
        for scope in ('owner', 'contact'):
            memory_id = f'draft-{scope}'
            rows.append({
                'case_id': f'synthetic-{scope}', 'category': 'time', 'scope_kind': scope,
                'annotation_author': 'agent', 'annotation_status': 'draft_pending_human',
                'independence_note': '只用于 CLI 工程回归，不声明语义覆盖。',
                'memories': [{'id': memory_id, 'version': 1,
                              'body': '合成本人曾参加陶艺课程。' if scope == 'owner'
                                      else '合成联系人曾参加木工课程。',
                              'provenance': 'manual_entry' if scope == 'owner' else 'source_supported',
                              'temporal_status': {'source_time': '2024-10-10', 'as_of': '2026-10-17',
                                                  'kind': 'historical', 'detail': '仅供人审的历史解释'}}],
                'supported_claims': [{'text': '曾参加课程。', 'source_memory_ids': [memory_id],
                                      'allowed_layers': ['l2']}],
                'forbidden_claims': [{'text': '目前仍参加课程。', 'reason': '不可外发的评分依据'}],
            })
        dataset.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
        worksheet = directory / 'worksheet.json'
        worksheet.write_text(json.dumps({
            'dataset_draft_sha256': hashlib.sha256(dataset.read_bytes()).hexdigest(),
            'cases': [{'case_id': row['case_id']} for row in rows],
        }))
        scoring = directory / 'scoring.json'
        scoring.write_text('{"human_review":false}')
        plan_dir, output_dir = directory / 'plan', directory / 'bound'
        planned = self.invoke('plan', '--dataset', str(dataset), '--worksheet', str(worksheet),
                              '--scoring-contract', str(scoring), '--source-date-policy',
                              'append-draft-source-date', '--manual-entry-rebinding',
                              '--output-dir', str(plan_dir))
        self.assertEqual(planned['cases'], 2)
        applied = self.invoke('apply', '--plan', str(plan_dir / 'construction-plan.json'),
                              '--backend-base-url', self.backend.base_url,
                              '--token-env', 'NOTALONE_SYNTHETIC_CONSTRUCTION_TOKEN',
                              '--create-contact-name', 'CLI质量构造合成联系人',
                              '--output-dir', str(output_dir))
        self.assertEqual(applied['constructed_cases'], 2)
        bindings = json.loads((output_dir / 'public-bindings.json').read_text())
        inputs = [json.loads(line) for line in (output_dir / 'model-inputs.jsonl').read_text().splitlines()]
        self.assertEqual({case['scope_kind'] for case in bindings['cases']}, {'owner', 'contact'})
        self.assertEqual(bindings['construction_status'], 'bound_pending_human')
        for case, model_input in zip(bindings['cases'], inputs, strict=True):
            persisted = self._get(self.backend, '/api/layered-memory/quality-inputs/' + case['actual_case_id'])
            self.assertEqual(persisted['quality_input']['model_input'], model_input)
            self.assertEqual(persisted['quality_input']['review_status'], 'unknown')
            self.assertFalse(persisted['quality_input']['quality_verified'])
            memory = model_input['memories'][0]
            self.assertEqual(set(memory['timing']), {
                'recorded_at', 'source_started_at', 'source_ended_at', 'source_time_complete',
                'current_status', 'valid_at', 'invalid_at', 'event'} if case['scope_kind'] == 'owner' else {
                    'recorded_at', 'source_started_at', 'source_ended_at', 'source_time_complete',
                    'current_status', 'current_status_reason'})
            self.assertIsNone(memory['timing']['event'] if case['scope_kind'] == 'owner' else memory['event'])
            self.assertIsNone(memory['timing']['source_started_at'])
            self.assertIsNone(memory['timing']['source_ended_at'])
            self.assertFalse(memory['timing']['source_time_complete'])
            self.assertIn('2024-10-10', memory['text'])
            self.assertIn('时刻与时区未知', memory['text'])
            self.assertFalse(memory['timing']['recorded_at'].startswith('2024-10-10'))
            self.assertEqual(memory['memory_id'], case['memories'][0]['actual_memory_id'])
            self.assertEqual(memory['revision'], case['memories'][0]['actual_revision'])
            self.assertEqual(case['memories'][0]['actual_eligibility'], 'manual_entry')
            self.assertNotIn('仅供人审', json.dumps(model_input, ensure_ascii=False))
            self.assertNotIn('不可外发', json.dumps(model_input, ensure_ascii=False))
        self.assertNotIn(self.backend.token, ''.join(path.read_text() for path in output_dir.iterdir()))

    def test_public_source_import_worker_and_confirmation_retain_real_provenance(self):
        text = '联系人长期练习古典吉他。'
        earlier_text = '联系人长期学习木工。'
        model = SyntheticSourceConstructionModel()
        model.source_texts = (text, earlier_text)
        self.backend = source_construction_backend(self, model)
        directory = Path(self.temporary.name)
        dataset, worksheet, scoring = (directory / name for name in ('source.jsonl', 'source-worksheet.json', 'source-scoring.json'))
        dataset.write_text(json.dumps({
            'case_id': 'source-supported-tracer', 'category': 'subject', 'scope_kind': 'contact',
            'annotation_author': 'agent', 'annotation_status': 'draft_pending_human',
            'memories': [{'id': 'source-draft', 'version': 1, 'body': text, 'provenance': 'source_supported',
                          'temporal_status': {'source_time': '2026-10-10T10:00:00+08:00',
                                              'as_of': '2026-10-17', 'kind': 'stable',
                                              'detail': '仅供人审的来源说明'}}],
            'supported_claims': [{'text': text, 'source_memory_ids': ['source-draft'], 'allowed_layers': ['l2', 'l3']}],
            'forbidden_claims': [{'text': '联系人喜欢黑胶。', 'reason': '禁止外发的评分说明'}],
        }, ensure_ascii=False) + '\n')
        row = json.loads(dataset.read_text())
        row['memories'].append({'id': 'earlier-source-draft', 'version': 1, 'body': earlier_text,
                                'provenance': 'source_supported', 'temporal_status': {
                                    'source_time': '2026-10-05T10:00:00+08:00', 'as_of': '2026-10-17',
                                    'kind': 'stable', 'detail': '仅供人审的来源说明'}})
        dataset.write_text(json.dumps(row, ensure_ascii=False) + '\n')
        worksheet.write_text(json.dumps({'dataset_draft_sha256': hashlib.sha256(dataset.read_bytes()).hexdigest(),
                                         'cases': [{'case_id': 'source-supported-tracer'}]}))
        scoring.write_text('{"human_review":false}')
        plan_dir, output_dir = directory / 'source-plan', directory / 'source-bound'
        self.invoke('plan', '--dataset', str(dataset), '--worksheet', str(worksheet), '--scoring-contract', str(scoring),
                    '--source-date-policy', 'unchanged', '--output-dir', str(plan_dir))
        self.invoke('apply', '--plan', str(plan_dir / 'construction-plan.json'), '--backend-base-url', self.backend.base_url,
                    '--token-env', 'NOTALONE_SYNTHETIC_CONSTRUCTION_TOKEN', '--create-contact-name', '来源支持合成联系人',
                    '--controlled-source-backend', '--source-files-shared-with-backend',
                    '--source-owner-external-id', 'wxid_synthetic_quality_owner',
                    '--source-contact-external-id', 'wxid_synthetic_quality_contact', '--confirm-source-candidates',
                    '--output-dir', str(output_dir))
        bindings = json.loads((output_dir / 'public-bindings.json').read_text())
        self.assertEqual(bindings['source_construction_order'], ['earlier-source-draft', 'source-draft'])
        self.assertEqual(bindings['provenance_coverage'], {
            'original_source_supported': 2, 'actual_source_supported': 2,
            'source_supported_rebound_to_manual': 0, 'source_supported_coverage_complete': True})
        self.assertEqual(len(bindings['cases'][0]['memories']), 2)
        entry = bindings['cases'][0]['memories'][0]
        self.assertEqual(entry['actual_eligibility'], 'source_supported')
        self.assertEqual(entry['actual_memory_response']['adoption_method'], 'manual')
        self.assertEqual(entry['source_import']['task_result']['status'], 'succeeded')
        self.assertEqual(entry['source_import']['matching_pending_candidates'][0]['status'], 'pending')
        self.assertEqual(entry['source_import']['actual_message']['message_id'],
                         entry['actual_memory_response']['source_ids'][0])
        self.assertEqual(entry['actual_public_timing']['source_started_at'], '2026-10-10T10:00:00+08:00')
        actual_input = json.loads((output_dir / 'model-inputs.jsonl').read_text())
        self.assertEqual(actual_input['memories'][0]['provenance_kind'], 'source_supported')
        for text_for_review in ('仅供人审的来源说明', '禁止外发的评分说明', 'source-supported-tracer'):
            self.assertNotIn(text_for_review, json.dumps(actual_input, ensure_ascii=False))
            self.assertNotIn(text_for_review, str(model.seen_calls))
        audit = (output_dir / 'http-exchanges.jsonl').read_text()
        self.assertIn('/api/imports/preview', audit)
        self.assertIn('/api/imports/commit', audit)
        self.assertIn('expected_content_sha256', audit)
        self.assertIn('/confirm', audit)

    def test_contact_per_case_defers_quality_input_until_scope_feedback_is_stable(self):
        directory = Path(self.temporary.name)
        dataset, worksheet, scoring = (directory / name for name in ('deferred.jsonl', 'deferred-worksheet.json', 'deferred-scoring.json'))
        rows = [{'case_id': f'contact-{number}', 'category': 'subject', 'scope_kind': 'contact',
                 'memories': [{'id': f'memory-{number}', 'version': 1, 'body': text,
                               'provenance': 'manual_entry', 'temporal_status': {'source_time': None}}],
                 'supported_claims': [], 'forbidden_claims': []}
                for number, text in ((1, '联系人学习陶艺。'), (2, '联系人学习木工。'))]
        dataset.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
        worksheet.write_text(json.dumps({'dataset_draft_sha256': hashlib.sha256(dataset.read_bytes()).hexdigest(),
                                         'cases': [{'case_id': row['case_id']} for row in rows]}))
        scoring.write_text('{"human_review":false}')
        plan_dir, output_dir = directory / 'deferred-plan', directory / 'deferred-bound'
        self.invoke('plan', '--dataset', str(dataset), '--worksheet', str(worksheet), '--scoring-contract', str(scoring),
                    '--source-date-policy', 'unchanged', '--output-dir', str(plan_dir))
        result = self.invoke('apply', '--plan', str(plan_dir / 'construction-plan.json'),
                              '--backend-base-url', self.backend.base_url, '--token-env', 'NOTALONE_SYNTHETIC_CONSTRUCTION_TOKEN',
                              '--create-contact-name', '独立合成联系人', '--contact-per-case', '--defer-quality-input',
                              '--output-dir', str(output_dir))
        self.assertEqual(result['constructed_l1_cases'], 2)
        self.assertEqual(result['quality_prepared_cases'], 0)
        state = json.loads((output_dir / 'public-bindings.json').read_text())
        self.assertEqual(state['construction_status'], 'l1_constructed_quality_deferred')
        self.assertEqual(len({case['contact_id'] for case in state['cases']}), 2)
        for case in state['cases']:
            memories = self._get(self.backend, f'/api/contacts/{case["contact_id"]}/memories')['memories']
            self.assertEqual(len(memories), 1)
            self.assertEqual(memories[0]['memory_id'], case['memories'][0]['actual_memory_id'])
            self.assertFalse(case['quality_input_prepared'])
            self.assertNotIn('actual_case_id', case)
        audit = [json.loads(line) for line in (output_dir / 'http-exchanges.jsonl').read_text().splitlines()]
        self.assertFalse(any('/quality-input' in exchange.get('path', '') for exchange in audit))
        self.assertFalse((output_dir / 'model-inputs.jsonl').exists())
