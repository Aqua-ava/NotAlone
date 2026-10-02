"""在独立随机测试库通过公开端口验证记忆时间，不读取用户资料。"""

from datetime import datetime, timezone
from pathlib import Path
import unittest
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.database_migrations import migrate
from notalone.memory import (
    AdoptionMethod,
    ConfirmedMemoryStatus,
    FactSubject,
    MemoryCandidate,
    MemoryCategory,
    MemoryTiming,
    MemoryTopic,
    OwnerMemory,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.scopes import ContactScope


FIRST_DATE = datetime(2024, 2, 1, tzinfo=timezone.utc)
SECOND_DATE = datetime(2024, 2, 3, tzinfo=timezone.utc)


class PostgresMemoryTimingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database_name = f"notalone_memory_timing_{uuid4().hex[:12]}_test"
        cls.database_url = f"postgresql:///{cls.database_name}"
        try:
            with psycopg.connect(
                "postgresql:///postgres", autocommit=True,
            ) as connection:
                connection.execute(sql.SQL("CREATE DATABASE {}").format(
                    sql.Identifier(cls.database_name),
                ))
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 不可用。") from error
        cls.addClassCleanup(cls._drop_database)
        migrate(
            cls.database_url,
            Path(__file__).resolve().parents[3] / "database/migrations",
        )

    @classmethod
    def _drop_database(cls) -> None:
        with psycopg.connect(
            "postgresql:///postgres", autocommit=True,
        ) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(cls.database_name),
            ))

    def setUp(self) -> None:
        self.scope = ContactScope(uuid4(), uuid4())
        self.store = PostgresMemoryStore(self.database_url)
        self._add_owner(self.scope.owner_id)
        self._add_contact(self.scope.owner_id, self.scope.contact_id)
        self.source_id, messages = self._add_source_messages(
            self.scope.owner_id, self.scope.contact_id,
            (FIRST_DATE, SECOND_DATE),
        )
        self.first, self.second = messages

    def tearDown(self) -> None:
        self._delete_owner(self.scope.owner_id)

    def _add_owner(self, owner_id: UUID) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner(id, display_name) "
                "VALUES (%s, '合成用户')", (owner_id,),
            )

    def _add_contact(self, owner_id: UUID, contact_id: UUID) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact(id, owner_id, display_name) "
                "VALUES (%s, %s, '合成联系人')", (contact_id, owner_id),
            )

    def _add_source_messages(
        self,
        owner_id: UUID,
        contact_id: UUID,
        dates: tuple[datetime, ...],
    ) -> tuple[UUID, tuple[UUID, ...]]:
        source_id = uuid4()
        message_ids = tuple(uuid4() for _ in dates)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, %s)
                """,
                (source_id, owner_id, contact_id, uuid4().hex * 2, len(dates)),
            )
            for message_id, occurred_at in zip(message_ids, dates):
                connection.execute(
                    """
                    INSERT INTO public.message (
                        id, owner_id, contact_id, speaker, message_type,
                        text_content, occurred_at
                    ) VALUES (%s, %s, %s, 'contact', 'text', '合成消息', %s)
                    """,
                    (message_id, owner_id, contact_id, occurred_at),
                )
                connection.execute(
                    """
                    INSERT INTO public.message_source_ref (
                        message_id, owner_id, contact_id, source_kind,
                        source_document_id, source_locator, raw_payload
                    ) VALUES (
                        %s, %s, %s, 'source_document', %s, %s, '{}'::jsonb
                    )
                    """,
                    (message_id, owner_id, contact_id, source_id,
                     str(message_id)),
                )
        return source_id, message_ids

    def _candidate(
        self,
        sources: tuple[UUID, ...],
        *,
        timing: MemoryTiming = MemoryTiming(),
        subject: FactSubject = FactSubject.CONTACT,
    ) -> MemoryCandidate:
        return MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope,
            text="合成历史活动资料", category=MemoryCategory.COMMON_FACT,
            source_ids=sources, subject=subject, timing=timing,
        )

    def _add_legacy_candidate(
        self,
        sources: tuple[UUID, ...],
        *,
        recorded_at: datetime | None = None,
    ) -> UUID:
        candidate_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                """
                INSERT INTO public.memory_candidate (
                    id, owner_id, contact_id, text_content, category,
                    source_ids, created_at
                ) VALUES (
                    %s, %s, %s, '合成旧事实', 'common_fact', %s,
                    COALESCE(%s, now())
                )
                """,
                (candidate_id, self.scope.owner_id, self.scope.contact_id,
                 list(sources), recorded_at),
            )
        return candidate_id

    def _delete_owner(self, owner_id: UUID) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id=%s", (owner_id,),
            )

    def test_old_history_returns_actual_evidence_dates_on_create_confirm_and_read(
        self,
    ) -> None:
        candidate = self.store.create_candidate(self._candidate(
            (self.first, self.second),
            timing=MemoryTiming.from_source_times((
                datetime(2026, 9, 1, tzinfo=timezone.utc),
            )),
        ))
        self.assertEqual(candidate.timing.source_started_at, FIRST_DATE)
        self.assertEqual(candidate.timing.source_ended_at, SECOND_DATE)
        self.assertTrue(candidate.timing.source_time_complete)
        self.assertIsNotNone(candidate.timing.recorded_at)
        self.assertEqual(
            self.store.list_pending_candidates(self.scope), (candidate,),
        )
        confirmed = self.store.confirm(
            scope=self.scope, candidate_id=candidate.candidate_id,
        )
        self.assertEqual(confirmed.timing.source_started_at, FIRST_DATE)
        self.assertEqual(confirmed.timing.source_ended_at, SECOND_DATE)
        self.assertIsNotNone(confirmed.timing.recorded_at)
        self.assertEqual(self.store.list_confirmed(self.scope), (confirmed,))
        self.assertIsNone(confirmed.valid_at)

    def test_self_candidate_confirmation_and_owner_read_keep_source_time(
        self,
    ) -> None:
        candidate = self.store.create_candidate(self._candidate(
            (self.first,), subject=FactSubject.SELF,
        ))
        owner_store = PostgresOwnerMemoryStore(self.database_url)
        memory = owner_store.confirm_candidate(candidate=candidate)
        self.assertEqual(memory.timing.source_started_at, FIRST_DATE)
        self.assertEqual(memory.timing.source_ended_at, FIRST_DATE)
        self.assertTrue(memory.timing.source_time_complete)
        self.assertIsNotNone(memory.timing.recorded_at)
        self.assertEqual(
            owner_store.list_active(self.scope.owner_id), (memory,),
        )
        self.assertEqual(
            owner_store.confirm_candidate(candidate=candidate), memory,
        )

    def test_document_reference_does_not_expand_to_all_its_chat_messages(
        self,
    ) -> None:
        candidate = self.store.create_candidate(self._candidate(
            (self.source_id,),
        ))
        self.assertIsNone(candidate.timing.source_started_at)
        self.assertIsNone(candidate.timing.source_ended_at)
        self.assertFalse(candidate.timing.source_time_complete)
        self.assertIsNotNone(candidate.timing.recorded_at)

    def test_mixed_known_missing_and_inactive_source_times_are_marked_incomplete(
        self,
    ) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.message SET occurred_at=NULL WHERE id=%s",
                (self.second,),
            )
        candidate = self.store.create_candidate(self._candidate(
            (self.first, self.second, self.source_id),
        ))
        self.assertEqual(candidate.timing.source_started_at, FIRST_DATE)
        self.assertEqual(candidate.timing.source_ended_at, FIRST_DATE)
        self.assertFalse(candidate.timing.source_time_complete)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.source_document SET status='deleting' "
                "WHERE id=%s", (self.source_id,),
            )
        current = self.store.get_candidate(
            scope=self.scope, candidate_id=candidate.candidate_id,
        )
        self.assertIsNone(current.timing.source_started_at)
        self.assertFalse(current.timing.source_time_complete)
        self.assertEqual(
            current.timing.recorded_at, candidate.timing.recorded_at,
        )

    def test_legacy_row_and_correction_keep_source_dates_and_own_saved_time(
        self,
    ) -> None:
        old_saved = datetime(2025, 5, 1, tzinfo=timezone.utc)
        candidate_id = self._add_legacy_candidate(
            (self.first,), recorded_at=old_saved,
        )
        legacy = self.store.get_candidate(
            scope=self.scope, candidate_id=candidate_id,
        )
        self.assertEqual(legacy.timing.recorded_at, old_saved)
        self.assertEqual(legacy.timing.source_started_at, FIRST_DATE)
        confirmed = self.store.confirm(
            scope=self.scope, candidate_id=candidate_id,
        )
        corrected = self.store.correct(
            scope=self.scope, memory_id=confirmed.memory_id,
            text="合成旧事实的修正",
        )
        self.assertEqual(corrected.timing.source_started_at, FIRST_DATE)
        self.assertGreater(
            corrected.timing.recorded_at, confirmed.timing.recorded_at,
        )
        self.assertEqual(self.store.list_confirmed(self.scope), (corrected,))
        self.assertEqual(self.store.get_candidate(
            scope=self.scope, candidate_id=candidate_id,
        ).timing.recorded_at, old_saved)

    def test_auto_owner_create_and_manual_entry_separate_evidence_from_saved_time(
        self,
    ) -> None:
        owner_store = PostgresOwnerMemoryStore(self.database_url)
        for method, sources, complete in (
            (AdoptionMethod.AUTO, (self.first, self.second), True),
            (AdoptionMethod.MANUAL, (self.scope.owner_id,), False),
        ):
            with self.subTest(method=method):
                memory = owner_store.create(OwnerMemory(
                    memory_id=uuid4(), owner_id=self.scope.owner_id,
                    text="合成本人资料", category=MemoryCategory.COMMON_FACT,
                    topic=MemoryTopic.OTHER, source_ids=sources,
                    adoption_method=method,
                    status=ConfirmedMemoryStatus.ACTIVE,
                ))
                self.assertIsNotNone(memory.timing.recorded_at)
                self.assertEqual(memory.timing.source_time_complete, complete)
                self.assertIn(
                    memory, owner_store.list_active(self.scope.owner_id),
                )
                if complete:
                    self.assertEqual(
                        memory.timing.source_started_at, FIRST_DATE,
                    )
                else:
                    self.assertIsNone(memory.timing.source_started_at)

    def test_foreign_contact_or_owner_dates_cannot_enter_legacy_row_projection(
        self,
    ) -> None:
        other_owner, other_contact = uuid4(), uuid4()
        self._add_owner(other_owner)
        self.addCleanup(self._delete_owner, other_owner)
        self._add_contact(other_owner, other_contact)
        _, messages = self._add_source_messages(
            other_owner, other_contact,
            (datetime(2026, 1, 1, tzinfo=timezone.utc),),
        )
        candidate_id = self._add_legacy_candidate((self.first, messages[0]))
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                """
                INSERT INTO public.owner_memory (
                    id, owner_id, text_content, category, source_ids,
                    adoption_method
                ) VALUES (%s, %s, '合成旧本人引用', 'common_fact', %s, 'auto')
                """,
                (uuid4(), self.scope.owner_id, [self.first, messages[0]]),
            )
        candidate = self.store.get_candidate(
            scope=self.scope, candidate_id=candidate_id,
        )
        owner_memory = PostgresOwnerMemoryStore(self.database_url).list_active(
            self.scope.owner_id,
        )[0]
        for timing in (candidate.timing, owner_memory.timing):
            self.assertEqual(timing.source_started_at, FIRST_DATE)
            self.assertEqual(timing.source_ended_at, FIRST_DATE)
            self.assertFalse(timing.source_time_complete)

    def test_same_owner_other_contact_source_is_excluded_from_contact_projection(
        self,
    ) -> None:
        other_contact = uuid4()
        self._add_contact(self.scope.owner_id, other_contact)
        _, messages = self._add_source_messages(
            self.scope.owner_id, other_contact,
            (datetime(2025, 1, 1, tzinfo=timezone.utc),),
        )
        candidate_id = self._add_legacy_candidate((self.first, messages[0]))
        candidate = self.store.get_candidate(
            scope=self.scope, candidate_id=candidate_id,
        )
        self.assertEqual(candidate.timing.source_started_at, FIRST_DATE)
        self.assertEqual(candidate.timing.source_ended_at, FIRST_DATE)
        self.assertFalse(candidate.timing.source_time_complete)
        with self.assertRaises(PermissionError):
            self.store.create_candidate(self._candidate((messages[0],)))
