"""跨进程物理额度必须先持久预留，重启不能重置。"""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from uuid import uuid4

from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget, SuiteBudgetError


def synthetic_manifest(*, allocated=3):
    return {'schema_version': 'organization-synthetic-suite-v2', 'dataset_version': '合成额度回归',
            'contract_id': 'a' * 64, 'max_http_attempts': allocated,
            'fixtures': [{'scenario_key': 'synthetic-one', 'dimension': 'subject', 'scope_kind': 'owner',
                          'feedback_mode': 'baseline', 'feedback_layer': None,
                          'source_ref': {'key': 'synthetic-db', 'database_url_env': 'SYNTHETIC_SUITE_DATABASE',
                                         'expected_database': 'synthetic_suite_test'},
                          'owner_id': str(uuid4()), 'run_id': str(uuid4()), 'case_id': str(uuid4()),
                          'input_sha256': 'b' * 64, 'annotation_sha256': 'c' * 64,
                          'allocated_attempts': allocated}]}


class PersistentSuiteBudgetTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name) / 'suite'
        self.manifest = synthetic_manifest()

    def reserve(self, budget, *, phase='l2_proposal'):
        fixture = self.manifest['fixtures'][0]
        return budget.reserve(source_ref='synthetic-db', owner_id=fixture['owner_id'], run_id=fixture['run_id'],
                              case_id=fixture['case_id'], phase=phase)

    def test_reopen_and_repeated_create_keep_spent_and_unknown_attempts(self):
        budget = PersistentSuiteBudget.create(self.directory, self.manifest)
        first = self.reserve(budget)
        budget.finish(first, outcome='succeeded', request_model='synthetic-request', response_model='synthetic-response')
        self.reserve(budget, phase='l2_verification')
        again = PersistentSuiteBudget.create(self.directory, self.manifest)
        self.assertEqual(again.snapshot()['used_attempts'], 2)
        self.reserve(again)
        with self.assertRaises(SuiteBudgetError):
            self.reserve(PersistentSuiteBudget.open(self.directory))
        changed = json.loads(json.dumps(self.manifest))
        changed['max_http_attempts'] += 1
        with self.assertRaises(SuiteBudgetError):
            PersistentSuiteBudget.create(self.directory, changed)
        for path in self.directory.iterdir():
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_concurrent_processes_cannot_overdraw_child_or_global_allocation(self):
        budget = PersistentSuiteBudget.create(self.directory, self.manifest)
        fixture = self.manifest['fixtures'][0]
        script = ('import sys; from pathlib import Path; '
                  'from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget,SuiteBudgetError; '
                  'b=PersistentSuiteBudget.open(Path(sys.argv[1])); '
                  'b.reserve(source_ref="synthetic-db",owner_id=sys.argv[2],run_id=sys.argv[3],case_id=sys.argv[4],phase="l2_proposal")')
        environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[3] / 'src'))
        def call(_):
            return subprocess.run([sys.executable, '-c', script, str(self.directory), fixture['owner_id'],
                                   fixture['run_id'], fixture['case_id']], env=environment,
                                  capture_output=True, timeout=15).returncode
        with ThreadPoolExecutor(max_workers=8) as pool:
            codes = list(pool.map(call, range(8)))
        self.assertEqual(codes.count(0), 3)
        self.assertEqual(budget.snapshot()['used_attempts'], 3)
        self.assertEqual(len(budget.snapshot()['reservations']), 3)

    def test_finish_is_idempotent_but_never_releases_or_rewrites_a_reservation(self):
        budget = PersistentSuiteBudget.create(self.directory, self.manifest)
        identifier = self.reserve(budget)
        budget.finish(identifier, outcome='failed')
        budget.finish(identifier, outcome='failed')
        with self.assertRaises(SuiteBudgetError):
            budget.finish(identifier, outcome='succeeded')
        self.assertEqual(budget.snapshot()['used_attempts'], 1)

    def test_child_allocation_remains_pinned_when_global_capacity_is_available(self):
        self.manifest['max_http_attempts'] = 6
        other = synthetic_manifest()['fixtures'][0]
        other['scenario_key'] = 'synthetic-two'
        self.manifest['fixtures'].append(other)
        budget = PersistentSuiteBudget.create(self.directory, self.manifest)
        for _ in range(3):
            self.reserve(budget)
        with self.assertRaises(SuiteBudgetError):
            self.reserve(budget)
        self.assertEqual(budget.snapshot()['remaining_attempts'], 3)
        budget.reserve(source_ref='synthetic-db', owner_id=other['owner_id'], run_id=other['run_id'],
                       case_id=other['case_id'], phase='l2_proposal')
        self.assertEqual(budget.snapshot()['used_attempts'], 4)

    def test_current_finite_suite_bound_and_fact_variant_are_explicit_without_changing_child_cap(self):
        self.manifest['max_http_attempts'] = 800
        self.manifest['fixtures'][0].update(feedback_mode='fact_corrected', feedback_layer='l2')
        self.manifest['fixtures'][0]['fact_error_command'] = {'settings_generation': 1, 'organization_generation': 1,
            'target_kind': 'scenario', 'version_id': str(uuid4()), 'item_index': 0, 'memory_id': str(uuid4())}
        budget = PersistentSuiteBudget.create(self.directory, self.manifest)
        self.assertEqual(budget.snapshot()['remaining_attempts'], 800)
        self.reserve(budget)
        self.assertEqual(PersistentSuiteBudget.open(self.directory).snapshot()['used_attempts'], 1)
        changed = json.loads(json.dumps(self.manifest))
        changed['max_http_attempts'] = 801
        with self.assertRaises(SuiteBudgetError):
            PersistentSuiteBudget.create(self.directory.parent / 'over-bound', changed)
