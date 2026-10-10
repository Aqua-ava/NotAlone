"""前台定位到消息入库的端到端接线测试。

真实 PostgreSQL 测试库 + 脚本化 fake CLI + 内存 fake 探针，覆盖首次
绑定确认、重名一次性选择、切换、补读、暂停、去重、删除与联系人隔离；
全部数据为合成数据，不连接真实微信。
"""

from __future__ import annotations

import json
import os
import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.conversation.matcher import (
    BindingMatchReason,
    FrontSessionEvidence,
)
from notalone.front_sync import (
    FrontSessionProbeObservation,
    FrontSyncPhase,
)
from notalone.front_sync.probe_adapter import FrontSessionQuality, ProbeAdapterError
from notalone.front_sync.sync_engine import (
    BindingConfirmationError,
    FrontSyncCycleReport,
    FrontSyncEngine,
)
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.scopes import ContactScope
from notalone.wechat_cli import LocalWechatCli
from tests.integration.front_sync.cli_fakes import (
    ScriptedCliRunner,
    candidate_json as _candidate,
    tail_stdout as _tail_stdout,
)


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
_NAME_A_RENAMED = "合成甲的新名字"
_SECRET_TEXT = "机密合成正文-不应出现在展示输出"
_SECRET_PREVIEW = "机密合成预览-不应出现在展示输出"


def _media_event_stdout(talker: str, local_id: int, *, base_time: int) -> str:
    """非文字事件：只推进水位，不产生规范消息。"""

    return json.dumps(
        {
            "type": "message",
            "cursor": f"local_id:{local_id}",
            "message": {
                "id": {"local_id": local_id, "talker": talker},
                "kind": "image",
                "create_time": base_time + local_id,
            },
        },
        ensure_ascii=False,
    )


class FakeProbe:
    """内存前台探针：由测试直接设置前台状态与证据。"""

    def __init__(self) -> None:
        self.observation = FrontSessionProbeObservation(
            wechat_in_front=False, evidence=None
        )
        self.error: ProbeAdapterError | None = None
        self.calls = 0

    def observe(self) -> FrontSessionProbeObservation:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.observation


