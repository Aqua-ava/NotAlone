"""有限依据15窗的墙钟边界；只用合成预算和临时时钟。"""

from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationBudget, EvaluationBudgetAbort,
)


class BoundedRuntimeDeadlineTest(unittest.TestCase):
    def test_first_call_timeout_closes_all_thirty_attempts_without_recovery(self):
        from notalone.memory_extraction.evaluation_owned_deadline import BoundedRuntime15Deadline

        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            output = home / "output"
            output.mkdir(mode=0o700)
            budget = EvaluationBudget.create(
                run_id=uuid4(), output_directory=output, request_limit=30,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",),
                config_sha256="a" * 64,
            )
            ticks, exits = [0.0], []
            control = BoundedRuntime15Deadline(
                receipt=output / "deadline.json", clock=lambda: ticks[0], exit_worker=exits.append,
            )
            with budget.batch():
                control.start(budget, synthetic=True)
                with control.invocation():
                    ticks[0] = 601
                    control.checkpoint()
                self.assertEqual(exits, [124])
                self.assertTrue(budget.closed_receipt()["closed"])
                self.assertEqual(budget.closed_receipt()["reserved_requests"], 0)
                receipt = json.loads((output / "deadline.json").read_bytes())
                self.assertEqual(receipt["reason"], "call_wall_deadline")
                self.assertEqual(receipt["request_limit"], 30)
                with self.assertRaises(EvaluationBudgetAbort), control.invocation():
                    self.fail("关闭场次不可开始下一次调用")
                control.finish()

    def test_old_budget_and_overlong_batch_are_rejected_before_invocation(self):
        from notalone.memory_extraction.evaluation_owned_deadline import BoundedRuntime15Deadline

        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            output = home / "output"
            output.mkdir(mode=0o700)
            with self.assertRaises(EvaluationBudgetAbort):
                BoundedRuntime15Deadline(
                    receipt=output / "too-long.json", clock=lambda: 0.0,
                    exit_worker=lambda code: None, remaining_batch_seconds=14401,
                )
            budget = EvaluationBudget.create(
                run_id=uuid4(), output_directory=output, request_limit=16,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",),
                config_sha256="a" * 64,
            )
            control = BoundedRuntime15Deadline(
                receipt=output / "wrong-cap.json", clock=lambda: 0.0, exit_worker=lambda code: None,
            )
            with budget.batch(), self.assertRaises(EvaluationBudgetAbort):
                control.start(budget, synthetic=True)
            self.assertTrue(budget.closed_receipt()["closed"])


if __name__ == "__main__":
    unittest.main()
