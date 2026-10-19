"""实际CLI及正式loader的自有隔离控制；SDK只接合成HTTP响应。"""

from __future__ import annotations

from contextlib import ExitStack, redirect_stdout, redirect_stderr
from datetime import datetime
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.ingest.normalizer import normalize_document
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.scopes import ContactScope
from notalone.tasks.command import worker_main
from notalone.tasks.models import ExtractionRuntimeMode


ROOT = Path(__file__).resolve().parents[3]


class RuntimeExecutionCliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database_name = f"notalone_runtime_execution_{uuid4().hex}_test"
        cls.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(cls.database_name)))
        cls.addClassCleanup(cls.drop_database)
        # 强制正式loader读到UTC，再核新模式是否仅凭活动来源恢复原偏移。
        cls.admin.execute(sql.SQL("ALTER DATABASE {} SET timezone TO 'UTC'").format(sql.Identifier(cls.database_name)))
        cls.database_url = make_conninfo("host=/tmp", dbname=cls.database_name)
        migrate(cls.database_url, ROOT / "database/migrations")

    @classmethod
    def drop_database(cls) -> None:
        try:
            cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))
            assert cls.admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s", (cls.database_name,)).fetchone() == (0,)
        finally:
            cls.admin.close()

    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        self.owner, self.contact = uuid4(), uuid4()
        self.owner_external = "wxid_synthetic_owner_" + self.owner.hex
        self.scope = ContactScope(self.owner, self.contact)
        guards.enter_context(patch.dict(os.environ, {
            "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.owner), "NOTALONE_DEEPSEEK_API_KEY": "synthetic-secret",
            "NOTALONE_DEEPSEEK_MODEL": "deepseek-flash", "NOTALONE_DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        }, clear=True))
        for obj, key in ((socket.socket, "connect"), (socket.socket, "connect_ex"), (socket, "getaddrinfo")):
            guards.enter_context(patch.object(obj, key, side_effect=AssertionError("禁止真实网络")))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成CLI用户')", (self.owner,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成CLI联系人')", (self.owner, self.contact))
            connection.execute("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES(%s,'wechat',%s,'合成用户')",
                               (self.owner, self.owner_external))
        with tempfile.TemporaryDirectory(prefix="notalone-runtime-input-") as directory:
            path = Path(directory) / "synthetic.jsonl"
            first = {
                "id": {"local_id": 1, "server_id_str": "synthetic-1", "talker": "wxid_synthetic_contact"},
                "create_time": int(datetime.fromisoformat("2026-10-17T20:00:00+08:00").timestamp()),
                "is_from_me": False, "kind": "text", "sender": "合成联系人", "sender_wxid": "wxid_synthetic_contact",
                "text": "我刚到家。", "time": "2026-10-17 20:00:00", "time_iso": "2026-10-17T20:00:00+08:00",
            }
            second = {**first, "id": {**first["id"], "local_id": 2, "server_id_str": "synthetic-2"},
                "is_from_me": True, "sender": "合成用户", "sender_wxid": self.owner_external, "text": "收到。",
                "create_time": int(datetime.fromisoformat("2026-10-17T20:01:00+08:00").timestamp()),
                "time": "2026-10-17 20:01:00", "time_iso": "2026-10-17T20:01:00+08:00"}
            path.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in (first, second)), encoding="utf-8")
            batch = normalize_document(read_jsonl(path))
        self.task_id = PostgresIngestRepository(self.database_url).import_document(
            owner_id=self.owner, document=batch,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact)),
        ).task_id

    def run_cli(self, mode: ExtractionRuntimeMode) -> list[dict]:
        message = load_contact_messages(self.scope, self.database_url)[0]
        self.assertEqual(message.occurred_at.isoformat(), "2026-10-17T12:00:00+00:00")
        requests = []

        def handle(transport, request):
            body = json.loads(request.content)
            requests.append(body)
            name = body["tools"][0]["function"]["name"]
            if name == "DirectMemoryExtractionOutput":
                from tests.unit.memory_extraction.test_command import _payload
                payload = {"scenes": [{"scene_name": "到家", "memories": [
                    {**_payload(message.message_id), "text": "联系人已到家。"}
                ]}]}
            elif name == "GroundedMemoryLabels":
                payload = {"units": {
                    "0:0": {"kind": "event", "subject": "contact", "topic": "other", "dependency": None,
                            "unresolved": False, "confidence": 0.95, "sensitivity": "none", "event": None},
                    "1:0": {"kind": "not_memory", "subject": "self", "topic": "other", "dependency": None,
                            "unresolved": False, "confidence": 0.95, "sensitivity": "none", "event": None},
                }}
            else:
                self.assertEqual(name, "SourceVerificationOutput")
                result = {"candidate_index": 0, "verdict": "supported", "issues": [],
                          "evidence": [{"message_id": str(message.message_id), "quote": message.text}]}
                if mode is ExtractionRuntimeMode.BOUNDED_RUNTIME_V1:
                    result["proof"] = None
                payload = {"results": [result]}
            return httpx.Response(200, request=request, json={
                "id": "synthetic-cli", "object": "chat.completion", "created": 1, "model": "deepseek-flash",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": "", "tool_calls": [{"id": "synthetic-call", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(payload, ensure_ascii=False)}}]}}],
            })

        with patch.object(httpx.HTTPTransport, "handle_request", handle), redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as errors:
            code = worker_main(["--contact-id", str(self.contact), "--task-id", str(self.task_id),
                                "--extraction-runtime-mode", mode.value])
        self.assertEqual(code, 0, output.getvalue() + errors.getvalue())
        task = PostgresBackgroundTaskRepository(self.database_url).get_task(
            owner_id=self.owner, contact_id=self.contact, task_id=self.task_id,
        )
        self.assertEqual(task.status.value, "succeeded")
        self.assertEqual(task.extraction_runtime_config.mode, mode)
        self.assertEqual([body["tools"][0]["function"]["name"] for body in requests],
                         ["DirectMemoryExtractionOutput" if mode is ExtractionRuntimeMode.LEGACY else "GroundedMemoryLabels",
                          "SourceVerificationOutput"])
        traces = PostgresExtractionTraceStore(self.database_url)
        detail = traces.get_batch(self.scope, traces.list_batches(self.scope)[0]["trace_id"])
        events = {item["stage"]: item["payload"] for item in detail["events"]}
        if mode is ExtractionRuntimeMode.BOUNDED_RUNTIME_V1:
            self.assertEqual(events["grounded_compile"]["payloads"][0], events["candidate_raw"]["fields"])
            self.assertEqual(events["grounded_draft"]["draft"]["units"]["0:0"]["kind"], "event")
        else:
            self.assertEqual(events["candidate_raw"]["fields"]["text"], "联系人已到家。")
            self.assertNotIn("grounded_compile", events)
        return requests

    def test_actual_cli_commits_explicit_legacy_and_preserves_utc_loader_time(self) -> None:
        requests = self.run_cli(ExtractionRuntimeMode.LEGACY)
        self.assertEqual(json.loads(requests[1]["messages"][1]["content"])["messages"][0]["occurred_at"],
                         "2026-10-17T12:00:00+00:00")

    def test_actual_cli_uses_saved_bounded_mode_and_recovers_source_local_offset(self) -> None:
        requests = self.run_cli(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        self.assertEqual(json.loads(requests[1]["messages"][1]["content"])["messages"][0]["occurred_at"],
                         "2026-10-17T20:00:00+08:00")
