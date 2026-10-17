"""正式导入／观察至指定任务及当前API的合成验收；不代签真实模型交付。"""

from __future__ import annotations

from contextlib import ExitStack, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta
import io
import json
import os
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.application.memory_service import MemoryService
from notalone.database_migrations import migrate
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.ingest.normalizer import normalize_document
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from notalone.tasks.command import worker_main
from notalone.tasks.extraction_runtime import runtime_config_for_mode
from notalone.tasks.models import ExtractionRuntimeMode
from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner, WorkerRunOutcome
from notalone.wechat_cli import LocalWechatCli
from notalone.wechat_cli.normalizer import normalize_cli_events


MIGRATIONS = Path(__file__).resolve().parents[3] / "database/migrations"
DIMENSIONS = {"subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported"}
DIRECT_CAPABILITIES = ["subject_binding", "event_preservation", "reference_resolution",
                       "direct_attribution", "temporal_preservation"]


def label(kind, subject="contact", dependency=None):
    return {"kind": kind, "subject": subject, "topic": "other", "dependency": dependency,
            "unresolved": False, "confidence": 0.95, "sensitivity": "none", "event": None}


def completed_question_proposal(payload):
    """公开问答例的已算位置；只取实际请求的UUID及候选包装偏移。"""
    question, answer = payload["messages"]
    candidate, = payload["candidates"]
    rule, variant = "BR_COMPLETED_QA_V1", "completed_answer"
    quote = candidate["text"].index("原话：“") + 4
    source = {"message_id": answer["message_id"], "start": 0, "end": 6}
    main = {"start": quote, "end": quote + 6}
    # 我已经到了。中作者[0,1)，动词[3,4)；前问目的地学校[3,5)。
    author = {**source, "end": 1}
    return {"version": 3,
            "atom_links": [{"rule_id": rule, "variant_id": variant,
                            "source": source, "candidate": main}],
            "reference": [
                {"rule_id": rule, "mention": author, "target": author, "binding": None},
                {"rule_id": rule, "mention": {**source, "start": 3, "end": 4},
                 "target": {"message_id": question["message_id"], "start": 3, "end": 5},
                 "binding": {"message_id": question["message_id"], "start": 0, "end": 8}},
            ],
            "reported": [{"rule_id": rule, "frame": "direct", "source": source, "candidate": main}]}


def direct_proposal(rule, variant, main, *, main_index=-1, identity=None, mention=None, condition=False, request=False):
    """仅用公开原句和实际请求定位模型提案，不生成程序图或依据。"""
    def proposal(payload):
        message = payload["messages"][main_index]
        candidate, = payload["candidates"]
        start = message["text"].index(main)
        quote = candidate["text"].index("原话：“") + 4

        def source(left, right):
            return {"message_id": message["message_id"], "start": start + left, "end": start + right}

        def target(left, right):
            return {"start": quote + left, "end": quote + right}

        whole, copied = source(0, len(main)), target(0, len(main))
        atoms = [(whole, copied)]
        if condition:
            comma = main.index("，") + 1
            atoms = [(source(0, comma), target(0, comma)), (source(comma, len(main)), target(comma, len(main)))]
        if request:
            action = main.index("让我") + 1
            end = len(main.removesuffix("。"))
            atoms.append((source(action, end), target(action, end)))
        author = main.index("让我") + 1 if request else main.index("我") if condition or rule == "BR_AUTHOR_ARRIVAL_V1" else main.rindex("我")
        anchor = source(author, author + 1)
        references = [{"rule_id": rule, "mention": anchor, "target": anchor, "binding": None}]
        if identity is not None:
            index, declaration = identity
            context = payload["messages"][index]
            binding_start = context["text"].index(declaration)
            relative = declaration.index("指") + 1
            pronoun_start = main.index(mention or declaration[4])
            references.append({"rule_id": rule, "mention": source(pronoun_start, pronoun_start + 1),
                "target": {"message_id": context["message_id"], "start": binding_start + relative,
                           "end": binding_start + len(declaration.removesuffix("。"))},
                "binding": {"message_id": context["message_id"], "start": binding_start, "end": binding_start + len(declaration)}})
        frame = "received_request" if variant.startswith("received") else "reported_request" if request else "direct"
        return {"version": 3,
                "atom_links": [{"rule_id": rule, "variant_id": variant, "source": left, "candidate": right}
                               for left, right in atoms],
                "reference": references,
                "reported": [{"rule_id": rule, "frame": frame, "source": whole, "candidate": copied}]}
    return proposal


class BoundedRuntimeAcceptanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database_name = f"notalone_bounded_acceptance_{uuid4().hex}_test"
        cls.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(cls.database_name)))
        cls.addClassCleanup(cls.drop_database)
        cls.admin.execute(sql.SQL("ALTER DATABASE {} SET timezone TO 'UTC'").format(sql.Identifier(cls.database_name)))
        cls.database_url = make_conninfo("host=/tmp", dbname=cls.database_name)
        migrate(cls.database_url, MIGRATIONS)

    @classmethod
    def drop_database(cls):
        try:
            cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))
            assert cls.admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s", (cls.database_name,)).fetchone() == (0,)
        finally:
            cls.admin.close()

    def setUp(self):
        guards = ExitStack()
        self.addCleanup(guards.close)
        self.scope = ContactScope(uuid4(), uuid4())
        self.owner_external = "wxid_acceptance_owner_" + self.scope.owner_id.hex
        self.contact_external = "wxid_acceptance_contact_" + self.scope.contact_id.hex
        guards.enter_context(patch.dict(os.environ, {
            "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.scope.owner_id), "NOTALONE_DEEPSEEK_API_KEY": "synthetic-secret",
            "NOTALONE_DEEPSEEK_MODEL": "deepseek-flash", "NOTALONE_DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        }, clear=True))
        for obj, key in ((socket.socket, "connect"), (socket.socket, "connect_ex"), (socket, "getaddrinfo")):
            guards.enter_context(patch.object(obj, key, side_effect=AssertionError("禁止真实网络")))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成验收用户')", (self.scope.owner_id,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成验收联系人')",
                               (self.scope.owner_id, self.scope.contact_id))
            connection.execute("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES(%s,'wechat',%s,'合成用户')",
                               (self.scope.owner_id, self.owner_external))
        self.store = PostgresMemoryStore(self.database_url)
        self.client = InProcessClient(create_app(
            database_url=self.database_url, owner_id=self.scope.owner_id, token="synthetic-acceptance",
            memory_service=MemoryService(contact_memory=self.store, owner_memory=PostgresOwnerMemoryStore(self.database_url)),
        ))
        self.headers = {"Authorization": "Bearer synthetic-acceptance"}

    def import_source(self, texts, senders):
        records = []
        for index, (text, sender) in enumerate(zip(texts, senders, strict=True)):
            at = datetime.fromisoformat("2030-01-02T20:00:00+08:00") + timedelta(minutes=index)
            records.append({
                "id": {"local_id": index + 1, "server_id_str": f"synthetic-{index + 1}", "talker": self.contact_external},
                "create_time": int(at.timestamp()), "is_from_me": sender == "self", "kind": "text",
                "sender": "合成用户" if sender == "self" else "合成联系人",
                "sender_wxid": self.owner_external if sender == "self" else self.contact_external,
                "text": text, "time": at.strftime("%Y-%m-%d %H:%M:%S"), "time_iso": at.isoformat(),
            })
        with tempfile.TemporaryDirectory(prefix="notalone-bounded-acceptance-") as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records), encoding="utf-8")
            document = normalize_document(read_jsonl(path))
        self.imported = PostgresIngestRepository(self.database_url).import_document(
            owner_id=self.scope.owner_id, document=document,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.scope.contact_id)),
        )
        self.messages = load_contact_messages(self.scope, self.database_url)
        self.assertEqual(tuple(row.text for row in self.messages), tuple(texts))
        self.task_id = self.imported.task_id
        return self.imported

    def observe_source(self, texts, senders=None):
        """只Mock外部CLI进程；解析、规范化、处理收据、绑定和观察写入均走正式接口。"""
        senders = senders or ("contact",) * len(texts)
        binding = PostgresConversationBindingRepository(self.database_url).create_binding(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, channel="wechat",
            account_scope="synthetic-acceptance", conversation_locator=self.contact_external,
        )
        rows = []
        for index, (text, sender) in enumerate(zip(texts, senders, strict=True)):
            at = datetime.fromisoformat("2030-01-02T20:00:00+08:00") + timedelta(minutes=index)
            rows.append({"type": "message", "cursor": f"synthetic-cursor-{index + 1}", "message": {
                "id": {"local_id": index + 1, "server_id_str": f"synthetic-{index + 1}", "talker": self.contact_external},
                "text": text, "kind": "text", "sender": "合成用户" if sender == "self" else "合成联系人",
                "sender_wxid": self.owner_external if sender == "self" else self.contact_external,
                "is_from_me": sender == "self", "create_time": int(at.timestamp()),
                "time": at.strftime("%Y-%m-%d %H:%M:%S"), "time_iso": at.isoformat(),
            }})
        external = SimpleNamespace(returncode=0, stderr="", stdout="\n".join(json.dumps(row, ensure_ascii=False) for row in rows))
        tail = LocalWechatCli(runner=lambda command: external).tail(self.contact_external)
        receipts = []
        messages = normalize_cli_events(tail.events, processing_receipts=receipts)
        self.observations = PostgresObservationStore(self.database_url)
        self.observation = self.observations.record_batch_with_messages(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, binding_id=binding.binding_id,
            mode=ObservationMode.CLI_BACKGROUND, cli_version="synthetic-acceptance",
            conversation_locator=self.contact_external, last_local_id=tail.last_local_id,
            last_cursor=tail.cursor, record_count=len(messages), event_count=tail.event_count,
            non_text_count=tail.non_text_count, messages=messages, processing_records=tuple(receipts),
        )
        with psycopg.connect(self.database_url) as connection:
            self.task_id = PostgresBackgroundTaskRepository.create_observation_task(
                connection, owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, message_count=len(messages),
            )
        self.messages = load_contact_messages(self.scope, self.database_url)
        self.assertEqual(tuple(row.text for row in self.messages), tuple(texts))
        self.assertTrue(all(row.source_snapshots and all(item["processing_status"] == "recorded"
                            for item in row.source_snapshots) for row in self.messages))

    def run_cli(self, labels, proposal):
        self.requests = []

        def handle(transport, request):
            body = json.loads(request.content)
            self.requests.append(body)
            name = body["tools"][0]["function"]["name"]
            if name == "GroundedMemoryLabels":
                payload = {"units": labels}
            else:
                self.assertEqual(name, "SourceVerificationOutput")
                actual = json.loads(body["messages"][1]["content"])
                candidate, = actual["candidates"]
                payload = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": row["message_id"], "quote": row["text"]}
                                 for row in actual["messages"] if row["message_id"] in candidate["source_message_ids"]],
                    "proof": proposal(actual)}]}
            return httpx.Response(200, request=request, json={
                "id": "synthetic-acceptance", "object": "chat.completion", "created": 1, "model": "deepseek-flash",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": "", "tool_calls": [{"id": "synthetic-call", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(payload, ensure_ascii=False)}}]}}],
            })

        with patch.object(httpx.HTTPTransport, "handle_request", handle), redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as errors:
            code = worker_main(["--contact-id", str(self.scope.contact_id), "--task-id", str(self.task_id),
                                "--extraction-runtime-mode", "bounded-runtime-v1"])
        self.assertEqual(code, 0, output.getvalue() + errors.getvalue())
        task = PostgresBackgroundTaskRepository(self.database_url).get_task(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, task_id=self.task_id,
        )
        self.assertEqual(task.status.value, "succeeded")
        self.assertEqual(task.extraction_runtime_config.mode.value, "bounded-runtime-v1")
        self.assertEqual([row["tools"][0]["function"]["name"] for row in self.requests],
                         ["GroundedMemoryLabels", "SourceVerificationOutput"])
        traces = PostgresExtractionTraceStore(self.database_url)
        self.trace = traces.get_batch(self.scope, traces.list_batches(self.scope)[0]["trace_id"])
        self.events = {row["stage"]: row["payload"] for row in self.trace["events"]}
        self.assertEqual(self.events["grounded_draft"]["draft"], {"units": labels})
        self.assertEqual(self.events["grounded_compile"]["payloads"][0], self.events["candidate_raw"]["fields"])
        return self.pending()

    def pending(self):
        response = self.client.get(f"/api/contacts/{self.scope.contact_id}/memory-candidates", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        return response.json()["candidates"]

    def assert_current_basis(self, item, rule, capabilities=DIRECT_CAPABILITIES):
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["source_dependency_mode"], "all")
        self.assertTrue(item["dimension_evidence_source_current"])
        evidence = item["dimension_evidence"]
        self.assertEqual(evidence["version"], 4)
        self.assertEqual(evidence["target_message_ids"], [str(row.message_id) for row in self.messages])
        basis = evidence["semantic_basis"]
        self.assertEqual(basis["version"], 3)
        self.assertEqual(basis["rules"], [{"rule_id": rule, "rule_version": 1}])
        self.assertEqual(basis["capabilities"], capabilities)
        config = PostgresBackgroundTaskRepository(self.database_url).get_task(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, task_id=self.task_id,
        ).extraction_runtime_config
        self.assertEqual(basis["rule_set_sha256"], config.rule_set_sha256)
        states = item["dimension_evidence_dimensions"]
        self.assertEqual(set(states), DIMENSIONS)
        for dimension in ("subject", "time", "paraphrase", "reference", "media", "reported"):
            self.assertEqual(states[dimension]["state"], "valid", dimension)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        return basis

    def assert_observation_erased(self):
        self.observations.delete_observation(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                                             observation_id=self.observation.observation.observation_id)
        self.assertEqual(self.pending(), [])
        self.assertEqual(load_contact_messages(self.scope, self.database_url), ())

    def assert_unknown_basis(self, item):
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["source_dependency_mode"], "all")
        self.assertTrue(item["dimension_evidence_source_current"])
        self.assertIsNone(item["dimension_evidence"]["semantic_basis"])
        states = item["dimension_evidence_dimensions"]
        for name in ("subject", "time", "paraphrase", "reference", "reported"):
            self.assertEqual(states[name]["state"], "unknown", name)
        self.assertEqual(states["media"]["state"], "valid")

    def assert_full_trace(self):
        window = self.events["window"]
        self.assertEqual(window["target_message_ids"], [str(row.message_id) for row in self.messages])
        self.assertEqual([row["text"] for row in window["messages"]], [row.text for row in self.messages])
        self.assertEqual([row["message_id"] for row in window["messages"]], [str(row.message_id) for row in self.messages])

    def test_completed_answer_preserves_opposite_authors_destination_and_current_api(self):
        self.import_source(("你已到学校了吗？", "我已经到了。"), ("self", "contact"))
        item, = self.run_cli({"0:0": label("question", "self"),
                              "1:0": label("state", dependency="0:0")}, completed_question_proposal)
        basis = self.assert_current_basis(item, "BR_COMPLETED_QA_V1")
        self.assertEqual([atom["predicate"] for atom in basis["atoms"]], ["arrive"])
        self.assertEqual([role["kind"] for role in basis["roles"]], ["author", "school"])
        self.assertEqual([row["occurred_at"] for row in item["dimension_evidence"]["messages"]],
                         ["2030-01-02T20:00:00+08:00", "2030-01-02T20:01:00+08:00"])
        deletion = PostgresSourceDeletionRepository(self.database_url)
        result = deletion.delete_source(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                                        source_document_id=self.imported.source_document_id)
        self.assertEqual(result.outcome, "deleted")
        deletion.verify_deleted(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                                source_document_id=self.imported.source_document_id)
        self.assertEqual(self.pending(), [])

    def test_observed_author_arrival_has_current_six_dimension_evidence_but_stays_pending(self):
        self.observe_source(("我刚到家。",))
        item, = self.run_cli({"0:0": label("event")},
                            direct_proposal("BR_AUTHOR_ARRIVAL_V1", "direct_quote", "我刚到家。"))
        self.assert_current_basis(item, "BR_AUTHOR_ARRIVAL_V1")
        self.assert_observation_erased()

    def test_observed_cross_message_lend_keeps_explicit_property_owner(self):
        declaration = "这里的“她”指我哥。"
        main = "我姐昨天把她的书借给我了。"
        self.observe_source((declaration, main))
        item, = self.run_cli({"0:0": label("not_memory"),
                              "1:0": label("relationship_event", dependency="0:0")},
                            direct_proposal("BR_KIN_LEND_V1", "completed_cross", main, identity=(0, declaration)))
        basis = self.assert_current_basis(item, "BR_KIN_LEND_V1")
        roles = {role["role_id"]: role["kind"] for role in basis["roles"]}
        slots = basis["atoms"][0]["roles"]
        self.assertEqual((roles[slots["agent"]], roles[slots["property_owner"]], roles[slots["recipient"]]),
                         ("elder_sister", "elder_brother", "author"))
        self.assertEqual(set(item["source_ids"]), {str(row.message_id) for row in self.messages})
        self.assert_observation_erased()

    def test_observed_two_roles_keep_competition_catalog_in_complete_window(self):
        declaration = "这里的“她”指我哥。"
        main = "我姐昨天把她的雨伞借给我了。"
        self.observe_source(("这里提到我姐和我哥。", declaration, main))
        item, = self.run_cli({"0:0": label("not_memory"), "1:0": label("not_memory"),
                              "2:0": label("relationship_event", dependency="1:0")},
                            direct_proposal("BR_TWO_ROLES_V1", "completed_cross", main, identity=(1, declaration)))
        basis = self.assert_current_basis(item, "BR_TWO_ROLES_V1")
        self.assertEqual(len(basis["representation"]["source_full"]), 3)
        self.assertNotIn(str(self.messages[0].message_id), item["source_ids"])
        self.assertEqual(len(item["source_ids"]), 2)
        self.assert_observation_erased()

    def test_observed_reported_request_keeps_outer_history_and_inner_requested_action(self):
        self.assert_request_branch("reported_event", "reported_inline", "request")

    def test_observed_received_request_does_not_invent_acceptance_or_performance(self):
        self.assert_request_branch("relationship_event", "received_inline", "receive_request")

    def assert_request_branch(self, kind, variant, predicate):
        main, declaration = "我姐昨天让我明天帮她顶个班。", "这里的“她”指我同事。"
        self.observe_source((main + declaration,))
        item, = self.run_cli({"0:0": label(kind, dependency="0:1"), "0:1": label("not_memory")},
                            direct_proposal("BR_REQUEST_V1", variant, main, identity=(0, declaration), request=True))
        capabilities = ["reported_attribution" if name == "direct_attribution" else name for name in DIRECT_CAPABILITIES]
        basis = self.assert_current_basis(item, "BR_REQUEST_V1", capabilities)
        self.assertEqual([(atom["predicate"], atom["phase"]) for atom in basis["atoms"]],
                         [(predicate, "historical"), ("cover_shift", "requested")])
        self.assertIsNone(item["valid_at"])
        self.assertIsNone(item["invalid_at"])
        self.assertEqual([row["slot"] for row in basis["qualifiers"] if row["kind"] == "time"],
                         ["event_time", "requested_time"])
        self.assert_observation_erased()

    def test_observed_condition_quantity_plan_roundtrips_non_utc_calendar_interval(self):
        main = "如果天晴，我计划明天只跑约3公里。"
        self.observe_source((main,))
        item, = self.run_cli({"0:0": label("condition"), "0:1": label("plan")},
                            direct_proposal("BR_COND_RUN_V1", "conditional_plan", main, condition=True))
        basis = self.assert_current_basis(item, "BR_COND_RUN_V1")
        self.assertEqual([(row["predicate"], row["phase"]) for row in basis["atoms"]],
                         [("clear_weather", "condition"), ("run", "planned")])
        self.assertEqual([row["kind"] for row in basis["qualifiers"]], ["quantity", "degree", "degree", "condition", "time"])
        self.assertEqual([row["modifier"] for row in basis["qualifiers"] if row["kind"] == "degree"], ["only", "approx"])
        self.assertEqual(datetime.fromisoformat(item["valid_at"]), datetime.fromisoformat("2030-01-03T00:00:00+08:00"))
        self.assertEqual(datetime.fromisoformat(item["invalid_at"]), datetime.fromisoformat("2030-01-04T00:00:00+08:00"))
        self.assertEqual(item["dimension_evidence"]["messages"][0]["occurred_at"], "2030-01-02T20:00:00+08:00")
        self.assert_observation_erased()

    def test_supported_without_proposal_does_not_grant_five_semantic_dimensions(self):
        self.observe_source(("我刚到家。",))
        item, = self.run_cli({"0:0": label("event")}, lambda payload: None)
        self.assert_unknown_basis(item)
        self.assertEqual(item["dimension_evidence_dimensions"]["truth_intent"]["state"], "valid")

    def test_cross_author_identity_cannot_bind_the_speakers_relation(self):
        declaration, main = "这里的“她”指我哥。", "我姐昨天把她的书借给我了。"
        self.observe_source((declaration, main), ("self", "contact"))
        item, = self.run_cli({"0:0": label("not_memory", "self"),
                              "1:0": label("relationship_event", dependency="0:0")},
                            direct_proposal("BR_KIN_LEND_V1", "completed_cross", main, identity=(0, declaration)))
        self.assert_unknown_basis(item)
        self.assert_full_trace()

    def test_later_identity_does_not_retroactively_resolve_an_earlier_event(self):
        declaration, main = "这里的“她”指我哥。", "我姐昨天把她的书借给我了。"
        self.observe_source((main, declaration))
        item, = self.run_cli({"0:0": label("relationship_event", dependency="1:0"), "1:0": label("not_memory")},
                            direct_proposal("BR_KIN_LEND_V1", "completed_cross", main, main_index=0, identity=(1, declaration)))
        self.assert_unknown_basis(item)

    def test_competing_identity_is_not_hidden_by_a_single_selected_proposal(self):
        declaration, main = "这里的“她”指我哥。", "我姐昨天把她的书借给我了。"
        self.observe_source((declaration + "这里的“她”指我姐。", main))
        item, = self.run_cli({"0:0": label("not_memory"), "0:1": label("not_memory"),
                              "1:0": label("relationship_event", dependency="0:0")},
                            direct_proposal("BR_KIN_LEND_V1", "completed_cross", main, identity=(0, declaration)))
        self.assert_unknown_basis(item)
        self.assert_full_trace()

    def test_different_pronoun_cannot_borrow_an_explicit_identity(self):
        declaration, main = "这里的“他”指我哥。", "我姐昨天把她的书借给我了。"
        self.observe_source((declaration, main))
        item, = self.run_cli({"0:0": label("not_memory"),
                              "1:0": label("relationship_event", dependency="0:0")},
                            direct_proposal("BR_KIN_LEND_V1", "completed_cross", main, identity=(0, declaration), mention="她"))
        self.assert_unknown_basis(item)

    def test_model_role_anchor_does_not_replace_the_actual_identity_target(self):
        declaration, main = "这里的“她”指我哥。", "我姐昨天把她的书借给我了。"
        self.observe_source((declaration, main))
        correct = direct_proposal("BR_KIN_LEND_V1", "completed_cross", main, identity=(0, declaration))

        def swapped(payload):
            proof = correct(payload)
            proof["reference"][1]["target"] = {"message_id": payload["messages"][1]["message_id"], "start": 0, "end": 2}
            return proof

        item, = self.run_cli({"0:0": label("not_memory"),
                              "1:0": label("relationship_event", dependency="0:0")}, swapped)
        self.assert_unknown_basis(item)

    def test_uncovered_tail_is_not_dropped_from_the_actual_window(self):
        self.observe_source(("我刚到家。还有另一个独立主张。",))
        item, = self.run_cli({"0:0": label("event"), "0:1": label("not_memory")},
                            direct_proposal("BR_AUTHOR_ARRIVAL_V1", "direct_quote", "我刚到家。"))
        self.assert_unknown_basis(item)
        self.assert_full_trace()

    def assert_oversize_unknown(self, item):
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["source_dependency_mode"], "all")
        self.assertIsNone(item.get("dimension_evidence"))
        self.assertEqual(set(item["dimension_evidence_dimensions"]), DIMENSIONS)
        self.assertTrue(all(row == {"required": True, "state": "unknown", "reason": "not_proven"}
                            for row in item["dimension_evidence_dimensions"].values()))
        self.assert_full_trace()

    def test_five_actual_messages_keep_all_without_cropping_snapshot_or_targets(self):
        self.observe_source(("背景甲。", "背景乙。", "背景丙。", "背景丁。", "我刚到家。"))
        labels = {f"{index}:0": label("not_memory") for index in range(4)}
        item, = self.run_cli({**labels, "4:0": label("event")}, lambda payload: None)
        self.assert_oversize_unknown(item)
        self.assertEqual(item["source_ids"], [str(self.messages[-1].message_id)])

    def test_4097_message_codepoints_keep_entire_body_without_a_v4_snapshot(self):
        text = "我" + "合成" * 2048
        self.assertEqual(len(text), 4097)
        self.observe_source((text,))
        item, = self.run_cli({"0:0": label("event")}, lambda payload: None)
        self.assert_oversize_unknown(item)
        self.assertIn(text, item["text"])

    def test_only_candidate_wrapper_over_limit_also_keeps_whole_evidence_null(self):
        text = "合成" * 2045
        self.assertEqual(len(text), 4090)
        self.observe_source((text,))
        item, = self.run_cli({"0:0": label("event")}, lambda payload: None)
        self.assertGreater(len(item["text"]), 4096)
        self.assert_oversize_unknown(item)

    def assert_single_attempt_rejects_invalid_proof(self, labels):
        """仅执行一次真实领取；不改变或代测CLI原有跨attempt恢复策略。"""
        requests = []

        def handle(transport, request):
            body = json.loads(request.content)
            requests.append(body)
            name = body["tools"][0]["function"]["name"]
            if name == "GroundedMemoryLabels":
                payload = {"units": labels}
            else:
                self.assertEqual(name, "SourceVerificationOutput")
                actual = json.loads(body["messages"][1]["content"])
                candidate, = actual["candidates"]
                message = next(row for row in actual["messages"] if row["message_id"] in candidate["source_message_ids"])
                payload = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": message["message_id"], "quote": message["text"]}],
                    "proof": {"version": True, "atom_links": None, "reference": None, "reported": None}}]}
            return httpx.Response(200, request=request, json={
                "id": "synthetic-invalid-proof", "object": "chat.completion", "created": 1, "model": "deepseek-flash",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": "", "tool_calls": [{"id": "synthetic-call", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(payload, ensure_ascii=False)}}]}}],
            })

        repository = PostgresBackgroundTaskRepository(self.database_url)
        repository.configure_extraction_runtime(owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            task_id=self.task_id, config=runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1))
        with patch.object(httpx.HTTPTransport, "handle_request", handle):
            result = BackgroundTaskWorker(repository=repository,
                extraction_runner=PostgresMemoryExtractionRunner(self.database_url)).run_once(
                    owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, task_id=self.task_id, worker_id=uuid4())
        self.assertEqual(result.outcome, WorkerRunOutcome.RETRYABLE)
        self.assertEqual(result.attempt_count, 1)
        self.assertEqual(result.error_code, "memory_extraction_failed")
        self.assertEqual([row["tools"][0]["function"]["name"] for row in requests],
                         ["GroundedMemoryLabels", "SourceVerificationOutput"])
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        traces = PostgresExtractionTraceStore(self.database_url)
        self.trace = traces.get_batch(self.scope, traces.list_batches(self.scope)[0]["trace_id"])
        self.events = {row["stage"]: row["payload"] for row in self.trace["events"]}
        self.assertEqual(self.trace["status"], "model_failed")
        self.assertTrue(any(row["payload"].get("failure_kind") == "invalid_output" for row in self.trace["events"]))
        self.assertEqual(len(self.trace["calls"]), 2)
        self.assertTrue(all(row["provider_attempts"] == 1 for row in self.trace["calls"]))
        self.assert_full_trace()

    def test_invalid_proof_stops_the_actual_batch_without_an_extra_model_call(self):
        self.observe_source(("我刚到家。",))
        self.assert_single_attempt_rejects_invalid_proof({"0:0": label("event")})

    def test_oversize_unknown_branch_cannot_swallow_an_invalid_proof(self):
        self.observe_source(("背景甲。", "背景乙。", "背景丙。", "背景丁。", "我刚到家。"))
        labels = {f"{index}:0": label("not_memory") for index in range(4)}
        self.assert_single_attempt_rejects_invalid_proof({**labels, "4:0": label("event")})
