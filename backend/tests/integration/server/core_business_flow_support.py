"""通过真实 HTTP 验收合成来源的导入、候选、重放、隔离与删除闭环。

每次运行自建并清理专用 PostgreSQL 测试库，应用正式迁移；只在模型
边界返回脚本化结果。桌面绑定为合成夹具，不读取微信或业务 .env。
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.runnables import Runnable

from notalone.application.import_service import ImportService, TaskHost
from notalone.application.memory_service import MemoryService
from notalone.application.model_priority import (
    ModelPriorityControl, PriorityAdjudicationRuntime, PriorityExtractionRuntime,
    PriorityReplyPort, PriorityVerificationRuntime,
)
from notalone.application.reply_service import ReplyService
from notalone.application.skill_service import LedgerService
from notalone.conversation.models import ConversationObservation
from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.contact_memory_index import PostgresContactMemoryIndexRepository
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.scopes import ContactScope
from notalone.server.app import BackendApp, BackendServer, create_app
from notalone.server.event_bus import EventBus
from notalone.server.event_models import BackendEvent
from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner


ROOT = Path(__file__).resolve().parents[3]


class ScriptedCoreModel(FakeMessagesListChatModel):
    """仅替代外部模型，保留实际 LangChain 模型与 Tool 循环协议。"""

    bound_tool_names: list[str] = []
    seen_calls: list[list[BaseMessage]] = []
    response_gates: dict[int, threading.Event] = {}

    def __init__(self) -> None:
        super().__init__(responses=[])
        self.bound_tool_names = []
        self.seen_calls = []
        self.response_gates = {}

    def pause_next_response(self) -> threading.Event:
        """在实际模型入口等待夹具准备，尚不消耗脚本或调用序号。"""

        gate = threading.Event()
        self.response_gates[len(self.seen_calls)] = gate
        return gate

    def wait_for_response(self) -> None:
        gate = self.response_gates.get(len(self.seen_calls))
        if gate is not None and not gate.wait(60):
            raise TimeoutError("合成模型响应未在时限内准备完成。")

    def bind_tools(
        self, tools: Sequence[Any], *, tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        del tool_choice, kwargs
        self.bound_tool_names = [
            item.get("title", item.get("name", ""))
            if isinstance(item, dict)
            else getattr(item, "name", getattr(item, "__name__", ""))
            for item in tools
        ]
        return self

    def _generate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager: Any = None, **kwargs: Any,
    ) -> Any:
        self.wait_for_response()
        if len(self.seen_calls) >= len(self.responses):
            raise AssertionError("核心验收模型脚本已耗尽，禁止额外调用。")
        self.i = len(self.seen_calls)
        self.seen_calls.append(messages)
        return super()._generate(messages, stop, run_manager, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return await asyncio.to_thread(
            self._generate, messages, stop, run_manager, **kwargs,
        )


def tool_response(name: str, args: dict[str, Any]) -> AIMessage:
    return AIMessage(content="", tool_calls=[{
        "name": name, "args": args, "id": f"synthetic-{uuid4()}",
    }])


class HttpBackend:
    """只通过回环 HTTP 操作后端；负责服务线程的生命周期。"""

    def __init__(self, app: BackendApp, owner_id: UUID) -> None:
        self.owner_id = owner_id
        self.token = app.token
        self.server = BackendServer(app, port=0)
        host, port = self.server.start()
        self.base_url = f"http://{host}:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)

    def request(
        self, path: str, body: dict[str, Any] | None = None,
        *, method: str | None = None, timeout: float = 10,
    ) -> tuple[int, dict[str, Any]]:
        request = Request(
            self.base_url + path,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            response = urlopen(request, timeout=timeout)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def events(self):
        return urlopen(Request(
            self.base_url + "/api/events",
            headers={"Authorization": f"Bearer {self.token}", "Connection": "close"},
        ), timeout=10)


class CoreBusinessFlowFixture:
    """数据库只负责迁移与夹具；所有业务结果均从公开 HTTP 观察。"""

    reply_model_factory = ScriptedCoreModel
    extraction_model_factory = ScriptedCoreModel
    production_model_wiring = False

    @classmethod
    def setUpClass(cls) -> None:
        cls.database_name = f"notalone_core_flow_{uuid4().hex}_test"
        cls.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        cls.addClassCleanup(cls.admin.close)
        cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(cls.database_name),
        ))
        cls.addClassCleanup(cls._drop_database)
        cls.database_url = f"host=/tmp dbname={cls.database_name}"
        env = dict(os.environ)
        env.update({
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_DATABASE_URL": cls.database_url,
        })
        migration = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations",
             str(ROOT / "database/migrations")],
            cwd=ROOT, env=env, text=True, capture_output=True, timeout=60,
        )
        if migration.returncode:
            raise RuntimeError(f"核心验收测试库迁移失败：{migration.stderr}")

    @classmethod
    def _drop_database(cls) -> None:
        cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
            sql.Identifier(cls.database_name),
        ))

    def setUp(self) -> None:
        self.owner_id, self.other_owner_id = uuid4(), uuid4()
        self.draft_evidence_id = uuid4()
        self.extraction_model = self.extraction_model_factory()
        self.reply_model = self.reply_model_factory()
        self.addCleanup(self._release_response_gates)
        self.bindings = PostgresConversationBindingRepository(self.database_url)
        self.lock_connections: list[psycopg.Connection] = []
        self.addCleanup(self._close_lock_connections)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        with psycopg.connect(self.database_url) as connection:
            for owner_id in (self.owner_id, self.other_owner_id):
                connection.execute(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (owner_id, "核心验收合成用户"),
                )
                connection.execute(
                    "INSERT INTO public.skill_library (owner_id, revision) VALUES (%s, 0)",
                    (owner_id,),
                )
        self.backend = self._backend(self.owner_id)
        self.other_backend = self._backend(self.other_owner_id)

    def _release_response_gates(self) -> None:
        for model in (self.extraction_model, self.reply_model):
            for gate in model.response_gates.values():
                gate.set()

    def _close_lock_connections(self) -> None:
        for connection in self.lock_connections:
            connection.close()

    def _backend(self, owner_id: UUID) -> HttpBackend:
        if self.production_model_wiring:
            return self._production_backend(owner_id)
        events = EventBus()
        priority = ModelPriorityControl()
        retrieval = PostgresRetrieval(
            self.database_url,
            owner_memory_store=PostgresOwnerMemoryStore(self.database_url),
        )
        ledger = PostgresOutboundLedger(self.database_url)
        extraction = PostgresMemoryExtractionRunner(
            self.database_url,
            runtime=PriorityExtractionRuntime(
                LangChainExtractionRuntime(model=self.extraction_model), priority,
            ),
            verification_runtime=PriorityVerificationRuntime(LangChainSourceVerificationRuntime(
                model=self.extraction_model, ledger=ledger, provider="synthetic",
            ), priority),
            adjudication_runtime=PriorityAdjudicationRuntime(
                LangChainAdjudicationRuntime(model=self.extraction_model), priority,
            ),
            ledger=ledger, provider="synthetic", model_name="scripted-core-test",
        )

        def lock_connection():
            connection = psycopg.connect(self.database_url, autocommit=True)
            self.lock_connections.append(connection)
            return connection

        def publish_progress(update):
            events.publish(BackendEvent.task_progress(
                scope=ContactScope(update.owner_id, update.contact_id),
                occurred_at=datetime.now(timezone.utc), task_id=update.task_id,
                step=update.step, status=update.status,
                processed_count=update.processed_count,
                attempt_count=update.attempt_count, retry_count=update.retry_count,
            ))

        def lookup(current_owner: UUID, contact_id: UUID):
            return next((
                binding.as_domain()
                for binding in self.bindings.list_active_bindings(owner_id=current_owner)
                if binding.scope.contact_id == contact_id
            ), None)

        generator = ReplyGenerator(
            store=PostgresReplyStore(self.database_url), ledger=ledger,
            runtime=LangChainReplyRuntime(
                model=self.reply_model, skill_port=PostgresSkillPort(self.database_url),
                retrieval=retrieval,
            ),
            context=RetrievalReplyContext(
                retrieval=retrieval, skill_library_revision=0,
                id_factory=lambda: self.draft_evidence_id,
                memory_index=PostgresContactMemoryIndexRepository(self.database_url),
            ),
        )
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-core-{owner_id}", events=events,
            import_service=ImportService(repository=PostgresIngestRepository(self.database_url)),
            task_host=TaskHost(
                worker_builder=lambda: BackgroundTaskWorker(
                    repository=PostgresBackgroundTaskRepository(self.database_url),
                    extraction_runner=extraction,
                    index_repository=PostgresContactMemoryIndexRepository(self.database_url),
                    model_priority=priority,
                ),
                lock_connection_builder=lock_connection, event_publisher=publish_progress,
                model_priority=priority,
                task_repository=PostgresBackgroundTaskRepository(self.database_url),
            ),
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(self.database_url),
                owner_memory=PostgresOwnerMemoryStore(self.database_url),
            ),
            reply_service=ReplyService(
                binding_lookup=lookup,
                conversation_factory=lambda binding: PostgresConversationPort(
                    self.database_url, owner_id=owner_id,
                    observation=ConversationObservation.confirmed(binding.binding_id),
                ),
                reply=PriorityReplyPort(generator, priority),
            ),
            runtime_shutdown=priority.stop,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def _production_backend(self, owner_id: UUID) -> HttpBackend:
        """装配实际 server builders，仅在外部模型构造边界替换。"""

        from notalone.server.command import _build_task_host
        from notalone.server.reply_wiring import build_reply_service

        priority, events = ModelPriorityControl(), EventBus()
        extraction_patch = patch(
            "notalone.memory_extraction.cli_support.build_deepseek_model",
            return_value=self.extraction_model,
        )
        extraction_patch.start()
        self.addCleanup(extraction_patch.stop)
        task_host = _build_task_host(self.database_url, events, model_priority=priority)
        with patch("notalone.server.reply_wiring.build_deepseek_model",
                   return_value=self.reply_model):
            reply_service = build_reply_service(
                database_url=self.database_url, owner_id=owner_id, model_priority=priority,
            )
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-core-{owner_id}", events=events,
            import_service=ImportService(repository=PostgresIngestRepository(self.database_url)),
            task_host=task_host, reply_service=reply_service,
            ledger_service=LedgerService(ledger=PostgresOutboundLedger(self.database_url)),
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(self.database_url),
                owner_memory=PostgresOwnerMemoryStore(self.database_url),
            ),
            runtime_shutdown=priority.stop,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def _get(self, backend: HttpBackend, path: str) -> dict[str, Any]:
        status, payload = backend.request(path)
        self.assertEqual(status, 200, payload)
        return payload

    def _import(
        self, backend: HttpBackend, label: str, tea: str,
        *, hold_model_response: bool = False,
    ) -> dict[str, Any]:
        path = Path(self.temporary.name) / f"synthetic-{label}.jsonl"
        owner_external = f"wxid_synthetic_{backend.token}"
        contact_external = f"wxid_synthetic_{uuid4().hex}"
        records = [{
            "id": {"local_id": number, "server_id_str": f"server-{number}",
                   "talker": contact_external},
            "create_time": 1786500000 + 60 * number,
            "is_from_me": from_me, "kind": "text",
            "sender": "合成用户" if from_me else f"合成联系人{label}",
            "sender_wxid": owner_external if from_me else contact_external,
            "text": text,
            "time": f"2026-08-12 10:0{number}:00",
            "time_iso": f"2026-08-12T10:0{number}:00+08:00",
        } for number, from_me, text in (
            (1, False, f"核心验收{label}：我平时喜欢{tea}。"),
            (2, True, "好的，我记下了。"),
            (3, False, f"核心验收{label}：一起聊聊{tea}？"),
        )]
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records),
                        encoding="utf-8")
        before = self._get(backend, "/api/contacts")["contacts"]
        status, preview = backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        self.assertTrue(preview["valid"])
        self.assertEqual(preview["record_count"], 3)
        self.assertEqual(self._get(backend, "/api/contacts")["contacts"], before)
        status, rejected = backend.request("/api/imports/commit", {"path": str(path)})
        self.assertEqual(status, 400, rejected)
        # 提交前先封住外部模型入口；真实导入、Worker 和存储仍照常执行。
        response_gate = self.extraction_model.pause_next_response()
        stream = None if hold_model_response else backend.events()
        if stream is not None:
            self.addCleanup(stream.close)
        status, imported = backend.request("/api/imports/commit", {
            "path": str(path), "new_contact_name": f"合成联系人{label}",
        })
        self.assertEqual(status, 200, imported)
        self.assertEqual(imported["imported_count"], 3)
        contact_id = imported["contact_id"]
        messages = self._get(backend, f"/api/contacts/{contact_id}/messages")["messages"]
        source = self._get(backend, f"/api/contacts/{contact_id}/sources")["sources"][0]
        self.assertEqual(len(messages), 3)
        self.assertEqual(source["status"], "active")
        task = self._get(backend, f"/api/tasks/status?contact_id={contact_id}"
                        f"&task_id={imported['task_id']}")
        self.assertIn(task["status"], {"queued", "running"}, task)
        self.assertEqual(self._get(backend, f"/api/contacts/{contact_id}/memories")["memories"], [])
        fact_message = next(item for item in messages if "我平时喜欢" in item["text"])
        target = next(item for item in messages if "一起聊聊" in item["text"])
        # 桌面会话只是已确认的合成夹具；渠道现场采集不属于本验收。
        self.bindings.create_binding(
            owner_id=backend.owner_id,
            contact_id=UUID(contact_id), channel="wechat",
            account_scope=f"synthetic-account-{backend.token}",
            conversation_locator=contact_external,
        )
        fact = {
            "text": f"联系人喜欢{tea}。", "category": "preference",
            "subject": "contact", "topic": "other",
            "source_message_ids": [fact_message["message_id"]],
            "confidence": 0.95, "risk_flags": [], "valid_at": None,
            "invalid_at": None, "speech_act": "assertion",
            "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "联系人直接陈述自己的口味。",
        }
        self.extraction_model.responses.extend([
            tool_response("MemoryExtractionOutput", {"facts": [fact]}),
            tool_response("SourceVerificationOutput", {"results": [{
                "candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": fact_message["message_id"],
                              "quote": f"我平时喜欢{tea}。"}],
            }]}),
        ])
        result = {"contact_id": contact_id, "task_id": imported["task_id"],
                  "source": source, "messages": messages, "target": target,
                  "fact_message": fact_message, "tea": tea,
                  "model_response_gate": response_gate}
        if not hold_model_response:
            response_gate.set()
            try:
                result["event_steps"] = self._read_import_events(backend, result, stream)
            finally:
                stream.close()
            self._wait_finished(backend, contact_id)
        return result

    def _start_import_worker(
        self, backend: HttpBackend, imported: dict[str, Any],
    ) -> tuple[int, dict[str, Any]]:
        """保留公开手动入口，允许与导入已经触发的原任务重合。"""

        response = backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        })
        self.assertEqual(response[0], 200, response)
        self.assertIn(response[1]["status"], {"started", "busy"}, response)
        imported["model_response_gate"].set()
        return response

    def _read_import_events(
        self, backend: HttpBackend, imported: dict[str, Any], stream: Any,
    ) -> list[str]:
        self.assertEqual(stream.status, 200)
        steps = []
        while len(steps) < 5:
            line = stream.readline()
            self.assertTrue(line, "HTTP SSE 在五步完成前结束。")
            if not line.startswith(b"data: "):
                continue
            event = json.loads(line.removeprefix(b"data: "))
            if event["contact_id"] != imported["contact_id"]:
                continue
            self.assertEqual(event["owner_id"], str(backend.owner_id))
            progress = event["payload"]
            self.assertEqual(event["type"], "task.progress")
            self.assertEqual(progress["task_id"], imported["task_id"])
            self.assertEqual(progress["status"], "succeeded", progress)
            steps.append(progress["step"])
        self.assertEqual(steps, ["parse", "normalize", "extract_memory", "index", "verify"])
        return steps

    def _run_import(self, backend: HttpBackend, imported: dict[str, Any]) -> None:
        contact_id = imported["contact_id"]
        self._wait_finished(backend, contact_id)
        self.assertEqual(imported["event_steps"],
                         ["parse", "normalize", "extract_memory", "index", "verify"])
        memories = self._get(backend, f"/api/contacts/{contact_id}/memories")["memories"]
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0]["text"], f"联系人喜欢{imported['tea']}。")
        self.assertEqual(memories[0]["adoption_method"], "auto")
        self.assertEqual(memories[0]["source_ids"], [imported["fact_message"]["message_id"]])
        imported["memory"] = memories[0]

    def _wait_finished(self, backend: HttpBackend, contact_id: str) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = self._get(backend, f"/api/tasks/status?contact_id={contact_id}")
            if state["status"] == "finished":
                self.assertEqual(state["progress"]["status"], "succeeded", state)
                return
            time.sleep(0.02)
        self.fail("导入 Worker 未在时限内完成。")

    def _reply(self, backend: HttpBackend, imported: dict[str, Any]) -> tuple[dict, dict]:
        self.reply_model.responses.extend([
            tool_response("conversation_search", {"query": "核心验收", "top_k": 8}),
            tool_response("ReplyRuntimeOutput", {
                "candidates": [{"text": f"好呀，我们聊聊{imported['tea']}。",
                                "basis": "回应当前消息并参考联系人明确表达的口味。",
                                "citation_ids": [imported["target"]["message_id"],
                                                 imported["memory"]["memory_id"]],
                                "risk_notes": []}], "used_skill_version_id": None,
            }),
        ])
        body = {"contact_id": imported["contact_id"], "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message",
                            "target_message_id": imported["target"]["message_id"],
                            "direction": f"自然回应，并结合对方对{imported['tea']}的偏好。"}}
        status, reply = backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, reply)
        self.assertEqual(len(reply["candidates"]), 1)
        evidence = self._get(backend, self._evidence_path(imported, reply))["evidence"]
        self.assertEqual({item["evidence_id"] for item in evidence},
                         {item["message_id"] for item in imported["messages"]}
                         | {imported["memory"]["memory_id"]})
        cited = {item["evidence_id"] for item in evidence if item["cited"]}
        self.assertEqual(cited, set(reply["candidates"][0]["citation_ids"]))
        self.assertTrue(any(item["kind"] == "confirmed_memory" and item["cited"]
                            for item in evidence))
        self.assertEqual(set(self.reply_model.bound_tool_names),
                         {"read_file", "conversation_search", "conversation_query", "ReplyRuntimeOutput"})
        tool_messages = [message for message in self.reply_model.seen_calls[-1]
                         if isinstance(message, ToolMessage) and message.name == "conversation_search"]
        self.assertEqual(len(tool_messages), 1)
        retrieved = json.loads(tool_messages[0].content)
        self.assertEqual(retrieved["status"], "ok")
        self.assertEqual({row["message_id"] for row in retrieved["messages"]},
                         {imported["target"]["message_id"], imported["fact_message"]["message_id"]})
        return body, reply

    @staticmethod
    def _evidence_path(imported: dict, reply: dict) -> str:
        return (f"/api/contacts/{imported['contact_id']}/replies/"
                f"{reply['reply_request_id']}/evidence")
