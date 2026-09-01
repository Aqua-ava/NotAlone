"""CLI 全量增量同步协调模块的行为测试。"""

from __future__ import annotations

import unittest
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.persistence.observation_store import ObservationMode
from notalone.scopes import ContactScope
from notalone.wechat_cli import CliCommandError
from notalone.wechat_cli.models import (
    CliMessageEvent,
    MessageIdentifier,
    TailResult,
)


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")


@dataclass(frozen=True)
class FakeBinding:
    binding_id: UUID
    contact_id: UUID
    conversation_locator: str
    display_name: str

    @property
    def scope(self) -> ContactScope:
        return ContactScope(owner_id=OWNER_ID, contact_id=self.contact_id)


class FakeSessionStream:
    def __init__(self, events: list[tuple[str, str]]) -> None:
        self.events = deque(events)
        self.closed = False
        self.process_id = 60001

    def read(self, timeout: float | None = None):
        del timeout
        if self.events:
            cursor, locator = self.events.popleft()
            from notalone.wechat_cli.models import CliSessionEvent

            return CliSessionEvent(cursor=cursor, conversation_locator=locator)
        return None

    def close(self) -> None:
        self.closed = True


class FakeCli:
    def __init__(self, *, stream_events: list[tuple[str, str]]) -> None:
        self.stream_events = stream_events
        self.stream_calls = 0
        self.stream: FakeSessionStream | None = None
        self.tail_calls: list[dict[str, object]] = []
        self.tail_results: dict[str, deque[TailResult]] = {}

    def version(self) -> str:
        return "1.6.20-test"

    def session_events_follow(self, **kwargs):
        self.stream_calls += 1
        self.stream = FakeSessionStream(self.stream_events)
        return self.stream

    def tail(self, talker: str, **kwargs) -> TailResult:
        self.tail_calls.append({"talker": talker, **kwargs})
        queue = self.tail_results.setdefault(talker, deque())
        return queue.popleft() if queue else TailResult((), None, None)


