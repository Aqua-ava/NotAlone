"""全局 CLI 会话事件流的适配器契约测试。"""

from __future__ import annotations

import json
import threading
import unittest
from collections import deque
from dataclasses import dataclass

from notalone.wechat_cli import LocalWechatCli, CliOutputError


@dataclass(frozen=True)
class FakeCommandResult:
    returncode: int
    stdout: str
    stderr: str = ""


class RecordingRunner:
    def __init__(self, result: FakeCommandResult) -> None:
        self.result = result
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, command: tuple[str, ...]) -> FakeCommandResult:
        self.calls.append(command)
        return self.result


class SessionProcess:
    def __init__(self, lines: list[str]) -> None:
        self._lines = deque(f"{line}\n" for line in lines)
        self._finished = threading.Event()
        self.terminated = False
        self.pid = 49152

    def readline(self) -> str:
        if self._lines:
            return self._lines.popleft()
        self._finished.wait(timeout=1)
        return ""

    def poll(self) -> int | None:
        return None if not self._finished.is_set() else 0

    def terminate(self) -> None:
        self.terminated = True
        self._finished.set()

    def kill(self) -> None:
        self.terminate()

    def wait(self, timeout: float | None = None) -> int:
        self._finished.wait(timeout=timeout)
        return 0


class GlobalFollowRunner:
    def __init__(self, process: SessionProcess) -> None:
        self.process = process
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, command: tuple[str, ...]) -> SessionProcess:
        self.calls.append(command)
        return self.process


class GlobalSessionStreamTest(unittest.TestCase):
    def test_close_failure_can_be_retried_without_losing_process(self) -> None:
        class FailsOnce(SessionProcess):
            attempts = 0
            def terminate(self):
                self.attempts += 1
                if self.attempts == 1:
                    raise OSError("合成关闭失败")
                super().terminate()
        process = FailsOnce([])
        stream = LocalWechatCli(follow_runner=GlobalFollowRunner(process)).session_events_follow()
        with self.assertRaises(OSError):
            stream.close()
        stream.close()
        self.assertEqual(process.attempts, 2)
        self.assertTrue(process.terminated)

    def test_parse_failure_close_still_reaps_owned_process(self) -> None:
        process = SessionProcess(["not-json"])
        stream = LocalWechatCli(follow_runner=GlobalFollowRunner(process)).session_events_follow()
        with self.assertRaises(CliOutputError):
            stream.read(timeout=1)
        stream.close()
        self.assertTrue(process.terminated)

    def test_tail_uses_baseline_time_without_cursor(self) -> None:
        runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=""))

        LocalWechatCli(runner=runner).tail(
            "wxid_1",
            since_time="2026-09-01T10:00:00+08:00",
        )

        self.assertEqual(
            runner.calls,
            [
                (
                    "wechat-cli",
                    "tail",
                    "wxid_1",
                    "--since-time",
                    "2026-09-01T10:00:00+08:00",
                    "--include-media-paths",
                    "false",
                    "--strict-read-only",
                )
            ],
        )

    def test_global_session_stream_returns_only_locator_and_cursor(self) -> None:
        process = SessionProcess(
            [
                json.dumps(
                    {
                        "type": "session",
                        "cursor": "session:42",
                        "session": {
                            "username": "wxid_1",
                            "chat_type": "private",
                        },
                    }
                )
            ]
        )
        runner = GlobalFollowRunner(process)

        stream = LocalWechatCli(follow_runner=runner).session_events_follow(
            scan_limit=5000,
            poll_interval="3s",
        )
        item = stream.read(timeout=0.2)

        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(item.cursor, "session:42")
        self.assertEqual(item.conversation_locator, "wxid_1")
        self.assertEqual(
            runner.calls,
            [
                (
                    "wechat-cli",
                    "tail",
                    "--mode",
                    "sessions",
                    "--scan-limit",
                    "5000",
                    "--poll-interval",
                    "3s",
                    "--include-media-paths",
                    "false",
                    "--follow",
                    "--jsonl",
                    "--strict-read-only",
                )
            ],
        )
        stream.close()
        self.assertTrue(process.terminated)

    def test_global_session_stream_accepts_unread_talker_shape(self) -> None:
        process = SessionProcess(
            [
                json.dumps(
                    {
                        "type": "unread",
                        "cursor": "session:43",
                        "talker": "wxid_2",
                    }
                )
            ]
        )
        stream = LocalWechatCli(
            follow_runner=GlobalFollowRunner(process)
        ).session_events_follow()

        item = stream.read(timeout=0.2)

        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(item.conversation_locator, "wxid_2")
        stream.close()


if __name__ == "__main__":
    unittest.main()
