"""隔离预览通过正式输入、Worker、水位和分层仓储读取当前版本。"""
import os
from pathlib import Path
import unittest

from notalone.application.memory_pipeline_preview import MemoryPipelinePreview
from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.ingest.models import ExistingContactSelection
from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.tasks.worker import PostgresMemoryExtractionRunner
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server.test_layered_memory_management import ControlledProposal, ControlledVerification
from tests.integration.server.test_layered_profile_management import ProfileProposal, ProfileVerification
from tests.unit.memory_extraction.test_flow import _payload
from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier


class MemoryPipelinePreviewTests(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_restart_reads_current_layers_without_replaying_successful_extraction(self):
        contact, _, message = self.import_contact('双方共同参加过课程。')
        source = next(Path(self.temporary.name).glob('synthetic-*.jsonl'))
        class Runtime:
            calls = 0
            def extract(inner, window):
                inner.calls += 1
                return (_payload(message, text='双方共同参加过课程。', category='common_fact'),)
        runtime = Runtime()
        def build():
            service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url), synthetic=True,
                proposer=ControlledProposal(), verifier=ControlledVerification(),
                profile_proposer=ProfileProposal(), profile_verifier=ProfileVerification())
            return MemoryPipelinePreview(self.database_url,
                expected_database=os.environ['NOTALONE_EXPECTED_TEST_DATABASE'],
                extraction_runner=PostgresMemoryExtractionRunner(self.database_url, runtime=runtime,
                    verification_runtime=SyntheticSupportingVerifier(), dimension_release=RELEASE_ALL_DIMENSIONS),
                layered_service=service)
        preview = build()
        from uuid import UUID
        submitted = preview.submit(path=source, owner_id=self.owner_id, selection=ExistingContactSelection(UUID(contact)))
        first = preview.execute(scope=submitted['scope'], task_id=submitted['task_id'])
        self.assertEqual(len(first['l1']['contact']), 1, first)
        self.assertEqual(len(first['contact']['scenarios']), 1, first)
        self.assertIsNotNone(first['contact']['profile'])
        second = build().execute(scope=submitted['scope'], task_id=submitted['task_id'])
        self.assertEqual(runtime.calls, 1)
        self.assertEqual(second['l1'], first['l1'])
        self.assertEqual(second['contact']['profile'], first['contact']['profile'])
        self.delete_source(contact, str(submitted['source_id']))
        removed = preview.read(submitted['scope'])
        self.assertEqual(removed['l1']['contact'], [])
        self.assertEqual(removed['contact']['scenarios'], [])
        self.assertIsNone(removed['contact']['profile'])

    def test_failed_extraction_resumes_original_task_without_duplicate_memory(self):
        from uuid import UUID
        from notalone.memory_extraction.errors import ExtractionRuntimeError
        contact, _, message = self.import_contact('双方共同参加过课程。')
        source = next(Path(self.temporary.name).glob('synthetic-*.jsonl'))
        class Runtime:
            failing = True
            calls = 0
            def extract(inner, window):
                inner.calls += 1
                if inner.failing:
                    raise ExtractionRuntimeError('合成暂时连接失败')
                return (_payload(message, text='双方共同参加过课程。', category='common_fact'),)
        runtime = Runtime()
        def build():
            service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url), synthetic=True,
                proposer=ControlledProposal(), verifier=ControlledVerification(),
                profile_proposer=ProfileProposal(), profile_verifier=ProfileVerification())
            return MemoryPipelinePreview(self.database_url,
                expected_database=os.environ['NOTALONE_EXPECTED_TEST_DATABASE'],
                extraction_runner=PostgresMemoryExtractionRunner(self.database_url, runtime=runtime,
                    verification_runtime=SyntheticSupportingVerifier(), dimension_release=RELEASE_ALL_DIMENSIONS),
                layered_service=service)
        preview = build()
        submitted = preview.submit(path=source, owner_id=self.owner_id, selection=ExistingContactSelection(UUID(contact)))
        first = preview.execute(scope=submitted['scope'], task_id=submitted['task_id'])
        self.assertEqual(first['execution']['status'], 'failed')
        self.assertEqual(first['l1']['contact'], [])
        runtime.failing = False
        recovered = build().execute(scope=submitted['scope'], task_id=submitted['task_id'], retry_failed=True)
        self.assertEqual(len(recovered['l1']['contact']), 1, recovered)
        self.assertIsNotNone(recovered['contact']['profile'])
        calls = runtime.calls
        replay = build().execute(scope=submitted['scope'], task_id=submitted['task_id'])
        self.assertEqual(runtime.calls, calls)
        self.assertEqual(replay['l1'], recovered['l1'])

    def test_explicit_retry_recovers_failed_layer_without_reextracting(self):
        from uuid import UUID
        for failed_layer in ('l2', 'l3'):
            with self.subTest(layer=failed_layer):
                contact, _, message = self.import_contact('双方共同参加过课程。')
                source = max(Path(self.temporary.name).glob('synthetic-*.jsonl'), key=lambda path: path.stat().st_mtime_ns)
                class Runtime:
                    calls = 0
                    def extract(inner, window):
                        inner.calls += 1
                        return (_payload(message, text='双方共同参加过课程。', category='common_fact'),)
                class Scenario(ControlledProposal):
                    failing = failed_layer == 'l2'
                    def propose(inner, *, memories, budget, deadline):
                        if inner.failing:
                            raise RuntimeError('合成L2连接失败')
                        return super().propose(memories=memories, budget=budget, deadline=deadline)
                class Profile(ProfileProposal):
                    failing = failed_layer == 'l3'
                    def propose(inner, *, scenarios, memories, budget, deadline):
                        if inner.failing:
                            raise RuntimeError('合成L3连接失败')
                        return super().propose(scenarios=scenarios, memories=memories, budget=budget, deadline=deadline)
                runtime, scenario, profile = Runtime(), Scenario(), Profile()
                service = LayeredMemoryService(PostgresLayeredMemoryStore(self.database_url), synthetic=True,
                    proposer=scenario, verifier=ControlledVerification(), profile_proposer=profile, profile_verifier=ProfileVerification())
                preview = MemoryPipelinePreview(self.database_url, expected_database=os.environ['NOTALONE_EXPECTED_TEST_DATABASE'],
                    extraction_runner=PostgresMemoryExtractionRunner(self.database_url, runtime=runtime,
                        verification_runtime=SyntheticSupportingVerifier(), dimension_release=RELEASE_ALL_DIMENSIONS), layered_service=service)
                submitted = preview.submit(path=source, owner_id=self.owner_id, selection=ExistingContactSelection(UUID(contact)))
                first = preview.execute(scope=submitted['scope'], task_id=submitted['task_id'])
                self.assertIn(first['contact']['status'], {'failed', 'paused'})
                prior_scenarios = first['contact']['scenarios']
                scenario.failing = profile.failing = False
                recovered = preview.execute(scope=submitted['scope'], task_id=submitted['task_id'], retry_failed=True)
                self.assertIsNotNone(recovered['contact']['profile'], recovered)
                self.assertEqual(runtime.calls, 1)
                if failed_layer == 'l3':
                    self.assertEqual(recovered['contact']['scenarios'], prior_scenarios)
