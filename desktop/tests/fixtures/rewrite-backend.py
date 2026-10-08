"""桌面改写验收：随机 PG、真实生产装配与 HTTP，只替换外部模型。

联系人、来源和 active 绑定是本轮合成准备，不证明首用绑定 UI 或微信现场。
控制协议只存在于测试进程 stdin，不进入产品后端或已签名 App。
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from notalone.application.model_priority import ModelPriorityControl
from notalone.application.setup_service import SetupService
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.server.app import create_app
from notalone.server.connection_info import write_backend_info
from notalone.server.reply_wiring import build_reply_service
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, HttpBackend, ScriptedCoreModel, tool_response,
)


class DesktopRewriteModel(ScriptedCoreModel):
    plans: list[dict[str, Any]] = []
    payloads: list[dict[str, Any]] = []

    def __init__(self) -> None:
        super().__init__()
        self.plans = []
        self.payloads = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.wait_for_response()
        payload = next(
            json.loads(message.content) for message in messages
            if isinstance(message, HumanMessage)
        )
        self.payloads.append(payload)
        if not self.plans:
            raise AssertionError("桌面模型脚本耗尽，禁止外部调用。")
        plan = self.plans.pop(0)
        if plan.get("probe_history"):
            self.plans.insert(0, {**plan, "probe_history": False, "cite_history": True})
            self.responses.append(tool_response("conversation_search", {"query": "私密合成历史", "top_k": 8}))
            return super()._generate(messages, stop, run_manager, **kwargs)
        if plan.get("fault"):
            self.responses.append(AIMessage(content=""))
            self.seen_calls.append(messages)
            if plan["fault"] == "timeout":
                raise TimeoutError("本轮合成外部模型超时。")
            raise RuntimeError("合成原始模型错误不应进入界面。")
        draft = next(item for item in payload["evidence"] if item["kind"] == "user_draft")
        citations = [draft["evidence_id"]]
        if plan.get("cite_history"):
            result = next(json.loads(message.content) for message in messages
                          if isinstance(message, ToolMessage) and message.name == "conversation_search")
            if result.get("status") == "ok" and result.get("messages"):
                citations.append(result["messages"][0]["evidence_id"])
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{
                "text": f"{plan.get('prefix', '我会晚一点回复你')}（说法{number + 1}）。",
                "basis": "保留本次草稿的事实和承诺范围。",
                "citation_ids": citations,
                "risk_notes": plan.get("risk_notes", []),
            } for number in range(plan.get("count", 2))],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class DesktopRewriteFixture(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = DesktopRewriteModel

    def _backend(self, owner_id: UUID) -> HttpBackend:
        priority = ModelPriorityControl()
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.reply_model):
            reply_service = build_reply_service(
                database_url=self.database_url, owner_id=owner_id, model_priority=priority,
            )
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-desktop-{owner_id}", reply_service=reply_service,
            setup_service=SetupService(
                owner_directory=PostgresOwnerDirectory(self.database_url),
                env_path=Path(os.environ["NOTALONE_ENV_FILE"]),
            ), runtime_shutdown=priority.stop,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def prepare_contact(self, owner_id: UUID, name: str, marker: str) -> str:
        contact_id, source_id, message_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, %s)",
                (owner_id, contact_id, name),
            )
            connection.execute(
                """INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name, content_sha256, record_count
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1)""",
                (source_id, owner_id, contact_id, uuid4().hex * 2),
            )
            connection.execute(
                """INSERT INTO public.message (
                    id, owner_id, contact_id, speaker, message_type, text_content, occurred_at
                ) VALUES (%s, %s, %s, 'contact', 'text', %s, now())""",
                (message_id, owner_id, contact_id, marker),
            )
            connection.execute(
                """INSERT INTO public.message_source_ref (
                    message_id, owner_id, contact_id, source_kind,
                    source_document_id, source_locator, raw_payload
                ) VALUES (%s, %s, %s, 'source_document', %s, 'synthetic:1', '{}'::jsonb)""",
                (message_id, owner_id, contact_id, source_id),
            )
        self.bindings.create_binding(
            owner_id=owner_id, contact_id=contact_id, channel="wechat",
            account_scope=f"synthetic-account-{owner_id}",
            conversation_locator=f"wxid_synthetic_{contact_id}",
        )
        return str(contact_id)


def main() -> None:
    fixture = DesktopRewriteFixture()
    try:
        DesktopRewriteFixture.setUpClass()
        fixture.setUp()
        contact_ids = [
            fixture.prepare_contact(fixture.owner_id, "合成联系人甲", "甲的私密合成历史：今晚我会晚一点回复你。"),
            fixture.prepare_contact(fixture.owner_id, "合成联系人乙", "乙的私密合成历史：今晚我会晚一点回复你。"),
        ]
        other_contact_id = fixture.prepare_contact(
            fixture.other_owner_id, "另一用户的联系人", "另一用户的私密合成历史：今晚我会晚一点回复你。",
        )
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        print(json.dumps({"ready": {
            "database_url": fixture.database_url, "owner_id": str(fixture.owner_id),
            "contact_ids": contact_ids, "other_contact_id": other_contact_id,
        }}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
                result = {}
            elif operation == "hold":
                fixture.reply_model.pause_next_response()
                result = {}
            elif operation == "release":
                fixture._release_response_gates()
                result = {}
            elif operation == "observations":
                result = {"payloads": fixture.reply_model.payloads,
                          "tool_names": fixture.reply_model.bound_tool_names,
                          "outbound": [str(message.content) for messages in fixture.reply_model.seen_calls
                                       for message in messages]}
            elif operation == "revoke":
                binding = next(item for item in fixture.bindings.list_active_bindings(owner_id=fixture.owner_id)
                               if str(item.scope.contact_id) == command["contact_id"])
                fixture.bindings.revoke_binding(owner_id=fixture.owner_id,
                                               contact_id=binding.scope.contact_id, binding_id=binding.binding_id)
                result = {}
            elif operation == "restart":
                fixture.backend.close()
                fixture.backend = fixture._backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
                result = {}
            elif operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            else:
                raise ValueError("未知桌面夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        fixture.doCleanups()
        DesktopRewriteFixture.doClassCleanups()


if __name__ == "__main__":
    main()
