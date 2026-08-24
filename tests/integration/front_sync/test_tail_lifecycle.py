"""前台 tail 生命周期的端到端编排测试。

使用真实 PostgreSQL 测试库与脚本化 fake CLI，验证按联系人切换、
补读、暂停、重启恢复与失败重试；全部数据为合成数据。
"""

from __future__ import annotations

import json
import os
import unittest
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Sequence
from uuid import uuid4

import psycopg

from notalone.conversation.matcher import FrontSessionEvidence
from notalone.front_sync import (
    FrontSyncPhase,
    FrontSyncStatus,
    TailLifecycle,
)
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.wechat_cli import LocalWechatCli


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)

_CHANNEL = "wechat"
_ACCOUNT = "synthetic-account"
_TALKER_A = "wxid_front_a"
_TALKER_B = "wxid_front_b"
_NAME_A = "合成甲"
_NAME_B = "合成乙"


@dataclass(frozen=True)
class FakeCommandResult:
    returncode: int
    stdout: str
    stderr: str = ""


def _candidate(username: str, display_name: str) -> dict:
    return {
        "username": username,
        "display_name": display_name,
        "match": "display_name_exact",
        "chat_type": "private",
        "last_timestamp": 1787486383,
    }


def _tail_stdout(
    talker: str,
    events: Sequence[tuple[int, str, bool]],
    *,
    base_time: int = 2_000_000_000,
) -> str:
    """按 (local_id, 正文, 是否我方) 生成 tail JSONL 输出。

    消息原始时间为 ``base_time + local_id``，便于围绕开关时刻构造窗口。
    """

    lines = []
    for local_id, text, is_from_me in events:
        lines.append(
            json.dumps(
                {
                    "type": "message",
                    "cursor": f"local_id:{local_id}",
                    "message": {
                        "id": {"local_id": local_id, "talker": talker},
                        "kind": "text",
                        "text": text,
                        "is_from_me": is_from_me,
                        "create_time": base_time + local_id,
                    },
                },
                ensure_ascii=False,
            )
        )
    return "\n".join(lines)