class FrontSyncEndToEndTest(unittest.TestCase):
    """只验证合成联系人的端到端接线，不连接真实微信。"""

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
                (self.owner_id, "端到端同步用户"),
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
        self.runner = ScriptedCliRunner()
        self.runner.candidates_by_query[_NAME_A] = [_candidate(_TALKER_A, _NAME_A)]
        self.runner.candidates_by_query[_NAME_B] = [_candidate(_TALKER_B, _NAME_B)]
        self.probe = FakeProbe()
        self.bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        self.sync_state = PostgresFrontSyncStateStore(TEST_DATABASE_URL)
        self.cli = LocalWechatCli(runner=self.runner)
        self.now = 1_000_000_000.0
        lifecycle = FrontSyncEngineLifecycleFactory.build(self)
        self.engine = FrontSyncEngine(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            probe=self.probe,
            lifecycle=lifecycle,
            bindings=self.bindings,
            sync_state=self.sync_state,
            cli=self.cli,
            clock=lambda: self.now,
        )
        self.engine.enable_sync()

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    # ------------------------------------------------------------------
    # 测试辅助
    # ------------------------------------------------------------------

    def _front(self, display_name: str | None, *, preview: str | None = None) -> None:
        self.probe.observation = FrontSessionProbeObservation(
            wechat_in_front=display_name is not None,
            selected_row_name=display_name,
            quality=FrontSessionQuality("minimal-region-v1", 1, 1),
            evidence=(
                None
                if display_name is None
                else FrontSessionEvidence(
                    display_name=display_name, preview_text=preview
                )
            ),
        )

    def _away(self) -> None:
        self.probe.observation = FrontSessionProbeObservation(
            wechat_in_front=False, evidence=None
        )

    def _message_count(self, contact_id: UUID) -> int:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(
                """
                SELECT count(*)
                FROM public.message
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, contact_id),
            ).fetchone()[0]

    def _watermark(self, contact_id: UUID) -> int | None:
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

    def _last_observation(self, contact_id: UUID) -> tuple | None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(
                """
                SELECT mode, cli_version, record_count, last_local_id
                FROM public.local_wechat_observation
                WHERE owner_id = %s AND contact_id = %s
                ORDER BY read_at DESC, created_at DESC
                LIMIT 1
                """,
                (self.owner_id, contact_id),
            ).fetchone()

    def _confirm_a(self) -> FrontSyncCycleReport:
        """走一次性确认把甲绑定到当前前台会话。"""

        self._front(_NAME_A)
        return self.engine.confirm_binding(
            contact_id=self.contact_a, locator=_TALKER_A
        )

    # ------------------------------------------------------------------
    # 绑定确认与自动切换
    # ------------------------------------------------------------------

    def test_unverified_or_inconsistent_observation_cannot_reuse_active_binding(self) -> None:
        self._confirm_a()
        for row, quality in [
            (_NAME_A, None),
            (_NAME_A, FrontSessionQuality("minimal-region-v1", 1, 0.89)),
            (_NAME_B, FrontSessionQuality("minimal-region-v1", 1, 1)),
        ]:
            with self.subTest(row=row, quality=quality):
                self.probe.observation = FrontSessionProbeObservation(
                    wechat_in_front=True,
                    evidence=FrontSessionEvidence(display_name=_NAME_A),
                    selected_row_name=row, quality=quality,
                )
                previous_tail_calls = len(self.runner.tail_calls)
                report = self.engine.cycle()
                self.assertNotEqual(report.phase, FrontSyncPhase.ACTIVE)
                self.assertIsNone(report.active_contact_id)
                self.assertEqual(len(self.runner.tail_calls), previous_tail_calls)
                with self.assertRaises(BindingConfirmationError):
                    self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)

    def test_bad_quality_invalidates_previous_candidate_selection(self) -> None:
        for operation in ["cycle", "confirm"]:
            with self.subTest(operation=operation):
                self._front(_NAME_A)
                self.assertTrue(self.engine.cycle().candidates)
                self.probe.observation = FrontSessionProbeObservation(
                    wechat_in_front=True, evidence=FrontSessionEvidence(display_name=_NAME_A),
                    selected_row_name=_NAME_A,
                )
                if operation == "cycle":
                    self.assertFalse(self.engine.cycle().candidates)
                else:
                    with self.assertRaises(BindingConfirmationError):
                        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)
                with self.assertRaises(BindingConfirmationError):
                    self.engine.confirm_pending_binding(contact_id=self.contact_a, locator=_TALKER_A)

    def test_probe_failure_invalidates_previous_candidate_selection(self) -> None:
        for code in ["probe_output_invalid", "minimal_region_layout_changed"]:
            for operation in ["cycle", "confirm"]:
                with self.subTest(code=code, operation=operation):
                    self.probe.error = None
                    self._front(_NAME_A)
                    self.assertTrue(self.engine.cycle().candidates)
                    self.probe.error = ProbeAdapterError(code, "合成探针失败")
                    if operation == "cycle":
                        self.assertFalse(self.engine.cycle().candidates)
                    else:
                        with self.assertRaises(BindingConfirmationError):
                            self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)
                    with self.assertRaises(BindingConfirmationError):
                        self.engine.confirm_pending_binding(contact_id=self.contact_a, locator=_TALKER_A)

    def test_first_binding_needs_confirmation_then_ingests_and_auto_confirms(
        self,
    ) -> None:
        self._front(_NAME_A)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "端到端合成消息一", False)])
        )

        report = self.engine.cycle()

        self.assertTrue(report.sync_enabled)
        self.assertEqual(report.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertEqual(
            report.decision_reason, BindingMatchReason.FIRST_BINDING_UNIQUE
        )
        self.assertEqual(
            [(c.username, c.display_name) for c in report.candidates],
            [(_TALKER_A, _NAME_A)],
        )
        self.assertEqual(report.batch_message_count, 0)
        self.assertEqual(self._message_count(self.contact_a), 0)
        self.assertEqual(self.runner.tail_calls, [])

        # 选择之后立即读入首批消息。
        report = self.engine.confirm_binding(
            contact_id=self.contact_a, locator=_TALKER_A
        )
        self.assertEqual(report.phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(report.active_contact_id, self.contact_a)
        self.assertEqual(
            report.decision_reason, BindingMatchReason.CONFIRMED_ACTIVE_BINDING
        )
        self.assertEqual(report.batch_message_count, 1)
        self.assertTrue(report.probe_available)
        self.assertTrue(report.wechat_in_front)
        self.assertTrue(report.cli_available)
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 10)

        # 观察来源可查询：模式、CLI 版本、计数与水位都入库。
        observation = self._last_observation(self.contact_a)
        self.assertEqual(observation[:3], ("live", "1.6.20-test", 1))
        self.assertEqual(observation[3], 10)

        # 绑定证据保存 display name 与时间/预览摘要，不保存预览原文。
        binding = self.bindings.read_active_by_locator(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            conversation_locator=_TALKER_A,
        )
        self.assertIsNotNone(binding)
        assert binding is not None
        self.assertEqual(binding.display_name, _NAME_A)
        self.assertEqual(binding.scope.contact_id, self.contact_a)

        # 正常读取不再要求重复确认。
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(11, "端到端合成消息二", True)])
        )
        report = self.engine.cycle()
        self.assertEqual(report.phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(
            report.decision_reason, BindingMatchReason.CONFIRMED_ACTIVE_BINDING
        )
        self.assertEqual(report.batch_message_count, 1)
        self.assertEqual(self._message_count(self.contact_a), 2)

        # from_me 映射为说话人并可查询。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            speakers = {
                row[0]
                for row in connection.execute(
                    """
                    SELECT speaker
                    FROM public.message
                    WHERE owner_id = %s AND contact_id = %s
                    """,
                    (self.owner_id, self.contact_a),
                ).fetchall()
            }
        self.assertEqual(speakers, {"contact", "user"})

    def test_pending_binding_confirmation_survives_app_focus_change(self) -> None:
        # 微信前台时已经得到候选；随后模拟绑定弹窗让 NotAlone 抢到焦点，
        # 选择联系人仍应消费刚才捕获的待确认证据。
        self._front(_NAME_A)
        report = self.engine.cycle()

        self.assertEqual(
            report.decision_reason, BindingMatchReason.FIRST_BINDING_UNIQUE
        )
        self._away()
        away_report = self.engine.cycle()
        self.assertEqual(away_report.phase, FrontSyncPhase.WAITING_FOREGROUND)
        self.assertEqual(
            [(c.username, c.display_name) for c in away_report.candidates],
            [(_TALKER_A, _NAME_A)],
        )

        confirmed = self.engine.confirm_pending_binding(
            contact_id=self.contact_a,
            locator=_TALKER_A,
        )

        self.assertEqual(confirmed.phase, FrontSyncPhase.WAITING_FOREGROUND)
        binding = self.bindings.read_active_by_locator(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            conversation_locator=_TALKER_A,
        )
        self.assertIsNotNone(binding)
        self.assertEqual(self._message_count(self.contact_a), 0)
        self.assertEqual(self.runner.tail_calls, [])

    def test_pending_binding_confirmation_expires(self) -> None:
        self._front(_NAME_A)
        self.engine.cycle()
        self.now += 61.0
        self._away()

        with self.assertRaises(BindingConfirmationError) as expired:
            self.engine.confirm_pending_binding(
                contact_id=self.contact_a,
                locator=_TALKER_A,
            )

        self.assertEqual(expired.exception.code, "pending_selection_expired")
        self.assertIsNone(
            self.bindings.read_active_by_locator(
                owner_id=self.owner_id,
                channel=_CHANNEL,
                account_scope=_ACCOUNT,
                conversation_locator=_TALKER_A,
            )
        )

    def test_duplicate_names_require_one_time_selection(self) -> None:
        self.runner.candidates_by_query[_NAME_A] = [
            _candidate("wxid_duplicate_one", _NAME_A),
            _candidate(_TALKER_A, _NAME_A),
        ]
        self._front(_NAME_A)

        report = self.engine.cycle()

        self.assertEqual(report.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertEqual(
            report.decision_reason,
            BindingMatchReason.AMBIGUOUS_REQUIRES_SELECTION,
        )
        self.assertEqual(len(report.candidates), 2)

        report = self.engine.confirm_binding(
            contact_id=self.contact_a, locator=_TALKER_A
        )
        self.assertEqual(report.phase, FrontSyncPhase.ACTIVE)

        # 选择之后同一会话自动通过，不重复确认。
        report = self.engine.cycle()
        self.assertEqual(
            report.decision_reason, BindingMatchReason.CONFIRMED_ACTIVE_BINDING
        )

    def test_ocr_distorted_name_falls_back_to_recent_sessions(self) -> None:
        # OCR 把标题读成变形名，resolve-chat 落空；回退最近会话转一次性选择。
        distorted = "FSM~cxk"
        self.runner.sessions_json = [_candidate(_TALKER_A, "FSM💕cxk")]
        self._front(distorted)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "变形名合成消息", False)])
        )

        report = self.engine.cycle()

        self.assertEqual(report.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertEqual(
            report.decision_reason,
            BindingMatchReason.UNMATCHED_REQUIRES_SELECTION,
        )
        self.assertEqual(
            [(c.username, c.display_name) for c in report.candidates],
            [(_TALKER_A, "FSM💕cxk")],
        )
        self.assertEqual(self._message_count(self.contact_a), 0)

        report = self.engine.confirm_binding(
            contact_id=self.contact_a, locator=_TALKER_A
        )
        self.assertEqual(report.phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(report.batch_message_count, 1)

        # 绑定保存观察名；之后同一观察名自动确认，不再要求选择。
        binding = self.bindings.read_active_by_locator(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            conversation_locator=_TALKER_A,
        )
        self.assertIsNotNone(binding)
        assert binding is not None
        self.assertEqual(binding.display_name, distorted)

        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(11, "变形名后续消息", False)])
        )
        report = self.engine.cycle()
        self.assertEqual(
            report.decision_reason, BindingMatchReason.CONFIRMED_ACTIVE_BINDING
        )
        self.assertEqual(self._message_count(self.contact_a), 2)

    def test_switch_a_b_a_isolates_scopes_and_reply_context(self) -> None:
        self._front(_NAME_A)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "甲的端到端消息", False)])
        )
        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)

        # 切到乙：首次绑定需要一次性确认。
        self._front(_NAME_B)
        self.runner.tail_queues[_TALKER_B].append(
            _tail_stdout(_TALKER_B, [(20, "乙的端到端消息", False)])
        )
        report = self.engine.cycle()
        self.assertEqual(
            report.decision_reason, BindingMatchReason.FIRST_BINDING_UNIQUE
        )
        self.engine.confirm_binding(contact_id=self.contact_b, locator=_TALKER_B)
        self.assertEqual(self._message_count(self.contact_b), 1)
        self.assertEqual(self._watermark(self.contact_b), 20)

        # 切回甲：自动确认并从甲自己的水位补读。
        self._front(_NAME_A)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(11, "甲的补读消息一", False), (12, "甲的补读消息二", True)],
            )
        )
        report = self.engine.cycle()
        self.assertEqual(
            report.decision_reason, BindingMatchReason.CONFIRMED_ACTIVE_BINDING
        )
        self.assertEqual(report.active_contact_id, self.contact_a)
        self.assertEqual(self._message_count(self.contact_a), 3)
        self.assertEqual(self._message_count(self.contact_b), 1)
        self.assertEqual(self._watermark(self.contact_a), 12)
        self.assertEqual(self._last_observation(self.contact_a)[0], "cli_catchup")
        self.assertEqual(
            self.runner.tail_calls,
            [
                (_TALKER_A, None),
                (_TALKER_B, None),
                (_TALKER_A, "local_id:10"),
            ],
        )

        # 回复上下文只能读取已验证联系人范围内的规范消息。
        retrieval = PostgresRetrieval(TEST_DATABASE_URL)
        hits_a = retrieval.search_messages(
            scope=ContactScope(
                owner_id=self.owner_id, contact_id=self.contact_a
            ),
        )
        hits_b = retrieval.search_messages(
            scope=ContactScope(
                owner_id=self.owner_id, contact_id=self.contact_b
            ),
        )
        self.assertEqual(
            {hit.text for hit in hits_a},
            {"甲的端到端消息", "甲的补读消息一", "甲的补读消息二"},
        )
        self.assertEqual({hit.text for hit in hits_b}, {"乙的端到端消息"})

    # ------------------------------------------------------------------
    # 暂停、去重与删除
    # ------------------------------------------------------------------

    def test_disabled_window_skips_backlog_after_reenable(self) -> None:
        self._front(_NAME_A)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A, [(10, "关闭前合成消息", False)], base_time=int(self.now)
            )
        )
        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)
        self.assertEqual(self._message_count(self.contact_a), 1)

        self.now += 100.0
        self.engine.disable_sync()
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A, [(11, "关闭期间合成消息", False)], base_time=int(self.now)
            )
        )
        report = self.engine.cycle()
        self.assertFalse(report.sync_enabled)
        self.assertEqual(report.phase, FrontSyncPhase.SYNC_DISABLED)
        self.assertEqual(self.runner.tail_calls, [(_TALKER_A, None)])

        # 重新开启后关闭窗口内消息只前移水位；窗口之后的消息正常写入。
        self.now += 100.0
        self.engine.enable_sync()
        report = self.engine.cycle()
        self.assertTrue(report.sync_enabled)
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 11)

        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A, [(12, "开启后合成消息", False)], base_time=int(self.now)
            )
        )
        report = self.engine.cycle()
        self.assertEqual(report.batch_message_count, 1)
        self.assertEqual(self._message_count(self.contact_a), 2)

    def test_import_overlap_dedups_across_sources(self) -> None:
        # 预置一条历史导入消息；CLI 观察写入相同稳定身份时复用。
        source_id = uuid4()
        message_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'overlap-e2e.jsonl',
                          %s, 1, 'active')
                """,
                (source_id, self.owner_id, self.contact_a, "f" * 64),
            )
            connection.execute(
                """
                INSERT INTO public.message (
                    id, owner_id, contact_id,
                    speaker, message_type, text_content
                ) VALUES (%s, %s, %s, 'contact', 'text', %s)
                """,
                (
                    message_id,
                    self.owner_id,
                    self.contact_a,
                    "导入与观察重叠的合成消息",
                ),
            )
            connection.execute(
                """
                INSERT INTO public.wechat_message_metadata (
                    message_id, owner_id, contact_id,
                    external_local_id, external_server_id,
                    external_talker, source_create_time
                ) VALUES (%s, %s, %s, 200, 'server_200', 'wxid_import', 2000)
                """,
                (message_id, self.owner_id, self.contact_a),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, source_document_id, source_locator, raw_payload
                ) VALUES (gen_random_uuid(), %s, %s, %s,
                          'source_document', %s, 'import:200', '{}'::jsonb)
                """,
                (message_id, self.owner_id, self.contact_a, source_id),
            )

        self._front(_NAME_A)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(
                _TALKER_A,
                [(200, "导入与观察重叠的合成消息", False)],
                base_time=1800,  # create_time = 1800 + 200 = 2000
            )
        )
        report = self.engine.confirm_binding(
            contact_id=self.contact_a, locator=_TALKER_A
        )

        self.assertEqual(report.batch_message_count, 1)
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 200)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            ref_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message_source_ref
                WHERE message_id = %s
                """,
                (message_id,),
            ).fetchone()[0]
        self.assertEqual(ref_count, 2)

    def test_revoked_binding_stops_reading(self) -> None:
        self._front(_NAME_A)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "撤销前合成消息", False)])
        )
        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)
        binding = self.bindings.read_active_by_locator(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            conversation_locator=_TALKER_A,
        )
        assert binding is not None

        self.bindings.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=binding.binding_id,
        )
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(11, "撤销后合成消息", False)])
        )
        report = self.engine.cycle()

        # 撤销后回到一次性绑定路径，期间不读取、不写入。
        self.assertEqual(report.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertEqual(
            report.decision_reason, BindingMatchReason.FIRST_BINDING_UNIQUE
        )
        self.assertEqual(report.batch_message_count, 0)
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 10)
        self.assertEqual(self.runner.tail_calls, [(_TALKER_A, None)])

    # ------------------------------------------------------------------
    # 失败关闭与异常路径
    # ------------------------------------------------------------------

    def test_group_chat_does_not_match_private_binding(self) -> None:
        self.runner.candidates_by_query["合成群"] = [
            _candidate("chatroom_synthetic", "合成群", chat_type="group")
        ]
        self._front("合成群")

        report = self.engine.cycle()

        self.assertEqual(report.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertEqual(
            report.decision_reason, BindingMatchReason.NO_CANDIDATE
        )
        self.assertEqual(report.candidates, ())
        self.assertEqual(self.runner.tail_calls, [])

    def test_media_events_advance_watermark_without_message(self) -> None:
        self._front(_NAME_A)
        media = _media_event_stdout(_TALKER_A, 30, base_time=2_000_000_000)
        text = json.dumps(
            {
                "type": "message",
                "cursor": "local_id:31",
                "message": {
                    "id": {"local_id": 31, "talker": _TALKER_A},
                    "kind": "text",
                    "text": "媒体后的文字消息",
                    "is_from_me": False,
                    "create_time": 2_000_000_031,
                },
            },
            ensure_ascii=False,
        )
        self.runner.tail_queues[_TALKER_A].append(f"{media}\n{text}")

        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)

        # 媒体事件不写入消息，但水位越过它继续前进。
        self.assertEqual(self._message_count(self.contact_a), 1)
        self.assertEqual(self._watermark(self.contact_a), 31)

    def test_cli_failure_and_probe_failure_fail_closed(self) -> None:
        self._front(_NAME_A)
        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)

        # CLI tail 失败：进入 FAILED，不写入。
        self.runner.tail_error = FileNotFoundError("/private/path/wechat-cli")
        report = self.engine.cycle()
        self.assertEqual(report.phase, FrontSyncPhase.FAILED)
        self.assertEqual(report.failure_code, "cli_not_found")
        self.assertEqual(self._message_count(self.contact_a), 0)

        # 退避结束后重试成功，恢复正常读取。
        self.now += 60.0
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "恢复后合成消息", False)])
        )
        report = self.engine.cycle()
        self.assertEqual(report.phase, FrontSyncPhase.ACTIVE)
        self.assertEqual(self._message_count(self.contact_a), 1)

        # 探针不可用：停止读取并展示探针失败原因。
        self.probe.error = ProbeAdapterError("probe_not_found", "探针不可用。")
        report = self.engine.cycle()
        self.assertFalse(report.probe_available)
        self.assertEqual(report.failure_code, "probe_not_found")
        self.assertEqual(report.phase, FrontSyncPhase.WAITING_FOREGROUND)

        # 微信不在前台：不读取。
        self.probe.error = None
        self._away()
        report = self.engine.cycle()
        self.assertTrue(report.probe_available)
        self.assertFalse(report.wechat_in_front)
        self.assertEqual(report.phase, FrontSyncPhase.WAITING_FOREGROUND)

    def test_cli_version_failure_marks_cli_unavailable(self) -> None:
        self._front(_NAME_A)
        self.runner.version_error = FileNotFoundError("/private/path/wechat-cli")

        report = self.engine.cycle()

        self.assertFalse(report.cli_available)
        # CLI 不可见原因可查询；观察门禁本身不受影响。
        self.assertEqual(report.phase, FrontSyncPhase.UNAVAILABLE)

    def test_binding_name_change_requires_one_confirmation(self) -> None:
        self._front(_NAME_A)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, "改名前合成消息", False)])
        )
        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)

        # 微信侧改名：候选仍指向同一外部会话，但需要一次确认。
        self.runner.candidates_by_query[_NAME_A_RENAMED] = [
            _candidate(_TALKER_A, _NAME_A_RENAMED)
        ]
        self._front(_NAME_A_RENAMED)
        report = self.engine.cycle()
        self.assertEqual(report.phase, FrontSyncPhase.UNAVAILABLE)
        self.assertEqual(
            report.decision_reason, BindingMatchReason.BINDING_NAME_CHANGED
        )

        report = self.engine.confirm_binding(
            contact_id=self.contact_a, locator=_TALKER_A
        )
        self.assertEqual(report.phase, FrontSyncPhase.ACTIVE)
        binding = self.bindings.read_active_by_locator(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            conversation_locator=_TALKER_A,
        )
        assert binding is not None
        self.assertEqual(binding.display_name, _NAME_A_RENAMED)

        # 确认一次之后自动通过。
        report = self.engine.cycle()
        self.assertEqual(
            report.decision_reason, BindingMatchReason.CONFIRMED_ACTIVE_BINDING
        )

    # ------------------------------------------------------------------
    # 确认入口的失败关闭
    # ------------------------------------------------------------------

    def test_confirm_binding_rejects_invalid_requests(self) -> None:
        self._front(_NAME_A)

        with self.assertRaises(BindingConfirmationError) as unknown:
            self.engine.confirm_binding(
                contact_id=self.contact_a, locator="wxid_unknown"
            )
        self.assertEqual(unknown.exception.code, "candidate_not_found")

        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)

        # 已经确认过的会话没有待选择项。
        with self.assertRaises(BindingConfirmationError) as pending:
            self.engine.confirm_binding(
                contact_id=self.contact_a, locator=_TALKER_A
            )
        self.assertEqual(pending.exception.code, "no_pending_selection")

        # 微信离开前台时不能确认。
        self._away()
        with self.assertRaises(BindingConfirmationError) as away:
            self.engine.confirm_binding(
                contact_id=self.contact_b, locator=_TALKER_B
            )
        self.assertEqual(away.exception.code, "front_session_unavailable")

        # 探针不可用时不能确认。
        self._front(_NAME_B)
        self.probe.error = ProbeAdapterError("probe_timeout", "探针超时。")
        with self.assertRaises(BindingConfirmationError) as probe_failed:
            self.engine.confirm_binding(
                contact_id=self.contact_b, locator=_TALKER_B
            )
        self.assertEqual(probe_failed.exception.code, "probe_unavailable")
        self.probe.error = None

    def test_confirm_binding_rejects_wrong_contact_on_name_change(self) -> None:
        self._front(_NAME_A)
        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)
        self.runner.candidates_by_query[_NAME_A_RENAMED] = [
            _candidate(_TALKER_A, _NAME_A_RENAMED)
        ]
        self._front(_NAME_A_RENAMED)
        self.engine.cycle()

        with self.assertRaises(BindingConfirmationError) as caught:
            self.engine.confirm_binding(
                contact_id=self.contact_b, locator=_TALKER_A
            )
        self.assertEqual(caught.exception.code, "binding_not_found")

    # ------------------------------------------------------------------
    # 展示层不泄漏正文
    # ------------------------------------------------------------------

    def test_report_render_excludes_message_and_preview_text(self) -> None:
        from notalone.front_sync.command import render_report_lines

        self._front(_NAME_A, preview=_SECRET_PREVIEW)
        self.runner.tail_queues[_TALKER_A].append(
            _tail_stdout(_TALKER_A, [(10, _SECRET_TEXT, False)])
        )
        self.engine.confirm_binding(contact_id=self.contact_a, locator=_TALKER_A)

        report = self.engine.cycle()
        rendered = "\n".join(render_report_lines(report))

        self.assertNotIn(_SECRET_TEXT, rendered)
        self.assertNotIn(_SECRET_PREVIEW, rendered)
        self.assertIn("phase=active", rendered)
        self.assertIn(f"contact_id={self.contact_a}", rendered)


class FrontSyncEngineLifecycleFactory:
    """集中构造生命周期，避免测试 setUp 噪音过大。"""

    @staticmethod
    def build(test: FrontSyncEndToEndTest):
        from notalone.front_sync import TailLifecycle

        return TailLifecycle(
            owner_id=test.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            cli=test.cli,
            bindings=test.bindings,
            observation_store=PostgresObservationStore(TEST_DATABASE_URL),
            sync_state=test.sync_state,
            clock=lambda: test.now,
        )


if __name__ == "__main__":
    unittest.main()
