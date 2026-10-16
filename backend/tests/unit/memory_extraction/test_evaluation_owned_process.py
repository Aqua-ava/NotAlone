"""自有worker收尾与有限事件回读；只运行本测试创建的合成进程组。"""
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import signal
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4


class OwnedPublicProcessTest(unittest.TestCase):
    def launch(self, *, kind, windows, script_body, remaining_seconds=60, killpg_effect=None):
        from notalone.memory_extraction import evaluation_owned_process as owned

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            (directory / "evaluation").mkdir()
            frozen = {"directory": str(directory), "run_id": str(uuid4()),
                      "selection": [{"case_id": f"synthetic-{i}", "gold_position": i} for i in range(windows)]}
            helper = SimpleNamespace(
                publish=lambda path, value: path.write_text(json.dumps(value)),
                read_private=lambda path: json.loads(path.read_bytes()),
            )
            script = "\n".join((
                "import json,os,signal,sys,time", "from pathlib import Path",
                f"directory=Path({str(directory)!r})", f"run_id={frozen['run_id']!r}",
                'assert sys.stdin.buffer.readline(7)==b"start\\n"', script_body,
            ))
            real_popen = subprocess.Popen
            real_killpg = os.killpg
            children = []

            def spawn(command, **options):
                self.assertTrue(options["start_new_session"])
                child = real_popen([sys.executable, "-B", "-c", script], **options)
                children.append(child)
                return child

            def killpg(pgid, signum):
                self.assertEqual(pgid, children[0].pid)
                return killpg_effect(real_killpg, pgid, signum)

            try:
                with patch.object(owned.subprocess, "Popen", side_effect=spawn), (
                    patch.object(owned.os, "killpg", side_effect=killpg) if killpg_effect else nullcontext()
                ):
                    receipt = owned._launch_owned_public_worker(
                        frozen=frozen, script=directory / "synthetic.py", root=directory, helper=helper,
                        freeze_path=directory / "freeze.json", expected_sha256="a" * 64,
                        approval_path=directory / "approval.json", end=datetime.now(timezone.utc) + timedelta(seconds=remaining_seconds),
                        clock=lambda: datetime.now(timezone.utc), kind=kind,
                    )
            except PermissionError as error:
                error.add_note(f"owned_test_kind={kind}; owned_pids={[child.pid for child in children]}")
                self.assertFalse((directory / "finish.json").exists())
                raise
            finally:
                # 失败负控也只回收本测试仍为session leader的已知child，边界patch已退出。
                for child in children:
                    if child.poll() is None:
                        try:
                            if os.getpgid(child.pid) == child.pid:
                                real_killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.wait(timeout=5)
            self.assertTrue(receipt["worker_gone"])
            with self.assertRaises(ProcessLookupError):
                os.killpg(children[0].pid, 0)
            return receipt

    def test_launch_requires_actual_esrch_after_transient_probe_permission_error(self):
        from notalone.memory_extraction.evaluation_provider_contract import REFERENCE21_V4_KIND

        for kind, windows in ((REFERENCE21_V4_KIND, 21), ("full140-v4", 140)):
            with self.subTest(kind=kind):
                signaled, injected, absent = [], [], []

                def boundary(real_killpg, pgid, signum):
                    if signum:
                        real_killpg(pgid, signum)
                        signaled.append(signum)
                    else:
                        if signaled and not injected:
                            injected.append(pgid)
                            raise PermissionError(errno.EPERM, "synthetic_exit_transition")
                        try:
                            real_killpg(pgid, 0)
                        except ProcessLookupError:
                            absent.append(pgid)
                            raise

                receipt = self.launch(
                    kind=kind, windows=windows, remaining_seconds=10.1,
                    script_body="time.sleep(30)", killpg_effect=boundary,
                )
                self.assertEqual(len(injected), 1)
                self.assertIn(injected[0], absent)
                self.assertTrue(receipt["worker_gone"])
                self.assertTrue(receipt["close_unknown"])

    def test_fork_cleanup_uses_existing_phase_deadline_for_delayed_group_absence(self):
        from notalone.memory_extraction.evaluation_provider_contract import REFERENCE21_V4_KIND

        for kind, windows in ((REFERENCE21_V4_KIND, 21), ("full140-v4", 140)):
            with self.subTest(kind=kind):
                killed, failures, absent = [], [], []

                def boundary(real_killpg, pgid, signum):
                    if signum:
                        real_killpg(pgid, signum)
                        if signum == signal.SIGKILL:
                            killed.append(time.monotonic())
                    else:
                        if killed and time.monotonic() - killed[0] < .2:
                            failures.append(time.monotonic())
                            raise PermissionError(errno.EPERM, "synthetic_delayed_orphan_exit")
                        try:
                            real_killpg(pgid, 0)
                        except ProcessLookupError:
                            absent.append(pgid)
                            raise

                receipt = self.launch(kind=kind, windows=windows, killpg_effect=boundary, script_body='''
if os.fork()==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    (directory/"descendant-ready").write_text("ready")
    time.sleep(30)
    os._exit(0)
while not (directory/"descendant-ready").exists():time.sleep(.01)
raise SystemExit(7)
''')
                self.assertEqual(receipt["exit_code"], 7)
                self.assertGreater(failures[-1] - failures[0], .1)
                self.assertIn(receipt["pid"], absent)
                self.assertTrue(receipt["worker_gone"])
                self.assertTrue(receipt["close_unknown"])

    def test_launch_preserves_persistent_probe_permission_error_without_more_signals(self):
        from notalone.memory_extraction.evaluation_provider_contract import REFERENCE21_V4_KIND

        signaled, failures = [], []
        first_error = PermissionError(errno.EPERM, "synthetic_persistent_permission")

        def boundary(real_killpg, pgid, signum):
            if signum:
                real_killpg(pgid, signum)
                signaled.append(signum)
            elif signaled:
                failures.append(time.monotonic())
                raise first_error if len(failures) == 1 else PermissionError(errno.EPERM, "still_unknown")
            else:
                real_killpg(pgid, 0)

        with self.assertRaises(PermissionError) as caught:
            self.launch(
                kind=REFERENCE21_V4_KIND, windows=21, remaining_seconds=10.1,
                script_body="time.sleep(30)", killpg_effect=boundary,
            )
        self.assertIs(caught.exception, first_error)
        self.assertEqual(signaled, [signal.SIGTERM])
        self.assertGreaterEqual(failures[-1] - failures[0], .9)
        self.assertLess(failures[-1] - failures[0], 1.5)

    def test_launch_keeps_default_probe_limit_before_any_signal(self):
        from notalone.memory_extraction.evaluation_provider_contract import REFERENCE21_V4_KIND

        calls, failures = [], []
        error = PermissionError(errno.EPERM, "synthetic_initial_permission")

        def boundary(real_killpg, pgid, signum):
            calls.append(signum)
            failures.append(time.monotonic())
            raise error

        with self.assertRaises(PermissionError) as caught:
            self.launch(
                kind=REFERENCE21_V4_KIND, windows=21, remaining_seconds=10.1,
                script_body="time.sleep(30)", killpg_effect=boundary,
            )
        self.assertIs(caught.exception, error)
        self.assertTrue(all(signum == 0 for signum in calls))
        self.assertGreaterEqual(failures[-1] - failures[0], .09)
        self.assertLess(failures[-1] - failures[0], .5)

    def test_launch_never_retries_permission_denied_term_or_kill(self):
        from notalone.memory_extraction.evaluation_provider_contract import REFERENCE21_V4_KIND

        for denied in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(signal=denied):
                signals = []
                error = PermissionError(errno.EPERM, "synthetic_signal_permission")

                def boundary(real_killpg, pgid, signum):
                    if signum:
                        signals.append(signum)
                        if signum == denied:
                            raise error
                    real_killpg(pgid, signum)

                with self.assertRaises(PermissionError) as caught:
                    self.launch(
                        kind=REFERENCE21_V4_KIND, windows=21, remaining_seconds=11,
                        script_body="signal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(30)",
                        killpg_effect=boundary,
                    )
                self.assertIs(caught.exception, error)
                self.assertEqual(signals, [signal.SIGTERM] if denied == signal.SIGTERM
                                 else [signal.SIGTERM, signal.SIGKILL])

    def test_fallback_never_silently_truncates_late_started_window(self):
        receipt = self.launch(kind="main16", windows=16, script_body='''
for i in range(1,2050):
    (directory/"evaluation"/f"event-{i:06}.json").write_text(json.dumps(
        {"kind":"case_started","case_position":15} if i==2049 else {"kind":"synthetic"}))
''')
        self.assertEqual(receipt["case_statuses"][15]["status"], "unknown")
        self.assertTrue(receipt["close_unknown"])

    def test_full140_fallback_covers_last_window_after_old_limit_and_overflow_is_unknown(self):
        for count, overflow in ((3001, False), (16385, True)):
            with self.subTest(count=count):
                receipt = self.launch(kind="full140-v4", windows=140, script_body=f'''
for i in range(1,{count + 1}):
    (directory/"evaluation"/f"event-{{i:06}}.json").write_text(json.dumps(
        {{"kind":"case_started","case_position":139}} if i=={count} else {{"kind":"synthetic"}}))
''')
                self.assertEqual(receipt["planned_windows"], 140)
                self.assertEqual(receipt["required_claims"], 138)
                expected = ["unknown"] * 140 if overflow else ["unrun"] * 139 + ["unknown"]
                self.assertEqual([item["status"] for item in receipt["case_statuses"]], expected)
                self.assertFalse(receipt["automatic_successor"])

    def test_full140_wrong_run_cap_pid_count_or_malformed_receipt_stays_close_unknown(self):
        for override in (
            '{"run_id":"wrong-run"}', '{"request_limit":32}', '{"request_limit":280.0}',
            '{"worker_pid":os.getpid()+1}', '{"worker_pid":float(os.getpid())}',
            '{"reserved_requests":True}', '{"reserved_requests":281}', '{"closed":False}', 'None',
        ):
            with self.subTest(override=override):
                receipt = self.launch(kind="full140-v4", windows=140, script_body=f'''
value={{"run_id":run_id,"worker_pid":os.getpid(),"closed":True,"request_limit":280,"reserved_requests":1}}
override={override}
if override is not None:value.update(override)
(directory/"deadline-receipt.json").write_text(json.dumps(value if override is not None else []))
''')
                self.assertFalse(receipt["closed"])
                self.assertTrue(receipt["close_unknown"])

    def test_full140_reaps_owned_descendants_after_leader_exit(self):
        receipt = self.launch(kind="full140-v4", windows=140, script_body='''
(directory/"deadline-receipt.json").write_text(json.dumps(
    {"run_id":run_id,"worker_pid":os.getpid(),"closed":True,"request_limit":280,"reserved_requests":280}))
if os.fork()==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    (directory/"descendant-ready").write_text("ready")
    time.sleep(30)
    os._exit(0)
while not (directory/"descendant-ready").exists():time.sleep(.01)
raise SystemExit(7)
''')
        self.assertEqual(receipt["exit_code"], 7)
        self.assertTrue(receipt["closed"])

    def test_full140_outer_obeys_existing_absolute_end_without_extending_worker_time(self):
        receipt = self.launch(kind="full140-v4", windows=140, remaining_seconds=10.1, script_body='''
signal.signal(signal.SIGTERM,signal.SIG_IGN)
time.sleep(30)
''')
        self.assertTrue(receipt["outer_timed_out"])
        self.assertTrue(receipt["close_unknown"])
        self.assertLess(receipt["elapsed_seconds"], 3)

    def test_mixed_normal_and_deadline_receipts_require_integer_pid_and_counts(self):
        from notalone.memory_extraction.evaluation_provider_contract import MIXED_KIND, MIXED_PLAN
        for form in ("normal", "deadline"):
            for change in ("valid", "float_pid", "bool_pid", "wrong_pid", "float_cap", "bool_count"):
                with self.subTest(form=form, change=change):
                    receipt = self.launch(kind=MIXED_KIND, windows=140, script_body=f'''
pid=os.getpid()
if {change!r}=="float_pid":pid=float(pid)
if {change!r}=="bool_pid":pid=True
if {change!r}=="wrong_pid":pid+=1
value={{"run_id":run_id,"worker_pid":pid,"closed":True,"request_limit":280,"reserved_requests":1}}
if {change!r}=="float_cap":value["request_limit"]=280.0
if {change!r}=="bool_count":value["reserved_requests"]=True
if {form!r}=="normal":
    value={{"worker_pid":pid,"execution_plan":{MIXED_PLAN!r},"receipt":{{"budget":value}}}}
    path=directory/"result.json"
else:path=directory/"deadline-receipt.json"
path.write_text(json.dumps(value))
''')
                    self.assertEqual(receipt["closed"], change == "valid")
                    self.assertEqual(receipt["close_unknown"], change != "valid")

    def test_mixed_fallback_keeps_16384_limit_and_last_window_mapping(self):
        from notalone.memory_extraction.evaluation_provider_contract import MIXED_KIND
        for count in (3001, 16385):
            with self.subTest(count=count):
                receipt = self.launch(kind=MIXED_KIND, windows=140, script_body=f'''
for i in range(1,{count + 1}):
    (directory/"evaluation"/f"event-{{i:06}}.json").write_text(json.dumps(
        {{"kind":"case_started","case_position":139}} if i=={count} else {{"kind":"synthetic"}}))
''')
                states = [row["status"] for row in receipt["case_statuses"]]
                self.assertEqual(states, ["unknown"] * 140 if count > 16384 else ["unrun"] * 139 + ["unknown"])

    def test_reference21_receipts_require_42_exact_plan_pid_and_owned_group_gone(self):
        from notalone.memory_extraction.evaluation_provider_contract import REFERENCE21_V4_KIND, REFERENCE21_V4_PLAN
        for form, change in (("normal", "valid"), ("normal", "plan"), ("normal", "pid"),
                             ("deadline", "valid"), ("deadline", "cap"), ("deadline", "count")):
            with self.subTest(form=form, change=change):
                receipt = self.launch(kind=REFERENCE21_V4_KIND, windows=21, script_body=f'''
pid=float(os.getpid()) if {change!r}=="pid" else os.getpid()
value={{"run_id":run_id,"worker_pid":pid,"closed":True,"request_limit":42,"reserved_requests":1}}
if {change!r}=="cap":value["request_limit"]=280
if {change!r}=="count":value["reserved_requests"]=True
if {form!r}=="normal":
    value={{"worker_pid":pid,"execution_plan":"wrong" if {change!r}=="plan" else {REFERENCE21_V4_PLAN!r},"receipt":{{"budget":value}}}}
    path=directory/"result.json"
else:path=directory/"deadline-receipt.json"
path.write_text(json.dumps(value))
''')
                self.assertEqual(receipt["closed"], change == "valid")
                self.assertEqual((receipt["planned_windows"], receipt["required_claims"]), (21, 28))

    def test_reference21_outer_keeps_absolute_end_and_never_auto_restarts(self):
        from notalone.memory_extraction.evaluation_provider_contract import REFERENCE21_V4_KIND
        receipt = self.launch(kind=REFERENCE21_V4_KIND, windows=21, remaining_seconds=10.1, script_body='''
signal.signal(signal.SIGTERM,signal.SIG_IGN)
time.sleep(30)
''')
        self.assertTrue(receipt["outer_timed_out"])
        self.assertTrue(receipt["close_unknown"])
        self.assertFalse(receipt["automatic_successor"])
        self.assertLess(receipt["elapsed_seconds"], 3)
