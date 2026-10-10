"""保真公开 HTTP 夹具；仅替换模型，使用正式生成装配与随机隔离 PG。"""

from __future__ import annotations

import json
import threading
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import HumanMessage

from notalone.application.memory_service import MemoryService
from notalone.application.model_priority import ModelPriorityControl
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, HttpBackend, ScriptedCoreModel, tool_response,
)
from tests.input_budget_support import synthetic_budget_kwargs


class FidelityControlledModel(ScriptedCoreModel):
    """脚本不接收期望／评分，保留实际框架输入及模型调用计量。"""

    plans: list[dict] = []
    payloads: list[dict] = []
    entered: threading.Event | None = None

    def __init__(self) -> None:
        super().__init__()
        self.plans, self.payloads = [], []
        self.entered = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.entered.set()
        self.wait_for_response()
        payload = next(json.loads(message.content) for message in messages
                       if isinstance(message, HumanMessage))
        self.payloads.append(payload)
        if not self.plans:
            raise AssertionError("合成脚本耗尽，禁止额外模型调用。")
        plan = self.plans.pop(0)
        primary = next(item for item in payload["evidence"]
                       if item["kind"] in {"user_draft", "user_purpose"} or
                       (item["kind"] == "message" and item["text"] == payload.get("current_text")))
        candidate = {"text": plan["text"], "basis": plan["basis"],
                     "citation_ids": plan.get("citation_ids", [primary["evidence_id"]]),
                     "risk_notes": plan.get("risk_notes", [])}
        if "messages" in plan:
            candidate["messages"] = plan["messages"]
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [candidate],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class FidelityHttpFixture(CoreBusinessFlowFixture):
    reply_model_factory = FidelityControlledModel
    dimension_release = None

    @classmethod
    def _drop_database(cls) -> None:
        super()._drop_database()
        remaining = cls.admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
                                      (cls.database_name,)).fetchone()[0]
        if remaining:
            raise RuntimeError("本轮保真测试库清理未确认。")

    def _backend(self, owner_id: UUID) -> HttpBackend:
        if self.production_model_wiring:
            return self._production_backend(owner_id)
        priority = ModelPriorityControl()
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.reply_model):
            reply = build_reply_service(database_url=self.database_url,
                                        owner_id=owner_id, model_priority=priority,
                                        **synthetic_budget_kwargs(self.reply_model))
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-fidelity-{owner_id}", reply_service=reply,
            memory_service=MemoryService(contact_memory=PostgresMemoryStore(self.database_url),
                                         owner_memory=PostgresOwnerMemoryStore(self.database_url)),
            runtime_shutdown=priority.stop,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def prepare_contact(self, owner_id: UUID, *, history: bool = True) -> tuple[str, str | None, str | None]:
        contact_id, source_id, message_id, target_id = uuid4(), uuid4(), uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES (%s,%s,'合成保真联系人')",
                               (contact_id, owner_id))
            if history:
                connection.execute("""INSERT INTO public.source_document
                    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                    VALUES (%s,%s,%s,'wechat_jsonl','synthetic-fidelity.jsonl',%s,2)""",
                                   (source_id, owner_id, contact_id, uuid4().hex * 2))
                connection.execute("""INSERT INTO public.message
                    (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                    VALUES (%s,%s,%s,'contact','text','合成旧聊天：我去年住在台北。','2025-01-01T00:00:00Z')""",
                                   (message_id, owner_id, contact_id))
                connection.execute("""INSERT INTO public.message_source_ref
                    (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                    VALUES (%s,%s,%s,'source_document',%s,'synthetic:1','{}'::jsonb)""",
                                   (message_id, owner_id, contact_id, source_id))
                connection.execute("""INSERT INTO public.message
                    (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                    VALUES (%s,%s,%s,'contact','text','合成当前邀请：今晚参加聚会吗？',now())""",
                                   (target_id, owner_id, contact_id))
                connection.execute("""INSERT INTO public.message_source_ref
                    (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                    VALUES (%s,%s,%s,'source_document',%s,'synthetic:2','{}'::jsonb)""",
                                   (target_id, owner_id, contact_id, source_id))
        self.bindings.create_binding(owner_id=owner_id, contact_id=contact_id,
                                     channel="wechat", account_scope=f"synthetic-{owner_id}",
                                     conversation_locator=f"synthetic-{contact_id}")
        return str(contact_id), str(target_id) if history else None, str(source_id) if history else None
