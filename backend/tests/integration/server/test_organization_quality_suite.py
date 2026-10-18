"""Suite通过真实质量HTTP建立子运行，并沿live源仓储重验聚合。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from uuid import uuid4

from notalone.memory.organization_quality import OrganizationQualityContract, content_digest
from notalone.memory.layered import OrganizationBudget
from notalone.application.organization_quality_suite import SyntheticSuiteReader
from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget, SUITE_SCHEMA
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class OrganizationQualitySuiteHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_formal_operator_assembly_uses_actual_factory_and_live_summary_but_unknown_never_sends(self):
        from unittest.mock import patch
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import make_conninfo
        from notalone.database_migrations import migrate
        from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
        from notalone.server.app import create_app
        from notalone.server.command import _build_memory_service
        from tests.integration.server.core_business_flow_support import HttpBackend
        from notalone.application.organization_runtime import build_layered_memory_service
        from notalone.memory.organization_sdk import actual_organization_adapters
        source_memory, fixture = self.create_fixture(100)
        directory = Path(self.temporary.name) / 'operator-suite'
        PersistentSuiteBudget.create(directory, {'schema_version': SUITE_SCHEMA, 'dataset_version': '明确未验证来源',
            'contract_id': self.actual_contract.identity, 'max_http_attempts': 6, 'fixtures': [fixture]})
        config = Path(self.temporary.name) / 'organization-runtime.json'
        config.write_text(json.dumps({'schema_version': 'organization-runtime-v1', 'suite_directory': str(directory),
            'organization_budget': OrganizationBudget(max_model_calls=4, max_characters=8000).to_payload()}))
        config.chmod(0o600)
        target_name = 'notalone_quality_target_' + uuid4().hex + '_test'
        target = make_conninfo(self.database_url, dbname=target_name)
        print('quality_target_planned: ' + target_name, flush=True)
        with psycopg.connect(self.database_url, dbname='postgres', autocommit=True) as admin:
            admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(target_name)))
            try:
                migrate(target, Path(__file__).resolve().parents[3] / 'database/migrations')
                owner_id = uuid4()
                PostgresOwnerDirectory(target).create_owner(owner_id, '合成正式装配目标')
                configured = {'NOTALONE_ORGANIZATION_QUALITY_CONFIG': str(config), 'NOTALONE_DEEPSEEK_API_KEY': 'synthetic-offline-never-valid',
                    'NOTALONE_DEEPSEEK_MODEL': 'deepseek-flash', 'NOTALONE_DEEPSEEK_BASE_URL': 'https://api.deepseek.com'}
                with patch.dict(os.environ, configured), patch('httpx.HTTPTransport.handle_request', side_effect=AssertionError('未验证配置禁止任何模型HTTP。')) as send:
                    service = build_layered_memory_service(target)
                    self.assertTrue(actual_organization_adapters((service._proposer, service._verifier,
                        service._profile_proposer, service._profile_verifier)))
                    backend = HttpBackend(create_app(database_url=target, owner_id=owner_id, token='synthetic-operator',
                        memory_service=_build_memory_service(target), layered_memory=service), owner_id)
                    try:
                        status, added = backend.request('/api/memories/manual-owner', {'text': '正式装配的合成L1资料。', 'category': 'common_fact'})
                        self.assertEqual(status, 200, added)
                        status, read = backend.request('/api/memories/owner/layered-memory')
                        self.assertEqual(status, 200, read)
                        self.assertEqual(read['layered_memory']['quality']['organization']['status'], 'unknown')
                        self.assertEqual(read['layered_memory']['quality']['reply']['status'], 'unknown')
                        self.assertFalse(read['layered_memory']['quality']['synthetic'])
                        self.assertNotIn('suite_member_unavailable', read['layered_memory']['quality']['organization']['reasons'])
                        status, enabled = backend.request('/api/memories/owner/layered-memory/enable', {'settings_generation': 0, 'purpose_confirmed': True})
                        self.assertEqual(status, 200, enabled)
                        self.assertEqual(enabled['layered_memory']['scenarios'], [])
                        self.assertIsNone(enabled['layered_memory']['profile'])
                        self.assertIsNone(enabled['layered_memory']['work_id'])
                        self.assertFalse(enabled['layered_memory']['quality']['automatic_use_allowed'])
                        self.assertEqual(backend.request('/api/memories/owner')[0], 200)
                        self.assertEqual(self.backend.request('/api/memories/owner/' + source_memory['memory_id'] + '/delete', {})[0], 200)
                        revoked = backend.request('/api/memories/owner/layered-memory')[1]['layered_memory']
                        self.assertEqual(revoked['quality']['organization']['status'], 'unknown')
                        self.assertIn('suite_member_unavailable', revoked['quality']['organization']['reasons'])
                        (directory / 'suite.json').unlink()
                        lost = backend.request('/api/memories/owner/layered-memory')[1]['layered_memory']
                        self.assertEqual(lost['quality']['organization']['status'], 'unknown')
                        self.assertIn('qualification_source_unavailable', lost['quality']['organization']['reasons'])
                        send.assert_not_called()
                    finally:
                        backend.close()
                    self.assertTrue(service._proposer.model.http_client.is_closed)
                    with patch.dict(os.environ, {'NOTALONE_DEEPSEEK_API_KEY': ''}):
                        missing = build_layered_memory_service(target)
                        fallback = HttpBackend(create_app(database_url=target, owner_id=owner_id, token='synthetic-missing-model',
                            memory_service=_build_memory_service(target), layered_memory=missing), owner_id)
                        try:
                            quality = fallback.request('/api/memories/owner/layered-memory')[1]['layered_memory']['quality']
                            self.assertEqual(quality['organization']['status'], 'unknown')
                            self.assertIn('organization_adapter_unavailable', quality['organization']['reasons'])
                            self.assertEqual(fallback.request('/api/memories/owner')[0], 200)
                            send.assert_not_called()
                        finally:
                            fallback.close()
            finally:
                admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(target_name)))
                self.assertFalse(admin.execute('SELECT 1 FROM pg_database WHERE datname=%s', (target_name,)).fetchone())
                print('quality_target_catalog_absent: ' + target_name, flush=True)

    def create_fixture(self, number):
        status, added = self.backend.request('/api/memories/manual-owner', {
            'text': f'合成本人第{number}项课程资料，仅供suite私有导出。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        memory = added['memory']
        status, prepared = self.backend.request('/api/memories/owner/layered-memory/quality-input', {
            'memory_versions': [{'memory_id': memory['memory_id'], 'revision': memory['revision']}]})
        self.assertEqual(status, 200, prepared)
        case = prepared['quality_input']
        status, created = self.backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [case['case_id']], 'max_http_attempts': 6, 'dataset_version': 'suite真实PG回归',
            'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, created)
        contract = dict(created['quality_report']['contract'])
        contract['budget'] = OrganizationBudget(**contract['budget'])
        self.actual_contract = OrganizationQualityContract(**contract)
        return memory, {'scenario_key': f'synthetic-suite-{number}', 'dimension': 'subject', 'scope_kind': 'owner',
                        'feedback_mode': 'baseline', 'feedback_layer': None,
                        'source_ref': {'key': 'suite-test-db', 'database_url_env': 'NOTALONE_TEST_DATABASE_URL',
                                       'expected_database': os.environ['NOTALONE_EXPECTED_TEST_DATABASE']},
                        'owner_id': str(self.owner_id), 'run_id': created['quality_report']['report_id'],
                        'case_id': case['case_id'], 'input_sha256': case['input_sha256'],
                        'annotation_sha256': content_digest(None), 'allocated_attempts': 6}

    def test_live_reader_keeps_all_members_and_source_deletion_closes_entire_suite(self):
        first, fixture1 = self.create_fixture(1)
        _, fixture2 = self.create_fixture(2)
        contract = self.actual_contract
        manifest = {'schema_version': SUITE_SCHEMA, 'dataset_version': 'suite真实PG回归',
                    'contract_id': contract.identity, 'max_http_attempts': 12, 'fixtures': [fixture1, fixture2]}
        directory = Path(self.temporary.name) / 'suite'
        PersistentSuiteBudget.create(directory, manifest)
        reader = SyntheticSuiteReader(directory)
        with self.assertRaises(Exception):
            reader.validate_target(self.database_url)
        report = reader.report(contract)
        self.assertEqual(report['case_count'], 2)
        self.assertEqual(len(report['cases']), 2)
        self.assertEqual(len(report['members']), 2)
        self.assertEqual(report['organization']['status'], 'unknown')
        summary = reader.resolve(contract)
        self.assertEqual(len(summary['receipt']), 64)
        self.assertNotIn('仅供suite私有导出', json.dumps(summary, ensure_ascii=False))
        self.assertIn('coverage_insufficient', summary['stage']['reasons'])
        self.assertIn('feedback_coverage_insufficient', summary['stage']['reasons'])
        status, deleted = self.backend.request('/api/memories/owner/' + first['memory_id'] + '/delete', {})
        self.assertEqual(status, 200, deleted)
        changed = reader.resolve(contract)
        self.assertEqual(changed['stage']['status'], 'unknown')
        self.assertIn('suite_member_unavailable', changed['stage']['reasons'])
        self.assertNotEqual(changed['receipt'], summary['receipt'])
        with self.assertRaises(Exception):
            with reader.hold(contract, summary):
                self.fail('不完整suite不能持锁发布。')

    def test_missing_operator_source_does_not_drop_its_failure_denominator(self):
        _, fixture = self.create_fixture(1)
        contract = self.actual_contract
        fixture['source_ref']['database_url_env'] = 'UNSET_SYNTHETIC_SUITE_SOURCE'
        directory = Path(self.temporary.name) / 'missing-suite'
        PersistentSuiteBudget.create(directory, {'schema_version': SUITE_SCHEMA, 'dataset_version': 'missing-source',
            'contract_id': contract.identity, 'max_http_attempts': 6, 'fixtures': [fixture]})
        report = SyntheticSuiteReader(directory).report(contract)
        self.assertEqual(report['case_count'], 1)
        self.assertEqual(report['member_errors'], [{'case_id': fixture['case_id'], 'reason': 'suite_member_unavailable'}])
        self.assertEqual(report['organization']['status'], 'unknown')

    def test_operator_cli_creates_reads_and_exports_without_printing_body(self):
        _, fixture = self.create_fixture(1)
        manifest = {'schema_version': SUITE_SCHEMA, 'dataset_version': 'suite-CLI真实PG',
                    'contract_id': self.actual_contract.identity, 'max_http_attempts': 6, 'fixtures': [fixture]}
        directory = Path(self.temporary.name)
        manifest_path, suite_path, export_path = directory / 'manifest.json', directory / 'cli-suite', directory / 'private-report.json'
        manifest_path.write_text(json.dumps(manifest))
        environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[3] / 'src'))
        def invoke(*args):
            result = subprocess.run([sys.executable, '-m', 'notalone.experiments.organization_quality_suite', *args],
                                    env=environment, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('仅供suite私有导出', result.stdout)
            return json.loads(result.stdout)
        created = invoke('create', '--manifest', str(manifest_path), '--directory', str(suite_path))
        self.assertEqual(created['fixture_count'], 1)
        self.assertEqual(created['used_attempts'], 0)
        self.assertEqual(invoke('read', '--directory', str(suite_path))['suite_id'], created['suite_id'])
        summary = invoke('summary', '--directory', str(suite_path), '--contract-id', self.actual_contract.identity)
        self.assertEqual(summary['stage']['status'], 'unknown')
        invoke('export', '--directory', str(suite_path), '--contract-id', self.actual_contract.identity,
               '--output', str(export_path))
        self.assertEqual(export_path.stat().st_mode & 0o777, 0o600)
        self.assertIn('仅供suite私有导出', export_path.read_text())
        report = SyntheticSuiteReader(suite_path).report(self.actual_contract)
        calibration = {key: report[key] for key in ('suite_id', 'manifest_sha256', 'member_evidence_sha256')}
        calibration.update({'contract_id': self.actual_contract.identity,
                            'reviewer': {'kind': 'agent', 'name': '合成工程审阅'},
                            'decision': 'approved', 'notes': '子运行尚未执行，不能据此标定全局。'})
        with self.assertRaises(Exception):
            SyntheticSuiteReader(suite_path).calibrate(self.actual_contract, calibration)
        self.assertFalse((suite_path / 'calibration.json').exists())

    def test_feedback_layer_is_checked_against_actual_guard_not_manifest_label(self):
        from tests.integration.server.test_layered_memory_management import LayeredMemoryManagementHttpTest
        from tests.integration.server.test_layered_memory_corrections import CorrectionProposal, CorrectionVerification
        status, contact = self.backend.request('/api/contacts', {'request_id': str(uuid4()), 'display_name': 'suite纠错合成联系人'})
        self.assertEqual(status, 201, contact)
        contact_id = contact['contact']['contact_id']
        self.assertEqual(self.backend.request(f'/api/contacts/{contact_id}/manual-confirmation', {})[0], 200)
        self.assertEqual(self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact_id, 'text': '联系人学习合成陶艺。', 'category': 'common_fact'})[0], 200)
        controlled = LayeredMemoryManagementHttpTest.controlled(self, proposer=CorrectionProposal(), verifier=CorrectionVerification())
        ready = LayeredMemoryManagementHttpTest.enable(self, controlled, contact_id)
        status, feedback = controlled.request(f'/api/contacts/{contact_id}/layered-memory/summary-error', {
            'settings_generation': ready['settings_generation'], 'organization_generation': ready['organization_generation'],
            'target_kind': 'scenario', 'version_id': ready['scenarios'][0]['version_id'], 'item_index': 0,
            'reason': '本例只检查实际L2反馈目标，不声明模型质量。', 'operation_id': str(uuid4())})
        self.assertEqual(status, 200, feedback)
        status, added = self.backend.request('/api/memories/manual-contact', {
            'contact_id': contact_id, 'text': '联系人另有独立合成木工课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, added)
        memory = added['memory']
        status, prepared = self.backend.request(f'/api/contacts/{contact_id}/layered-memory/quality-input', {
            'memory_versions': [{'memory_id': memory['memory_id'], 'revision': memory['revision']}]})
        self.assertEqual(status, 200, prepared)
        case = prepared['quality_input']
        self.assertTrue(case['model_input']['corrections'])
        status, run = self.backend.request('/api/layered-memory/quality-runs', {
            'case_ids': [case['case_id']], 'max_http_attempts': 6, 'dataset_version': 'suite真实反馈目标',
            'data_kind': 'fixed_synthetic', 'purpose_confirmed': True})
        self.assertEqual(status, 200, run)
        payload = dict(run['quality_report']['contract'])
        payload['budget'] = OrganizationBudget(**payload['budget'])
        contract = OrganizationQualityContract(**payload)
        fixture = {'scenario_key': 'actual-l2-feedback', 'dimension': 'subject', 'scope_kind': 'contact',
            'feedback_mode': 'summary_error', 'feedback_layer': 'l2',
            'source_ref': {'key': 'suite-test-db', 'database_url_env': 'NOTALONE_TEST_DATABASE_URL',
                'expected_database': os.environ['NOTALONE_EXPECTED_TEST_DATABASE']},
            'owner_id': str(self.owner_id), 'run_id': run['quality_report']['report_id'], 'case_id': case['case_id'],
            'input_sha256': case['input_sha256'], 'annotation_sha256': content_digest(None), 'allocated_attempts': 6}
        manifest = {'schema_version': SUITE_SCHEMA, 'dataset_version': 'suite真实反馈目标',
                    'contract_id': contract.identity, 'max_http_attempts': 6, 'fixtures': [fixture]}
        directory = Path(self.temporary.name) / 'actual-feedback-suite'
        PersistentSuiteBudget.create(directory, manifest)
        report = SyntheticSuiteReader(directory).report(contract)
        self.assertEqual(len(report['members']), 1)
        self.assertNotIn('fixture_feedback_snapshot_mismatch', report['organization']['reasons'])
        self.assertIn('feedback_output_missing', report['organization']['reasons'])
        self.assertEqual(report['baseline_case_count'], 0)
        self.assertEqual(report['dimensions'], {})
        fixture['feedback_layer'] = 'l3'
        wrong = Path(self.temporary.name) / 'wrong-feedback-layer-suite'
        PersistentSuiteBudget.create(wrong, manifest)
        self.assertIn('fixture_feedback_snapshot_mismatch', SyntheticSuiteReader(wrong).resolve(contract)['stage']['reasons'])