class FakeObservationStore:
    def __init__(self) -> None:
        self.baselines: dict[tuple[UUID, UUID], datetime] = {}
        self.cursors: dict[tuple[UUID, UUID], object] = {}
        self.recorded: list[dict[str, object]] = []

    def ensure_baseline(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        return self.baselines.setdefault(key, kwargs["baseline_at"])

    def read_baseline(self, **kwargs):
        return self.baselines.get((kwargs["owner_id"], kwargs["contact_id"]))

    def read_cursor(self, **kwargs):
        return self.cursors.get((kwargs["owner_id"], kwargs["contact_id"]))

    def record_batch_with_messages(self, **kwargs):
        self.recorded.append(kwargs)
        from notalone.persistence.observation_store import RecordedObservationBatch

        self.cursors[(kwargs["owner_id"], kwargs["contact_id"])] = _Cursor(
            binding_id=kwargs["binding_id"],
            conversation_locator=kwargs["conversation_locator"],
            last_local_id=kwargs["last_local_id"],
            last_cursor=kwargs["last_cursor"],
        )
        return RecordedObservationBatch(
            observation=None,  # type: ignore[arg-type]
            message_ids=(),
            created_message_ids=tuple(uuid4() for _ in kwargs["messages"]),
        )


class FakeSyncState:
    def __init__(self) -> None:
        self.disabled_at: datetime | None = None
        self.enabled_at: datetime | None = None

    def read(self, **kwargs):
        del kwargs
        return self


@dataclass(frozen=True)
class _Cursor:
    binding_id: UUID
    conversation_locator: str
    last_local_id: int
    last_cursor: str


def _message(talker: str, local_id: int, text: str) -> CliMessageEvent:
    return CliMessageEvent(
        message_id=MessageIdentifier(local_id=local_id, talker=talker),
        text=text,
        kind="text",
        sender="联系人",
        sender_wxid=talker,
        is_from_me=False,
        create_time=2_000_000_000 + local_id,
        time=None,
        time_iso=None,
    )


class CliBackgroundSyncTest(unittest.TestCase):
    def setUp(self) -> None:
        self.binding_a = FakeBinding(uuid4(), uuid4(), "wxid_a", "甲")
        self.binding_b = FakeBinding(uuid4(), uuid4(), "wxid_b", "乙")
        self.bindings = [self.binding_a, self.binding_b]
        self.sync_state = FakeSyncState()
        self.cli = FakeCli(
            stream_events=[
                ("session:1", "wxid_a"),
                ("session:2", "wxid_unbound"),
                ("session:3", "wxid_b"),
            ]
        )
        self.store = FakeObservationStore()
        self.now = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 10, "后台消息"),),
                    cursor="local_id:10",
                    last_local_id=10,
                )
            ]
        )
        self.cli.tail_results["wxid_b"] = deque(
            [TailResult(events=(), cursor=None, last_local_id=None)]
        )
        self.sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=self.cli,
            bindings=self.bindings,
            observation_store=self.store,
            sync_state=self.sync_state,
            clock=lambda: self.now,
        )

    def test_one_global_stream_dispatches_only_bound_sessions(self) -> None:
        result = self.sync.cycle(enabled=True)

        self.assertEqual(self.cli.stream_calls, 1)
        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_a", "wxid_b"],
        )
        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(result.status.stream_mode, "global_follow")
        self.assertEqual(result.status.bound_count, 2)
        self.assertEqual(
            self.store.recorded[0]["mode"],
            ObservationMode.CLI_BACKGROUND,
        )

    def test_new_binding_uses_baseline_then_next_cycle_uses_contact_cursor(self) -> None:
        self.sync.cycle(enabled=True)
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 11, "第二条"),),
                    cursor="local_id:11",
                    last_local_id=11,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:4", "wxid_a"))
        self.sync.cycle(enabled=True)

        self.assertIsNone(self.cli.tail_calls[0].get("cursor"))
        self.assertEqual(
            self.cli.tail_calls[0].get("since_time"),
            (
                datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
                .astimezone()
                .replace(tzinfo=None)
                .isoformat(timespec="seconds")
            ),
        )
        self.assertEqual(self.cli.tail_calls[2].get("cursor"), "local_id:10")
        self.assertNotIn("since_time", self.cli.tail_calls[2])

    def test_global_stream_safety_sweep_reads_without_session_event(self) -> None:
        self.sync.cycle(enabled=True)
        self.cli.tail_calls.clear()
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 11, "我方发送后仍应同步"),),
                    cursor="local_id:11",
                    last_local_id=11,
                )
            ]
        )
        self.cli.tail_results["wxid_b"] = deque(
            [TailResult(events=(), cursor=None, last_local_id=None)]
        )

        # 模拟全局 sessions 流没有报告 wxid_a 的我方新消息。
        self.now += timedelta(seconds=15)
        result = self.sync.cycle(enabled=True)

        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_a", "wxid_b"],
        )
        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            self.store.cursors[(OWNER_ID, self.binding_a.contact_id)].last_local_id,
            11,
        )

    def test_global_safety_sweep_is_not_repeated_on_every_heartbeat(self) -> None:
        self.sync.cycle(enabled=True)
        self.cli.tail_calls.clear()

        # 后端心跳是 3 秒级；安全对账不能把每次心跳都变成一批 CLI
        # 子进程，否则会持续触发 macOS 跨 App 数据访问门禁。
        self.now += timedelta(seconds=1)
        self.sync.cycle(enabled=True)

        self.assertEqual(self.cli.tail_calls, [])

    def test_failed_binding_waits_for_next_round_instead_of_blocking_queue(self) -> None:
        original_tail = self.cli.tail
        failed_once = True

        def tail_with_one_failure(talker: str, **kwargs: object) -> TailResult:
            nonlocal failed_once
            if talker == "wxid_a" and failed_once:
                failed_once = False
                self.cli.tail_calls.append({"talker": talker, **kwargs})
                raise CliCommandError("cli_command_failed", "合成失败")
            return original_tail(talker, **kwargs)

        self.cli.tail = tail_with_one_failure  # type: ignore[method-assign]

        first = self.sync.cycle(enabled=True)

        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_a", "wxid_b"],
        )
        self.assertEqual(first.status.failure_code, "cli_command_failed")

        self.cli.tail_calls.clear()
        self.now += timedelta(seconds=15)
        second = self.sync.cycle(enabled=True)

        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_a", "wxid_b"],
        )
        self.assertEqual(second.batch_message_count, 1)

    def test_manual_disabled_window_skips_messages_but_advances_cursor(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync_state.disabled_at = datetime.fromtimestamp(
            2_000_000_010,
            tz=timezone.utc,
        )
        self.sync_state.enabled_at = datetime.fromtimestamp(
            2_000_000_012,
            tz=timezone.utc,
        )
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 11, "关闭期间消息"),),
                    cursor="local_id:11",
                    last_local_id=11,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:4", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.batch_message_count, 0)
        self.assertEqual(self.store.recorded[-1]["messages"], ())
        self.assertEqual(
            self.store.cursors[(OWNER_ID, self.binding_a.contact_id)].last_local_id,
            11,
        )

    def test_global_stream_failure_falls_back_to_bounded_one_shot_reads(self) -> None:
        self.cli.session_events_follow = lambda **kwargs: (_ for _ in ()).throw(
            CliCommandError("cli_follow_unsupported", "不可用")
        )

        result = self.sync.cycle(enabled=True)

        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_a", "wxid_b"],
        )
        self.assertEqual(result.status.stream_mode, "bounded_polling")
        self.assertEqual(result.status.failure_code, "cli_follow_unsupported")

    def test_disabled_cycle_closes_global_stream_and_does_not_read(self) -> None:
        self.sync.cycle(enabled=True)
        self.cli.tail_calls.clear()

        result = self.sync.cycle(enabled=False)

        self.assertTrue(self.cli.stream is not None and self.cli.stream.closed)
        self.assertEqual(self.cli.tail_calls, [])
        self.assertEqual(result.status.phase, "disabled")


if __name__ == "__main__":
    unittest.main()
