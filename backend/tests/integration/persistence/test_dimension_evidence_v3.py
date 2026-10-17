"""有限作者引句依据的隔离持久化接缝；不连接业务库或真实模型。"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from notalone.application.memory_service import MemoryService
from notalone.database_migrations import migrate
from notalone.memory import AdoptionMethod, MemoryCandidate, SourceDependencyMode
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.dimension_evidence import DimensionEvidence, DimensionEvidenceChangedError
from notalone.memory.evidence_binding import content_digest
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction import source_proof
from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore
from notalone.persistence.dimension_evidence import supports_dimension_evidence_version
from notalone.persistence.memory_store import MemoryPersistenceError
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from tests.unit.memory_extraction.author_quote_helpers import author_quote_producer


MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"


class DimensionEvidenceV3PersistenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.database_name = f"notalone_proof_b_{uuid4().hex}_test"
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(self.database_name),
        ))
        print(f"isolated_database_created={self.database_name}")
        self.database_url = make_conninfo("host=/tmp", dbname=self.database_name)
        self.addCleanup(self._cleanup_database)
        self._prefix("058")
        self.scope = ContactScope(uuid4(), uuid4())
        self.source_id, self.message_id, self.old_id = uuid4(), uuid4(), uuid4()
        self.source_text = "我刚到家。"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')",
                (self.scope.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')",
                (self.scope.owner_id, self.scope.contact_id),
            )
            connection.execute("""
                INSERT INTO public.source_document(
                    id,owner_id,contact_id,source_type,file_name,content_sha256,record_count
                ) VALUES(%s,%s,%s,'wechat_jsonl','synthetic-proof-b.jsonl',%s,1)
            """, (self.source_id, self.scope.owner_id, self.scope.contact_id,
                  content_digest(self.source_text)))
            connection.execute("""
                INSERT INTO public.message(
                    id,owner_id,contact_id,speaker,message_type,text_content,occurred_at
                ) VALUES(%s,%s,%s,'contact','text',%s,%s)
            """, (self.message_id, self.scope.owner_id, self.scope.contact_id,
                  self.source_text, datetime(2026, 10, 16, tzinfo=timezone.utc)))
            connection.execute("""
                INSERT INTO public.message_source_ref(
                    message_id,owner_id,contact_id,source_kind,source_document_id,
                    source_locator,raw_payload
                ) VALUES(%s,%s,%s,'source_document',%s,'synthetic:proof-b',%s)
            """, (self.message_id, self.scope.owner_id, self.scope.contact_id,
                  self.source_id, Jsonb({"text": self.source_text})))
            connection.execute("""
                INSERT INTO public.memory_candidate(
                    id,owner_id,contact_id,text_content,category,source_ids
                ) VALUES(%s,%s,%s,'旧合成候选','common_fact',%s)
            """, (self.old_id, self.scope.owner_id, self.scope.contact_id,
                  [self.message_id]))

    def _prefix(self, number: str) -> tuple[str, ...]:
        with tempfile.TemporaryDirectory(prefix="notalone-proof-b-prefix-") as directory:
            target = Path(directory)
            for source in MIGRATIONS.glob("*.sql"):
                if source.name[:3] <= number:
                    shutil.copyfile(source, target / source.name)
            return migrate(self.database_url, target)

    def _cleanup_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(self.database_name),
            ))
            residual = self.admin.execute(
                "SELECT count(*) FROM pg_database WHERE datname=%s",
                (self.database_name,),
            ).fetchone()[0]
            self.assertEqual(residual, 0)
            print(f"isolated_database_cleaned={self.database_name};residual={residual}")
        finally:
            self.admin.close()

    def _replace_source(self, text: str, speaker: str = "contact") -> None:
        self.source_text = text
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.message SET text_content=%s,speaker=%s WHERE id=%s",
                (text, speaker, self.message_id),
            )
            connection.execute(
                "UPDATE public.source_document SET content_sha256=%s WHERE id=%s",
                (content_digest(text), self.source_id),
            )
            connection.execute(
                "UPDATE public.message_source_ref SET raw_payload=%s WHERE message_id=%s",
                (Jsonb({"text": text}), self.message_id),
            )

    def _client(self, store: PostgresMemoryStore) -> InProcessClient:
        service = MemoryService(
            contact_memory=store,
            owner_memory=PostgresOwnerMemoryStore(self.database_url),
        )
        return InProcessClient(create_app(
            database_url=self.database_url, owner_id=self.scope.owner_id,
            token="test-token", memory_service=service,
        ))

    def _producer_candidate(
        self, *, proof="complete", mode="nullable-proof-v2", expect_basis=None,
    ) -> MemoryCandidate:
        messages = load_contact_messages(self.scope, self.database_url)
        window = ExtractionWindow(
            self.scope.owner_id, self.scope.contact_id, messages, (self.message_id,),
        )
        outcome, model, raw = author_quote_producer(window, proof=proof, mode=mode)
        self.assertIsNone(outcome.failure_kind)
        self.assertEqual(len(model.seen_calls), 1)
        self.assertEqual(len(outcome.accepted), 1)
        fact, = outcome.accepted
        self.assertEqual(fact.dimension_evidence.version, {
            "legacy-v4": 1, "nullable-proof-v1": 2, "nullable-proof-v2": 3,
        }[mode])
        self.assertTrue(fact.dimension_evidence.source_bound)
        if proof == "complete":
            self.assertEqual(raw["proof"]["version"], 2)
        expected = proof == "complete" if expect_basis is None else expect_basis
        self.assertEqual(fact.dimension_evidence.semantic_basis is not None, expected)
        return MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text=fact.text,
            category=fact.category, topic=fact.topic, subject=fact.subject,
            source_ids=fact.source_message_ids, confidence=fact.confidence,
            risk_flags=fact.risk_flags, alternatives=fact.alternatives,
            valid_at=fact.valid_at, invalid_at=fact.invalid_at, timing=fact.timing,
            interpretation_reason=fact.interpretation_reason,
            dimension_evidence=fact.dimension_evidence,
        )

    def _assert_blocked_confirmation(self, store, saved) -> None:
        current = store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertFalse(current.dimension_evidence.source_bound)
        with self.assertRaises(DimensionEvidenceChangedError):
            store.confirm(
                scope=self.scope, candidate_id=saved.candidate_id,
                expected_dimension_evidence=saved.dimension_evidence,
            )
        self.assertEqual(store.list_confirmed(self.scope), ())

    def test_actual_producer_requires_059_then_saves_reads_and_exports(self) -> None:
        candidate = self._producer_candidate()
        store = PostgresMemoryStore(self.database_url)
        with self.assertRaises(MemoryPersistenceError):
            store.create_candidate(candidate)
        self.assertIsNone(store.get_candidate(
            scope=self.scope, candidate_id=self.old_id,
        ).dimension_evidence)
        migrate(self.database_url, MIGRATIONS)
        saved = store.create_candidate(candidate)
        read = store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertEqual(read.status.value, "pending")
        self.assertTrue(read.dimension_evidence.source_bound)
        self.assertEqual(read.dimension_evidence.to_payload(), candidate.dimension_evidence.to_payload())
        basis = read.dimension_evidence.semantic_basis.to_payload()
        self.assertEqual((basis["version"], basis["representation"]["kind"]), (2, "author_quote_h1"))
        self.assertEqual(basis["rules"], [{"rule_id": "AUTHOR_ARRIVAL_H1", "rule_version": 2}])
        self.assertEqual(basis["capabilities"], [
            "author_binding", "arrival_event_preservation", "author_self_reference",
            "direct_attribution", "recency_preservation",
        ])
        for name, span in (("candidate", (0, 13)), ("author", (0, 3)), ("inner", (7, 12))):
            self.assertEqual((basis["representation"][name]["start"], basis["representation"][name]["end"]), span)
        response = self._client(store).get(
            f"/api/contacts/{self.scope.contact_id}/memory-candidates",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(response.status_code, 200)
        exported = next(row for row in response.json()["candidates"]
                        if row["candidate_id"] == str(saved.candidate_id))
        self.assertEqual(exported["dimension_evidence"], candidate.dimension_evidence.to_payload())
        self.assertTrue(exported["dimension_evidence_source_current"])
        self.assertNotIn(self.source_text, str(exported["dimension_evidence"]))
        self.assertNotIn(saved.text, str(exported["dimension_evidence"]))
        for other_scope in (ContactScope(self.scope.owner_id, uuid4()),
                            ContactScope(uuid4(), self.scope.contact_id)):
            with self.subTest(scope=other_scope), self.assertRaises(PermissionError):
                store.get_candidate(scope=other_scope, candidate_id=saved.candidate_id)
        self.assertEqual(store.list_confirmed(self.scope), ())

    def test_save_reparses_new_basis_and_current_source_in_its_transaction(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        candidate = self._producer_candidate()
        payload = deepcopy(candidate.dimension_evidence.to_payload())
        payload["semantic_basis"]["rule_set_sha256"] = "f" * 64
        forged = replace(candidate, dimension_evidence=DimensionEvidence.from_payload(payload))
        store = PostgresMemoryStore(self.database_url)
        with self.assertRaises(DimensionEvidenceChangedError):
            store.create_candidate(forged)
        pragmatics = deepcopy(candidate.dimension_evidence.to_payload())
        pragmatics["pragmatics"]["speech_act"] = "plan"
        with self.assertRaises(DimensionEvidenceChangedError):
            store.create_candidate(replace(
                candidate, dimension_evidence=DimensionEvidence.from_payload(pragmatics),
            ))
        self._replace_source("我刚到学校。")
        with self.assertRaises(DimensionEvidenceChangedError):
            store.create_candidate(candidate)
        self.assertEqual(store.list_pending_candidates(self.scope), ())
        legacy = store.get_candidate(scope=self.scope, candidate_id=self.old_id)
        self.assertEqual((legacy.status.value, legacy.failure_reason),
                         ('invalidated', 'correction:generation_unknown'))
        self.assertEqual((legacy.text, legacy.source_ids), ('旧合成候选', (self.message_id,)))

    def test_database_requires_the_only_direct_source_for_nonnull_v3_basis(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        saved = PostgresMemoryStore(self.database_url).create_candidate(self._producer_candidate())
        with psycopg.connect(self.database_url) as connection:
            with self.assertRaises(psycopg.errors.CheckViolation):
                with connection.transaction():
                    connection.execute(
                        "UPDATE public.memory_candidate SET source_ids=%s WHERE id=%s",
                        ([self.message_id, uuid4()], saved.candidate_id),
                    )

    def test_actual_sender_recency_and_unicode_variants_round_trip(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        for speaker, text, author in (
            ("user", "我刚到家", "用户"),
            ("contact", "我刚刚到家。", "联系人"),
            ("user", "我刚刚到家。", "用户"),
        ):
            with self.subTest(speaker=speaker, text=text):
                self._replace_source(text, speaker)
                saved = store.create_candidate(self._producer_candidate())
                self.assertEqual(saved.text, f'{author}原话：“{text.strip()}”')
                read = store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
                self.assertTrue(read.dimension_evidence.source_bound)
                self.assertEqual(read.subject.value, "self" if speaker == "user" else "contact")

    def test_database_rejects_wrong_versions_graph_and_representation(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        saved = PostgresMemoryStore(self.database_url).create_candidate(self._producer_candidate())
        payload = saved.dimension_evidence.to_payload()
        invalid = []

        def change(path, value):
            edited = deepcopy(payload)
            target = edited
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            invalid.append((path, value, edited))

        for version in (True, 3.0, 2, 4):
            change(("version",), version)
        change(("extra",), True)
        for path, value in (
            (("semantic_basis", "version"), 1),
            (("semantic_basis", "version"), 2.0),
            (("semantic_basis", "rules", 0, "rule_version"), 2.0),
            (("semantic_basis", "rules", 0, "rule_version"), True),
            (("semantic_basis", "rules", 0, "rule_id"), "KIN_LEND_BA_H1"),
            (("semantic_basis", "roles", 0, "role_id"), True),
            (("semantic_basis", "roles", 0, "role_id"), 0.0),
            (("semantic_basis", "atoms", 0, "roles", "actor"), 15),
            (("semantic_basis", "atoms", 0, "roles", "actor"), 0.0),
            (("semantic_basis", "atoms", 0, "phase"), "planned"),
            (("semantic_basis", "qualifiers", 0, "atom_id"), 15),
            (("semantic_basis", "qualifiers", 0, "kind"), "quantity"),
            (("semantic_basis", "qualifiers", 0, "slot"), None),
            (("semantic_basis", "qualifiers", 0, "value_sha256"), "f" * 64),
            (("semantic_basis", "qualifiers", 0, "candidate", "sha256"), "f" * 64),
            (("semantic_basis", "reference_bindings", 0, "binding"), {}),
            (("semantic_basis", "reference_bindings", 0, "method"), "source_identity"),
            (("semantic_basis", "source_graph_sha256"), "f" * 64),
            (("semantic_basis", "frame"), "reported"),
            (("semantic_basis", "capabilities"), payload["semantic_basis"]["capabilities"][:-1]),
            (("semantic_basis", "capabilities"), list(reversed(payload["semantic_basis"]["capabilities"]))),
            (("semantic_basis", "representation", "version"), True),
            (("semantic_basis", "representation", "version"), 1.0),
            (("semantic_basis", "representation", "kind"), "direct_h"),
            (("semantic_basis", "representation", "source", "message_id"), str(uuid4())),
            (("semantic_basis", "representation", "source", "span", "end"), 100),
            (("semantic_basis", "representation", "source", "span", "sha256"), "f" * 64),
            (("semantic_basis", "representation", "candidate", "end"), 100),
            (("semantic_basis", "representation", "author", "start"), 1),
            (("semantic_basis", "representation", "inner", "start"), 6),
            (("semantic_basis", "representation", "inner", "text"), "不允许正文"),
            (("messages", 0, "source_refs"), []),
            (("messages", 0, "source_state_sha256"), None),
            (("messages", 0, "sender"), "self"),
            (("scope", "owner_id"), str(uuid4())),
            (("pragmatics", "speech_act"), "plan"),
        ):
            change(path, value)
        with psycopg.connect(self.database_url) as connection:
            for path, value, edited in invalid:
                with self.subTest(path=path, value=value):
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        with connection.transaction():
                            connection.execute(
                                "UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s",
                                (Jsonb(edited), saved.candidate_id),
                            )
            for column, value in (
                ("category", "relationship_note"), ("subject", "self"),
                ("valid_at", datetime(2026, 10, 16, tzinfo=timezone.utc)),
                ("invalid_at", datetime(2026, 10, 17, tzinfo=timezone.utc)),
            ):
                with self.subTest(column=column):
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        with connection.transaction():
                            connection.execute(sql.SQL(
                                "UPDATE public.memory_candidate SET {}=%s WHERE id=%s"
                            ).format(sql.Identifier(column)), (value, saved.candidate_id))
        self.assertTrue(PostgresMemoryStore(self.database_url).get_candidate(
            scope=self.scope, candidate_id=saved.candidate_id,
        ).dimension_evidence.source_bound)

    def test_confirm_reparses_current_rules_without_changing_saved_hashes(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        original = saved.dimension_evidence.to_payload()
        with patch.dict(source_proof._GRAMMARS, {
            "arrival_source": source_proof._GRAMMARS["arrival_source"] + "(?:)",
        }):
            self._assert_blocked_confirmation(store, saved)
            self.assertEqual(store.get_candidate(
                scope=self.scope, candidate_id=saved.candidate_id,
            ).dimension_evidence.to_payload(), original)
        self.assertTrue(store.get_candidate(
            scope=self.scope, candidate_id=saved.candidate_id,
        ).dimension_evidence.source_bound)

    def test_nonactive_source_invalidates_before_confirm(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        try:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.source_document SET status='deleting' WHERE id=%s",
                    (self.source_id,),
                )
            self.assertFalse(store.get_candidate(
                scope=self.scope, candidate_id=saved.candidate_id,
            ).dimension_evidence.source_bound)
            with self.assertRaises(MemoryCorrectionConflictError):
                store.confirm(scope=self.scope, candidate_id=saved.candidate_id)
            self.assertEqual(store.list_confirmed(self.scope), ())
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.source_document SET status='active' WHERE id=%s",
                    (self.source_id,),
                )

    def test_confirm_reparses_stored_basis_with_unchanged_window_digests(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        payload = deepcopy(saved.dimension_evidence.to_payload())
        payload["semantic_basis"]["rule_set_sha256"] = "f" * 64
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s",
                (Jsonb(payload), saved.candidate_id),
            )
        self._assert_blocked_confirmation(store, saved)

    def test_source_text_author_time_and_raw_state_invalidate_before_confirm(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        at = datetime(2026, 10, 16, tzinfo=timezone.utc)
        for statement, value, original in (
            ("UPDATE public.message SET text_content=%s WHERE id=%s", "我刚到学校。", self.source_text),
            ("UPDATE public.message SET speaker=%s WHERE id=%s", "user", "contact"),
            ("UPDATE public.message SET occurred_at=%s WHERE id=%s", at + timedelta(seconds=1), at),
            ("UPDATE public.message_source_ref SET raw_payload=%s WHERE message_id=%s",
             Jsonb({"text": "合成来源状态已变"}), Jsonb({"text": self.source_text})),
        ):
            with self.subTest(statement=statement):
                try:
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(statement, (value, self.message_id))
                    self._assert_blocked_confirmation(store, saved)
                finally:
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(statement, (original, self.message_id))
        self.assertTrue(store.get_candidate(
            scope=self.scope, candidate_id=saved.candidate_id,
        ).dimension_evidence.source_bound)

    def test_migration_preserves_existing_null_v1_and_v2_payloads(self) -> None:
        store = PostgresMemoryStore(self.database_url)
        legacy = [store.create_candidate(self._producer_candidate(proof="omitted", mode="legacy-v4")),
                  store.create_candidate(self._producer_candidate(proof=None, mode="nullable-proof-v1"))]
        originals = [candidate.dimension_evidence.to_payload() for candidate in legacy]
        migrate(self.database_url, MIGRATIONS)
        self.assertEqual(migrate(self.database_url, MIGRATIONS), ())
        self.assertIsNone(store.get_candidate(scope=self.scope, candidate_id=self.old_id).dimension_evidence)
        for candidate, original in zip(legacy, originals, strict=True):
            read = store.get_candidate(scope=self.scope, candidate_id=candidate.candidate_id)
            self.assertEqual(read.dimension_evidence.to_payload(), original)
            self.assertIs(read.source_dependency_mode, SourceDependencyMode.ANY)
            self.assertEqual((read.status.value, read.failure_reason),
                             ('invalidated', 'correction:generation_unknown'))
            for method in (AdoptionMethod.AUTO, AdoptionMethod.MANUAL):
                with self.subTest(method=method), self.assertRaises(MemoryCorrectionConflictError):
                    store.confirm(scope=self.scope, candidate_id=candidate.candidate_id, adoption_method=method)
        self.assertEqual(store.list_pending_candidates(self.scope), ())

    def test_rejection_clears_v3_evidence_and_blocks_same_old_source(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        rejected = store.create_candidate(self._producer_candidate())
        self.assertIsNone(store.reject_candidate(
            scope=self.scope, candidate_id=rejected.candidate_id,
        ).dimension_evidence)
        repeated = store.create_candidate(self._producer_candidate())
        self.assertEqual((repeated.status.value, repeated.failure_reason),
                         ('invalidated', 'correction:old_evidence'))
        self.assertEqual(store.list_pending_candidates(self.scope), ())
        for method in (AdoptionMethod.AUTO, AdoptionMethod.MANUAL):
            with self.subTest(method=method), self.assertRaises(MemoryCorrectionConflictError):
                store.confirm(scope=self.scope, candidate_id=repeated.candidate_id, adoption_method=method)

    def test_discard_clears_v3_evidence(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        discarded = store.create_candidate(self._producer_candidate())
        response = self._client(store).request(
            "POST", f"/api/contacts/{self.scope.contact_id}/memory-candidates/{discarded.candidate_id}/discard",
            headers={"Authorization": "Bearer test-token"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(store.get_candidate(
            scope=self.scope, candidate_id=discarded.candidate_id,
        ).dimension_evidence)

    def test_source_delete_clears_pending_v3_evidence(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        active = store.create_candidate(self._producer_candidate())
        self.assertTrue(active.dimension_evidence.source_bound)
        deletion = PostgresSourceDeletionRepository(self.database_url)
        result = deletion.delete_source(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=self.source_id,
        )
        self.assertEqual(result.outcome, "deleted")
        deletion.verify_deleted(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=self.source_id,
        )
        self.assertEqual(store.list_pending_candidates(self.scope), ())
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.memory_candidate WHERE dimension_evidence IS NOT NULL",
            ).fetchone()[0], 0)

    def test_compiler_source_padding_remains_unknown_without_rewriting_candidate(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        self._replace_source(" 我刚刚到家。 ", "user")
        candidate = self._producer_candidate(expect_basis=False)
        self.assertEqual(candidate.text, '用户原话：“ 我刚刚到家。”')
        saved = PostgresMemoryStore(self.database_url).create_candidate(candidate)
        self.assertIsNone(saved.dimension_evidence.semantic_basis)
        self.assertEqual(saved.status.value, "pending")

    def test_context_source_deletion_clears_unknown_v3_and_keeps_direct_candidate(self) -> None:
        migrate(self.database_url, MIGRATIONS)
        context_id, context_source = uuid4(), uuid4()
        text = "公开合成上下文。"
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""
                INSERT INTO public.source_document(
                    id,owner_id,contact_id,source_type,file_name,content_sha256,record_count
                ) VALUES(%s,%s,%s,'wechat_jsonl','synthetic-proof-b-context.jsonl',%s,1)
            """, (context_source, self.scope.owner_id, self.scope.contact_id, content_digest(text)))
            connection.execute("""
                INSERT INTO public.message(
                    id,owner_id,contact_id,speaker,message_type,text_content,occurred_at
                ) VALUES(%s,%s,%s,'contact','text',%s,%s)
            """, (context_id, self.scope.owner_id, self.scope.contact_id, text,
                  datetime(2026, 10, 15, tzinfo=timezone.utc)))
            connection.execute("""
                INSERT INTO public.message_source_ref(
                    message_id,owner_id,contact_id,source_kind,source_document_id,
                    source_locator,raw_payload
                ) VALUES(%s,%s,%s,'source_document',%s,'synthetic:proof-b-context',%s)
            """, (context_id, self.scope.owner_id, self.scope.contact_id,
                  context_source, Jsonb({"text": text})))
        candidate = self._producer_candidate(expect_basis=False)
        self.assertEqual(candidate.source_ids, (self.message_id,))
        self.assertEqual(len(candidate.dimension_evidence.messages), 2)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(candidate)
        deletion = PostgresSourceDeletionRepository(self.database_url)
        result = deletion.delete_source(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=context_source,
        )
        self.assertEqual(result.outcome, "deleted")
        deletion.verify_deleted(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=context_source,
        )
        current = store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertEqual(current.text, saved.text)
        self.assertIs(current.source_dependency_mode, SourceDependencyMode.ANY)
        self.assertEqual((current.status.value, current.failure_reason),
                         ('invalidated', 'correction:generation_unknown'))
        self.assertIsNone(current.dimension_evidence)
        self.assertNotIn(saved.candidate_id, {item.candidate_id for item in store.list_pending_candidates(self.scope)})
        with self.assertRaises(MemoryCorrectionConflictError):
            store.confirm(
                scope=self.scope, candidate_id=saved.candidate_id,
                expected_dimension_evidence=saved.dimension_evidence,
            )
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.memory_candidate WHERE dimension_evidence IS NOT NULL",
            ).fetchone()[0], 0)

    def test_version3_requires_its_validated_forward_constraint(self) -> None:
        with psycopg.connect(self.database_url) as connection:
            self.assertTrue(supports_dimension_evidence_version(connection, 1))
            self.assertTrue(supports_dimension_evidence_version(connection, 2))
            self.assertFalse(supports_dimension_evidence_version(connection, 3))
        self.assertEqual(migrate(self.database_url, MIGRATIONS), tuple(
            source.name for source in sorted(MIGRATIONS.glob('*.sql')) if source.name[:3] > '058'))
        self.assertEqual(migrate(self.database_url, MIGRATIONS), ())
        with psycopg.connect(self.database_url) as connection:
            self.assertTrue(supports_dimension_evidence_version(connection, 1))
            self.assertTrue(supports_dimension_evidence_version(connection, 2))
            self.assertTrue(supports_dimension_evidence_version(connection, 3))
            self.assertTrue(supports_dimension_evidence_version(connection, 4))
            for invalid in (True, 3.0, 5, "3", None):
                with self.subTest(version=invalid):
                    self.assertFalse(supports_dimension_evidence_version(connection, invalid))
            connection.execute("""
                ALTER TABLE public.memory_candidate
                DROP CONSTRAINT memory_candidate_dimension_evidence_version4_check
            """)
            connection.execute("""
                ALTER TABLE public.memory_candidate
                ADD CONSTRAINT memory_candidate_dimension_evidence_version4_check
                CHECK (true) NOT VALID
            """)
            self.assertFalse(supports_dimension_evidence_version(connection, 3))
            self.assertFalse(supports_dimension_evidence_version(connection, 4))


if __name__ == "__main__":
    unittest.main()
