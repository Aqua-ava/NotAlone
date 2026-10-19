"""本地微信 CLI 适配器的公开 seam 测试。"""

from __future__ import annotations

import json
import subprocess
import threading
import unittest
from dataclasses import dataclass
from unittest.mock import patch

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


class FollowProcess:
    def __init__(self, lines: list[str], returncode: int = 0) -> None:
        self._lines = iter(lines)
        self._returncode = returncode
        self.terminated = False
        self._lock = threading.Lock()
        self._finished = threading.Event()

    def readline(self) -> str:
        with self._lock:
            try:
                return next(self._lines)
            except StopIteration:
                pass
        self._finished.wait(timeout=1)
        return ""

    def poll(self) -> int | None:
        return self._returncode if self._finished.is_set() else None

    def terminate(self) -> None:
        self.terminated = True
        self._finished.set()

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        return self._returncode


class FollowRunner:
    def __init__(self, process: FollowProcess) -> None:
        self.process = process
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, command: tuple[str, ...]) -> FollowProcess:
        self.calls.append(command)
        return self.process


class BlockingCommandProcess:
    """可被 close() 终止的合成一次性命令进程。"""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.released = threading.Event()
        self.returncode: int | None = None
        self.terminated = False

    def __enter__(self):
        return self

    def __exit__(self, *args: object) -> None:
        del args

    def communicate(self, timeout: float | None = None):
        self.started.set()
        self.released.wait(timeout=timeout or 2)
        return '{"ok": true, "data": {"version": "1.6.20"}}', ""

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15
        self.released.set()

    def wait(self, timeout: float | None = None) -> int:
        if not self.released.wait(timeout=timeout):
            raise subprocess.TimeoutExpired("wechat-cli", timeout)
        assert self.returncode is not None
        return self.returncode

    def kill(self) -> None:
        self.terminate()


