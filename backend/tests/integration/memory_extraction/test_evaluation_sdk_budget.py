"""真实 SDK 的离线预算接缝：显式 legacy HTTPX 客户端与合成返回。"""

from __future__ import annotations

import asyncio
import importlib
import os
import socket
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationAsyncTransport,
    EvaluationBudget,
    EvaluationBudgetAbort,
    EvaluationTransport,
)


BASE_URL = "https://evaluation.invalid/v1"
ENDPOINT = f"{BASE_URL}/chat/completions"
MODEL = "synthetic-evaluation-model"
MESSAGES = [{"role": "user", "content": "合成评测输入"}]


def successful_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        request=request,
        json={
            "id": "synthetic-completion",
            "object": "chat.completion",
            "created": 1,
            "model": MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "合成评测返回"},
                    "finish_reason": "stop",
                }
            ],
        },
    )


class EvaluationSdkBudgetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # 替换环境对象，不读取或复制当前环境中的凭据、额外请求头。
        self.stack.enter_context(patch.object(os, "environ", {}))
        self.sdk = importlib.import_module("openai")
        httpx2 = importlib.import_module("httpx2")
        # 两套客户端模块预绑定了构造器；公共别名与预绑定位置都拒绝出站。
        transport_modules = (
            httpx,
            httpx2,
            importlib.import_module("httpx._client"),
            importlib.import_module("httpx2._client"),
        )
        for module in transport_modules:
            for name in ("HTTPTransport", "AsyncHTTPTransport"):
                self.stack.enter_context(
                    patch.object(
                        module,
                        name,
                        side_effect=AssertionError("禁止构造真实网络 transport"),
                    )
                )
        for name in ("connect", "connect_ex"):
            self.stack.enter_context(
                patch.object(
                    socket.socket,
                    name,
                    side_effect=AssertionError("禁止真实 socket 连接"),
                )
            )
        self.stack.enter_context(
            patch.object(
                socket,
                "getaddrinfo",
                side_effect=AssertionError("禁止真实 DNS 查询"),
            )
        )
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))

    def budget(self, *, limit: int) -> EvaluationBudget:
        output = self.home / f"output-{uuid4()}"
        output.mkdir(mode=0o700)
        return EvaluationBudget.create(
            run_id=uuid4(),
            output_directory=output,
            request_limit=limit,
            allowed_endpoints=(ENDPOINT,),
            config_sha256="a" * 64,
        )

    def client(self, budget: EvaluationBudget, handler: Any) -> Any:
        http_client = httpx.Client(
            transport=EvaluationTransport(
                budget, synthetic_transport=httpx.MockTransport(handler)
            ),
            trust_env=False,
            follow_redirects=False,
        )
        # OpenAI 3.3.1 的官方 HTTPX2 迁移说明提供此临时兼容接口。
        return self.sdk.OpenAI(
            api_key="synthetic-not-a-real-key",
            base_url=BASE_URL,
            timeout=60.0,
            max_retries=2,
            http_client=cast(Any, http_client),
        )

    def async_client(self, budget: EvaluationBudget, handler: Any) -> Any:
        http_client = httpx.AsyncClient(
            transport=EvaluationAsyncTransport(
                budget, synthetic_transport=httpx.MockTransport(handler)
            ),
            trust_env=False,
            follow_redirects=False,
        )
        return self.sdk.AsyncOpenAI(
            api_key="synthetic-not-a-real-key",
            base_url=BASE_URL,
            timeout=60.0,
            max_retries=2,
            http_client=cast(Any, http_client),
        )

    def test_sync_sdk_retry_success_keeps_all_reservations(self) -> None:
        budget = self.budget(limit=3)
        observed: list[int] = []
        run_id = UUID(budget.snapshot()["run_id"])

        def synthetic(request: httpx.Request) -> httpx.Response:
            self.assertEqual(str(request.url), ENDPOINT)
            self.assertEqual(request.method, "POST")
            observed.append(budget.snapshot()["reserved_requests"])
            if len(observed) == 1:
                return httpx.Response(
                    503,
                    request=request,
                    headers={"retry-after-ms": "1"},
                    json={"error": {"message": "合成暂时失败", "type": "synthetic"}},
                )
            return successful_response(request)

        with budget.batch(), self.client(budget, synthetic) as client:
            response = client.chat.completions.create(model=MODEL, messages=MESSAGES)
            self.assertEqual(budget.snapshot()["reserved_requests"], 2)
        self.assertEqual(response.choices[0].message.content, "合成评测返回")
        self.assertEqual(observed, [1, 2])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_async_sdk_retry_success_keeps_all_reservations(self) -> None:
        budget = self.budget(limit=3)
        observed: list[int] = []
        run_id = UUID(budget.snapshot()["run_id"])

        async def synthetic(request: httpx.Request) -> httpx.Response:
            self.assertEqual(str(request.url), ENDPOINT)
            self.assertEqual(request.method, "POST")
            observed.append(budget.snapshot()["reserved_requests"])
            if len(observed) == 1:
                return httpx.Response(
                    503,
                    request=request,
                    headers={"retry-after-ms": "1"},
                    json={"error": {"message": "合成暂时失败", "type": "synthetic"}},
                )
            return successful_response(request)

        async def perform() -> Any:
            with budget.batch():
                async with self.async_client(budget, synthetic) as client:
                    response = await client.chat.completions.create(
                        model=MODEL, messages=MESSAGES
                    )
                    self.assertEqual(budget.snapshot()["reserved_requests"], 2)
                    return response

        response = asyncio.run(perform())
        self.assertEqual(response.choices[0].message.content, "合成评测返回")
        self.assertEqual(observed, [1, 2])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_sync_sdk_retry_cannot_send_after_limit_or_wrap_hard_stop(self) -> None:
        budget = self.budget(limit=2)
        observed: list[int] = []
        run_id = UUID(budget.snapshot()["run_id"])

        def synthetic(request: httpx.Request) -> httpx.Response:
            observed.append(budget.snapshot()["reserved_requests"])
            raise httpx.ConnectError("合成连接失败", request=request)

        with budget.batch(), self.client(budget, synthetic) as client:
            with self.assertRaises(EvaluationBudgetAbort):
                client.chat.completions.create(model=MODEL, messages=MESSAGES)
            with self.assertRaises(EvaluationBudgetAbort):
                client.chat.completions.create(model=MODEL, messages=MESSAGES)
        self.assertEqual(observed, [1, 2])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_async_sdk_retry_cannot_send_after_limit_or_wrap_hard_stop(self) -> None:
        budget = self.budget(limit=2)
        observed: list[int] = []
        run_id = UUID(budget.snapshot()["run_id"])

        async def synthetic(request: httpx.Request) -> httpx.Response:
            observed.append(budget.snapshot()["reserved_requests"])
            raise httpx.ReadTimeout("合成读取超时", request=request)

        async def perform() -> None:
            with budget.batch():
                async with self.async_client(budget, synthetic) as client:
                    with self.assertRaises(EvaluationBudgetAbort):
                        await client.chat.completions.create(
                            model=MODEL, messages=MESSAGES
                        )
                    with self.assertRaises(EvaluationBudgetAbort):
                        await client.chat.completions.create(
                            model=MODEL, messages=MESSAGES
                        )

        asyncio.run(perform())
        self.assertEqual(observed, [1, 2])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_sync_sdk_terminal_errors_keep_all_attempts_without_refund(self) -> None:
        for status, expected_attempts in ((400, 1), (503, 3)):
            with self.subTest(status=status):
                budget = self.budget(limit=4)
                observed: list[int] = []
                run_id = UUID(budget.snapshot()["run_id"])

                def synthetic(request: httpx.Request) -> httpx.Response:
                    observed.append(budget.snapshot()["reserved_requests"])
                    return httpx.Response(
                        status,
                        request=request,
                        headers={"retry-after-ms": "1"},
                        json={
                            "error": {"message": "合成最终失败", "type": "synthetic"}
                        },
                    )

                with budget.batch(), self.client(budget, synthetic) as client:
                    with self.assertRaises(self.sdk.APIStatusError):
                        client.chat.completions.create(model=MODEL, messages=MESSAGES)
                    self.assertEqual(
                        budget.snapshot()["reserved_requests"], expected_attempts
                    )
                self.assertEqual(observed, [1] if status == 400 else [1, 2, 3])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)

    def test_sync_sdk_unknown_result_stops_after_one_dispatch(self) -> None:
        budget = self.budget(limit=4)
        observed: list[int] = []
        run_id = UUID(budget.snapshot()["run_id"])

        def synthetic(request: httpx.Request) -> httpx.Response:
            observed.append(budget.snapshot()["reserved_requests"])
            raise OSError("合成响应记录故障")

        with self.assertRaises(EvaluationBudgetAbort):
            with budget.batch(), self.client(budget, synthetic) as client:
                client.chat.completions.create(model=MODEL, messages=MESSAGES)
        self.assertEqual(observed, [1])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_async_sdk_unknown_result_stops_after_one_dispatch(self) -> None:
        budget = self.budget(limit=4)
        observed: list[int] = []
        run_id = UUID(budget.snapshot()["run_id"])

        async def synthetic(request: httpx.Request) -> httpx.Response:
            observed.append(budget.snapshot()["reserved_requests"])
            raise OSError("合成响应记录故障")

        async def perform() -> None:
            with budget.batch():
                async with self.async_client(budget, synthetic) as client:
                    await client.chat.completions.create(model=MODEL, messages=MESSAGES)

        with self.assertRaises(EvaluationBudgetAbort):
            asyncio.run(perform())
        self.assertEqual(observed, [1])
        with self.assertRaises(EvaluationBudgetAbort):
            EvaluationBudget.open(run_id=run_id)

    def test_async_sdk_terminal_errors_keep_all_attempts_without_refund(self) -> None:
        for status, expected_attempts in ((400, 1), (503, 3)):
            with self.subTest(status=status):
                budget = self.budget(limit=4)
                observed: list[int] = []
                run_id = UUID(budget.snapshot()["run_id"])

                async def synthetic(request: httpx.Request) -> httpx.Response:
                    observed.append(budget.snapshot()["reserved_requests"])
                    return httpx.Response(
                        status,
                        request=request,
                        headers={"retry-after-ms": "1"},
                        json={
                            "error": {"message": "合成最终失败", "type": "synthetic"}
                        },
                    )

                async def perform() -> None:
                    with budget.batch():
                        async with self.async_client(budget, synthetic) as client:
                            with self.assertRaises(self.sdk.APIStatusError):
                                await client.chat.completions.create(
                                    model=MODEL, messages=MESSAGES
                                )
                            self.assertEqual(
                                budget.snapshot()["reserved_requests"],
                                expected_attempts,
                            )

                asyncio.run(perform())
                self.assertEqual(observed, [1] if status == 400 else [1, 2, 3])
                with self.assertRaises(EvaluationBudgetAbort):
                    EvaluationBudget.open(run_id=run_id)


if __name__ == "__main__":
    unittest.main()
