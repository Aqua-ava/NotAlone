import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from notalone.experiments.problem_budget import ProblemBudget, ProblemStopped, reserve_problem_attempt


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
        with patch('notalone.experiments.problem_budget.time.time', return_value=10**12):
            with self.assertRaises(ProblemStopped):
                self.budget.reserve('r1')
        self.budget.finish('r1', 'unknown', 'deadline')

    def test_binding_fails_closed_and_reserves(self):
        self.budget.start('r1', 'hypothesis')
        with patch.dict(os.environ, {'NOTALONE_PROBLEM_BUDGET': str(self.path), 'NOTALONE_PROBLEM_ROUND': ''}):
            with self.assertRaises(ProblemStopped):
                reserve_problem_attempt()
        with patch.dict(os.environ, {'NOTALONE_PROBLEM_BUDGET': str(self.path), 'NOTALONE_PROBLEM_ROUND': 'r1'}):
            reserve_problem_attempt()
        self.assertEqual(self.budget.snapshot()['used'], 1)
