"""固定指代主集16窗控制；仅临时home、合成预算和受控时钟。"""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort


class Main16DeadlineTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))

    def budget(self, name, limit=32):
        output = self.home / name
        output.mkdir(mode=0o700)
        return EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=limit,
            allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64), output

    def test_call_closes_fsynced32_receipt_before_exit_and_refuses_next_invocation(self):
        from notalone.memory_extraction.evaluation_main16_deadline import Main16Deadline

        budget, output = self.budget("call")
        ticks, exits = [0.0], []
        receipt = output / "deadline.json"

        def exit_worker(code):
            exits.append((code, budget.closed_receipt(), json.loads(receipt.read_bytes())))

        control = Main16Deadline(receipt=receipt, clock=lambda: ticks[0], exit_worker=exit_worker)
        with budget.batch():
            control.start(budget, synthetic=True)
            with control.invocation():
                ticks[0] = 600
                control.checkpoint()
            self.assertEqual(exits[0][0], 124)
            self.assertTrue(exits[0][1]["closed"])
            self.assertEqual(exits[0][2]["request_limit"], 32)
            self.assertEqual(exits[0][2]["reason"], "call_wall_deadline")
            with self.assertRaises(EvaluationBudgetAbort), control.invocation():
                self.fail("超时后不得开始下一请求")
            control.finish()

    def test_main16_refuses_old_caps_before_starting_watch(self):
        from notalone.memory_extraction.evaluation_main16_deadline import Main16Deadline

        for limit in (4, 16):
            with self.subTest(limit=limit):
                budget, output = self.budget(str(limit), limit)
                control = Main16Deadline(receipt=output / "deadline.json", clock=lambda: 0, exit_worker=lambda _: None)
                with budget.batch(), self.assertRaisesRegex(EvaluationBudgetAbort, "claimed_budget_required"):
                    control.start(budget, synthetic=True)

    def test_remaining_whole_batch_time_wins_over_a_fresh_call_and_close_failure_stays_unknown(self):
        from notalone.memory_extraction.evaluation_main16_deadline import Main16Deadline

        budget, output = self.budget("batch")
        ticks, exits = [0.0], []
        control = Main16Deadline(receipt=output / "deadline.json", clock=lambda: ticks[0],
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
            self.assertEqual(receipt["request_limit"], 32)
            self.assertIsNone(receipt["reserved_requests"])
            budget.close()
            control.finish()

    def test_invalid_or_more_than_12h_work_time_is_rejected(self):
        from notalone.memory_extraction.evaluation_main16_deadline import Main16Deadline

        _, output = self.budget("invalid")
        for remaining in (0, 43181, float("nan")):
            with self.subTest(remaining=remaining), self.assertRaisesRegex(EvaluationBudgetAbort, "clock_invalid"):
                Main16Deadline(receipt=output / "deadline.json", clock=lambda: 0,
                               exit_worker=lambda _: None, remaining_batch_seconds=remaining)

    def test_fixed32_budget_hard_refuses_33rd_attempt_without_refunding_failed_attempts(self):
        import httpx
        from notalone.memory_extraction.evaluation_main16_deadline import Main16Deadline

        budget, output = self.budget("hard-cap")
        control = Main16Deadline(receipt=output / "deadline.json", clock=lambda: 0, exit_worker=lambda _: None)
        request = httpx.Request("POST", "https://api.deepseek.com/chat/completions")
        with budget.batch():
            control.start(budget, synthetic=True)
            for _ in range(32):
                with self.assertRaisesRegex(ValueError, "合成失败"), control.invocation(), budget.attempt(request):
                    raise ValueError("合成失败")
            self.assertEqual(budget.snapshot()["reserved_requests"], 32)
            with self.assertRaises(EvaluationBudgetAbort), budget.attempt(request):
                self.fail("第33次不得进入传输")
        control.finish()

