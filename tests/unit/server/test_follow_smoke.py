"""前台同步验证诊断接缝的外部行为测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.conversation.matcher import BindingMatchReason
from notalone.front_sync import FrontSyncPhase
from notalone.front_sync.sync_engine import FrontSyncCycleReport
from notalone.front_sync.tail_lifecycle import FollowRuntimeStatus
from notalone.server.app import create_app
from notalone.server.follow_smoke import (
    FollowSmokeCheckpoint,
    FollowSmokeContactSnapshot,
    FollowSmokeController,
    FollowSmokeStatus,
)
from notalone.server.testing import InProcessClient


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
RECORDED_AT = datetime(2026, 9, 1, 1, 0, tzinfo=timezone.utc)


def _report(*, enabled: bool = True) -> FrontSyncCycleReport:
    return FrontSyncCycleReport(
        sync_enabled=enabled,
        phase=FrontSyncPhase.ACTIVE if enabled else FrontSyncPhase.SYNC_DISABLED,
        probe_available=True,
        wechat_in_front=True,
        cli_available=True,
        failure_code=None,
        active_contact_id=CONTACT_ID if enabled else None,
        active_binding_display_name="合成联系人甲" if enabled else None,
        decision_reason=(
            BindingMatchReason.CONFIRMED_ACTIVE_BINDING if enabled else None
        ),
        batch_message_count=1 if enabled else 0,
    )


def _runtime(*, enabled: bool = False, stream: bool = False) -> FollowRuntimeStatus:
    return FollowRuntimeStatus(
        enabled=enabled,
        stream_active=stream,
        process_id=4321 if stream else None,
        mode="live" if stream else None,
        watermark=18 if stream else None,
    )


def _snapshot() -> FollowSmokeContactSnapshot:
    return FollowSmokeContactSnapshot(
        contact_id=CONTACT_ID,
        bound=True,
        message_count=12,
        observation_ref_count=4,
        watermark=18,
        latest_mode="live",
        duplicate_identities=0,
    )


class FakeFollowSmokeHost:
    def __init__(self, *, sync_enabled: bool = True) -> None:
        self.enabled = sync_enabled
        self.follow_enabled = False
        self.stream_active = False
        self.interrupt_calls = 0

    def sync_enabled(self) -> bool:
        return self.enabled

    def status(self) -> FrontSyncCycleReport:
        return _report(enabled=self.enabled)

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        self.follow_enabled = True
        self.stream_active = True
        return self.status()

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        self.follow_enabled = False
        self.stream_active = False
        return self.status()

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        self.interrupt_calls += 1
        self.stream_active = False
        return self.status()

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        return _runtime(enabled=self.follow_enabled, stream=self.stream_active)


class FakeSnapshotReader:
    def snapshot(self, *, owner_id: UUID) -> tuple[FollowSmokeContactSnapshot, ...]:
        if owner_id != OWNER_ID:
            raise AssertionError("unexpected owner")
        return (_snapshot(),)


class FollowSmokeControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = FakeFollowSmokeHost()
        self.controller = FollowSmokeController(
            owner_id=OWNER_ID,
            host=self.host,
            snapshots=FakeSnapshotReader(),
            clock=lambda: RECORDED_AT,
        )

    def test_start_enables_follow_without_enabling_sync(self) -> None:
        result = self.controller.start()

        self.assertTrue(result.active)
        self.assertTrue(result.runtime.enabled)
        self.assertTrue(result.runtime.stream_active)
        self.assertTrue(self.host.enabled)

    def test_start_rejects_disabled_sync(self) -> None:
        host = FakeFollowSmokeHost(sync_enabled=False)
        controller = FollowSmokeController(
            owner_id=OWNER_ID,
            host=host,
            snapshots=FakeSnapshotReader(),
            clock=lambda: RECORDED_AT,
        )

        with self.assertRaisesRegex(Exception, "sync_disabled"):
            controller.start()
        self.assertFalse(host.follow_enabled)

    def test_checkpoint_keeps_only_metadata_and_can_be_read_back(self) -> None:
        self.controller.start()

        result = self.controller.checkpoint("baseline")

        self.assertEqual(len(result.checkpoints), 1)
        checkpoint = result.checkpoints[0]
        self.assertIsInstance(checkpoint, FollowSmokeCheckpoint)
        self.assertEqual(checkpoint.label, "baseline")
        self.assertEqual(checkpoint.watermark, 18)
        self.assertEqual(checkpoint.contacts[0].message_count, 12)

    def test_interrupt_is_explicitly_scoped_to_follow_stream(self) -> None:
        self.controller.start()

        result = self.controller.interrupt()

        self.assertEqual(self.host.interrupt_calls, 1)
        self.assertFalse(result.runtime.stream_active)
        self.assertTrue(result.active)


class FollowSmokeApiContractTest(unittest.TestCase):
    def setUp(self) -> None:
        host = FakeFollowSmokeHost()
        controller = FollowSmokeController(
            owner_id=OWNER_ID,
            host=host,
            snapshots=FakeSnapshotReader(),
            clock=lambda: RECORDED_AT,
        )
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            follow_smoke=controller,
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    def test_status_returns_sanitized_follow_contract(self) -> None:
        response = self.client.get(
            "/api/sync/follow-smoke/status",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["active"])
        self.assertFalse(payload["follow_enabled"])
        self.assertEqual(payload["contacts"][0]["watermark"], 18)
        self.assertEqual(payload["contacts"][0]["duplicate_identities"], 0)
        self.assertNotIn("text", response.body.decode("utf-8"))
        self.assertNotIn("content", response.body.decode("utf-8"))

    def test_start_checkpoint_interrupt_and_stop_are_http_operations(self) -> None:
        prefix = "/api/sync/follow-smoke"

        started = self.client.request("POST", f"{prefix}/start", headers=self.headers)
        self.assertEqual(started.status_code, 200)
        self.assertTrue(started.json()["active"])

        checkpoint = self.client.request(
            "POST",
            f"{prefix}/checkpoint",
            headers=self.headers,
            body=b'{"label":"baseline"}',
        )
        self.assertEqual(checkpoint.status_code, 200)
        self.assertEqual(checkpoint.json()["checkpoints"][0]["label"], "baseline")

        interrupted = self.client.request(
            "POST", f"{prefix}/interrupt", headers=self.headers
        )
        self.assertEqual(interrupted.status_code, 200)
        self.assertFalse(interrupted.json()["follow_stream_active"])

        stopped = self.client.request("POST", f"{prefix}/stop", headers=self.headers)
        self.assertEqual(stopped.status_code, 200)
        self.assertFalse(stopped.json()["active"])

    def test_checkpoint_rejects_unknown_label_without_leaking_body(self) -> None:
        self.client.request(
            "POST",
            "/api/sync/follow-smoke/start",
            headers=self.headers,
        )
        response = self.client.request(
            "POST",
            "/api/sync/follow-smoke/checkpoint",
            headers=self.headers,
            body=b'{"label":"secret chat body"}',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "follow_smoke_request_invalid"})
        self.assertNotIn("secret chat body", response.body.decode("utf-8"))

    def test_follow_smoke_fails_closed_without_control(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)

        response = client.get(
            "/api/sync/follow-smoke/status",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "follow_smoke_unavailable"})


if __name__ == "__main__":
    unittest.main()
