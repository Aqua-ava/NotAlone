"""固定v3两窗的墙钟控制；只用临时home、合成预算和自有进程。"""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort


class Ambiguity2DeadlineTest(unittest.TestCase):
    def test_fixed4_closes_and_fsyncs_before_exit_and_cannot_use_remaining8_budget(self):
        from notalone.memory_extraction.evaluation_ambiguity2_deadline import Ambiguity2Deadline

        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            output = home / "output"
            output.mkdir(mode=0o700)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=4,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64)
            ticks, exits = [0.0], []
            receipt = output / "deadline.json"

            def exit_worker(code):
                exits.append((code, budget.closed_receipt(), json.loads(receipt.read_bytes())))

            control = Ambiguity2Deadline(receipt=receipt, clock=lambda: ticks[0], exit_worker=exit_worker)
            with budget.batch():
                control.start(budget, synthetic=True)
                with control.invocation():
                    ticks[0] = 601
                    control.checkpoint()
                self.assertEqual(exits[0][0], 124)
                self.assertTrue(exits[0][1]["closed"])
                self.assertEqual(exits[0][2]["request_limit"], 4)
                self.assertEqual(exits[0][2]["reason"], "call_wall_deadline")
                with self.assertRaises(EvaluationBudgetAbort), control.invocation():
                    self.fail("超时后不可继续下一调用")
                control.finish()

    def test_wrong_fixed_budget_is_rejected_and_work_deadline_close_failure_is_unknown(self):
        from notalone.memory_extraction.evaluation_ambiguity2_deadline import Ambiguity2Deadline
        from notalone.memory_extraction.evaluation_remaining8_deadline import Remaining8Deadline

        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            for limit, wrong_type in ((4, Remaining8Deadline), (16, Ambiguity2Deadline)):
                output = home / str(limit)
                output.mkdir(mode=0o700)
                budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=limit,
                    allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64)
                wrong = wrong_type(receipt=output / "wrong.json", clock=lambda: 0, exit_worker=lambda _: None)
                with budget.batch(), self.assertRaises(EvaluationBudgetAbort):
                    wrong.start(budget, synthetic=True)

            output = home / "failure"
            output.mkdir(mode=0o700)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=4,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="b" * 64)
            ticks, exits = [0.0], []
            control = Ambiguity2Deadline(receipt=output / "deadline.json", clock=lambda: ticks[0], exit_worker=exits.append)
            with budget.batch():
                control.start(budget, synthetic=True)
                ticks[0] = 5381
                with patch.object(budget, "close", side_effect=EvaluationBudgetAbort("synthetic close unknown")):
                    control.checkpoint()
                self.assertEqual(exits, [125])
                receipt = json.loads((output / "deadline.json").read_bytes())
                self.assertEqual(receipt["reason"], "batch_wall_deadline")
                self.assertFalse(receipt["closed"])
                self.assertEqual(receipt["request_limit"], 4)
                self.assertIsNone(receipt["reserved_requests"])
                budget.close()
                control.finish()
