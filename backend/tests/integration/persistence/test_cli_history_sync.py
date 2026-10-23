"""首绑历史同步、检查点与 PostgreSQL 的真实存储集成测试。

外部 CLI 使用合成脚本，其余路径保留生产适配器、调度、迁移与存储。
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import psycopg

from notalone.application.message_stream import MessageStream
from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.ingest.models import (
    ChannelIdentityCandidate,
    ExistingContactSelection,
    ImportBatch,
    ImportConfirmationRequest,
    OwnerChannelIdentityCandidate,
)
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.history_sync_state import (
    HistorySyncPhase,
    HistorySyncStatePersistenceError,
    PostgresHistorySyncStateStore,
)
from notalone.persistence.history_authorization import (
    HistoryAuthorizationState,
    PostgresHistorySyncAuthorizationStore,
)
from notalone.persistence.message_stream import PostgresMessageStream
from notalone.persistence.observation_store import ObservationMode
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.wechat_cli import LocalWechatCli
from notalone.wechat_cli.models import ChatCandidate
from notalone.wechat_cli.normalizer import normalize_cli_events
from tests.integration.persistence import test_observation_store as observations


NOW = datetime(2026, 10, 23, 9, tzinfo=timezone.utc)
HISTORY_CREATE_BASE = 1_767_225_600  # 2026-01-01，早于固定水位


class ScriptedHistoryRunner:
    """只替代外部 CLI 进程；分页、去重与存储走生产代码。"""

    def __init__(self) -> None:
        self.local_ids: list[int] = []
        self.page_limit = 50
        self.calls: list[tuple[str, ...]] = []
        self.missing_table = False
        self.probe_deleted = False
        self.insert_after_first_history_page: list[int] | None = None
        self.history_page_reads = 0

    def seed(self, local_ids) -> None:
        self.local_ids = sorted(local_ids)

    def __call__(self, command: tuple[str, ...]) -> SimpleNamespace:
        self.calls.append(command)
        if command[1] == "--version":
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {"ok": True, "data": {"version": "synthetic-history"}}
                ),
                stderr="",
            )
        if command[1] == "sql":
            if not self.probe_deleted:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({"ok": False, "error": "合成探针不可用"}),
                    stderr="",
                )
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {
                        "ok": True,
                        "data": {
                            "freshness": {
                                "message_source": "live_selected_db_read_only"
                            },
                            "query": {"has_more": False, "returned": 1},
                            "rows": [
                                {
                                    "deleted_count": 1,
                                    "session_count": 0,
                                    "empty_session_count": 0,
                                }
                            ],
                        },
                    }
                ),
                stderr="",
            )
        if command[1] != "tail":
            raise AssertionError("测试脚本只允许 tail/sql/--version。")
        talker = command[2]
        history = "--history" in command
        limit = (
            int(command[command.index("--limit") + 1])
            if "--limit" in command
            else 50
        )
        cursor = (
            command[command.index("--cursor") + 1]
            if "--cursor" in command
            else None
        )
        if history:
            if self.missing_table:
                return SimpleNamespace(
                    returncode=1,
                    stdout=json.dumps(
                        {
                            "ok": False,
                            "error": {
                                "code": "tool_error",
                                "message": "table msg_0 not found in 2 message shards",
                            },
                        }
                    ),
                    stderr="",
                )
            self.history_page_reads += 1
        after = (
            [number for number in self.local_ids if number > int(cursor.split(":")[1])]
            if cursor is not None
            else list(self.local_ids)
        )
        if history:
            window = after[:limit]
        elif cursor is None:
            # 真实增量首次读取返回最新一页；本测试不依赖该分支。
            window = after[-limit:]
        else:
            window = after[:limit]
        has_more = len(after) > len(window)
        events = [
            {
                "type": "message",
                "cursor": f"local_id:{number}",
                "message": {
                    "id": {"local_id": number, "talker": talker},
                    "kind": "text",
                    "text": f"合成历史消息{number}",
                    "is_from_me": number % 2 == 0,
                    "create_time": HISTORY_CREATE_BASE + number,
                },
            }
            for number in window
        ]
        payload = {
            "ok": True,
            "data": {
                "events": events,
                "cursor": f"local_id:{window[-1]}" if window else None,
                "freshness": {"message_source": "live_message_db"},
                "query": {
                    "chat": talker,
                    "has_more": has_more,
                    "history": history,
                },
            },
        }
        if (
            history
            and cursor is None
            and self.insert_after_first_history_page is not None
        ):
            self.local_ids = sorted(
                self.local_ids + self.insert_after_first_history_page
            )
            self.insert_after_first_history_page = None
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")


class HistorySyncPersistenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        observations.PostgresObservationStoreTest.setUpClass()
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            ready = connection.execute(
                "SELECT to_regclass('public.cli_history_sync_state'), "
                "to_regclass('public.wechat_observation_cursor')"
            ).fetchone()
        if not all(ready):
            raise unittest.SkipTest("历史同步集成测试需要已执行 104 迁移的隔离测试库。")

    def setUp(self) -> None:
        self.fixture = observations.PostgresObservationStoreTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.now = NOW
        self.scope = self.fixture.binding_a.scope
        self.binding = self.fixture.binding_a
        self.runner = ScriptedHistoryRunner()
        self.history = PostgresHistorySyncStateStore(observations.TEST_DATABASE_URL)
        self.bindings = PostgresConversationBindingRepository(
            observations.TEST_DATABASE_URL
        )
        # 夹具默认建立两位联系人；本测试只关注合成甲，撤销乙以隔离读取。
        self.bindings.revoke_binding(
            owner_id=self.scope.owner_id,
            contact_id=self.fixture.binding_b.scope.contact_id,
            binding_id=self.fixture.binding_b.binding_id,
        )
        self.sync = self.make_sync()

    def make_sync(
        self, *, authorization=None, account_scope: str = "synthetic-account"
    ) -> CliBackgroundSync:
        sync = CliBackgroundSync(
            owner_id=self.scope.owner_id,
            channel="wechat",
            account_scope=account_scope,
            cli=LocalWechatCli(runner=self.runner),
            bindings=self.bindings,
            observation_store=self.fixture.store,
            history_state=self.history,
            history_authorization=authorization or _AllowAll(),
            history_page_limit=50,
            clock=lambda: self.now,
        )
        self.addCleanup(sync.close)
        return sync

    @property
    def messages(self) -> MessageStream:
        return MessageStream(PostgresMessageStream(observations.TEST_DATABASE_URL))

    def message_texts(self) -> list[str]:
        stream = self.messages
        texts: list[str] = []
        cursor = None
        while True:
            page = stream.page_messages(
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
                limit=100,
                before_message_id=cursor,
            )
            texts.extend(message.text for message in page.messages)
            if page.next_cursor is None:
                break
            cursor = page.next_cursor
        return list(reversed(texts))

    def state(self):
        return self.history.read(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            binding_id=self.binding.binding_id,
        )

    def auth_scope(self):
        return dict(
            owner_id=self.scope.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
        )

    def test_assistant_request_restores_explicit_history_warning(self):
        from uuid import uuid4
        from notalone.application.reply_service import ReplyServiceRequest
        from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
        from notalone.reply.interface import RewriteDraft
        store = PostgresAssistantSessionStore(observations.TEST_DATABASE_URL)
        session = store.default(self.scope)
        request = ReplyServiceRequest(idempotency_key=uuid4(), content=RewriteDraft("合成想法"),
            allow_incomplete_history=True)
        receipt = store.reserve_prepared(self.scope, session, request)
        restored = PostgresAssistantSessionStore(observations.TEST_DATABASE_URL).prepared_request(self.scope, receipt)
        self.assertTrue(restored.allow_incomplete_history)
        snapshot = store.read_session(self.scope, session)
        self.assertTrue(snapshot.turns[0].input["allow_incomplete_history"])
        self.assertIn("历史覆盖不完整", snapshot.turns[0].input["history_coverage_warning"])

    def test_reply_history_eligibility_distinguishes_old_authorization_and_unstarted(self):
        from notalone.persistence.reply_history_coverage import PostgresReplyHistoryCoverage
        reader = PostgresReplyHistoryCoverage(observations.TEST_DATABASE_URL)
        args = (self.scope.owner_id, self.scope.contact_id)
        self.assertIsNone(reader(*args))
        authorization = PostgresHistorySyncAuthorizationStore(observations.TEST_DATABASE_URL)
        authorization.decide(owner_id=self.scope.owner_id, channel="wechat",
            account_scope="synthetic-account", decision="accepted", at=NOW)
        self.assertEqual(reader(*args), "not_started")
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(reader(*args), "incomplete")
        extra = self.bindings.create_binding(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            channel="wechat", account_scope="synthetic-account", conversation_locator="wxid_second_binding")
        self.assertEqual(reader(*args), "not_started")
        self.bindings.revoke_binding(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            binding_id=extra.binding_id)
        self.assertEqual(reader(*args), "incomplete")
        self.assertIsNone(reader(self.scope.owner_id, self.fixture.binding_b.scope.contact_id))

    def test_first_connection_grant_enrolls_and_starts_history(self):
        from notalone.persistence.sync_scope import PostgresSyncScopeStore
        from notalone.persistence.wechat_setup import PostgresWechatSetupStore

        account = "setup-history-account"
        PostgresWechatSetupStore(observations.TEST_DATABASE_URL).connect(
            self.scope.owner_id, account, self.now
        )
        scopes = PostgresSyncScopeStore(observations.TEST_DATABASE_URL)
        self.assertEqual(
            scopes.read(
                owner_id=self.scope.owner_id,
                channel="wechat",
                account_scope=account,
            ).mode,
            "all_private",
        )
        self.assertEqual(
            scopes.enroll(
                owner_id=self.scope.owner_id,
                channel="wechat",
                account_scope=account,
                sessions=(
                    ChatCandidate(
                        username="wxid_setup_history",
                        display_name="合成首连会话",
                        chat_type="private",
                        last_timestamp=None,
                        match=None,
                        sort_timestamp=None,
                        source="sessions",
                    ),
                ),
            ),
            1,
        )
        authorization = PostgresHistorySyncAuthorizationStore(
            observations.TEST_DATABASE_URL
        )
        sync = self.make_sync(authorization=authorization, account_scope=account)
        self.runner.seed(range(1, 11))
        sync.cycle(enabled=True, max_bindings=1)

        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            contact_id, binding_id = connection.execute(
                "SELECT contact_id, id FROM public.conversation_binding "
                "WHERE owner_id=%s AND conversation_locator='wxid_setup_history'",
                (self.scope.owner_id,),
            ).fetchone()
        state = self.history.read(
            owner_id=self.scope.owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
        )
        self.assertIsNotNone(state)
        self.assertIs(state.phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(state.message_count, 10)
        first_read = next(
            command for command in self.runner.calls
            if len(command) > 2 and command[1] == "tail"
            and command[2] == "wxid_setup_history"
        )
        self.assertIn("--history", first_read)

    def test_old_authorization_keeps_incremental_until_one_time_upgrade(self):
        authorization = PostgresHistorySyncAuthorizationStore(
            observations.TEST_DATABASE_URL
        )
        self.assertIs(
            authorization.read(**self.auth_scope()).state,
            HistoryAuthorizationState.REQUIRED,
        )
        self.runner.seed(range(1, 61))
        sync = self.make_sync(authorization=authorization)
        self.addCleanup(sync.close)

        sync.cycle(enabled=True, max_bindings=1)
        self.assertIsNone(self.state())
        self.assertEqual(self.runner.history_page_reads, 0)
        self.assertGreater(len(self.message_texts()), 0)

        authorization.decide(**self.auth_scope(), decision="declined", at=self.now)
        sync.cycle(enabled=True, max_bindings=1)
        self.assertIsNone(self.state())
        self.assertEqual(self.runner.history_page_reads, 0)

        authorization.decide(**self.auth_scope(), decision="accepted", at=self.now)
        sync.request_history_start()
        sync.cycle(enabled=True, max_bindings=1)
        started = self.state()
        self.assertIsNotNone(started)
        self.assertEqual(self.runner.history_page_reads, 1)

        # 重复确认、后端重启与并发刷新不重置水位或检查点。
        restarted = PostgresHistorySyncAuthorizationStore(
            observations.TEST_DATABASE_URL
        )
        restarted.decide(**self.auth_scope(), decision="accepted", at=self.now)
        sync.request_history_start()
        sync.cycle(enabled=True, max_bindings=1)
        current = self.state()
        self.assertEqual(current.watermark_at, started.watermark_at)
        self.assertEqual(current.started_at, started.started_at)
        self.assertGreaterEqual(current.message_count, started.message_count)

    def test_selected_confirmation_starts_only_its_own_history_task(self):
        authorization = PostgresHistorySyncAuthorizationStore(
            observations.TEST_DATABASE_URL
        )
        self.runner.seed(range(1, 31))
        sync = self.make_sync(authorization=authorization)
        self.addCleanup(sync.close)

        self.assertEqual(sync.start_history_for_bindings([self.binding]), 1)
        # 账号级历史授权仍是待确认；逐项确认只覆盖刚确认的绑定。
        self.assertIs(
            authorization.read(**self.auth_scope()).state,
            HistoryAuthorizationState.REQUIRED,
        )
        sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(self.runner.history_page_reads, 1)
        started = self.state()
        self.assertIsNotNone(started)
        self.assertEqual(sync.start_history_for_bindings([self.binding]), 0)
        self.assertEqual(self.state().started_at, started.started_at)

    def test_newly_enrolled_private_session_starts_with_history(self):
        authorization = PostgresHistorySyncAuthorizationStore(
            observations.TEST_DATABASE_URL
        )
        authorization.decide(**self.auth_scope(), decision="accepted", at=self.now)
        sync = self.make_sync(authorization=authorization)
        self.runner.seed(range(1, 11))
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            contact = connection.execute(
                "INSERT INTO public.contact(owner_id,display_name) VALUES(%s,'合成新会话') RETURNING id",
                (self.scope.owner_id,),
            ).fetchone()[0]
        binding = self.bindings.create_binding(
            owner_id=self.scope.owner_id,
            contact_id=contact,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_new",
        )
        # 新会话由下一轮安全对账纳入，复用既有增量发现节奏。
        sync.request_safety_sweep()

        for _ in range(3):
            sync.cycle(enabled=True, max_bindings=1)
        state = self.history.read(
            owner_id=self.scope.owner_id,
            contact_id=contact,
            binding_id=binding.binding_id,
        )
        self.assertIsNotNone(state)
        self.assertIs(state.phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(state.message_count, 10)
        first_read = next(
            command for command in self.runner.calls
            if len(command) > 2 and command[1] == "tail" and command[2] == "wxid_observation_new"
        )
        self.assertIn("--history", first_read)

    def test_declined_upgrade_still_allows_selected_confirmation_only(self):
        authorization = PostgresHistorySyncAuthorizationStore(
            observations.TEST_DATABASE_URL
        )
        authorization.decide(**self.auth_scope(), decision="declined", at=self.now)
        sync = self.make_sync(authorization=authorization)
        self.runner.seed(range(1, 11))
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            other_contact = connection.execute(
                "INSERT INTO public.contact(owner_id,display_name) VALUES(%s,'合成未确认会话') RETURNING id",
                (self.scope.owner_id,),
            ).fetchone()[0]
        other = self.bindings.create_binding(
            owner_id=self.scope.owner_id,
            contact_id=other_contact,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_other",
        )

        self.assertEqual(sync.start_history_for_bindings([self.binding]), 1)
        sync.cycle(
            enabled=True,
            priority_contact_id=self.scope.contact_id,
            max_bindings=1,
        )
        self.assertIsNotNone(self.state())
        self.assertIsNone(self.history.read(
            owner_id=self.scope.owner_id,
            contact_id=other_contact,
            binding_id=other.binding_id,
        ))
        # 拒绝账号级升级后，逐项确认只覆盖刚确认的会话，不扩及其他既有绑定。
        self.assertIs(
            authorization.read(**self.auth_scope()).state,
            HistoryAuthorizationState.DECLINED,
        )

    def test_binding_history_start_is_scoped_and_does_not_revive_revoked(self):
        def start(account_scope, binding_id):
            return self.history.ensure_bindings_started(
                owner_id=self.scope.owner_id,
                channel="wechat",
                account_scope=account_scope,
                binding_ids=(binding_id,),
                watermark_at=self.now,
            )

        self.assertEqual(start("other-account", self.binding.binding_id), 0)
        self.assertEqual(
            start("synthetic-account", self.fixture.binding_b.binding_id), 0
        )
        self.assertEqual(start("synthetic-account", self.binding.binding_id), 1)
        self.assertEqual(start("synthetic-account", self.binding.binding_id), 0)

    def test_three_pages_commit_and_restart_resumes_without_duplicates(self) -> None:
        self.runner.seed(range(1, 121))

        first = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(first.batch_message_count, 50)
        self.assertEqual(self.message_texts()[:1], ["合成历史消息1"])
        self.assertIs(self.state().phase, HistorySyncPhase.SYNCING)
        self.assertEqual(self.state().last_cursor, "local_id:50")

        self.sync.close()
        self.sync = self.make_sync()
        second = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(second.batch_message_count, 50)
        self.assertEqual(self.state().last_cursor, "local_id:100")

        self.sync.close()
        self.sync = self.make_sync()
        third = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(third.batch_message_count, 20)
        self.assertIs(self.state().phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(self.state().message_count, 120)
        self.assertEqual(self.state().page_count, 3)
        self.assertEqual(len(self.message_texts()), 120)
        coverage = third.status.history_coverages[0]
        self.assertEqual(coverage.phase, "complete")
        self.assertEqual(coverage.message_count, 120)

        # 完成后从检查点转入增量；没有新消息时不重复写入。
        self.runner.seed(range(1, 121))
        fourth = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(fourth.batch_message_count, 0)
        self.assertEqual(len(self.message_texts()), 120)
        self.assertIs(self.state().phase, HistorySyncPhase.COMPLETE)

        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            rows = connection.execute(
                "SELECT mode, is_reliable FROM public.local_wechat_observation "
                "WHERE owner_id=%s AND contact_id=%s ORDER BY read_at",
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchall()
        self.assertEqual(
            [row for row in rows if row[0] == ObservationMode.CLI_HISTORY.value],
            [
                (ObservationMode.CLI_HISTORY.value, False),
                (ObservationMode.CLI_HISTORY.value, False),
                (ObservationMode.CLI_HISTORY.value, True),
            ],
        )

    def test_message_arriving_during_history_is_deduplicated_into_the_same_chain(self) -> None:
        self.runner.seed(range(1, 101))
        self.runner.insert_after_first_history_page = [101]

        self.sync.cycle(enabled=True, max_bindings=1)
        self.sync.cycle(enabled=True, max_bindings=1)
        third = self.sync.cycle(enabled=True, max_bindings=1)

        self.assertIs(self.state().phase, HistorySyncPhase.COMPLETE)
        texts = self.message_texts()
        self.assertEqual(len(texts), 101)
        self.assertEqual(sum(text == "合成历史消息101" for text in texts), 1)
        self.assertEqual(third.batch_message_count, 1)

    def test_existing_cursor_and_overlapping_source_do_not_block_history(self) -> None:
        self.runner.seed(range(1, 121))
        overlap_event = normalize_cli_events(
            (
                _cli_event(1, "wxid_observation_a"),
            )
        )
        self.fixture.store.record_batch_with_messages(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            binding_id=self.binding.binding_id,
            mode=ObservationMode.LIVE,
            cli_version="synthetic-before-history",
            conversation_locator="wxid_observation_a",
            since_local_id=None,
            since_cursor=None,
            last_local_id=1,
            last_cursor="local_id:1",
            cursor_ordered=False,
            record_count=1,
            event_count=1,
            non_text_count=0,
            messages=overlap_event,
        )
        self.assertEqual(len(self.message_texts()), 1)

        for _ in range(4):
            self.sync.cycle(enabled=True, max_bindings=1)
            if self.state().phase is HistorySyncPhase.COMPLETE:
                break
        self.assertIs(self.state().phase, HistorySyncPhase.COMPLETE)
        texts = self.message_texts()
        self.assertEqual(len(texts), 120)
        self.assertEqual(sum(text == "合成历史消息1" for text in texts), 1)

        cursor = self.fixture.store.read_cursor(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
        )
        self.assertIsNotNone(cursor)
        self.assertEqual(cursor.last_cursor, "local_id:120")
        # 完成后的普通心跳不能把增量游标回退到旧可靠观察。
        self.sync.cycle(enabled=True, max_bindings=1)
        cursor = self.fixture.store.read_cursor(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
        )
        self.assertEqual(cursor.last_cursor, "local_id:120")
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            refs = connection.execute(
                """
                SELECT count(*)
                FROM public.message_source_ref AS ref
                JOIN public.wechat_message_metadata AS metadata
                  ON metadata.message_id = ref.message_id
                WHERE ref.owner_id = %s AND ref.contact_id = %s
                  AND metadata.external_local_id = 1
                """,
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()[0]
        self.assertEqual(refs, 2)

    def test_ahead_cursor_is_not_rewound_by_history_completion(self) -> None:
        self.runner.seed(range(1, 121))
        self.fixture.store.record_batch_with_messages(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            binding_id=self.binding.binding_id,
            mode=ObservationMode.LIVE,
            cli_version="synthetic-ahead",
            conversation_locator="wxid_observation_a",
            since_local_id=None,
            since_cursor=None,
            last_local_id=900,
            last_cursor="local_id:900",
            cursor_ordered=False,
            record_count=1,
            event_count=1,
            non_text_count=0,
            messages=normalize_cli_events((_cli_event(900, "wxid_observation_a"),)),
        )

        for _ in range(4):
            self.sync.cycle(enabled=True, max_bindings=1)
            if self.state().phase is HistorySyncPhase.COMPLETE:
                break

        self.assertIs(self.state().phase, HistorySyncPhase.COMPLETE)
        cursor = self.fixture.store.read_cursor(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
        )
        self.assertEqual(cursor.last_cursor, "local_id:900")
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            reliable = connection.execute(
                """
                SELECT is_reliable
                FROM public.local_wechat_observation
                WHERE owner_id = %s AND contact_id = %s
                  AND mode = 'cli_history' AND last_cursor = 'local_id:120'
                """,
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()
        self.assertEqual(reliable, (False,))

        self.sync.request_safety_sweep()
        self.sync.cycle(enabled=True, max_bindings=1)
        cursor = self.fixture.store.read_cursor(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
        )
        self.assertEqual(cursor.last_cursor, "local_id:900")

    def test_file_import_source_overlap_does_not_block_or_duplicate_history(self) -> None:
        self.runner.seed(range(1, 21))
        imported = normalize_cli_events(
            (_cli_event(1, "wxid_observation_a"),)
        )
        batch = ImportBatch(
            file_name="synthetic_history_overlap.jsonl",
            content_sha256="a" * 64,
            owner_channel_identity=OwnerChannelIdentityCandidate(
                channel="wechat",
                external_id="wxid_synthetic_owner",
                observed_name="合成本人",
                observed_name_variant_count=1,
            ),
            channel_identity=ChannelIdentityCandidate(
                channel="wechat",
                external_id="wxid_observation_a",
                observed_name="合成历史联系人",
                observed_name_variant_count=1,
            ),
            messages=imported,
        )
        result = PostgresIngestRepository(
            observations.TEST_DATABASE_URL
        ).import_document(
            owner_id=self.scope.owner_id,
            initialize_first_owner_identity=True,
            document=batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(
                    contact_id=self.scope.contact_id
                )
            ),
        )
        self.assertEqual(result.message_count, 1)
        self.assertEqual(self.message_texts(), ["合成历史消息1"])

        for _ in range(3):
            self.sync.cycle(enabled=True, max_bindings=1)
            if self.state().phase is HistorySyncPhase.COMPLETE:
                break
        self.assertIs(self.state().phase, HistorySyncPhase.COMPLETE)
        texts = self.message_texts()
        self.assertEqual(len(texts), 20)
        self.assertEqual(sum(text == "合成历史消息1" for text in texts), 1)
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            refs = connection.execute(
                """
                SELECT count(*)
                FROM public.message_source_ref AS ref
                JOIN public.wechat_message_metadata AS metadata
                  ON metadata.message_id = ref.message_id
                WHERE ref.owner_id = %s AND ref.contact_id = %s
                  AND metadata.external_local_id = 1
                """,
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()[0]
        self.assertEqual(refs, 2)

    def test_empty_history_is_incomplete_and_never_complete(self) -> None:
        self.runner.seed([])
        result = self.sync.cycle(enabled=True, max_bindings=1)

        state = self.state()
        self.assertIs(state.phase, HistorySyncPhase.INCOMPLETE)
        self.assertEqual(state.failure_code, "history_empty")
        self.assertIsNone(state.completed_at)
        self.assertEqual(result.status.history_coverages[0].phase, "incomplete")
        self.assertEqual(self.message_texts(), [])

    def test_missing_message_table_is_incomplete(self) -> None:
        self.runner.seed(range(1, 21))
        self.runner.missing_table = True
        self.runner.probe_deleted = True
        result = self.sync.cycle(enabled=True, max_bindings=1)

        state = self.state()
        self.assertIs(state.phase, HistorySyncPhase.INCOMPLETE)
        self.assertEqual(state.failure_code, "local_history_deleted")
        self.assertEqual(result.status.history_coverages[0].phase, "incomplete")
        self.assertEqual(self.message_texts(), [])

    def test_failed_checkpoint_rolls_back_the_whole_page(self) -> None:
        self.runner.seed(range(1, 21))
        with patch(
            "notalone.persistence.observation_store.advance_history_checkpoint",
            side_effect=HistorySyncStatePersistenceError("合成检查点失败"),
        ):
            failed = self.sync.cycle(enabled=True, max_bindings=1)

        self.assertEqual(failed.batch_message_count, 0)
        self.assertEqual(self.message_texts(), [])
        state = self.state()
        self.assertIs(state.phase, HistorySyncPhase.SYNCING)
        self.assertIsNone(state.last_cursor)
        self.assertIsNone(
            self.fixture.store.read_cursor(
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
            )
        )

        self.now += timedelta(seconds=5)
        recovered = self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(recovered.batch_message_count, 20)
        self.assertEqual(len(self.message_texts()), 20)
        self.assertIs(self.state().phase, HistorySyncPhase.COMPLETE)
        self.assertEqual(self.state().last_cursor, "local_id:20")

    def test_disabled_switch_and_revoke_stop_reads_but_keep_checkpoint(self) -> None:
        self.runner.seed(range(1, 121))
        self.sync.cycle(enabled=True, max_bindings=1)
        reads = self.runner.history_page_reads
        self.sync.cycle(enabled=False)
        self.assertEqual(self.runner.history_page_reads, reads)
        self.assertEqual(self.state().last_cursor, "local_id:50")

        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(self.runner.history_page_reads, reads + 1)
        self.assertEqual(self.state().last_cursor, "local_id:100")

        PostgresConversationBindingRepository(
            observations.TEST_DATABASE_URL
        ).revoke_binding(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            binding_id=self.binding.binding_id,
        )
        reads = self.runner.history_page_reads
        self.sync.cycle(enabled=True, max_bindings=1)
        self.assertEqual(self.runner.history_page_reads, reads)
        self.assertEqual(self.state().last_cursor, "local_id:100")
        self.assertIs(self.state().phase, HistorySyncPhase.SYNCING)


class _AllowAll:
    def history_sync_authorized(self, **kwargs) -> bool:
        del kwargs
        return True


def _cli_event(local_id: int, talker: str):
    from notalone.wechat_cli.models import CliMessageEvent, MessageIdentifier

    return CliMessageEvent(
        message_id=MessageIdentifier(local_id, talker),
        text=f"合成历史消息{local_id}",
        kind="text",
        sender=None,
        sender_wxid=None,
        is_from_me=False,
        create_time=HISTORY_CREATE_BASE + local_id,
        time=None,
        time_iso=None,
    )


if __name__ == "__main__":
    unittest.main()
