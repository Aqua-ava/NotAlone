"""合成构造 CLI 只走显式 HTTP，并保留人审缺口。"""

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


class QualityConstructionCliTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.dataset = self.directory / 'dataset.jsonl'
        self.dataset.write_text(json.dumps({
            'case_id': 'synthetic-contact', 'category': 'time', 'scope_kind': 'contact',
            'annotation_author': 'agent', 'annotation_status': 'draft_pending_human',
            'independence_note': '人审专用说明',
            'memories': [{'id': 'draft-memory', 'version': 1, 'body': '联系人过去参加陶艺课程。',
                          'provenance': 'source_supported', 'temporal_status': {
                              'source_time': '2024-10-10T10:00:00+08:00',
                              'kind': 'historical', 'detail': '不得进入模型的说明',
                              'as_of': '2026-10-17'}}],
            'supported_claims': [{'text': '联系人曾参加陶艺课程。',
                                  'source_memory_ids': ['draft-memory'], 'allowed_layers': ['l2']}],
            'forbidden_claims': [{'text': '联系人现在仍参加课程。', 'reason': '金标不能外发'}],
        }, ensure_ascii=False) + '\n')
        self.worksheet = self.directory / 'worksheet.json'
        self.worksheet.write_text(json.dumps({'dataset_draft_sha256': hashlib.sha256(
            self.dataset.read_bytes()).hexdigest(), 'cases': [{'case_id': 'synthetic-contact'}]}))
        self.scoring = self.directory / 'scoring.json'
        self.scoring.write_text('{"human_review":false}')

    def cli(self, *arguments, env=None):
        runtime_env = dict(os.environ)
        runtime_env['PYTHONPATH'] = str(Path(__file__).resolve().parents[3] / 'src')
        runtime_env.update(env or {})
        return subprocess.run([sys.executable, '-m',
                               'notalone.experiments.organization_quality_construct', *arguments],
                              text=True, capture_output=True, env=runtime_env, timeout=15)

    def plan(self, *arguments):
        return self.cli('plan', '--dataset', str(self.dataset), '--worksheet', str(self.worksheet),
                        '--scoring-contract', str(self.scoring), '--output-dir', str(self.directory / 'plan'),
                        '--source-date-policy', 'append-draft-source-date', *arguments)

    def test_source_supported_cannot_silently_become_manual_entry(self):
        result = self.plan()
        self.assertEqual(result.returncode, 0, result.stderr)
        source_plan = json.loads((self.directory / 'plan' / 'construction-plan.json').read_text())
        self.assertEqual(source_plan['cases'][0]['entries'][0]['actual_entry_kind'], 'source_supported')
        self.assertEqual(source_plan['cases'][0]['entries'][0]['text'], '联系人过去参加陶艺课程。')
        self.assertFalse(source_plan['manual_entry_rebinding'])
        result = self.plan('--manual-entry-rebinding', '--output-dir', str(self.directory / 'manual-plan'))
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads((self.directory / 'manual-plan' / 'construction-plan.json').read_text())
        entry = plan['cases'][0]['entries'][0]
        self.assertEqual(entry['draft_memory']['provenance'], 'source_supported')
        self.assertEqual(entry['actual_entry_kind'], 'manual_entry')
        self.assertIn('2024-10-10T10:00:00+08:00', entry['text'])
        self.assertNotIn('不得进入模型的说明', entry['text'])
        self.assertIn('source_supported_rebound_to_manual_entry', entry['conversion_gaps'])
        self.assertEqual(plan['review_status'], 'unknown')
        self.assertFalse(plan['quality_verified'])

    def start_backend(self, *, leak_gold=False, scope='contact'):
        exchanges = []
        contact_id = '00000000-0000-4000-8000-000000000001'
        memory_id = '00000000-0000-4000-8000-000000000011'
        saved = {}
        timing = {'recorded_at': '2026-10-18T10:00:00+08:00', 'source_started_at': None,
                  'source_ended_at': None, 'source_time_complete': False,
                  'current_status': 'current_unverified', 'current_status_reason': '合成未知'}
        model_timing = {key: value for key, value in timing.items() if key != 'current_status_reason'}
        model_timing.update({'valid_at': '2026-10-18T10:00:00+08:00', 'invalid_at': None, 'event': None})

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                if self.headers.get('Authorization') != 'Bearer synthetic-explicit-token':
                    self.send_error(401)
                    return
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                exchanges.append({'path': self.path, 'body': body,
                                  'authorization': self.headers.get('Authorization')})
                if self.path == '/api/contacts':
                    result = {'contact': {'contact_id': contact_id, 'display_name': body['display_name']}}
                elif self.path.endswith('/manual-confirmation'):
                    result = {'confirmed': True}
                elif self.path in {'/api/memories/manual-contact', '/api/memories/manual-owner'}:
                    saved.update(body)
                    result = {'memory': {'memory_id': memory_id, 'revision': 7,
                                         'text': body['text'], 'timing': timing}}
                elif self.path.endswith('/quality-input'):
                    projected_memory = {'memory_id': memory_id, 'revision': 7, 'text': saved['text'],
                                        'timing': model_timing if scope == 'owner' else timing}
                    if scope == 'contact':
                        projected_memory.update({'provenance_kind': 'manual_entry', 'event': None,
                                                 'category': 'common_fact', 'valid_at': None, 'invalid_at': None})
                    model_input = {'memories': [projected_memory], 'scenarios': [], 'corrections': []}
                    if leak_gold:
                        if leak_gold == 'timing':
                            projected_memory['timing'] = {**projected_memory['timing'], 'detail': '非法嵌套字段'}
                        elif leak_gold == 'event':
                            projected_memory['event'] = {
                                'stage': 'planned', 'occurrence_start': None, 'occurrence_end': None,
                                'stage_verified': False, 'occurrence_verified': False,
                                'version': 1, 'stage_evidence': [], 'occurrence_evidence': [],
                                'detail': '非法事件说明'}
                        else:
                            model_input['memories'][0]['detail'] = '非法额外字段'
                    digest = hashlib.sha256(json.dumps(model_input, ensure_ascii=False, sort_keys=True,
                                                       separators=(',', ':')).encode()).hexdigest()
                    result = {'quality_input': {'case_id': 'actual-case', 'scope_kind': scope,
                                               'contact_id': contact_id if scope == 'contact' else None,
                                               'contract_id': 'actual-contract',
                                               'input_sha256': digest, 'model_input': model_input,
                                               'construction': [{'memory_id': memory_id, 'revision': 7,
                                                                 'provenance_kind': 'manual_entry',
                                                                 'timing': timing}],
                                               'review_status': 'unknown', 'quality_verified': False}}
                else:
                    self.send_error(404)
                    return
                encoded = json.dumps(result).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.shutdown)
        return f'http://127.0.0.1:{server.server_port}', exchanges

    def apply(self, backend_url):
        return self.cli('apply', '--plan', str(self.directory / 'plan' / 'construction-plan.json'),
                        '--backend-base-url', backend_url, '--token-env', 'SYNTHETIC_CONSTRUCTION_TOKEN',
                        '--create-contact-name', '质量构造合成联系人',
                        '--output-dir', str(self.directory / 'applied'),
                        env={'SYNTHETIC_CONSTRUCTION_TOKEN': 'synthetic-explicit-token'})

    def test_apply_binds_actual_revision_without_sending_annotation_fields(self):
        self.assertEqual(self.plan('--manual-entry-rebinding').returncode, 0)
        backend_url, exchanges = self.start_backend()
        result = self.apply(backend_url)
        self.assertEqual(result.returncode, 0, result.stderr)
        paths = [entry['path'] for entry in exchanges]
        self.assertEqual(paths, ['/api/contacts',
                                '/api/contacts/00000000-0000-4000-8000-000000000001/manual-confirmation',
                                '/api/memories/manual-contact',
                                '/api/contacts/00000000-0000-4000-8000-000000000001/layered-memory/quality-input'])
        self.assertEqual(exchanges[-1]['body'], {'memory_versions': [{
            'memory_id': '00000000-0000-4000-8000-000000000011', 'revision': 7}]})
        self.assertEqual(set(exchanges[2]['body']), {'text', 'category', 'contact_id'})
        self.assertNotIn('金标不能外发', json.dumps(exchanges, ensure_ascii=False))
        output = self.directory / 'applied'
        binding = json.loads((output / 'public-bindings.json').read_text())
        self.assertEqual(binding['provenance_coverage']['source_supported_rebound_to_manual'], 1)
        self.assertFalse(binding['provenance_coverage']['source_supported_coverage_complete'])
        model_input = json.loads((output / 'model-inputs.jsonl').read_text())
        self.assertEqual(set(model_input), {'memories', 'scenarios', 'corrections'})
        self.assertEqual(model_input['memories'][0]['revision'], 7)
        review = json.loads((output / 'support-review.json').read_text())
        self.assertEqual(review['cases'][0]['supported_claims'][0]['source_memory_ids'],
                         ['00000000-0000-4000-8000-000000000011'])
        self.assertEqual(review['review_status'], 'unknown')
        self.assertFalse(review['quality_verified'])
        all_files = ''.join(file.read_text() for file in output.iterdir() if file.is_file())
        self.assertNotIn('synthetic-explicit-token', all_files)
        self.assertNotIn('synthetic-explicit-token', result.stdout + result.stderr)

    def test_apply_refuses_non_whitelisted_backend_model_fields_and_keeps_audit(self):
        self.assertEqual(self.plan('--manual-entry-rebinding').returncode, 0)
        backend_url, _ = self.start_backend(leak_gold=True)
        result = self.apply(backend_url)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.directory / 'applied' / 'model-inputs.jsonl').exists())
        audit = (self.directory / 'applied' / 'http-exchanges.jsonl').read_text()
        self.assertIn('quality-input', audit)
        state = json.loads((self.directory / 'applied' / 'public-bindings.json').read_text())
        self.assertEqual(state['construction_status'], 'failed')
        self.assertFalse(state['quality_verified'])

    def test_date_only_and_unknown_source_dates_never_get_a_fabricated_instant(self):
        row = json.loads(self.dataset.read_text())
        row['memories'][0]['temporal_status']['source_time'] = '2024-10-10'
        unknown = json.loads(json.dumps(row['memories'][0]))
        unknown['id'] = 'unknown-date'
        unknown['temporal_status']['source_time'] = None
        row['memories'].append(unknown)
        self.dataset.write_text(json.dumps(row) + '\n')
        worksheet = json.loads(self.worksheet.read_text())
        worksheet['dataset_draft_sha256'] = hashlib.sha256(self.dataset.read_bytes()).hexdigest()
        self.worksheet.write_text(json.dumps(worksheet))
        result = self.plan('--manual-entry-rebinding')
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = json.loads((self.directory / 'plan' / 'construction-plan.json').read_text())['cases'][0]['entries']
        self.assertIn('时刻与时区未知', entries[0]['text'])
        self.assertNotIn('T00:00', entries[0]['text'])
        self.assertEqual(entries[0]['draft_memory']['temporal_status']['source_time'], '2024-10-10')
        self.assertTrue(entries[1]['text'].startswith('合成资料记述日期未知。'))

    def test_owner_construct_uses_only_owner_http_without_creating_a_contact(self):
        row = json.loads(self.dataset.read_text())
        row['scope_kind'] = 'owner'
        row['memories'][0]['provenance'] = 'manual_entry'
        self.dataset.write_text(json.dumps(row) + '\n')
        worksheet = json.loads(self.worksheet.read_text())
        worksheet['dataset_draft_sha256'] = hashlib.sha256(self.dataset.read_bytes()).hexdigest()
        self.worksheet.write_text(json.dumps(worksheet))
        self.assertEqual(self.plan().returncode, 0)
        backend_url, exchanges = self.start_backend(scope='owner')
        result = self.apply(backend_url)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([item['path'] for item in exchanges], [
            '/api/memories/manual-owner', '/api/memories/owner/layered-memory/quality-input'])
        self.assertNotIn('contact_id', exchanges[0]['body'])
        binding = json.loads((self.directory / 'applied' / 'public-bindings.json').read_text())
        self.assertIsNone(binding['cases'][0]['contact_id'])

    def test_apply_refuses_annotation_hidden_inside_backend_timing(self):
        self.assertEqual(self.plan('--manual-entry-rebinding').returncode, 0)
        backend_url, _ = self.start_backend(leak_gold='timing')
        result = self.apply(backend_url)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('MemoryTiming', result.stderr)
        self.assertFalse((self.directory / 'applied' / 'model-inputs.jsonl').exists())

    def test_apply_refuses_extra_annotation_inside_contact_event(self):
        self.assertEqual(self.plan('--manual-entry-rebinding').returncode, 0)
        backend_url, _ = self.start_backend(leak_gold='event')
        result = self.apply(backend_url)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('事件投影', result.stderr)
        self.assertFalse((self.directory / 'applied' / 'model-inputs.jsonl').exists())

    def test_source_date_only_stays_unresolved_until_explicit_reconstruction(self):
        row = json.loads(self.dataset.read_text())
        row['memories'][0]['temporal_status']['source_time'] = '2024-10-10'
        self.dataset.write_text(json.dumps(row) + '\n')
        worksheet = json.loads(self.worksheet.read_text())
        worksheet['dataset_draft_sha256'] = hashlib.sha256(self.dataset.read_bytes()).hexdigest()
        self.worksheet.write_text(json.dumps(worksheet))
        result = self.plan()
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads((self.directory / 'plan' / 'construction-plan.json').read_text())
        self.assertFalse(plan['construction_ready'])
        entry = plan['cases'][0]['entries'][0]
        self.assertIsNone(entry['source_message_time'])
        self.assertEqual(entry['text'], '联系人过去参加陶艺课程。')
        backend_url, exchanges = self.start_backend()
        result = self.apply(backend_url)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('未解决日期', result.stderr)
        self.assertEqual(exchanges, [])
        override = {'draft_memory_id': 'draft-memory', 'original_date_only': '2024-10-10',
                    'source_message_at': '2024-10-10T23:30:00+08:00',
                    'assumption': 'agent_chosen_synthetic_message_time'}
        path = self.directory / 'overrides.json'
        path.write_text(json.dumps({'schema_version': 'synthetic-source-time-overrides-v1', 'entries': [override]}))
        result = self.plan('--source-time-overrides', str(path), '--output-dir', str(self.directory / 'reconstructed-plan'))
        self.assertEqual(result.returncode, 0, result.stderr)
        reconstructed = json.loads((self.directory / 'reconstructed-plan' / 'construction-plan.json').read_text())
        self.assertTrue(reconstructed['construction_ready'])
        entry = reconstructed['cases'][0]['entries'][0]
        self.assertEqual(entry['source_message_time'], '2024-10-10T23:30:00+08:00')
        self.assertEqual(entry['source_time_override'], override)
        self.assertEqual(entry['draft_memory']['temporal_status']['source_time'], '2024-10-10')
        self.assertIn('explicit_synthetic_source_time_reconstruction_requires_review', entry['conversion_gaps'])
