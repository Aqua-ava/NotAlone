"""本地微信 CLI 适配器的公开 seam 测试。"""

from __future__ import annotations

import json
import unittest
from dataclasses import dataclass

from notalone.wechat_cli import (
    CliCommandError,
    CliOutputError,
    LocalWechatCli,
)


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


class RaisingRunner:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def __call__(self, command: tuple[str, ...]) -> FakeCommandResult:
        raise self.error


class LocalWechatCliAdapterTest(unittest.TestCase):
    def test_resolve_chat_preserves_candidates_without_exposing_raw_output(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "ok": True,
                        "tool": "resolve_chat",
                        "command": "resolve-chat",
                        "data": {
                            "query": "姐姐",
                            "candidates": [
                                {
                                    "username": "wxid_candidate_1",
                                    "display_name": "姐姐",
                                    "match": "display_name_exact",
                                    "chat_type": "private",
                                    "last_timestamp": 1787486383,
                                    "sort_timestamp": 1787486383,
                                    "source": "session",
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        )

        result = LocalWechatCli(runner=runner).resolve_chat(
            "姐姐",
            type_filter="private",
        )

        self.assertEqual(len(result.candidates), 1)
        self.assertEqual(result.candidates[0].username, "wxid_candidate_1")
        self.assertEqual(result.candidates[0].match, "display_name_exact")
        self.assertEqual(result.candidates[0].last_timestamp, 1787486383)
        self.assertEqual(
            runner.calls,
            [
                (
                    "wechat-cli",
                    "resolve-chat",
                    "姐姐",
                    "--type-filter",
                    "private",
                    "--strict-read-only",
                )
            ],
        )

    def test_resolve_chat_preserves_multiple_exact_candidates(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "ok": True,
                        "data": {
                            "query": "姐姐",
                            "candidates": [
                                {
                                    "username": "wxid_candidate_1",
                                    "display_name": "姐姐",
                                    "match": "display_name_exact",
                                    "chat_type": "private",
                                },
                                {
                                    "username": "wxid_candidate_2",
                                    "display_name": "姐姐",
                                    "match": "display_name_exact",
                                    "chat_type": "private",
                                },
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        )

        result = LocalWechatCli(runner=runner).resolve_chat("姐姐")

        self.assertEqual(
            [candidate.username for candidate in result.candidates],
            ["wxid_candidate_1", "wxid_candidate_2"],
        )

    def test_tail_parses_text_event_and_returns_cursor(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout="\n".join(
                    [
                        json.dumps(
                            {
                                "type": "message",
                                "cursor": "local_id:42",
                                "event_time": 1787486383,
                                "message": {
                                    "id": {"local_id": 42, "talker": "wxid_1"},
                                    "text": "合成消息",
                                    "kind": "text",
                                    "sender": "姐姐",
                                    "sender_wxid": "wxid_1",
                                    "is_from_me": False,
                                    "time": "2026-08-23 19:59:43",
                                    "time_iso": "2026-08-23T19:59:43+08:00",
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                ),
            )
        )

        result = LocalWechatCli(runner=runner).tail(
            "wxid_1",
            limit=5,
        )

        self.assertEqual(result.cursor, "local_id:42")
        self.assertEqual(len(result.events), 1)
        self.assertEqual(result.events[0].message_id.local_id, 42)
        self.assertEqual(result.events[0].message_id.talker, "wxid_1")
        self.assertEqual(result.events[0].text, "合成消息")
        self.assertFalse(result.events[0].is_from_me)
        self.assertEqual(result.events[0].kind, "text")
        self.assertEqual(
            runner.calls[0],
            (
                "wechat-cli",
                "tail",
                "wxid_1",
                "--limit",
                "5",
                "--jsonl",
                "--strict-read-only",
            ),
        )

    def test_tail_skips_non_text_event_and_keeps_cursor(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "type": "message",
                        "cursor": "local_id:43",
                        "message": {
                            "id": {"local_id": 43, "talker": "wxid_1"},
                            "kind": "image",
                            "text": "",
                            "is_from_me": False,
                        },
                    }
                ),
            )
        )

        result = LocalWechatCli(runner=runner).tail("wxid_1")

        self.assertEqual(result.events, ())
        self.assertEqual(result.cursor, "local_id:43")

    def test_sessions_preserves_matching_metadata(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "ok": True,
                        "data": {
                            "sessions": [
                                {
                                    "username": "wxid_1",
                                    "display_name": "姐姐",
                                    "chat_type": "private",
                                    "last_timestamp": 1787486383,
                                    "sort_timestamp": 1787486383,
                                    "summary": "合成预览",
                                    "last_sender_display_name": "姐姐",
                                }
                            ]
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        )

        sessions = LocalWechatCli(runner=runner).sessions(
            keyword="姐姐",
            type_filter="private",
            limit=5,
        )

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].summary, "合成预览")
        self.assertEqual(sessions[0].last_sender_display_name, "姐姐")
        self.assertEqual(
            runner.calls[0],
            (
                "wechat-cli",
                "sessions",
                "--keyword",
                "姐姐",
                "--type-filter",
                "private",
                "--limit",
                "5",
                "--strict-read-only",
            ),
        )

    def test_tail_uses_cursor_for_incremental_read(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "type": "message",
                        "cursor": "local_id:44",
                        "message": {
                            "id": {"local_id": 44, "talker": "wxid_1"},
                            "kind": "text",
                            "text": "下一条合成消息",
                            "is_from_me": True,
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        )

        LocalWechatCli(runner=runner).tail(
            "wxid_1",
            cursor="local_id:42",
        )

        self.assertEqual(
            runner.calls[0],
            (
                "wechat-cli",
                "tail",
                "wxid_1",
                "--cursor",
                "local_id:42",
                "--jsonl",
                "--strict-read-only",
            ),
        )

    def test_tail_rejects_event_from_another_talker(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "type": "message",
                        "cursor": "local_id:46",
                        "message": {
                            "id": {"local_id": 46, "talker": "wxid_other"},
                            "kind": "text",
                            "text": "串会话合成消息",
                            "is_from_me": False,
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        )

        with self.assertRaises(CliOutputError):
            LocalWechatCli(runner=runner).tail("wxid_1")

    def test_tail_rejects_blank_output(self) -> None:
        runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=" \n\n"))

        with self.assertRaises(CliOutputError):
            LocalWechatCli(runner=runner).tail("wxid_1")

    def test_empty_cursor_is_rejected_before_command(self) -> None:
        runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=""))

        with self.assertRaises(CliOutputError):
            LocalWechatCli(runner=runner).tail("wxid_1", cursor=" ")

        self.assertEqual(runner.calls, [])

    def test_cli_not_found_is_a_stable_error(self) -> None:
        runner = RaisingRunner(FileNotFoundError("/private/path/wechat-cli"))

        with self.assertRaises(CliCommandError) as raised:
            LocalWechatCli(runner=runner).resolve_chat("姐姐")

        self.assertEqual(raised.exception.code, "cli_not_found")

    def test_resolve_chat_rejects_missing_candidates(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps({"ok": True, "data": {"query": "姐姐"}}),
            )
        )

        with self.assertRaises(CliOutputError):
            LocalWechatCli(runner=runner).resolve_chat("姐姐")

    def test_invalid_json_is_a_safe_output_error(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout='{"private_message":"不应出现在错误里"',
            )
        )

        with self.assertRaises(CliOutputError) as raised:
            LocalWechatCli(runner=runner).resolve_chat("姐姐")

        self.assertEqual(raised.exception.code, "cli_output_invalid")
        self.assertNotIn("private_message", str(raised.exception))

    def test_tail_rejects_missing_message_id(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "type": "message",
                        "cursor": "local_id:45",
                        "message": {
                            "kind": "text",
                            "text": "没有 ID 的合成消息",
                            "is_from_me": False,
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        )

        with self.assertRaises(CliOutputError):
            LocalWechatCli(runner=runner).tail("wxid_1")

    def test_nonzero_cli_exit_becomes_stable_error_without_stderr(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=2,
                stdout="",
                stderr="private database path and message text",
            )
        )

        with self.assertRaises(CliCommandError) as raised:
            LocalWechatCli(runner=runner).resolve_chat("姐姐")

        self.assertEqual(raised.exception.code, "cli_command_failed")
        self.assertNotIn("private", str(raised.exception))
        self.assertNotIn("message text", str(raised.exception))
