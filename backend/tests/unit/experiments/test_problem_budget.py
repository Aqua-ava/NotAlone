import os
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from notalone.problem_budget import ProblemBudget, ProblemStopped, reserve_problem_attempt


class ProblemBudgetTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'ledger.sqlite3'
        self.budget = ProblemBudget(self.path)
        self.budget.create('synthetic-problem', 3, 30)

    def test_cumulative_across_rounds_and_reopen(self):
        self.budget.start('r1', 'first hypothesis')
        self.budget.reserve('r1')
        self.budget.finish('r1', 'improved', 'review1')
        reopened = ProblemBudget(self.path)
        reopened.start('r2', 'second hypothesis')
        reopened.reserve('r2')
        reopened.reserve('r2')
        with self.assertRaises(ProblemStopped):
            reopened.reserve('r2')
        self.assertEqual(reopened.snapshot()['used'], 3)
        with self.assertRaises(FileExistsError):
            reopened.create('reset', 9, 30)

    def test_two_unimproved_rounds_stop_even_without_calls(self):
        for i, outcome in enumerate(('unchanged', 'unknown')):
            self.budget.start(str(i), 'hypothesis')
            self.budget.finish(str(i), outcome, 'review')
        with self.assertRaises(ProblemStopped):
            self.budget.start('again', 'hypothesis')

    def test_pending_and_finished_rounds_cannot_be_overwritten(self):
        self.budget.start('r1', 'hypothesis')
        with self.assertRaises(ProblemStopped):
            self.budget.start('r2', 'hypothesis')
        self.budget.finish('r1', 'unchanged', 'review')
        with self.assertRaises(ProblemStopped):
            self.budget.finish('r1', 'improved', 'changed-review')
        with self.assertRaises(ProblemStopped):
            self.budget.reserve('r1')

    def test_deadline_stops_requests_but_allows_closure(self):
        self.budget.start('r1', 'hypothesis')
        with patch('notalone.problem_budget.time.time', return_value=10**12):
            with self.assertRaises(ProblemStopped):
                self.budget.reserve('r1')
        self.budget.finish('r1', 'unknown', 'deadline')

    def test_explicit_continuation_keeps_history_and_limits_new_rounds(self):
        for number in (1, 2):
            self.budget.start(f'r{number}', 'hypothesis')
            if number == 1:
                self.budget.reserve('r1')
            self.budget.finish(f'r{number}', 'unchanged', 'review')
        before = self.budget.snapshot()
        with self.assertRaises(ProblemStopped):
            self.budget.start('r3', 'hypothesis')
        self.budget.authorize_continuation(reason='用户明确同意修复后最多三轮', max_new_rounds=3, minutes=30)
        reopened = ProblemBudget(self.path)
        granted = reopened.snapshot()
        self.assertEqual(granted['used'], before['used'])
        self.assertEqual(granted['no_improvement_rounds'], 2)
        self.assertEqual(granted['rounds'], before['rounds'])
        self.assertEqual(granted['continuations'][0]['existing_rounds'], 2)
        for number in (3, 4, 5):
            reopened.start(f'r{number}', 'hypothesis')
            if number == 5:
                reopened.reserve(f'r{number}')
            reopened.finish(f'r{number}', 'improved', 'review')
        with self.assertRaises(ProblemStopped):
            reopened.start('r6', 'improved也不能超出授权')
        self.assertEqual(reopened.snapshot()['used'], 2)
        self.assertEqual(len(reopened.snapshot()['rounds']), 5)

    def test_continuation_has_own_expiry_and_keeps_original_deadline(self):
        before = self.budget.snapshot()
        with patch('notalone.problem_budget.time.time', return_value=before['deadline'] + 1):
            self.budget.authorize_continuation(reason='明确继续授权', max_new_rounds=3, minutes=1)
            self.budget.start('r1', 'hypothesis')
            self.budget.reserve('r1')
        self.assertEqual(self.budget.snapshot()['deadline'], before['deadline'])
        with patch('notalone.problem_budget.time.time', return_value=before['deadline'] + 62):
            with self.assertRaises(ProblemStopped):
                self.budget.reserve('r1')
            self.budget.finish('r1', 'improved', 'expired')
            with self.assertRaises(ProblemStopped):
                self.budget.start('r2', 'hypothesis')

    def test_cli_records_authorization_and_rejects_invalid_grants(self):
        from notalone.problem_budget import main
        with patch('sys.argv', ['problem_budget', '--ledger', str(self.path), 'authorize-continuation',
                                '--reason', '用户明确授权', '--max-new-rounds', '3', '--minutes', '30']):
            with patch('sys.stdout', new_callable=io.StringIO) as output:
                main()
        grant = json.loads(output.getvalue())['continuations'][0]
        self.assertEqual(grant['reason'], '用户明确授权')
        self.assertEqual(grant['existing_rounds'], 0)
        self.assertEqual(grant['max_new_rounds'], 3)
        for values in ({'reason': '', 'max_new_rounds': 3, 'minutes': 30},
                       {'reason': '授权', 'max_new_rounds': 4, 'minutes': 30},
                       {'reason': '授权', 'max_new_rounds': 3, 'minutes': float('inf')}):
            with self.assertRaises(ValueError):
                self.budget.authorize_continuation(**values)
        self.budget.start('r1', 'hypothesis')
        with self.assertRaises(ProblemStopped):
            self.budget.authorize_continuation(reason='不能跳过在途轮', minutes=30)
        self.assertEqual(len(self.budget.snapshot()['continuations']), 1)

    def test_binding_fails_closed_and_reserves(self):
        self.budget.start('r1', 'hypothesis')
        with patch.dict(os.environ, {'NOTALONE_PROBLEM_BUDGET': str(self.path), 'NOTALONE_PROBLEM_ROUND': ''}):
            with self.assertRaises(ProblemStopped):
                reserve_problem_attempt()
        with patch.dict(os.environ, {'NOTALONE_PROBLEM_BUDGET': str(self.path), 'NOTALONE_PROBLEM_ROUND': 'r1'}):
            reserve_problem_attempt()
        self.assertEqual(self.budget.snapshot()['used'], 1)


    def test_production_extraction_transport_counts_each_physical_attempt(self):
        import httpx
        from notalone.memory_trace.transport import build_trace_http_client
        self.budget.start('r1', 'transport budget')
        sent = []
        def handle(request):
            sent.append(request)
            return httpx.Response(503, json={'error': 'synthetic'})
        with patch.dict(os.environ, {'NOTALONE_PROBLEM_BUDGET': str(self.path), 'NOTALONE_PROBLEM_ROUND': 'r1'}):
            with build_trace_http_client(transport=httpx.MockTransport(handle)) as client:
                for _ in range(3):
                    client.post('https://synthetic.invalid/chat', json={})
                with self.assertRaises(ProblemStopped):
                    client.post('https://synthetic.invalid/chat', json={})
        self.assertEqual(len(sent), 3)
        self.assertEqual(self.budget.snapshot()['used'], 3)

    def test_production_organization_transport_shares_same_budget(self):
        import time
        import httpx
        from notalone.memory.organization_deadline import OrganizationCallDeadline
        from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport, organization_request_context
        from notalone.memory.layered import OrganizationBudget
        self.budget.start('r1', 'layered transport budget')
        transport = OrganizationQualityHTTPTransport(httpx.MockTransport(lambda request: httpx.Response(200, json={})))
        with patch.dict(os.environ, {'NOTALONE_PROBLEM_BUDGET': str(self.path), 'NOTALONE_PROBLEM_ROUND': 'r1'}):
            with organization_request_context(lambda: None, lambda *args: None,
                    OrganizationCallDeadline(time.monotonic()+10), OrganizationBudget()):
                with httpx.Client(transport=transport) as client:
                    client.post('https://synthetic.invalid/chat', json={})
        self.assertEqual(self.budget.snapshot()['used'], 1)