class ScriptedCliRunner:
    """按命令分发的脚本化 CLI；tail 输出按 talker 排队消费。"""

    def __init__(self) -> None:
        self.candidates_by_query: dict[str, list[dict]] = {}
        self.tail_queues: dict[str, deque[str]] = defaultdict(deque)
        self.tail_calls: list[tuple[str, str | None]] = []
        self.tail_error: Exception | None = None
        self.version_calls = 0

    def __call__(self, command: tuple[str, ...]) -> FakeCommandResult:
        subcommand = command[1]
        if subcommand == "--version":
            self.version_calls += 1
            return FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {"ok": True, "data": {"version": "1.6.20-test"}}
                ),
            )
        if subcommand == "resolve-chat":
            query = command[2]
            return FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "ok": True,
                        "data": {
                            "query": query,
                            "candidates": self.candidates_by_query.get(query, []),
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        if subcommand == "tail":
            if self.tail_error is not None:
                error, self.tail_error = self.tail_error, None
                raise error
            talker = command[2]
            cursor = None
            if "--cursor" in command:
                cursor = command[command.index("--cursor") + 1]
            self.tail_calls.append((talker, cursor))
            queue = self.tail_queues[talker]
            stdout = queue.popleft() if queue else ""
            return FakeCommandResult(returncode=0, stdout=stdout)
        raise AssertionError(f"测试未预期的 CLI 命令：{subcommand}")


class TailLifecycleTest(unittest.TestCase):
    """只验证合成联系人的生命周期编排，不连接真实微信。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = 'front_sync_state'
                    """
                ).fetchone()
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 022 同步开关迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_a = uuid4()
        self.contact_b = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "前台同步用户"),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_a, "联系人甲"),
                        (self.owner_id, self.contact_b, "联系人乙"),
                    ),
                )
        bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        self.binding_a = bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            conversation_locator=_TALKER_A,
            display_name=_NAME_A,
        )
        self.binding_b = bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_b,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            conversation_locator=_TALKER_B,
            display_name=_NAME_B,
        )
        self.runner = ScriptedCliRunner()
        self.runner.candidates_by_query[_NAME_A] = [_candidate(_TALKER_A, _NAME_A)]
        self.runner.candidates_by_query[_NAME_B] = [_candidate(_TALKER_B, _NAME_B)]
        self.now = 1_000_000_000.0
        self.lifecycle = self._build_lifecycle()
        self.lifecycle.enable_sync()

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _build_lifecycle(self) -> TailLifecycle:
        return TailLifecycle(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            cli=LocalWechatCli(runner=self.runner),
            bindings=PostgresConversationBindingRepository(TEST_DATABASE_URL),
            observation_store=PostgresObservationStore(TEST_DATABASE_URL),
            sync_state=PostgresFrontSyncStateStore(TEST_DATABASE_URL),
            clock=lambda: self.now,
        )

    def _observe(self, display_name: str | None) -> FrontSyncStatus:
        evidence = (
            None
            if display_name is None
            else FrontSessionEvidence(display_name=display_name)
        )
        self.lifecycle.observe_front_session(
            wechat_in_front=display_name is not None,
            evidence=evidence,
        )
        return self.lifecycle.status()

    def _message_count(self, contact_id) -> int:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(
                """
                SELECT count(*)
                FROM public.message
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, contact_id),
            ).fetchone()[0]

    def _last_observation_mode(self, contact_id) -> str | None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            row = connection.execute(
                """
                SELECT mode
                FROM public.local_wechat_observation
                WHERE owner_id = %s AND contact_id = %s
                ORDER BY read_at DESC, created_at DESC
                LIMIT 1
                """,
                (self.owner_id, contact_id),
            ).fetchone()
        return None if row is None else row[0]

    def _watermark(self, contact_id) -> int | None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            row = connection.execute(
                """
                SELECT last_local_id
                FROM public.wechat_observation_cursor
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, contact_id),
            ).fetchone()
        return None if row is None else row[0]

    def test_first_start_reads_live_batch_from_cursor_none(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "首条合成消息", False)])
        )

        status = self._observe(_NAME_A)
        self.lifecycle.poll()

        self.assertEqual(status.phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(status.active_contact_id, self.contact_a)
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 10)
        self.assertEqual(self._last_observation_mode(self.contact_a), "live")
        self.assertEqual(self.runner.tail_calls, [(_TALKER_A, None)])

    def test_switch_a_b_a_isolates_cursors_and_marks_catchup(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "甲的合成消息", False)])
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()

        # 切到乙：旧联系人停止，新联系人使用自己的 cursor（首次为空）。
        self.runner.tail_queues[_TALKER_B].append(
            _tail_stdout(_TALKER_B, [(20, "乙的合成消息", False)])
        )
        status_b = self._observe(_NAME_B)
        self.lifecycle.poll()

        self.assertEqual(status_b.active_contact_id, self.contact_b)
        self.assertEqual(self._message_count(self.contact_b), 1)
        self.assertEqual(self._watermark(self.contact_b), 20)
        self.assertEqual(self._watermark(self.contact_a), 10)

        # 甲离开期间来了新消息；切回甲只补读甲自己的窗口。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(11, "甲的补读消息一", False), (12, "甲的补读消息二", True)],
            )
        )
        status_a = self._observe(_NAME_A)
        self.lifecycle.poll()

        self.assertEqual(status_a.active_contact_id, self.contact_a)
        self.assertEqual(self._message_count(self.contact_a), 3)
        self.assertEqual(self._watermark(self.contact_a), 12)
        self.assertEqual(self._message_count(self.contact_b), 1)
        self.assertEqual(self._last_observation_mode(self.contact_a), "cli_catchup")
        self.assertEqual(
            self.runner.tail_calls,
            [
                (_TALKER_A, None),
                (_TALKER_B, None),
                (_TALKER_A, "local_id:10"),
            ],
        )
        # 补读批次之后的继续读取回到 live 模式。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(13, "甲的实时消息", False)])
        )
        self.lifecycle.poll()
        self.assertEqual(self._last_observation_mode(self.contact_a), "live")

    def test_disabled_sync_stops_reading_and_skips_backlog_on_enable(
        self,
    ) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(10, "关闭前合成消息", False)],
                base_time=int(self.now),
            )
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()
        self.assertEqual(self._watermark(self.contact_a), 10)

        self.now += 100.0
        self.lifecycle.disable_sync()
        self.assertEqual(
            self.lifecycle.status().phase, FrontSyncPhase.SYNC_DISABLED
        )

        # 关闭期间产生消息：观察与轮询都不读取。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(11, "关闭期间合成消息", False)],
                base_time=int(self.now),
            )
        )
        status = self._observe(_NAME_A)
        self.lifecycle.poll()
        self.assertEqual(status.phase, FrontSyncPhase.SYNC_DISABLED)
        self.assertEqual(self.runner.tail_calls, [(_TALKER_A, None)])
        self.assertEqual(self._message_count(self.contact_a), 1)

        # 重新开启后，关闭窗口内的消息只前移水位、不写入。
        self.now += 100.0
        self.lifecycle.enable_sync()
        self._observe(_NAME_A)
        self.lifecycle.poll()
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 11)

        # 开启之后的新消息正常写入 live。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(12, "开启后合成消息", False)],
                base_time=int(self.now),
            )
        )
        self.lifecycle.poll()
        self.assertEqual(self._message_count(self.contact_a), 2)
        self.assertEqual(self._last_observation_mode(self.contact_a), "live")

    def test_disabled_window_applies_to_every_contact(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(10, "关闭前合成消息", False)],
                base_time=int(self.now),
            )
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()

        self.now += 100.0
        self.lifecycle.disable_sync()
        self.now += 100.0
        self.lifecycle.enable_sync()

        # 直接切到从未读过的乙：关闭窗口内消息同样不被写入。
        self.runner.tail_queues[_TALKER_B].append(
            _tail_stdout(
                _TALKER_B,
                [(20, "乙关闭窗口内消息", False)],
                base_time=int(self.now) - 100,
            )
        )
        self._observe(_NAME_B)
        self.lifecycle.poll()
        self.assertEqual(self._message_count(self.contact_b), 0)
        self.assertEqual(self._watermark(self.contact_b), 20)

        # 切回甲：甲的关闭窗口内消息也不被补读。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(11, "甲关闭窗口内消息", False)],
                base_time=int(self.now) - 100,
            )
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 11)

        # 窗口之后的消息对两个联系人都正常写入。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(12, "甲窗口后消息", False)],
                base_time=int(self.now),
            )
        )
        self.lifecycle.poll()
        self.assertEqual(self._message_count(self.contact_a), 2)

    def test_wechat_not_in_front_stops_and_restore_catches_up(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "前台合成消息", False)])
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()

        status = self.lifecycle.observe_front_session(
            wechat_in_front=False, evidence=None
        )
        self.assertIsNone(status)
        self.assertEqual(
            self.lifecycle.status().phase, FrontSyncPhase.WAITING_FOREGROUND
        )
        self.assertIsNone(self.lifecycle.status().active_contact_id)

        # 离开前台期间来消息；回到前台后从 cursor 补读。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(11, "离开期间合成消息", False)])
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()

        self.assertEqual(self._message_count(self.contact_a), 2)
        self.assertEqual(self._last_observation_mode(self.contact_a), "cli_catchup")
        self.assertEqual(
            self.runner.tail_calls[-1], (_TALKER_A, "local_id:10")
        )

    def test_restart_with_sync_enabled_recovers_from_cursor(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "重启前合成消息", False)])
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()
        self.assertEqual(self._message_count(self.contact_a), 1)

        # 新实例模拟应用重启：同步开关仍开启，从既有水位恢复。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(11, "重启后合成消息", False)])
        )
        self.lifecycle = self._build_lifecycle()
        self._observe(_NAME_A)
        self.lifecycle.poll()

        self.assertEqual(self._message_count(self.contact_a), 2)
        self.assertEqual(self._watermark(self.contact_a), 11)
        self.assertEqual(
            self.runner.tail_calls[-1], (_TALKER_A, "local_id:10")
        )

    def test_restart_with_sync_disabled_does_not_read(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "重启前合成消息", False)])
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()
        self.lifecycle.disable_sync()

        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(11, "关闭期间合成消息", False)])
        )
        self.lifecycle = self._build_lifecycle()
        self._observe(_NAME_A)
        self.lifecycle.poll()

        self.assertEqual(
            self.lifecycle.status().phase, FrontSyncPhase.SYNC_DISABLED
        )
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 10)

    def test_duplicate_events_do_not_create_duplicate_messages(self) -> None:
        batch = _tail_stdout(_TALKER_A, [(10, "重复合成消息", False)])
        self.runner.tail_queues[_TALKER_A].append(batch)
        self._observe(_NAME_A)
        self.lifecycle.poll()

        # CLI 重复返回同一批事件（例如进程崩溃重放）时不产生重复消息。
        self.runner.tail_queues[_TALKER_A].append(batch)
        self.lifecycle.poll()

        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 10)

    def test_cli_failure_enters_failed_state_and_retries_with_backoff(
        self,
    ) -> None:
        self._observe(_NAME_A)
        self.runner.tail_error = FileNotFoundError("/private/path/wechat-cli")
        self.lifecycle.poll()

        status = self.lifecycle.status()
        self.assertEqual(status.phase, FrontSyncPhase.FAILED)
        self.assertEqual(status.failure_code, "cli_not_found")
        self.assertEqual(self._message_count(self.contact_a), 0)

        # 退避窗口内的轮询不会再次调用 CLI。
        calls_before = len(self.runner.tail_calls)
        self.now += 0.5
        self.lifecycle.poll()
        self.assertEqual(len(self.runner.tail_calls), calls_before)

        # 退避结束后重试成功，恢复正常读取。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "恢复后合成消息", False)])
        )
        self.now += 60.0
        self.lifecycle.poll()
        self.assertEqual(self.lifecycle.status().phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(self._message_count(self.contact_a), 1)

    def test_unresolvable_front_session_stops_reading(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "切换前合成消息", False)])
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()

        status = self._observe("不存在的名字")
        self.assertEqual(status.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertIsNone(status.active_contact_id)

        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(11, "停止后合成消息", False)])
        )
        self.lifecycle.poll()
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self.runner.tail_calls, [(_TALKER_A, None)])

    def test_first_binding_requires_selection_before_reading(self) -> None:
        self.runner.candidates_by_query["未绑定"] = [
            _candidate("wxid_unbound", "未绑定")
        ]

        status = self._observe("未绑定")

        self.assertEqual(status.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertEqual(self.runner.tail_calls, [])
        self.assertEqual(self._message_count(self.contact_a), 0)
        self.assertEqual(self._message_count(self.contact_b), 0)

    def test_repeated_resume_of_same_contact_is_stable(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "并发合成消息", False)])
        )
        self._observe(_NAME_A)
        self._observe(_NAME_A)
        self._observe(_NAME_A)
        self.lifecycle.poll()

        # 重复启动同一联系人不重复读取、不重复写入。
        self.assertEqual(self.runner.tail_calls, [(_TALKER_A, None)])
        self.assertEqual(self._message_count(self.contact_a), 1)

    def test_empty_poll_keeps_active_state_and_watermark(self) -> None:
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "首条合成消息", False)])
        )
        self._observe(_NAME_A)
        self.lifecycle.poll()

        # 没有新消息的轮询保持活跃状态与水位。
        self.lifecycle.poll()
        self.assertEqual(self.lifecycle.status().phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(self._watermark(self.contact_a), 10)
        self.assertEqual(self._message_count(self.contact_a), 1)


if __name__ == "__main__":
    unittest.main()
