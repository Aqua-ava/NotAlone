"""依据变化与真实删除沿公开会话操作验证，不补造旧证据。"""

from __future__ import annotations

import json
import unittest
import threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb
from langchain_core.messages import HumanMessage

from tests.integration.server import test_assistant_session_memory_dependencies as memory_fixture
from tests.integration.server import test_assistant_session_api as session_fixture
from tests.integration.server.test_assistant_generation_prepare import AssistantCompletionBarrierStore
from tests.integration.persistence.concurrency import wait_for_blocked_operations
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.memory import FactSubject, MemoryCandidate, MemoryCategory
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend


class CommitBoundaryReplyStore(PostgresReplyStore):
    """只延迟公开持久化边界，之后委托实际 owner 事务完成写入。"""

    def __init__(self, database_url: str, *, id_factory=uuid4) -> None:
        super().__init__(database_url, id_factory=id_factory)
        self.hold_before_commit = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def save(self, request, context, reply):
        if self.hold_before_commit:
            self.hold_before_commit = False
            self.entered.set()
            if not self.release.wait(5):
                raise TimeoutError("合成提交边界未释放。")
        return super().save(request, context, reply)


class CommitIdentifierFactory:
    """公共 id_factory 在真实事务最后复验后暂停一次候选标识分配。"""

    def __init__(self) -> None:
        self.armed = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def __call__(self):
        if self.armed:
            self.armed = False
            self.entered.set()
            if not self.release.wait(5):
                raise TimeoutError("合成候选标识边界未释放。")
        return uuid4()


class HistoricalReplyBasisHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        memory_fixture.AssistantSessionMemoryDependencyHttpTest.setUpClass()

    def setUp(self) -> None:
        self.fixture = session_fixture.AssistantSessionHttpTest()
        self.fixture.production_discussion_context = True
        self.commit_ids = CommitIdentifierFactory()
        self.reply_store = CommitBoundaryReplyStore(session_fixture.DATABASE_URL, id_factory=self.commit_ids)
        self.fixture.reply_store_factory = lambda database_url: self.reply_store
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store = PostgresAssistantSessionStore(session_fixture.DATABASE_URL)
        self.scope = ContactScope(self.fixture.owner_id, self.fixture.contact_id)
        status, session = self.fixture._default()
        self.assertEqual(status, 200, session)
        self.session_id = UUID(session["session_id"])
        self.path = self.fixture._path(self.session_id)

    _memory = memory_fixture.AssistantSessionMemoryDependencyHttpTest._memory
    _set_period = memory_fixture.AssistantSessionMemoryDependencyHttpTest._set_period

    def _source_memory(self, text: str, *, subject=FactSubject.CONTACT,
                       category=MemoryCategory.PREFERENCE, occurred_at=None, valid_at=None, invalid_at=None):
        source_id, message_id = self.fixture._source(text)
        if occurred_at is not None:
            with psycopg.connect(session_fixture.DATABASE_URL) as connection:
                connection.execute("UPDATE public.message SET occurred_at=%s WHERE id=%s", (occurred_at, message_id))
                connection.execute("UPDATE public.message_source_ref SET raw_payload=%s WHERE message_id=%s",
                                   (Jsonb({"time_iso": occurred_at.isoformat()}), message_id))
        candidate = PostgresMemoryStore(session_fixture.DATABASE_URL).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text=text, category=category, subject=subject,
            source_ids=(UUID(message_id),), valid_at=valid_at, invalid_at=invalid_at,
        ))
        status, confirmed = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        self.assertEqual(status, 200, confirmed)
        return source_id, message_id, confirmed["memory"]["memory_id"]

    def test_current_status_clock_change_is_not_rewritten_into_the_original_evidence(self) -> None:
        start = datetime.fromisoformat("2026-10-01T00:00:00+08:00")
        end = datetime.fromisoformat("2026-11-01T00:00:00+08:00")
        sent = datetime.fromisoformat("2026-10-14T08:00:00+08:00")
        text = "这个月在加班。"
        with patch("notalone.memory.current_status._utc_now", return_value=sent.replace(hour=15)):
            _, _, memory_id = self._source_memory(text, category=MemoryCategory.RECENT_STATE,
                                                  occurred_at=sent, valid_at=start, invalid_at=end)
            self.fixture.model.responses = [self.fixture._candidate(memory_id)]
            body = self.fixture._body(draft=text)
            body["content"]["include_relationship_context"] = True
            status, generated = self.fixture.backend.request(self.path + "/replies", body)
            self.assertEqual(status, 200, generated)
            evidence_path = f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence"
            original = self.fixture.backend.request(evidence_path)[1]
            timing = next(item["timing"] for item in original["evidence"] if item["evidence_id"] == memory_id)
            self.assertEqual(timing["current_status"], "current_verified")
        with patch("notalone.memory.current_status._utc_now", return_value=end):
            status, saved = self.fixture.backend.request(self.path)
            self.assertEqual(status, 200, saved)
            self.assertEqual(saved["turns"][0]["state"], "completed")
            self.assertEqual(saved["turns"][0]["basis_changes"], [{
                "evidence_id": memory_id, "kind": "confirmed_memory", "reason": "memory_time_changed",
            }])
            status, history = self.fixture.backend.request(evidence_path)
            self.assertEqual(status, 200, history)
            self.assertEqual(history["evidence"], original["evidence"])
            self.assertEqual(history["basis_changes"], saved["turns"][0]["basis_changes"])
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_current_timing_change_after_last_model_validation_cannot_commit_a_new_candidate(self) -> None:
        sent = datetime.fromisoformat("2026-10-14T08:00:00+08:00")
        start, end = sent.replace(day=1, hour=0), sent.replace(month=11, day=1, hour=0)
        text = "这个月在加班。"
        with patch("notalone.memory.current_status._utc_now", return_value=sent.replace(hour=15)):
            _, _, memory_id = self._source_memory(text, category=MemoryCategory.RECENT_STATE,
                                                  occurred_at=sent, valid_at=start, invalid_at=end)
            self.fixture.model.responses = [self.fixture._candidate(memory_id)]
            body = self.fixture._body(draft=text)
            body["content"]["include_relationship_context"] = True
            self.reply_store.hold_before_commit = True
            with ThreadPoolExecutor(max_workers=1) as pool:
                request = pool.submit(self.fixture.backend.request, self.path + "/replies", body)
                try:
                    self.assertTrue(self.reply_store.entered.wait(5), "模型后最后验证须已完成。")
                    with patch("notalone.memory.current_status._utc_now", return_value=end):
                        self.reply_store.release.set()
                        status, result = request.result(timeout=10)
                finally:
                    self.reply_store.release.set()
        self.assertNotEqual(status, 200, result)
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual(saved["turns"][0]["state"], "failed")
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(saved["turns"][0]["input"]["content"], {**body["content"], "user_instruction": None})
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s", (self.fixture.owner_id,)).fetchone()[0], 0)

    def test_owner_transaction_serializes_correction_after_final_validation_and_saved_result_still_wins(self) -> None:
        text = "喜欢散步，希望表达轻松自然。"
        memory_id = self._memory("contact", text)
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        self.fixture.model.responses = [self.fixture._candidate(str(memory_id))]
        barrier = AssistantCompletionBarrierStore(session_fixture.DATABASE_URL)
        backend = self.fixture._backend(assistant_store=barrier)
        self.addCleanup(backend.close)
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=2) as pool:
            request = pool.submit(backend.request, self.path + "/replies", body)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                self.commit_ids.armed = True
                gate.set()
                self.assertTrue(self.commit_ids.entered.wait(5), "真实 writer 必须在最后复验与 INSERT 之间持锁暂停。")
                with psycopg.connect(session_fixture.DATABASE_URL) as connection:
                    blockers = {row[0] for row in connection.execute(
                        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted "
                        "AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
                    ).fetchall()}
                correction = pool.submit(self.fixture.backend.request,
                    f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct",
                    {"text": "喜欢慢慢散步，希望表达轻松自然。"})
                wait_for_blocked_operations(session_fixture.DATABASE_URL, blockers, 1)
                self.assertFalse(correction.done(), "人工修正须等待候选 writer 的同一 owner 锁。")
                self.commit_ids.release.set()
                self.assertTrue(barrier.entered.wait(5), "C 必须实际可靠保存后再关联 A。")
                self.assertEqual(correction.result(timeout=10)[0], 200)
            finally:
                gate.set()
                self.commit_ids.release.set()
                barrier.release.set()
            status, generated = request.result(timeout=10)
        self.assertEqual(status, 200, generated)
        saved = backend.request(self.path)[1]
        self.assertEqual(saved["turns"][0]["state"], "completed")
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], generated["candidates"])
        self.assertEqual(saved["turns"][0]["basis_changes"], [{
            "evidence_id": str(memory_id), "kind": "confirmed_memory", "reason": "memory_revised",
        }])
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def _generate(self, kind: str):
        text = "我喜欢散步，希望表达轻松自然。"
        memory_id = self._memory(kind, text)
        self.fixture.model.responses.append(self.fixture._candidate(str(memory_id)))
        # fixture的第一条预置模型结果只供无记忆输入，当前切片明确替换。
        self.fixture.model.responses = [self.fixture.model.responses[-1]]
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        status, generated = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, generated)
        return memory_id, body, generated

    def _continue_command(self, generated: dict, *, version_id=None, intent="合成问候，这次只打招呼", session_id=None) -> dict:
        candidate_id = generated["candidates"][0]["candidate_id"]
        return {"idempotency_key": str(uuid4()), "expected_input_version_id": generated["input_version_id"],
                "instruction": "第一条简短一点", "intention_update": intent,
                "displayed_group": {"session_id": str(session_id or self.session_id), "candidate_group_id": generated["reply_request_id"],
                    "candidates": [{"number": 1, "candidate_id": candidate_id, "version_id": version_id or candidate_id}]}}

    def _restart_backend(self):
        """重新构造全部正式回复装配，只有外部模型仍受控。"""
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.fixture.model):
            service = build_reply_service(database_url=session_fixture.DATABASE_URL,
                owner_id=self.fixture.owner_id, **synthetic_budget_kwargs(self.fixture.model))
        backend = HttpBackend(create_app(database_url=session_fixture.DATABASE_URL,
            owner_id=self.fixture.owner_id, token="synthetic-history-restart", reply_service=service), self.fixture.owner_id)
        self.addCleanup(backend.close)
        return backend

    def test_prepared_ordinary_continue_restarts_with_frozen_historical_and_current_groups(self) -> None:
        old_id, _, original = self._generate("contact")
        status, corrected = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/memories/{old_id}/correct", {"text": "我喜欢慢慢散步，希望表达轻松自然。"})
        self.assertEqual(status, 200, corrected)
        new_id = corrected["memory"]["memory_id"]
        body = self.fixture._body(draft="我愿意聊聊散步，先不作承诺。")
        body["continued_from_candidate_id"] = original["candidates"][0]["candidate_id"]
        body["content"]["include_relationship_context"] = True
        status, receipt = self.fixture.backend.request(self.path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(len(self.fixture.model.seen_calls), 1)
        self.fixture._source("准备之后才出现的合成消息不能进入固定历史。")
        self.fixture.model.responses.append(self.fixture._candidate(new_id))
        restarted = self._restart_backend()
        status, result = restarted.request(self.path + "/replies", body)
        self.assertEqual(status, 200, result)
        self.assertEqual((result["turn_id"], result["input_version_id"]), (receipt["turn_id"], receipt["input_version_id"]))
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1] if isinstance(message, HumanMessage))
        self.assertNotIn("准备之后才出现", json.dumps(payload, ensure_ascii=False))
        memory_ids = [item["evidence_id"] for item in payload["evidence"] if item["kind"] == "confirmed_memory"]
        self.assertEqual(memory_ids, [new_id])
        continued = next(item for item in payload["evidence"] if item["kind"] == "continued_candidate")
        self.assertEqual(continued["basis_changes"], [{"evidence_id": str(old_id), "kind": "confirmed_memory", "reason": "memory_revised"}])
        self.assertEqual(restarted.request(self.path + "/replies", body), (status, result))
        self.assertEqual(len(self.fixture.model.seen_calls), 2)

    def test_prepared_historical_continue_rejects_second_correction_before_model_after_restart(self) -> None:
        old_id, _, original = self._generate("owner")
        status, corrected = self.fixture.backend.request(f"/api/memories/owner/{old_id}/correct",
            {"text": "我喜欢慢慢散步，希望表达轻松自然。"})
        self.assertEqual(status, 200, corrected)
        command = self._continue_command(original, intent="愿意聊聊散步，先不承诺安排。")
        status, receipt = self.fixture.backend.request(self.path + "/continue/prepare", command)
        self.assertEqual(status, 200, receipt)
        status, changed = self.fixture.backend.request(f"/api/memories/owner/{corrected['memory']['memory_id']}/correct",
            {"text": "我喜欢偶尔散步，希望表达轻松自然。"})
        self.assertEqual(status, 200, changed)
        restarted = self._restart_backend()
        self.assertNotEqual(restarted.request(self.path + "/continue", command)[0], 200)
        saved = restarted.request(self.path)[1]
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], original["candidates"])
        self.assertIsNone(saved["turns"][-1]["reply"])
        self.assertEqual(saved["turns"][-1]["input"]["content"]["draft_text"], command["intention_update"])
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_source_deletion_erases_prepared_history_before_restarted_execution(self) -> None:
        text = "喜欢散步，希望表达轻松自然。"
        source_id, _, memory_id = self._source_memory(text, subject=FactSubject.SELF)
        self.fixture.model.responses = [self.fixture._candidate(memory_id)]
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        status, original = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, original)
        command = self._continue_command(original, intent="先聊聊散步，不作承诺。")
        status, receipt = self.fixture.backend.request(self.path + "/continue/prepare", command)
        self.assertEqual(status, 200, receipt)
        self.fixture._delete_source(source_id)
        # 删除效果必须在任何 GET 之前已落库；058既有触发器清除固定正文。
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            rows = connection.execute("SELECT prepared_context,input_payload FROM public.assistant_session_turn WHERE owner_id=%s",
                (self.fixture.owner_id,)).fetchall()
            self.assertTrue(rows)
            self.assertTrue(all(context is None and input_payload is None for context, input_payload in rows))
        restarted = self._restart_backend()
        self.assertNotEqual(restarted.request(self.path + "/continue", command)[0], 200)
        self.assertTrue(all(turn["input"] is None and turn["reply"] is None for turn in restarted.request(self.path)[1]["turns"]))
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_completed_old_format_receipt_remains_readable_after_memory_correction(self) -> None:
        old_id = self._memory("contact", "喜欢散步，希望表达轻松自然。")
        body = self.fixture._body(draft="喜欢散步，希望表达轻松自然。")
        body["content"]["include_relationship_context"] = True
        self.fixture.model.responses = [self.fixture._candidate(str(old_id))]
        status, receipt = self.fixture.backend.request(self.path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        status, generated = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, generated)
        status, corrected = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/memories/{old_id}/correct", {"text": "喜欢慢慢散步，希望表达轻松自然。"})
        self.assertEqual(status, 200, corrected)
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context=jsonb_set(prepared_context,'{schema_revision}','1'::jsonb) WHERE id=%s",
                (receipt["turn_id"],))
        restarted = self._restart_backend()
        identity = {"request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"]}
        status, checked = restarted.request(self.path + "/preparation-format", identity)
        self.assertEqual(status, 200, checked)
        self.assertEqual((checked["turn_id"], checked["state"]), (receipt["turn_id"], "completed"))
        status, replay = restarted.request(self.path + "/replies", body)
        self.assertEqual(status, 200, replay)
        self.assertEqual(replay["candidates"], generated["candidates"])
        self.assertEqual(replay["basis_changes"], [{"evidence_id": str(old_id), "kind": "confirmed_memory", "reason": "memory_revised"}])
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_original_reply_continue_rechecks_basis_at_commit_and_retry_captures_fresh_basis(self) -> None:
        text = "我喜欢散步，希望表达轻松自然。"
        source_id, _, memory_id = self._source_memory(text)
        self.fixture.model.responses = [self.fixture._candidate(memory_id)]
        first = self.fixture._body(draft=text)
        first["content"]["include_relationship_context"] = True
        status, generated = self.fixture.backend.request("/api/reply/generate", first)
        self.assertEqual(status, 200, generated)
        candidate_id = generated["candidates"][0]["candidate_id"]
        command = self.fixture._body(draft="这次先轻松问候，不作承诺。")
        command["continued_from_candidate_id"] = candidate_id
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        self.reply_store.hold_before_commit = True
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(self.fixture.backend.request, "/api/reply/generate", command)
            try:
                self.assertTrue(self.reply_store.entered.wait(5))
                status, corrected = self.fixture.backend.request(
                    f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct",
                    {"text": "我喜欢慢慢散步，希望表达轻松自然。"},
                )
                self.assertEqual(status, 200, corrected)
            finally:
                self.reply_store.release.set()
            self.assertNotEqual(request.result(timeout=10)[0], 200)
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_candidate AS candidate JOIN public.reply_request AS request "
                "ON candidate.reply_request_id=request.id WHERE request.owner_id=%s AND request.idempotency_key=%s",
                (self.fixture.owner_id, command["idempotency_key"]),
            ).fetchone()[0], 0)
        new_memory_id = corrected["memory"]["memory_id"]
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        status, retried = self.fixture.backend.request("/api/reply/generate", command)
        self.assertEqual(status, 200, retried)
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertEqual(payload["draft_text"], command["content"]["draft_text"])
        old_reference = next(item for item in payload["evidence"] if item["kind"] == "continued_candidate")
        self.assertEqual(old_reference["basis_changes"], [{
            "evidence_id": memory_id, "kind": "confirmed_memory", "reason": "memory_revised",
        }])
        self.assertEqual(old_reference["factual_role"], "previous_assistant_candidate")
        fresh = self.fixture._body(draft="我喜欢慢慢散步，希望表达轻松自然，这次先问候。")
        fresh["content"]["include_relationship_context"] = True
        fresh["continued_from_candidate_id"] = candidate_id
        self.fixture.model.responses.append(self.fixture._candidate(new_memory_id))
        status, current = self.fixture.backend.request("/api/reply/generate", fresh)
        self.assertEqual(status, 200, current)
        self.assertIn(new_memory_id, current["context_receipt"]["evidence_ids"])
        self.assertNotIn(memory_id, current["context_receipt"]["evidence_ids"])
        calls = len(self.fixture.model.seen_calls)
        self.fixture._delete_source(source_id)
        for saved in (generated, retried, current):
            status, evidence = self.fixture.backend.request(
                f"/api/contacts/{self.fixture.contact_id}/replies/{saved['reply_request_id']}/evidence",
            )
            self.assertEqual(status, 404, evidence)
        self.assertNotEqual(self.fixture.backend.request("/api/reply/generate", command)[0], 200)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)

    def test_plain_reply_commit_rechecks_contact_and_owner_memory_without_an_assistant_turn(self) -> None:
        for subject in (FactSubject.CONTACT, FactSubject.SELF):
            with self.subTest(subject=subject.value):
                text = "我喜欢散步，希望表达轻松自然。"
                source_id, _, memory_id = self._source_memory(text, subject=subject)
                body = self.fixture._body(draft=text)
                body["content"]["include_relationship_context"] = True
                self.fixture.model.responses.append(self.fixture._candidate(memory_id))
                if len(self.fixture.model.seen_calls) == 0:
                    self.fixture.model.responses = [self.fixture.model.responses[-1]]
                self.reply_store.entered.clear()
                self.reply_store.release.clear()
                self.reply_store.hold_before_commit = True
                with ThreadPoolExecutor(max_workers=1) as pool:
                    request = pool.submit(self.fixture.backend.request, "/api/reply/generate", body)
                    try:
                        self.assertTrue(self.reply_store.entered.wait(5))
                        correction_path = (f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct"
                                           if subject == FactSubject.CONTACT else f"/api/memories/owner/{memory_id}/correct")
                        status, corrected = self.fixture.backend.request(correction_path, {
                            "text": "我喜欢慢慢散步，希望表达轻松自然。",
                        })
                        self.assertEqual(status, 200, corrected)
                    finally:
                        self.reply_store.release.set()
                    self.assertNotEqual(request.result(timeout=10)[0], 200)
                with psycopg.connect(session_fixture.DATABASE_URL) as connection:
                    self.assertEqual(connection.execute(
                        "SELECT count(*) FROM public.reply_candidate AS candidate JOIN public.reply_request AS request "
                        "ON request.id=candidate.reply_request_id WHERE request.owner_id=%s AND request.idempotency_key=%s",
                        (self.fixture.owner_id, body["idempotency_key"]),
                    ).fetchone()[0], 0)
                    self.assertEqual(connection.execute(
                        "SELECT count(*) FROM public.assistant_session_turn WHERE owner_id=%s", (self.fixture.owner_id,),
                    ).fetchone()[0], 0)
                new_memory_id = corrected["memory"]["memory_id"]
                self.fixture.model.responses.append(self.fixture._candidate(new_memory_id))
                status, retried = self.fixture.backend.request("/api/reply/generate", body)
                self.assertEqual(status, 200, retried)
                self.assertIn(new_memory_id, retried["context_receipt"]["evidence_ids"])
                self.assertNotIn(memory_id, retried["context_receipt"]["evidence_ids"])
                payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                               if isinstance(message, HumanMessage))
                self.assertEqual(payload["draft_text"], body["content"]["draft_text"])
                calls = len(self.fixture.model.seen_calls)
                self.fixture._delete_source(source_id)
                self.assertEqual(self.fixture.backend.request(
                    f"/api/contacts/{self.fixture.contact_id}/replies/{retried['reply_request_id']}/evidence",
                )[0], 404)
                self.assertNotEqual(self.fixture.backend.request("/api/reply/generate", body)[0], 200)
                self.assertEqual(len(self.fixture.model.seen_calls), calls)
        pure = self.fixture._body(draft="合成纯草稿：稍后再聊。")
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        status, generated = self.fixture.backend.request("/api/reply/generate", pure)
        self.assertEqual(status, 200, generated)
        evidence_path = f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence"
        self.assertEqual({item["kind"] for item in self.fixture.backend.request(evidence_path)[1]["evidence"]}, {"user_draft"})

    def test_source_delete_before_late_result_erases_corrected_owner_history_versions_and_carry(self) -> None:
        self._source_deletion_order(source_first=True, subject=FactSubject.SELF)

    def test_source_delete_after_result_erases_corrected_contact_history_versions_and_carry(self) -> None:
        self._source_deletion_order(source_first=False, subject=FactSubject.CONTACT)

    def test_history_stays_scoped_while_owner_memory_can_use_a_legal_other_contact_source(self) -> None:
        text = "本人明确喜欢散步，希望表达轻松自然。"
        source_id, _, memory_id = self._source_memory(text, subject=FactSubject.SELF)
        self.fixture.bindings.create_binding(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.other_contact_id,
            channel="wechat", account_scope="synthetic-history-scope", conversation_locator=f"synthetic-{uuid4()}",
        )
        status, session = self.fixture._default(contact_id=self.fixture.other_contact_id)
        self.assertEqual(status, 200, session)
        other_path = self.fixture._path(session["session_id"], contact_id=self.fixture.other_contact_id)
        body = self.fixture._body(draft=text, contact_id=self.fixture.other_contact_id)
        body["content"]["include_relationship_context"] = True
        self.fixture.model.responses = [self.fixture._candidate(memory_id)]
        status, generated = self.fixture.backend.request(other_path + "/replies", body)
        self.assertEqual(status, 200, generated)
        candidate_id = generated["candidates"][0]["candidate_id"]
        versions_path = other_path + f"/candidates/{candidate_id}/versions"
        status, corrected = self.fixture.backend.request(f"/api/memories/owner/{memory_id}/correct", {
            "text": "本人明确喜欢慢慢散步，希望表达轻松自然。",
        })
        self.assertEqual(status, 200, corrected)
        self.assertEqual(self.fixture.backend.request(other_path)[1]["turns"][0]["basis_changes"], [{
            "evidence_id": memory_id, "kind": "owner_memory", "reason": "memory_revised",
        }])
        foreign = self.fixture._backend(owner_id=uuid4())
        self.addCleanup(foreign.close)
        command = self._continue_command(generated, session_id=session["session_id"], intent=text)
        wrong_contact_path = self.fixture._path(session["session_id"])
        evidence_path = f"/api/contacts/{self.fixture.other_contact_id}/replies/{generated['reply_request_id']}/evidence"
        for backend, path in ((foreign, other_path), (self.fixture.backend, wrong_contact_path)):
            self.assertEqual(backend.request(path), (404, {"error": "not_found"}))
            self.assertEqual(backend.request(path + f"/candidates/{candidate_id}/versions"), (404, {"error": "not_found"}))
            self.assertEqual(backend.request(path + "/continue", command), (404, {"error": "not_found"}))
        self.assertEqual(foreign.request(evidence_path), (404, {"error": "not_found"}))
        self.assertEqual(self.fixture.backend.request(self.path)[1]["turns"], [])
        self.fixture.model.responses.append(self.fixture._candidate(corrected["memory"]["memory_id"]))
        status, prepared = self.fixture.backend.request(other_path + "/continue/prepare", command)
        self.assertEqual(status, 200, prepared)
        restarted = self._restart_backend()
        status, continued = restarted.request(other_path + "/continue", command)
        self.assertEqual(status, 200, continued)
        self.assertIn(corrected["memory"]["memory_id"], continued["context_receipt"]["evidence_ids"])
        self.fixture._delete_source(source_id)
        self.assertTrue(all(turn["state"] == "redacted" for turn in self.fixture.backend.request(other_path)[1]["turns"]))
        self.assertEqual(self.fixture.backend.request(versions_path), (404, {"error": "not_found"}))
        self.assertEqual(self.fixture.model.review_calls, 1)
        self.assertEqual(len(self.fixture.model.seen_calls), 3)

    def test_legacy_missing_time_and_revision_metadata_stays_unknown_and_is_not_backfilled(self) -> None:
        memory_id, _, generated = self._generate("owner")
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            legacy = connection.execute("SELECT context_snapshot FROM public.reply_request WHERE owner_id=%s AND id=%s",
                                        (self.fixture.owner_id, generated["reply_request_id"])).fetchone()[0]
            for item in legacy["evidence"]:
                item.pop("timing", None)
            legacy["assistant_discussion_snapshot"].pop("basis_revision_sha256", None)
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE owner_id=%s AND id=%s",
                               (Jsonb(legacy), self.fixture.owner_id, generated["reply_request_id"]))
            connection.execute("UPDATE public.reply_context_evidence SET evidence_revision=NULL WHERE owner_id=%s AND reply_request_id=%s",
                               (self.fixture.owner_id, generated["reply_request_id"]))
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "completed")
        self.assertEqual(saved["turns"][0]["basis_changes"], [])
        evidence_path = f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence"
        status, evidence = self.fixture.backend.request(evidence_path)
        self.assertEqual(status, 200, evidence)
        for item in evidence["evidence"]:
            self.assertIsNone(item["timing"]["recorded_at"])
            self.assertEqual(item["timing"]["current_status"], "current_unverified")
        self.fixture.model.responses.append(self.fixture._candidate(str(memory_id)))
        status, continued = self.fixture.backend.request(self.path + "/continue", self._continue_command(
            generated, intent="愿意聊聊散步，希望表达轻松自然。",
        ))
        self.assertEqual(status, 200, continued)
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            self.assertEqual(connection.execute("SELECT context_snapshot FROM public.reply_request WHERE owner_id=%s AND id=%s",
                                               (self.fixture.owner_id, generated["reply_request_id"])).fetchone()[0], legacy)
            self.assertTrue(all(row[0] is None for row in connection.execute(
                "SELECT evidence_revision FROM public.reply_context_evidence WHERE owner_id=%s AND reply_request_id=%s",
                (self.fixture.owner_id, generated["reply_request_id"]),
            ).fetchall()))

    def test_manual_owner_root_remains_legal_while_its_mixed_chat_replacement_is_erased(self) -> None:
        text = "本人手录偏好：喜欢散步，希望表达轻松自然。"
        root_id = self._memory("owner", text)
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        self.fixture.model.responses = [self.fixture._candidate(str(root_id))]
        status, original = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, original)
        source_id, message_id = self.fixture._source("本人补充偏好：喜欢慢慢散步，希望表达轻松自然。")
        candidate = PostgresMemoryStore(session_fixture.DATABASE_URL).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text="本人补充偏好：喜欢慢慢散步，希望表达轻松自然。",
            category=MemoryCategory.PREFERENCE, subject=FactSubject.SELF, source_ids=(UUID(message_id),),
        ))
        status, updated = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/memory-candidates/{candidate.candidate_id}/apply-update",
            {"previous_memory_id": str(root_id), "expected_revision": 1},
        )
        self.assertEqual(status, 200, updated)
        replacement_id = updated["memory"]["memory_id"]
        self.assertEqual(set(updated["memory"]["source_ids"]), {str(self.fixture.owner_id), message_id})
        self.fixture.model.responses.append(self.fixture._candidate(replacement_id))
        status, mixed = self.fixture.backend.request(self.path + "/continue", self._continue_command(original, intent=text))
        self.assertEqual(status, 200, mixed)
        self.fixture._delete_source(source_id)
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual([turn["state"] for turn in saved["turns"]], ["completed", "redacted"])
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], original["candidates"])
        self.assertEqual(saved["turns"][0]["basis_changes"], [{
            "evidence_id": str(root_id), "kind": "owner_memory", "reason": "memory_revised",
        }])
        self.assertIsNone(saved["turns"][1]["reply"])
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            root = connection.execute("SELECT text_content,source_ids,adoption_method,status FROM public.owner_memory WHERE owner_id=%s AND id=%s",
                                      (self.fixture.owner_id, root_id)).fetchone()
            self.assertEqual(root, (text, [self.fixture.owner_id], "manual", "invalidated"))
            self.assertEqual(connection.execute("SELECT count(*) FROM public.owner_memory WHERE owner_id=%s AND id=%s",
                                               (self.fixture.owner_id, replacement_id)).fetchone()[0], 0)
        self.assertEqual(len(self.fixture.model.seen_calls), 2)


    def test_corrected_manual_owner_root_remains_legal_when_unrelated_chat_source_is_erased(self) -> None:
        text = "本人手录偏好：喜欢散步，希望表达轻松自然。"
        root_id = self._memory("owner", text)
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        self.fixture.model.responses = [self.fixture._candidate(str(root_id))]
        status, original = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, original)
        source_id, _ = self.fixture._source("与手录资料无关的独立聊天来源。")
        status, corrected = self.fixture.backend.request(
            f"/api/memories/owner/{root_id}/correct", {"text": "本人手录偏好：喜欢慢慢散步，希望表达轻松自然。"})
        self.assertEqual(status, 200, corrected)
        replacement_id = corrected["memory"]["memory_id"]
        self.fixture.model.responses.append(self.fixture._candidate(replacement_id))
        status, continued = self.fixture.backend.request(self.path + "/continue", self._continue_command(original, intent=text))
        self.assertEqual(status, 200, continued)
        self.fixture._delete_source(source_id)
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual([turn["state"] for turn in saved["turns"]], ["completed", "completed"])
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], original["candidates"])
        self.assertEqual(saved["turns"][0]["basis_changes"], [{
            "evidence_id": str(root_id), "kind": "owner_memory", "reason": "memory_revised",
        }])
        self.assertEqual(saved["turns"][1]["reply"]["candidates"], continued["candidates"])
        self.assertEqual(len(self.fixture.model.seen_calls), 2)

    def test_discarded_pending_basis_keeps_completed_expression_but_fresh_continue_excludes_it(self) -> None:
        text = "合成未确认偏好：喜欢散步，希望表达轻松自然。"
        _, message_id = self.fixture._source(text)
        candidate = PostgresMemoryStore(session_fixture.DATABASE_URL).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text=text, category=MemoryCategory.PREFERENCE,
            source_ids=(UUID(message_id),),
        ))
        candidate_memory_id = str(candidate.candidate_id)
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        self.fixture.model.responses = [self.fixture._candidate(str(self.fixture.draft_id))]
        status, generated = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, generated)
        evidence_path = f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence"
        self.assertIn(candidate_memory_id, [item["evidence_id"] for item in self.fixture.backend.request(evidence_path)[1]["evidence"]])
        status, discarded = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/memory-candidates/{candidate_memory_id}/discard", {},
        )
        self.assertEqual(status, 200, discarded)
        status, history = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, history)
        self.assertEqual(history["turns"][0]["state"], "completed")
        change = [{"evidence_id": candidate_memory_id, "kind": "pending_candidate", "reason": "memory_revised"}]
        self.assertEqual(history["turns"][0]["basis_changes"], change)
        candidate_id = generated["candidates"][0]["candidate_id"]
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        status, continued = self.fixture.backend.request(self.path + "/continue", {
            "idempotency_key": str(uuid4()), "expected_input_version_id": generated["input_version_id"],
            "instruction": "第一条简短一点", "intention_update": "合成问候，这次只打招呼",
            "displayed_group": {"session_id": str(self.session_id), "candidate_group_id": generated["reply_request_id"],
                "candidates": [{"number": 1, "candidate_id": candidate_id, "version_id": candidate_id}]},
        })
        self.assertEqual(status, 200, continued)
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertNotIn(candidate_memory_id, [item["evidence_id"] for item in payload["evidence"]])
        self.assertEqual(payload["continuation_reference"]["basis_changes"], change)

    def test_confirmed_pending_basis_keeps_completed_body_and_continue_uses_confirmed_memory(self) -> None:
        text = "合成待确认偏好：喜欢散步，希望表达轻松自然。"
        source_id, message_id = self.fixture._source(text)
        candidate = PostgresMemoryStore(session_fixture.DATABASE_URL).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text=text, category=MemoryCategory.PREFERENCE,
            source_ids=(UUID(message_id),),
        ))
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        self.fixture.model.responses = [self.fixture._candidate(str(self.fixture.draft_id))]
        status, generated = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, generated)
        status, original = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence",
        )
        self.assertEqual(status, 200, original)
        self.assertIn(str(candidate.candidate_id), [item["evidence_id"] for item in original["evidence"]])
        status, confirmed = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        self.assertEqual(status, 200, confirmed)
        status, history = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, history)
        self.assertEqual(history["turns"][0]["state"], "completed")
        self.assertEqual(history["turns"][0]["reply"]["candidates"], generated["candidates"])
        change = [{"evidence_id": str(candidate.candidate_id), "kind": "pending_candidate", "reason": "memory_revised"}]
        self.assertEqual(history["turns"][0]["basis_changes"], change)
        memory_id = confirmed["memory"]["memory_id"]
        self.fixture.model.responses.append(self.fixture._candidate(memory_id))
        status, continued = self.fixture.backend.request(self.path + "/continue", self._continue_command(
            generated, intent="喜欢散步，希望表达轻松自然，先轻松问候。",
        ))
        self.assertEqual(status, 200, continued)
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertNotIn(str(candidate.candidate_id), [item["evidence_id"] for item in payload["evidence"]])
        self.assertIn(memory_id, [item["evidence_id"] for item in payload["evidence"]])
        self.assertEqual(payload["continuation_reference"]["basis_changes"], change)
        self.fixture._delete_source(source_id)
        self.assertTrue(all(turn["reply"] is None for turn in self.fixture.backend.request(self.path)[1]["turns"]))

    def test_interrupted_continue_restores_saved_intent_with_fresh_basis_and_source_delete_blocks_recovery(self) -> None:
        text = "喜欢散步，希望表达轻松自然。"
        source_id, _, memory_id = self._source_memory(text)
        self.fixture.model.responses = [self.fixture._candidate(memory_id)]
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        status, parent = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, parent)
        command = self._continue_command(parent, intent="愿意聊聊散步，保持轻松自然，先不承诺安排。")
        status, prepared = self.fixture.backend.request(self.path + "/continue/prepare", command)
        self.assertEqual(status, 200, prepared)
        self.fixture.model.responses.append(self.fixture._candidate(memory_id))
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(self.fixture.backend.request, self.path + "/continue", command)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                status, corrected = self.fixture.backend.request(
                    f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct",
                    {"text": "喜欢慢慢散步，希望表达轻松自然。"},
                )
                self.assertEqual(status, 200, corrected)
                status, interrupted = self.fixture.backend.request(self.path + "/interrupt", {
                    "request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"],
                })
                self.assertEqual(status, 200, interrupted)
                self.assertEqual(interrupted["interruption_reason"], "app_quit")
            finally:
                gate.set()
            self.assertNotEqual(request.result(timeout=10)[0], 200)
        original = self.fixture.backend.request(self.path)[1]["turns"][-1]
        self.assertEqual(original["state"], "failed")
        self.assertEqual(original["input"]["content"]["draft_text"], command["intention_update"])
        retry = {"original_turn_id": prepared["turn_id"], "original_input_version_id": prepared["input_version_id"],
                 "request_key": str(uuid4())}
        calls = len(self.fixture.model.seen_calls)
        status, retry_prepared = self.fixture.backend.request(self.path + "/retry-interrupted/prepare", retry)
        self.assertEqual(status, 200, retry_prepared)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        self.fixture.model.responses.append(self.fixture._candidate(corrected["memory"]["memory_id"]))
        status, recovered = self.fixture.backend.request(self.path + "/retry-interrupted", retry)
        self.assertEqual(status, 200, recovered)
        self.assertEqual(recovered["turn_id"], retry_prepared["turn_id"])
        self.assertEqual(recovered["restored_input"]["content"], original["input"]["content"])
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertEqual(payload["draft_text"], command["intention_update"])
        self.assertEqual(payload["continuation_reference"]["basis_changes"], [{
            "evidence_id": memory_id, "kind": "confirmed_memory", "reason": "memory_revised",
        }])
        self.assertIn(corrected["memory"]["memory_id"], recovered["context_receipt"]["evidence_ids"])
        self.assertEqual(self.fixture.backend.request(self.path + "/retry-interrupted", retry), (200, recovered))
        self.assertEqual(len(self.fixture.model.seen_calls), calls + 1)
        self.fixture._delete_source(source_id)
        for payload in (retry, {**retry, "request_key": str(uuid4())}):
            for suffix in ("/retry-interrupted/prepare", "/retry-interrupted"):
                self.assertNotEqual(self.fixture.backend.request(self.path + suffix, payload)[0], 200)
        self.assertEqual(len(self.fixture.model.seen_calls), calls + 1)
        self.assertTrue(all(turn["state"] == "redacted" and turn["reply"] is None and turn["input"] is None
                            for turn in self.fixture.backend.request(self.path)[1]["turns"]))

    def test_corrected_contact_memory_keeps_edited_history_and_explicit_continue_uses_new_basis(self) -> None:
        self._corrected_memory_keeps_history_and_continues("contact")

    def test_corrected_owner_memory_keeps_edited_history_and_explicit_continue_uses_new_basis(self) -> None:
        self._corrected_memory_keeps_history_and_continues("owner")

    def _corrected_memory_keeps_history_and_continues(self, kind: str) -> None:
        memory_id, _, generated = self._generate(kind)
        candidate_id = generated["candidates"][0]["candidate_id"]
        versions_path = self.path + f"/candidates/{candidate_id}/versions"
        edit = {"edit_key": str(uuid4()), "parent_version_id": candidate_id,
                "messages": [{"message_id": generated["candidates"][0]["messages"][0]["message_id"],
                              "text": "用户合成编辑：愿意聊聊，先不作承诺。"}]}
        status, edited = self.fixture.backend.request(versions_path, edit)
        self.assertEqual(status, 200, edited)
        edited_version = edited["versions"][-1]
        correction_path = (f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct"
                           if kind == "contact" else f"/api/memories/owner/{memory_id}/correct")
        status, corrected = self.fixture.backend.request(
            correction_path, {"text": "我喜欢慢慢散步，希望表达轻松自然。"},
        )
        self.assertEqual(status, 200, corrected)
        new_memory_id = corrected["memory"]["memory_id"]
        calls = len(self.fixture.model.seen_calls)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][-1]["state"], "completed")
        expected_change = [{"evidence_id": str(memory_id),
                            "kind": "confirmed_memory" if kind == "contact" else "owner_memory",
                            "reason": "memory_revised"}]
        self.assertEqual(saved["turns"][-1]["basis_changes"], expected_change)
        status, history = self.fixture.backend.request(versions_path)
        self.assertEqual(status, 200, history)
        self.assertEqual(history["versions"], edited["versions"])
        self.assertEqual(history["basis_changes"], expected_change)
        status, basis = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence",
        )
        self.assertEqual(status, 200, basis)
        self.assertEqual(basis["basis_changes"], expected_change)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        self.fixture.model.responses.append(self.fixture._candidate(new_memory_id))
        command = {
            "idempotency_key": str(uuid4()), "expected_input_version_id": generated["input_version_id"],
            "instruction": "第一条简短一点", "intention_update": "愿意聊聊散步，希望轻松自然，先不作承诺",
            "displayed_group": {"session_id": str(self.session_id),
                                "candidate_group_id": generated["reply_request_id"],
                                "candidates": [{"number": 1, "candidate_id": candidate_id,
                                                "version_id": edited_version["version_id"]}]},
        }
        status, preparation = self.fixture.backend.request(self.path + "/continue/prepare", command)
        self.assertEqual(status, 200, preparation)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        status, continued = self.fixture.backend.request(self.path + "/continue", command)
        self.assertEqual(status, 200, continued)
        self.assertNotEqual(continued["reply_request_id"], generated["reply_request_id"])
        self.assertIn(new_memory_id, continued["context_receipt"]["evidence_ids"])
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertEqual(payload["draft_text"], "愿意聊聊散步，希望轻松自然，先不作承诺")
        self.assertEqual(payload["continuation_reference"]["basis_changes"], expected_change)
        self.assertEqual(payload["continuation_reference"]["messages"], edited_version["messages"])
        memory_evidence = [item for item in payload["evidence"]
                           if item["kind"] in ("confirmed_memory", "owner_memory")]
        self.assertNotIn(str(memory_id), [item["evidence_id"] for item in memory_evidence])
        self.assertIn(new_memory_id, [item["evidence_id"] for item in memory_evidence])
        self.assertEqual(self.fixture.backend.request(versions_path)[1]["versions"], edited["versions"])

    def test_expired_candidate_can_be_carried_explicitly_and_new_reply_retrieves_fresh_basis(self) -> None:
        memory_id, _, generated = self._generate("contact")
        candidate_id = generated["candidates"][0]["candidate_id"]
        self._set_period("contact", memory_id, expired=True)
        status, selected = self.fixture.backend.request(self.path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": candidate_id,
        })
        self.assertEqual(status, 200, selected)
        calls = len(self.fixture.model.seen_calls)
        status, carried = self.fixture.backend.request(self.path + "/new-with-candidate", {
            "expected_selection_id": selected["selection_id"], "candidate_id": candidate_id,
            "version_id": candidate_id,
        })
        self.assertEqual(status, 200, carried)
        child_path = self.fixture._path(carried["session_id"])
        status, saved = self.fixture.backend.request(child_path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["inputs"][0]["content"]["messages"], generated["candidates"][0]["messages"])
        self.assertEqual(saved["inputs"][0]["basis_changes"], [{
            "evidence_id": str(memory_id), "kind": "confirmed_memory", "reason": "memory_expired",
        }])
        self.assertEqual(saved["turns"], [])
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        body = self.fixture._body(draft="本次愿意聊聊散步，保持轻松自然。")
        body["content"]["include_relationship_context"] = True
        body["expected_input_version_id"] = carried["input_version_id"]
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        status, continued = self.fixture.backend.request(child_path + "/replies", body)
        self.assertEqual(status, 200, continued)
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertNotIn(str(memory_id), [item["evidence_id"] for item in payload["evidence"]])
        self.assertEqual(payload["assistant_discussion"]["items"][0]["basis_changes"],
                         saved["inputs"][0]["basis_changes"])

    def test_basis_change_after_historical_reference_read_rejects_late_result_and_retry_recaptures(self) -> None:
        memory_id, _, generated = self._generate("contact")
        candidate_id = generated["candidates"][0]["candidate_id"]
        command = {"idempotency_key": str(uuid4()), "expected_input_version_id": generated["input_version_id"],
                   "instruction": "第一条简短一点", "intention_update": "合成问候，这次只打招呼",
                   "displayed_group": {"session_id": str(self.session_id),
                                       "candidate_group_id": generated["reply_request_id"],
                                       "candidates": [{"number": 1, "candidate_id": candidate_id,
                                                       "version_id": candidate_id}]}}
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(self.fixture.backend.request, self.path + "/continue", command)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                status, corrected = self.fixture.backend.request(
                    f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct",
                    {"text": "我喜欢慢慢散步，希望表达轻松自然。"},
                )
                self.assertEqual(status, 200, corrected)
            finally:
                gate.set()
            self.assertNotEqual(request.result(timeout=10)[0], 200)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "completed")
        self.assertEqual(saved["turns"][-1]["state"], "failed")
        self.assertIsNone(saved["turns"][-1]["reply"])
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        status, retried = self.fixture.backend.request(self.path + "/continue", command)
        self.assertEqual(status, 200, retried)
        payload = next(json.loads(message.content) for message in self.fixture.model.seen_calls[-1]
                       if isinstance(message, HumanMessage))
        self.assertEqual(payload["draft_text"], command["intention_update"])
        self.assertEqual(payload["continuation_reference"]["basis_changes"], [{
            "evidence_id": str(memory_id), "kind": "confirmed_memory", "reason": "memory_revised",
        }])
        self.assertEqual(len(self.fixture.backend.request(self.path)[1]["turns"]), 2)


    def _source_deletion_order(self, *, source_first: bool, subject: FactSubject) -> None:
        text = "合成来源偏好：喜欢散步，希望表达轻松自然。"
        source_id, _, memory_id = self._source_memory(text, subject=subject)
        self.fixture.model.responses = [self.fixture._candidate(memory_id)]
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        status, generated = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, generated)
        candidate_id = generated["candidates"][0]["candidate_id"]
        versions_path = self.path + f"/candidates/{candidate_id}/versions"
        status, edited = self.fixture.backend.request(versions_path, {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": [{"message_id": generated["candidates"][0]["messages"][0]["message_id"],
                          "text": "合成用户编辑：愿意聊聊，先不承诺安排。"}],
        })
        self.assertEqual(status, 200, edited)
        version_id = edited["versions"][-1]["version_id"]
        correction_path = (f"/api/memories/owner/{memory_id}/correct" if subject == FactSubject.SELF
                           else f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct")
        status, corrected = self.fixture.backend.request(correction_path, {"text": "合成修正偏好：喜欢慢慢散步，保持轻松自然。"})
        self.assertEqual(status, 200, corrected)
        self.assertEqual(self.fixture.backend.request(versions_path)[1]["versions"], edited["versions"])
        status, selection = self.fixture.backend.request(self.path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": version_id,
        })
        self.assertEqual(status, 200, selection)
        status, carried = self.fixture.backend.request(self.path + "/new-with-candidate", {
            "expected_selection_id": selection["selection_id"], "candidate_id": candidate_id, "version_id": version_id,
        })
        self.assertEqual(status, 200, carried)
        child_path = self.fixture._path(carried["session_id"])
        self.assertEqual(self.fixture.backend.request(child_path)[1]["inputs"][0]["content"]["messages"], edited["versions"][-1]["messages"])
        command = self._continue_command(generated, version_id=version_id)
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(self.fixture.backend.request, self.path + "/continue", command)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                if source_first:
                    self.fixture._delete_source(source_id)
            finally:
                gate.set()
            status, continued = request.result(timeout=10)
        if source_first:
            self.assertNotEqual(status, 200, continued)
        else:
            self.assertEqual(status, 200, continued)
            self.fixture._delete_source(source_id)
        calls = len(self.fixture.model.seen_calls)
        status, erased = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, erased)
        self.assertEqual([turn["state"] for turn in erased["turns"]], ["redacted", "redacted"])
        self.assertTrue(all(turn["input"] is None and turn["reply"] is None and not turn["basis_changes"]
                            for turn in erased["turns"]))
        carried_input = self.fixture.backend.request(child_path)[1]["inputs"][0]
        self.assertEqual(carried_input["state"], "redacted")
        self.assertIsNone(carried_input["content"])
        self.assertEqual(self.fixture.backend.request(versions_path), (404, {"error": "not_found"}))
        evidence_path = f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence"
        self.assertEqual(self.fixture.backend.request(evidence_path), (404, {"error": "not_found"}))
        for suffix, payload in (("/replies", body), ("/continue", command), ("/continue/prepare", command)):
            self.assertNotEqual(self.fixture.backend.request(self.path + suffix, payload)[0], 200)
        self.fixture._delete_source(source_id)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        with psycopg.connect(session_fixture.DATABASE_URL) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.fixture.owner_id,)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_context_evidence WHERE owner_id=%s", (self.fixture.owner_id,)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.assistant_candidate_version WHERE owner_id=%s", (self.fixture.owner_id,)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.message WHERE owner_id=%s", (self.fixture.owner_id,)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT content, dependency_ids FROM public.assistant_session_input WHERE owner_id=%s", (self.fixture.owner_id,)).fetchall(),
                             [(None, []), (None, []), (None, [])])
