"""真实适配器、后台调度与 PostgreSQL 的合成分页回归。"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

import psycopg

from notalone.application.message_stream import MessageStream
from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.persistence.backfill_state import BackfillPhase, PostgresBackfillStateStore
from notalone.persistence.message_stream import PostgresMessageStream
from notalone.wechat_cli import LocalWechatCli
from tests.integration.persistence import test_observation_store as observations


class PagedCliRunner:
    """仅替代外部 CLI 进程，保留生产 JSON 解析与存储。"""

    def __init__(self) -> None:
        self.fail_next_page = False

    def __call__(self, command: tuple[str, ...]) -> SimpleNamespace:
        if command[1] == "--version":
            payload = {"ok": True, "data": {"version": "synthetic-pagination"}}
        else:
            if command[1] != "tail" or command[2] != "wxid_observation_a":
                raise AssertionError("只能读取本测试授权的合成会话。")
            cursor = command[command.index("--cursor") + 1] if "--cursor" in command else None
            start = int(cursor.split(":")[1]) if cursor else 0
            if start == 50 and self.fail_next_page:
                self.fail_next_page = False
                return SimpleNamespace(returncode=1, stdout=json.dumps({
                    "ok": False, "error": {"code": "tool_error", "message": "合成读取失败"},
                }), stderr="")
            end = min(start + 50, 53)
            events = [{
                "type": "message", "cursor": f"local_id:{number}",
                "message": {
                    "id": {"local_id": number, "talker": "wxid_observation_a"},
                    "kind": "text", "text": f"分页合成消息{number}",
                    "is_from_me": number % 2 == 0, "create_time": 2_000_000_000 + number,
                },
            } for number in range(start + 1, end + 1)]
            payload = {"ok": True, "data": {
                "events": events, "cursor": f"local_id:{end}",
                "freshness": {"message_source": "live_message_db"},
                "query": {"chat": "wxid_observation_a", "has_more": end < 53},
            }}
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")


class CliPaginationPersistenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        observations.PostgresObservationStoreTest.setUpClass()
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            ready = connection.execute(
                "SELECT to_regclass('public.source_processing_record'), "
                "to_regclass('public.source_processing_capture_tombstone')",
            ).fetchone()
        if not all(ready):
            raise unittest.SkipTest("分页集成测试需要已执行来源追踪迁移的隔离测试库。")

    def setUp(self) -> None:
        self.fixture = observations.PostgresObservationStoreTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.scope = self.fixture.binding_a.scope
        self.runner = PagedCliRunner()
        self.backfill = PostgresBackfillStateStore(observations.TEST_DATABASE_URL)
        self.messages = MessageStream(PostgresMessageStream(observations.TEST_DATABASE_URL))
        self.sync = self.make_sync()

    def make_sync(self) -> CliBackgroundSync:
        sync = CliBackgroundSync(
            owner_id=self.scope.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
            cli=LocalWechatCli(runner=self.runner),
            bindings=[self.fixture.binding_a],
            observation_store=self.fixture.store,
            backfill_state=self.backfill,
            clock=lambda: datetime(2026, 9, 1, tzinfo=timezone.utc),
        )
        self.addCleanup(sync.close)
        return sync

    def message_texts(self) -> list[str]:
        page = self.messages.page_messages(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, limit=100,
        )
        return [message.text for message in page.messages]

    def backfill_state(self):
        return self.backfill.read(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            binding_id=self.fixture.binding_a.binding_id,
        )

    def test_multiple_pages_commit_before_restart_and_only_finish_at_last_page(self) -> None:
        first = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(first.batch_message_count, 50)
        self.assertEqual(len(self.message_texts()), 50)
        self.assertEqual(self.message_texts()[0], "分页合成消息50")
        self.assertEqual(self.backfill_state().phase, BackfillPhase.BACKFILLING)
        self.assertEqual(self.backfill_state().message_count, 50)

        self.sync.close()
        self.sync = self.make_sync()
        second = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(second.batch_message_count, 3)
        self.assertEqual(len(self.message_texts()), 53)
        self.assertEqual(self.message_texts()[0], "分页合成消息53")
        self.assertEqual(self.backfill_state().phase, BackfillPhase.COMPLETE)
        self.assertEqual(self.backfill_state().message_count, 53)

        self.sync.request_safety_sweep()
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(len(self.message_texts()), 53)
        cursor = self.fixture.store.read_cursor(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
        )
        self.assertEqual(cursor.last_local_id, 53)

    def test_failed_next_page_keeps_committed_messages_and_retries_without_duplicates(self) -> None:
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(len(self.message_texts()), 50)
        self.runner.fail_next_page = True
        failed = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(failed.batch_message_count, 0)
        self.assertEqual(failed.status.failure_code, "cli_command_failed")
        self.assertEqual(len(self.message_texts()), 50)
        cursor = self.fixture.store.read_cursor(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
        )
        self.assertEqual(cursor.last_local_id, 50)

        self.sync.request_safety_sweep()
        retried = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(retried.batch_message_count, 3)
        self.assertEqual(len(self.message_texts()), 53)
        self.assertEqual(len(set(self.message_texts())), 53)
        self.sync.close()
        self.sync = self.make_sync()
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(len(self.message_texts()), 53)
