"""仅在本用例拥有的随机测试库验证 nullable 依据迁移与来源接线。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from notalone.database_migrations import migrate
from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory
from notalone.memory.dimension_evidence import DimensionEvidenceChangedError
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow
from notalone.persistence import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.memory_store import MemoryPersistenceError
from notalone.persistence.source_deletion import (
    PostgresSourceDeletionRepository,
    SourceDeletionVerificationError,
)
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.verification_helpers import (
    SyntheticSupportingVerifier,
)


MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"


class DimensionEvidenceMigrationTest(unittest.TestCase):
    created_database_names: list[str] = []

    def setUp(self) -> None:
        self.database_name = f"notalone_dimension_{uuid4().hex}_test"
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.admin.execute(sql.SQL(
            "CREATE DATABASE {} TEMPLATE template0"
        ).format(sql.Identifier(self.database_name)))
        self.created_database_names.append(self.database_name)
        self.database_url = make_conninfo("host=/tmp", dbname=self.database_name)
        self.addCleanup(self._cleanup_database)
        with tempfile.TemporaryDirectory(
            prefix="notalone-dimension-prefix-"
        ) as directory:
            prefix = Path(directory)
            for source in MIGRATIONS.glob("*.sql"):
                if source.name[:3] <= "055":
                    shutil.copyfile(source, prefix / source.name)
            migrate(self.database_url, prefix)
        self.scope = ContactScope(uuid4(), uuid4())
        self.source_id = uuid4()
        self.message_id = uuid4()
        self.old_candidate_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""
                INSERT INTO public.owner (id, display_name)
                VALUES (%s, '合成用户')
            """, (self.scope.owner_id,))
            connection.execute("""
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, '合成联系人')
            """, (self.scope.owner_id, self.scope.contact_id))
            connection.execute("""
                INSERT INTO public.source_document (id, owner_id, contact_id,
                    source_type, file_name, content_sha256, record_count)
                VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1)
            """, (self.source_id, self.scope.owner_id, self.scope.contact_id, "a" * 64))
            connection.execute("""
                INSERT INTO public.message (id, owner_id, contact_id, speaker,
                    message_type, text_content, occurred_at)
                VALUES (%s, %s, %s, 'contact', 'text', '我喜欢咖啡', %s)
            """, (
                self.message_id, self.scope.owner_id, self.scope.contact_id,
                datetime(2026, 9, 15, tzinfo=timezone.utc),
            ))
            connection.execute("""
                INSERT INTO public.message_source_ref (message_id, owner_id,
                    contact_id, source_kind, source_document_id,
                    source_locator, raw_payload)
                VALUES (%s, %s, %s, 'source_document', %s, 'synthetic:1', '{}'::jsonb)
            """, (
                self.message_id, self.scope.owner_id, self.scope.contact_id,
                self.source_id,
            ))
            connection.execute("""
                INSERT INTO public.memory_candidate (id, owner_id, contact_id,
                    text_content, category, source_ids)
                VALUES (%s, %s, %s, '旧合成候选', 'common_fact', %s)
            """, (
                self.old_candidate_id, self.scope.owner_id, self.scope.contact_id,
                [self.message_id],
            ))

    def _cleanup_database(self) -> None:
        try:
            self.admin.execute(sql.SQL(
                "DROP DATABASE {} WITH (FORCE)"
            ).format(sql.Identifier(self.database_name)))
        finally:
            self.admin.close()

    def _candidate(self, **overrides) -> MemoryCandidate:
        messages = load_contact_messages(self.scope, self.database_url)
        fact = ExtractionFlow(
            runtime=RecordingRuntime((
                _payload(self.message_id, text=messages[0].text, **overrides),
            )),
            verification_runtime=SyntheticSupportingVerifier(),
        ).run(ExtractionWindow(
            self.scope.owner_id, self.scope.contact_id, messages
        )).accepted[0]
        return MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text=fact.text,
            category=fact.category, topic=fact.topic, subject=fact.subject,
            source_ids=fact.source_message_ids, confidence=fact.confidence,
            risk_flags=fact.risk_flags, alternatives=fact.alternatives,
            valid_at=fact.valid_at, invalid_at=fact.invalid_at, timing=fact.timing,
            interpretation_reason=fact.interpretation_reason,
            dimension_evidence=fact.dimension_evidence,
        )

    def test_migration_preserves_old_null_and_repeat_is_empty(self) -> None:
        applied = migrate(self.database_url, MIGRATIONS)
        self.assertIn("056_memory_candidate_dimension_evidence.sql", applied)
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute("""
                SELECT status, dimension_evidence FROM public.memory_candidate
                WHERE id=%s
            """, (self.old_candidate_id,)).fetchone()
        self.assertEqual(row, ("pending", None))
        self.assertEqual(migrate(self.database_url, MIGRATIONS), ())

    def test_migration_rejects_wrong_scope_version_and_pragmatic_shape(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        payload = self._candidate().dimension_evidence.to_payload()
        invalid = (
            {**payload, "version": True},
            {**payload, "version": 2},
            {**payload, "scope": {
                "owner_id": str(self.scope.owner_id),
                "contact_id": str(uuid4()),
            }},
            {**payload, "pragmatics": {
                **payload["pragmatics"], "speech_act": True,
            }},
        )
        with psycopg.connect(self.database_url) as connection:
            for index, rejected in enumerate(invalid):
                with self.subTest(index=index):
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        with connection.transaction():
                            connection.execute("""
                                UPDATE public.memory_candidate
                                SET dimension_evidence=%s WHERE id=%s
                            """, (Jsonb(rejected), self.old_candidate_id))
            row = connection.execute("""
                SELECT dimension_evidence FROM public.memory_candidate
                WHERE id=%s
            """, (self.old_candidate_id,)).fetchone()
        self.assertEqual(row, (None,))

    def test_unmigrated_schema_reads_unknown_and_refuses_evidence_write(self) -> None:
        store = PostgresMemoryStore(self.database_url)
        old = store.get_candidate(
            scope=self.scope, candidate_id=self.old_candidate_id,
        )
        self.assertIsNone(old.dimension_evidence)
        candidate = self._candidate()
        rejected_id = candidate.candidate_id
        with self.assertRaises(MemoryPersistenceError):
            store.create_candidate(candidate)
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("""
                SELECT id FROM public.memory_candidate WHERE id=%s
            """, (rejected_id,)).fetchone())
            self.assertIsNone(connection.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name='memory_candidate'
                  AND column_name='dimension_evidence'
            """).fetchone())
        confirmed = store.confirm(
            scope=self.scope, candidate_id=self.old_candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        self.assertIs(confirmed.adoption_method, AdoptionMethod.MANUAL)

    def test_loader_carries_actual_type_and_text_representation(self) -> None:
        messages = load_contact_messages(self.scope, self.database_url)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].message_type, "text")
        self.assertEqual(messages[0].text_representation, "text")

    def test_store_round_trips_current_anchors_and_refuses_scope_read(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        candidate = self._candidate()
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(candidate)
        self.assertIsNotNone(saved.dimension_evidence)
        self.assertTrue(saved.dimension_evidence.source_bound)
        self.assertEqual(
            saved.dimension_evidence.to_payload(),
            candidate.dimension_evidence.to_payload(),
        )
        read = store.get_candidate(
            scope=self.scope, candidate_id=candidate.candidate_id,
        )
        self.assertTrue(read.dimension_evidence.source_bound)
        with self.assertRaises(PermissionError):
            store.get_candidate(
                scope=ContactScope(self.scope.owner_id, uuid4()),
                candidate_id=candidate.candidate_id,
            )

    def test_equivalent_timezones_preserve_the_candidate_binding(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        self.database_url = make_conninfo(
            self.database_url, options="-c timezone=Asia/Taipei",
        )
        utc_store = PostgresMemoryStore(make_conninfo(
            self.database_url, options="-c timezone=UTC",
        ))
        local_store = PostgresMemoryStore(self.database_url)
        candidates = []
        for dates in ({}, {
            "valid_at": "2026-09-15T08:00:00+08:00",
            "invalid_at": "2026-09-20T08:00:00+08:00",
        }):
            with self.subTest(candidate_dates=bool(dates)):
                candidate = self._candidate(**dates)
                self.assertTrue(candidate.dimension_evidence.source_bound)
                self.assertEqual(
                    candidate.dimension_evidence.messages[0].occurred_at.utcoffset(),
                    timedelta(hours=8),
                )
                saved = utc_store.create_candidate(candidate)
                candidates.append(saved)
                self.assertEqual(saved.valid_at, candidate.valid_at)
                self.assertEqual(saved.invalid_at, candidate.invalid_at)
                if saved.valid_at is not None:
                    self.assertEqual(saved.valid_at.utcoffset(), timedelta(0))
                self.assertTrue(saved.dimension_evidence.source_bound)
                for store in (local_store, utc_store):
                    read = store.get_candidate(
                        scope=self.scope, candidate_id=saved.candidate_id,
                    )
                    self.assertTrue(read.dimension_evidence.source_bound)
                    self.assertEqual(
                        read.dimension_evidence.to_payload(),
                        candidate.dimension_evidence.to_payload(),
                    )
        # 等价表示可保留，真实来源瞬间改变仍必须拒绝旧证明。
        original_time = datetime(2026, 9, 15, tzinfo=timezone.utc)
        try:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.message SET occurred_at=%s WHERE id=%s",
                    (original_time + timedelta(seconds=1), self.message_id),
                )
            for candidate in candidates:
                read = utc_store.get_candidate(
                    scope=self.scope, candidate_id=candidate.candidate_id,
                )
                self.assertFalse(read.dimension_evidence.source_bound)
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.message SET occurred_at=%s WHERE id=%s",
                    (original_time, self.message_id),
                )

    def test_source_fingerprint_changes_invalidate_unchanged_normalized_text(
        self,
    ) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._candidate())
        self.assertTrue(saved.dimension_evidence.source_bound)
        controls = (
            (
                "source_document_sha256",
                "UPDATE public.source_document SET content_sha256=%s WHERE id=%s",
                "b" * 64, "a" * 64, self.source_id,
            ),
            (
                "raw_source_ref",
                "UPDATE public.message_source_ref SET raw_payload=%s "
                "WHERE message_id=%s",
                Jsonb({"synthetic_changed": True}), Jsonb({}), self.message_id,
            ),
        )
        for label, statement, changed_value, old_value, identifier in controls:
            with self.subTest(field=label):
                try:
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(statement, (changed_value, identifier))
                    current = store.get_candidate(
                        scope=self.scope, candidate_id=saved.candidate_id,
                    )
                    self.assertEqual(current.text, saved.text)
                    self.assertFalse(current.dimension_evidence.source_bound)
                finally:
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(statement, (old_value, identifier))

    def test_context_source_change_is_unknown_and_deletion_clears_evidence(
        self,
    ) -> None:
        migrate(self.database_url, MIGRATIONS)
        context_id, context_source = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""
                INSERT INTO public.source_document (id, owner_id, contact_id,
                    source_type, file_name, content_sha256, record_count)
                VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-context.jsonl', %s, 1)
            """, (context_source, self.scope.owner_id, self.scope.contact_id, "b" * 64))
            connection.execute("""
                INSERT INTO public.message (id, owner_id, contact_id, speaker,
                    message_type, text_content, occurred_at)
                VALUES (%s, %s, %s, 'contact', 'text', '合成上下文', %s)
            """, (
                context_id, self.scope.owner_id, self.scope.contact_id,
                datetime(2026, 9, 16, tzinfo=timezone.utc),
            ))
            connection.execute("""
                INSERT INTO public.message_source_ref (message_id, owner_id,
                    contact_id, source_kind, source_document_id,
                    source_locator, raw_payload)
                VALUES (%s, %s, %s, 'source_document', %s,
                        'synthetic:context', '{}'::jsonb)
            """, (
                context_id, self.scope.owner_id, self.scope.contact_id,
                context_source,
            ))
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._candidate())
        self.assertTrue(saved.dimension_evidence.source_bound)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""
                UPDATE public.message SET text_content='变更的合成上下文'
                WHERE id=%s
            """, (context_id,))
        changed = store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertFalse(changed.dimension_evidence.source_bound)
        result = PostgresSourceDeletionRepository(self.database_url).delete_source(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=context_source,
        )
        self.assertEqual(result.outcome, "deleted")
        remaining = store.get_candidate(
            scope=self.scope, candidate_id=saved.candidate_id,
        )
        self.assertEqual(remaining.text, saved.text)
        self.assertIsNone(remaining.dimension_evidence)
        with self.assertRaises(DimensionEvidenceChangedError):
            store.confirm(
                scope=self.scope, candidate_id=saved.candidate_id,
                expected_dimension_evidence=saved.dimension_evidence,
            )

    def test_auto_confirmation_rechecks_current_source_in_its_transaction(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._candidate())
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.message SET text_content='合成来源已经变更' WHERE id=%s",
                (self.message_id,),
            )

        with self.assertRaises(DimensionEvidenceChangedError):
            store.confirm(scope=self.scope, candidate_id=saved.candidate_id)

        self.assertEqual(store.list_confirmed(self.scope), ())
        pending = store.get_candidate(
            scope=self.scope, candidate_id=saved.candidate_id
        )
        self.assertEqual(pending.status.value, "pending")
        self.assertFalse(pending.dimension_evidence.source_bound)

    def test_owner_auto_confirmation_rechecks_the_contact_window(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.message SET speaker='user' WHERE id=%s",
                (self.message_id,),
            )
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._candidate(subject="self"))
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.message SET text_content='合成本人来源变更' WHERE id=%s",
                (self.message_id,),
            )

        owner = PostgresOwnerMemoryStore(self.database_url)
        with self.assertRaises(DimensionEvidenceChangedError):
            owner.confirm_candidate(
                candidate=saved, adoption_method=AdoptionMethod.AUTO
            )

        self.assertEqual(owner.list_active(self.scope.owner_id), ())
        self.assertEqual(store.get_candidate(
            scope=self.scope, candidate_id=saved.candidate_id
        ).status.value, "pending")

    def test_delete_verification_rejects_residual_dimension_dependencies(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        shared_source = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'shared.jsonl', %s, 1)
            """, (shared_source, self.scope.owner_id, self.scope.contact_id, "b" * 64))
            connection.execute("""
                INSERT INTO public.message_source_ref (
                    message_id, owner_id, contact_id, source_kind,
                    source_document_id, source_locator, raw_payload
                ) VALUES (%s, %s, %s, 'source_document', %s, 'shared:1', '{}')
            """, (
                self.message_id, self.scope.owner_id, self.scope.contact_id,
                shared_source,
            ))
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._candidate())
        deletion = PostgresSourceDeletionRepository(self.database_url)
        deletion.delete_source(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=self.source_id,
        )
        deletion.verify_deleted(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=self.source_id,
        )
        with psycopg.connect(self.database_url) as connection:
            changed = connection.execute(
                "UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s",
                (Jsonb(saved.dimension_evidence.to_payload()), saved.candidate_id),
            ).rowcount
            self.assertEqual(changed, 1)

        with self.assertRaises(SourceDeletionVerificationError):
            deletion.verify_deleted(
                owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                source_document_id=self.source_id,
            )

    def test_discard_clears_evidence_and_preserves_the_deletion_fingerprint(
        self,
    ) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._candidate())

        discarded = store.discard_candidate_with_fingerprint(
            scope=self.scope, candidate_id=saved.candidate_id
        )

        self.assertEqual(discarded.status.value, "rejected")
        self.assertIsNone(discarded.dimension_evidence)
        self.assertIn(saved.text, store.deleted_texts(self.scope))
        self.assertEqual(store.list_confirmed(self.scope), ())


if __name__ == "__main__":
    unittest.main()
