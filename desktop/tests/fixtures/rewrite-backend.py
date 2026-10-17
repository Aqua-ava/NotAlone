"""桌面改写验收：随机 PG、真实生产装配与 HTTP，只替换外部模型。

联系人、来源和 active 绑定是本轮合成准备，不证明首用绑定 UI 或微信现场。
控制协议只存在于测试进程 stdin，不进入产品后端或已签名 App。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
import httpx
from openai import BadRequestError
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from fixture_cleanup import bind_prepared_database, cleanup_fixture, database_ownership_path, verify_full_migrations

# 直接 App 入口在载入测试模块前绑定双 URL；runpy 包装器继续拥有其既有库。
PREPARED_DATABASE_NAME = bind_prepared_database() if __name__ == "__main__" else None

from notalone.application.model_priority import ModelPriorityControl
from notalone.application.memory_service import MemoryService
from notalone.application.setup_service import SetupService
from notalone.application.skill_service import LedgerService, SkillService
from notalone.application.task_service import TaskService
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.connection_info import write_backend_info
from notalone.server.reply_wiring import build_reply_service
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, HttpBackend, ScriptedCoreModel, tool_response,
)
from tests.input_budget_support import synthetic_budget_kwargs


class DesktopRewriteModel(ScriptedCoreModel):
    plans: list[dict[str, Any]] = []
    payloads: list[dict[str, Any]] = []
    entered: Any = None

    def __init__(self) -> None:
        super().__init__()
        self.plans = []
        self.payloads = []
        self.entered = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.entered.set()
        self.wait_for_response()
        payload = next(
            json.loads(message.content) for message in messages
            if isinstance(message, HumanMessage)
        )
        self.payloads.append(payload)
        if not self.plans:
            raise AssertionError("桌面模型脚本耗尽，禁止外部调用。")
        plan = self.plans.pop(0)
        if plan.get("provider_context_limit"):
            self.record_model_payload(messages, kwargs)
            self.seen_calls.append(messages)
            raise BadRequestError(
                "合成供应商私密错误正文不得回显。",
                response=httpx.Response(400, request=httpx.Request(
                    "POST", "https://synthetic.provider.invalid/chat/completions",
                )),
                body={"code": "context_length_exceeded", "message": "合成私密响应不得回显。"},
            )
        if plan.get("read_skill"):
            self.responses.append(tool_response("read_file", {
                "file_path": f"/notalone/reply-skills/{plan["read_skill"]}/SKILL.md",
            }))
            return super()._generate(messages, stop, run_manager, **kwargs)
        if plan.get("probe_history"):
            self.plans.insert(0, {**plan, "probe_history": False, "cite_history": True})
            self.responses.append(tool_response("conversation_search", {"query": plan.get("probe_query", "私密合成历史"), "top_k": 8}))
            return super()._generate(messages, stop, run_manager, **kwargs)
        if plan.get("fault"):
            self.responses.append(AIMessage(content=""))
            self.record_model_payload(messages, kwargs)
            self.seen_calls.append(messages)
            if plan["fault"] == "timeout":
                raise TimeoutError("本轮合成外部模型超时。")
            raise RuntimeError("合成原始模型错误不应进入界面。")
        if payload["input_mode"] == "direction_exploration":
            exploration = plan.get("explore", {})
            ids = [str(uuid4()) if exploration.get("invalid_evidence") else payload["evidence"][0]["evidence_id"]] if payload["evidence"] else []
            if exploration.get("cite_all"):
                ids = [item["evidence_id"] for item in payload["evidence"]]
            group = exploration.get("group", "")
            options = [
                {"label": "愿意等待", "intent": exploration.get("direction", f"表示愿意等待，但不增加承诺。{group}"),
                 "reason": "想留出时间时适用。", "citation_ids": ids, "recommended": bool(ids), "pause": False},
                {"label": "说明边界", "intent": exploration.get("direction", f"表示愿意等待，但不增加承诺。{group}") if exploration.get("same_stance") else f"说明今晚不继续等待，之后再联系。{group}",
                 "reason": "想说明时间边界时适用。", "citation_ids": [], "recommended": False, "pause": False},
                {"label": "暂不回应", "intent": f"暂不回应本次消息。{group}", "reason": "尚未想好时可以暂停。",
                 "citation_ids": [], "recommended": False, "pause": True},
            ]
            if "options" in exploration:
                options = [{"citation_ids": [], "recommended": False, "pause": False, **item}
                           for item in exploration["options"]]
            self.responses.append(tool_response("ExplorationOutput", {
                "understanding": exploration.get("understanding", "对方说明回复会晚一点。"),
                "ambiguities": exploration.get("ambiguities", []), "citation_ids": ids,
                "options": options, "question": exploration.get("question"),
                "current_step": "本次只说明意愿，不推进其他安排。", "tradeoffs": ["简短表达可能只推进当前一步。"],
            }))
            return super()._generate(messages, stop, run_manager, **kwargs)
        primary = next(item for item in payload["evidence"]
                       if (item["kind"] == "user_draft" if payload["input_mode"] == "rewrite_draft"
                           else item["kind"] == "user_purpose" if payload["input_mode"] == "initiate_conversation"
                           else item["kind"] == "message" and item["text"] == payload["current_text"]))
        citations = [primary["evidence_id"]]
        if plan.get("cite_pending"):
            citations.extend(item["evidence_id"] for item in payload["evidence"] if item["kind"] == "pending_candidate")
        if plan.get("cite_history"):
            result = next(json.loads(message.content) for message in messages
                          if isinstance(message, ToolMessage) and message.name == "conversation_search")
            if result.get("status") == "ok" and result.get("messages"):
                citations.append(result["messages"][0]["evidence_id"])
        candidates = [{
            "text": plan.get("text", f"{plan.get('prefix', '我会晚一点回复你')}（说法{number + 1}）。"),
            "basis": plan.get("basis", "保留本次草稿的事实和承诺范围。" if payload["input_mode"] == "rewrite_draft"
                              else "依据选中的消息，在本次明确方向内组织表达。"),
            "citation_ids": plan.get("citation_ids", citations),
            "risk_notes": plan.get("risk_notes", []),
        } for number in range(plan.get("count", 2))]
        if "message_groups" in plan:
            for candidate, parts in zip(candidates, plan["message_groups"], strict=True):
                candidate["messages"] = parts
                candidate["text"] = "\n\n".join(parts)
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": candidates, "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class DesktopRewriteFixture(CoreBusinessFlowFixture, unittest.TestCase):
    _prepared_database_name = PREPARED_DATABASE_NAME
    production_model_wiring = True
    reply_model_factory = DesktopRewriteModel
    dimension_release = None

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.migration_receipt = verify_full_migrations(cls.database_name, cls.database_url)

    def input_budget_configuration(self) -> dict[str, Any]:
        """默认合成协议不变，预算页面夹具仅覆盖显式能力配置。"""
        return synthetic_budget_kwargs(self.reply_model)

    def sync_control(self, owner_id):
        return None

    def _backend(self, owner_id: UUID) -> HttpBackend:
        priority = ModelPriorityControl()
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.reply_model):
            reply_service = build_reply_service(
                database_url=self.database_url, owner_id=owner_id, model_priority=priority,
                **self.input_budget_configuration(),
            )
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-desktop-{owner_id}", reply_service=reply_service,
            ledger_service=LedgerService(ledger=PostgresOutboundLedger(self.database_url)),
            skill_service=SkillService(management=PostgresSkillLibrary(self.database_url)),
            task_service=TaskService(repository=PostgresBackgroundTaskRepository(self.database_url)),
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(self.database_url),
                owner_memory=PostgresOwnerMemoryStore(self.database_url),
            ),
            setup_service=SetupService(
                owner_directory=PostgresOwnerDirectory(self.database_url),
                env_path=Path(os.environ["NOTALONE_ENV_FILE"]),
            ), runtime_shutdown=priority.stop, sync_control=self.sync_control(owner_id),
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

    def add_older_messages(self, contact_id: str) -> None:
        """本轮固定合成分页资料，不能指定其他 owner 或任意消息正文。"""
        with psycopg.connect(self.database_url) as connection:
            source_id = connection.execute(
                "SELECT id FROM public.source_document WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, UUID(contact_id)),
            ).fetchone()[0]
            for number in range(21):
                message_id = uuid4()
                connection.execute(
                    """INSERT INTO public.message (
                        id, owner_id, contact_id, speaker, message_type, text_content, occurred_at
                    ) VALUES (%s, %s, %s, 'contact', 'text', %s,
                              now() - (%s * interval '1 minute'))""",
                    (message_id, self.owner_id, UUID(contact_id), f"甲的较早合成消息 {number + 1:02d}", number + 1),
                )
                connection.execute(
                    """INSERT INTO public.message_source_ref (
                        message_id, owner_id, contact_id, source_kind, source_document_id,
                        source_locator, raw_payload
                    ) VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)""",
                    (message_id, self.owner_id, UUID(contact_id), source_id, f"synthetic:older:{number + 1}"),
                )


    def prepare_strategy_skills(self, contact_ids: list[str], other_contact_id: str) -> dict[str, Any]:
        """通过原Skill Library导入合成包；只把范围设为本轮已准备的联系人。"""
        directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent / "synthetic-skills"
        library = PostgresSkillLibrary(self.database_url)
        prepared = []
        for label, owner, contact, versions in (
            ("first", self.owner_id, contact_ids[0], 1),
            ("second", self.owner_id, contact_ids[0], 2),
            ("other_contact", self.owner_id, contact_ids[1], 1),
            ("other_owner", self.other_owner_id, other_contact_id, 1),
        ):
            name = f"synthetic-strategy-{label.replace('_', '-')}-{uuid4().hex[:8]}"
            package = directory / name
            package.mkdir(parents=True)
            for number in range(1, versions + 1):
                marker = f"合成静态Skill:{label}:v{number}。只辅助本次理解，保留用户意愿，不新增约定。"
                content = f"---\nname: {name}\ndescription: 合成关系沟通策略，仅用于受控验证。\n---\n\n{marker}\n"
                (package / "SKILL.md").write_text(content, encoding="utf-8")
                result = (library.import_package(owner, package) if number == 1
                          else library.update_package(owner, package))
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.reply_skill SET contact_id=%s WHERE id=%s AND owner_id=%s",
                                   (UUID(contact), result.skill_id, owner))
            prepared.append({"label": label, "skill_id": str(result.skill_id), "version_id": str(result.version_id),
                             "name": name, "version_number": versions, "marker": marker})
        return {"skills": prepared}

    def prepare_direction_dependency(self, contact_id: str) -> dict[str, str]:
        """固定合成旧目标与独立相邻来源，置于生成器近期50条之外。"""
        contact = UUID(contact_id)
        target_source, adjacent_source = uuid4(), uuid4()
        target_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            recent_source = connection.execute(
                "SELECT id FROM public.source_document WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, contact),
            ).fetchone()[0]
            for source in (target_source, adjacent_source):
                connection.execute(
                    """INSERT INTO public.source_document (
                        id, owner_id, contact_id, source_type, file_name, content_sha256, record_count
                    ) VALUES (%s, %s, %s, 'wechat_jsonl', 'strategy-synthetic.jsonl', %s, 1)""",
                    (source, self.owner_id, contact, uuid4().hex * 2),
                )
            rows = [(uuid4(), recent_source, f"用于分页的合成近期消息 {n:02d}", n)
                    for n in range(1, 56)]
            rows.extend([(target_id, target_source, "合成较早的回应目标", 100),
                         (uuid4(), adjacent_source, "合成相邻来源隐私标记", 99)])
            for message_id, source, text, minutes in rows:
                connection.execute(
                    """INSERT INTO public.message (
                        id, owner_id, contact_id, speaker, message_type, text_content, occurred_at
                    ) VALUES (%s, %s, %s, 'contact', 'text', %s,
                              now() - (%s * interval '1 minute'))""",
                    (message_id, self.owner_id, contact, text, minutes),
                )
                connection.execute(
                    """INSERT INTO public.message_source_ref (
                        message_id, owner_id, contact_id, source_kind, source_document_id,
                        source_locator, raw_payload
                    ) VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)""",
                    (message_id, self.owner_id, contact, source, f"synthetic:strategy:{minutes}"),
                )
        return {"target_id": str(target_id), "target_source": str(target_source), "adjacent_source": str(adjacent_source)}

    def shift_direction_dependency(self, contact_id: str, target_source: str) -> None:
        """固定合成消息移出旧相邻来源，观察保留意愿的删除依赖。"""
        with psycopg.connect(self.database_url) as connection:
            for number in range(3):
                message_id = uuid4()
                connection.execute(
                    """INSERT INTO public.message (
                        id, owner_id, contact_id, speaker, message_type, text_content, occurred_at
                    ) VALUES (%s, %s, %s, 'contact', 'text', %s,
                              now() - interval '100 minutes' + (%s * interval '5 seconds'))""",
                    (message_id, self.owner_id, UUID(contact_id), f"合成新增近邻消息 {number + 1}", number + 1),
                )
                connection.execute(
                    """INSERT INTO public.message_source_ref (
                        message_id, owner_id, contact_id, source_kind, source_document_id,
                        source_locator, raw_payload
                    ) VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)""",
                    (message_id, self.owner_id, UUID(contact_id), UUID(target_source), f"synthetic:shift:{number + 1}"),
                )

    def reply_privacy_counts(self, contact_id: str) -> dict[str, int]:
        """只观察本轮合成联系人计数，不输出原始请求正文。"""
        with psycopg.connect(self.database_url) as connection:
            total, sensitive, failed = connection.execute(
                """SELECT count(*),
                    count(*) FILTER (WHERE normalized_input LIKE '%%合成%%'),
                    count(*) FILTER (WHERE state='failed')
                FROM public.reply_request WHERE owner_id=%s AND contact_id=%s""",
                (self.owner_id, UUID(contact_id)),
            ).fetchone()
        return {"total": total, "sensitive": sensitive, "failed": failed}


def main() -> None:
    fixture = DesktopRewriteFixture()
    DesktopRewriteFixture._database_ownership_path = database_ownership_path()
    try:
        DesktopRewriteFixture.setUpClass()
        os.environ.update({"NOTALONE_DATABASE_URL": fixture.database_url,
                           "NOTALONE_TEST_DATABASE_URL": fixture.database_url})
        fixture.setUp()
        contact_ids = [
            fixture.prepare_contact(fixture.owner_id, "合成联系人甲", "甲的私密合成历史：今晚我会晚一点回复你。"),
            fixture.prepare_contact(fixture.owner_id, "合成联系人乙", "乙的私密合成历史：今晚我会晚一点回复你。"),
        ]
        other_contact_id = fixture.prepare_contact(
            fixture.other_owner_id, "另一用户的联系人", "另一用户的私密合成历史：今晚我会晚一点回复你。",
        )
        empty_contact_id = uuid4()
        historical_basis = None
        with psycopg.connect(fixture.database_url) as connection:
            connection.execute("INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s,%s,%s)",
                               (fixture.owner_id, empty_contact_id, "无消息的合成联系人"))
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        print(json.dumps({"ready": {
            "database_url": fixture.database_url, "owner_id": str(fixture.owner_id),
            "contact_ids": contact_ids, "other_contact_id": other_contact_id,
            "empty_contact_id": str(empty_contact_id),
            **fixture.migration_receipt,
        }}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
                result = {}
            elif operation == "hold":
                fixture.reply_model.entered.clear()
                fixture.reply_model.pause_next_response()
                result = {}
            elif operation == "release":
                fixture._release_response_gates()
                result = {}
            elif operation == "observations":
                result = {"payloads": fixture.reply_model.payloads,
                          "skill_reads": [[str(message.content) for message in messages
                                           if isinstance(message, ToolMessage) and message.name == "read_file"]
                                          for messages in fixture.reply_model.seen_calls],
                          "model_entered": fixture.reply_model.entered.is_set(),
                          "tool_names": fixture.reply_model.bound_tool_names,
                          "outbound": [str(message.content) for messages in fixture.reply_model.seen_calls
                                       for message in messages],
                          "outbound_calls": [[str(message.content) for message in messages]
                                             for messages in fixture.reply_model.seen_calls]}
            elif operation == "read_group_as_other_owner":
                # 同一实际组路径，仅更换为夹具已有的另一owner认证，不拼接错误联系人。
                session_id, candidate_id = UUID(command["session_id"]), UUID(command["candidate_id"])
                status, data = fixture.other_backend.request(
                    f"/api/contacts/{contact_ids[0]}/assistant-sessions/{session_id}"
                    f"/candidates/{candidate_id}/versions?page=0", timeout=5,
                )
                result = {"status": status, "data": data}
            elif operation == "revoke":
                binding = next(item for item in fixture.bindings.list_active_bindings(owner_id=fixture.owner_id)
                               if str(item.scope.contact_id) == command["contact_id"])
                fixture.bindings.revoke_binding(owner_id=fixture.owner_id,
                                               contact_id=binding.scope.contact_id, binding_id=binding.binding_id)
                result = {}
            elif operation == "older_messages":
                fixture.add_older_messages(contact_ids[0])
                result = {}
            elif operation == "direction_dependency":
                result = fixture.prepare_direction_dependency(contact_ids[0])
            elif operation == "memory_current_status":
                from memory_current_status_fixture import prepare_memory_current_status
                result = prepare_memory_current_status(fixture, contact_ids[0])
            elif operation == "historical_basis_prepare":
                from historical_reply_basis_fixture import prepare_historical_reply_basis
                historical_basis = prepare_historical_reply_basis(fixture, contact_ids[0], command["kind"])
                result = historical_basis
            elif operation == "historical_basis_expire":
                from historical_reply_basis_fixture import expire_historical_reply_basis
                if historical_basis is None:
                    raise ValueError("本轮尚未准备合成历史依据。")
                result = expire_historical_reply_basis(fixture, historical_basis)
            elif operation == "shift_direction_dependency":
                fixture.shift_direction_dependency(contact_ids[0], command["target_source"])
                result = {}
            elif operation == "reply_privacy_counts":
                result = fixture.reply_privacy_counts(contact_ids[0])
            elif operation == "age_exploration":
                with psycopg.connect(fixture.database_url) as connection:
                    connection.execute("UPDATE public.reply_exploration SET created_at=created_at-(%s*interval '1 second'), root_created_at=root_created_at-(%s*interval '1 second') WHERE owner_id=%s",
                                       (command["seconds"], command["seconds"], fixture.owner_id))
                result = {}
            elif operation == "fidelity_history":
                # 固定合成资料；仅调整本夹具甲的消息并确认本夹具空联系人绑定。
                with psycopg.connect(fixture.database_url) as connection:
                    source_id = connection.execute(
                        "SELECT id FROM public.source_document WHERE owner_id=%s AND contact_id=%s",
                        (fixture.owner_id, UUID(contact_ids[0])),
                    ).fetchone()[0]
                    connection.execute("""UPDATE public.message SET text_content='合成旧聊天：我去年住在台北。',
                        occurred_at='2025-01-01T00:00:00Z' WHERE owner_id=%s AND contact_id=%s""",
                                       (fixture.owner_id, UUID(contact_ids[0])))
                    target_id = uuid4()
                    connection.execute("""INSERT INTO public.message
                        (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                        VALUES (%s,%s,%s,'contact','text','合成当前邀请：今晚参加聚会吗？',now())""",
                                       (target_id, fixture.owner_id, UUID(contact_ids[0])))
                    connection.execute("""INSERT INTO public.message_source_ref
                        (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                        VALUES (%s,%s,%s,'source_document',%s,'synthetic:fidelity:2','{}'::jsonb)""",
                                       (target_id, fixture.owner_id, UUID(contact_ids[0]), source_id))
                fixture.bindings.create_binding(owner_id=fixture.owner_id, contact_id=empty_contact_id,
                    channel="wechat", account_scope=f"synthetic-account-{fixture.owner_id}",
                    conversation_locator=f"wxid_synthetic_{empty_contact_id}")
                result = {}
            elif operation == "strategy_skills":
                result = fixture.prepare_strategy_skills(contact_ids, other_contact_id)
            elif operation == "strategy_pending":
                with psycopg.connect(fixture.database_url) as connection:
                    source_id = connection.execute("SELECT id FROM public.source_document WHERE owner_id=%s AND contact_id=%s", (fixture.owner_id, UUID(contact_ids[0]))).fetchone()[0]
                pending = PostgresMemoryStore(fixture.database_url).create_candidate(MemoryCandidate(
                    candidate_id=uuid4(), scope=ContactScope(fixture.owner_id, UUID(contact_ids[0])),
                    text="合成近况：对方可能正在忙。", category=MemoryCategory.RECENT_STATE,
                    source_ids=(source_id,), confidence=0.8,
                ))
                result = {"candidate_id": str(pending.candidate_id), "source_id": str(source_id)}
            elif operation == "strategy_many_sources":
                # 固定21个同联系人合成来源，验证完整来源身份不受引用条数预算截断。
                source_ids = tuple(uuid4() for _ in range(21))
                scope = ContactScope(fixture.owner_id, UUID(contact_ids[0]))
                with psycopg.connect(fixture.database_url) as connection:
                    for source_id in source_ids:
                        connection.execute(
                            "INSERT INTO public.source_document "
                            "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                            "VALUES (%s,%s,%s,'wechat_jsonl','multi-source-synthetic.jsonl',%s,0)",
                            (source_id, scope.owner_id, scope.contact_id, uuid4().hex * 2),
                        )
                store = PostgresMemoryStore(fixture.database_url)
                candidate = store.create_candidate(MemoryCandidate(
                    candidate_id=uuid4(), scope=scope, text="合成已确认资料带完整的二十一个来源。",
                    category=MemoryCategory.RECENT_STATE, source_ids=source_ids,
                ))
                memory = store.confirm(scope=scope, candidate_id=candidate.candidate_id,
                                       adoption_method=AdoptionMethod.MANUAL)
                result = {"memory_id": str(memory.memory_id), "source_ids": [str(item) for item in source_ids]}
            elif operation == "unrelated_source":
                source_id = uuid4()
                with psycopg.connect(fixture.database_url) as connection:
                    connection.execute(
                        "INSERT INTO public.source_document "
                        "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                        "VALUES (%s, %s, %s, 'wechat_jsonl', 'unrelated-synthetic.jsonl', %s, 0)",
                        (source_id, fixture.owner_id, UUID(contact_ids[0]), uuid4().hex * 2),
                    )
                result = {"source_id": str(source_id)}
            elif operation == "withdraw_target_source":
                with psycopg.connect(fixture.database_url) as connection:
                    connection.execute(
                        "UPDATE public.source_document SET status='delete_requested' "
                        "WHERE owner_id=%s AND contact_id=%s AND status='active'",
                        (fixture.owner_id, UUID(contact_ids[0])),
                    )
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
        cleanup_fixture(fixture)


if __name__ == "__main__":
    main()
