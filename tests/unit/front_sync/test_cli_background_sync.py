"""CLI 全量增量同步协调模块的行为测试。"""

from __future__ import annotations

import json
import unittest
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

from notalone.front_sync.cli_sync import CliBackgroundSync, CliSyncPhase
from notalone.persistence.observation_store import ObservationMode
from notalone.scopes import ContactScope
from notalone.wechat_cli import CliCommandError, LocalWechatCli
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
        return queue.popleft() if queue else TailResult(
            (), None, None, freshness_confirmed=True
        )


class FakeObservationStore:
    def __init__(self) -> None:
        self.baselines: dict[tuple[UUID, UUID], datetime] = {}
        self.baseline_calls: list[dict[str, object]] = []
        self.cursors: dict[tuple[UUID, UUID], object] = {}
        self.reliable_cursors: dict[tuple[UUID, UUID], object] = {}
        self.rewind_calls: list[dict[str, object]] = []
        self.recorded: list[dict[str, object]] = []

    def ensure_baseline(self, **kwargs):
        self.baseline_calls.append(kwargs)
        key = (kwargs["owner_id"], kwargs["contact_id"])
        return self.baselines.setdefault(key, kwargs["baseline_at"])

    def read_baseline(self, **kwargs):
        return self.baselines.get((kwargs["owner_id"], kwargs["contact_id"]))

    def read_cursor(self, **kwargs):
        return self.cursors.get((kwargs["owner_id"], kwargs["contact_id"]))

    def read_reliable_cursor(self, **kwargs):
        # 真实存储按 binding_id 过滤可靠游标；绑定重建后查不到旧观察。
        cursor = self.reliable_cursors.get(
            (kwargs["owner_id"], kwargs["contact_id"])
        )
        if cursor is not None and (
            getattr(cursor, "binding_id", None) != kwargs.get("binding_id")
        ):
            return None
        return cursor

    def rewind_cursor(self, **kwargs):
        self.rewind_calls.append(kwargs)
        key = (kwargs["owner_id"], kwargs["contact_id"])
        target = kwargs.get("target")
        self.cursors[key] = target

    def record_batch_with_messages(self, **kwargs):
        self.recorded.append(kwargs)
        from notalone.persistence.observation_store import RecordedObservationBatch

        self.cursors[(kwargs["owner_id"], kwargs["contact_id"])] = _Cursor(
            binding_id=kwargs["binding_id"],
            conversation_locator=kwargs["conversation_locator"],
            last_local_id=kwargs["last_local_id"],
            last_cursor=kwargs["last_cursor"],
        )
        self.reliable_cursors[(kwargs["owner_id"], kwargs["contact_id"])] = self.cursors[
            (kwargs["owner_id"], kwargs["contact_id"])
        ]
        return RecordedObservationBatch(
            observation=None,  # type: ignore[arg-type]
            message_ids=(),
            created_message_ids=tuple(uuid4() for _ in kwargs["messages"]),
        )


@dataclass(frozen=True)
class _BackfillState:
    contact_id: UUID
    phase: str
    trigger_at: datetime
    message_count: int = 0
    non_text_count: int = 0
    last_cursor: str | None = None
    failure_code: str | None = None

    @property
    def scope(self) -> ContactScope:
        return ContactScope(owner_id=OWNER_ID, contact_id=self.contact_id)


