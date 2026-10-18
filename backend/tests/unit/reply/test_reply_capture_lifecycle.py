"""评测捕获的关闭必须遵守异步连接所属循环，并保留失败回执。"""

import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

import httpx

from notalone.reply.adapters.reply_comparison_capture import ReplyComparisonCapture


class LoopBoundTransport:
    """合成连接在首次异步请求时绑定循环；普通MockTransport没有此约束。"""

    def __init__(self):
        self.transport = httpx.MockTransport(self.respond)
        self.transport.close = self.close
        self.transport.aclose = self.aclose
        self.loop = None
        self.sync_closes = 0
        self.async_closes = 0
        self.sync_error = None
        self.async_error = None

    async def respond(self, request):
        self.loop = asyncio.get_running_loop()
        return httpx.Response(200, json={"synthetic": True})

    def close(self):
        self.sync_closes += 1
        if self.sync_error:
            raise self.sync_error

    async def aclose(self):
        self.async_closes += 1
        if self.loop is not None and self.loop is not asyncio.get_running_loop():
            raise RuntimeError("合成连接不能跨事件循环关闭")
        if self.async_error:
            raise self.async_error


class ReplyCaptureLifecycleTest(unittest.TestCase):
    @contextmanager
    def capture(self, transport):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = {"capture_async_lifecycle": "same-loop-v1", "data_kind": "synthetic", "request_limit": 2, "per_arm_limit": 6,
                        "cases": [{"case_id": "synthetic", "input_sha256": "a" * 64}]}
            with patch.object(Path, "home", return_value=root), patch.dict(os.environ, {}, clear=True), \
                    patch.object(socket.socket, "connect", side_effect=AssertionError("禁止网络")):
                yield ReplyComparisonCapture(root / "output", manifest,
                                             synthetic_transport=transport.transport,
                                             async_lifecycle="same-loop-v1")

    async def request(self, capture):
        with capture.budget.batch(), capture.arm("synthetic", "baseline"):
            await capture.http_async_client.post("https://api.deepseek.com/chat/completions",
                                                 json={"messages": []})

    def test_async_request_and_close_share_loop_and_persist_receipt(self):
        transport = LoopBoundTransport()
        with self.capture(transport) as capture:
            async def run():
                try:
                    await self.request(capture)
                finally:
                    await capture.aclose()

            asyncio.run(run())
            saved = json.loads(capture.path.read_text())
            self.assertTrue(saved["budget_receipt"]["closed"])
            self.assertEqual(saved["budget_receipt"]["reserved_requests"], 1)
            self.assertEqual((transport.sync_closes, transport.async_closes), (1, 1))
            capture.close()
            self.assertEqual((transport.sync_closes, transport.async_closes), (1, 1))

    def test_client_close_failure_preserves_receipt_and_attempts_other_client(self):
        for failed_client in ("sync", "async"):
            with self.subTest(failed_client=failed_client):
                transport = LoopBoundTransport()
                failure = RuntimeError(f"{failed_client}合成关闭失败")
                setattr(transport, f"{failed_client}_error", failure)
                with self.capture(transport) as capture:
                    async def run():
                        await self.request(capture)
                        with self.assertRaises(RuntimeError) as raised:
                            await capture.aclose()
                        self.assertIs(raised.exception, failure)

                    asyncio.run(run())
                    saved = json.loads(capture.path.read_text())
                    self.assertTrue(saved["budget_receipt"]["closed"])
                    self.assertEqual(saved["budget_receipt"]["reserved_requests"], 1)
                    self.assertEqual((transport.sync_closes, transport.async_closes), (1, 1))
                    with self.assertRaises(RuntimeError) as repeated:
                        capture.close()
                    self.assertIs(repeated.exception, failure)

    def test_wrong_loop_close_preserves_receipt_without_reopening_async_connection(self):
        for close_async in (False, True):
            with self.subTest(close_async=close_async):
                transport = LoopBoundTransport()
                with self.capture(transport) as capture:
                    asyncio.run(self.request(capture))
                    with self.assertRaisesRegex(RuntimeError, "请求所属事件循环"):
                        if close_async:
                            asyncio.run(capture.aclose())
                        else:
                            capture.close()
                    self.assertEqual((transport.sync_closes, transport.async_closes), (1, 0))
                    self.assertTrue(json.loads(capture.path.read_text())["budget_receipt"]["closed"])

    def test_sync_close_in_running_loop_requires_await_and_leaves_cleanup_available(self):
        transport = LoopBoundTransport()
        with self.capture(transport) as capture:
            async def run():
                await self.request(capture)
                with self.assertRaisesRegex(RuntimeError, "await capture.aclose"):
                    capture.close()
                self.assertEqual((transport.sync_closes, transport.async_closes), (0, 0))
                await capture.aclose()

            asyncio.run(run())
            self.assertEqual((transport.sync_closes, transport.async_closes), (1, 1))

    def test_multiple_close_errors_are_retained_with_durable_receipt(self):
        transport = LoopBoundTransport()
        transport.sync_error = RuntimeError("同步关闭失败")
        transport.async_error = asyncio.CancelledError("异步关闭取消")
        with self.capture(transport) as capture:
            async def run():
                await self.request(capture)
                with self.assertRaises(BaseExceptionGroup) as raised:
                    await capture.aclose()
                self.assertEqual(raised.exception.exceptions,
                                 (transport.sync_error, transport.async_error))

            asyncio.run(run())
            self.assertTrue(json.loads(capture.path.read_text())["budget_receipt"]["closed"])
            self.assertEqual((transport.sync_closes, transport.async_closes), (1, 1))

    def test_wrong_loop_request_is_rejected_before_new_budget_reservation(self):
        transport = LoopBoundTransport()
        with self.capture(transport) as capture:
            async def send():
                await capture.http_async_client.post("https://api.deepseek.com/chat/completions",
                                                     json={"messages": []})
            with asyncio.Runner() as owner:
                with capture.budget.batch(), capture.arm("synthetic", "baseline"):
                    owner.run(send())
                    with self.assertRaisesRegex(RuntimeError, "同一事件循环"):
                        asyncio.run(send())
                owner.run(capture.aclose())
            self.assertEqual(capture.bundle["budget_receipt"]["reserved_requests"], 1)

    def test_lifecycle_must_be_explicitly_frozen_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            for mode in ("unknown", "same-loop-v1"):
                with self.subTest(mode=mode), self.assertRaises(ValueError):
                    ReplyComparisonCapture(output, {}, async_lifecycle=mode)
                self.assertFalse(output.exists())