class LocalWechatCliAdapterTest(unittest.TestCase):
    def test_empty_live_tail_envelope_confirms_freshness_without_advancing(self) -> None:
        runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=json.dumps({
            "ok": True,
            "data": {
                "events": [], "cursor": "opaque-current-cursor",
                "freshness": {"message_source": "live_message_db"},
                "query": {"chat": "wxid_1", "has_more": False},
            },
        })))

        result = LocalWechatCli(runner=runner).tail("wxid_1", cursor="opaque-current-cursor")

        self.assertTrue(result.freshness_confirmed)
        self.assertEqual(result.events, ())
        self.assertIsNone(result.cursor)
        self.assertIsNone(result.last_local_id)
        self.assertNotIn("--jsonl", runner.calls[0])

    def test_tail_envelope_rejects_unproven_or_other_chat_freshness(self) -> None:
        cases = [
            {"freshness": {}},
            {"freshness": {"message_source": "cache"}},
            {"query": {"chat": "wxid_other", "has_more": False}},
            {"query": {"chat": "wxid_1"}},
            {"query": {"chat": "wxid_1", "has_more": True}},
            {"warnings": ["合成降级警告"]},
            {"error": {"message": "合成错误"}},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                data = {
                    "events": [],
                    "freshness": {"message_source": "live_message_db"},
                    "query": {"chat": "wxid_1", "has_more": False},
                }
                data.update(changes)
                runner = RecordingRunner(FakeCommandResult(
                    returncode=0, stdout=json.dumps({"ok": True, "data": data})
                ))
                with self.assertRaises(CliOutputError) as raised:
                    LocalWechatCli(runner=runner).tail("wxid_1")
                self.assertEqual(raised.exception.code, "cli_freshness_unknown")

    def test_tail_envelope_parses_messages_and_rejects_cross_contact_events(self) -> None:
        for talker in ("wxid_1", "wxid_other"):
            with self.subTest(talker=talker):
                runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=json.dumps({
                    "ok": True,
                    "data": {
                        "events": [{
                            "type": "message", "cursor": "local_id:43",
                            "message": {
                                "id": {"local_id": 43, "talker": talker},
                                "kind": "text", "text": "合成消息", "is_from_me": True,
                            },
                        }],
                        "freshness": {"message_source": "live_message_db"},
                        "query": {"chat": "wxid_1", "has_more": False},
                    },
                })))
                if talker != "wxid_1":
                    with self.assertRaises(CliOutputError):
                        LocalWechatCli(runner=runner).tail("wxid_1")
                else:
                    result = LocalWechatCli(runner=runner).tail("wxid_1")
                    self.assertEqual(result.events[0].text, "合成消息")
                    self.assertEqual(result.cursor, "local_id:43")
                    self.assertTrue(result.freshness_confirmed)

    def test_tail_envelope_with_remaining_page_cannot_complete_backfill(self) -> None:
        runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=json.dumps({
            "ok": True,
            "data": {
                "events": [{
                    "type": "message", "cursor": "local_id:43",
                    "message": {
                        "id": {"local_id": 43, "talker": "wxid_1"},
                        "kind": "text", "text": "合成消息", "is_from_me": True,
                    },
                }],
                "freshness": {"message_source": "live_message_db"},
                "query": {"chat": "wxid_1", "has_more": True},
            },
        })))
        with self.assertRaises(CliOutputError) as raised:
            LocalWechatCli(runner=runner).tail("wxid_1")
        self.assertEqual(raised.exception.code, "cli_freshness_unknown")

    def test_close_terminates_inflight_one_shot_command(self) -> None:
        process = BlockingCommandProcess()
        cli = LocalWechatCli(timeout_seconds=30)
        errors: list[Exception] = []

        def run_version() -> None:
            try:
                cli.version()
            except Exception as error:  # command is intentionally terminated
                errors.append(error)

        with patch(
            "notalone.wechat_cli.adapter.subprocess.Popen",
            return_value=process,
        ):
            thread = threading.Thread(target=run_version)
            thread.start()
            self.assertTrue(process.started.wait(timeout=1))
            try:
                cli.close()
            finally:
                process.terminate()
            thread.join(timeout=1)

        self.assertFalse(thread.is_alive())
        self.assertTrue(process.terminated)
        self.assertTrue(errors)

    def test_tail_follow_streams_events_and_closes_process(self) -> None:
        follow_runner = FollowRunner(
            FollowProcess(
                [
                    json.dumps(
                        {
                            "type": "message",
                            "cursor": "local_id:42",
                            "message": {
                                "id": {"local_id": 42, "talker": "wxid_1"},
                                "kind": "text",
                                "text": "流式合成消息",
                                "is_from_me": False,
                            },
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                ]
            )
        )
        cli = LocalWechatCli(
            runner=RecordingRunner(FakeCommandResult(returncode=0, stdout="")),
            follow_runner=follow_runner,
        )

        stream = cli.tail_follow("wxid_1", cursor="local_id:41")
        item = stream.read(timeout=1)

        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(item.cursor, "local_id:42")
        self.assertEqual(item.local_id, 42)
        self.assertIsNotNone(item.event)
        assert item.event is not None
        self.assertEqual(item.event.text, "流式合成消息")
        self.assertIsNone(stream.read(timeout=0.01))
        self.assertFalse(stream.closed)
        stream.close()
        self.assertTrue(stream.closed)
        self.assertTrue(follow_runner.process.terminated)
        self.assertEqual(
            follow_runner.calls,
            [
                (
                    "wechat-cli",
                    "tail",
                    "wxid_1",
                    "--cursor",
                    "local_id:41",
                    "--include-media-paths",
                    "false",
                    "--follow",
                    "--jsonl",
                    "--strict-read-only",
                )
            ],
        )

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
        self.assertEqual(result.last_local_id, 42)
        self.assertEqual(len(result.events), 1)
        self.assertEqual(result.events[0].message_id.local_id, 42)
        self.assertEqual(result.events[0].message_id.talker, "wxid_1")
        self.assertEqual(result.events[0].text, "合成消息")
        self.assertFalse(result.events[0].is_from_me)
        self.assertEqual(result.events[0].kind, "text")
        self.assertTrue(result.freshness_confirmed)
        self.assertEqual(
            runner.calls[0],
            (
                "wechat-cli",
                "tail",
                "wxid_1",
                "--limit",
                "5",
                "--include-media-paths",
                "false",
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
        # 非文字事件不进规范消息，但水位仍然前移。
        self.assertEqual(result.last_local_id, 43)
        self.assertEqual(result.event_count, 1)
        self.assertEqual(result.non_text_count, 1)
        self.assertTrue(result.freshness_confirmed)

    def test_tail_pairs_cursor_with_maximum_local_id_when_output_is_unordered(self) -> None:
        def event(local_id: int, cursor: str) -> str:
            return json.dumps(
                {
                    "type": "message",
                    "cursor": cursor,
                    "message": {
                        "id": {"local_id": local_id, "talker": "wxid_1"},
                        "kind": "text",
                        "text": f"消息 {local_id}",
                        "is_from_me": False,
                    },
                },
                ensure_ascii=False,
            )

        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout="\n".join(
                    [
                        event(44, "local_id:44"),
                        event(43, "local_id:43"),
                    ]
                ),
            )
        )

        result = LocalWechatCli(runner=runner).tail("wxid_1")

        self.assertEqual(result.last_local_id, 44)
        self.assertEqual(result.cursor, "local_id:44")

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

    def test_sessions_preserves_named_candidates_when_another_name_is_blank(self) -> None:
        for display_name in ("", " \t\n\u3000"):
            with self.subTest(display_name=display_name):
                runner = RecordingRunner(FakeCommandResult(
                    returncode=0,
                    stdout=json.dumps({
                        "ok": True,
                        "data": {
                            "sessions": [
                                {
                                    "username": "wxid_unnamed",
                                    "display_name": display_name,
                                    "chat_type": "private",
                                },
                                {
                                    "username": "wxid_named",
                                    "display_name": "合成联系人",
                                    "chat_type": "private",
                                },
                            ],
                        },
                    }),
                ))

                sessions = LocalWechatCli(runner=runner).sessions(
                    type_filter="private", limit=5000,
                )

                self.assertEqual(
                    [(item.username, item.display_name) for item in sessions],
                    [
                        ("wxid_unnamed", "wxid_unnamed"),
                        ("wxid_named", "合成联系人"),
                    ],
                )

    def test_sessions_rejects_missing_or_non_string_display_names(self) -> None:
        for fields in (
            {},
            {"display_name": None},
            {"display_name": False},
            {"display_name": 42},
            {"display_name": []},
            {"display_name": {}},
        ):
            with self.subTest(fields=fields):
                candidate = {"username": "wxid_1", "chat_type": "private"}
                candidate.update(fields)
                runner = RecordingRunner(FakeCommandResult(
                    returncode=0,
                    stdout=json.dumps({
                        "ok": True, "data": {"sessions": [candidate]},
                    }),
                ))

                with self.assertRaises(CliOutputError) as raised:
                    LocalWechatCli(runner=runner).sessions()

                self.assertEqual(raised.exception.code, "cli_output_invalid")

    def test_sessions_requires_valid_username_before_name_fallback(self) -> None:
        for fields in (
            {},
            {"username": None},
            {"username": False},
            {"username": 42},
            {"username": []},
            {"username": {}},
            {"username": ""},
            {"username": " \t\u3000"},
        ):
            with self.subTest(fields=fields):
                candidate = {"display_name": "", "chat_type": "private"}
                candidate.update(fields)
                runner = RecordingRunner(FakeCommandResult(
                    returncode=0,
                    stdout=json.dumps({
                        "ok": True, "data": {"sessions": [candidate]},
                    }),
                ))

                with self.assertRaises(CliOutputError) as raised:
                    LocalWechatCli(runner=runner).sessions()

                self.assertEqual(raised.exception.code, "cli_output_invalid")

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
                "--include-media-paths",
                "false",
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

    def test_tail_without_new_events_returns_empty_result(self) -> None:
        runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=" \n\n"))

        result = LocalWechatCli(runner=runner).tail("wxid_1")

        # 轮询没有新消息是正常结果，不是输出损坏；水位保持不变。
        self.assertEqual(result.events, ())
        self.assertIsNone(result.cursor)
        self.assertIsNone(result.last_local_id)
        self.assertFalse(result.freshness_confirmed)

    def test_empty_cursor_is_rejected_before_command(self) -> None:
        runner = RecordingRunner(FakeCommandResult(returncode=0, stdout=""))

        with self.assertRaises(CliOutputError):
            LocalWechatCli(runner=runner).tail("wxid_1", cursor=" ")

        self.assertEqual(runner.calls, [])

    def test_cli_version_is_read_from_envelope(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "ok": True,
                        "tool": "version",
                        "command": "version",
                        "data": {"name": "wechat-cli", "version": "1.6.20"},
                    }
                ),
            )
        )

        version = LocalWechatCli(runner=runner).version()

        self.assertEqual(version, "1.6.20")
        self.assertEqual(runner.calls[0], ("wechat-cli", "--version"))

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

    def test_structured_invalid_argument_error_keeps_a_safe_specific_code(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=1,
                stdout=json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "code": "invalid_argument",
                            "message": "internal command details",
                        },
                    }
                ),
            )
        )

        with self.assertRaises(CliCommandError) as raised:
            LocalWechatCli(runner=runner).tail("wxid_1", since_time="bad")

        self.assertEqual(raised.exception.code, "cli_invalid_argument")
        self.assertNotIn("internal command details", str(raised.exception))

    def test_missing_key_error_is_reported_as_refresh_required(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=1,
                stdout=json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "code": "tool_error",
                            "message": (
                                "strict_read_only: automatic key refresh is disabled "
                                "(no enc_key; refresh wxkey key map)"
                            ),
                        },
                    }
                ),
            )
        )

        with self.assertRaises(CliCommandError) as raised:
            LocalWechatCli(runner=runner).tail("wxid_1", since_time="2026-09-01")

        self.assertEqual(raised.exception.code, "cli_key_refresh_required")
        self.assertNotIn("enc_key", str(raised.exception))

    def test_missing_message_table_reports_coverage_unavailable_safely(self) -> None:
        runner = RecordingRunner(
            FakeCommandResult(
                returncode=1,
                stdout=json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "code": "tool_error",
                            "message": (
                                "table Msg_synthetic_private not found "
                                "in 9 message shards"
                            ),
                        },
                    }
                ),
                stderr="synthetic private database path",
            )
        )

        with self.assertRaises(CliCommandError) as raised:
            LocalWechatCli(runner=runner).tail(
                "wxid_synthetic", since_time="2026-10-01T12:00:00"
            )

        self.assertEqual(raised.exception.code, "cli_message_table_missing")
        self.assertNotIn("Msg_synthetic_private", str(raised.exception))
        self.assertNotIn("database path", str(raised.exception))

    def test_only_known_message_shard_errors_receive_missing_table_code(self) -> None:
        cases = (
            (
                "tool_error",
                "table Msg_synthetic not found in opened message shards",
                "cli_message_table_missing",
            ),
            ("tool_error", "table contacts not found", "cli_command_failed"),
            (
                "tool_error",
                "failed: table Msg_synthetic not found in 9 message shards",
                "cli_command_failed",
            ),
            (
                "unknown_error",
                "table Msg_synthetic not found in 9 message shards",
                "cli_command_failed",
            ),
        )
        for code, message, expected in cases:
            with self.subTest(code=code, message=message):
                runner = RecordingRunner(
                    FakeCommandResult(
                        returncode=1,
                        stdout=json.dumps(
                            {"ok": False, "error": {"code": code, "message": message}}
                        ),
                    )
                )
                with self.assertRaises(CliCommandError) as raised:
                    LocalWechatCli(runner=runner).tail("wxid_synthetic")
                self.assertEqual(raised.exception.code, expected)
                self.assertNotIn("Msg_synthetic", str(raised.exception))
