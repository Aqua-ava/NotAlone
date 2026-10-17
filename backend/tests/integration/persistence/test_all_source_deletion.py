"""新ALL正文依赖的物理删除反控；直接SQL只验证删除，不签来源语义。"""

from pathlib import Path
import hashlib
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from notalone.database_migrations import migrate
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore


class AllSourceDeletionTest(unittest.TestCase):
    def setUp(self):
        import notalone.persistence.source_memory_erasure as implementation
        self.assertEqual(Path(implementation.__file__).resolve(),
                         Path(__file__).resolve().parents[3] / "src/notalone/persistence/source_memory_erasure.py")
        self.name = f"notalone_all_delete_{uuid4().hex}_test"
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.name)))
        self.addCleanup(self._drop)
        self.url = make_conninfo("host=/tmp", dbname=self.name)
        migrate(self.url, Path(__file__).resolve().parents[3] / "database/migrations")
        self.owner, self.contact, self.other = uuid4(), uuid4(), uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')", (self.owner,))
            for contact in (self.contact, self.other):
                connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')", (self.owner, contact))
        self.target_source, self.target = self._source("合成目标原文。")
        self.context_source, self.context = self._source("合成必需上下文。")
        self.deletion = PostgresSourceDeletionRepository(self.url)

    def _drop(self):
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.name)))
            self.assertEqual(self.admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s", (self.name,)).fetchone(), (0,))
            print(f"isolated_database_cleaned={self.name};residual=0")
        finally:
            self.admin.close()

    def _source(self, text):
        source, message = uuid4(), uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'wechat_jsonl','synthetic-all.jsonl',%s,1)", (source, self.owner, self.contact, hashlib.sha256(text.encode()).hexdigest()))
            connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,'contact','text',%s,'2026-10-17T10:00:00+08:00')", (message, self.owner, self.contact, text))
            connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,'source_document',%s,'synthetic:all',%s)", (message, self.owner, self.contact, source, Jsonb({"text": text})))
        return source, message

    def _record(self, table, *, mode="all", status=None, source_ids=None, candidate=None, supersedes=None, contact=None):
        identifier = uuid4()
        columns = ["id", "owner_id", "text_content", "category", "source_ids", "source_dependency_mode"]
        values = [identifier, self.owner, "合成正文及必需上下文", "common_fact", source_ids or [self.target, self.context], mode]
        if table != "owner_memory":
            columns.append("contact_id")
            values.append(contact or self.contact)
        if table != "memory_candidate":
            columns.append("adoption_method")
            values.append("manual")
        if status is not None:
            columns.append("status")
            values.append(status)
            if status == "extract_failed":
                columns.append("failure_reason")
                values.append("synthetic_failure")
        if candidate is not None:
            columns.append("source_candidate_id")
            values.append(candidate)
        if supersedes is not None:
            columns.append("supersedes_memory_id")
            values.append(supersedes)
        with psycopg.connect(self.url) as connection:
            connection.execute(sql.SQL("INSERT INTO public.{}({}) VALUES({})").format(
                sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, columns)),
                sql.SQL(",").join(sql.Placeholder() for _ in values)), values)
        return identifier

    def _delete(self, source):
        return self.deletion.delete_source(owner_id=self.owner, contact_id=self.contact, source_document_id=source)

    def _row(self, table, identifier):
        with psycopg.connect(self.url) as connection:
            return connection.execute(sql.SQL("SELECT text_content,source_ids,source_dependency_mode FROM public.{} WHERE id=%s").format(sql.Identifier(table)), (identifier,)).fetchone()

    def _request(self, *, state="failed", parent=None):
        identifier, binding = uuid4(), uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,continued_from_candidate_id) VALUES(%s,%s,%s,%s,%s,'合成输入',%s,1,now()+interval '1 hour',%s)", (identifier, self.owner, self.other, binding, uuid4(), state, parent))
        return identifier, binding

    def test_one_required_message_erases_all_statuses_and_versions_but_keeps_any(self):
        records = [("memory_candidate", self._record("memory_candidate", status=status))
                   for status in ("pending", "confirmed", "rejected", "invalidated", "extract_failed")]
        origin = records[1][1]
        first = self._record("confirmed_memory", candidate=origin)
        corrected = self._record("confirmed_memory", supersedes=first)
        records += [("confirmed_memory", first), ("confirmed_memory", corrected)]
        for table in ("confirmed_memory", "owner_memory"):
            records += [(table, self._record(table, status=status)) for status in ("active", "invalidated", "deleted")]
        keep_any = self._record("confirmed_memory", mode="any")
        keep_manual = self._record("confirmed_memory", mode="any", source_ids=[self.target])
        keep_other = self._record("confirmed_memory", mode="any", source_ids=[self.target], contact=self.other)
        self._delete(self.context_source)
        for table, identifier in records:
            with self.subTest(table=table, identifier=identifier):
                self.assertIsNone(self._row(table, identifier))
        self.assertEqual(self._row("confirmed_memory", keep_any)[1:], ([self.target], "any"))
        self.assertIsNotNone(self._row("confirmed_memory", keep_manual))
        self.assertIsNotNone(self._row("confirmed_memory", keep_other))
        self.assertEqual(self._delete(self.context_source).outcome, "already_deleted")

    def test_alternative_source_preserves_all_until_the_last_reference_disappears(self):
        alternate, _ = self._source("合成替代引用。")
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,'source_document',%s,'synthetic:alternate',%s)", (self.context, self.owner, self.contact, alternate, Jsonb({"text": "合成必需上下文。"})))
        identifier = self._record("memory_candidate")
        self._delete(self.context_source)
        self.assertEqual(self._row("memory_candidate", identifier)[1:], ([self.target, self.context], "all"))
        self._delete(alternate)
        self.assertIsNone(self._row("memory_candidate", identifier))

    def test_unrelated_background_does_not_erase_body_dependency(self):
        background, _ = self._source("合成无关窗口背景。")
        identifier = self._record("memory_candidate")
        self._delete(background)
        self.assertEqual(self._row("memory_candidate", identifier)[1:], ([self.target, self.context], "all"))

    def test_observation_last_reference_erases_all_but_preserves_old_any_behavior(self):
        binding = PostgresConversationBindingRepository(self.url).create_binding(
            owner_id=self.owner, contact_id=self.contact, channel="wechat",
            account_scope="synthetic-all", conversation_locator="wxid_synthetic_all",
        )
        observations = PostgresObservationStore(self.url)
        observed = observations.record_batch(
            owner_id=self.owner, contact_id=self.contact, binding_id=binding.binding_id,
            mode=ObservationMode.LIVE, cli_version="synthetic/1", conversation_locator="wxid_synthetic_all",
            since_local_id=None, last_local_id=1, last_cursor="synthetic:1", record_count=1,
        )
        observation_id = observed.observation_id
        with psycopg.connect(self.url) as connection:
            connection.execute("DELETE FROM public.message_source_ref WHERE message_id=%s", (self.context,))
            connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) VALUES(%s,%s,%s,'local_wechat_observation',%s,'synthetic:observed',%s)", (self.context, self.owner, self.contact, observation_id, Jsonb({"text": "合成必需上下文。"})))
        all_record = self._record("memory_candidate", status="rejected")
        old_any = self._record("memory_candidate", mode="any")
        observations.delete_observation(owner_id=self.owner, contact_id=self.contact, observation_id=observation_id)
        self.assertIsNone(self._row("memory_candidate", all_record))
        self.assertEqual(self._row("memory_candidate", old_any)[1:], ([self.target], "any"))

    def test_owner_id_seeds_recursive_reply_cleanup_and_revokes_possible_old_owner_lease(self):
        owner_memory = self._record("owner_memory", status="invalidated")
        root, binding = self._request()
        reply_candidate = uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.reply_context_evidence(reply_request_id,evidence_id,owner_id,contact_id,conversation_binding_id,ordinal,kind,evidence_text,source_ids) VALUES(%s,%s,%s,%s,%s,0,'owner_memory','合成本人资料副本','[]')", (root, owner_memory, self.owner, self.other, binding))
            connection.execute("INSERT INTO public.reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes) VALUES(%s,%s,%s,%s,%s,0,'合成候选副本','合成依据','[]')", (reply_candidate, root, self.owner, self.other, binding))
        child, _ = self._request(parent=reply_candidate)
        running, _ = self._request(state="running")
        independent, _ = self._request()
        self._delete(self.context_source)
        with psycopg.connect(self.url) as connection:
            for identifier in (root, child, running):
                self.assertIsNone(connection.execute("SELECT id FROM public.reply_request WHERE id=%s", (identifier,)).fetchone())
            self.assertIsNotNone(connection.execute("SELECT id FROM public.reply_request WHERE id=%s", (independent,)).fetchone())
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_candidate WHERE id=%s", (reply_candidate,)).fetchone(), (0,))


if __name__ == "__main__":
    unittest.main()
