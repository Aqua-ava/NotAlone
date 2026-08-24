"""CLI 观察来源与联系人级水位的 PostgreSQL 持久化测试。"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.observation_store import (
    ObservationMode,
    ObservationNotFoundError,
    ObservationWatermarkError,
    PostgresObservationStore,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresObservationStoreTest(unittest.TestCase):
    """只验证合成观察元数据，不连接微信或读取聊天内容。"""

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
                      AND table_name = 'local_wechat_observation'
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
            raise unittest.SkipTest("测试库尚未应用 020 观察来源迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_a = uuid4()
        self.contact_b = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "观察来源用户"),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_a, "合成联系人甲"),
                        (self.owner_id, self.contact_b, "合成联系人乙"),
                    ),
                )
        bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        self.binding_a = bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_a",
        )
        self.binding_b = bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_b,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_b",
        )
        self.store = PostgresObservationStore(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _record(
        self,
        contact_id,
        binding_id,
        *,
        mode=ObservationMode.LIVE,
        since_local_id=None,
        last_local_id,
        locator="wxid_observation_a",
    ):
        return self.store.record_batch(
            owner_id=self.owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            mode=mode,
            cli_version="wechat-cli/0.1.0-test",
            conversation_locator=locator,
            since_local_id=since_local_id,
            last_local_id=last_local_id,
            last_cursor=f"cursor-{last_local_id}",
            record_count=3,
        )

    def test_first_read_has_no_cursor_and_zero_since_is_rejected(self) -> None:
        self.assertIsNone(
            self.store.read_cursor(
                owner_id=self.owner_id, contact_id=self.contact_a
            )
        )

        with self.assertRaises(ObservationWatermarkError):
            self.store.record_batch(
                owner_id=self.owner_id,
                contact_id=self.contact_a,
                binding_id=self.binding_a.binding_id,
                mode=ObservationMode.LIVE,
                cli_version="wechat-cli/0.1.0-test",
                conversation_locator="wxid_observation_a",
                since_local_id=0,
                last_local_id=5,
                last_cursor="cursor-5",
                record_count=3,
            )

    def test_cursors_are_contact_scoped_and_survive_restart(self) -> None:
        self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        self._record(
            self.contact_b,
            self.binding_b.binding_id,
            last_local_id=42,
            locator="wxid_observation_b",
        )

        # 用新的 store 实例模拟进程重启后恢复水位。
        recovered = PostgresObservationStore(TEST_DATABASE_URL)
        cursor_a = recovered.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )
        cursor_b = recovered.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_b
        )

        self.assertEqual(cursor_a.last_local_id, 10)
        self.assertEqual(cursor_a.last_cursor, "cursor-10")
        self.assertEqual(cursor_a.binding_id, self.binding_a.binding_id)
        self.assertEqual(cursor_b.last_local_id, 42)
        self.assertEqual(cursor_b.conversation_locator, "wxid_observation_b")

    def test_switching_a_b_a_keeps_cursors_isolated_and_catchup_marked(self) -> None:
        first = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        self._record(
            self.contact_b,
            self.binding_b.binding_id,
            last_local_id=42,
            locator="wxid_observation_b",
        )

        catchup = self.store.record_batch(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=self.binding_a.binding_id,
            mode=ObservationMode.CLI_CATCHUP,
            cli_version="wechat-cli/0.1.0-test",
            conversation_locator="wxid_observation_a",
            since_local_id=first.last_local_id,
            since_cursor=first.last_cursor,
            last_local_id=17,
            last_cursor="cursor-17",
            record_count=2,
        )

        self.assertEqual(catchup.mode, ObservationMode.CLI_CATCHUP)
        self.assertEqual(catchup.since_local_id, 10)
        cursor_a = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )
        cursor_b = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_b
        )
        self.assertEqual(cursor_a.last_local_id, 17)
        self.assertEqual(cursor_b.last_local_id, 42)

    def test_same_batch_retry_is_idempotent(self) -> None:
        first = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        cursor_before = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )

        retried = self.store.record_batch(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=self.binding_a.binding_id,
            mode=ObservationMode.LIVE,
            cli_version="wechat-cli/0.1.0-test",
            conversation_locator="wxid_observation_a",
            last_local_id=10,
            last_cursor="cursor-10",
            record_count=3,
        )
        cursor_after = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )

        self.assertEqual(retried.observation_id, first.observation_id)
        self.assertEqual(cursor_before.updated_at, cursor_after.updated_at)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            (count,) = connection.execute(
                """
                SELECT count(*)
                FROM public.local_wechat_observation
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, self.contact_a),
            ).fetchone()
        self.assertEqual(count, 1)

    def test_watermark_only_moves_forward(self) -> None:
        self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )

        with self.assertRaises(ObservationWatermarkError):
            self.store.record_batch(
                owner_id=self.owner_id,
                contact_id=self.contact_a,
                binding_id=self.binding_a.binding_id,
                mode=ObservationMode.LIVE,
                cli_version="wechat-cli/0.1.0-test",
                conversation_locator="wxid_observation_a",
                since_local_id=3,
                last_local_id=8,
                last_cursor="cursor-8",
                record_count=1,
            )

    def test_empty_batch_at_current_watermark_is_not_an_error(self) -> None:
        # live 轮询没有新消息时水位持平，不应报错也不倒退。
        self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )

        empty = self.store.record_batch(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=self.binding_a.binding_id,
            mode=ObservationMode.LIVE,
            cli_version="wechat-cli/0.1.0-test",
            conversation_locator="wxid_observation_a",
            since_local_id=10,
            since_cursor="cursor-10",
            last_local_id=10,
            last_cursor="cursor-10",
            record_count=0,
        )

        self.assertEqual(empty.record_count, 0)
        cursor = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )
        self.assertEqual(cursor.last_local_id, 10)

    def test_revoked_or_foreign_binding_is_rejected(self) -> None:
        bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        bindings.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_b,
            binding_id=self.binding_b.binding_id,
        )

        with self.assertRaises(ObservationNotFoundError):
            self._record(
                self.contact_b,
                self.binding_b.binding_id,
                last_local_id=5,
                locator="wxid_observation_b",
            )
        # 绑定与联系人范围不一致时同样拒绝。
        with self.assertRaises(ObservationNotFoundError):
            self._record(
                self.contact_a,
                self.binding_b.binding_id,
                last_local_id=6,
                locator="wxid_observation_b",
            )

    def test_delete_observation_is_scope_checked(self) -> None:
        recorded = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )

        with self.assertRaises(ObservationNotFoundError):
            self.store.delete_observation(
                owner_id=self.owner_id,
                contact_id=self.contact_b,
                observation_id=recorded.observation_id,
            )

        self.store.delete_observation(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=recorded.observation_id,
        )
        # 来源删除不影响已成功推进的水位。
        cursor = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )
        self.assertEqual(cursor.last_local_id, 10)

    def test_delete_observation_removes_refs_and_orphan_messages(self) -> None:
        recorded = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        message_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
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
                    "观察到的合成消息",
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, observation_id, source_locator, raw_payload
                ) VALUES (gen_random_uuid(), %s, %s, %s,
                          'local_wechat_observation', %s, %s, '{}'::jsonb)
                """,
                (
                    message_id,
                    self.owner_id,
                    self.contact_a,
                    recorded.observation_id,
                    "cli:10",
                ),
            )

        self.store.delete_observation(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=recorded.observation_id,
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            counts = connection.execute(
                """
                SELECT
                    (SELECT count(*) FROM public.local_wechat_observation
                     WHERE id = %s),
                    (SELECT count(*) FROM public.message_source_ref
                     WHERE message_id = %s),
                    (SELECT count(*) FROM public.message
                     WHERE owner_id = %s AND contact_id = %s AND id = %s)
                """,
                (
                    recorded.observation_id,
                    message_id,
                    self.owner_id,
                    self.contact_a,
                    message_id,
                ),
            ).fetchone()
        self.assertEqual(counts, (0, 0, 0))

    def test_delete_observation_keeps_message_supported_by_import_source(self) -> None:
        recorded = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        source_id = uuid4()
        message_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'obs-dedup.jsonl',
                          %s, 1, 'active')
                """,
                (source_id, self.owner_id, self.contact_a, "9" * 64),
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
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, observation_id, source_locator, raw_payload
                ) VALUES (gen_random_uuid(), %s, %s, %s,
                          'local_wechat_observation', %s, %s, '{}'::jsonb)
                """,
                (
                    message_id,
                    self.owner_id,
                    self.contact_a,
                    recorded.observation_id,
                    "cli:10",
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, source_document_id, source_locator, raw_payload
                ) VALUES (gen_random_uuid(), %s, %s, %s,
                          'source_document', %s, %s, '{}'::jsonb)
                """,
                (
                    message_id,
                    self.owner_id,
                    self.contact_a,
                    source_id,
                    "import:10",
                ),
            )

        self.store.delete_observation(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=recorded.observation_id,
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            kept = connection.execute(
                """
                SELECT
                    (SELECT count(*) FROM public.message
                     WHERE owner_id = %s AND contact_id = %s AND id = %s),
                    (SELECT count(*) FROM public.message_source_ref
                     WHERE message_id = %s)
                """,
                (
                    self.owner_id,
                    self.contact_a,
                    message_id,
                    message_id,
                ),
            ).fetchone()
        self.assertEqual(kept, (1, 1))

    def test_binding_row_deletion_cascades_observation_and_cursor(self) -> None:
        self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.conversation_binding WHERE id = %s",
                (self.binding_a.binding_id,),
            )

        self.assertIsNone(
            self.store.read_cursor(
                owner_id=self.owner_id, contact_id=self.contact_a
            )
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            (count,) = connection.execute(
                """
                SELECT count(*)
                FROM public.local_wechat_observation
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, self.contact_a),
            ).fetchone()
        self.assertEqual(count, 0)

    def test_record_cli_messages_writes_new_messages_with_source_refs(
        self,
    ) -> None:
        observation = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        messages = (
            NormalizedMessage(
                source_locator="cli:100",
                speaker="contact",
                message_type="text",
                text_content="你好",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=100,
                    external_server_id="server_100",
                    external_talker="wxid_test",
                    source_create_time=1000,
                    raw_payload_json='{"text":"你好"}',
                ),
            ),
            NormalizedMessage(
                source_locator="cli:101",
                speaker="user",
                message_type="text",
                text_content="你好啊",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=101,
                    external_server_id="server_101",
                    external_talker="wxid_test",
                    source_create_time=1001,
                    raw_payload_json='{"text":"你好啊"}',
                ),
            ),
        )

        message_ids = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=observation.observation_id,
            messages=messages,
        )

        self.assertEqual(len(message_ids), 2)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            # 验证消息已写入
            message_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message
                WHERE owner_id = %s AND contact_id = %s
                  AND id = ANY(%s)
                """,
                (self.owner_id, self.contact_a, list(message_ids)),
            ).fetchone()[0]
            self.assertEqual(message_count, 2)

            # 验证 wechat_metadata 已写入
            metadata_count = connection.execute(
                """
                SELECT count(*)
                FROM public.wechat_message_metadata
                WHERE owner_id = %s AND contact_id = %s
                  AND message_id = ANY(%s)
                """,
                (self.owner_id, self.contact_a, list(message_ids)),
            ).fetchone()[0]
            self.assertEqual(metadata_count, 2)

            # 验证 message_source_ref 已写入
            ref_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message_source_ref
                WHERE owner_id = %s AND contact_id = %s
                  AND observation_id = %s
                """,
                (self.owner_id, self.contact_a, observation.observation_id),
            ).fetchone()[0]
            self.assertEqual(ref_count, 2)

    def test_record_cli_messages_deduplicates_across_sources(self) -> None:
        # 先通过导入写入一条消息
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            source_doc_id = connection.execute(
                """
                INSERT INTO public.source_document (
                    owner_id, contact_id, source_type,
                    file_name, content_sha256, record_count
                )
                VALUES (%s, %s, 'wechat_jsonl', 'test.jsonl', %s, 1)
                RETURNING id
                """,
                (
                    self.owner_id,
                    self.contact_a,
                    "a" * 64,  # 64 位十六进制 SHA256
                ),
            ).fetchone()[0]
            message_id = connection.execute(
                """
                INSERT INTO public.message (
                    id, owner_id, contact_id, speaker,
                    message_type, text_content, occurred_at
                )
                VALUES (%s, %s, %s, 'contact', 'text', '导入消息', NULL)
                RETURNING id
                """,
                (uuid4(), self.owner_id, self.contact_a),
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO public.wechat_message_metadata (
                    message_id, owner_id, contact_id,
                    external_local_id, external_server_id,
                    external_talker, source_create_time
                )
                VALUES (%s, %s, %s, 200, 'server_200', 'wxid_test', 2000)
                """,
                (message_id, self.owner_id, self.contact_a),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    message_id, owner_id, contact_id,
                    source_kind, source_document_id,
                    source_locator, raw_payload
                )
                VALUES (%s, %s, %s, 'source_document', %s, 'import:200', '{}')
                """,
                (message_id, self.owner_id, self.contact_a, source_doc_id),
            )

        # 现在通过 CLI 观察写入同一消息(相同 local_id + create_time)
        observation = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=20,
            locator="wxid_observation_a",
        )
        messages = (
            NormalizedMessage(
                source_locator="cli:200",
                speaker="contact",
                message_type="text",
                text_content="导入消息",  # 同文
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=200,  # 相同 local_id
                    external_server_id="server_200",
                    external_talker="wxid_test",
                    source_create_time=2000,  # 相同 create_time
                    raw_payload_json='{"text":"导入消息"}',
                ),
            ),
        )

        returned_ids = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=observation.observation_id,
            messages=messages,
        )

        # 应该复用既有消息 ID,不生成新消息
        self.assertEqual(len(returned_ids), 1)
        self.assertEqual(returned_ids[0], message_id)

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            # 验证消息总数没变
            message_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, self.contact_a),
            ).fetchone()[0]
            self.assertEqual(message_count, 1)

            # 验证现在有 2 个来源引用(导入 + CLI)
            ref_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message_source_ref
                WHERE message_id = %s
                """,
                (message_id,),
            ).fetchone()[0]
            self.assertEqual(ref_count, 2)

    def test_record_cli_messages_handles_duplicate_events_in_same_batch(
        self,
    ) -> None:
        """同一批次内的重复事件(相同 local_id + create_time)只生成一个消息。"""
        observation = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        # 同一批次内两条完全相同的事件
        messages = (
            NormalizedMessage(
                source_locator="cli:300",
                speaker="contact",
                message_type="text",
                text_content="重复消息",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=300,
                    external_server_id="server_300",
                    external_talker="wxid_test",
                    source_create_time=3000,
                    raw_payload_json='{"text":"重复消息"}',
                ),
            ),
            NormalizedMessage(
                source_locator="cli:300",  # 相同 local_id
                speaker="contact",
                message_type="text",
                text_content="重复消息",  # 相同文本
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=300,  # 相同 local_id
                    external_server_id="server_300",
                    external_talker="wxid_test",
                    source_create_time=3000,  # 相同 create_time
                    raw_payload_json='{"text":"重复消息"}',
                ),
            ),
        )

        message_ids = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=observation.observation_id,
            messages=messages,
        )

        # 应该只生成一个消息 ID(去重)
        self.assertEqual(len(message_ids), 2)  # 两条输入,但去重后只有一个唯一消息
        # 实际上两个 message_id 应该相同
        self.assertEqual(message_ids[0], message_ids[1])

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            # 验证只有一个消息
            message_count = connection.execute(
                """
                SELECT count(*)
                FROM public.message
                WHERE owner_id = %s AND contact_id = %s
                  AND id = %s
                """,
                (self.owner_id, self.contact_a, message_ids[0]),
            ).fetchone()[0]
            self.assertEqual(message_count, 1)

    def test_record_cli_messages_same_text_different_id_creates_separate_messages(
        self,
    ) -> None:
        """同文不同 ID 应该生成不同的规范消息。"""
        observation = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        messages = (
            NormalizedMessage(
                source_locator="cli:400",
                speaker="contact",
                message_type="text",
                text_content="相同文本",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=400,  # 不同 local_id
                    external_server_id="server_400",
                    external_talker="wxid_test",
                    source_create_time=4000,
                    raw_payload_json='{"text":"相同文本"}',
                ),
            ),
            NormalizedMessage(
                source_locator="cli:401",
                speaker="contact",
                message_type="text",
                text_content="相同文本",  # 相同文本
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=401,  # 不同 local_id
                    external_server_id="server_401",
                    external_talker="wxid_test",
                    source_create_time=4001,  # 不同 create_time
                    raw_payload_json='{"text":"相同文本"}',
                ),
            ),
        )

        message_ids = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=observation.observation_id,
            messages=messages,
        )

        # 应该生成两个不同的消息 ID
        self.assertEqual(len(message_ids), 2)
        self.assertNotEqual(message_ids[0], message_ids[1])

    def test_record_cli_messages_handles_self_messages(self) -> None:
        """我方消息应该正确映射 speaker 为 user。"""
        observation = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        messages = (
            NormalizedMessage(
                source_locator="cli:500",
                speaker="user",  # 我方消息
                message_type="text",
                text_content="我发的消息",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=500,
                    external_server_id="server_500",
                    external_talker="wxid_test",
                    source_create_time=5000,
                    raw_payload_json='{"text":"我发的消息","is_from_me":true}',
                ),
            ),
        )

        message_ids = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=observation.observation_id,
            messages=messages,
        )

        self.assertEqual(len(message_ids), 1)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            speaker = connection.execute(
                """
                SELECT speaker
                FROM public.message
                WHERE id = %s
                """,
                (message_ids[0],),
            ).fetchone()[0]
            self.assertEqual(speaker, "user")

    def test_record_cli_messages_handles_missing_create_time(self) -> None:
        """缺失 create_time 的消息以 -1 参与去重。"""
        observation = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        messages = (
            NormalizedMessage(
                source_locator="cli:600",
                speaker="contact",
                message_type="text",
                text_content="缺失时间",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=600,
                    external_server_id=None,  # 缺失 server_id
                    external_talker="wxid_test",
                    source_create_time=None,  # 缺失 create_time
                    raw_payload_json='{"text":"缺失时间"}',
                ),
            ),
        )

        message_ids = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=observation.observation_id,
            messages=messages,
        )

        self.assertEqual(len(message_ids), 1)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            # 验证 wechat_metadata 中 source_create_time 为 NULL
            create_time = connection.execute(
                """
                SELECT source_create_time
                FROM public.wechat_message_metadata
                WHERE message_id = %s
                """,
                (message_ids[0],),
            ).fetchone()[0]
            self.assertIsNone(create_time)

    def test_record_cli_messages_isolates_between_contacts(self) -> None:
        """不同联系人的相同消息身份应该生成不同的规范消息。"""
        observation_a = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        observation_b = self._record(
            self.contact_b,
            self.binding_b.binding_id,
            last_local_id=20,
            locator="wxid_observation_b",
        )

        # 两个联系人发送完全相同的消息(相同 local_id + create_time)
        messages = (
            NormalizedMessage(
                source_locator="cli:700",
                speaker="contact",
                message_type="text",
                text_content="相同消息",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=700,
                    external_server_id="server_700",
                    external_talker="wxid_test",
                    source_create_time=7000,
                    raw_payload_json='{"text":"相同消息"}',
                ),
            ),
        )

        message_ids_a = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=observation_a.observation_id,
            messages=messages,
        )
        message_ids_b = self.store.record_cli_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_b,
            observation_id=observation_b.observation_id,
            messages=messages,
        )

        # 应该生成两个不同的消息(联系人隔离)
        self.assertEqual(len(message_ids_a), 1)
        self.assertEqual(len(message_ids_b), 1)
        self.assertNotEqual(message_ids_a[0], message_ids_b[0])


if __name__ == "__main__":
    unittest.main()
