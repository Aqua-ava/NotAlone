"""评测 HTTP 封顶只使用合成 transport，不构造供应商客户端。"""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationAsyncTransport,
    EvaluationBudget,
    EvaluationBudgetAbort,
    EvaluationTransport,
)


class EvaluationHttpBudgetTest(unittest.TestCase):
    def _budget(self, home, *, limit=2, run_id=None, output_name="output"):
        output = home / output_name
        output.mkdir(mode=0o700)
        return EvaluationBudget.create(
            run_id=run_id or uuid4(),
            output_directory=output,
            request_limit=limit,
            allowed_endpoints=("https://synthetic.invalid/v1/chat",),
            config_sha256="a" * 64,
        )

    def test_retry_loop_spends_all_failed_attempts_and_does_not_catch_hard_stop(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                observed_reservations = []

                def synthetic(request):
                    observed_reservations.append(budget.snapshot()["reserved_requests"])
                    raise httpx.ConnectError("synthetic connection failure")

                caught_failures = []
                with httpx.Client(
                    transport=EvaluationTransport(
                        budget, synthetic_transport=httpx.MockTransport(synthetic)
                    ),
                    trust_env=False,
                ) as client:
                    with self.assertRaises(EvaluationBudgetAbort):
                        for _ in range(5):
                            try:
                                client.post("https://synthetic.invalid/v1/chat")
                            except Exception as error:
                                caught_failures.append(type(error).__name__)
                self.assertEqual(observed_reservations, [1, 2])
                self.assertEqual(caught_failures, ["ConnectError", "ConnectError"])

    def test_problem_total_stops_before_transport(self):
        import os
        from notalone.experiments.problem_budget import ProblemBudget
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = root / 'problem.sqlite3'
            problem = ProblemBudget(ledger)
            problem.create('synthetic', 1, 30)
            problem.start('r1', 'one request only')
            with patch.object(Path, 'home', return_value=root), patch.dict(os.environ, {
                'NOTALONE_PROBLEM_BUDGET': str(ledger), 'NOTALONE_PROBLEM_ROUND': 'r1',
            }):
                budget = self._budget(root)
                sent = []
                with httpx.Client(transport=EvaluationTransport(budget,
                    synthetic_transport=httpx.MockTransport(
                        lambda request: sent.append(1) or httpx.Response(200))), trust_env=False) as client:
                    client.post('https://synthetic.invalid/v1/chat')
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post('https://synthetic.invalid/v1/chat')
                self.assertEqual(sent, [1])
                self.assertEqual(problem.snapshot()['used'], 1)

    def test_distinct_handles_cannot_have_two_requests_in_flight(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                run_id = UUID(budget.snapshot()["run_id"])
                another = EvaluationBudget.open(run_id=run_id)
                second_sent = []
                with httpx.Client(
                    transport=EvaluationTransport(
                        another,
                        synthetic_transport=httpx.MockTransport(
                            lambda request: (
                                second_sent.append(request) or httpx.Response(200)
                            )
                        ),
                    ),
                    trust_env=False,
                ) as second_client:
                    def synthetic(request):
                        with self.assertRaises(EvaluationBudgetAbort):
                            second_client.post("https://synthetic.invalid/v1/chat")
                        return httpx.Response(200)

                    with httpx.Client(
                        transport=EvaluationTransport(
                            budget, synthetic_transport=httpx.MockTransport(synthetic)
                        ),
                        trust_env=False,
                    ) as client:
                        self.assertEqual(
                            client.post(
                                "https://synthetic.invalid/v1/chat"
                            ).status_code,
                            200,
                        )
                self.assertEqual(second_sent, [])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_replaced_output_directory_stops_before_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget = self._budget(home)
                (home / "output").rename(home / "original-output")
                (home / "output").mkdir(mode=0o700)
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
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post("https://synthetic.invalid/v1/chat")
                self.assertEqual(sent, [])

    def test_counter_fault_sends_nothing_and_cannot_be_reopened(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                run_id = UUID(budget.snapshot()["run_id"])
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
                        sqlite3,
                        "connect",
                        side_effect=OSError("synthetic storage failure"),
                    ):
                        with self.assertRaises(EvaluationBudgetAbort):
                            client.post("https://synthetic.invalid/v1/chat")
                self.assertEqual(sent, [])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_same_run_cannot_reset_or_resume_after_close(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                run_id = uuid4()
                budget = self._budget(home, run_id=run_id)
                other_output = home / "other-output"
                other_output.mkdir(mode=0o700)
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.create(
                        run_id=run_id,
                        output_directory=other_output,
                        request_limit=99,
                        allowed_endpoints=("https://other.invalid/v1/chat",),
                        config_sha256="b" * 64,
                    )
                self.assertEqual(budget.snapshot()["request_limit"], 2)
                budget.close()
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_response_read_failure_is_not_refunded(self):
        class FailedResponse(httpx.SyncByteStream):
            def __iter__(self):
                yield b"synthetic-partial"
                raise httpx.ReadError("synthetic response failure")

        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary), limit=1)
                with httpx.Client(
                    transport=EvaluationTransport(
                        budget,
                        synthetic_transport=httpx.MockTransport(
                            lambda request: httpx.Response(200, stream=FailedResponse())
                        ),
                    ),
                    trust_env=False,
                ) as client:
                    with self.assertRaises(httpx.ReadError):
                        client.post("https://synthetic.invalid/v1/chat")
                self.assertEqual(budget.snapshot()["reserved_requests"], 1)

    def test_corrupt_registry_and_unknown_run_hard_stop_without_rebuilding(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=uuid4())
                budget = self._budget(home)
                run_id = UUID(budget.snapshot()["run_id"])
                registry_file = (
                    home / ".notalone-memory-evaluations"
                    / str(run_id) / "budget.sqlite3"
                )
                registry_file.write_bytes(b"synthetic corruption")
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.create(
                        run_id=run_id,
                        output_directory=home / "output",
                        request_limit=2,
                        allowed_endpoints=("https://synthetic.invalid/v1/chat",),
                        config_sha256="a" * 64,
                    )

    def test_caller_cannot_inject_a_transport_with_hidden_retries(self):
        class HiddenRetryTransport(httpx.BaseTransport):
            def handle_request(self, request):
                return httpx.Response(200)

        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationTransport(None, synthetic_transport=HiddenRetryTransport())

    def test_async_timeout_consumes_attempt_and_refuses_reopen(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            output = home / "output"
            output.mkdir(mode=0o700)
            with patch.object(Path, "home", return_value=home):
                run_id = uuid4()
                budget = EvaluationBudget.create(
                    run_id=run_id,
                    output_directory=output,
                    request_limit=1,
                    allowed_endpoints=("https://synthetic.invalid/v1/chat",),
                    config_sha256="a" * 64,
                )
                sent = []

                async def synthetic(request):
                    sent.append(request)
                    raise httpx.ReadTimeout("synthetic timeout")

                async def perform():
                    async with httpx.AsyncClient(
                        transport=EvaluationAsyncTransport(
                            budget,
                            synthetic_transport=httpx.MockTransport(synthetic),
                        ),
                        trust_env=False,
                    ) as client:
                        with self.assertRaises(httpx.ReadTimeout):
                            await client.post("https://synthetic.invalid/v1/chat")

                asyncio.run(perform())
                self.assertEqual(len(sent), 1)
                self.assertEqual(budget.snapshot()["reserved_requests"], 1)
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_async_success_and_concurrent_send_hard_stops(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget = self._budget(Path(temporary))
                dispatched = []
                run_id = UUID(budget.snapshot()["run_id"])

                async def perform():
                    entered = asyncio.Event()
                    release = asyncio.Event()

                    async def synthetic(request):
                        dispatched.append(budget.snapshot()["reserved_requests"])
                        entered.set()
                        await release.wait()
                        return httpx.Response(200, content=b"synthetic")

                    async with httpx.AsyncClient(
                        transport=EvaluationAsyncTransport(
                            budget,
                            synthetic_transport=httpx.MockTransport(synthetic),
                        ),
                        trust_env=False,
                    ) as client:
                        first = asyncio.create_task(
                            client.post("https://synthetic.invalid/v1/chat")
                        )
                        await entered.wait()
                        with self.assertRaises(EvaluationBudgetAbort):
                            await client.post("https://synthetic.invalid/v1/chat")
                        release.set()
                        self.assertEqual((await first).content, b"synthetic")

                asyncio.run(perform())
                self.assertEqual(dispatched, [1])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_disallowed_endpoint_closes_run_instead_of_allowing_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            output = home / "output"
            output.mkdir(mode=0o700)
            with patch.object(Path, "home", return_value=home):
                run_id = uuid4()
                budget = EvaluationBudget.create(
                    run_id=run_id,
                    output_directory=output,
                    request_limit=2,
                    allowed_endpoints=("https://synthetic.invalid/v1/chat",),
                    config_sha256="a" * 64,
                )
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
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post("https://other.invalid/v1/chat")
                self.assertEqual(sent, [])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_one_attempt_is_not_refunded_and_refuses_reopen_or_another_send(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            output = home / "output"
            output.mkdir(mode=0o700)
            with patch.object(Path, "home", return_value=home):
                run_id = uuid4()
                budget = EvaluationBudget.create(
                    run_id=run_id,
                    output_directory=output,
                    request_limit=1,
                    allowed_endpoints=("https://synthetic.invalid/v1/chat",),
                    config_sha256="a" * 64,
                )
                sent = []

                def synthetic(request):
                    sent.append(request.url)
                    return httpx.Response(200, content=b"synthetic")

                with httpx.Client(
                    transport=EvaluationTransport(
                        budget, synthetic_transport=httpx.MockTransport(synthetic)
                    ),
                    trust_env=False,
                ) as client:
                    self.assertEqual(
                        client.post("https://synthetic.invalid/v1/chat").status_code,
                        200,
                    )
                self.assertEqual(budget.snapshot()["reserved_requests"], 1)
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)
                with httpx.Client(
                    transport=EvaluationTransport(
                        budget,
                        synthetic_transport=httpx.MockTransport(synthetic),
                    ),
                    trust_env=False,
                ) as client:
                    with self.assertRaises(EvaluationBudgetAbort):
                        client.post("https://synthetic.invalid/v1/chat")
                self.assertEqual(len(sent), 1)


if __name__ == "__main__":
    unittest.main()
