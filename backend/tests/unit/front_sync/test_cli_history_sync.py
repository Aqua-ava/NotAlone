"""首绑完整历史同步引擎的行为测试；外部 CLI 与存储均为合成边界。"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4
import unittest

from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.persistence.history_sync_state import (
    HistorySyncPhase,
    HistorySyncState,
)
from notalone.persistence.observation_store import (
    ObservationPersistenceError,
    RecordedObservationBatch,
)
from notalone.scopes import ContactScope
from notalone.wechat_cli import CliCommandError, LocalWechatCli
from notalone.wechat_cli.models import (
    CliMessageEvent,
    MessageIdentifier,
    TailResult,
)


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
BINDING_ID = UUID("33333333-3333-3333-3333-333333333333")
NOW = datetime(2026, 10, 23, 9, tzinfo=timezone.utc)


@dataclass(frozen=True)
class FakeBinding:
    binding_id: UUID
    contact_id: UUID
    conversation_locator: str = "wxid_synthetic_history"
    display_name: str = "合成历史联系人"

    @property
    def scope(self) -> ContactScope:
        return ContactScope(owner_id=OWNER_ID, contact_id=self.contact_id)


class FakeAuthorization:
    def __init__(self, allowed: bool = True) -> None:
        self.allowed = allowed
        self.calls = 0

    def history_sync_authorized(self, **kwargs) -> bool:
        del kwargs
        self.calls += 1
        return self.allowed


def _event(local_id: int, *, create_time: int | None = None) -> CliMessageEvent:
    return CliMessageEvent(
        message_id=MessageIdentifier(local_id, "wxid_synthetic_history"),
        text=f"合成历史消息 {local_id}",
        kind="text",
        sender="合成联系人",
        sender_wxid=None,
        is_from_me=False,
        create_time=create_time if create_time is not None else 1_790_000_000 + local_id,
        time=None,
        time_iso=None,
    )


def _page(
    local_ids: range | tuple[int, ...],
    *,
    has_more: bool,
    cursor: str | None,
    create_time: int | None = None,
    local_history_state: str | None = None,
) -> TailResult:
    events = tuple(_event(number, create_time=create_time) for number in local_ids)
    if not events:
        return TailResult(
            events=(),
            cursor=None,
            last_local_id=None,
            freshness_confirmed=True,
            local_history_state=local_history_state,
        )
    return TailResult(
        events=events,
        cursor=cursor,
        last_local_id=events[-1].message_id.local_id,
        event_count=len(events),
        non_text_count=0,
        freshness_confirmed=True,
        has_more=has_more,
        local_history_state=local_history_state,
    )


class _EmptyStream:
    def __init__(self) -> None:
        self.closed = False
        self.process_id = 1

    def read(self, timeout: float | None = None):
        del timeout
        return None

    def close(self) -> None:
        self.closed = True


class FakeHistoryCli:
    """按历史游标返回合成页；增量读取单独记录。"""

    def __init__(self) -> None:
        self.history_pages: dict[str | None, TailResult] = {}
        self.incremental_pages: dict[tuple[str, str | None], TailResult] = {}
        self.calls: list[dict[str, object]] = []
        self.errors: dict[str | None, Exception] = {}

    def version(self, *, timeout_seconds: float | None = None) -> str:
        del timeout_seconds
        return "synthetic-history"

    def session_events_follow(self, **kwargs):
        del kwargs
        return _EmptyStream()

    def tail(self, talker: str, **kwargs) -> TailResult:
        self.calls.append({"talker": talker, **kwargs})
        if kwargs.get("history"):
            cursor = kwargs.get("cursor")
            if cursor in self.errors:
                raise self.errors[cursor]
            return self.history_pages[cursor]
        key = (kwargs.get("cursor"), kwargs.get("since_time"))
        return self.incremental_pages.get(
            key, TailResult((), None, None, freshness_confirmed=True)
        )


class FakeHistoryStateStore:
    """模拟按 owner+contact+binding 保存的历史覆盖状态。"""

    def __init__(self) -> None:
        self.states: dict[UUID, HistorySyncState] = {}
        self.bindings: list[FakeBinding] = []
        self.ensure_calls: list[dict[str, object]] = []
        self.incomplete_calls: list[dict[str, object]] = []
        self.checkpoints: list[dict[str, object]] = []

    def ensure_scope_started(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        watermark_at: datetime,
    ) -> int:
        self.ensure_calls.append(
            {
                "owner_id": owner_id,
                "channel": channel,
                "account_scope": account_scope,
                "watermark_at": watermark_at,
            }
        )
        created = 0
        for binding in self.bindings:
            if binding.binding_id in self.states:
                continue
            self.states[binding.binding_id] = HistorySyncState(
                scope=ContactScope(
                    owner_id=owner_id, contact_id=binding.contact_id
                ),
                binding_id=binding.binding_id,
                phase=HistorySyncPhase.SYNCING,
                watermark_at=watermark_at,
                message_count=0,
                non_text_count=0,
                page_count=0,
                last_local_id=None,
                last_cursor=None,
                failure_code=None,
                started_at=watermark_at,
                completed_at=None,
                updated_at=watermark_at,
            )
            created += 1
        return created

    def read(self, *, owner_id: UUID, contact_id: UUID, binding_id: UUID):
        del owner_id, contact_id
        return self.states.get(binding_id)

    def list_active(self, *, owner_id: UUID, channel: str, account_scope: str):
        del owner_id, channel, account_scope
        return tuple(self.states.values())

    def mark_running(self, *, owner_id: UUID, contact_id: UUID, binding_id: UUID):
        del owner_id, contact_id
        state = self.states[binding_id]
        state = replace(state, phase=HistorySyncPhase.SYNCING, failure_code=None)
        self.states[binding_id] = state
        return state

    def mark_incomplete(
        self, *, owner_id: UUID, contact_id: UUID, binding_id: UUID, failure_code: str
    ):
        del owner_id, contact_id
        self.incomplete_calls.append(
            {"binding_id": binding_id, "failure_code": failure_code}
        )
        state = self.states[binding_id]
        state = replace(
            state,
            phase=HistorySyncPhase.INCOMPLETE,
            failure_code=failure_code,
        )
        self.states[binding_id] = state
        return state

    def apply_checkpoint(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        checkpoint,
        now: datetime,
    ) -> HistorySyncState:
        del owner_id, contact_id
        self.checkpoints.append(
            {"binding_id": binding_id, "checkpoint": checkpoint}
        )
        state = self.states[binding_id]
        state = replace(
            state,
            phase=(
                HistorySyncPhase.COMPLETE
                if checkpoint.complete
                else HistorySyncPhase.SYNCING
            ),
            message_count=state.message_count + checkpoint.message_count,
            non_text_count=state.non_text_count + checkpoint.non_text_count,
            page_count=state.page_count + 1,
            last_local_id=checkpoint.last_local_id,
            last_cursor=checkpoint.last_cursor,
            failure_code=None,
            completed_at=now if checkpoint.complete else None,
            updated_at=now,
        )
        self.states[binding_id] = state
        return state


@dataclass(frozen=True)
class _Cursor:
    binding_id: UUID
    conversation_locator: str
    last_local_id: int
    last_cursor: str


class FakeObservationStore:
    def __init__(self, history: FakeHistoryStateStore, clock) -> None:
        self.history = history
        self.clock = clock
        self.baselines: dict[tuple[UUID, UUID], datetime] = {}
        self.cursors: dict[tuple[UUID, UUID], _Cursor] = {}
        self.reliable_cursors: dict[tuple[UUID, UUID], _Cursor] = {}
        self.recorded: list[dict[str, object]] = []
        self.fail_next_write = False

    def ensure_baseline(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        return self.baselines.setdefault(key, kwargs["baseline_at"])

    def read_baseline(self, **kwargs):
        return self.baselines.get((kwargs["owner_id"], kwargs["contact_id"]))

    def read_cursor(self, **kwargs):
        return self.cursors.get((kwargs["owner_id"], kwargs["contact_id"]))

    def read_reliable_cursor(self, **kwargs):
        cursor = self.reliable_cursors.get(
            (kwargs["owner_id"], kwargs["contact_id"])
        )
        if cursor is not None and cursor.binding_id != kwargs.get("binding_id"):
            return None
        return cursor

    def rewind_cursor(self, **kwargs):
        key = (kwargs["owner_id"], kwargs["contact_id"])
        self.cursors[key] = kwargs.get("target")

    def record_batch_with_messages(self, **kwargs):
        if self.fail_next_write:
            self.fail_next_write = False
            raise ObservationPersistenceError("合成写入失败")
        self.recorded.append(dict(kwargs))
        create = kwargs.get("created_message_ids")
        del create
        counts = kwargs.get("messages", ())
        checkpoint = kwargs.get("history_checkpoint")
        if checkpoint is not None:
            self.history.apply_checkpoint(
                owner_id=kwargs["owner_id"],
                contact_id=kwargs["contact_id"],
                binding_id=kwargs["binding_id"],
                checkpoint=checkpoint,
                now=self.clock(),
            )
            if checkpoint.complete:
                key = (kwargs["owner_id"], kwargs["contact_id"])
                self.cursors[key] = _Cursor(
                    binding_id=kwargs["binding_id"],
                    conversation_locator=kwargs["conversation_locator"],
                    last_local_id=checkpoint.last_local_id,
                    last_cursor=checkpoint.last_cursor,
                )
        if kwargs.get("advance_cursor", True):
            key = (kwargs["owner_id"], kwargs["contact_id"])
            cursor = _Cursor(
                binding_id=kwargs["binding_id"],
                conversation_locator=kwargs["conversation_locator"],
                last_local_id=kwargs["last_local_id"],
                last_cursor=kwargs["last_cursor"],
            )
            self.cursors[key] = cursor
            self.reliable_cursors[key] = cursor
        return RecordedObservationBatch(
            observation=SimpleNamespace(
                observation_id=uuid4(),
                last_local_id=kwargs["last_local_id"],
                last_cursor=kwargs["last_cursor"],
            ),
            message_ids=tuple(uuid4() for _ in counts),
            created_message_ids=tuple(uuid4() for _ in counts),
            source_created=True,
        )


class HistorySyncEngineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = NOW
        self.binding = FakeBinding(BINDING_ID, CONTACT_ID)
        self.history = FakeHistoryStateStore()
        self.observations = FakeObservationStore(self.history, lambda: self.now)
        self.cli = FakeHistoryCli()
        self.authorization = FakeAuthorization()
        self.sync = self.make_sync()

    def make_sync(self, *, bindings=None, authorized: bool = True):
        self.history.bindings = list([self.binding] if bindings is None else bindings)
        self.sync = CliBackgroundSync(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="synthetic-account",
            cli=self.cli,
            bindings=[self.binding] if bindings is None else bindings,
            observation_store=self.observations,
            history_state=self.history,
            history_authorization=self.authorization if authorized else None,
            clock=lambda: self.now,
        )
        return self.sync

    def test_authorized_binding_starts_history_from_the_earliest_page(self) -> None:
        self.cli.history_pages[None] = _page(range(1, 4), has_more=True, cursor="local_id:3")
        result = self.sync.cycle(enabled=True)

        self.assertEqual(len(self.history.ensure_calls), 1)
        self.assertEqual(self.history.ensure_calls[0]["watermark_at"], NOW)
        self.assertEqual(self.history.ensure_calls[0]["account_scope"], "synthetic-account")
        history_call = self.cli.calls[0]
        self.assertTrue(history_call["history"])
        self.assertNotIn("cursor", history_call)
        self.assertNotIn("since_time", history_call)
        self.assertEqual(result.batch_message_count, 3)
        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.SYNCING)
        self.assertEqual(state.message_count, 3)
        self.assertEqual(state.last_cursor, "local_id:3")
        self.assertFalse(self.observations.recorded[0]["advance_cursor"])
        self.assertFalse(self.observations.recorded[0]["is_reliable"])

    def test_continuation_uses_committed_checkpoint_and_completes(self) -> None:
        self.cli.history_pages[None] = _page(range(1, 3), has_more=True, cursor="local_id:2")
        self.cli.history_pages["local_id:2"] = _page(
            range(3, 5), has_more=False, cursor="local_id:4"
        )
        self.sync.cycle(enabled=True)
        result = self.sync.cycle(enabled=True)

        self.assertEqual(self.cli.calls[1]["cursor"], "local_id:2")
        self.assertEqual(result.batch_message_count, 2)
        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(state.message_count, 4)
        self.assertEqual(state.page_count, 2)
        self.assertEqual(self.observations.cursors[(OWNER_ID, CONTACT_ID)].last_cursor, "local_id:4")
        coverage = result.status.history_coverages[0]
        self.assertEqual(coverage.phase, "complete")

    def test_unauthorized_binding_never_reads_history(self) -> None:
        self.authorization.allowed = False
        result = self.sync.cycle(enabled=True)

        self.assertEqual(self.history.ensure_calls, [])
        self.assertFalse(any(call.get("history") for call in self.cli.calls))
        self.assertEqual(result.status.history_coverages[0].phase, "not_started")

    def test_restart_resumes_from_persisted_checkpoint(self) -> None:
        self.cli.history_pages[None] = _page(range(1, 3), has_more=True, cursor="local_id:2")
        self.cli.history_pages["local_id:2"] = _page(
            range(3, 5), has_more=False, cursor="local_id:4"
        )
        self.sync.cycle(enabled=True)
        restarted = self.make_sync()
        result = restarted.cycle(enabled=True)

        self.assertEqual(self.cli.calls[1]["cursor"], "local_id:2")
        self.assertEqual(result.batch_message_count, 2)
        self.assertIs(self.history.states[BINDING_ID].phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(self.history.states[BINDING_ID].message_count, 4)

    def test_disabled_switch_stops_reading_and_keeps_the_checkpoint(self) -> None:
        self.cli.history_pages[None] = _page(range(1, 3), has_more=True, cursor="local_id:2")
        self.cli.history_pages["local_id:2"] = _page(
            range(3, 5), has_more=False, cursor="local_id:4"
        )
        self.sync.cycle(enabled=True)
        calls = len(self.cli.calls)
        self.sync.cycle(enabled=False)
        self.assertEqual(len(self.cli.calls), calls)
        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.SYNCING)
        self.assertEqual(state.last_cursor, "local_id:2")

        self.sync.cycle(enabled=True)
        self.assertEqual(self.cli.calls[-1]["cursor"], "local_id:2")

    def test_empty_history_is_incomplete_not_complete(self) -> None:
        self.cli.history_pages[None] = _page((), has_more=False, cursor=None)
        result = self.sync.cycle(enabled=True)

        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.INCOMPLETE)
        self.assertEqual(state.failure_code, "history_empty")
        self.assertIsNone(state.completed_at)
        self.assertEqual(result.status.history_coverages[0].phase, "incomplete")
        self.assertEqual(self.observations.recorded, [])
        self.assertNotIn((OWNER_ID, CONTACT_ID), self.observations.cursors)

    def test_local_history_deleted_is_incomplete(self) -> None:
        self.cli.history_pages[None] = _page(
            (), has_more=False, cursor=None, local_history_state="deleted"
        )
        result = self.sync.cycle(enabled=True)

        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.INCOMPLETE)
        self.assertEqual(state.failure_code, "local_history_deleted")
        self.assertNotEqual(result.status.history_coverages[0].phase, "complete")

    def test_missing_message_table_keeps_incomplete_reason(self) -> None:
        self.cli.errors[None] = CliCommandError(
            "cli_message_table_missing", "合成缺表"
        )
        self.sync.cycle(enabled=True)

        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.INCOMPLETE)
        self.assertEqual(state.failure_code, "cli_message_table_missing")
        self.assertIsNone(state.completed_at)
        self.assertEqual(self.observations.recorded, [])

    def test_partial_watermark_from_cli_is_rejected_as_invalid_output(self) -> None:
        self.cli.history_pages[None] = TailResult(
            events=(_event(1),),
            cursor=None,
            last_local_id=1,
            freshness_confirmed=True,
            has_more=False,
        )
        self.sync.cycle(enabled=True)

        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.INCOMPLETE)
        self.assertEqual(state.failure_code, "cli_output_invalid")
        self.assertEqual(self.observations.recorded, [])

    def test_cli_failure_marks_incomplete_and_retries_after_backoff(self) -> None:
        self.cli.errors[None] = CliCommandError("cli_command_failed", "合成历史读取失败")
        self.sync.cycle(enabled=True)
        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.INCOMPLETE)
        self.assertEqual(state.failure_code, "cli_command_failed")

        calls = len(self.cli.calls)
        self.sync.cycle(enabled=True)
        self.assertEqual(len(self.cli.calls), calls)

        self.cli.errors.pop(None)
        self.cli.history_pages[None] = _page(range(1, 3), has_more=False, cursor="local_id:2")
        self.now += timedelta(minutes=1)
        self.sync.cycle(enabled=True)
        self.assertIsNone(self.cli.calls[-1].get("cursor"))
        self.assertIs(self.history.states[BINDING_ID].phase, HistorySyncPhase.COMPLETE)

    def test_write_failure_keeps_syncing_and_retries_the_same_page(self) -> None:
        self.cli.history_pages[None] = _page(range(1, 3), has_more=True, cursor="local_id:2")
        self.cli.history_pages["local_id:2"] = _page(
            range(3, 5), has_more=False, cursor="local_id:4"
        )
        self.observations.fail_next_write = True
        failed = self.sync.cycle(enabled=True)
        self.assertEqual(failed.status.failure_code, "observation_persistence_failed")
        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.SYNCING)
        self.assertIsNone(state.last_cursor)

        self.now += timedelta(seconds=5)
        self.sync.cycle(enabled=True)
        self.assertIsNone(self.cli.calls[-1].get("cursor"))
        self.assertIs(self.history.states[BINDING_ID].phase, HistorySyncPhase.SYNCING)
        self.sync.cycle(enabled=True)
        self.assertEqual(self.cli.calls[-1].get("cursor"), "local_id:2")
        self.assertIs(self.history.states[BINDING_ID].phase, HistorySyncPhase.COMPLETE)

    def test_future_timestamp_and_watermark_do_not_end_history_early(self) -> None:
        self.cli.history_pages[None] = _page(
            range(1, 4),
            has_more=True,
            cursor="local_id:3",
            create_time=int(NOW.timestamp()) + 1,
        )
        self.cli.history_pages["local_id:3"] = _page(
            range(4, 6),
            has_more=False,
            cursor="local_id:5",
            create_time=int(NOW.timestamp()) + 2,
        )
        first = self.sync.cycle(enabled=True)

        state = self.history.states[BINDING_ID]
        self.assertIs(state.phase, HistorySyncPhase.SYNCING)
        self.assertEqual(state.watermark_at, NOW)
        self.assertEqual(first.batch_message_count, 3)

        second = self.sync.cycle(enabled=True)
        self.assertIs(self.history.states[BINDING_ID].phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(second.batch_message_count, 2)
        self.assertEqual(self.cli.calls[1]["cursor"], "local_id:3")
        self.sync.request_safety_sweep()
        self.sync.cycle(enabled=True)
        self.assertNotIn("history", self.cli.calls[-1])

    def test_existing_incremental_cursor_does_not_block_history_start(self) -> None:
        self.observations.cursors[(OWNER_ID, CONTACT_ID)] = _Cursor(
            BINDING_ID, "wxid_synthetic_history", 900, "local_id:900"
        )
        self.observations.reliable_cursors[(OWNER_ID, CONTACT_ID)] = _Cursor(
            BINDING_ID, "wxid_synthetic_history", 900, "local_id:900"
        )
        self.cli.history_pages[None] = _page(range(1, 3), has_more=False, cursor="local_id:2")
        self.sync.cycle(enabled=True)

        self.assertTrue(self.cli.calls[0]["history"])
        self.assertIsNone(self.cli.calls[0].get("cursor"))
        self.assertFalse(self.observations.recorded[0]["advance_cursor"])
        self.assertEqual(self.history.states[BINDING_ID].message_count, 2)
        self.assertIs(self.history.states[BINDING_ID].phase, HistorySyncPhase.COMPLETE)

    def test_status_exposes_only_binding_metadata(self) -> None:
        self.cli.history_pages[None] = _page(range(1, 3), has_more=True, cursor="local_id:2")
        result = self.sync.cycle(enabled=True)
        coverage = result.status.history_coverages[0]

        self.assertEqual(coverage.binding_id, BINDING_ID)
        self.assertEqual(coverage.contact_id, CONTACT_ID)
        self.assertEqual(coverage.phase, "syncing")
        self.assertEqual(coverage.message_count, 2)
        self.assertEqual(coverage.page_count, 1)
        self.assertEqual(coverage.watermark_at, NOW)
        self.assertNotIn("合成历史消息", repr(result.status))

    def test_other_binding_continues_when_one_history_fails(self) -> None:
        other = FakeBinding(
            uuid4(), uuid4(), conversation_locator="wxid_synthetic_other", display_name="合成乙"
        )
        self.sync = self.make_sync(bindings=[self.binding, other])
        self.cli.errors[None] = CliCommandError("cli_timeout", "合成超时")
        self.sync.cycle(enabled=True, max_bindings=1)
        self.cli.errors.clear()
        self.cli.history_pages[None] = _page(
            range(1, 3), has_more=False, cursor="local_id:2"
        )
        self.sync.cycle(enabled=True, max_bindings=1)

        self.assertIs(
            self.history.states[self.binding.binding_id].phase,
            HistorySyncPhase.INCOMPLETE,
        )
        self.assertIn(other.binding_id, self.history.states)
        self.assertIs(
            self.history.states[other.binding_id].phase,
            HistorySyncPhase.COMPLETE,
        )


if __name__ == "__main__":
    unittest.main()
