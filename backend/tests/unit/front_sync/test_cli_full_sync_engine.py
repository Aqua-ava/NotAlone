"""CLI 后台同步与前台 OCR 状态分离的引擎测试。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from time import monotonic
from uuid import UUID

from notalone.front_sync.cli_binding import CliBindingCandidateView, CliBindingSelection
from notalone.front_sync.cli_sync import (
    CliSyncCycleResult,
    CliSyncPhase,
    CliSyncStatus,
)
from notalone.front_sync.foreground_locator import ForegroundLocatorStatus
from notalone.front_sync.foreground_observation import FreshForegroundObservation
from notalone.front_sync.sync_engine import FrontSyncCycleReport
from notalone.front_sync.tail_lifecycle import FrontSyncPhase, FollowRuntimeStatus
from notalone.wechat_cli import CliCommandError


OWNER_ID = UUID("33333333-3333-3333-3333-333333333333")
CONTACT_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")


@dataclass(frozen=True)
class FakeState:
    enabled: bool = True

    def read(self, **kwargs):
        del kwargs
        return type("State", (), {"enabled": self.enabled})()

    def read_bounded(self, **kwargs):
        return self.read(**kwargs)

    def enable(self, **kwargs):
        del kwargs
        object.__setattr__(self, "enabled", True)

    def disable(self, **kwargs):
        del kwargs
        object.__setattr__(self, "enabled", False)


class FakeBackground:
    def __init__(self) -> None:
        self.calls: list[bool] = []
        self.priority_calls: list[UUID | None] = []
        self.safety_sweep_requests = 0
        self.smoke_enabled = False
        self.interruptions = 0
        self.backfill_pauses = 0
        self.backfill_retries = 0
        self.result = CliSyncCycleResult(
            status=CliSyncStatus(
                phase=CliSyncPhase.ACTIVE,
                stream_active=True,
                stream_mode="global_follow",
                failure_code=None,
                bound_count=2,
            ),
            batch_message_count=3,
        )

    def cycle(
        self,
        *,
        enabled: bool,
        priority_contact_id: UUID | None = None,
    ) -> CliSyncCycleResult:
        self.calls.append(enabled)
        self.priority_calls.append(priority_contact_id)
        return self.result

    def close(self) -> None:
        pass

    def request_safety_sweep(self) -> None:
        self.safety_sweep_requests += 1

    def pause_backfill(self) -> None:
        self.backfill_pauses += 1

    def retry_backfill(self) -> None:
        self.backfill_retries += 1

    def enable_follow_smoke(self):
        self.smoke_enabled = True

    def disable_follow_smoke(self):
        self.smoke_enabled = False

    def interrupt_follow_stream(self):
        self.interruptions += 1

    def follow_runtime_status(self):
        return FollowRuntimeStatus(enabled=self.smoke_enabled, stream_active=True, mode="global_follow")


class FakeForeground:
    def __init__(self) -> None:
        self.calls: list[bool] = []
        self.fresh_calls: list[bool] = []
        self.result = ForegroundLocatorStatus(
            phase=FrontSyncPhase.FAILED,
            probe_available=False,
            wechat_in_front=False,
            failure_code="screen_capture_permission_missing",
            active_contact_id=None,
            active_binding_display_name=None,
            decision_reason=None,
            candidates=(),
        )

    def observe(self, *, enabled: bool) -> ForegroundLocatorStatus:
        self.calls.append(enabled)
        return self.result

    def observe_fresh(self, *, enabled: bool, deadline: float) -> FreshForegroundObservation:
        self.fresh_calls.append(enabled)
        return FreshForegroundObservation.create(
            phase="confirmed", reason="confirmed_active_binding",
            probe_available=True, wechat_in_front=True,
            contact_id=CONTACT_ID, binding_id=OWNER_ID,
        )


class FakeCli:
    def __init__(self) -> None:
        self.close_calls = 0
        self.version_failures = 0

    def version(self) -> str:
        if self.version_failures > 0:
            self.version_failures -= 1
            raise CliCommandError("cli_not_found", "合成 CLI 暂不可用")
        return "1.6.20-test"

    def close(self) -> None:
        self.close_calls += 1


class FakeBindingCoordinator:
    def __init__(self) -> None:
        self.confirmed: list[tuple[CliBindingSelection, ...]] = []

    def list_candidates(self):
        return (
            CliBindingCandidateView("wxid_a", "甲", 1, None),
        )

    def confirm(self, selections):
        self.confirmed.append(tuple(selections))
        return ()


class FakeFallback:
    def cycle(self) -> FrontSyncCycleReport:
        raise AssertionError("全量 CLI 主循环不应调用旧前台同步引擎")

    def enable_follow_smoke(self):
        return _legacy_report()

    def disable_follow_smoke(self):
        return _legacy_report()

    def interrupt_follow_stream(self):
        return _legacy_report()

    def follow_runtime_status(self):
        return FollowRuntimeStatus(enabled=False, stream_active=False)

    def confirm_binding(self, **kwargs):
        del kwargs
        return _legacy_report()

    def confirm_pending_binding(self, **kwargs):
        del kwargs
        return _legacy_report()


def _legacy_report() -> FrontSyncCycleReport:
    return FrontSyncCycleReport(
        sync_enabled=True,
        phase=FrontSyncPhase.ACTIVE,
        probe_available=True,
        wechat_in_front=True,
        cli_available=True,
        failure_code=None,
        active_contact_id=CONTACT_ID,
        active_binding_display_name="甲",
        decision_reason=None,
    )


class CliFullSyncEngineTest(unittest.TestCase):
    def test_follow_diagnostics_use_current_background_without_ocr(self) -> None:
        self.engine.enable_follow_smoke()
        self.assertTrue(self.background.smoke_enabled)
        self.assertEqual(self.engine.follow_runtime_status().mode, "global_follow")
        self.engine.interrupt_follow_stream()
        self.assertEqual(self.background.interruptions, 1)
        self.engine.disable_follow_smoke()
        self.assertFalse(self.background.smoke_enabled)
        self.assertEqual(self.foreground.calls, [])

    def setUp(self) -> None:
        from notalone.front_sync.full_sync_engine import CliFullSyncEngine

        self.state = FakeState()
        self.background = FakeBackground()
        self.foreground = FakeForeground()
        self.bindings = FakeBindingCoordinator()
        self.cli = FakeCli()
        self.engine = CliFullSyncEngine(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=self.cli,
            sync_state=self.state,
            background=self.background,
            foreground=self.foreground,
            binding_coordinator=self.bindings,
            fallback=FakeFallback(),
            clock=lambda: datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc),
        )

    def test_background_cycle_does_not_observe_or_claim_foreground(self) -> None:
        report = self.engine.cycle()

        self.assertEqual(report.sync_mode, "cli_background")
        self.assertEqual(report.phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(report.cli_sync_phase, "active")
        self.assertTrue(report.cli_stream_active)
        self.assertEqual(report.cli_batch_message_count, 3)
        self.assertFalse(report.probe_available)
        self.assertEqual(report.foreground_phase, "unavailable")
        self.assertEqual(report.foreground_failure_code, "foreground_not_observed")
        self.assertFalse(report.wechat_in_front)
        self.assertIsNone(report.active_contact_id)
        self.assertIsNone(report.active_binding_display_name)
        self.assertIsNone(report.decision_reason)
        self.assertEqual(report.candidates, ())
        self.assertEqual(self.background.calls, [True])
        self.assertEqual(self.foreground.calls, [])

    def test_selected_contact_is_prioritized_for_background_cycle(self) -> None:
        self.engine.set_priority_contact(CONTACT_ID)

        self.engine.cycle()

        self.assertEqual(self.background.priority_calls, [CONTACT_ID])

    def test_cycles_switches_and_backfill_controls_never_launch_visual_reads(self) -> None:
        # 即使视觉端口有可用身份，后台也不能据此授予身份或隐式优先级。
        self.foreground.result = ForegroundLocatorStatus(
            phase=FrontSyncPhase.ACTIVE, probe_available=True, wechat_in_front=True,
            failure_code=None, active_contact_id=CONTACT_ID,
            active_binding_display_name="甲", decision_reason=None, candidates=(),
        )
        reports = [self.engine.cycle(), self.engine.cycle()]
        self.engine.disable_sync()
        reports.append(self.engine.cycle())
        self.engine.enable_sync()
        self.engine.request_sync_check()
        reports.append(self.engine.cycle())
        self.engine.pause_backfill()
        reports.append(self.engine.cycle())
        self.engine.retry_backfill()
        reports.append(self.engine.cycle())

        self.assertEqual(self.background.calls, [True, True, False, True, True, True])
        self.assertEqual(self.background.priority_calls, [None] * 6)
        self.assertEqual(self.background.backfill_pauses, 1)
        self.assertEqual(self.background.backfill_retries, 1)
        self.assertEqual(self.foreground.calls, [])
        self.assertEqual(self.foreground.fresh_calls, [])
        self.assertTrue(all(report.active_contact_id is None for report in reports))
        self.assertTrue(all(report.foreground_failure_code == "foreground_not_observed"
                            for report in reports))

    def test_explicit_fresh_observation_does_not_become_background_identity(self) -> None:
        fresh = self.engine.observe_foreground(deadline=monotonic() + 2)
        report = self.engine.cycle()

        self.assertEqual(fresh.contact_id, CONTACT_ID)
        self.assertEqual(self.foreground.fresh_calls, [True])
        self.assertEqual(self.foreground.calls, [])
        self.assertIsNone(report.active_contact_id)
        self.assertEqual(self.background.priority_calls, [None])

    def test_batch_binding_honors_only_explicit_background_priority(self) -> None:
        self.engine.set_priority_contact(CONTACT_ID)
        self.engine.confirm_cli_bindings((CliBindingSelection(locator="wxid_a"),))
        self.engine.set_priority_contact(None)
        self.engine.cycle()

        self.assertEqual(self.background.priority_calls, [CONTACT_ID, None])
        self.assertEqual(self.foreground.calls, [])

    def test_explicit_legacy_binding_confirmation_remains_available(self) -> None:
        report = self.engine.confirm_binding(contact_id=CONTACT_ID, locator="wxid_a")
        pending = self.engine.confirm_pending_binding(contact_id=CONTACT_ID, locator="wxid_a")

        self.assertEqual(report.active_contact_id, CONTACT_ID)
        self.assertEqual(pending.active_contact_id, CONTACT_ID)

    def test_batch_binding_is_exposed_without_using_foreground_probe(self) -> None:
        candidates = self.engine.list_cli_sessions()
        self.engine.confirm_cli_bindings((CliBindingSelection(locator="wxid_a"),))

        self.assertEqual(candidates[0].username, "wxid_a")
        self.assertEqual(len(self.bindings.confirmed), 1)
        self.assertEqual(self.foreground.calls, [])

    def test_sync_check_requests_a_background_safety_sweep(self) -> None:
        self.engine.request_sync_check()

        self.assertEqual(self.background.safety_sweep_requests, 1)

    def test_cancel_pending_io_closes_cli_without_closing_sync_state(self) -> None:
        self.engine.cancel_pending_io()

        self.assertEqual(self.cli.close_calls, 1)

    def test_cli_availability_retries_after_a_temporary_failure(self) -> None:
        from notalone.front_sync.full_sync_engine import CliFullSyncEngine

        now = [datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)]
        cli = FakeCli()
        cli.version_failures = 1
        engine = CliFullSyncEngine(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=cli,
            sync_state=self.state,
            background=FakeBackground(),
            foreground=self.foreground,
            binding_coordinator=self.bindings,
            fallback=FakeFallback(),
            clock=lambda: now[0],
        )

        unavailable = engine.cycle()
        self.assertFalse(unavailable.cli_available)

        now[0] += timedelta(seconds=15)
        recovered = engine.cycle()

        self.assertTrue(recovered.cli_available)
        self.assertEqual(recovered.phase, FrontSyncPhase.ACTIVE)


if __name__ == "__main__":
    unittest.main()
