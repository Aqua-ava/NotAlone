"""评测批次一次领取及未知故障停发；全部请求与文件均为合成。"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationBudget,
    EvaluationBudgetAbort,
    EvaluationTransport,
)


class EvaluationBatchTest(unittest.TestCase):
    def _budget(self, home: Path) -> EvaluationBudget:
        output = home / "output"
        output.mkdir(mode=0o700)
        return EvaluationBudget.create(
            run_id=uuid4(),
            output_directory=output,
            request_limit=3,
            allowed_endpoints=("https://synthetic.invalid/v1/chat",),
            config_sha256="a" * 64,
        )

    def test_claimed_batch_cannot_be_reopened_even_before_first_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                run_id = UUID(budget.snapshot()["run_id"])
                with budget.batch():
                    self.assertEqual(budget.snapshot()["reserved_requests"], 0)
                    with self.assertRaises(EvaluationBudgetAbort):
                        EvaluationBudget.open(run_id=run_id)
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_unknown_transport_failure_is_a_hard_stop_instead_of_sdk_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                run_id = UUID(budget.snapshot()["run_id"])
                reservations = []

                def synthetic(request):
                    reservations.append(budget.snapshot()["reserved_requests"])
                    raise OSError("synthetic result storage failure")

                with httpx.Client(
                    transport=EvaluationTransport(
                        budget, synthetic_transport=httpx.MockTransport(synthetic)
                    ),
                    trust_env=False,
                ) as client:
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post("https://synthetic.invalid/v1/chat")
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post("https://synthetic.invalid/v1/chat")
                self.assertEqual(reservations, [1])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_pre_send_claim_blocks_reopen_when_counter_and_close_writes_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget = self._budget(home)
                run_id = UUID(budget.snapshot()["run_id"])
                sent = []
                real_open = os.open

                def storage_fault(path, *args, **kwargs):
                    if Path(path).name == "closed":
                        raise OSError("synthetic close storage failure")
                    return real_open(path, *args, **kwargs)

                with budget.batch():
                    with httpx.Client(
                        transport=EvaluationTransport(
                            budget,
                            synthetic_transport=httpx.MockTransport(
                                lambda request: (
                                    sent.append(request) or httpx.Response(200)
                                )
                            ),
                        ),
                        trust_env=False,
                    ) as client:
                        with patch.object(
                            sqlite3, "connect",
                            side_effect=OSError("synthetic counter failure"),
                        ):
                            with patch.object(os, "open", side_effect=storage_fault):
                                with self.assertRaisesRegex(
                                    EvaluationBudgetAbort,
                                    "budget_stop_record_failed",
                                ):
                                    client.post("https://synthetic.invalid/v1/chat")
                                with self.assertRaises(EvaluationBudgetAbort):
                                    budget.close()
                    # 此时关闭记录尚不存在；故障前领取凭证已经足以拒绝续开。
                    closed = (
                        home / ".notalone-memory-evaluations" / str(run_id)
                        / "closed"
                    )
                    self.assertFalse(closed.exists())
                    with self.assertRaisesRegex(
                        EvaluationBudgetAbort, "batch_already_claimed"
                    ):
                        EvaluationBudget.open(run_id=run_id)
                self.assertEqual(sent, [])

    def test_result_save_failure_preserves_error_and_stops_next_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget = self._budget(home)
                run_id = UUID(budget.snapshot()["run_id"])
                reservations = []

                def synthetic(request):
                    reservations.append(budget.snapshot()["reserved_requests"])
                    return httpx.Response(200, content=b"synthetic full response")

                with httpx.Client(
                    transport=EvaluationTransport(
                        budget, synthetic_transport=httpx.MockTransport(synthetic)
                    ),
                    trust_env=False,
                ) as client:
                    with self.assertRaisesRegex(OSError, "synthetic save failure"):
                        with budget.batch():
                            response = client.post("https://synthetic.invalid/v1/chat")
                            with patch.object(
                                Path, "write_bytes",
                                side_effect=OSError("synthetic save failure"),
                            ):
                                output = home / "output" / "result.bin"
                                output.write_bytes(response.content)
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post("https://synthetic.invalid/v1/chat")
                self.assertEqual(reservations, [1])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_claim_fsync_failure_dispatches_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                sent = []
                with httpx.Client(
                    transport=EvaluationTransport(
                        budget,
                        synthetic_transport=httpx.MockTransport(
                            lambda request: sent.append(request) or httpx.Response(200)
                        ),
                    ),
                    trust_env=False,
                ) as client:
                    with patch.object(
                        os, "fsync",
                        side_effect=OSError("synthetic fsync failure"),
                    ):
                        with self.assertRaises(EvaluationBudgetAbort):
                            client.post("https://synthetic.invalid/v1/chat")
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post("https://synthetic.invalid/v1/chat")
                self.assertEqual(sent, [])

    def test_keyboard_interrupt_closes_batch_without_overwriting_original_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                run_id = UUID(budget.snapshot()["run_id"])
                fault = patch.object(
                    os, "open", side_effect=OSError("synthetic closing fault")
                )
                try:
                    with self.assertRaisesRegex(
                        KeyboardInterrupt, "synthetic interrupt"
                    ) as raised:
                        with budget.batch():
                            fault.start()
                            raise KeyboardInterrupt("synthetic interrupt")
                finally:
                    fault.stop()
                self.assertEqual(
                    raised.exception.__notes__,
                    ["evaluation_close_failed:budget_stop_record_failed"],
                )
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_only_unclaimed_preparation_can_be_opened_and_nested_batch_stops(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                run_id = UUID(budget.snapshot()["run_id"])
                preparation = EvaluationBudget.open(run_id=run_id)
                self.assertEqual(preparation.snapshot()["reserved_requests"], 0)
                with budget.batch():
                    with self.assertRaises(EvaluationBudgetAbort):
                        with budget.batch():
                            self.fail("不能重复领取批次")
                with self.assertRaises(EvaluationBudgetAbort):
                    with preparation.batch():
                        self.fail("不能用旧准备句柄恢复已领取批次")


if __name__ == "__main__":
    unittest.main()
