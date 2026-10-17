"""07 的公开 HTTP 夹具：正式回复装配，只替换外部模型。"""

from __future__ import annotations

import json
from unittest.mock import patch
from uuid import UUID, uuid4

from langchain_core.messages import HumanMessage, ToolMessage

from notalone.application.import_service import ImportService
from notalone.application.memory_service import MemoryService
from notalone.application.model_priority import ModelPriorityControl
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.fidelity_http_support import FidelityControlledModel
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend, ScriptedCoreModel, tool_response
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class OverviewReplyControlledModel(FidelityControlledModel):
    """引用实际模型输入的种类，脚本不接收概览正文或预期 ID。"""

    def wait_for_response(self) -> None:
        gate = self.response_gates.get(len(self.seen_calls))
        if gate is not None and not gate.wait(5):
            raise TimeoutError("合成回复模型暂停未解除。")

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(message.content) for message in messages if isinstance(message, HumanMessage))
        if self.plans and "history" in self.plans[0]:
            self.entered.set()
            self.wait_for_response()
            plan = self.plans.pop(0)["history"]
            self.payloads.append(payload)
            self.responses.append(tool_response(plan["name"], plan["args"]))
            return ScriptedCoreModel._generate(self, messages, stop, run_manager, **kwargs)
        if self.plans and self.plans[0].pop("cite_last_history", False):
            result = next(json.loads(message.content) for message in reversed(messages)
                          if isinstance(message, ToolMessage) and message.name in {"conversation_search", "conversation_query"})
            self.plans[0]["citation_ids"] = [item["evidence_id"] for item in result["messages"]]
        if self.plans and "cite_kinds" in self.plans[0]:
            plan = self.plans[0]
            kinds = set(plan.pop("cite_kinds"))
            plan["citation_ids"] = [item["evidence_id"] for item in payload["evidence"] if item["kind"] in kinds]
            if not plan["citation_ids"]:
                raise AssertionError("合成脚本要求的实际证据未进入模型输入。")
        return super()._generate(messages, stop, run_manager, **kwargs)


class OverviewReplyHttpFixture(MemoryOverviewHttpFixture):
    """沿公开初始化、导入、确认与既有 assistant/reply 端点生成。

    本夹具不创建数据库；调用方必须先绑定同一显式自有测试库，并应用正式
    连续迁移。继承的 import_contact/confirm 返回实际导入和确认身份。
    """

    def activate_replies(self, contact_id: str) -> None:
        if not hasattr(self, "reply_model"):
            self.reply_model = OverviewReplyControlledModel()
            self.addCleanup(lambda: [gate.set() for gate in self.reply_model.response_gates.values()])
        bindings = PostgresConversationBindingRepository(self.database_url)
        if not any(item.scope.contact_id == UUID(contact_id)
                   for item in bindings.list_active_bindings(owner_id=self.owner_id)):
            bindings.create_binding(
                owner_id=self.owner_id, contact_id=UUID(contact_id), channel="wechat",
                account_scope=f"synthetic-overview-reply-{self.owner_id}",
                conversation_locator=self.contact_locators[contact_id],
            )
        self.backend = self._backend(self.owner_id)

    def _backend(self, owner_id, *, overview_service=None, task_host=None, runtime_shutdown=None):
        if owner_id is None or not hasattr(self, "reply_model"):
            return super()._backend(owner_id, overview_service=overview_service, task_host=task_host,
                                    runtime_shutdown=runtime_shutdown)
        priority = ModelPriorityControl()
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.reply_model):
            service = build_reply_service(database_url=self.database_url, owner_id=owner_id,
                                          model_priority=priority, **getattr(self, "layered_reply_options", {}),
                                          **synthetic_budget_kwargs(self.reply_model, capacity=getattr(self, "reply_capacity", 100000)))
        self.assertIsNotNone(service)
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id, token="synthetic-overview-reply-token",
            setup_service=self.setup, import_service=ImportService(repository=PostgresIngestRepository(self.database_url)),
            memory_service=MemoryService(contact_memory=PostgresMemoryStore(self.database_url),
                                         owner_memory=PostgresOwnerMemoryStore(self.database_url)),
            reply_service=service, overview_service=overview_service, task_host=task_host,
            runtime_shutdown=priority.stop,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def reply_path(self, contact_id: str) -> str:
        status, session = self.backend.request(f"/api/contacts/{contact_id}/assistant-session/default", {}, method="POST")
        self.assertEqual(status, 200, session)
        return f"/api/contacts/{contact_id}/assistant-sessions/{session['session_id']}"

    def rewrite_body(self, contact_id: str, draft: str, *, key=None, include_context=True) -> dict:
        return {"idempotency_key": str(key or uuid4()), "contact_id": contact_id,
                "content": {"type": "rewrite_draft", "draft_text": draft,
                            "include_relationship_context": include_context}}

    def evidence_path(self, contact_id: str, turn: dict) -> str:
        return f"/api/contacts/{contact_id}/replies/{turn['reply_request_id']}/evidence"

    def manual_owner(self, text: str, *, category="common_fact") -> dict:
        status, result = self.backend.request("/api/memories/manual-owner", {"text": text, "category": category})
        self.assertEqual(status, 200, result)
        return result["memory"]

    def manual_contact(self, contact_id: str, text: str, *, category="common_fact") -> dict:
        status, result = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact_id, "text": text, "category": category,
        })
        self.assertEqual(status, 200, result)
        return result["memory"]
