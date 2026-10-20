"""以合成子进程验证原生 worker 的有界传输与停机，不读取桌面。"""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from time import monotonic
import unittest
from unittest.mock import patch

from notalone.front_sync.probe_adapter import MacosFrontSessionProbe, ProbeAdapterError


_CHILD = r'''import json, os, select, sys
from pathlib import Path
mode = {mode!r}
marker = Path({marker!r})
prior_start = marker.exists()
marker.write_text(str(os.getpid()))
if mode == "bad_ready":
    print(json.dumps({{"version":1,"event":"ready","extra":True}}), flush=True)
elif mode == "oversized_ready":
    print("x" * 65536, flush=True)
elif mode == "stalled_ready":
    select.select([], [], [], 10)
else:
    print(json.dumps({{"version":1,"event":"ready"}}), flush=True)
last_id = None
for line in sys.stdin:
    request = json.loads(line)
    assert set(request) == {{"version", "request_id", "operation"}}
    assert type(request["version"]) is int and request["version"] == 1
    assert request["operation"] == "observe"
    from uuid import UUID
    assert str(UUID(request["request_id"])) == request["request_id"]
    with marker.with_suffix(".requests").open("a") as requests:
        requests.write(request["request_id"] + "\n")
    if mode == "timeout_once" and not prior_start and last_id:
        select.select([], [], [], 10)
    if mode == "inflight":
        marker.with_suffix(".request").write_text("started")
        select.select([], [], [], 10)
    payload = {{"version":1,"request_id":request["request_id"],
               "result":{{"ok":True,"wechat_in_front":False}}}}
    if mode.startswith("header"):
        payload["result"] = {{"ok":True,"wechat_in_front":True,
            "display_name":("合成测试(8)" if mode == "header_group" else "合成测试"),
            "capture_version":"automatic-header-v3",
            "captured_at":"2026-10-19T10:00:00Z",
            "quality":{{"layout_verified":True,"display_name_confidence":1.0,"name_complete":True}}}}
    if mode == "old_id" and last_id:
        payload["request_id"] = last_id
    if mode == "version": payload["version"] = True
    if mode == "float_version": payload["version"] = 1.0
    if mode == "nan": payload["result"]["extra"] = float("nan")
    if mode == "extra_line":
        print(json.dumps(payload) + "\n{{}}", flush=True)
        continue
    if mode == "stderr":
        os.write(2, b"x" * 262144)
    if mode == "nested":
        print('[' * 2048 + '0' + ']' * 2048, flush=True)
        continue
    if mode == "duplicate":
        print('{{"version":1,"version":1,"request_id":"' + request["request_id"] + '","result":{{}}}}', flush=True)
        continue
    if mode == "utf8":
        os.write(1, bytes([255,10]))
        continue
    if mode == "unknown": payload["extra"] = "合成保密标记"
    if mode == "invalid":
        print("not-json-合成保密标记", flush=True)
        continue
    if mode == "oversized":
        print("x" * 65536, flush=True)
        continue
    if mode == "partial":
        sys.stdout.write('{{"version":1')
        sys.stdout.flush()
        sys.exit(0)
    if mode == "permission":
        payload["result"] = {{"ok":False,"error":"screen_capture_permission_missing"}}
    if mode == "invalid_result":
        payload["result"] = {{"ok":True,"wechat_in_front":"合成保密标记"}}
    print(json.dumps(payload), flush=True)
    last_id = request["request_id"]
    if mode == "idle_exit":
        sys.exit(0)
'''


class SessionWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.processes: list[subprocess.Popen] = []
        real_popen = subprocess.Popen

        def spawn(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            self.processes.append(process)
            return process

        self.popen = patch("subprocess.Popen", side_effect=spawn)
        self.popen.start()
        self.addCleanup(self.popen.stop)
        self.addCleanup(self._clean_processes)

    def _clean_processes(self) -> None:
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=1)

    def _probe(self, mode: str = "normal") -> MacosFrontSessionProbe:
        executable = self.root / "synthetic-worker"
        executable.write_text("#!" + sys.executable + " -S\n" + _CHILD.format(
            mode=mode, marker=str(self.root / "pid"),
        ))
        executable.chmod(0o700)
        probe = MacosFrontSessionProbe(executable=str(executable))
        self.addCleanup(probe.close)
        return probe

    def test_fresh_requests_reuse_one_pid_and_legacy_command_stays_separate(self) -> None:
        probe = self._probe()
        self.assertFalse(probe.observe_fresh(timeout_seconds=1).wechat_in_front)
        first_pid = self.processes[0].pid
        self.assertFalse(probe.observe_fresh(timeout_seconds=1).wechat_in_front)
        self.assertEqual([p.pid for p in self.processes], [first_pid])
        request_ids = (self.root / "pid.requests").read_text().splitlines()
        self.assertEqual(len(request_ids), 2)
        self.assertNotEqual(*request_ids)
        command = self.processes[0].args
        self.assertEqual(command[1:], ("--session-worker", "--json"))
        probe.close()
        self.assertIsNotNone(self.processes[0].poll())
        probe.close()

    def test_close_allows_later_explicit_observation_after_reenable(self) -> None:
        probe = self._probe()
        probe.observe_fresh(timeout_seconds=1)
        probe.close()
        self.assertIsNotNone(self.processes[0].poll())
        self.assertFalse(probe.observe_fresh(timeout_seconds=1).wechat_in_front)
        self.assertEqual(len(self.processes), 2)

    def test_previous_request_id_cannot_satisfy_new_observation(self) -> None:
        probe = self._probe("old_id")
        probe.observe_fresh(timeout_seconds=1)
        with self.assertRaises(ProbeAdapterError) as caught:
            probe.observe_fresh(timeout_seconds=1)
        self.assertEqual(caught.exception.code, "probe_output_invalid")
        self.assertIsNotNone(self.processes[0].poll())
        self.assertEqual(len(self.processes), 1)

    def test_timeout_kills_worker_and_next_round_creates_fresh_process(self) -> None:
        probe = self._probe("timeout_once")
        probe.observe_fresh(timeout_seconds=1)
        with self.assertRaises(ProbeAdapterError) as caught:
            probe.observe_fresh(timeout_seconds=0.12)
        self.assertEqual(caught.exception.code, "probe_timeout")
        self.assertIsNotNone(self.processes[0].poll())
        self.assertFalse(probe.observe_fresh(timeout_seconds=1).wechat_in_front)
        self.assertEqual(len(self.processes), 2)

    def test_idle_exit_is_restarted_before_next_request(self) -> None:
        probe = self._probe("idle_exit")
        probe.observe_fresh(timeout_seconds=1)
        self.processes[0].wait(timeout=1)
        self.assertFalse(probe.observe_fresh(timeout_seconds=1).wechat_in_front)
        self.assertEqual(len(self.processes), 2)

    def test_bad_protocol_is_bounded_and_failure_does_not_echo_output(self) -> None:
        for mode in ("version", "float_version", "unknown", "invalid", "oversized", "partial", "invalid_result",
                     "bad_ready", "oversized_ready", "duplicate", "nested", "utf8", "nan", "extra_line"):
            with self.subTest(mode=mode):
                before = len(self.processes)
                probe = self._probe(mode)
                with self.assertRaises(ProbeAdapterError) as caught:
                    probe.observe_fresh(timeout_seconds=1)
                self.assertIn(caught.exception.code, ("probe_output_invalid", "probe_failed"))
                self.assertNotIn("合成保密标记", str(caught.exception))
                self.assertEqual(len(self.processes), before + 1)
                self.assertIsNotNone(self.processes[-1].poll())

    def test_permission_failure_stops_worker_and_gate_blocks_next_start(self) -> None:
        probe = self._probe("permission")
        for _ in range(2):
            with self.assertRaises(ProbeAdapterError) as caught:
                probe.observe_fresh(timeout_seconds=1)
            self.assertEqual(caught.exception.code, "screen_capture_permission_missing")
        self.assertEqual(len(self.processes), 1)
        self.assertIsNotNone(self.processes[0].poll())
        probe.reset_permission_gate()
        with self.assertRaises(ProbeAdapterError):
            probe.observe_fresh(timeout_seconds=1)
        self.assertEqual(len(self.processes), 2)

    def test_close_interrupts_inflight_request_without_waiting_for_request_lock(self) -> None:
        probe = self._probe("inflight")
        errors: list[Exception] = []
        def observe() -> None:
            try:
                probe.observe_fresh(timeout_seconds=2)
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=observe)
        thread.start()
        request_marker = self.root / "pid.request"
        # 用有界事件等待管道请求就绪，不以固定长睡眠猜测状态。
        deadline = monotonic() + 1
        while not request_marker.exists() and monotonic() < deadline:
            threading.Event().wait(0.005)
        self.assertTrue(request_marker.exists())
        started = monotonic()
        probe.close()
        thread.join(timeout=0.5)
        self.assertLess(monotonic() - started, 0.5)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(errors[0], ProbeAdapterError)
        self.assertIsNotNone(self.processes[0].poll())

    def test_stderr_cannot_block_observation_or_leak_to_error_output(self) -> None:
        probe = self._probe("stderr")
        self.assertFalse(probe.observe_fresh(timeout_seconds=1).wechat_in_front)

    def test_ready_wait_and_lock_wait_are_charged_to_same_deadline(self) -> None:
        from notalone.front_sync.session_worker import NativeSessionWorker, SessionWorkerError

        worker = NativeSessionWorker("/synthetic/not-executed")
        worker._request_lock.acquire()
        self.addCleanup(worker._request_lock.release)
        started = monotonic()
        with self.assertRaises(SessionWorkerError) as caught:
            worker.observe(timeout_seconds=0.03)
        self.assertEqual(caught.exception.code, "probe_timeout")
        self.assertLess(monotonic() - started, 0.15)
        self.assertEqual(self.processes, [])
        probe = self._probe("stalled_ready")
        started = monotonic()
        with self.assertRaises(ProbeAdapterError) as caught:
            probe.observe_fresh(timeout_seconds=0.15)
        self.assertEqual(caught.exception.code, "probe_timeout")
        self.assertLess(monotonic() - started, 0.3)
        self.assertIsNotNone(self.processes[0].poll())

    def test_missing_executable_has_stable_code(self) -> None:
        probe = MacosFrontSessionProbe(executable=str(self.root / "absent"))
        with self.assertRaises(ProbeAdapterError) as caught:
            probe.observe_fresh(timeout_seconds=1)
        self.assertEqual(caught.exception.code, "probe_not_found")

    def test_locator_close_forwards_to_probe(self) -> None:
        from uuid import UUID
        from unittest.mock import Mock
        from notalone.front_sync.foreground_locator import ForegroundLocator

        probe = Mock()
        locator = ForegroundLocator(owner_id=UUID(int=1), channel="wechat", account_scope="test",
                                    probe=probe, cli=object(), bindings=object())
        locator.close()
        probe.close.assert_called_once_with()

    def test_wait_for_request_lock_does_not_reset_deadline(self) -> None:
        from notalone.front_sync.session_worker import NativeSessionWorker, SessionWorkerError

        worker = NativeSessionWorker("/synthetic/not-executed")
        clock = [10.0]
        class WaitingLock:
            def acquire(self, *, timeout):
                self.wait_budget = timeout
                clock[0] += 0.06
                return True
            def release(self):
                pass
        waiting = WaitingLock()
        worker._request_lock = waiting
        def ensure_process(*, generation, deadline):
            self.assertEqual(generation, 0)
            self.assertAlmostEqual(deadline - clock[0], 0.04)
            raise SessionWorkerError("probe_timeout")
        with patch("notalone.front_sync.session_worker.monotonic", side_effect=lambda: clock[0]), \
                patch.object(worker, "_ensure_process", side_effect=ensure_process):
            with self.assertRaises(SessionWorkerError):
                worker.observe(timeout_seconds=0.1)
        self.assertAlmostEqual(waiting.wait_budget, 0.1)

    def _locator(self, probe, *, sessions):
        from types import SimpleNamespace
        from tests.unit.front_sync.test_emoji_fallback import OWNER, binding
        from notalone.front_sync.foreground_locator import ForegroundLocator

        return ForegroundLocator(
            owner_id=OWNER, channel="wechat", account_scope="synthetic-account", probe=probe,
            cli=SimpleNamespace(sessions=sessions),
            bindings=SimpleNamespace(list_active_bindings=lambda **kwargs: (binding("合成测试"),)),
        )

    def test_cancel_after_native_success_reaps_worker_and_preserves_host_exception(self) -> None:
        from notalone.server.sync_host import SyncHostBusy

        for mode in ("normal", "header"):
            with self.subTest(mode=mode):
                probe = self._probe(mode)
                cancelled = [False]
                original = probe._worker.observe
                expected = SyncHostBusy("合成授权代际已变更")
                def native_result(**kwargs):
                    result = original(**kwargs)
                    cancelled[0] = True
                    return result
                def check_current():
                    if cancelled[0]:
                        raise expected
                def sessions(**kwargs):
                    self.fail("取消后的结果不应进入名单查询")
                locator = self._locator(probe, sessions=sessions)
                with patch.object(probe._worker, "observe", side_effect=native_result):
                    with self.assertRaises(SyncHostBusy) as caught:
                        locator.observe_fresh(enabled=True, deadline=monotonic() + 2,
                                              check_current=check_current)
                self.assertIs(caught.exception, expected)
                self.assertIsNotNone(self.processes[-1].poll())

    def test_cancel_during_session_lookup_reaps_worker_without_publishing_identity(self) -> None:
        from notalone.server.sync_host import SyncHostBusy
        from tests.unit.front_sync.test_emoji_fallback import candidate

        probe = self._probe("header")
        cancelled = [False]
        expected = SyncHostBusy("合成读取范围已变更")
        def sessions(**kwargs):
            cancelled[0] = True
            return (candidate("合成测试"),)
        def check_current():
            if cancelled[0]:
                raise expected
        locator = self._locator(probe, sessions=sessions)
        with self.assertRaises(SyncHostBusy) as caught:
            locator.observe_fresh(enabled=True, deadline=monotonic() + 2,
                                  check_current=check_current)
        self.assertIs(caught.exception, expected)
        self.assertIsNotNone(self.processes[0].poll())

    def test_session_lookup_timeout_reaps_worker_including_group_masked_failure(self) -> None:
        from notalone.wechat_cli import CliAdapterError

        for mode in ("header", "header_group"):
            for error in (TimeoutError("合成名单超时"), CliAdapterError("cli_timeout", "合成CLI超时")):
                with self.subTest(mode=mode, error=type(error).__name__):
                    probe = self._probe(mode)
                    def sessions(**kwargs):
                        raise error
                    locator = self._locator(probe, sessions=sessions)
                    result = locator.observe_fresh(enabled=True, deadline=monotonic() + 2)
                    expected = ("group_chat_suspected" if mode == "header_group" else
                                "observation_timeout" if isinstance(error, TimeoutError) else
                                "binding_verification_unavailable")
                    self.assertEqual(result.reason, expected)
                    self.assertIsNone(result.contact_id)
                    self.assertIsNotNone(self.processes[-1].poll())

    def test_injected_runner_retains_single_frame_command(self) -> None:
        commands = []
        def runner(command):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, '{"ok":true,"wechat_in_front":false}', '')
        probe = MacosFrontSessionProbe(runner=runner)
        probe.observe_fresh(timeout_seconds=1)
        probe.observe()
        self.assertEqual(commands[0][1:], ("--session", "--json", "--minimal-region", "--single-frame"))
        self.assertEqual(commands[1][1:], ("--session", "--json"))
        self.assertEqual(self.processes, [])
