"""经真实 HTTP 与合成 PostgreSQL 验证助手会话删除，不读取私人资料。"""

from __future__ import annotations

import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate
from notalone.application.memory_service import MemoryService
from notalone.application.reply_service import ReplyService
from notalone.conversation.models import ConversationObservation
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import (
    HttpBackend,
    ScriptedCoreModel,
    tool_response,
)
from tests.input_budget_support import synthetic_budget_kwargs


INSTANCE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
ROOT = Path(__file__).resolve().parents[3]


class DeletionScriptedModel(ScriptedCoreModel):
    """在外部模型边界控制返回时机，不替换业务控制器或存储。"""

    response_entered: object = None

    def __init__(self) -> None:
        super().__init__()
        self.response_entered = threading.Event()

    def wait_for_response(self) -> None:
        if len(self.seen_calls) in self.response_gates:
            self.response_entered.set()
        super().wait_for_response()


class AssistantSessionDeletionHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not INSTANCE_URL:
            raise unittest.SkipTest("必须显式指定隔离 PostgreSQL 测试库。")
        with psycopg.connect(INSTANCE_URL) as connection:
            database_name = connection.execute("SELECT current_database()").fetchone()[0]
        if not database_name.endswith("_test"):
            raise RuntimeError("会话删除验证只允许隔离 _test 数据库。")
        cls.database_name = f"notalone_session_delete_{uuid4().hex}_test"
        cls.database_url = make_conninfo(INSTANCE_URL, dbname=cls.database_name)
        cls.admin = psycopg.connect(INSTANCE_URL, dbname="postgres", autocommit=True)
        cls.addClassCleanup(cls.admin.close)
        cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
            sql.Identifier(cls.database_name),
        ))
        cls.addClassCleanup(cls._drop_database)
        migrate(cls.database_url, ROOT / "database/migrations")

    @classmethod
    def _drop_database(cls) -> None:
        cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
            sql.Identifier(cls.database_name),
        ))

    def setUp(self) -> None:
        self.owner_id, self.contact_id, self.other_contact_id = uuid4(), uuid4(), uuid4()
        self.draft_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成删除用户')",
                (self.owner_id,),
            )
            for contact_id in (self.contact_id, self.other_contact_id):
                connection.execute(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, '同名合成联系人')",
                    (self.owner_id, contact_id),
                )
            connection.execute(
                "INSERT INTO public.skill_library (owner_id, revision) VALUES (%s, 0)",
                (self.owner_id,),
            )
        self.addCleanup(self._clean_owner)
        self.bindings = PostgresConversationBindingRepository(self.database_url)
        self.binding = self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-session-delete",
            conversation_locator=f"synthetic-{uuid4()}",
        )
        self.model = DeletionScriptedModel()
        self.model.responses = [self._candidate("好的，明天见。")]
        retrieval = PostgresRetrieval(
            self.database_url, memory_store=PostgresMemoryStore(self.database_url),
            owner_memory_store=PostgresOwnerMemoryStore(self.database_url),
        )
        self.reply_service = ReplyService(
            binding_lookup=lambda owner_id, contact_id: next((
                binding.as_domain()
                for binding in self.bindings.list_active_bindings(owner_id=owner_id)
                if binding.scope.contact_id == contact_id
            ), None),
            conversation_factory=lambda binding: PostgresConversationPort(
                self.database_url, owner_id=self.owner_id,
                observation=ConversationObservation.confirmed(binding.binding_id),
            ),
            reply=ReplyGenerator(
                store=PostgresReplyStore(self.database_url),
                context=RetrievalReplyContext(
                    retrieval=retrieval, skill_library_revision=0,
                    id_factory=lambda: self.draft_id,
                ),
                runtime=LangChainReplyRuntime(
                    model=self.model, skill_port=PostgresSkillPort(self.database_url),
                    retrieval=retrieval,
                    **synthetic_budget_kwargs(self.model),
                ),
            ),
        )
        self.backend = self._backend()

    def _candidate(self, text: str, *citation_ids: str):
        return tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": text, "basis": "保留本次合成草稿原意。",
                            "citation_ids": list(citation_ids) or [str(self.draft_id)], "risk_notes": []}],
            "used_skill_version_id": None,
        })

    def _backend(self, *, owner_id: UUID | None = None) -> HttpBackend:
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id or self.owner_id,
            token="synthetic-assistant-session-delete-token",
            reply_service=self.reply_service,
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(self.database_url),
                owner_memory=PostgresOwnerMemoryStore(self.database_url),
            ),
        ), owner_id or self.owner_id)
        self.addCleanup(backend.close)
        return backend

    def _clean_owner(self, owner_id: UUID | None = None) -> None:
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.owner WHERE id = %s", (owner_id or self.owner_id,))

    def _default(self, *, contact_id: UUID | None = None) -> str:
        status, result = self.backend.request(
            f"/api/contacts/{contact_id or self.contact_id}/assistant-session/default",
            {}, method="POST",
        )
        self.assertEqual(status, 200, result)
        return result["session_id"]

    def _path(self, session_id: str, *, contact_id: UUID | None = None) -> str:
        return f"/api/contacts/{contact_id or self.contact_id}/assistant-sessions/{session_id}"

    def _body(self, *, key: UUID | None = None, draft: str = "明天见") -> dict:
        return {
            "idempotency_key": str(key or uuid4()), "contact_id": str(self.contact_id),
            "content": {"type": "rewrite_draft", "draft_text": draft},
        }

    def _database_fault(self, table: str, operation: str):
        row = {"INSERT": "NEW", "DELETE": "OLD"}[operation]
        name = f"synthetic_session_delete_fault_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS "
                "'BEGIN RAISE EXCEPTION ''synthetic_delete_failure''; END;'"
            ).format(name=sql.Identifier(name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {name} BEFORE {operation} ON public.{table} "
                "FOR EACH ROW WHEN ({row}.owner_id = {owner}::uuid) "
                "EXECUTE FUNCTION public.{name}()"
            ).format(name=sql.Identifier(name), operation=sql.SQL(operation),
                     table=sql.Identifier(table), row=sql.SQL(row), owner=sql.Literal(str(self.owner_id))))

        def remove_fault() -> None:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER IF EXISTS {name} ON public.{table}").format(
                    name=sql.Identifier(name), table=sql.Identifier(table),
                ))
                connection.execute(sql.SQL("DROP FUNCTION IF EXISTS public.{name}()").format(
                    name=sql.Identifier(name),
                ))
        self.addCleanup(remove_fault)
        return remove_fault

    def _source_message(self) -> tuple[str, str]:
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1)",
                (source_id, self.owner_id, self.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message "
                "(id, owner_id, contact_id, speaker, message_type, text_content, occurred_at) "
                "VALUES (%s, %s, %s, 'contact', 'text', '明天合成活动再确认？', now())",
                (message_id, self.owner_id, self.contact_id),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, 'synthetic-1', '{}'::jsonb)",
                (message_id, self.owner_id, self.contact_id, source_id),
            )
        return str(source_id), str(message_id)

    def _independent_session(self) -> str:
        # 10 的新开入口尚未交付，只准备第二会话身份；生成、删除与重读仍经真实 HTTP。
        session_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.assistant_session (id, owner_id, contact_id, is_default) "
                "VALUES (%s, %s, %s, FALSE)",
                (session_id, self.owner_id, self.contact_id),
            )
        return str(session_id)

    def test_confirmed_delete_cannot_be_read_or_recovered_as_default(self) -> None:
        session_id = self._default()
        path = self._path(session_id)
        status, turn = self.backend.request(path + "/replies", self._body())
        self.assertEqual(status, 200, turn)
        self.assertEqual(len(self.backend.request(path)[1]["turns"]), 1)

        self.assertEqual(
            self.backend.request(path, {"confirmed": True}, method="DELETE"),
            (200, {"session_id": session_id, "state": "deleted"}),
        )
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        self.assertNotEqual(self._default(), session_id)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_deleted_request_key_cannot_recreate_discussion_in_new_session(self) -> None:
        session_id = self._default()
        path = self._path(session_id)
        body = self._body(draft="这段合成讨论必须清除")
        status, reply = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)
        status, global_replay = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, global_replay)
        self.assertEqual(global_replay["reply_request_id"], reply["reply_request_id"])
        self.assertEqual(global_replay["candidates"], reply["candidates"])
        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        replacement = self._path(self._default())

        status, rejected = self.backend.request(replacement + "/replies", body)
        self.assertNotEqual(status, 200, rejected)
        self.assertEqual(self.backend.request(replacement)[1]["turns"], [])
        self.assertEqual(self.backend.request(replacement)[1]["inputs"], [])
        self.assertEqual(self.backend.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_missing_or_false_confirmation_preserves_discussion(self) -> None:
        path = self._path(self._default())
        self.assertEqual(self.backend.request(path + "/replies", self._body())[0], 200)
        original = self.backend.request(path)
        for confirmation in (None, {}, {"confirmed": False}, {"confirmed": 1},
                             {"confirmed": "true"}, {"confirmed": True, "contact_id": str(self.contact_id)}):
            with self.subTest(confirmation=confirmation):
                self.assertEqual(
                    self.backend.request(path, confirmation, method="DELETE"),
                    (400, {"error": "assistant_session_request_invalid"}),
                )
                self.assertEqual(self.backend.request(path), original)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_repeated_delete_and_generate_do_not_restore_deleted_session(self) -> None:
        session_id = self._default()
        path = self._path(session_id)
        body = self._body()
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        missing = (404, {"error": "not_found"})
        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE"), missing)
        self.assertEqual(self.backend.request(path + "/replies", body), missing)
        self.assertEqual(self.backend.request(path), missing)
        reopened = self._backend()
        self.assertEqual(reopened.request(path), missing)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_foreign_owner_contact_and_unknown_session_cannot_delete_discussion(self) -> None:
        session_id = self._default()
        path = self._path(session_id)
        self.assertEqual(self.backend.request(path + "/replies", self._body())[0], 200)
        original = self.backend.request(path)
        foreign_owner = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '另一合成用户')",
                (foreign_owner,),
            )
        self.addCleanup(self._clean_owner, foreign_owner)
        other_backend = self._backend(owner_id=foreign_owner)
        missing = (404, {"error": "not_found"})
        self.assertEqual(other_backend.request(path, {"confirmed": True}, method="DELETE"), missing)
        self.assertEqual(self.backend.request(
            self._path(session_id, contact_id=self.other_contact_id), {"confirmed": True}, method="DELETE",
        ), missing)
        self.assertEqual(self.backend.request(self._path(str(uuid4())), {"confirmed": True}, method="DELETE"), missing)
        self.assertEqual(self.backend.request(path), original)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_running_generation_return_after_delete_cannot_restore_request_or_input(self) -> None:
        path = self._path(self._default())
        body = self._body(draft="删除期间迟到的合成输入")
        gate = self.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                stored = self.backend.request(path)[1]
                self.assertEqual(stored["turns"][0]["state"], "running")
                self.assertIsNone(stored["turns"][0]["reply"])
                self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
            finally:
                gate.set()
            status, result = running.result(timeout=10)
            self.assertNotEqual(status, 200, result)
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        replacement = self._path(self._default())
        self.assertEqual(self.backend.request(replacement)[1]["turns"], [])
        self.assertNotEqual(self.backend.request(replacement + "/replies", body)[0], 200)
        self.assertEqual(self.backend.request(replacement)[1]["inputs"], [])
        self.assertEqual(self.backend.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_failed_reply_without_completed_candidate_is_cleared_and_cannot_replay(self) -> None:
        path = self._path(self._default())
        body = self._body(draft="失败请求也必须清除的合成输入")
        self.model.responses = [self._candidate("无效合成引用", str(uuid4()))]
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        failed = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(failed["state"], "failed")
        self.assertIsNone(failed["reply"])
        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.model.responses.append(self._candidate("不应再次运行的候选"))
        replacement = self._path(self._default())
        self.assertNotEqual(self.backend.request(replacement + "/replies", body)[0], 200)
        self.assertEqual(self.backend.request(replacement)[1]["turns"], [])
        self.assertEqual(self.backend.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_reserved_key_without_reply_request_is_invalidated_before_late_start(self) -> None:
        path = self._path(self._default())
        body = self._body(draft="只有预留键的合成讨论")
        remove_fault = self._database_fault("reply_request", "INSERT")
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 503)
        reserved = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(reserved["request_key"], body["idempotency_key"])
        self.assertEqual(reserved["state"], "failed")
        self.assertIsNone(reserved["reply"])
        remove_fault()

        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (409, {"error": "reply_input_invalidated"}))
        replacement = self._path(self._default())
        self.assertNotEqual(self.backend.request(replacement + "/replies", body)[0], 200)
        self.assertEqual(self.backend.request(replacement)[1]["inputs"], [])
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        self.assertEqual(len(self.model.seen_calls), 0)

    def test_database_delete_failure_rolls_back_and_retry_clears_saved_reply(self) -> None:
        session_id = self._default()
        path = self._path(session_id)
        body = self._body()
        status, reply = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)
        original = self.backend.request(path)
        evidence_path = f"/api/contacts/{self.contact_id}/replies/{reply['reply_request_id']}/evidence"
        original_evidence = self.backend.request(evidence_path)
        remove_fault = self._database_fault("assistant_session", "DELETE")

        self.assertEqual(
            self.backend.request(path, {"confirmed": True}, method="DELETE"),
            (503, {"error": "assistant_session_save_failed"}),
        )
        self.assertEqual(self.backend.request(path), original)
        self.assertEqual(self.backend.request(evidence_path), original_evidence)
        self.assertEqual(self.backend.request(path + "/replies", body), (200, reply))
        remove_fault()
        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(evidence_path)[0], 404)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_deleting_parent_erases_descendants_but_keeps_unrelated_discussion(self) -> None:
        parent_path = self._path(self._default())
        status, parent = self.backend.request(parent_path + "/replies", self._body())
        self.assertEqual(status, 200, parent)
        candidate_id = parent["candidates"][0]["candidate_id"]
        child_path = self._path(self._independent_session())
        child_body = {**self._body(draft="继续明确选中的合成候选"),
                      "continued_from_candidate_id": candidate_id}
        self.model.responses.append(self._candidate("从旧候选派生的合成版本", candidate_id))
        status, child = self.backend.request(child_path + "/replies", child_body)
        self.assertEqual(status, 200, child)
        grandchild_body = {**self._body(draft="继续第二代合成候选"),
                           "continued_from_candidate_id": child["candidates"][0]["candidate_id"]}
        self.model.responses.append(self._candidate(
            "第二代派生的合成版本", child["candidates"][0]["candidate_id"],
        ))
        status, grandchild = self.backend.request(child_path + "/replies", grandchild_body)
        self.assertEqual(status, 200, grandchild)
        status, discussion = self.backend.request(child_path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "另一段独立的合成讨论"},
        })
        self.assertEqual(status, 200, discussion)
        self.model.responses.append(self._candidate("独立的新合成候选"))
        status, independent = self.backend.request(child_path + "/replies", self._body(draft="独立合成要求"))
        self.assertEqual(status, 200, independent)

        self.assertEqual(self.backend.request(parent_path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(self.backend.request(parent_path), (404, {"error": "not_found"}))
        status, remaining = self.backend.request(child_path)
        self.assertEqual(status, 200, remaining)
        self.assertEqual([turn["state"] for turn in remaining["turns"]], ["redacted", "redacted", "completed"])
        for turn in remaining["turns"][:2]:
            self.assertIsNone(turn["input"])
            self.assertIsNone(turn["reply"])
            self.assertEqual(turn["placeholder"], "相关来源已删除")
        self.assertEqual(remaining["turns"][2]["reply"]["candidates"], independent["candidates"])
        self.assertEqual(remaining["inputs"][2]["content"]["purpose_hint"], "另一段独立的合成讨论")
        self.assertEqual([record["state"] for record in remaining["inputs"]],
                         ["redacted", "redacted", "active", "active"])
        for result in (parent, child, grandchild):
            evidence = f"/api/contacts/{self.contact_id}/replies/{result['reply_request_id']}/evidence"
            self.assertEqual(self.backend.request(evidence)[0], 404)
        self.assertEqual(self.backend.request(child_path + "/replies", child_body)[0], 409)
        self.assertEqual(self.backend.request(child_path + "/replies", grandchild_body)[0], 409)
        self.assertEqual(len(self.model.seen_calls), 4)

    def test_deleting_parent_erases_reserved_descendant_without_reply_request(self) -> None:
        parent_path = self._path(self._default())
        parent_body = self._body()
        status, parent = self.backend.request(parent_path + "/replies", parent_body)
        self.assertEqual(status, 200, parent)
        status, global_replay = self.backend.request("/api/reply/generate", parent_body)
        self.assertEqual(status, 200, global_replay)
        self.assertEqual(global_replay["reply_request_id"], parent["reply_request_id"])
        self.assertEqual(global_replay["candidates"], parent["candidates"])
        child_path = self._path(self._independent_session())
        child_body = {**self._body(draft="只预留输入也必须随前序候选清除的合成讨论"),
                      "continued_from_candidate_id": parent["candidates"][0]["candidate_id"]}
        remove_fault = self._database_fault("reply_request", "INSERT")
        self.assertEqual(self.backend.request(child_path + "/replies", child_body)[0], 503)
        remove_fault()
        reserved = self.backend.request(child_path)[1]["turns"][0]
        self.assertEqual(reserved["state"], "failed")
        self.assertIsNotNone(reserved["input"])
        self.assertIsNone(reserved["reply"])
        self.assertEqual(len(self.model.seen_calls), 1)
        status, discussion = self.backend.request(child_path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "同一会话的独立讨论继续保留"},
        })
        self.assertEqual(status, 200, discussion)
        self.model.responses.append(self._candidate("同一会话的独立候选继续保留"))
        status, independent = self.backend.request(child_path + "/replies", self._body(draft="另一段独立合成要求"))
        self.assertEqual(status, 200, independent)

        self.assertEqual(self.backend.request(parent_path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(self.backend.request(parent_path), (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request("/api/reply/generate", parent_body), (409, {"error": "reply_input_invalidated"}))
        status, remaining = self.backend.request(child_path)
        self.assertEqual(status, 200, remaining)
        self.assertEqual([turn["state"] for turn in remaining["turns"]], ["redacted", "completed"])
        child = remaining["turns"][0]
        self.assertIsNone(child["input"])
        self.assertIsNone(child["reply"])
        self.assertEqual(child["placeholder"], "相关来源已删除")
        self.assertEqual([record["state"] for record in remaining["inputs"]], ["redacted", "active", "active"])
        self.assertIsNone(remaining["inputs"][0]["content"])
        self.assertEqual(remaining["inputs"][1]["content"]["purpose_hint"], "同一会话的独立讨论继续保留")
        self.assertEqual(remaining["turns"][1]["reply"]["candidates"], independent["candidates"])
        self.assertEqual(self.backend.request(child_path + "/replies", child_body)[0], 409)
        self.assertEqual(len(self.model.seen_calls), 2)
        # 同键换成独立草稿仍须拒绝；否则旧键会在全局或新会话入口成为新请求。
        reused_key = self._body(key=UUID(child_body["idempotency_key"]), draft="不能用已清除的预留键改写新正文")
        self.model.responses.append(self._candidate("失效预留键不应调用到这条合成脚本"))
        self.assertEqual(self.backend.request("/api/reply/generate", reused_key), (500, {"error": "reply_generation_failed"}))
        replacement = self._path(self._default())
        self.assertEqual(self.backend.request(replacement + "/replies", reused_key)[0], 409)
        self.assertEqual(self.backend.request(replacement)[1]["turns"], [])
        self.assertEqual(self.backend.request(replacement)[1]["inputs"], [])
        self.assertEqual(self.backend.request(child_path)[1], remaining)
        self.assertEqual(len(self.model.seen_calls), 2)

    def test_source_messages_memories_and_explicit_manual_sample_survive_session_delete(self) -> None:
        source_id, message_id = self._source_message()
        self.assertEqual(self.backend.request("/api/memories/manual-contact", {
            "contact_id": str(self.contact_id), "text": "合成联系人长期偏好轻松交流", "category": "preference", "topic": "other",
        })[0], 200)
        self.assertEqual(self.backend.request("/api/memories/manual-owner", {
            "text": "合成本人长期偏好简洁表达", "category": "preference", "topic": "other",
        })[0], 200)
        sample_path = f"/api/contacts/{self.contact_id}/style-samples"
        status, sample = self.backend.request(sample_path, {
            "idempotency_key": str(uuid4()), "text": "主动保存的独立合成样本", "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, sample)
        paths = [f"/api/contacts/{self.contact_id}/sources", f"/api/contacts/{self.contact_id}/messages",
                 f"/api/contacts/{self.contact_id}/memories", "/api/memories/owner", sample_path]
        original = [self.backend.request(path) for path in paths]
        self.assertIn(source_id, [source["source_id"] for source in original[0][1]["sources"]])
        self.assertIn(message_id, [message["message_id"] for message in original[1][1]["messages"]])
        self.model.responses = [self._candidate("好的，明天再确认。", message_id)]
        path = self._path(self._default())
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": message_id, "direction": "轻松回应稍后确认"}}
        status, reply = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)

        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        for public_path, before in zip(paths, original, strict=True):
            self.assertEqual(self.backend.request(public_path), before)
        self.assertEqual(self.backend.request(f"{sample_path}/{sample['sample']['sample_id']}")[0], 200)
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_explicit_candidate_sample_remains_independent_and_deleted_candidate_cannot_be_saved_again(self) -> None:
        source_id, message_id = self._source_message()
        self.model.responses = [self._candidate("候选产生的合成表达", message_id)]
        path = self._path(self._default())
        status, reply = self.backend.request(path + "/replies", {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "reply_to_message", "target_message_id": message_id, "direction": "轻松回应"},
        })
        self.assertEqual(status, 200, reply)
        sample_path = f"/api/contacts/{self.contact_id}/style-samples"
        save = {"idempotency_key": str(uuid4()), "text": "用户主动另存的合成最终表达",
                "origin": {"kind": "candidate", "id": reply["candidates"][0]["candidate_id"]}}
        status, saved = self.backend.request(sample_path, save)
        self.assertEqual(status, 200, saved)
        self.assertEqual(set(saved["sample"]["source_ids"]), {source_id, message_id})

        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(sample_path)[1]["samples"], [saved["sample"]])
        self.assertEqual(self.backend.request(sample_path, save), (200, saved))
        self.assertEqual(self.backend.request(sample_path, {**save, "idempotency_key": str(uuid4())})[0], 404)
        self.assertEqual(len(self.model.seen_calls), 1)
