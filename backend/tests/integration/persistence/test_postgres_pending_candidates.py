"""PostgreSQL 待确认候选检索轨的隔离与来源集成测试。"""

from __future__ import annotations

import os
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.persistence import PostgresMemoryStore, PostgresRetrieval
from notalone.reply.context import (
    ContextEvidence,
    ReplyContext,
    ReplyContextInvariantError,
    RetrievalReplyContext,
    pending_candidate_selection_reason,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
)
from notalone.retrieval import InMemoryRetrieval
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresPendingCandidateRetrievalTest(unittest.TestCase):
    """只使用合成 owner、联系人和来源。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.memory_candidate')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error

        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 009 Memory 迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        self.other_owner_id = uuid4()
        self.other_owner_contact_id = uuid4()
        self.source_id = uuid4()
        self.other_contact_source_id = uuid4()
        self.deleted_source_id = uuid4()
        self.pending_id = uuid4()
        self.second_pending_id = uuid4()
        self.confirmed_id = uuid4()
        self.rejected_id = uuid4()
        self.expired_id = uuid4()
        self.future_id = uuid4()
        self.other_contact_candidate_id = uuid4()
        self.other_owner_candidate_id = uuid4()
        self.source_document_pending_id = uuid4()

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (
                        (self.owner_id, "合成待确认用户"),
                        (self.other_owner_id, "另一个合成用户"),
                    ),
                )
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成联系人甲"),
                        (self.owner_id, self.other_contact_id, "合成联系人乙"),
                        (
                            self.other_owner_id,
                            self.other_owner_contact_id,
                            "另一个合成联系人",
                        ),
                    ),
                )
            self._insert_source(connection, self.source_id, "active", "a")
            self._insert_source(
                connection,
                self.other_contact_source_id,
                "active",
                "c",
                contact_id=self.other_contact_id,
            )
            self._insert_source(connection, self.deleted_source_id, "delete_failed", "b")
            now = datetime.now(timezone.utc)
            self._insert_candidate(
                connection, self.pending_id, "对方下个月准备换工作",
            )
            self._insert_candidate(
                connection, self.second_pending_id, "对方正在考虑养猫",
            )
            self._insert_candidate(
                connection,
                self.confirmed_id,
                "对方已经确认过的资料",
                status="confirmed",
            )
            self._insert_candidate(
                connection,
                self.rejected_id,
                "用户已经否决的候选",
                status="rejected",
            )
            self._insert_candidate(
                connection,
                self.expired_id,
                "有效期已过的候选",
                invalid_at=now - timedelta(minutes=1),
            )
            self._insert_candidate(
                connection,
                self.future_id,
                "尚未生效的候选",
                valid_at=now + timedelta(days=1),
            )
            self._insert_candidate(
                connection,
                self.other_contact_candidate_id,
                "另一联系人的待确认候选",
                contact_id=self.other_contact_id,
                source_id=self.other_contact_source_id,
            )
            self._insert_candidate(
                connection,
                self.other_owner_candidate_id,
                "另一个 owner 的待确认候选",
                owner_id=self.other_owner_id,
                contact_id=self.other_owner_contact_id,
                source_id=self.source_id,
            )
            self._insert_candidate(
                connection,
                self.source_document_pending_id,
                "来源已不可用的待确认候选",
                source_id=self.deleted_source_id,
            )

        self.port = PostgresRetrieval(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id IN (%s, %s)",
                (self.owner_id, self.other_owner_id),
            )

    def _scope(self, contact_id: UUID | None = None) -> ContactScope:
        return ContactScope(self.owner_id, contact_id or self.contact_id)

    def _insert_source(
        self,
        connection: psycopg.Connection,
        source_id: UUID,
        status: str,
        digest_letter: str,
        *,
        contact_id: UUID | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO public.source_document (
                id, owner_id, contact_id, source_type, file_name,
                content_sha256, record_count, status
            )
            VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 1, %s)
            """,
            (
                source_id,
                self.owner_id,
                contact_id or self.contact_id,
                f"synthetic-pending-{digest_letter}.jsonl",
                digest_letter * 64,
                status,
            ),
        )

    def _insert_candidate(
        self,
        connection: psycopg.Connection,
        candidate_id: UUID,
        text: str,
        *,
        status: str = "pending",
        owner_id: UUID | None = None,
        contact_id: UUID | None = None,
        source_id: UUID | None = None,
        valid_at: datetime | None = None,
        invalid_at: datetime | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO public.memory_candidate (
                id, owner_id, contact_id, text_content, category, topic,
                subject, source_ids, status, valid_at, invalid_at
            )
            VALUES (%s, %s, %s, %s, 'preference', 'work', 'contact', %s, %s, %s, %s)
            """,
            (
                candidate_id,
                owner_id or self.owner_id,
                contact_id or self.contact_id,
                text,
                [source_id or self.source_id],
                status,
                valid_at,
                invalid_at,
            ),
        )

    def test_only_pending_candidates_in_scope_are_returned(self) -> None:
        results = self.port.search_pending_candidates(scope=self._scope())

        # 同一事务写入的两条候选 created_at 相同，行序按 id 升序；只比较集合。
        self.assertEqual(
            {candidate.candidate_id for candidate in results},
            {self.pending_id, self.second_pending_id},
        )
        self.assertTrue(
            all(candidate.status == "pending" for candidate in results)
        )
        self.assertTrue(all(candidate.scope == self._scope() for candidate in results))
        self.assertTrue(
            all(candidate.source_ids == (self.source_id,) for candidate in results)
        )

    def test_confirmed_and_rejected_candidates_never_enter_the_pending_track(
        self,
    ) -> None:
        pending_ids = {
            candidate.candidate_id
            for candidate in self.port.search_pending_candidates(scope=self._scope())
        }

        self.assertNotIn(self.confirmed_id, pending_ids)
        self.assertNotIn(self.rejected_id, pending_ids)
        self.assertEqual(
            self.port.search_confirmed_memories(scope=self._scope()),
            (),
        )

    def test_expired_and_not_yet_valid_candidates_are_not_returned(self) -> None:
        pending_ids = {
            candidate.candidate_id
            for candidate in self.port.search_pending_candidates(scope=self._scope())
        }

        self.assertNotIn(self.expired_id, pending_ids)
        self.assertNotIn(self.future_id, pending_ids)

    def test_candidate_with_unavailable_source_is_not_returned(self) -> None:
        pending_ids = {
            candidate.candidate_id
            for candidate in self.port.search_pending_candidates(scope=self._scope())
        }

        self.assertNotIn(self.source_document_pending_id, pending_ids)

    def test_candidate_ids_narrow_results_for_revalidation(self) -> None:
        matched = self.port.search_pending_candidates(
            scope=self._scope(),
            candidate_ids=(self.second_pending_id,),
        )
        unknown = self.port.search_pending_candidates(
            scope=self._scope(),
            candidate_ids=(self.rejected_id,),
        )

        self.assertEqual(
            tuple(candidate.candidate_id for candidate in matched),
            (self.second_pending_id,),
        )
        self.assertEqual(unknown, ())

    def test_query_scores_and_limits_pending_candidates(self) -> None:
        results = self.port.search_pending_candidates(
            scope=self._scope(),
            query="换工作",
            limit=1,
        )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].candidate_id, self.pending_id)
        self.assertIsNotNone(results[0].relevance_score)

    def test_in_memory_and_postgres_tracks_agree_on_the_same_candidates(
        self,
    ) -> None:
        """同一批合成候选在内存与 PostgreSQL 两条路径给出相同可见集合。

        覆盖共享谓词里两个路径都能判定的部分：pending 状态、联系人范围与
        半开有效期。来源可用性只有 PostgreSQL 权威路径能判定，见下一个用例。
        """

        now = datetime.now(timezone.utc)
        fixtures = (
            ("可见候选", None, None),
            ("已过期候选", None, now - timedelta(days=1)),
            ("尚未生效候选", now + timedelta(days=1), None),
            ("无有效期候选", None, None),
        )
        owner_id = uuid4()
        contact_id = uuid4()
        source_id = uuid4()
        scope = ContactScope(owner_id, contact_id)
        memory_store = InMemoryMemoryStore()

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (owner_id, "合成对照用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (owner_id, contact_id, "合成对照联系人"),
            )
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                )
                VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 1, 'active')
                """,
                (
                    source_id,
                    owner_id,
                    contact_id,
                    "synthetic-parity.jsonl",
                    "e" * 64,
                ),
            )
            for index, (text, valid_at, invalid_at) in enumerate(fixtures):
                candidate_id = UUID(int=0x1000 + index)
                memory_store.create_candidate(
                    MemoryCandidate(
                        candidate_id=candidate_id,
                        scope=scope,
                        text=text,
                        category=MemoryCategory.PREFERENCE,
                        source_ids=(source_id,),
                        valid_at=valid_at,
                        invalid_at=invalid_at,
                    )
                )
                connection.execute(
                    """
                    INSERT INTO public.memory_candidate (
                        id, owner_id, contact_id, text_content, category,
                        topic, subject, source_ids, status, valid_at, invalid_at
                    )
                    VALUES (%s, %s, %s, %s, 'preference', 'work', 'contact',
                            %s, 'pending', %s, %s)
                    """,
                    (
                        candidate_id,
                        owner_id,
                        contact_id,
                        text,
                        [source_id],
                        valid_at,
                        invalid_at,
                    ),
                )

        try:
            memory_results = InMemoryRetrieval(
                memory_store=memory_store,
            ).search_pending_candidates(scope=scope)
            postgres_results = PostgresRetrieval(
                TEST_DATABASE_URL
            ).search_pending_candidates(scope=scope)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (owner_id,),
                )

        def visible(results):
            return tuple(
                (candidate.candidate_id, candidate.text) for candidate in results
            )

        self.assertEqual(visible(memory_results), visible(postgres_results))
        self.assertEqual(
            [text for _, text in visible(postgres_results)],
            ["可见候选", "无有效期候选"],
        )

    def test_cross_contact_scope_returns_its_own_pending_candidates_only(self) -> None:
        other_scope = self._scope(self.other_contact_id)

        results = self.port.search_pending_candidates(scope=other_scope)

        self.assertEqual(
            tuple(candidate.candidate_id for candidate in results),
            (self.other_contact_candidate_id,),
        )
        self.assertTrue(all(candidate.scope == other_scope for candidate in results))

    def _pending_snapshot(self, candidate_id: UUID):
        """按待确认轨的真实读取结果构造快照，避免手写字段与库内漂移。"""

        live = self.port.search_pending_candidates(
            scope=self._scope(),
            candidate_ids=(candidate_id,),
        )[0]
        command = GenerateReply(
            idempotency_key=uuid4(),
            scope=self._scope(),
            conversation_binding_id=uuid4(),
            content=ReplyToMessage(
                uuid4(),
                ConfirmedDirection("关心一下近况", DirectionSource.DIRECT_INPUT),
            ),
        )
        snapshot = ReplyContext(
            reply_request_id=uuid4(),
            command=command,
            scope=self._scope(),
            current_text="他下个月准备换工作吗？",
            direction=command.content.direction,
            evidence=(
                ContextEvidence(
                    evidence_id=live.candidate_id,
                    kind="pending_candidate",
                    text=live.text,
                    scope=live.scope,
                    source_ids=live.source_ids,
                    # 快照理由必须与真实组装一致：强制未确认标注 + 候选属性。
                    selection_reason=pending_candidate_selection_reason(live),
                    status=live.status,
                    valid_at=live.valid_at,
                    invalid_at=live.invalid_at,
                    timing=live.timing,
                ),
            ),
            skill_library_revision=1,
        )
        return snapshot, RetrievalReplyContext(
            retrieval=self.port,
            skill_library_revision=1,
        )

    def test_confirmed_candidate_moves_to_confirmed_memory_track(self) -> None:
        """pending 候选经既有确认路径转正：进入 confirmed 轨、离开 pending 轨。"""

        memory_store = PostgresMemoryStore(TEST_DATABASE_URL)

        memory = memory_store.confirm(
            scope=self._scope(),
            candidate_id=self.pending_id,
            adoption_method=AdoptionMethod.MANUAL,
        )

        confirmed = self.port.search_confirmed_memories(scope=self._scope())
        self.assertEqual(
            tuple(item.memory_id for item in confirmed),
            (memory.memory_id,),
        )
        self.assertEqual(confirmed[0].text, "对方下个月准备换工作")
        self.assertEqual(confirmed[0].adoption_method, "manual")

        pending_ids = {
            candidate.candidate_id
            for candidate in self.port.search_pending_candidates(scope=self._scope())
        }
        self.assertNotIn(self.pending_id, pending_ids)
        self.assertIn(self.second_pending_id, pending_ids)

    def test_forged_annotation_in_snapshot_is_rejected_on_revalidation(self) -> None:
        """状态仍是 pending、理由被改写成「已确认」的快照不得继续本轮。"""

        snapshot, validator = self._pending_snapshot(self.pending_id)
        validator.validate_current(snapshot)
        forged = replace(
            snapshot,
            evidence=(
                replace(
                    snapshot.evidence[0],
                    selection_reason="已确认、可以当作事实。",
                ),
            ),
        )

        with self.assertRaises(ReplyContextInvariantError):
            validator.validate_current(forged)

    def test_snapshot_revalidation_rejects_candidate_after_source_is_unavailable(
        self,
    ) -> None:
        snapshot, validator = self._pending_snapshot(self.pending_id)
        validator.validate_current(snapshot)

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.source_document SET status = 'delete_failed' "
                "WHERE id = %s AND owner_id = %s AND contact_id = %s",
                (self.source_id, self.owner_id, self.contact_id),
            )

        # 来源进入删除流程后，同一快照不得继续使用未确认候选。
        with self.assertRaises(ReplyContextInvariantError):
            validator.validate_current(snapshot)

    def test_snapshot_revalidation_rejects_rejected_candidate(self) -> None:
        snapshot, validator = self._pending_snapshot(self.second_pending_id)
        validator.validate_current(snapshot)

        # 候选被用户否决后，旧快照必须立即失效。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.memory_candidate SET status = 'rejected' "
                "WHERE id = %s AND owner_id = %s AND contact_id = %s",
                (self.second_pending_id, self.owner_id, self.contact_id),
            )

        with self.assertRaises(ReplyContextInvariantError):
            validator.validate_current(snapshot)


if __name__ == "__main__":
    unittest.main()
