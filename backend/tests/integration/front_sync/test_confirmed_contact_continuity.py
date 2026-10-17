"""双确认联系人事件与独立游标的合成持久化验证，不连接真实微信。"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate
from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.scopes import ContactScope
from notalone.wechat_cli.models import (
    CliMessageEvent,
    CliSessionEvent,
    MessageIdentifier,
    TailResult,
)


ACCOUNT = "synthetic-two-contact-account"
TALKER_A = "synthetic_contact_a"
TALKER_B = "synthetic_contact_b"


class SyntheticSessionStream:
    """只在内存中投递会话变化通知，不创建进程或读取正文。"""

    def __init__(self) -> None:
        self.events: deque[CliSessionEvent] = deque()
        self.closed = False

    def read(self, timeout: float | None = None) -> CliSessionEvent | None:
        del timeout
        return self.events.popleft() if self.events else None

    def close(self) -> None:
        self.closed = True


class SyntheticCli:
    """只替换已解析的外部 CLI 边界，允许显式重放合成消息。"""

    def __init__(self) -> None:
        self.stream = SyntheticSessionStream()
        self.stream_starts = 0
        self.tail_calls: list[tuple[str, str | None]] = []
        self.results: dict[str, TailResult] = {}

    def version(self) -> str:
        return "synthetic-continuity"

    def session_events_follow(self, **kwargs: object) -> SyntheticSessionStream:
        del kwargs
        self.stream_starts += 1
        self.stream = SyntheticSessionStream()
        return self.stream

    def tail(self, talker: str, **kwargs: object) -> TailResult:
        cursor = kwargs.get("cursor")
        if cursor is not None and not isinstance(cursor, str):
            raise TypeError("合成 CLI cursor 必须是字符串。")
        self.tail_calls.append((talker, cursor))
        return self.results.get(
            talker, TailResult((), None, freshness_confirmed=True)
        )

    def notify(self, talker: str, sequence: int) -> None:
        self.stream.events.append(CliSessionEvent(f"session:{sequence}", talker))

    def replay(self, talker: str, *events: CliMessageEvent) -> None:
        last_id = events[-1].message_id.local_id
        self.results[talker] = TailResult(
            events, f"local_id:{last_id}", last_id, freshness_confirmed=True
        )


class ConfirmedContactContinuityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        instance = os.environ["NOTALONE_TEST_DATABASE_URL"]
        cls.database_name = f"notalone_continuity_{uuid4().hex}_test"
        cls.database_url = make_conninfo(instance, dbname=cls.database_name)
        cls.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        try:
            cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(cls.database_name)))
        except BaseException:
            cls.admin.close()
            raise
        cls.addClassCleanup(cls._drop_database)
        binding = patch.dict(os.environ, NOTALONE_DATABASE_URL=cls.database_url,
                             NOTALONE_TEST_DATABASE_URL=cls.database_url,
                             NOTALONE_EXPECTED_TEST_DATABASE=cls.database_name)
        binding.start()
        cls.addClassCleanup(binding.stop)
        with psycopg.connect(cls.database_url) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if name != cls.database_name or not name.endswith("_test"):
            raise RuntimeError("双联系人合成验证只允许连接 _test 库。")
        migrations = Path(__file__).resolve().parents[3] / "database/migrations"
        expected = tuple(sorted(path.name for path in migrations.glob("*.sql")))
        if migrate(cls.database_url, migrations) != expected or migrate(cls.database_url, migrations):
            raise RuntimeError("双联系人回归须完整执行当前正式迁移，重复执行为零。")

    @classmethod
    def _drop_database(cls) -> None:
        try:
            cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))
            if cls.admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
                                 (cls.database_name,)).fetchone()[0]:
                raise AssertionError("双联系人自有测试库未清理。")
        finally:
            cls.admin.close()

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_a, self.contact_b = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "双联系人合成验收用户"),
            )
            for contact_id, name in (
                (self.contact_a, "合成联系人甲"),
                (self.contact_b, "合成联系人乙"),
            ):
                connection.execute(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (self.owner_id, contact_id, name),
                )
        self.addCleanup(self._delete_owner)
        self.bindings = PostgresConversationBindingRepository(self.database_url)
        for contact_id, talker in (
            (self.contact_a, TALKER_A),
            (self.contact_b, TALKER_B),
        ):
            self.bindings.create_binding(
                owner_id=self.owner_id,
                contact_id=contact_id,
                channel="wechat",
                account_scope=ACCOUNT,
                conversation_locator=talker,
                display_name="已确认合成联系人",
            )
        self.store = PostgresObservationStore(self.database_url)
        self.retrieval = PostgresRetrieval(self.database_url)
        self.cli = SyntheticCli()
        self.now = datetime(2026, 10, 12, 14, 0, tzinfo=timezone.utc)
        self.sync = self._new_sync()
        self.addCleanup(self.sync.close)

    def _delete_owner(self) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id=%s", (self.owner_id,)
            )

    def _new_sync(self) -> CliBackgroundSync:
        return CliBackgroundSync(
            owner_id=self.owner_id,
            channel="wechat",
            account_scope=ACCOUNT,
            cli=self.cli,
            bindings=self.bindings,
            observation_store=self.store,
            clock=lambda: self.now,
        )

    def _message(self, talker: str, local_id: int, text: str) -> CliMessageEvent:
        return CliMessageEvent(
            message_id=MessageIdentifier(local_id, talker),
            text=text,
            kind="text",
            sender="合成对方",
            sender_wxid=talker,
            is_from_me=False,
            create_time=int(self.now.timestamp()) + local_id,
            time=None,
            time_iso=None,
        )

    def _texts(self, contact_id: UUID) -> set[str]:
        return {
            message.text
            for message in self.retrieval.search_messages(
                scope=ContactScope(self.owner_id, contact_id)
            )
        }

    def _cursor(self, contact_id: UUID) -> str | None:
        cursor = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=contact_id
        )
        return None if cursor is None else cursor.last_cursor

    def test_partner_events_keep_contact_cursors_and_dedup_across_a_b_a(self) -> None:
        baseline = self.sync.cycle(enabled=True, priority_contact_id=self.contact_a)
        self.assertEqual(baseline.status.stream_mode, "global_follow")
        self.assertEqual(baseline.status.bound_count, 2)
        self.assertIsNone(baseline.status.failure_code)
        self.assertIsNone(self._cursor(self.contact_a))
        self.assertIsNone(self._cursor(self.contact_b))
        self.cli.tail_calls.clear()
        # 当前联系人沿用生产三秒读取节奏，仍早于十五秒安全对账。
        self.now += timedelta(seconds=3)

        a1 = self._message(TALKER_A, 10, "同步验收 A1")
        b1 = self._message(TALKER_B, 10, "同步验收 B1")
        a2 = self._message(TALKER_A, 11, "同步验收 A2")
        self.cli.replay(TALKER_A, a1)
        self.cli.notify(TALKER_A, 1)
        self.sync.cycle(enabled=True, priority_contact_id=self.contact_a)
        self.assertEqual(self.cli.tail_calls, [(TALKER_A, None)])
        self.assertEqual(self._texts(self.contact_a), {"同步验收 A1"})
        self.assertEqual(self._texts(self.contact_b), set())
        self.assertEqual(self._cursor(self.contact_a), "local_id:10")
        self.assertIsNone(self._cursor(self.contact_b))

        self.cli.tail_calls.clear()
        self.cli.replay(TALKER_B, b1)
        self.cli.notify(TALKER_B, 2)
        self.sync.cycle(enabled=True, priority_contact_id=self.contact_b)
        self.assertEqual(self.cli.tail_calls, [(TALKER_B, None)])
        self.assertEqual(self._texts(self.contact_b), {"同步验收 B1"})
        self.assertEqual(self._cursor(self.contact_b), "local_id:10")

        # 合成时钟不前进，排除定期对账；乙保持优先时甲仍由事件推进。
        self.cli.tail_calls.clear()
        self.cli.replay(TALKER_A, a1, a2)
        self.cli.notify(TALKER_A, 3)
        self.sync.cycle(enabled=True, priority_contact_id=self.contact_b)
        self.assertEqual(self.cli.tail_calls, [(TALKER_A, "local_id:10")])
        self.assertEqual(self._cursor(self.contact_a), "local_id:11")
        self.assertEqual(self._cursor(self.contact_b), "local_id:10")

        self.cli.tail_calls.clear()
        self.sync.cycle(enabled=True, priority_contact_id=self.contact_a)
        self.cli.notify(TALKER_B, 4)
        self.cli.notify(TALKER_B, 4)
        self.cli.notify("synthetic_unconfirmed", 5)
        self.sync.cycle(enabled=True, priority_contact_id=self.contact_a)
        self.assertEqual(
            self.cli.tail_calls,
            [(TALKER_A, "local_id:11"), (TALKER_B, "local_id:10")],
        )

        self.now += timedelta(seconds=15)
        self.sync.cycle(enabled=True, priority_contact_id=self.contact_a)
        self.assertEqual(self._texts(self.contact_a), {"同步验收 A1", "同步验收 A2"})
        self.assertEqual(self._texts(self.contact_b), {"同步验收 B1"})
        messages_a = self.retrieval.search_messages(
            scope=ContactScope(self.owner_id, self.contact_a)
        )
        messages_b = self.retrieval.search_messages(
            scope=ContactScope(self.owner_id, self.contact_b)
        )
        self.assertEqual((len(messages_a), len(messages_b)), (2, 1))
        self.assertEqual(
            {message.role for message in (*messages_a, *messages_b)}, {"contact"}
        )
        self.assertEqual(self.cli.stream_starts, 1)

        # 重建协调器仍使用数据库中的两份游标；重放不增加规范消息。
        self.sync.close()
        restored = self._new_sync()
        self.addCleanup(restored.close)
        self.cli.tail_calls.clear()
        result = restored.cycle(enabled=True, priority_contact_id=self.contact_b)
        self.assertIsNone(result.status.failure_code)
        self.assertEqual(
            self.cli.tail_calls,
            [(TALKER_B, "local_id:10"), (TALKER_A, "local_id:11")],
        )
        self.assertEqual(self._texts(self.contact_a), {"同步验收 A1", "同步验收 A2"})
        self.assertEqual(self._texts(self.contact_b), {"同步验收 B1"})
        self.assertEqual(
            (self._cursor(self.contact_a), self._cursor(self.contact_b)),
            ("local_id:11", "local_id:10"),
        )
        restored_a = self.retrieval.search_messages(
            scope=ContactScope(self.owner_id, self.contact_a)
        )
        restored_b = self.retrieval.search_messages(
            scope=ContactScope(self.owner_id, self.contact_b)
        )
        self.assertEqual((len(restored_a), len(restored_b)), (2, 1))
        self.assertEqual(
            {message.message_id for message in (*messages_a, *messages_b)},
            {message.message_id for message in (*restored_a, *restored_b)},
        )
