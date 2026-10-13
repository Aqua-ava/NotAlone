"""真实producer进入随机隔离库；业务库与真实模型均不在此接缝。"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
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

from notalone.application.memory_service import MemoryService
from notalone.database_migrations import migrate
from notalone.memory import MemoryCandidate
from notalone.memory.dimension_evidence import DimensionEvidence, DimensionEvidenceChangedError
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow
from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore
from notalone.persistence.memory_store import MemoryPersistenceError
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result


MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"


class DimensionEvidenceV2PersistenceTest(unittest.TestCase):
    created_database_names: list[str] = []

    def setUp(self) -> None:
        self.database_name = f"notalone_dimension_v2_{uuid4().hex}_test"
        self.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(self.database_name)))
        self.created_database_names.append(self.database_name)
        self.database_url = make_conninfo("host=/tmp", dbname=self.database_name)
        self.addCleanup(self._cleanup_database)
        self._prefix("055")
        self.scope = ContactScope(uuid4(), uuid4())
        self.source_id, self.message_id, self.old_id = uuid4(), uuid4(), uuid4()
        self.source_text = "我刚到家。"
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')", (self.scope.owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')", (self.scope.owner_id,self.scope.contact_id))
            connection.execute("""INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES(%s,%s,%s,'wechat_jsonl','synthetic-v2.jsonl',%s,1)""", (self.source_id,self.scope.owner_id,self.scope.contact_id,"a"*64))
            connection.execute("""INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                VALUES(%s,%s,%s,'contact','text',%s,%s)""", (self.message_id,self.scope.owner_id,self.scope.contact_id,self.source_text,datetime(2026,10,13,tzinfo=timezone.utc)))
            connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES(%s,%s,%s,'source_document',%s,'synthetic:one','{}'::jsonb)""", (self.message_id,self.scope.owner_id,self.scope.contact_id,self.source_id))
            connection.execute("""INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,source_ids)
                VALUES(%s,%s,%s,'旧合成候选','common_fact',%s)""", (self.old_id,self.scope.owner_id,self.scope.contact_id,[self.message_id]))

    def _prefix(self, number: str) -> tuple[str, ...]:
        with tempfile.TemporaryDirectory(prefix="notalone-dimension-v2-prefix-") as directory:
            target = Path(directory)
            for source in MIGRATIONS.glob("*.sql"):
                if source.name[:3] <= number:
                    shutil.copyfile(source, target / source.name)
            return migrate(self.database_url, target)

    def _cleanup_database(self) -> None:
        try:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(self.database_name)))
        finally:
            self.admin.close()

    def _producer_candidate(
        self, *, text: str = "联系人刚到家。", rule: str = "AUTHOR_ARRIVAL_H1",
        variant: str = "direct_h", frame: str = "direct", subject: str = "contact",
        category: str = "common_fact", speech: str = "assertion", assertion: str = "asserted",
    ) -> MemoryCandidate:
        messages = load_contact_messages(self.scope, self.database_url)
        window = ExtractionWindow(self.scope.owner_id,self.scope.contact_id,messages)
        source = {"message_id":str(self.message_id),"start":0,"end":len(self.source_text)}
        main = self.source_text.split("。", 1)[0]
        author_start = main.rindex("我")
        author = {"message_id":str(self.message_id),"start":author_start,"end":author_start + 1}
        references = [{"rule_id":rule,"mention":author,"target":author,"binding":None}]
        if "这里的“" in self.source_text:
            binding_start = self.source_text.index("这里的“")
            pronoun = self.source_text[binding_start + 4]
            mention_start = main.index(pronoun)
            target_start = self.source_text.index("指", binding_start) + 1
            references.append({
                "rule_id":"SOURCE_IDENTITY_H1",
                "mention":{"message_id":str(self.message_id),"start":mention_start,"end":mention_start + 1},
                "target":{"message_id":str(self.message_id),"start":target_start,"end":len(self.source_text.rstrip("。"))},
                "binding":{"message_id":str(self.message_id),"start":binding_start,"end":len(self.source_text.rstrip("。"))},
            })
        proof = {
            "version":1,
            "atom_links":[{"rule_id":rule,"variant_id":variant,"source":source,"candidate":{"start":0,"end":len(text)}}],
            "reference":references,
            "reported":[{"rule_id":rule,"frame":frame,"source":source,"candidate":{"start":0,"end":len(text)}}],
        }
        verifier = FixedSourceVerifier(({**verification_result(evidence=((self.message_id,self.source_text),)),"proof":proof},))
        verifier.verification_mode = "nullable-proof-v1"
        outcome = ExtractionFlow(runtime=RecordingRuntime((_payload(self.message_id,text=text,category=category,subject=subject,speech_act=speech,assertion_status=assertion),)),verification_runtime=verifier).run(window)
        self.assertIsNone(outcome.failure_kind)
        self.assertEqual(len(outcome.accepted),1)
        self.assertEqual(len(verifier.calls),1)
        fact = outcome.accepted[0]
        self.assertEqual(fact.dimension_evidence.version,2)
        return MemoryCandidate(candidate_id=uuid4(),scope=self.scope,text=fact.text,
            category=fact.category,topic=fact.topic,subject=fact.subject,
            source_ids=fact.source_message_ids,confidence=fact.confidence,
            risk_flags=fact.risk_flags,alternatives=fact.alternatives,
            valid_at=fact.valid_at,invalid_at=fact.invalid_at,timing=fact.timing,
            interpretation_reason=fact.interpretation_reason,dimension_evidence=fact.dimension_evidence)

    def _client(self, store: PostgresMemoryStore) -> InProcessClient:
        service = MemoryService(contact_memory=store,owner_memory=PostgresOwnerMemoryStore(self.database_url))
        return InProcessClient(create_app(database_url=self.database_url,owner_id=self.scope.owner_id,token="test-token",memory_service=service))

    def test_055_and_056_read_null_and_refuse_new_version_without_ddl(self) -> None:
        candidate = self._producer_candidate()
        store = PostgresMemoryStore(self.database_url)
        for prefix in ("055","056"):
            with self.subTest(schema=prefix):
                self._prefix(prefix)
                self.assertIsNone(store.get_candidate(scope=self.scope,candidate_id=self.old_id).dimension_evidence)
                with self.assertRaises(MemoryPersistenceError):
                    store.create_candidate(candidate)
                with psycopg.connect(self.database_url) as connection:
                    self.assertIsNone(connection.execute("SELECT id FROM public.memory_candidate WHERE id=%s",(candidate.candidate_id,)).fetchone())

    def test_forward_migration_preserves_null_and_repeats_empty(self) -> None:
        applied = migrate(self.database_url,MIGRATIONS)
        self.assertIn("057_memory_candidate_semantic_basis.sql",applied)
        old = PostgresMemoryStore(self.database_url).get_candidate(scope=self.scope,candidate_id=self.old_id)
        self.assertIsNone(old.dimension_evidence)
        self.assertEqual(old.status.value,"pending")
        self.assertEqual(migrate(self.database_url,MIGRATIONS),())

    def test_actual_producer_saves_reads_and_exports_no_body_basis(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        candidate = self._producer_candidate()
        self.assertIsNotNone(candidate.dimension_evidence.semantic_basis)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(candidate)
        read = store.get_candidate(scope=self.scope,candidate_id=saved.candidate_id)
        self.assertTrue(read.dimension_evidence.source_bound)
        self.assertEqual(read.dimension_evidence.to_payload(),candidate.dimension_evidence.to_payload())
        client = self._client(store)
        response = client.get(f"/api/contacts/{self.scope.contact_id}/memory-candidates",headers={"Authorization":"Bearer test-token"})
        self.assertEqual(response.status_code,200)
        exported = next(item for item in response.json()["candidates"] if item["candidate_id"]==str(saved.candidate_id))
        self.assertEqual(exported["dimension_evidence"],saved.dimension_evidence.to_payload())
        self.assertTrue(exported["dimension_evidence_source_current"])
        self.assertNotIn(self.source_text,str(exported["dimension_evidence"]))
        self.assertNotIn(saved.text,str(exported["dimension_evidence"]))
        with self.assertRaises(PermissionError):
            store.get_candidate(scope=ContactScope(self.scope.owner_id,uuid4()),candidate_id=saved.candidate_id)

    def test_save_rechecks_actual_source_and_graph_in_its_transaction(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        candidate = self._producer_candidate()
        store = PostgresMemoryStore(self.database_url)
        payload = deepcopy(candidate.dimension_evidence.to_payload())
        payload["semantic_basis"]["rule_set_sha256"]="f"*64
        forged = replace(candidate,dimension_evidence=DimensionEvidence.from_payload(payload))
        with self.assertRaises(DimensionEvidenceChangedError):
            store.create_candidate(forged)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message SET text_content='我刚到学校。' WHERE id=%s",(self.message_id,))
        with self.assertRaises(DimensionEvidenceChangedError):
            store.create_candidate(candidate)
        self.assertEqual(store.list_pending_candidates(self.scope), (store.get_candidate(scope=self.scope,candidate_id=self.old_id),))

    def test_confirm_reparses_basis_instead_of_trusting_equal_hashes(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        payload = saved.dimension_evidence.to_payload()
        payload["semantic_basis"]["rule_set_sha256"]="f"*64
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s",(Jsonb(payload),saved.candidate_id))
        current = store.get_candidate(scope=self.scope,candidate_id=saved.candidate_id)
        self.assertFalse(current.dimension_evidence.source_bound)
        with self.assertRaises(DimensionEvidenceChangedError):
            store.confirm(scope=self.scope,candidate_id=saved.candidate_id)
        self.assertEqual(store.list_confirmed(self.scope),())

    def test_source_time_and_raw_state_change_invalidate_current_proof(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        for statement, value, original in (
            ("UPDATE public.message SET occurred_at=%s WHERE id=%s",datetime(2026,10,13,tzinfo=timezone.utc)+timedelta(seconds=1),datetime(2026,10,13,tzinfo=timezone.utc)),
            ("UPDATE public.message_source_ref SET raw_payload=%s WHERE message_id=%s",Jsonb({"synthetic_changed":True}),Jsonb({})),
        ):
            with self.subTest(statement=statement):
                try:
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(statement,(value,self.message_id))
                    self.assertFalse(store.get_candidate(scope=self.scope,candidate_id=saved.candidate_id).dimension_evidence.source_bound)
                finally:
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(statement,(original,self.message_id))
        equivalent = PostgresMemoryStore(make_conninfo(self.database_url,options="-c timezone=Asia/Taipei"))
        self.assertTrue(equivalent.get_candidate(scope=self.scope,candidate_id=saved.candidate_id).dimension_evidence.source_bound)

    def test_candidate_rejection_and_source_delete_remove_v2_evidence(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        discarded = store.discard_candidate_with_fingerprint(scope=self.scope,candidate_id=saved.candidate_id)
        self.assertIsNone(discarded.dimension_evidence)
        active = store.create_candidate(self._producer_candidate())
        deletion = PostgresSourceDeletionRepository(self.database_url)
        result = deletion.delete_source(owner_id=self.scope.owner_id,contact_id=self.scope.contact_id,source_document_id=self.source_id)
        self.assertEqual(result.outcome,"deleted")
        deletion.verify_deleted(owner_id=self.scope.owner_id,contact_id=self.scope.contact_id,source_document_id=self.source_id)
        self.assertEqual(store.list_pending_candidates(self.scope),())
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.memory_candidate WHERE dimension_evidence IS NOT NULL").fetchone()[0],0)

    def test_database_rejects_semantic_shape_and_cross_kind_edges(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(self._producer_candidate())
        payload = saved.dimension_evidence.to_payload()
        with psycopg.connect(self.database_url) as connection:
            self.assertTrue(connection.execute(
                "SELECT public.notalone_dimension_evidence_v2_shape(%s,length(text_content)) "
                "FROM public.memory_candidate WHERE id=%s", (Jsonb(payload),saved.candidate_id),
            ).fetchone()[0])
        invalid = []
        for version in (True,2.0,3):
            invalid.append({**payload,"version":version})
        invalid.append({**payload,"extra":True})
        for path,value in (
            (("semantic_basis","version"),True),
            (("semantic_basis","roles",0,"role_id"),True),
            (("semantic_basis","atoms",0,"roles","actor"),15),
            (("semantic_basis","qualifiers",0,"atom_id"),15),
            (("semantic_basis","reference_bindings",0,"binding"),{}),
        ):
            changed=deepcopy(payload); target=changed
            for key in path[:-1]: target=target[key]
            target[path[-1]]=value; invalid.append(changed)
        with psycopg.connect(self.database_url) as connection:
            for changed in invalid:
                with self.subTest(payload=changed), self.assertRaises(psycopg.errors.CheckViolation):
                    with connection.transaction():
                        connection.execute("UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s",(Jsonb(changed),saved.candidate_id))

    def test_context_source_deletion_clears_unknown_v2_without_losing_direct_candidate(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        context_id, context_source = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES(%s,%s,%s,'wechat_jsonl','synthetic-context.jsonl',%s,1)""", (context_source,self.scope.owner_id,self.scope.contact_id,"b"*64))
            connection.execute("""INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                VALUES(%s,%s,%s,'contact','text','公开合成上下文',%s)""", (context_id,self.scope.owner_id,self.scope.contact_id,datetime(2026,10,14,tzinfo=timezone.utc)))
            connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES(%s,%s,%s,'source_document',%s,'synthetic:context','{}'::jsonb)""", (context_id,self.scope.owner_id,self.scope.contact_id,context_source))
        candidate = self._producer_candidate()
        self.assertIsNone(candidate.dimension_evidence.semantic_basis)
        self.assertEqual(len(candidate.dimension_evidence.messages),2)
        store = PostgresMemoryStore(self.database_url)
        saved = store.create_candidate(candidate)
        self.assertTrue(saved.dimension_evidence.source_bound)
        deletion = PostgresSourceDeletionRepository(self.database_url)
        result = deletion.delete_source(owner_id=self.scope.owner_id,contact_id=self.scope.contact_id,source_document_id=context_source)
        self.assertEqual(result.outcome,"deleted")
        deletion.verify_deleted(owner_id=self.scope.owner_id,contact_id=self.scope.contact_id,source_document_id=context_source)
        remaining = store.get_candidate(scope=self.scope,candidate_id=saved.candidate_id)
        self.assertEqual(remaining.text,saved.text)
        self.assertIsNone(remaining.dimension_evidence)
        with self.assertRaises(DimensionEvidenceChangedError):
            store.confirm(scope=self.scope,candidate_id=saved.candidate_id,expected_dimension_evidence=saved.dimension_evidence)

    def _replace_source(self, text: str, speaker: str = "contact") -> None:
        from notalone.memory.evidence_binding import content_digest

        self.source_text = text
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message SET text_content=%s,speaker=%s WHERE id=%s",(text,speaker,self.message_id))
            connection.execute("UPDATE public.source_document SET content_sha256=%s WHERE id=%s",(content_digest(text),self.source_id))
            connection.execute("UPDATE public.message_source_ref SET raw_payload=%s WHERE message_id=%s",(Jsonb({"text":text}),self.message_id))

    def _assert_current_export(self, candidate: MemoryCandidate, store: PostgresMemoryStore) -> MemoryCandidate:
        self.assertIsNotNone(candidate.dimension_evidence.semantic_basis)
        saved = store.create_candidate(candidate)
        read = store.get_candidate(scope=self.scope,candidate_id=saved.candidate_id)
        self.assertTrue(read.dimension_evidence.source_bound)
        self.assertEqual(read.dimension_evidence.to_payload(),candidate.dimension_evidence.to_payload())
        response = self._client(store).get(f"/api/contacts/{self.scope.contact_id}/memory-candidates",headers={"Authorization":"Bearer test-token"})
        self.assertEqual(response.status_code,200)
        exported = next(item for item in response.json()["candidates"] if item["candidate_id"]==str(read.candidate_id))
        self.assertEqual(exported["dimension_evidence"],candidate.dimension_evidence.to_payload())
        self.assertTrue(exported["dimension_evidence_source_current"])
        self.assertEqual(read.status.value,"pending")
        return read

    def test_actual_self_request_frames_round_trip_roles_and_inner_time(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        self._replace_source("我姐让我后天帮她顶个班。这里的“她”指我姐。", "user")
        store = PostgresMemoryStore(self.database_url)
        cases = (
            ("用户的姐姐已提出请托，内容是希望用户后天替该姐姐顶班，未说明接受", "quoted_request_h", "report", "reported"),
            ("用户已收到用户的姐姐请托；所请内容为用户后天替该姐姐顶班，未说明接受", "received_request_h", "assertion", "asserted"),
        )
        for text,frame,speech,assertion in cases:
            with self.subTest(frame=frame):
                candidate = self._producer_candidate(text=text,rule="REQUEST_ROLE_H1",variant=frame,frame=frame,
                    subject="self",category="relationship_note",speech=speech,assertion=assertion)
                read = self._assert_current_export(candidate,store)
                basis = read.dimension_evidence.semantic_basis.to_payload()
                self.assertEqual(basis["frame"],frame)
                self.assertEqual(basis["roles"][0]["sender"],"self")
                self.assertEqual(basis["roles"][1]["kind"],"elder_sister")
                self.assertEqual(basis["reference_bindings"][1]["method"],"source_identity")
                self.assertEqual(basis["atoms"][1]["predicate"],"cover_shift")
                self.assertEqual(basis["atoms"][1]["roles"]["beneficiary"],1)
                self.assertEqual(basis["qualifiers"][0]["slot"],"requested_time")
        self.assertEqual(store.list_confirmed(self.scope),())

    def test_actual_decimal_plan_round_trips_condition_quantity_degree_and_time(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        self._replace_source("如果天晴，我计划后天跑约7.5公里。")
        store = PostgresMemoryStore(self.database_url)
        candidate = self._producer_candidate(text="如果天晴，联系人计划后天跑约7500米。",
            rule="COND_PLAN_RUN_V1",variant="conditional_plan",speech="plan",assertion="conditional")
        read = self._assert_current_export(candidate,store)
        basis = read.dimension_evidence.semantic_basis.to_payload()
        self.assertEqual([item["kind"] for item in basis["qualifiers"]],["quantity","degree","condition","time"])
        self.assertEqual([item["predicate"] for item in basis["atoms"]],["clear_weather","run"])
        self.assertEqual(basis["qualifiers"][0]["atom_id"],1)
        self.assertEqual(basis["qualifiers"][1]["quantity_qualifier_id"],0)
        self.assertEqual(basis["qualifiers"][2]["condition_atom_id"],0)
        self.assertEqual(basis["qualifiers"][2]["action_atom_id"],1)
        invalid = []
        for index,key,value in ((1,"quantity_qualifier_id",3),(0,"atom_id",0),(2,"condition_atom_id",1),(2,"action_atom_id",0)):
            changed = deepcopy(read.dimension_evidence.to_payload())
            changed["semantic_basis"]["qualifiers"][index][key]=value
            invalid.append(changed)
        with psycopg.connect(self.database_url) as connection:
            for changed in invalid:
                with self.subTest(payload=changed), self.assertRaises(psycopg.errors.CheckViolation):
                    with connection.transaction():
                        connection.execute("UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s",(Jsonb(changed),read.candidate_id))
        self.assertTrue(store.get_candidate(scope=self.scope,candidate_id=read.candidate_id).dimension_evidence.source_bound)
        self.assertEqual(store.list_confirmed(self.scope),())

    def test_database_rejects_null_qualifier_slots(self) -> None:
        migrate(self.database_url,MIGRATIONS)
        store = PostgresMemoryStore(self.database_url)
        cases = (
            ("quantity", "如果天晴，我计划后天跑约7.5公里。", {
                "text":"如果天晴，联系人计划后天跑约7500米。",
                "rule":"COND_PLAN_RUN_V1", "variant":"conditional_plan",
                "speech":"plan", "assertion":"conditional",
            }),
            ("polarity", "我哥前天没有把他的书借给我。这里的“他”指我哥。", {
                "text":"联系人的哥哥前天没有把自己的书借给联系人",
                "rule":"KIN_LEND_BA_H1", "variant":"negative_h",
            }),
        )
        for kind,source,fields in cases:
            with self.subTest(kind=kind):
                self._replace_source(source)
                saved = store.create_candidate(self._producer_candidate(**fields))
                valid = saved.dimension_evidence.to_payload()
                changed = deepcopy(valid)
                qualifier = next(item for item in changed["semantic_basis"]["qualifiers"] if item["kind"]==kind)
                qualifier["slot"] = None
                with psycopg.connect(self.database_url) as connection:
                    query = "SELECT public.notalone_dimension_evidence_v2_shape(%s,length(text_content)) FROM public.memory_candidate WHERE id=%s"
                    self.assertTrue(connection.execute(query,(Jsonb(valid),saved.candidate_id)).fetchone()[0])
                    self.assertFalse(connection.execute(query,(Jsonb(changed),saved.candidate_id)).fetchone()[0])
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        with connection.transaction():
                            connection.execute("UPDATE public.memory_candidate SET dimension_evidence=%s WHERE id=%s",(Jsonb(changed),saved.candidate_id))
                current = store.get_candidate(scope=self.scope,candidate_id=saved.candidate_id)
                self.assertEqual(current.dimension_evidence.to_payload(),valid)
                self.assertTrue(current.dimension_evidence.source_bound)
