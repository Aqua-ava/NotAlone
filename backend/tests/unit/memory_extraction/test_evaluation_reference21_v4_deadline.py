"""原公开21窗控制；仅临时home、合成预算与受控时钟。"""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort


class Reference21V4DeadlineTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))

    def budget(self, name, limit=42):
        output = self.home / name
        output.mkdir(mode=0o700)
        return EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=limit,
            allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64), output

    def test_call_closes_fsynced42_receipt_before_exit_and_refuses_next_invocation(self):
        from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline

        budget, output = self.budget("call")
        ticks, exits = [0.0], []
        receipt = output / "deadline.json"

        def exit_worker(code):
            exits.append((code, budget.closed_receipt(), json.loads(receipt.read_bytes())))

        control = Reference21V4Deadline(receipt=receipt, clock=lambda: ticks[0], exit_worker=exit_worker)
        with budget.batch():
            control.start(budget, synthetic=True)
            with control.invocation():
                ticks[0] = 600
                control.checkpoint()
            self.assertEqual(exits[0][0], 124)
            self.assertTrue(exits[0][1]["closed"])
            self.assertEqual(exits[0][2]["request_limit"], 42)
            self.assertEqual(exits[0][2]["reason"], "call_wall_deadline")
            with self.assertRaises(EvaluationBudgetAbort), control.invocation():
                self.fail("超时后不得开始下一请求")
            control.finish()

    def test_earlier_batch_deadline_and_close_failure_preserve_unknown(self):
        from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline

        budget, output = self.budget("batch")
        ticks, exits = [0.0], []
        control = Reference21V4Deadline(receipt=output / "deadline.json", clock=lambda: ticks[0],
                                   exit_worker=exits.append, remaining_batch_seconds=40)
        with budget.batch():
            control.start(budget, synthetic=True)
            ticks[0] = 30
            with control.invocation():
                ticks[0] = 40
                with patch.object(budget, "close", side_effect=EvaluationBudgetAbort("合成关闭失败")):
                    control.checkpoint()
            self.assertEqual(exits, [125])
            receipt = json.loads((output / "deadline.json").read_bytes())
            self.assertEqual(receipt["reason"], "batch_wall_deadline")
            self.assertFalse(receipt["closed"])
            self.assertEqual(receipt["request_limit"], 42)
            self.assertIsNone(receipt["reserved_requests"])
            budget.close()
            control.finish()

    def test_reference21_refuses_old_caps_and_more_than_4h_work_time(self):
        from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline

        for limit in (4, 16, 32, 280):
            with self.subTest(limit=limit):
                budget, output = self.budget(str(limit), limit)
                control = Reference21V4Deadline(receipt=output / "deadline.json", clock=lambda: 0, exit_worker=lambda _: None)
                with budget.batch(), self.assertRaisesRegex(EvaluationBudgetAbort, "claimed_budget_required"):
                    control.start(budget, synthetic=True)
        _, output = self.budget("invalid")
        for remaining in (0, True, 14381, float("nan")):
            with self.subTest(remaining=remaining), self.assertRaisesRegex(EvaluationBudgetAbort, "clock_invalid"):
                Reference21V4Deadline(receipt=output / "deadline.json", clock=lambda: 0,
                                  exit_worker=lambda _: None, remaining_batch_seconds=remaining)

    def test_fixed42_budget_refuses_43st_attempt_without_refunding_failures(self):
        import httpx
        from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline

        budget, output = self.budget("hard-cap")
        control = Reference21V4Deadline(receipt=output / "deadline.json", clock=lambda: 0, exit_worker=lambda _: None)
        request = httpx.Request("POST", "https://api.deepseek.com/chat/completions")
        with budget.batch():
            control.start(budget, synthetic=True)
            for _ in range(42):
                with self.assertRaisesRegex(ValueError, "合成失败"), control.invocation(), budget.attempt(request):
                    raise ValueError("合成失败")
            self.assertEqual(budget.snapshot()["reserved_requests"], 42)
            with self.assertRaises(EvaluationBudgetAbort), budget.attempt(request):
                self.fail("第43次不得进入传输")
        control.finish()
