"""验收读取归因只观察既有调度及合成子进程，不访问真实微信。"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from tests.unit.front_sync import test_cli_background_sync as sync_fixture
from tests.unit.wechat_cli import test_acceptance_scope as scope_fixture

fixture = scope_fixture.fixture


class EmptyTailProcess(scope_fixture.SyntheticProcess):
    def communicate(self, timeout=None):
        self.returncode = 0
        return json.dumps({"ok": True, "data": {
            "events": [], "freshness": {"message_source": "live_message_db"},
            "query": {"chat": "synthetic-selected", "has_more": False},
        }}), ""


class SyncReadCausesTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        base_scope = scope_fixture.AcceptanceScopeTest()
        base_scope.setUp()
        self.scope = replace(base_scope.scope,
            audit_path=self.directory / "audit.jsonl",
            pid_audit_path=self.directory / "pids.jsonl")
        self.rows_path = self.directory / "measurements.jsonl"
        self.rows_path.touch(mode=0o600)
        source = Path(fixture.__file__).with_name("observation_measurements.py")
        self.enterContext(patch.object(sys, "path", [str(source.parent), *sys.path]))
        spec = importlib.util.spec_from_file_location("observation_measurements", source)
        self.measurements = importlib.util.module_from_spec(spec)
        self.enterContext(patch.dict(sys.modules, observation_measurements=self.measurements))
        spec.loader.exec_module(self.measurements)
        self.enterContext(patch.dict(fixture.os.environ, {
            "NOTALONE_OBSERVATION_MEASUREMENT_FILE": str(self.rows_path),
            "NOTALONE_SYNC_PROBE": "/synthetic/probe",
        }))
        from notalone.server.app import BackendApp
        self.enterContext(patch.object(fixture.subprocess, "run", fixture.subprocess.run))
        self.enterContext(patch.object(BackendApp, "handle", BackendApp.handle))
        self.measurements.install()
        self.commands = []
        self.processes = []
        self.spawn_error = None

        def process_factory(command, **kwargs):
            self.commands.append(command)
            if self.spawn_error:
                raise self.spawn_error
            process = EmptyTailProcess()
            process.pid += len(self.processes)
            self.processes.append(process)
            return process

        self.cli = fixture.build_scoped_cli(self.scope, process_factory=process_factory,
                                           clock=lambda: 1791782460.0)
        self.addCleanup(self.cli.close)
        base = sync_fixture.CliBackgroundSyncTest()
        base.setUp()
        self.binding = replace(base.binding_a, conversation_locator=self.scope.locator)
        self.now = datetime.fromtimestamp(1791782460, tz=timezone.utc)
        self.stream = sync_fixture.FakeSessionStream([])
        self.cli.session_events_follow = lambda **kwargs: self.stream
        self.sync = sync_fixture.CliBackgroundSync(
            owner_id=sync_fixture.OWNER_ID, channel="wechat", account_scope="synthetic",
            cli=self.cli, bindings=[self.binding], observation_store=base.store,
            backfill_state=base.backfill_store, sync_state=base.sync_state,
            clock=lambda: self.now)
        self.addCleanup(self.sync.close)

    def rows(self):
        return [value for line in self.rows_path.read_text().splitlines()
                if (value := json.loads(line))["kind"] == "cli-read-cause"]

    def test_actual_selected_live_event_read_has_positive_pid_cause(self):
        self.sync.cycle(enabled=True)
        before = len(self.commands)
        self.sync._global_cursor = "synthetic-initial-watermark"
        self.stream.events.append(("synthetic-next-watermark", self.scope.locator))
        result = self.sync.cycle(enabled=True)
        self.assertEqual(len(self.commands), before + 1)
        self.assertEqual(result.batch_message_count, 0)
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1]["sources"], ["global_live_event"])
        self.assertEqual(rows[-1]["attribution"], "single")
        self.assertEqual(rows[-1]["pid"], self.processes[-1].pid)
        self.assertGreater(rows[-1]["pid"], 0)
        self.assertNotIn(self.scope.locator, json.dumps(rows))
        audit = [json.loads(line) for line in self.scope.audit_path.read_text().splitlines()]
        self.assertIn({"event": "finished", "kind": "tail", "pid": rows[-1]["pid"],
                       "status": "exited", "returncode": 0}, audit)

    def event(self):
        self.sync._global_cursor = "synthetic-known-watermark"
        self.stream.events.append(("synthetic-next-watermark", self.scope.locator))

    def test_initial_snapshot_batch_and_initial_reconciliation_are_mixed(self):
        self.stream.events.extend([
            ("synthetic-first", self.scope.locator),
            ("synthetic-second", self.scope.locator)])
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.rows()[0]["sources"],
                         ["global_initial_batch", "initial_reconciliation"])
        self.assertEqual(self.rows()[0]["attribution"], "mixed")
        self.assertEqual(self.rows()[0]["global_event_semantics"],
                         "product-classification-only")

    def test_initial_safety_backfill_and_priority_reads_are_distinct(self):
        self.sync.cycle(enabled=True)
        self.sync.request_safety_sweep()
        self.sync.cycle(enabled=True)
        self.sync.request_backfill_check()
        self.sync.cycle(enabled=True)
        self.sync.cycle(enabled=True, priority_contact_id=self.binding.contact_id)
        self.assertEqual([row["sources"] for row in self.rows()], [
            ["initial_reconciliation"], ["safety_reconciliation"],
            ["backfill_reconciliation"], ["priority_reconciliation"]])

    def test_event_and_priority_upgrade_are_mixed(self):
        self.sync.cycle(enabled=True)
        self.event()
        self.sync.cycle(enabled=True, priority_contact_id=self.binding.contact_id)
        self.assertEqual(self.rows()[-1]["sources"],
                         ["global_live_event", "priority_reconciliation"])
        self.assertEqual(self.rows()[-1]["attribution"], "mixed")

    def test_priority_cadence_skipped_event_is_not_a_read_cause(self):
        self.sync.cycle(enabled=True, priority_contact_id=self.binding.contact_id)
        before = (len(self.commands), len(self.rows()))
        self.event()
        self.sync.cycle(enabled=True, priority_contact_id=self.binding.contact_id)
        self.assertEqual((len(self.commands), len(self.rows())), before)
        self.now += timedelta(seconds=3)
        self.sync.cycle(enabled=True, priority_contact_id=self.binding.contact_id)
        self.assertEqual(self.rows()[-1]["sources"], ["priority_reconciliation"])

    def test_pending_event_cause_survives_a_cycle_budget(self):
        self.sync.cycle(enabled=True)
        self.event()
        with patch("notalone.front_sync.cli_sync._MAX_BINDINGS_PER_CYCLE", 0):
            self.sync.cycle(enabled=True)
        self.assertEqual(len(self.rows()), 1)
        self.sync.cycle(enabled=True)
        self.assertEqual(self.rows()[-1]["sources"], ["global_live_event"])

    def test_pending_event_priority_promotion_is_observed(self):
        self.sync.cycle(enabled=True)
        self.event()
        with patch("notalone.front_sync.cli_sync._MAX_BINDINGS_PER_CYCLE", 0):
            self.sync.cycle(enabled=True)
        # 单独覆盖已有队列提升入口；它也可把普通补齐升级为 live。
        self.sync._prioritize_pending(self.binding.contact_id, [self.binding])
        self.sync.cycle(enabled=True)
        self.assertEqual(self.rows()[-1]["sources"],
                         ["global_live_event", "priority_reconciliation"])

    def test_unknown_preexisting_queue_is_not_promoted_to_single_cause(self):
        self.sync.cycle(enabled=True)
        self.sync._pending_locators.append(self.scope.locator)
        self.sync._pending_locator_set.add(self.scope.locator)
        self.event()
        self.sync.cycle(enabled=True)
        self.assertEqual(self.rows()[-1]["attribution"], "unknown")
        self.assertEqual(self.rows()[-1]["sources"], ["global_live_event", "unknown"])

    def test_close_discards_queued_sources(self):
        self.sync.cycle(enabled=True)
        self.event()
        with patch("notalone.front_sync.cli_sync._MAX_BINDINGS_PER_CYCLE", 0):
            self.sync.cycle(enabled=True)
        self.sync.close()
        self.sync.cycle(enabled=True)
        self.assertEqual(self.rows()[-1]["sources"], ["initial_reconciliation"])

    def test_failed_spawn_has_no_positive_pid_or_carried_event_cause(self):
        self.sync.cycle(enabled=True)
        self.event()
        self.spawn_error = OSError("合成启动失败")
        failed = self.sync.cycle(enabled=True)
        self.assertEqual(failed.status.failure_code, "acceptance_cli_start_failed")
        self.assertEqual(len(self.rows()), 1)
        self.spawn_error = None
        self.sync.request_safety_sweep()
        self.sync.cycle(enabled=True)
        self.assertEqual(self.rows()[-1]["sources"], ["safety_reconciliation"])

    def test_skipped_read_and_unselected_event_do_not_start_a_process(self):
        self.sync.cycle(enabled=True)
        before = len(self.commands)
        self.sync._global_cursor = "synthetic-watermark"
        self.stream.events.append(("synthetic-unselected-watermark", "synthetic-other"))
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.commands), before)
        # 保留正式 _read_binding 提前返回路径，不用队列项补造实际读取。
        self.sync.request_backfill_check()
        self.sync.pause_backfill()
        self.sync._enqueue(self.scope.locator)
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.commands), before)

    def test_observer_and_plain_runtime_keep_the_same_commands_and_results(self):
        def run():
            results = [self.sync.cycle(enabled=True)]
            self.event()
            results.append(self.sync.cycle(enabled=True))
            results.append(self.sync.cycle(enabled=True,
                                           priority_contact_id=self.binding.contact_id))
            results.append(self.sync.cycle(enabled=False))
            return results

        observed = run()
        observed_commands = self.commands[:]
        self.assertEqual(len(self.rows()), 3)
        self.cli.close_runner.__self__.tail_started = None
        del self.cli.read_cause_observer
        self.commands.clear()
        base = sync_fixture.CliBackgroundSyncTest()
        base.setUp()
        self.stream = sync_fixture.FakeSessionStream([])
        self.sync = sync_fixture.CliBackgroundSync(
            owner_id=sync_fixture.OWNER_ID, channel="wechat", account_scope="synthetic",
            cli=self.cli, bindings=[self.binding], observation_store=base.store,
            backfill_state=base.backfill_store, sync_state=base.sync_state,
            clock=lambda: self.now)
        self.addCleanup(self.sync.close)
        self.assertEqual(run(), observed)
        self.assertEqual(self.commands, observed_commands)
        self.assertEqual(len(self.rows()), 3)

    def test_recorder_failure_preserves_return_exception_and_scope(self):
        observer = self.cli.read_cause_observer
        observer.record = lambda row: (_ for _ in ()).throw(OSError("合成测量不可写"))
        result = self.sync.cycle(enabled=True)
        self.assertEqual(result.batch_message_count, 0)
        self.assertIsNone(result.status.failure_code)
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.rows(), [])
        self.assertFalse(self.processes[0].terminated)
        with self.assertRaises(fixture.CliCommandError) as rejected:
            self.cli.tail("synthetic-other", since_time="2026-10-12T13:21:00")
        self.assertEqual(rejected.exception.code, "acceptance_scope_exceeded")
        self.assertEqual(len(self.commands), 1)
        self.spawn_error = OSError("合成启动失败")
        with self.assertRaises(fixture.CliCommandError) as failed:
            self.cli.tail(self.scope.locator, since_time="2026-10-12T13:21:00")
        self.assertEqual(failed.exception.code, "acceptance_cli_start_failed")

    def test_unattributed_direct_read_is_unknown_and_has_only_metadata(self):
        result = self.cli.tail(self.scope.locator, since_time="2026-10-12T13:21:00")
        self.assertEqual(result.events, ())
        row = self.rows()[0]
        self.assertEqual(row["sources"], ["unknown"])
        self.assertEqual(row["attribution"], "unknown")
        self.assertEqual(set(row), {"kind", "pid", "started_at_ms", "sources", "attribution",
            "global_event_semantics", "backend_cpu_ms", "backend_max_rss_bytes",
            "backend_children_cpu_ms", "backend_child_max_rss_bytes"})
        self.cli.read_cause_observer.tail_started(None)
        self.cli.read_cause_observer.tail_started(0)
        self.assertEqual(len(self.rows()), 1)


if __name__ == "__main__":
    unittest.main()
