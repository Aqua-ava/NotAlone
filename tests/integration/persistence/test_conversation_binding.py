"""PostgreSQL 会话绑定持久化与重新验证测试。"""

from __future__ import annotations

import os
import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.application import CandidateReplyFlow
from notalone.conversation import (
    ConversationObservation,
    ConversationObservationState,
    ConversationResolutionState,
    VerificationReason,
)
from notalone.persistence.conversation_repository import (
    ConversationBindingNotFoundError,
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresConversationBindingTest(unittest.TestCase):
    """只验证合成绑定，不连接桌面会话或读取聊天内容。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.conversation_binding')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 006 会话绑定迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成会话用户"),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成联系人甲"),
                        (self.owner_id, self.other_contact_id, "合成联系人乙"),
                    ),
                )
        self.repository = PostgresConversationBindingRepository(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_binding_survives_adapter_recreation_and_updates_last_verified_at(
        self,
    ) -> None:
        created = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="synthetic-conversation-001",
        )
        before_verification = created.last_verified_at

        port = PostgresConversationPort(
            TEST_DATABASE_URL,
            owner_id=self.owner_id,
            observation=ConversationObservation.confirmed(created.binding_id),
        )
        result = port.verify_current()

        self.assertEqual(result.state, ConversationResolutionState.READY)
        self.assertEqual(result.reason, VerificationReason.ACTIVE_BINDING)
        self.assertEqual(
            result.scope.owner_id if result.scope else None,
            self.owner_id,
        )
        self.assertEqual(
            result.scope.contact_id if result.scope else None,
            self.contact_id,
        )

        recreated = PostgresConversationPort(
            TEST_DATABASE_URL,
            owner_id=self.owner_id,
            observation=ConversationObservation.confirmed(created.binding_id),
        )
        recreated_result = CandidateReplyFlow(
            conversation=recreated,
        ).resolve_current_scope()
        stored = self.repository.read_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=created.binding_id,
        )

        self.assertEqual(recreated_result.state, ConversationResolutionState.READY)
        self.assertIsNotNone(stored.last_verified_at)
        self.assertGreaterEqual(stored.last_verified_at, before_verification)

    def test_revoked_binding_never_returns_ready_after_recreation(self) -> None:
        created = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="synthetic-conversation-002",
        )
        self.repository.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=created.binding_id,
        )

        port = PostgresConversationPort(
            TEST_DATABASE_URL,
            owner_id=self.owner_id,
            observation=ConversationObservation.confirmed(created.binding_id),
        )

        result = port.verify_current()

        self.assertEqual(result.state, ConversationResolutionState.REJECTED)
        self.assertEqual(result.reason, VerificationReason.BINDING_REVOKED)

    def test_wrong_contact_scope_cannot_revoke_or_read_binding(self) -> None:
        created = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="synthetic-conversation-003",
        )

        with self.assertRaises(ConversationBindingNotFoundError):
            self.repository.read_binding(
                owner_id=self.owner_id,
                contact_id=self.other_contact_id,
                binding_id=created.binding_id,
            )

        with self.assertRaises(ConversationBindingNotFoundError):
            self.repository.revoke_binding(
                owner_id=self.owner_id,
                contact_id=self.other_contact_id,
                binding_id=created.binding_id,
            )

        port = PostgresConversationPort(
            TEST_DATABASE_URL,
            owner_id=self.owner_id,
            observation=ConversationObservation.confirmed(created.binding_id),
        )
        result = port.verify_current()

        self.assertEqual(result.state, ConversationResolutionState.READY)
        self.assertEqual(
            result.scope.contact_id if result.scope else None,
            self.contact_id,
        )

    def test_other_owner_cannot_verify_binding_by_id(self) -> None:
        created = self.repository.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="synthetic-conversation-004",
        )
        other_owner_id = uuid4()

        port = PostgresConversationPort(
            TEST_DATABASE_URL,
            owner_id=other_owner_id,
            observation=ConversationObservation.confirmed(created.binding_id),
        )

        result = port.verify_current()

        self.assertEqual(result.state, ConversationResolutionState.REJECTED)
        self.assertEqual(result.reason, VerificationReason.NO_ACTIVE_BINDING)

    def test_changed_or_ambiguous_observation_never_queries_as_ready(self) -> None:
        for state, reason in (
            (
                ConversationObservationState.CONVERSATION_CHANGED,
                VerificationReason.CONVERSATION_CHANGED,
            ),
            (
                ConversationObservationState.AMBIGUOUS,
                VerificationReason.AMBIGUOUS_MATCH,
            ),
        ):
            with self.subTest(state=state):
                port = PostgresConversationPort(
                    TEST_DATABASE_URL,
                    owner_id=self.owner_id,
                    observation=ConversationObservation(
                        state=state,
                        binding_id=None,
                    ),
                )

                result = port.verify_current()

                self.assertEqual(
                    result.state,
                    ConversationResolutionState.NEEDS_USER_CONFIRMATION,
                )
                self.assertEqual(result.reason, reason)


if __name__ == "__main__":
    unittest.main()
