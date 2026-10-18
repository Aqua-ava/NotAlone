"""真实验收的 CLI 接缝只使用合成进程结果验证读取边界。"""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import unittest
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID
from unittest.mock import patch

from notalone.wechat_cli import CliCommandError
from notalone.conversation.matcher import FrontSessionEvidence
from notalone.front_sync.probe_adapter import FrontSessionProbeObservation, FrontSessionQuality


FIXTURE_PATH = (Path(__file__).resolve().parents[4]
                / "desktop/tests/fixtures/real-sync-python.py")
SPEC = importlib.util.spec_from_file_location("acceptance_scope_fixture", FIXTURE_PATH)
assert SPEC is not None and SPEC.loader is not None
fixture = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = fixture
SPEC.loader.exec_module(fixture)


@dataclass(frozen=True)
class FakeResult:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


class SyntheticRunner:
    def __init__(self, result: FakeResult) -> None:
        self.result = result
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, command: tuple[str, ...]) -> FakeResult:
        self.calls.append(command)
        return self.result


class SyntheticProcess:
    def __init__(self, *, follow: bool = False) -> None:
        self.pid = 987654
        self.returncode: int | None = None
        self.stdout = io.StringIO(json.dumps({
            "type": "session", "cursor": "synthetic-session:1",
            "session": {"username": "synthetic-selected"},
        }) + "\n" if follow else "")
        self.terminated = False
        self.stopped = threading.Event()

    def poll(self) -> int | None:
        return self.returncode

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        self.returncode = 0
        return json.dumps({"ok": True, "data": {"version": "synthetic-1"}}), ""

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15
        self.stopped.set()

    def kill(self) -> None:
        self.returncode = -9
        self.stopped.set()

    def wait(self, timeout: float | None = None) -> int:
        assert self.returncode is not None
        return self.returncode


class AcceptanceScopeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = fixture.AcceptanceScope(
            locator="synthetic-selected",
            real_cli=Path("/synthetic/wechat-cli"),
            real_wcdb=Path("/synthetic/libWCDB.dylib"),
            sandbox_profile=Path("/synthetic/readonly.sb"),
            audit_path=Path("/synthetic/audit.jsonl"),
            pid_audit_path=Path("/synthetic/pids.jsonl"),
            approved_texts=("合成验收文字",),
            not_before=1791782400.25,
            until=1791783000.0,
        )

    def test_other_conversation_is_rejected_before_cli_execution(self) -> None:
        runner = SyntheticRunner(FakeResult())
        cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        with self.assertRaises(CliCommandError) as raised:
            cli.tail("synthetic-unselected", since_time="2026-10-12T13:20:01")
        self.assertEqual(raised.exception.code, "acceptance_scope_exceeded")
        self.assertEqual(runner.calls, [])

    def test_selected_self_text_can_advance_only_its_observed_cursor(self) -> None:
        runner = SyntheticRunner(FakeResult(stdout=json.dumps({
            "type": "message", "cursor": "synthetic-cursor:12",
            "message": {"id": {"talker": "synthetic-selected", "local_id": 12},
                        "kind": "text", "text": "合成验收文字", "is_from_me": True,
                        "create_time": 1791782460},
        })))
        cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        initial = cli.tail("synthetic-selected", since_time="2026-10-12T13:20:01")
        repeated = cli.tail("synthetic-selected", cursor=initial.cursor)
        self.assertEqual(repeated.events[0].text, "合成验收文字")
        self.assertEqual(len(runner.calls), 2)
        with self.assertRaises(CliCommandError):
            cli.tail("synthetic-selected", cursor="unobserved-cursor")
        self.assertEqual(len(runner.calls), 2)

    def test_scope_rejects_request_past_the_acceptance_end(self) -> None:
        runner = SyntheticRunner(FakeResult())
        cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        with self.assertRaises(CliCommandError):
            cli.tail("synthetic-selected", since_time="2026-10-12T16:00:00")
        self.assertEqual(runner.calls, [])

    def test_short_explicit_renewal_keeps_since_and_content_boundaries(self) -> None:
        end = self.scope.not_before + 7200
        scope = replace(self.scope, until=end, long_running=True,
                        execution_not_before=end - 600, execution_until=end)
        event = {"type": "message", "cursor": "synthetic-cursor:12", "message": {
            "id": {"talker": "synthetic-selected", "local_id": 12}, "kind": "text",
            "text": "合成验收文字", "is_from_me": True, "create_time": 1791782460,
        }}
        runner = SyntheticRunner(FakeResult(stdout=json.dumps(event)))
        now = [end - 300]
        cli = fixture.build_scoped_cli(scope, runner=runner, clock=lambda: now[0])
        result = cli.tail("synthetic-selected", since_time="2026-10-12T13:20:01")
        self.assertEqual(len(result.events), 1)
        self.assertIn("2026-10-12T13:20:01", runner.calls[0])
        for change in ({"create_time": end}, {"create_time": 1791782400},
                       {"text": "未授权文字"}, {"is_from_me": False}, {"kind": "image"}):
            with self.subTest(change=change):
                runner.result = FakeResult(stdout=json.dumps(
                    {**event, "message": {**event["message"], **change}}))
                with self.assertRaises(CliCommandError):
                    cli.tail("synthetic-selected", since_time="2026-10-12T13:20:01")
        count = len(runner.calls)
        for timestamp in (end - 601, end):
            now[0] = timestamp
            with self.assertRaises(CliCommandError) as raised:
                cli.version()
            self.assertEqual(raised.exception.code, "acceptance_window_expired")
        self.assertEqual(len(runner.calls), count)
        now[0] = end - 300
        with self.assertRaises(CliCommandError):
            cli.tail("synthetic-unselected", since_time="2026-10-12T13:20:01")
        self.assertEqual(len(runner.calls), count)

    def test_explicit_incoming_test_text_keeps_the_actual_direction(self) -> None:
        runner = SyntheticRunner(FakeResult(stdout=json.dumps({
            "type": "message", "cursor": "synthetic-cursor:12",
            "message": {"id": {"talker": "synthetic-selected", "local_id": 12},
                        "kind": "text", "text": "合成验收文字", "is_from_me": False,
                        "create_time": 1791782460},
        })))
        scope = replace(self.scope, allow_incoming_test_text=True)
        cli = fixture.build_scoped_cli(scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        result = cli.tail("synthetic-selected", since_time="2026-10-12T13:20:01")
        self.assertFalse(result.events[0].is_from_me)
        self.assertEqual(result.events[0].text, "合成验收文字")

        invalid = json.loads(runner.result.stdout)
        invalid["message"]["text"] = "未约定来信"
        runner.result = FakeResult(stdout=json.dumps(invalid))
        with self.assertRaises(CliCommandError):
            cli.tail("synthetic-selected", cursor=result.cursor)

    def test_session_listing_is_explicitly_blocked_without_reading(self) -> None:
        runner = SyntheticRunner(FakeResult())
        cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        with self.assertRaises(CliCommandError) as raised:
            cli.sessions()
        self.assertEqual(raised.exception.code, "acceptance_session_listing_blocked")
        self.assertEqual(runner.calls, [])

    def test_foreground_metadata_preserves_same_name_candidates_without_previews(self) -> None:
        runner = SyntheticRunner(FakeResult(stdout=json.dumps({
            "ok": True, "data": {"sessions": [
                {"username": "synthetic-selected", "display_name": "合成测试名",
                 "chat_type": "private", "summary": "合成不应转交的预览",
                 "last_sender_display_name": "合成不应转交的发送者"},
                {"username": "synthetic-other", "display_name": "合成测试名",
                 "chat_type": "group", "summary": "另一份合成预览"},
            ]},
        })))
        cli = fixture.build_scoped_cli(replace(self.scope, metadata_name="合成测试名"),
                                       runner=runner, clock=lambda: 1791782460.0)
        candidates = cli.sessions(keyword="合成测试名", type_filter="all", limit=51,
                                  timeout_seconds=0.25)
        self.assertEqual([(item.username, item.chat_type) for item in candidates],
                         [("synthetic-selected", "private"), ("synthetic-other", "group")])
        self.assertTrue(all(item.summary is None and item.last_sender_display_name is None
                            for item in candidates))
        self.assertEqual(len(runner.calls), 1)
        from notalone.front_sync.foreground_locator import ForegroundLocator
        locator = ForegroundLocator(owner_id=UUID("00000000-0000-4000-8000-000000000001"),
            channel="wechat", account_scope="synthetic-account", cli=cli,
            probe=SimpleNamespace(observe_fresh=lambda **kwargs: FrontSessionProbeObservation(
                wechat_in_front=True, evidence=FrontSessionEvidence(display_name="合成测试名"),
                selected_row_name="合成测试名", quality=FrontSessionQuality("automatic-window-v2", 1, 1),
                captured_at=datetime.now(timezone.utc))),
            bindings=SimpleNamespace(list_active_bindings=lambda **kwargs: self.fail("歧义不应读取绑定目录")))
        import time
        result = locator.observe_fresh(enabled=True, deadline=time.monotonic() + 1.3)
        self.assertEqual(result.reason, "group_chat_suspected")
        self.assertEqual(result.phase, "paused")
        self.assertIsNone(result.contact_id)

    def test_foreground_metadata_does_not_authorize_other_keywords_or_wide_lists(self) -> None:
        runner = SyntheticRunner(FakeResult())
        cli = fixture.build_scoped_cli(replace(self.scope, metadata_name="合成测试名"),
                                       runner=runner, clock=lambda: 1791782460.0)
        for operation in (lambda: cli.sessions(type_filter="private", limit=5000),
                          lambda: cli.sessions(keyword="其它合成名", type_filter="all", limit=51),
                          lambda: cli.sessions(keyword="合成测试名", type_filter="private", limit=51),
                          lambda: cli.sessions(keyword="合成测试名", type_filter="all", limit=50),
                          lambda: cli.resolve_chat("其它合成名"),
                          lambda: cli.tail("synthetic-other", since_time="2026-10-12T13:20:01")):
            with self.subTest(operation=operation), self.assertRaises(CliCommandError):
                operation()
        self.assertEqual(runner.calls, [])

    def test_foreground_resolver_keeps_all_types_without_preview_text(self) -> None:
        runner = SyntheticRunner(FakeResult(stdout=json.dumps({"ok": True, "data": {"candidates": [
            {"username": "synthetic-selected", "display_name": "合成测试名", "chat_type": "private", "summary": "合成预览"},
            {"username": "synthetic-duplicate", "display_name": "合成测试名", "chat_type": "group", "last_sender_display_name": "合成发送者"},
        ]}})))
        cli = fixture.build_scoped_cli(replace(self.scope, metadata_name="合成测试名"),
                                       runner=runner, clock=lambda: 1791782460.0)
        result = cli.resolve_chat("合成测试名")
        self.assertEqual([item.chat_type for item in result.candidates], ["private", "group"])
        self.assertTrue(all(item.summary is None and item.last_sender_display_name is None for item in result.candidates))
        self.assertEqual(len(runner.calls), 1)

    def test_foreground_target_requires_private_original_scope_and_unchanged_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            scope_path = directory / "scope.json"
            scope_path.write_text('{"synthetic":"scope"}')
            scope_path.chmod(0o600)
            target_path = directory / "target.json"
            value = {"schemaVersion": 1, "purpose": "real-foreground-locator-acceptance", "scopePath": str(scope_path),
                "scopeSha256": fixture.hashlib.sha256(scope_path.read_bytes()).hexdigest(), "displayName": "合成测试名",
                "probePath": "/synthetic/Resources/notalone-sync-probe", "profilePath": str(directory / "profile.json")}
            target_path.write_text(json.dumps(value))
            target_path.chmod(0o600)
            environment = {"NOTALONE_REAL_FOREGROUND_MODE": "1", "NOTALONE_REAL_FOREGROUND_TARGET": str(target_path),
                "NOTALONE_REAL_SYNC_SCOPE": str(scope_path),
                "NOTALONE_REAL_FOREGROUND_TARGET_SHA256": fixture.hashlib.sha256(target_path.read_bytes()).hexdigest()}
            with patch.dict(fixture.os.environ, environment, clear=True):
                self.assertEqual(fixture.load_foreground_target()["displayName"], "合成测试名")
                target_path.write_text(json.dumps({**value, "displayName": "未认可合成名"}))
                with self.assertRaises(CliCommandError):
                    fixture.load_foreground_target()
                target_path.write_text(json.dumps(value))
                scope_path.write_text('{"synthetic":"changed"}')
                with self.assertRaises(CliCommandError):
                    fixture.load_foreground_target()
            with patch.dict(fixture.os.environ, {"NOTALONE_REAL_FOREGROUND_MODE": "0"}, clear=True):
                self.assertIsNone(fixture.load_foreground_target())

    def test_foreground_metadata_timeout_reaps_only_its_owned_query(self) -> None:
        class SlowMetadata(SyntheticProcess):
            timeouts: list[float | None] = []

            def communicate(self, timeout: float | None = None) -> tuple[str, str]:
                self.timeouts.append(timeout)
                if self.returncode is not None:
                    return "", ""
                if timeout is not None and timeout <= 0.25:
                    raise subprocess.TimeoutExpired("synthetic-metadata", timeout)
                self.returncode = 0
                return json.dumps({"ok": True, "data": {"sessions": []}}), ""

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            scope = replace(self.scope, metadata_name="合成测试名",
                            audit_path=directory / "audit.jsonl",
                            pid_audit_path=directory / "pids.jsonl")
            owned = SlowMetadata()
            cli = fixture.build_scoped_cli(scope, process_factory=lambda *args, **kwargs: owned,
                                           clock=lambda: 1791782460.0)
            try:
                with self.assertRaises(CliCommandError) as raised:
                    cli.sessions(keyword="合成测试名", type_filter="all", limit=51,
                                 timeout_seconds=0.25)
                self.assertEqual(raised.exception.code, "acceptance_cli_timeout")
                self.assertLessEqual(owned.timeouts[0], 0.25)
                self.assertEqual(owned.returncode, -9)
                events = [json.loads(line) for line in scope.audit_path.read_text().splitlines()]
                self.assertEqual(events[-1]["event"], "finished")
                self.assertEqual(events[-1]["kind"], "foreground_metadata")
                self.assertEqual(events[-1]["returncode"], -9)
                self.assertFalse(any(key in item for item in events
                                     for key in ("argv", "summary", "display_name", "locator")))
            finally:
                cli.close()

    def test_foreground_metadata_completed_after_monotonic_deadline_is_rejected(self) -> None:
        now = [0.0]

        class LateMetadata(SyntheticProcess):
            def communicate(self, timeout: float | None = None) -> tuple[str, str]:
                now[0] = 0.26
                self.returncode = 0
                return json.dumps({"ok": True, "data": {"sessions": []}}), ""

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            scope = replace(self.scope, metadata_name="合成测试名", audit_path=directory / "audit.jsonl",
                            pid_audit_path=directory / "pids.jsonl")
            cli = fixture.build_scoped_cli(scope, process_factory=lambda *args, **kwargs: LateMetadata(),
                                           clock=lambda: 1791782460.0)
            try:
                with patch.object(fixture.time, "monotonic", side_effect=lambda: now[0]), self.assertRaises(CliCommandError) as raised:
                    cli.sessions(keyword="合成测试名", type_filter="all", limit=51, timeout_seconds=0.25)
                self.assertEqual(raised.exception.code, "acceptance_cli_timeout")
            finally:
                cli.close()

    def test_empty_jsonl_without_live_source_proof_is_rejected(self) -> None:
        runner = SyntheticRunner(FakeResult(stdout=""))
        cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        with self.assertRaises(CliCommandError) as raised:
            cli.tail("synthetic-selected", since_time="2026-10-12T13:20:01")
        self.assertEqual(raised.exception.code, "acceptance_source_unverified")

    def test_verified_live_empty_envelope_is_a_completed_read(self) -> None:
        runner = SyntheticRunner(FakeResult(stdout=json.dumps({
            "ok": True, "data": {"events": [],
                "freshness": {"message_source": "live_message_db"},
                "query": {"chat": "synthetic-selected", "has_more": False}},
        })))
        cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        result = cli.tail("synthetic-selected", since_time="2026-10-12T13:20:01")
        self.assertTrue(result.freshness_confirmed)
        self.assertEqual(result.events, ())

    def test_failed_audit_reservation_prevents_process_creation(self) -> None:
        processes: list[tuple[str, ...]] = []
        cli = fixture.build_scoped_cli(
            self.scope, process_factory=lambda command, **kwargs: processes.append(command),
            clock=lambda: 1791782460.0,
        )
        with self.assertRaises(CliCommandError) as raised:
            cli.version()
        self.assertEqual(raised.exception.code, "acceptance_private_file_invalid")
        self.assertEqual(processes, [])

    def test_unsafe_commands_and_expired_window_never_reach_runner(self) -> None:
        runner = SyntheticRunner(FakeResult())
        cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                       clock=lambda: 1791782460.0)
        for operation in (lambda: cli.tail("synthetic-selected"),
                          lambda: cli.tail("synthetic-selected", since_time="2026-10-12T13:20:00"),
                          lambda: cli.resolve_chat("合成标题"),
                          lambda: cli.sessions(),
                          lambda: cli.tail_follow("synthetic-selected")):
            with self.subTest(operation=operation):
                with self.assertRaises(CliCommandError):
                    operation()
        expired = fixture.build_scoped_cli(self.scope, runner=runner,
                                           clock=lambda: 1791783000.0)
        with self.assertRaises(CliCommandError) as raised:
            expired.version()
        self.assertEqual(raised.exception.code, "acceptance_window_expired")
        self.assertEqual(runner.calls, [])

    def test_out_of_scope_text_direction_media_or_time_rejects_entire_batch(self) -> None:
        valid = {"type": "message", "cursor": "synthetic-cursor:12", "message": {
            "id": {"talker": "synthetic-selected", "local_id": 12}, "kind": "text",
            "text": "合成验收文字", "is_from_me": True, "create_time": 1791782460,
        }}
        changes = ({"text": "未授权的合成文字"}, {"is_from_me": False}, {"kind": "image"},
                   {"create_time": 1791782400}, {"create_time": None})
        for change in changes:
            with self.subTest(change=change):
                invalid = {**valid, "cursor": "synthetic-cursor:13",
                           "message": {**valid["message"], **change}}
                runner = SyntheticRunner(FakeResult(stdout="\n".join(
                    json.dumps(item) for item in (valid, invalid))))
                cli = fixture.build_scoped_cli(self.scope, runner=runner,
                                               clock=lambda: 1791782460.0)
                with self.assertRaises(CliCommandError) as raised:
                    cli.tail("synthetic-selected", since_time="2026-10-12T13:20:01")
                self.assertEqual(raised.exception.code, "acceptance_scope_exceeded")
                self.assertNotIn("合成文字", str(raised.exception))
                with self.assertRaises(CliCommandError):
                    cli.tail("synthetic-selected", cursor="synthetic-cursor:12")
                self.assertEqual(len(runner.calls), 1)

    def test_follow_accepts_only_fixed_metadata_parameters_and_is_reaped_on_close(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            scope = replace(self.scope, audit_path=directory / "audit.jsonl",
                            pid_audit_path=directory / "pids.jsonl")
            created: list[SyntheticProcess] = []

            def spawn(command: tuple[str, ...], **kwargs: object) -> SyntheticProcess:
                process = SyntheticProcess(follow=True)
                created.append(process)
                self.assertEqual(command[:3], ("/usr/bin/sandbox-exec", "-f", "/synthetic/readonly.sb"))
                self.assertEqual(set(kwargs["env"]) - {"HOME", "USER", "LOGNAME", "TMPDIR"},
                                 {"PATH", "TZ", "WECHAT_CLI_WCDB_LIB"})
                return process

            cli = fixture.build_scoped_cli(scope, process_factory=spawn,
                                           clock=lambda: 1791782460.0)
            with self.assertRaises(CliCommandError):
                cli.session_events_follow(scan_limit=1)
            self.assertEqual(created, [])
            stream = cli.session_events_follow()
            event = stream.read(timeout=1)
            self.assertEqual(event.conversation_locator, "synthetic-selected")
            cli.close()
            self.assertTrue(created[0].terminated)
            records = [json.loads(line) for line in scope.audit_path.read_text().splitlines()]
            self.assertEqual([(item["event"], item.get("status")) for item in records],
                             [("scope_rejected", "rejected"), ("started", "reserved"),
                              ("started", "running"), ("finished", "exited")])
            self.assertFalse(any(key in item for item in records
                                 for key in ("argv", "cursor", "locator", "text", "token")))

    def test_load_scope_rejects_symlinks_and_public_read_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            paths = {key: directory / name for key, name in {
                "real_cli": "wechat-cli", "real_wcdb": "libWCDB.dylib",
                "sandbox_profile": "readonly.sb", "audit_path": "audit.jsonl",
                "pid_audit_path": "pids.jsonl",
            }.items()}
            for key in ("real_cli", "real_wcdb", "sandbox_profile"):
                paths[key].write_text("合成资料")
                paths[key].chmod(0o755 if key == "real_cli" else 0o600)
            value = {**{key: str(path) for key, path in paths.items()},
                     "locator": "synthetic-selected", "approved_texts": ["合成验收文字"],
                     "not_before": 1791782400.25, "until": 1791783000.0}
            selected = directory / "scope.json"
            selected.write_text(json.dumps(value))
            selected.chmod(0o600)
            self.assertEqual(fixture.load_scope(selected).locator, "synthetic-selected")
            extended = {**value, "until": value["not_before"] + 4500,
                        "long_running": True, "allow_incoming_test_text": True}
            selected.write_text(json.dumps(extended))
            loaded = fixture.load_scope(selected)
            self.assertTrue(loaded.long_running)
            self.assertTrue(loaded.allow_incoming_test_text)
            for invalid in ({**extended, "long_running": False},
                            {**extended, "until": extended["until"] + 1},
                            {**extended, "long_running": 1},
                            {**extended, "allow_incoming_test_text": "true"}):
                selected.write_text(json.dumps(invalid))
                with self.assertRaises(CliCommandError):
                    fixture.load_scope(selected)
            end = value["not_before"] + 7200
            renewed = {**extended, "until": end, "execution_not_before": end - 600,
                       "execution_until": end}
            selected.write_text(json.dumps(renewed))
            loaded = fixture.load_scope(selected)
            self.assertEqual(loaded.execution_not_before, end - 600)
            self.assertEqual(loaded.execution_until, loaded.until)
            invalid_renewals = [
                {key: item for key, item in renewed.items() if key != missing}
                for missing in ("execution_not_before", "execution_until")
            ] + [
                {**renewed, **change} for change in (
                    {"execution_not_before": end - 601},
                    {"execution_not_before": end},
                    {"execution_not_before": True},
                    {"execution_not_before": None},
                    {"execution_not_before": float("nan")},
                    {"execution_not_before": 10**1000},
                    {"execution_until": 10**1000},
                    {"execution_until": float("inf")},
                    {"execution_until": end - 1},
                    {"until": end + 1, "execution_until": end + 1,
                     "execution_not_before": end - 599},
                    {"long_running": False},
                    {"not_before": end - 599},
                )
            ]
            for invalid in invalid_renewals:
                with self.subTest(invalid_fields=set(invalid)):
                    selected.write_text(json.dumps(invalid))
                    with self.assertRaises(CliCommandError):
                        fixture.load_scope(selected)
            selected.write_text(json.dumps(value))
            link = directory / "scope-link.json"
            link.symlink_to(selected)
            with self.assertRaises(CliCommandError):
                fixture.load_scope(link)
            selected.chmod(0o644)
            with self.assertRaises(CliCommandError):
                fixture.load_scope(selected)

    def test_running_child_is_reaped_when_its_start_audit_cannot_append(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            scope = replace(self.scope, audit_path=directory / "audit.jsonl",
                            pid_audit_path=directory / "pids.jsonl")
            private_target = directory / "untouched.jsonl"
            private_target.write_text("合成保留文字")
            private_target.chmod(0o600)
            created: list[SyntheticProcess] = []

            def spawn(command: tuple[str, ...], **kwargs: object) -> SyntheticProcess:
                process = SyntheticProcess()
                created.append(process)
                scope.audit_path.unlink()
                scope.audit_path.symlink_to(private_target)
                return process

            cli = fixture.build_scoped_cli(scope, process_factory=spawn,
                                           clock=lambda: 1791782460.0)
            with self.assertRaises(CliCommandError):
                cli.version()
            self.assertTrue(created[0].terminated)
            self.assertEqual(private_target.read_text(), "合成保留文字")
            with self.assertRaises(CliCommandError):
                cli.version()
            self.assertEqual(len(created), 1)

    def test_deadline_terminates_owned_metadata_stream_without_another_product_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            scope = replace(self.scope, audit_path=directory / "audit.jsonl",
                            pid_audit_path=directory / "pids.jsonl")
            process = SyntheticProcess(follow=True)
            now = [1791782460.0]
            cli = fixture.build_scoped_cli(
                scope, process_factory=lambda command, **kwargs: process,
                clock=lambda: now[0],
            )
            cli.session_events_follow()
            now[0] = 1791783000.0
            self.assertTrue(process.stopped.wait(timeout=1))
            cli.close()
            records = [json.loads(line) for line in scope.audit_path.read_text().splitlines()]
            self.assertEqual(records[-1]["event"], "finished")
            self.assertEqual(records[-1]["returncode"], -15)

    def test_renewed_deadline_stops_owned_stream_and_prevents_new_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            end = self.scope.not_before + 7200
            scope = replace(self.scope, until=end, long_running=True,
                            execution_not_before=end - 600, execution_until=end,
                            audit_path=directory / "audit.jsonl",
                            pid_audit_path=directory / "pids.jsonl")
            created: list[SyntheticProcess] = []

            def spawn(command: tuple[str, ...], **kwargs: object) -> SyntheticProcess:
                process = SyntheticProcess(follow=True)
                created.append(process)
                return process

            now = [end - 300]
            cli = fixture.build_scoped_cli(scope, process_factory=spawn, clock=lambda: now[0])
            cli.session_events_follow()
            now[0] = end
            self.assertTrue(created[0].stopped.wait(timeout=1))
            with self.assertRaises(CliCommandError):
                cli.version()
            self.assertEqual(len(created), 1)
            cli.close()


if __name__ == "__main__":
    unittest.main()
