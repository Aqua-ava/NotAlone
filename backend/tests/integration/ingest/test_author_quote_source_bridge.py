"""公开合成文件经正式导入形成作者引句依据，不回填来源元数据。"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.application.memory_service import MemoryService
from notalone.database_migrations import migrate
from notalone.ingest.import_command import import_file
from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.dimensions import (
    DEFAULT_DIMENSION_RELEASE,
    required_dimensions,
    valid_evidence_dimensions,
)
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.models import ExtractionWindow, MessageRef
from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore
from notalone.persistence.postgres_repository import ImportResult, PostgresIngestRepository
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.persistence.source_tasks import PostgresSourceTasks
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from tests.unit.memory_extraction.author_quote_helpers import author_quote_producer


MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"


class AuthorQuoteSourceBridgeTest(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, {
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_MEMORY_DIMENSION_GATE": "1",
            "LANGSMITH_TRACING": "false",
        })
        environment.start()
        self.addCleanup(environment.stop)
        for target in ("httpx.Client.send", "httpx.AsyncClient.send"):
            outbound = patch(target, side_effect=AssertionError("本测试禁止真实 HTTP"))
            outbound.start()
            self.addCleanup(outbound.stop)
        self.database_name = f"notalone_quote_source_bridge_{uuid4().hex}_test"
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.addCleanup(self.admin.close)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(self.database_name),
        ))
        print(f"isolated_database_created={self.database_name}")
        self.addCleanup(self._cleanup_database)
        self.database_url = make_conninfo("host=/tmp", dbname=self.database_name)
        migrate(self.database_url, MIGRATIONS)
        self.scope = ContactScope(uuid4(), uuid4())
        self.owner_external_id = f"synthetic_owner_{uuid4().hex}"
        self.contact_external_id = f"synthetic_contact_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')",
                (self.scope.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact(owner_id,id,display_name) "
                "VALUES(%s,%s,'合成联系人')",
                (self.scope.owner_id, self.scope.contact_id),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity "
                "(owner_id,channel,external_id,observed_name) "
                "VALUES(%s,'wechat',%s,'合成用户')",
                (self.scope.owner_id, self.owner_external_id),
            )
        temporary = tempfile.TemporaryDirectory(prefix="notalone-quote-source-bridge-")
        self.directory = Path(temporary.name)
        self.addCleanup(self._cleanup_files, temporary)
        self.store = PostgresMemoryStore(self.database_url)
        self.owner_store = PostgresOwnerMemoryStore(self.database_url)
        self.adoption = MemoryAdoption(
            memory_port=self.store, owner_memory_port=self.owner_store,
        )

    def _cleanup_database(self) -> None:
        self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
            sql.Identifier(self.database_name),
        ))
        residual = self.admin.execute(
            "SELECT count(*) FROM pg_database WHERE datname=%s",
            (self.database_name,),
        ).fetchone()[0]
        self.assertEqual(residual, 0)
        print(f"isolated_database_cleaned={self.database_name};residual={residual}")

    def _cleanup_files(self, temporary: tempfile.TemporaryDirectory) -> None:
        temporary.cleanup()
        self.assertFalse(self.directory.exists())
        print("synthetic_import_files_cleaned=true")

    def _import(
        self, *, contact_text: str = "我刚到家", owner_text: str = "我刚刚到家。",
    ) -> tuple[ImportResult, tuple[MessageRef, ...], list[dict], bytes]:
        records = []
        for index, (text, own) in enumerate(((contact_text, False), (owner_text, True))):
            records.append({
                "id": {
                    "local_id": 101 + index,
                    "server_id_str": f"synthetic-arrival-{101 + index}",
                    "talker": self.contact_external_id,
                },
                "create_time": 1792108800 + index * 60,
                "is_from_me": own,
                "kind": "text",
                "sender": "合成用户" if own else "合成联系人",
                "sender_wxid": self.owner_external_id if own else self.contact_external_id,
                "text": text,
                "time": f"2026-10-16 08:0{index}:00",
                "time_iso": f"2026-10-16T08:0{index}:00+08:00",
            })
        content = "".join(
            json.dumps(row, ensure_ascii=False) + "\n" for row in records
        ).encode("utf-8")
        path = self.directory / "public-synthetic-arrival.jsonl"
        path.write_bytes(content)
        imported = import_file(
            path=path, owner_id=self.scope.owner_id,
            confirmation=ImportConfirmationRequest(
                ExistingContactSelection(self.scope.contact_id),
            ),
            repository=PostgresIngestRepository(self.database_url),
        )
        return imported, load_contact_messages(self.scope, self.database_url), records, content

    def _window(
        self, messages: tuple[MessageRef, ...], target: MessageRef,
    ) -> ExtractionWindow:
        return ExtractionWindow(
            self.scope.owner_id, self.scope.contact_id, messages,
            (target.message_id,),
        )

    def _client(self) -> InProcessClient:
        return InProcessClient(create_app(
            database_url=self.database_url, owner_id=self.scope.owner_id,
            token="synthetic-bridge-token",
            memory_service=MemoryService(contact_memory=self.store, owner_memory=self.owner_store),
        ))

    def _export(self) -> list[dict]:
        response = self._client().get(
            f"/api/contacts/{self.scope.contact_id}/memory-candidates",
            headers={"Authorization": "Bearer synthetic-bridge-token"},
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["candidates"]

    def test_imported_original_records_produce_current_pending_author_evidence(self) -> None:
        imported, messages, records, content = self._import()
        self.assertEqual(len(messages), 2)
        self.assertEqual(DEFAULT_DIMENSION_RELEASE.allowed, frozenset())
        for message, record, expected in zip(messages, records, (
            "联系人原话：“我刚到家”", "用户原话：“我刚刚到家。”",
        ), strict=True):
            with self.subTest(sender=message.sender.value):
                snapshot, = message.source_snapshots
                self.assertEqual(str(snapshot["source_id"]), str(imported.source_document_id))
                self.assertEqual(snapshot["source_kind"], "source_document")
                self.assertEqual(
                    snapshot["locator"],
                    "jsonl:1" if message.sender.value == "contact" else "jsonl:2",
                )
                self.assertEqual(snapshot["raw_payload"], record)
                self.assertEqual(
                    snapshot["source_content_sha256"], hashlib.sha256(content).hexdigest(),
                )
                self.assertEqual(snapshot["processing_status"], "recorded")
                self.assertEqual(snapshot["processing_record"]["payload"]["parsed"], record)
                # 明确选一条进入有限合同；不把整份导入会话当成单消息。
                outcome, model, _ = author_quote_producer(self._window((message,), message))
                self.assertIsNone(outcome.failure_kind)
                self.assertEqual(len(model.seen_calls), 1)
                fact, = outcome.accepted
                self.assertEqual(fact.text, expected)
                self.assertTrue(fact.dimension_evidence.source_bound)
                self.assertEqual(fact.dimension_evidence.version, 3)
                self.assertEqual(fact.dimension_evidence.semantic_basis.to_payload()["version"], 2)
                self.assertEqual(valid_evidence_dimensions(fact), {
                    "subject", "truth_intent", "paraphrase", "reference",
                    "reported", "time", "media",
                })
                self.assertEqual(required_dimensions(fact), {
                    "subject", "truth_intent", "paraphrase", "reference", "reported", "time",
                })
                stats = self.adoption.adopt(self.scope, outcome)
                self.assertEqual((stats.pending, stats.adopted), (1, 0))
        saved = self.store.list_pending_candidates(self.scope)
        self.assertEqual(len(saved), 2)
        for candidate in saved:
            current = self.store.get_candidate(
                scope=self.scope, candidate_id=candidate.candidate_id,
            )
            self.assertTrue(current.dimension_evidence.source_bound)
            self.assertEqual(current.status.value, "pending")
        exported = self._export()
        self.assertEqual(len(exported), 2)
        self.assertTrue(all(row["dimension_evidence_source_current"] for row in exported))
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_imported_source_does_not_replace_proof_or_remove_full_context(self) -> None:
        _, messages, _, _ = self._import()
        for window, proof in (
            (self._window((messages[0],), messages[0]), "omitted"),
            (self._window(messages, messages[1]), "complete"),
        ):
            with self.subTest(proof=proof):
                outcome, model, _ = author_quote_producer(window, proof=proof)
                self.assertIsNone(outcome.failure_kind)
                self.assertEqual(len(model.seen_calls), 1)
                fact, = outcome.accepted
                self.assertTrue(fact.dimension_evidence.source_bound)
                self.assertIsNone(fact.dimension_evidence.semantic_basis)
                self.assertFalse({"subject", "paraphrase", "reference", "reported", "time"}
                                 & valid_evidence_dimensions(fact))
                stats = self.adoption.adopt(self.scope, outcome)
                self.assertEqual((stats.pending, stats.adopted), (1, 0))
        self.assertEqual(len(self._export()), 2)
        self.assertTrue(all(candidate.dimension_evidence.semantic_basis is None
                            for candidate in self.store.list_pending_candidates(self.scope)))
        self.assertEqual(self.store.list_confirmed(self.scope), ())

    def test_import_retains_source_padding_and_compiler_unknown(self) -> None:
        _, messages, _, _ = self._import(contact_text=" 我刚到家。 ")
        message = messages[0]
        self.assertEqual(message.text, " 我刚到家。 ")
        self.assertEqual(message.source_snapshots[0]["raw_payload"]["text"], " 我刚到家。 ")
        outcome, model, _ = author_quote_producer(self._window((message,), message))
        self.assertIsNone(outcome.failure_kind)
        self.assertEqual(len(model.seen_calls), 1)
        fact, = outcome.accepted
        self.assertEqual(fact.text, "联系人原话：“ 我刚到家。”")
        self.assertIsNone(fact.dimension_evidence.semantic_basis)
        stats = self.adoption.adopt(self.scope, outcome)
        self.assertEqual((stats.pending, stats.adopted), (1, 0))
        exported, = self._export()
        self.assertIsNone(exported["dimension_evidence"]["semantic_basis"])

    def test_import_source_delete_request_stops_loader_and_invalidates_api_evidence(self) -> None:
        imported, messages, _, _ = self._import()
        outcome, _, _ = author_quote_producer(self._window((messages[0],), messages[0]))
        stats = self.adoption.adopt(self.scope, outcome)
        self.assertEqual((stats.pending, stats.adopted), (1, 0))
        saved, = self.store.list_pending_candidates(self.scope)
        self.assertTrue(saved.dimension_evidence.source_bound)
        PostgresSourceTasks(self.database_url).request_delete(
            self.scope.owner_id, self.scope.contact_id, imported.source_document_id,
        )
        self.assertEqual(load_contact_messages(self.scope, self.database_url), ())
        current = self.store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertFalse(current.dimension_evidence.source_bound)
        exported, = self._export()
        self.assertFalse(exported["dimension_evidence_source_current"])
        with self.assertRaises(PermissionError):
            self.store.confirm(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        deletion = PostgresSourceDeletionRepository(self.database_url)
        result = deletion.delete_source(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=imported.source_document_id,
        )
        self.assertEqual(result.outcome, "deleted")
        deletion.verify_deleted(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            source_document_id=imported.source_document_id,
        )
        with self.assertRaises(LookupError):
            self.store.get_candidate(scope=self.scope, candidate_id=saved.candidate_id)
        self.assertEqual(self._export(), [])
        self.assertEqual(load_contact_messages(self.scope, self.database_url), ())