class FakeBackfillStateStore:
    """按联系人保存合成的补齐状态，模拟持久化边界。"""

    def __init__(self) -> None:
        self.states: dict[tuple[UUID, UUID], _BackfillState] = {}

    def read(self, **kwargs):
        return self.states.get((kwargs["owner_id"], kwargs["contact_id"]))

    def ensure_started(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        current = self.states.get(key)
        trigger_at = kwargs["trigger_at"]
        if current is None:
            current = _BackfillState(
                kwargs["contact_id"], "gap_detected", trigger_at
            )
        elif current.phase == "paused":
            pass
        elif current.trigger_at != trigger_at:
            current = _BackfillState(
                kwargs["contact_id"], "gap_detected", trigger_at
            )
        elif current.phase == "failed":
            current = _BackfillState(
                kwargs["contact_id"], "gap_detected", trigger_at
            )
        self.states[key] = current
        return current

    def mark_running(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        current = self.states[key]
        current = _BackfillState(
            current.contact_id,
            "backfilling",
            current.trigger_at,
            current.message_count,
            current.non_text_count,
            current.last_cursor,
        )
        self.states[key] = current
        return current

    def mark_complete(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        current = self.states[key]
        current = _BackfillState(
            current.contact_id,
            "complete",
            current.trigger_at,
            kwargs["message_count"],
            kwargs.get("non_text_count", 0),
            kwargs.get("last_cursor"),
        )
        self.states[key] = current
        return current

    def mark_failed(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        current = self.states[key]
        current = _BackfillState(
            current.contact_id,
            "failed",
            current.trigger_at,
            current.message_count,
            current.non_text_count,
            current.last_cursor,
            kwargs["failure_code"],
        )
        self.states[key] = current
        return current

    def list_active(self, **kwargs):
        del kwargs
        return tuple(self.states.values())

    def mark_incomplete(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        current = self.states[key]
        current = _BackfillState(
            current.contact_id,
            "incomplete",
            current.trigger_at,
            current.message_count,
            current.non_text_count,
            current.last_cursor,
            kwargs["failure_code"],
        )
        self.states[key] = current
        return current

    def mark_paused(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        current = self.states[key]
        current = _BackfillState(
            current.contact_id,
            "paused",
            current.trigger_at,
            current.message_count,
            current.non_text_count,
            current.last_cursor,
            current.failure_code,
        )
        self.states[key] = current
        return current

    def mark_retry(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        current = self.states[key]
        current = _BackfillState(
            current.contact_id,
            "gap_detected",
            kwargs["trigger_at"],
        )
        self.states[key] = current
        return current


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
        self.backfill_store = FakeBackfillStateStore()
        self.now = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 10, "后台消息"),),
                    cursor="local_id:10",
                    last_local_id=10,
                    freshness_confirmed=True,
                )
            ]
        )
        self.cli.tail_results["wxid_b"] = deque(
            [
                TailResult(
                    events=(),
                    cursor=None,
                    last_local_id=None,
                    freshness_confirmed=True,
                )
            ]
        )
        self.sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=self.cli,
            bindings=self.bindings,
            observation_store=self.store,
            backfill_state=self.backfill_store,
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

    def test_current_contact_is_first_in_a_bounded_initial_queue(self) -> None:
        result = self.sync.cycle(
            enabled=True,
            priority_contact_id=self.binding_b.contact_id,
        )

        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_b", "wxid_a"],
        )
        self.assertEqual(result.status.bound_count, 2)
        self.assertEqual(result.status.backfill_contact_id, self.binding_b.contact_id)

    def test_round_robin_keeps_non_priority_contacts_progressing(self) -> None:
        bindings = [
            FakeBinding(uuid4(), uuid4(), f"wxid_{index}", f"联系人{index}")
            for index in range(10)
        ]
        cli = FakeCli(stream_events=[])
        store = FakeObservationStore()
        backfill_store = FakeBackfillStateStore()
        sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=cli,
            bindings=bindings,
            observation_store=store,
            backfill_state=backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now,
        )

        sync.cycle(enabled=True, priority_contact_id=bindings[0].contact_id)
        cli.tail_calls.clear()
        self.now += timedelta(seconds=15)
        sync.cycle(enabled=True, priority_contact_id=bindings[0].contact_id)
        first_sweep = [call["talker"] for call in cli.tail_calls]
        cli.tail_calls.clear()
        self.now += timedelta(seconds=15)
        sync.cycle(enabled=True, priority_contact_id=bindings[0].contact_id)
        second_sweep = [call["talker"] for call in cli.tail_calls]

        self.assertEqual(first_sweep[0], "wxid_0")
        self.assertEqual(second_sweep[0], "wxid_0")
        self.assertNotEqual(set(first_sweep[1:]), set(second_sweep[1:]))
        self.assertEqual(set(first_sweep[1:]) | set(second_sweep[1:]), {
            f"wxid_{index}" for index in range(1, 10)
        })

    def test_backfill_check_does_not_requeue_completed_contacts(self) -> None:
        bindings = [
            FakeBinding(uuid4(), uuid4(), f"wxid_{index}", f"联系人{index}")
            for index in range(33)
        ]
        cli = FakeCli(stream_events=[])
        store = FakeObservationStore()
        backfill_store = FakeBackfillStateStore()
        sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=cli,
            bindings=bindings,
            observation_store=store,
            backfill_state=backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now,
        )

        first = sync.cycle(enabled=True)
        second = sync.cycle(enabled=True)

        self.assertEqual(first.status.pending_count, 1)
        self.assertEqual(second.status.pending_count, 0)
        self.assertEqual(second.status.backfill_phase, "complete")
        self.assertEqual(second.status.backfill_completed_contacts, 33)
        self.assertEqual(len(cli.tail_calls), 33)

    def test_baseline_is_checked_once_per_binding_across_heartbeats(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.cycle(enabled=True)

        self.assertEqual(
            [call["conversation_locator"] for call in self.store.baseline_calls],
            ["wxid_a", "wxid_b"],
        )

    def test_new_binding_uses_baseline_then_next_cycle_uses_contact_cursor(self) -> None:
        self.sync.cycle(enabled=True)
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 11, "第二条"),),
                    cursor="local_id:11",
                    last_local_id=11,
                    freshness_confirmed=True,
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
                    freshness_confirmed=True,
                )
            ]
        )
        self.cli.tail_results["wxid_b"] = deque(
            [
                TailResult(
                    events=(),
                    cursor=None,
                    last_local_id=None,
                    freshness_confirmed=True,
                )
            ]
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

    def test_reopened_sync_backfills_messages_from_disabled_window(self) -> None:
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
                    freshness_confirmed=True,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:4", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            self.store.recorded[-1]["messages"][0].text_content,
            "关闭期间消息",
        )
        self.assertEqual(
            self.store.cursors[(OWNER_ID, self.binding_a.contact_id)].last_local_id,
            11,
        )
        self.assertEqual(result.status.backfill_phase, "complete")
        self.assertEqual(result.status.backfill_contact_id, self.binding_a.contact_id)
        self.assertEqual(result.status.backfill_message_count, 1)

    def test_stale_cursor_rewinds_to_last_reliable_position_before_tail(self) -> None:
        self.sync.cycle(enabled=True)
        reliable = self.store.reliable_cursors[(OWNER_ID, self.binding_a.contact_id)]
        self.store.cursors[(OWNER_ID, self.binding_a.contact_id)] = _Cursor(
            binding_id=self.binding_a.binding_id,
            conversation_locator="wxid_a",
            last_local_id=20,
            last_cursor="local_id:20",
        )
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 11, "回放消息"),),
                    cursor="local_id:11",
                    last_local_id=11,
                    freshness_confirmed=True,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:4", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(self.cli.tail_calls[-1].get("cursor"), "local_id:10")
        self.assertEqual(self.store.rewind_calls[-1]["target"], reliable)
        self.assertEqual(
            self.store.recorded[-1]["since_cursor"],
            "local_id:10",
        )

    def test_non_text_events_are_counted_without_becoming_text_messages(self) -> None:
        self.sync.cycle(enabled=True)
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 12, "后续文字"),),
                    cursor="local_id:12",
                    last_local_id=12,
                    event_count=2,
                    non_text_count=1,
                    freshness_confirmed=True,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:4", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        recorded = self.store.recorded[-1]
        self.assertEqual(recorded["event_count"], 2)
        self.assertEqual(recorded["non_text_count"], 1)
        self.assertEqual(len(recorded["messages"]), 1)
        self.assertEqual(recorded["messages"][0].text_content, "后续文字")
        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(result.status.backfill_message_count, 1)

    def test_backfill_failure_is_visible_and_not_complete(self) -> None:
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
                    events=(_message("wxid_a", 11, "补齐失败消息"),),
                    cursor="local_id:11",
                    last_local_id=11,
                    freshness_confirmed=True,
                )
            ]
        )
        original_tail = self.cli.tail

        def fail_backfill_once(talker: str, **kwargs: object) -> TailResult:
            if talker == "wxid_a":
                self.cli.tail = original_tail  # type: ignore[method-assign]
                raise CliCommandError("cli_command_failed", "合成失败")
            return original_tail(talker, **kwargs)

        self.cli.tail = fail_backfill_once  # type: ignore[method-assign]
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:4", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.status.backfill_phase, "failed")
        self.assertEqual(result.status.backfill_failure_code, "cli_command_failed")
        self.assertNotEqual(result.status.backfill_phase, "complete")

    def test_empty_live_poll_without_freshness_is_a_healthy_noop(self) -> None:
        # 真实适配器对"没有新消息"的一次性 tail 输出为空，且
        # freshness_confirmed=False；常规 live 轮询的空结果是正常稳态，
        # 必须保持既有水位，不能当成 cli_freshness_unknown 失败。
        self.sync.cycle(enabled=True)
        self.cli.tail_results["wxid_a"] = deque(
            [TailResult(events=(), cursor=None, last_local_id=None)]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:5", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertIsNone(result.status.failure_code)
        self.assertEqual(result.status.phase, CliSyncPhase.ACTIVE)

    def test_cli_unavailable_marks_backfill_incomplete(self) -> None:
        original_tail = self.cli.tail

        def unavailable_tail(talker: str, **kwargs: object) -> TailResult:
            if talker == "wxid_a":
                self.cli.tail_calls.append({"talker": talker, **kwargs})
                raise CliCommandError("cli_not_found", "不可用")
            return original_tail(talker, **kwargs)

        self.cli.tail = unavailable_tail  # type: ignore[method-assign]

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.status.backfill_phase, "incomplete")
        self.assertEqual(result.status.backfill_incomplete_contacts, 1)
        self.assertEqual(result.status.backfill_failure_code, "cli_not_found")
        self.assertNotEqual(result.status.backfill_phase, "complete")

    def test_unknown_cli_freshness_marks_backfill_incomplete(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.request_backfill_check()
        self.cli.tail_results["wxid_a"] = deque(
            [TailResult(events=(), cursor=None, last_local_id=None)]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:freshness", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.status.backfill_phase, "incomplete")
        self.assertEqual(result.status.backfill_incomplete_contacts, 1)
        self.assertEqual(
            result.status.backfill_failure_code,
            "cli_freshness_unknown",
        )
        self.assertNotEqual(result.status.backfill_phase, "complete")

    def test_missing_table_keeps_coverage_incomplete_and_other_contact_syncing(self) -> None:
        original_tail = self.cli.tail
        missing_table_cli = LocalWechatCli(
            runner=lambda command: SimpleNamespace(
                returncode=1,
                stdout=json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "code": "tool_error",
                            "message": "table Msg_synthetic not found in 9 message shards",
                        },
                    }
                ),
                stderr="",
            )
        )

        def scoped_tail(talker: str, **kwargs: object) -> TailResult:
            if talker == "wxid_a":
                self.cli.tail_calls.append({"talker": talker, **kwargs})
                return missing_table_cli.tail(talker, **kwargs)
            return original_tail(talker, **kwargs)

        self.cli.tail = scoped_tail  # type: ignore[method-assign]
        self.cli.tail_results["wxid_b"] = deque(
            [
                TailResult(
                    events=(_message("wxid_b", 20, "乙的合成新消息"),),
                    cursor="local_id:20",
                    last_local_id=20,
                    freshness_confirmed=True,
                )
            ]
        )

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.status.backfill_phase, "incomplete")
        self.assertEqual(result.status.backfill_incomplete_contacts, 1)
        self.assertEqual(result.status.backfill_failed_contacts, 0)
        self.assertEqual(
            result.status.backfill_failure_code, "cli_message_table_missing"
        )
        self.assertEqual(result.batch_message_count, 1)
        self.assertTrue(result.status.stream_active)
        self.assertNotIn((OWNER_ID, self.binding_a.contact_id), self.store.cursors)
        self.assertEqual(len(self.store.recorded), 1)
        self.assertEqual(self.store.recorded[0]["contact_id"], self.binding_b.contact_id)

    def test_paused_backfill_stays_paused_after_sync_restart(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.request_backfill_check()
        self.sync.pause_backfill()

        restarted = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=self.cli,
            bindings=self.bindings,
            observation_store=self.store,
            backfill_state=self.backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now + timedelta(seconds=30),
        )
        self.cli.tail_calls.clear()

        result = restarted.cycle(enabled=True)

        self.assertEqual(result.status.backfill_phase, "paused")
        self.assertEqual(self.cli.tail_calls, [])

    def test_paused_backfill_still_reads_a_live_session_event(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.request_backfill_check()
        self.sync.pause_backfill()
        self.cli.tail_calls.clear()
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 11, "暂停补齐后实时消息"),),
                    cursor="local_id:11",
                    last_local_id=11,
                    freshness_confirmed=True,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:live-after-pause", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            self.store.cursors[(OWNER_ID, self.binding_a.contact_id)].last_local_id,
            11,
        )
        self.assertEqual(
            self.backfill_store.states[(OWNER_ID, self.binding_a.contact_id)].phase,
            "paused",
        )

    def test_paused_backfill_still_reads_a_safety_sweep(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.request_backfill_check()
        self.sync.pause_backfill()
        self.cli.tail_calls.clear()
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 12, "暂停补齐后对账消息"),),
                    cursor="local_id:12",
                    last_local_id=12,
                    freshness_confirmed=True,
                )
            ]
        )

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            self.store.cursors[(OWNER_ID, self.binding_a.contact_id)].last_local_id,
            12,
        )
        self.assertEqual(
            self.backfill_store.states[(OWNER_ID, self.binding_a.contact_id)].phase,
            "paused",
        )

    def test_paused_backfill_priority_contact_still_reads_safety_sweep(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.request_backfill_check()
        self.sync.pause_backfill()
        self.cli.tail_calls.clear()
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 14, "暂停补齐后当前联系人消息"),),
                    cursor="local_id:14",
                    last_local_id=14,
                    freshness_confirmed=True,
                )
            ]
        )

        result = self.sync.cycle(
            enabled=True,
            priority_contact_id=self.binding_a.contact_id,
        )

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(self.cli.tail_calls[0]["talker"], "wxid_a")
        self.assertEqual(
            self.store.cursors[(OWNER_ID, self.binding_a.contact_id)].last_local_id,
            14,
        )
        self.assertEqual(
            self.backfill_store.states[(OWNER_ID, self.binding_a.contact_id)].phase,
            "paused",
        )

    def test_priority_contact_already_pending_is_promoted_to_live_read(self) -> None:
        bindings = [
            FakeBinding(uuid4(), uuid4(), f"wxid_{index}", f"联系人{index}")
            for index in range(33)
        ]
        cli = FakeCli(stream_events=[])
        store = FakeObservationStore()
        backfill_store = FakeBackfillStateStore()
        priority = bindings[-1]
        backfill_store.states[(OWNER_ID, priority.contact_id)] = _BackfillState(
            priority.contact_id,
            "paused",
            self.now,
        )
        cli.tail_results[priority.conversation_locator] = deque(
            [
                TailResult(
                    events=(
                        _message(
                            priority.conversation_locator,
                            14,
                            "队列中的当前联系人消息",
                        ),
                    ),
                    cursor="local_id:14",
                    last_local_id=14,
                    freshness_confirmed=True,
                )
            ]
        )
        sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=cli,
            bindings=bindings,
            observation_store=store,
            backfill_state=backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now,
        )

        sync.cycle(enabled=True)
        result = sync.cycle(
            enabled=True,
            priority_contact_id=priority.contact_id,
        )

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            store.cursors[(OWNER_ID, priority.contact_id)].last_local_id,
            14,
        )
        self.assertEqual(
            backfill_store.states[(OWNER_ID, priority.contact_id)].phase,
            "paused",
        )

    def test_priority_contact_is_polled_every_three_seconds_without_round_robin_wait(
        self,
    ) -> None:
        bindings = [
            FakeBinding(uuid4(), uuid4(), f"wxid_{index}", f"联系人{index}")
            for index in range(10)
        ]
        cli = FakeCli(stream_events=[])
        store = FakeObservationStore()
        backfill_store = FakeBackfillStateStore()
        sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=cli,
            bindings=bindings,
            observation_store=store,
            backfill_state=backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now,
        )

        sync.cycle(enabled=True, priority_contact_id=bindings[0].contact_id)
        cli.tail_calls.clear()

        self.now += timedelta(seconds=2)
        sync.cycle(enabled=True, priority_contact_id=bindings[0].contact_id)
        self.assertEqual(cli.tail_calls, [])

        self.now += timedelta(seconds=1)
        cli.tail_results["wxid_0"] = deque(
            [
                TailResult(
                    events=(_message("wxid_0", 14, "当前联系人三秒读取"),),
                    cursor="local_id:14",
                    last_local_id=14,
                    freshness_confirmed=True,
                )
            ]
        )
        result = sync.cycle(
            enabled=True,
            priority_contact_id=bindings[0].contact_id,
        )

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            [call["talker"] for call in cli.tail_calls],
            ["wxid_0"],
        )
        self.assertEqual(
            store.cursors[(OWNER_ID, bindings[0].contact_id)].last_local_id,
            14,
        )

    def test_backfill_read_does_not_delay_next_priority_live_read(self) -> None:
        bindings = [
            FakeBinding(uuid4(), uuid4(), f"wxid_{index}", f"联系人{index}")
            for index in range(2)
        ]
        cli = FakeCli(stream_events=[])
        store = FakeObservationStore()
        backfill_store = FakeBackfillStateStore()
        priority = bindings[0]
        sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=cli,
            bindings=bindings,
            observation_store=store,
            backfill_state=backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now,
        )

        sync.cycle(enabled=True, priority_contact_id=priority.contact_id)
        self.now += timedelta(seconds=2)
        sync.request_backfill_check()
        sync.cycle(enabled=True, priority_contact_id=priority.contact_id)
        cli.tail_calls.clear()
        cli.tail_results[priority.conversation_locator] = deque(
            [
                TailResult(
                    events=(_message(priority.conversation_locator, 14, "live 到期"),),
                    cursor="local_id:14",
                    last_local_id=14,
                    freshness_confirmed=True,
                )
            ]
        )
        self.now += timedelta(seconds=1)

        result = sync.cycle(
            enabled=True,
            priority_contact_id=priority.contact_id,
        )

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            [call["talker"] for call in cli.tail_calls],
            [priority.conversation_locator],
        )

    def test_priority_live_read_does_not_reopen_completed_backfill_while_other_contacts_pending(
        self,
    ) -> None:
        bindings = [
            FakeBinding(uuid4(), uuid4(), f"wxid_{index}", f"联系人{index}")
            for index in range(33)
        ]
        cli = FakeCli(stream_events=[])
        store = FakeObservationStore()
        backfill_store = FakeBackfillStateStore()
        priority = bindings[-1]
        sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=cli,
            bindings=bindings,
            observation_store=store,
            backfill_state=backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now,
        )

        sync.cycle(
            enabled=True,
            priority_contact_id=priority.contact_id,
        )
        self.assertEqual(
            backfill_store.states[(OWNER_ID, priority.contact_id)].phase,
            "complete",
        )
        self.now += timedelta(seconds=3)
        cli.tail_results[priority.conversation_locator] = deque(
            [
                TailResult(
                    events=(
                        _message(
                            priority.conversation_locator,
                            14,
                            "生命周期保护",
                        ),
                    ),
                    cursor="local_id:14",
                    last_local_id=14,
                    freshness_confirmed=True,
                )
            ]
        )

        result = sync.cycle(
            enabled=True,
            priority_contact_id=priority.contact_id,
        )

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            store.cursors[(OWNER_ID, priority.contact_id)].last_local_id,
            14,
        )
        priority_state = backfill_store.states[(OWNER_ID, priority.contact_id)]
        self.assertEqual(priority_state.phase, "complete")
        self.assertEqual(priority_state.message_count, 0)

    def test_pause_then_retry_resumes_from_a_new_bounded_check(self) -> None:
        self.sync.cycle(enabled=True)
        self.sync.request_backfill_check()
        self.sync.pause_backfill()
        self.cli.tail_calls.clear()

        paused = self.sync.cycle(enabled=True)

        self.assertEqual(paused.status.backfill_phase, "paused")
        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_a", "wxid_b"],
        )

        self.sync.retry_backfill()
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 13, "重试后消息"),),
                    cursor="local_id:13",
                    last_local_id=13,
                    freshness_confirmed=True,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:retry", "wxid_a"))

        resumed = self.sync.cycle(enabled=True)

        self.assertEqual(resumed.status.backfill_phase, "complete")
        self.assertEqual(resumed.status.backfill_total_contacts, 2)
        self.assertEqual(resumed.status.backfill_total_message_count, 1)

    def test_paused_failed_backfill_does_not_reenter_running(self) -> None:
        self.sync.cycle(enabled=True)
        failed_contact = self.bindings[0].contact_id
        self.backfill_store.states[(OWNER_ID, failed_contact)] = _BackfillState(
            failed_contact,
            "failed",
            self.now,
            failure_code="cli_command_failed",
        )
        self.sync.request_backfill_check()
        self.sync.pause_backfill()
        self.cli.tail_calls.clear()

        result = self.sync.cycle(enabled=True)

        self.assertEqual(
            self.backfill_store.states[(OWNER_ID, failed_contact)].phase,
            "failed",
        )
        self.assertEqual(
            [call["talker"] for call in self.cli.tail_calls],
            ["wxid_a", "wxid_b"],
        )
        self.assertEqual(result.status.backfill_phase, "failed")

    def test_failed_backfill_state_is_not_reopened_by_a_live_read(self) -> None:
        self.sync.cycle(enabled=True)
        failed_contact = self.bindings[0].contact_id
        self.backfill_store.states[(OWNER_ID, failed_contact)] = _BackfillState(
            failed_contact,
            "failed",
            self.now,
            failure_code="cli_command_failed",
        )
        self.cli.tail_results["wxid_a"] = deque(
            [
                TailResult(
                    events=(_message("wxid_a", 11, "失败状态下的实时消息"),),
                    cursor="local_id:11",
                    last_local_id=11,
                    freshness_confirmed=True,
                )
            ]
        )
        assert self.cli.stream is not None
        self.cli.stream.events.append(("session:live-after-failure", "wxid_a"))

        result = self.sync.cycle(enabled=True)

        self.assertEqual(result.batch_message_count, 1)
        self.assertEqual(
            self.backfill_store.states[(OWNER_ID, failed_contact)].phase,
            "failed",
        )

    def test_failed_backfill_survives_sweep_when_disabled_window_present(self) -> None:
        # disable→enable 之后关闭窗口在本进程生命周期恒存在；安全对账
        # 不能因为它反复把失败补齐重置重试（旧状态会每轮
        # GAP→BACKFILLING→失败/完成 震荡，审计计数不断被清零）。
        clock_value = [self.now]
        sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=self.cli,
            bindings=self.bindings,
            observation_store=self.store,
            backfill_state=self.backfill_store,
            sync_state=self.sync_state,
            clock=lambda: clock_value[0],
        )
        sync.cycle(enabled=True)
        failed_contact = self.bindings[0].contact_id
        self.backfill_store.states[(OWNER_ID, failed_contact)] = _BackfillState(
            failed_contact,
            "failed",
            self.now,
            failure_code="cli_command_failed",
        )
        self.sync_state.disabled_at = datetime.fromtimestamp(
            2_000_000_010,
            tz=timezone.utc,
        )
        self.sync_state.enabled_at = datetime.fromtimestamp(
            2_000_000_012,
            tz=timezone.utc,
        )
        clock_value[0] = self.now + timedelta(seconds=30)
        self.cli.tail_calls.clear()

        sync.cycle(enabled=True)

        failed_state = self.backfill_store.states[
            (OWNER_ID, failed_contact)
        ]
        self.assertEqual(failed_state.phase, "failed")
        self.assertEqual(failed_state.failure_code, "cli_command_failed")
        self.assertIn("wxid_a", [call["talker"] for call in self.cli.tail_calls])

    def test_recreated_binding_keeps_cursor_for_same_locator(self) -> None:
        # 撤销并重建绑定（新 binding_id）后，同一会话定位的既有游标
        # 仍是真实观察位置：继续用它读取，不回退删除游标并跳到
        # "现在"的 baseline，避免两个水位之间的消息成为永久空洞。
        self.sync.cycle(enabled=True)
        self.store.rewind_calls.clear()
        reborn_binding = FakeBinding(
            uuid4(),
            self.binding_a.contact_id,
            "wxid_a",
            "甲",
        )
        restarted = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=self.cli,
            bindings=[reborn_binding],
            observation_store=self.store,
            backfill_state=self.backfill_store,
            sync_state=self.sync_state,
            clock=lambda: self.now + timedelta(seconds=30),
        )
        self.cli.tail_calls.clear()

        restarted.cycle(enabled=True)

        reborn_calls = [
            call for call in self.cli.tail_calls if call["talker"] == "wxid_a"
        ]
        self.assertEqual(
            len(reborn_calls),
            1,
        )
        self.assertEqual(reborn_calls[-1].get("cursor"), "local_id:10")
        self.assertNotIn("since_time", reborn_calls[-1])
        self.assertEqual(self.store.rewind_calls, [])

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
