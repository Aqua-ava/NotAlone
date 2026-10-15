"""剩余8窗的本地墙钟控制；仅临时home和合成预算。"""

from contextlib import ExitStack
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort


class Remaining8DeadlineTest(unittest.TestCase):
    def test_invocation_exit_rechecks_deadline_even_when_watch_thread_has_not_observed_it(self):
        from notalone.memory_extraction.evaluation_remaining8_deadline import Remaining8Deadline
        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            output = home / "output"; output.mkdir(mode=0o700)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=16,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64)
            ticks, exits = [0.0], []
            # 模拟watcher尚未调度到新时点；调用退场仍必须独立复核。
            clock = lambda: ticks[0] if threading.current_thread() is threading.main_thread() else 0.0
            control = Remaining8Deadline(receipt=output / "deadline.json", clock=clock, exit_worker=exits.append)
            original = ValueError("synthetic original failure")
            with budget.batch():
                control.start(budget, synthetic=True)
                with self.assertRaises(ValueError) as caught:
                    with control.invocation():
                        ticks[0] = 601
                        raise original
                self.assertIs(caught.exception, original)
                self.assertEqual(exits, [124])
                self.assertTrue(budget.closed_receipt()["closed"])
                control.finish()

    def test_call_deadline_durably_closes_before_owned_exit_and_cannot_send_again(self):
        from notalone.memory_extraction.evaluation_remaining8_deadline import Remaining8Deadline

        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            output = home / "output"
            output.mkdir(mode=0o700)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=16,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64)
            ticks, exits = [0.0], []
            receipt = output / "deadline-receipt.json"
            def exit_worker(code):
                exits.append((code, budget.closed_receipt()["closed"], json.loads(receipt.read_bytes())))
            control = Remaining8Deadline(receipt=receipt, clock=lambda: ticks[0], exit_worker=exit_worker)
            with budget.batch():
                control.start(budget, synthetic=True)
                with control.invocation():
                    ticks[0] = 601
                    control.checkpoint()
                self.assertEqual(exits[0][0:2], (124, True))
                self.assertEqual(exits[0][2]["reason"], "call_wall_deadline")
                self.assertTrue(exits[0][2]["closed"])
                self.assertEqual(exits[0][2]["reserved_requests"], 0)
                import httpx
                with self.assertRaises(EvaluationBudgetAbort), budget.attempt(httpx.Request("POST", "https://api.deepseek.com/chat/completions")):
                    self.fail("closed后不能进入传输")
                control.finish()
            self.assertEqual(len(exits), 1)

    def test_batch_deadline_survives_between_calls_and_close_failure_is_unknown(self):
        from notalone.memory_extraction.evaluation_remaining8_deadline import Remaining8Deadline
        with ExitStack() as stack:
            home = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
            stack.enter_context(patch.object(Path, "home", return_value=home))
            output = home / "output"; output.mkdir(mode=0o700)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=16,
                allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64)
            ticks, exits = [0.0], []
            control = Remaining8Deadline(receipt=output / "deadline.json", clock=lambda: ticks[0], exit_worker=exits.append)
            with budget.batch():
                control.start(budget, synthetic=True)
                with control.invocation():
                    ticks[0] = 599
                    control.checkpoint()
                self.assertEqual(exits, [])
                ticks[0] = 2381
                with patch.object(budget, "close", side_effect=EvaluationBudgetAbort("synthetic storage failure")):
                    control.checkpoint()
                self.assertEqual(exits, [125])
                receipt = json.loads((output / "deadline.json").read_bytes())
                self.assertEqual(receipt["reason"], "batch_wall_deadline")
                self.assertFalse(receipt["closed"])
                self.assertIsNone(receipt["reserved_requests"])
                with self.assertRaises(EvaluationBudgetAbort), control.invocation():
                    self.fail("停止后不能开始下一调用")
                budget.close(); control.finish()

    def test_real_owned_synthetic_worker_exits_after_fsynced_closed_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            root = Path(__file__).resolve().parents[4]
            script = f'''
import json,time
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_remaining8_deadline import Remaining8Deadline
home=Path({str(home)!r})
with patch.object(Path,"home",return_value=home):
    output=home/"output";output.mkdir(mode=0o700)
    budget=EvaluationBudget.create(run_id=uuid4(),output_directory=output,request_limit=16,
        allowed_endpoints=("https://api.deepseek.com/chat/completions",),config_sha256="a"*64)
    ticks=[0.0]
    control=Remaining8Deadline(receipt=output/"deadline.json",clock=lambda:ticks[0])
    with budget.batch():
        control.start(budget,synthetic=True)
        ticks[0]=2381
        time.sleep(5)
'''
            child = subprocess.run([sys.executable, "-B", "-c", script], cwd=home,
                env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(root / "backend/src"), "NOTALONE_DISABLE_DOTENV": "1"},
                start_new_session=True, capture_output=True, timeout=6)
            self.assertEqual(child.returncode, 124, child.stderr.decode())
            receipt = json.loads((home / "output/deadline.json").read_bytes())
            self.assertTrue(receipt["closed"])
            self.assertEqual(receipt["reason"], "batch_wall_deadline")
            self.assertEqual(receipt["reserved_requests"], 0)


if __name__ == "__main__":
    unittest.main()
