"""公开回环 HTTP 与隔离 PostgreSQL 验证人工决定不会被旧证据覆盖。

输入只使用合成来源和受控提取结果，业务结果从现有记忆 HTTP 入口读取。
"""

import threading
import time
import unittest
from datetime import datetime, timezone
from uuid import uuid4
from uuid import UUID
from unittest.mock import patch

import psycopg
from psycopg import sql

from notalone.application.memory_service import MemoryService
from notalone.memory.models import FactSubject, MemoryCandidate, MemoryCategory, MemoryTopic
from notalone.memory.models import AdoptionMethod
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.locks import release_global_worker_lock, try_acquire_global_worker_lock
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository, SourceDeletionVerificationError
from psycopg.types.json import Jsonb
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.evidence import build_dimension_evidence
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
from tests.integration.server import test_import_auto_flow as auto_support
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, HttpBackend, tool_response,
)


class MemoryCorrectionProtectionHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    def setUp(self):
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '纠错合成用户')",
                (self.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, '纠错合成联系人')",
                (self.owner_id, self.contact_id),
            )
        self.store = PostgresMemoryStore(self.database_url)
        self.backend = self._open_backend()
        self.message_id, self.source_id = self._source("我喝咖啡只是工作需要。")

    def _open_backend(self, owner_id=None):
        owner_id = owner_id or self.owner_id
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token="synthetic-correction",
            memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(self.database_url),
                owner_memory=PostgresOwnerMemoryStore(self.database_url),
            ),
        ), owner_id)
        self.addCleanup(backend.close)
        return backend

    def _source(self, text, scope=None):
        scope = scope or self.scope
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1)",
                (source_id, scope.owner_id, scope.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message "
                "(id, owner_id, contact_id, speaker, message_type, text_content, occurred_at) "
                "VALUES (%s, %s, %s, 'contact', 'text', %s, now())",
                (message_id, scope.owner_id, scope.contact_id, text),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, 'synthetic:1', '{}'::jsonb)",
                (message_id, scope.owner_id, scope.contact_id, source_id),
            )
        return message_id, source_id

    def _candidate(self, text, **overrides):
        values = dict(
            candidate_id=uuid4(), scope=self.scope, text=text,
            category=MemoryCategory.PREFERENCE, source_ids=(self.message_id,),
        )
        values.update(overrides)
        return self.store.create_candidate(MemoryCandidate(**values))

    def _window_evidence(self, text, subject=FactSubject.CONTACT):
        messages = load_contact_messages(self.scope, self.database_url)
        fact = ExtractedFact(
            text=text, category=MemoryCategory.PREFERENCE, subject=subject,
            topic=MemoryTopic.OTHER, source_message_ids=(self.message_id,), confidence=0.95,
        )
        return build_dimension_evidence(ExtractionWindow(
            self.owner_id, self.contact_id, messages,
        ), fact, None)

    def _alias_source(self, message_id):
        source_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-alias.jsonl', %s, 1)",
                (source_id, self.owner_id, self.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, 'synthetic:alias', '{}'::jsonb)",
                (message_id, self.owner_id, self.contact_id, source_id),
            )
        return source_id

    def _assert_erased(self, *markers, preserved_record_ids=()):
        # 全表所有字段审计本用户及无 owner 字段副本；其他用户的合法同文不能被删除。
        with psycopg.connect(self.database_url) as connection:
            tables = connection.execute(
                "SELECT tablename FROM pg_tables WHERE schemaname='public'",
            ).fetchall()
            for (table,) in tables:
                for marker in markers:
                    remaining = connection.execute(
                        sql.SQL("SELECT EXISTS (SELECT 1 FROM public.{} AS data "
                                "WHERE (NOT to_jsonb(data) ? 'owner_id' OR to_jsonb(data)->>'owner_id'=%s) "
                                "AND NOT COALESCE(to_jsonb(data)->>'id', '')=ANY(%s::text[]) "
                                "AND to_jsonb(data)::text LIKE %s)").format(sql.Identifier(table)),
                        (str(self.owner_id), list(preserved_record_ids), f"%{marker}%"),
                    ).fetchone()[0]
                    self.assertFalse(remaining, f"来源删除后仍有正文副本：{table}")

    def _request(self, suffix, body=None):
        status, payload = self.backend.request(
            f"/api/contacts/{self.contact_id}/{suffix}", body,
        )
        self.assertEqual(status, 200, payload)
        return payload

    def _delete_source(self, source_id):
        status, response = self.backend.request(
            f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE",
        )
        self.assertEqual(status, 202, response)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            sources = self._request("sources")["sources"]
            state = next(row["status"] for row in sources if row["source_id"] == str(source_id))
            if state == "deleted":
                return
            if state == "delete_requested":
                status, task = self.backend.request(
                    f"/api/tasks/status?contact_id={self.contact_id}&task_id={response['task_id']}",
                )
                self.assertEqual(status, 200, task)
                if task["status"] == "queued":
                    status, duplicate = self.backend.request(
                        f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE",
                    )
                    self.assertEqual(status, 202, duplicate)
                    self.assertEqual(duplicate["task_id"], response["task_id"])
            threading.Event().wait(0.02)
        self.fail(f"合成来源删除未完成：{state}")

    def _failure_trigger(self, operation):
        self.assertIn(operation, ("INSERT", "DELETE"))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""CREATE FUNCTION correction_test_failure() RETURNS trigger
                LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '合成事务失败'; END; $$""")
            connection.execute(sql.SQL("CREATE TRIGGER correction_test_failure BEFORE {} "
                "ON public.memory_correction_decision FOR EACH ROW EXECUTE FUNCTION correction_test_failure()")
                .format(sql.SQL(operation)))
        self.addCleanup(self._release_failure_trigger)

    def _release_failure_trigger(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DROP TRIGGER IF EXISTS correction_test_failure ON public.memory_correction_decision")
            connection.execute("DROP FUNCTION IF EXISTS correction_test_failure()")

    def test_corrected_old_evidence_cannot_publish_paraphrase_after_restart(self):
        wrong = self._candidate("联系人喜欢咖啡。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        corrected = self._request(f"memories/{original['memory_id']}/correct", {
            "text": "联系人喝咖啡只是工作需要。",
        })["memory"]
        self.store = PostgresMemoryStore(self.database_url)
        self._candidate("对方偏爱喝咖啡。")
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        self.assertEqual(
            [row["memory_id"] for row in self._request("memories")["memories"]],
            [corrected["memory_id"]],
        )

    def test_rejection_protects_old_evidence_despite_category_topic_and_subject_change(self):
        rejected = self._candidate("联系人喜欢咖啡。")
        self._request(f"memory-candidates/{rejected.candidate_id}/discard", {})
        self.store = PostgresMemoryStore(self.database_url)
        for subject in (FactSubject.CONTACT, FactSubject.SELF, FactSubject.SHARED):
            self._candidate(
                "经常喝咖啡是其口味偏好。", subject=subject,
                category=MemoryCategory.RELATIONSHIP_NOTE, topic=MemoryTopic.WORK,
            )
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_candidate_saved_before_correction_is_hidden_and_cannot_be_confirmed(self):
        wrong = self._candidate("联系人喜欢咖啡。")
        late = self._candidate("咖啡是对方爱喝的饮品。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._request(f"memories/{original['memory_id']}/correct", {
            "text": "联系人喝咖啡只是工作需要。",
        })
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        status, result = self.backend.request(
            f"/api/contacts/{self.contact_id}/memory-candidates/{late.candidate_id}/confirm", {},
        )
        self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))

    def test_genuinely_new_message_is_pending_with_previous_user_decision(self):
        wrong = self._candidate("联系人喜欢咖啡。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        corrected = self._request(f"memories/{original['memory_id']}/correct", {
            "text": "联系人喝咖啡只是工作需要。",
        })["memory"]
        new_message, new_source = self._source("现在我开始喜欢咖啡了。")
        current = self._candidate("联系人喜欢咖啡。", source_ids=(new_message,))
        pending = self._request("memory-candidates")["candidates"]
        self.assertEqual([row["candidate_id"] for row in pending], [str(current.candidate_id)])
        review = pending[0]["correction_review"][0]
        self.assertEqual(review["decision"], "corrected")
        self.assertEqual(review["previous_text"], "联系人喜欢咖啡。")
        self.assertEqual(review["corrected_text"], "联系人喝咖啡只是工作需要。")
        self.assertEqual(review["new_message_ids"], [str(new_message)])
        self.assertEqual(review["new_source_ids"], [str(new_source)])
        self.assertEqual(
            [row["memory_id"] for row in self._request("memories")["memories"]],
            [corrected["memory_id"]],
        )

    def test_source_deletion_erases_decision_and_derived_comparison(self):
        wrong = self._candidate("纠错私密旧主张：对方喜欢咖啡。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._request(f"memories/{original['memory_id']}/correct", {"text": "纠错私密人工解释：只是工作需要。"})
        fresh_message, _ = self._source("新的合成证据。")
        self._candidate("新证据待审核。", source_ids=(fresh_message,))
        self.assertTrue(self._request("memory-candidates")["candidates"][0]["correction_review"])
        self._delete_source(self.source_id)
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        self.assertEqual(self._request("memories")["memories"], [])

    def test_queued_context_deletion_hides_old_comparison_and_refuses_late_confirmation(self):
        self._assert_queued_correction_hidden(FactSubject.CONTACT)

    def test_queued_self_context_deletion_hides_old_comparison_and_refuses_late_confirmation(self):
        self._assert_queued_correction_hidden(FactSubject.SELF)

    def test_queued_context_deletion_hides_new_memory_confirmed_with_old_comparison(self):
        self._assert_queued_correction_hidden(FactSubject.CONTACT, confirm_new=True)

    def test_queued_self_context_deletion_hides_new_memory_confirmed_with_old_comparison(self):
        self._assert_queued_correction_hidden(FactSubject.SELF, confirm_new=True)

    def _assert_queued_correction_hidden(self, subject, *, confirm_new=False):
        _, context_source = self._source("排队删除的合成上下文。")
        wrong = self._candidate("排队删除私密旧错误。", subject=subject,
                                dimension_evidence=self._window_evidence("排队删除私密旧错误。", subject))
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        prefix = ("/api/memories/owner" if subject is FactSubject.SELF
                  else f"/api/contacts/{self.contact_id}/memories")
        status, result = self.backend.request(prefix + f"/{original['memory_id']}/correct", {
            "text": "排队删除私密人工判断。",
        })
        self.assertEqual(status, 200, result)
        fresh, _ = self._source("另一条仍活动的新证据。")
        candidate = self._candidate("应随旧比较暂时撤下的候选。", subject=subject, source_ids=(fresh,))
        review = self._request("memory-candidates")["candidates"][0]["correction_review"]
        if confirm_new:
            self._request(f"memory-candidates/{candidate.candidate_id}/confirm", {
                "correction_decision_ids": [row["decision_id"] for row in review],
            })
            self.assertEqual(len(self._get(self.backend, prefix)["memories"]), 2)
        with psycopg.connect(self.database_url, autocommit=True) as lock:
            self.assertTrue(try_acquire_global_worker_lock(lock))
            try:
                status, deletion = self.backend.request(
                    f"/api/contacts/{self.contact_id}/sources/{context_source}", method="DELETE",
                )
                self.assertEqual(status, 202, deletion)
                status, task = self.backend.request(
                    f"/api/tasks/status?contact_id={self.contact_id}&task_id={deletion['task_id']}",
                )
                self.assertEqual(status, 200, task)
                self.assertEqual(task["status"], "queued")
                self.assertEqual(self._request("memory-candidates")["candidates"], [])
                status, memories = self.backend.request(prefix)
                self.assertEqual(status, 200, memories)
                self.assertEqual(memories["memories"], [])
                status, result = self.backend.request(
                    f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm",
                    {"correction_decision_ids": [row["decision_id"] for row in review]},
                )
                self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))
            finally:
                release_global_worker_lock(lock)
        self._delete_source(context_source)
        self._assert_erased("排队删除私密旧错误", "排队删除私密人工判断", "应随旧比较暂时撤下的候选")

    def test_deleted_context_source_cannot_commit_cached_extraction(self):
        _, context_source = self._source("仅作上下文的合成私密解释。")
        cached = self._window_evidence("来自已删上下文的迟到候选。")
        self._delete_source(context_source)
        with self.assertRaises(MemoryCorrectionConflictError):
            self._candidate("来自已删上下文的迟到候选。", dimension_evidence=cached)
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_changed_source_generation_cannot_be_recaptured_as_fresh_cached_window(self):
        text = "旧窗口来源已变化的迟到合成候选。"
        cached = self._window_evidence(text)
        self.assertTrue(all(item.source_state_sha256 is not None for item in cached.messages))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET content_sha256=%s WHERE owner_id=%s AND id=%s",
                               (uuid4().hex * 2, self.owner_id, self.source_id))
        with self.assertRaises(MemoryCorrectionConflictError):
            self._candidate(text, dimension_evidence=cached)
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_queued_context_deletion_refuses_idempotent_correction_body_replay(self):
        _, context_source = self._source("幂等重放仅作上下文的私密依据。")
        text = "幂等重放的旧合成错误。"
        wrong = self._candidate(text, dimension_evidence=self._window_evidence(text))
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        body = {"text": "不得从幂等请求恢复的私密人工正文。"}
        self._request(f"memories/{original['memory_id']}/correct", body)
        self._request(f"memories/{original['memory_id']}/correct", body)
        with psycopg.connect(self.database_url, autocommit=True) as lock:
            self.assertTrue(try_acquire_global_worker_lock(lock))
            try:
                status, deletion = self.backend.request(f"/api/contacts/{self.contact_id}/sources/{context_source}", method="DELETE")
                self.assertEqual(status, 202, deletion)
                self.assertEqual(self._request("memories")["memories"], [])
                self.assertEqual(self.backend.request(f"/api/contacts/{self.contact_id}/memories/{original['memory_id']}/correct", body),
                                 (409, {"error": "memory_correction_conflict"}))
            finally:
                release_global_worker_lock(lock)

    def test_partial_source_deletion_clears_unreviewed_candidate_source_snapshots(self):
        alias = self._alias_source(self.message_id)
        candidate = self._candidate("共享规范消息的独立合成候选。")
        with psycopg.connect(self.database_url) as connection:
            previous = connection.execute("SELECT correction_evidence FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                                          (self.owner_id, candidate.candidate_id)).fetchone()[0]
        self._delete_source(self.source_id)
        with psycopg.connect(self.database_url) as connection:
            current = connection.execute("SELECT correction_evidence FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                                         (self.owner_id, candidate.candidate_id)).fetchone()[0]
            self.assertNotIn(str(self.source_id), str(current))
            for ref in previous["source_refs"]:
                if ref["source_id"] == str(self.source_id):
                    self.assertNotIn(ref["ref_id"], str(current))
                    self.assertNotIn(ref["digest"], str(current))
            self.assertEqual(connection.execute("SELECT count(*) FROM public.message_source_ref WHERE source_document_id=%s", (alias,)).fetchone()[0], 1)
        self.assertEqual(self.backend.request(f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {}),
                         (409, {"error": "memory_correction_conflict"}))

    def test_partial_source_deletion_refuses_stale_discard_without_restoring_private_decision(self):
        alias = self._alias_source(self.message_id)
        text = "失去原始世代后不能复活的私密丢弃正文。"
        candidate = self._candidate(text)
        self._delete_source(self.source_id)
        self.assertEqual(self.backend.request(
            f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/discard", {},
        ), (409, {"error": "memory_correction_conflict"}))
        self._delete_source(alias)
        self._assert_erased(text)

    def test_current_delete_after_partial_source_erasure_keeps_bodyless_canonical_guard(self):
        alias = self._alias_source(self.message_id)
        text = "部分来源删除后仍须擦除的私密记忆正文。"
        candidate = self._candidate(text)
        memory = self._request(f"memory-candidates/{candidate.candidate_id}/confirm", {})["memory"]
        self._delete_source(self.source_id)
        self.assertEqual(self._request("memories")["memories"][0]["memory_id"], memory["memory_id"])
        self._request(f"memories/{memory['memory_id']}/delete", {})
        self._assert_erased(text)
        for backend in (self.backend, self._open_backend()):
            self._candidate("换说法也不应重生的旧规范消息错误。")
            self.assertEqual(self._get(backend, f"/api/contacts/{self.contact_id}/memory-candidates")["candidates"], [])
        self._delete_source(alias)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.memory_correction_decision WHERE owner_id=%s",
                                                (self.owner_id,)).fetchone()[0], 0)

    def test_new_source_ref_to_old_message_does_not_count_as_new_evidence(self):
        rejected = self._candidate("联系人喜欢咖啡。")
        self._request(f"memory-candidates/{rejected.candidate_id}/discard", {})
        alias = self._alias_source(self.message_id)
        self._candidate("对方偏爱咖啡。", source_ids=(alias,))
        self._candidate("对方对咖啡情有独钟。")
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_confirmation_rechecks_old_review_source_generation(self):
        rejected = self._candidate("需要旧新依据对照的合成错误。")
        self._request(f"memory-candidates/{rejected.candidate_id}/discard", {})
        fresh, _ = self._source("真正新的规范消息合成证据。")
        candidate = self._candidate("需要旧新依据对照的合成错误。", source_ids=(fresh,))
        review = self._request("memory-candidates")["candidates"][0]["correction_review"]
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET content_sha256=%s WHERE owner_id=%s AND id=%s",
                               (uuid4().hex * 2, self.owner_id, self.source_id))
        path = f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm"
        for backend in (self.backend, self._open_backend()):
            self.assertEqual(backend.request(path, {"correction_decision_ids": [row["decision_id"] for row in review]}),
                             (409, {"error": "memory_correction_conflict"}))
            self.assertEqual(self._get(backend, f"/api/contacts/{self.contact_id}/memories")["memories"], [])

    def test_legacy_generation_without_message_snapshots_is_not_backfilled_at_confirmation(self):
        candidate = self._candidate("旧结构世代未知的合成资料。")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=correction_evidence-'message_snapshots' "
                               "WHERE owner_id=%s AND id=%s", (self.owner_id, candidate.candidate_id))
        path = f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm"
        for backend in (self.backend, self._open_backend()):
            self.assertEqual(backend.request(path, {}), (409, {"error": "memory_correction_conflict"}))
            self.assertEqual(self._get(backend, f"/api/contacts/{self.contact_id}/memories")["memories"], [])

    def test_added_alias_does_not_change_the_frozen_participant_generation(self):
        candidate = self._candidate("仅参与原规范消息的合成资料。")
        self._alias_source(self.message_id)
        status, result = self.backend.request(f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["memory"]["source_ids"], [str(self.message_id)])

    def test_context_deletion_erases_decision_even_when_message_has_another_source(self):
        context_message, context_source = self._source("纠错窗口私密解释。")
        evidence = self._window_evidence("纠错窗口私密旧主张。")
        wrong = self._candidate("纠错窗口私密旧主张。", dimension_evidence=evidence)
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._request(f"memories/{original['memory_id']}/correct", {"text": "纠错窗口私密人工判断。"})
        self._alias_source(context_message)
        fresh_message, _ = self._source("新的合成直接证据。")
        self._candidate("有新证据但待核对。", source_ids=(fresh_message,))
        self._delete_source(context_source)
        self.assertEqual(self._request("memories")["memories"], [])
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        self._assert_erased("纠错窗口私密旧主张", "纠错窗口私密人工判断")
        with self.assertRaises(MemoryCorrectionConflictError):
            self._candidate("纠错窗口私密旧主张。", dimension_evidence=evidence)
        # 已删除来源的旧快照无效，但当前活动别名也不能把同一规范消息变成新证据。
        self._alias_source(self.message_id)
        current_text = "同一旧消息的另一种错误说法。"
        self._candidate(current_text, dimension_evidence=self._window_evidence(current_text))
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_self_correction_protects_old_evidence_and_new_evidence_requires_review(self):
        wrong = self._candidate("我喜欢咖啡。", subject=FactSubject.SELF)
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        status, result = self.backend.request(f"/api/memories/owner/{original['memory_id']}/correct", {
            "text": "我喝咖啡只是工作需要。",
        })
        self.assertEqual(status, 200, result)
        self._candidate("本人偏爱喝咖啡。", subject=FactSubject.SELF)
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        fresh_message, _ = self._source("我现在开始喜欢咖啡了。")
        self._candidate("我喜欢咖啡。", subject=FactSubject.SELF, source_ids=(fresh_message,))
        pending = self._request("memory-candidates")["candidates"]
        self.assertEqual(pending[0]["correction_review"][0]["corrected_text"], "我喝咖啡只是工作需要。")

    def test_partial_deletion_restarts_with_minimal_guard_and_last_source_erases_it(self):
        for alias_first in (False, True):
            with self.subTest(alias_first=alias_first):
                message, source = self._source("多来源的合成原始消息。")
                alias = self._alias_source(message)
                wrong = self._candidate("多来源私密旧错误。", source_ids=(message,))
                original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
                self._request(f"memories/{original['memory_id']}/correct", {"text": "多来源私密人工判断。"})
                first, last = (alias, source) if alias_first else (source, alias)
                self._delete_source(first)
                self._assert_erased("多来源私密旧错误", "多来源私密人工判断")
                self.backend = self._open_backend()
                self.store = PostgresMemoryStore(self.database_url)
                self._candidate("仍活动旧消息上的改写。", source_ids=(message,))
                self.assertEqual(self._request("memory-candidates")["candidates"], [])
                with psycopg.connect(self.database_url) as connection:
                    rows = connection.execute("SELECT evidence,rejected_text,corrected_text FROM public.memory_correction_decision WHERE owner_id=%s",
                                              (self.owner_id,)).fetchall()
                self.assertEqual(rows, [({"version": 1, "kind": "erased_guard", "canonical_ids": [str(message)]}, None, None)])
                fresh, _ = self._source("全新的合成原始消息。")
                fresh_candidate = self._candidate("独立新规范消息候选。", source_ids=(fresh,))
                review = self._request("memory-candidates")["candidates"][0]["correction_review"]
                self.assertEqual(review[0]["previous_text"], "原资料已删除；旧证据上的人工否决继续有效。")
                self._request(f"memory-candidates/{fresh_candidate.candidate_id}/confirm", {
                    "correction_decision_ids": [row["decision_id"] for row in review],
                })
                self._delete_source(last)
                self._delete_source(first)
                with psycopg.connect(self.database_url) as connection:
                    remaining = connection.execute("SELECT count(*) FROM public.memory_correction_decision WHERE owner_id=%s", (self.owner_id,)).fetchone()[0]
                self.assertEqual(remaining, 0)
                self.assertEqual(self._request("memories")["memories"], [])
                self._assert_erased("多来源私密旧错误", "多来源私密人工判断", "独立新规范消息候选")

    def test_self_candidate_saved_before_correction_cannot_be_confirmed_late(self):
        wrong = self._candidate("我喜欢咖啡。", subject=FactSubject.SELF)
        late = self._candidate("本人偏爱咖啡。", subject=FactSubject.SELF)
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self.backend.request(f"/api/memories/owner/{original['memory_id']}/correct", {"text": "我喝咖啡只是工作需要。"})
        status, result = self.backend.request(
            f"/api/contacts/{self.contact_id}/memory-candidates/{late.candidate_id}/confirm", {},
        )
        self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))

    def test_pending_before_correction_inherits_comparison_deletion_dependency(self):
        wrong = self._candidate("被纠正的旧错误。")
        fresh_message, _ = self._source("真正的新合成证据。")
        self._candidate("新证据下仍需核对的结论。", source_ids=(fresh_message,))
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._request(f"memories/{original['memory_id']}/correct", {"text": "用户新的人工判断。"})
        self.assertTrue(self._request("memory-candidates")["candidates"][0]["correction_review"])
        self._delete_source(self.source_id)
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_confirmation_requires_current_decision_and_replays_one_version(self):
        wrong = self._candidate("联系人喜欢咖啡。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        corrected = self._request(f"memories/{original['memory_id']}/correct", {
            "text": "联系人喝咖啡只是工作需要。",
        })["memory"]
        new_message, _ = self._source("现在我开始喜欢咖啡了。")
        fresh = self._candidate("联系人喜欢咖啡。", source_ids=(new_message,))
        pending = self._request("memory-candidates")["candidates"][0]
        path = f"/api/contacts/{self.contact_id}/memory-candidates/{fresh.candidate_id}/confirm"
        for body in ({}, {"correction_decision_ids": []}, {"correction_decision_ids": [str(uuid4())]}):
            status, result = self.backend.request(path, body)
            self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))
        body = {"correction_decision_ids": [item["decision_id"] for item in pending["correction_review"]]}
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        status, replay = self.backend.request(path, body)
        self.assertEqual(status, 200, replay)
        self.assertEqual(result["memory"]["memory_id"], replay["memory"]["memory_id"])
        self.assertEqual(result["memory"]["adoption_method"], "manual")
        self.assertEqual(len(self._request("memories")["memories"]), 2)
        self.assertIn(corrected["memory_id"], [item["memory_id"] for item in self._request("memories")["memories"]])

    def test_confirmation_accepts_complete_review_after_more_than_one_hundred_decisions(self):
        corrected_ids = []
        for index in range(101):
            status, original = self.backend.request("/api/memories/manual-contact", {
                "contact_id": str(self.contact_id), "category": "common_fact",
                "text": f"第{index}条合成人工旧主张。",
            })
            self.assertEqual(status, 200, original)
            corrected = self._request(f"memories/{original['memory']['memory_id']}/correct", {
                "text": f"第{index}条合成人工纠正。",
            })["memory"]
            corrected_ids.append(corrected["memory_id"])
        fresh_message, _ = self._source("这是人工纠正之后的真正新规范消息。")
        fresh = self._candidate("有新依据需要人工确认的合成主张。", source_ids=(fresh_message,))
        pending = self._request("memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        decision_ids = [row["decision_id"] for row in pending[0]["correction_review"]]
        self.assertEqual(len(decision_ids), 101)
        path = f"/api/contacts/{self.contact_id}/memory-candidates/{fresh.candidate_id}/confirm"
        status, result = self.backend.request(path, {"correction_decision_ids": decision_ids[:100]})
        self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))
        body = {"correction_decision_ids": decision_ids}
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        status, replay = self.backend.request(path, body)
        self.assertEqual(status, 200, replay)
        self.assertEqual(result["memory"]["memory_id"], replay["memory"]["memory_id"])
        memories = self._request("memories")["memories"]
        self.assertEqual(len(memories), 102)
        self.assertTrue(set(corrected_ids).issubset(row["memory_id"] for row in memories))

    def test_explicit_manual_addition_remains_available_after_correction(self):
        wrong = self._candidate("联系人喜欢咖啡。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._request(f"memories/{original['memory_id']}/correct", {"text": "只是工作需要。"})
        status, response = self.backend.request("/api/memories/manual-contact", {
            "contact_id": str(self.contact_id), "text": "用户主动补充另一条合成资料。", "category": "common_fact",
        })
        self.assertEqual(status, 200, response)
        self.assertEqual(response["memory"]["adoption_method"], "manual")
        self.assertEqual(len(self._request("memories")["memories"]), 2)

    def test_manual_contact_correction_still_requires_review_of_new_canonical_evidence(self):
        self._assert_manual_correction_review(FactSubject.CONTACT)

    def test_current_correction_of_independent_legacy_manual_entry_does_not_require_old_extraction_proof(self):
        status, original = self.backend.request("/api/memories/manual-contact", {
            "contact_id": str(self.contact_id), "text": "明确独立手录根的旧合成正文。", "category": "preference",
        })
        self.assertEqual(status, 200, original)
        with psycopg.connect(self.database_url) as connection:
            candidate_id = connection.execute("SELECT source_candidate_id FROM public.confirmed_memory WHERE owner_id=%s AND id=%s",
                                              (self.owner_id, UUID(original["memory"]["memory_id"]))).fetchone()[0]
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL WHERE owner_id=%s AND id=%s",
                               (self.owner_id, candidate_id))
        corrected = self._request(f"memories/{original['memory']['memory_id']}/correct", {
            "text": "当前本人主动纠正独立手录根。",
        })["memory"]
        self.assertEqual(self._request("memories")["memories"][0]["memory_id"], corrected["memory_id"])
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute("SELECT correction_evidence FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                                                (self.owner_id, candidate_id)).fetchone()[0])

    def test_manual_self_correction_still_requires_review_of_new_canonical_evidence(self):
        self._assert_manual_correction_review(FactSubject.SELF)

    def _assert_manual_correction_review(self, subject):
        is_self = subject is FactSubject.SELF
        original_text = "我喜欢咖啡。" if is_self else "联系人喜欢咖啡。"
        corrected_text = "我喝咖啡只是工作需要。" if is_self else "联系人喝咖啡只是工作需要。"
        status, original = self.backend.request(
            "/api/memories/manual-owner" if is_self else "/api/memories/manual-contact",
            {"text": original_text, "category": "preference",
             **({} if is_self else {"contact_id": str(self.contact_id)})},
        )
        self.assertEqual(status, 200, original)
        path = "/api/memories/owner" if is_self else f"/api/contacts/{self.contact_id}/memories"
        status, corrected = self.backend.request(
            path + f"/{original['memory']['memory_id']}/correct", {"text": corrected_text},
        )
        self.assertEqual(status, 200, corrected)
        fresh, source = self._source("这是纠正之后的新规范消息：现在开始喜欢咖啡了。")
        candidate = self._candidate(original_text, source_ids=(fresh,), subject=subject)
        pending = self._request("memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        review = pending[0].get("correction_review", [])
        self.assertEqual(len(review), 1)
        self.assertEqual(review[0]["corrected_text"], corrected_text)
        self.assertEqual(review[0]["new_message_ids"], [str(fresh)])
        self.assertEqual(review[0]["new_source_ids"], [str(source)])
        self.assertEqual(self._get(self.backend, path)["memories"][0]["memory_id"],
                         corrected["memory"]["memory_id"])
        status, result = self.backend.request(
            f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))

    def test_confirmation_rechecks_canonical_message_generation(self):
        candidate = self._candidate("从原消息得出的合成主张。")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message SET text_content='变化的来源正文。' WHERE id=%s", (self.message_id,))
        status, result = self.backend.request(
            f"/api/contacts/{self.contact_id}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))
        self.assertEqual(self._request("memories")["memories"], [])

    def test_duplicate_correction_returns_one_version_and_stale_change_conflicts(self):
        wrong = self._candidate("联系人喜欢咖啡。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        body = {"text": "联系人喝咖啡只是工作需要。"}
        path = f"/api/contacts/{self.contact_id}/memories/{original['memory_id']}/correct"
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        status, replay = self.backend.request(path, body)
        self.assertEqual(status, 200, replay)
        self.assertEqual(result["memory"]["memory_id"], replay["memory"]["memory_id"])
        status, conflict = self.backend.request(path, {"text": "另一个迟到判断。"})
        self.assertEqual((status, conflict), (409, {"error": "memory_correction_conflict"}))
        self.assertEqual(len(self._request("memories")["memories"]), 1)

    def test_duplicate_rejection_replays_without_second_deleted_version(self):
        rejected = self._candidate("联系人喜欢咖啡。")
        path = f"/api/contacts/{self.contact_id}/memory-candidates/{rejected.candidate_id}/discard"
        status, result = self.backend.request(path, {})
        self.assertEqual(status, 200, result)
        status, replay = self.backend.request(path, {})
        self.assertEqual((status, replay), (200, result))
        self._candidate("对方偏爱咖啡。")
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.confirmed_memory WHERE owner_id=%s AND source_candidate_id=%s",
                (self.owner_id, rejected.candidate_id),
            ).fetchone()[0], 1)

    def test_source_delete_commits_before_late_correction_and_confirmation(self):
        wrong = self._candidate("来源先删的私密错误。")
        late = self._candidate("来源先删的私密改写。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._delete_source(self.source_id)
        for suffix, body in (
            (f"memories/{original['memory_id']}/correct", {"text": "不可落库的私密修正。"}),
            (f"memory-candidates/{late.candidate_id}/confirm", {}),
        ):
            status, response = self.backend.request(f"/api/contacts/{self.contact_id}/{suffix}", body)
            self.assertEqual((status, response), (404, {"error": "memory_not_found"}))
        self._assert_erased("来源先删的私密", "不可落库的私密修正")

    def test_correction_failure_rolls_back_and_recovers_as_one_manual_version(self):
        wrong = self._candidate("恢复前的私密错误。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._failure_trigger("INSERT")
        path = f"/api/contacts/{self.contact_id}/memories/{original['memory_id']}/correct"
        body = {"text": "恢复后的私密人工判断。"}
        status, response = self.backend.request(path, body)
        self.assertEqual((status, response), (500, {"error": "memory_operation_failed"}))
        self.assertEqual([item["memory_id"] for item in self._request("memories")["memories"]], [original["memory_id"]])
        self._assert_erased("恢复后的私密人工判断")
        self._release_failure_trigger()
        self.backend = self._open_backend()
        status, response = self.backend.request(path, body)
        self.assertEqual(status, 200, response)
        status, replay = self.backend.request(path, body)
        self.assertEqual(status, 200, replay)
        self.assertEqual(response["memory"]["memory_id"], replay["memory"]["memory_id"])
        self.store = PostgresMemoryStore(self.database_url)
        self._candidate("恢复重试后的旧错误改写。")
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_failed_source_deletion_retries_original_task_and_erases_recovery_text(self):
        wrong = self._candidate("删除重试私密旧主张。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._request(f"memories/{original['memory_id']}/correct", {"text": "删除重试私密人工解释。"})
        fresh_message, _ = self._source("删除重试后的新证据。")
        self._candidate("删除重试私密新候选。", source_ids=(fresh_message,))
        self._failure_trigger("DELETE")
        path = f"/api/contacts/{self.contact_id}/sources/{self.source_id}"
        status, deletion = self.backend.request(path, method="DELETE")
        self.assertEqual(status, 202, deletion)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            status, task = self.backend.request(
                f"/api/tasks/status?contact_id={self.contact_id}&task_id={deletion['task_id']}",
            )
            self.assertEqual(status, 200, task)
            if task["status"] == "failed":
                break
            if task["status"] == "queued":
                # 同库前一删除线程仍持全局锁时，沿公开入口显式继续原请求。
                status, duplicate = self.backend.request(path, method="DELETE")
                self.assertEqual(status, 202, duplicate)
                self.assertEqual(duplicate["task_id"], deletion["task_id"])
            threading.Event().wait(0.02)
        self.assertEqual(task["status"], "failed")
        self._release_failure_trigger()
        status, retry = self.backend.request(path, method="DELETE")
        self.assertEqual(status, 202, retry)
        self.assertEqual(retry["task_id"], deletion["task_id"])
        self._delete_source(self.source_id)
        self._assert_erased("删除重试私密旧主张", "删除重试私密人工解释", "删除重试私密新候选")
        self.backend = self._open_backend()
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        self.assertEqual(self._request("memories")["memories"], [])

    def test_contact_decision_does_not_leak_to_other_contact_or_owner(self):
        wrong = self._candidate("范围隔离旧错误。")
        self._request(f"memory-candidates/{wrong.candidate_id}/discard", {})
        self._alias_source(self.message_id)
        self._delete_source(self.source_id)
        self.backend = self._open_backend()
        other_contact, other_owner, other_owner_contact = uuid4(), uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s,'另一纠错合成用户')", (other_owner,))
            connection.execute("INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'同用户另一合成联系人')",
                               (self.owner_id, other_contact))
            connection.execute("INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'另一用户合成联系人')",
                               (other_owner, other_owner_contact))
        scopes = (ContactScope(self.owner_id, other_contact), ContactScope(other_owner, other_owner_contact))
        for scope in scopes:
            message, _ = self._source("独立范围合成证据。", scope)
            candidate = self._candidate("范围隔离旧错误。", scope=scope, source_ids=(message,))
            backend = self.backend if scope.owner_id == self.owner_id else self._open_backend(scope.owner_id)
            path = f"/api/contacts/{scope.contact_id}/memory-candidates"
            status, pending = backend.request(path)
            self.assertEqual(status, 200, pending)
            self.assertNotIn("correction_review", pending["candidates"][0])
            status, confirmed = backend.request(path + f"/{candidate.candidate_id}/confirm", {})
            self.assertEqual(status, 200, confirmed)
            self.assertEqual(confirmed["memory"]["contact_id"], str(scope.contact_id))
            if scope.owner_id != self.owner_id:
                status, hidden = self.backend.request(path + f"/{candidate.candidate_id}/confirm", {})
                self.assertEqual((status, hidden), (404, {"error": "memory_not_found"}))
        self._delete_source(self.source_id)
        status, memories = self.backend.request(f"/api/contacts/{other_contact}/memories")
        self.assertEqual(status, 200, memories)
        self.assertEqual(len(memories["memories"]), 1)

    def test_unrelated_contact_queued_guard_cannot_block_current_confirmation(self):
        other_contact = uuid4()
        other_scope = ContactScope(self.owner_id, other_contact)
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'独立排队合成联系人')",
                (self.owner_id, other_contact),
            )
        message, source = self._source("另一范围的独立合成来源。", other_scope)
        other = self._candidate("另一范围的合成旧错误。", scope=other_scope, source_ids=(message,))
        current_contact = self.contact_id
        self.contact_id = other_contact
        try:
            original = self._request(f"memory-candidates/{other.candidate_id}/confirm", {})["memory"]
            self._request(f"memories/{original['memory_id']}/correct", {"text": "另一范围的合成人工判断。"})
            alias = self._alias_source(message)
            self._delete_source(source)
        finally:
            self.contact_id = current_contact
        current = self._candidate("当前范围的独立合成候选。")
        with psycopg.connect(self.database_url, autocommit=True) as lock:
            deadline = time.monotonic() + 2
            acquired = try_acquire_global_worker_lock(lock)
            while not acquired and time.monotonic() < deadline:
                threading.Event().wait(0.01)
                acquired = try_acquire_global_worker_lock(lock)
            self.assertTrue(acquired, "本例上一来源清除未在时限内释放 Worker 锁")
            try:
                status, queued = self.backend.request(
                    f"/api/contacts/{other_contact}/sources/{alias}", method="DELETE",
                )
                self.assertEqual(status, 202, queued)
                confirmed = self._request(f"memory-candidates/{current.candidate_id}/confirm", {})
                self.assertEqual(confirmed["memory"]["text"], "当前范围的独立合成候选。")
            finally:
                release_global_worker_lock(lock)

    def test_stale_candidate_in_another_contact_cannot_block_user_correction(self):
        wrong = self._candidate("本联系人需要修正的旧资料。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        other_scope = ContactScope(self.owner_id, uuid4())
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'另一合成联系人')",
                               (self.owner_id, other_scope.contact_id))
        message, _ = self._source("另一范围候选的原始来源世代。", other_scope)
        stale = self._candidate("另一范围的候选。", scope=other_scope, source_ids=(message,))
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message SET text_content='模拟另一范围来源世代变化。' WHERE id=%s", (message,))
        corrected = self._request(f"memories/{original['memory_id']}/correct", {
            "text": "本联系人新的人工判断。",
        })["memory"]
        self.assertEqual([row["memory_id"] for row in self._request("memories")["memories"]], [corrected["memory_id"]])
        status, response = self.backend.request(
            f"/api/contacts/{other_scope.contact_id}/memory-candidates/{stale.candidate_id}/confirm", {},
        )
        self.assertEqual((status, response), (409, {"error": "memory_correction_conflict"}))

    def test_revoking_auto_memory_protects_old_paraphrase_and_reviews_new_evidence(self):
        wrong = self._candidate("联系人喜欢咖啡。")
        original = self.store.confirm(scope=self.scope, candidate_id=wrong.candidate_id, adoption_method=AdoptionMethod.AUTO)
        self._request(f"memories/{original.memory_id}/delete", {})
        self.store = PostgresMemoryStore(self.database_url)
        self._candidate("对方偏爱喝咖啡。")
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        new_message, _ = self._source("真正新的合成咖啡证据。")
        self._candidate("联系人喜欢咖啡。", source_ids=(new_message,))
        pending = self._request("memory-candidates")["candidates"]
        self.assertEqual(pending[0]["correction_review"][0]["decision"], "rejected")
        self.assertEqual(self._request("memories")["memories"], [])

    def test_revoking_self_auto_memory_protects_its_independent_scope(self):
        wrong = self._candidate("本人喜欢咖啡。", subject=FactSubject.SELF)
        original = PostgresOwnerMemoryStore(self.database_url).confirm_candidate(
            candidate=wrong, adoption_method=AdoptionMethod.AUTO,
        )
        status, response = self.backend.request(f"/api/memories/owner/{original.memory_id}/delete", {})
        self.assertEqual(status, 200, response)
        self._candidate("我偏爱喝咖啡。", subject=FactSubject.SELF)
        self.assertEqual(self._request("memory-candidates")["candidates"], [])

    def test_deleting_corrected_memory_erases_all_version_bodies_and_keeps_only_guard(self):
        wrong = self._candidate("删除记忆私密原错误。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        corrected = self._request(f"memories/{original['memory_id']}/correct", {
            "text": "删除记忆私密人工版本。",
        })["memory"]
        self._request(f"memories/{corrected['memory_id']}/delete", {})
        self._assert_erased("删除记忆私密原错误", "删除记忆私密人工版本")
        with psycopg.connect(self.database_url) as connection:
            guards = connection.execute(
                "SELECT evidence,rejected_text,corrected_text,replacement_memory_id "
                "FROM public.memory_correction_decision WHERE owner_id=%s", (self.owner_id,),
            ).fetchall()
            snapshot = connection.execute(
                "SELECT correction_evidence,correction_decision_ids FROM public.memory_candidate "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, wrong.candidate_id),
            ).fetchone()
        self.assertTrue(guards)
        self.assertTrue(all(row == ({"version": 1, "kind": "erased_guard",
                                    "canonical_ids": [str(self.message_id)]}, None, None, None)
                            for row in guards))
        self.assertEqual(snapshot, (None, None))
        self.backend = self._open_backend()
        self._candidate("旧证据上的改写不得恢复。")
        self.assertEqual(self._request("memory-candidates")["candidates"], [])
        new_message, _ = self._source("删除后独立新证据。")
        self._candidate("删除后的独立新主张。", source_ids=(new_message,))
        review = self._request("memory-candidates")["candidates"][0]["correction_review"]
        self.assertTrue(all(row["decision"] == "rejected" for row in review))
        self.assertTrue(all(row["previous_text"] == "原资料已删除；旧证据上的人工否决继续有效。" for row in review))
        self.assertTrue(all(row["corrected_text"] is None for row in review))

    def test_late_delete_of_superseded_version_cannot_erase_current_manual_decision(self):
        for subject in (FactSubject.CONTACT, FactSubject.SELF):
            with self.subTest(subject=subject):
                message, _ = self._source("迟到删除版本复验的独立证据。")
                candidate = self._candidate("迟到删除前的旧资料。", subject=subject, source_ids=(message,))
                pending = next(row for row in self._request("memory-candidates")["candidates"]
                               if row["candidate_id"] == str(candidate.candidate_id))
                original = self._request(f"memory-candidates/{candidate.candidate_id}/confirm", {
                    "correction_decision_ids": [row["decision_id"] for row in pending.get("correction_review", [])],
                })["memory"]
                prefix = ("/api/memories/owner" if subject is FactSubject.SELF
                          else f"/api/contacts/{self.contact_id}/memories")
                status, response = self.backend.request(prefix + f"/{original['memory_id']}/correct", {
                    "text": "迟到删除不能覆盖的新人工判断。",
                })
                self.assertEqual(status, 200, response)
                corrected = response["memory"]
                status, response = self.backend.request(prefix + f"/{original['memory_id']}/delete", {})
                self.assertEqual((status, response), (409, {"error": "memory_correction_conflict"}))
                status, response = self.backend.request(prefix)
                self.assertEqual(status, 200, response)
                self.assertIn(corrected["memory_id"], [row["memory_id"] for row in response["memories"]])
                for _ in range(2):
                    status, response = self.backend.request(prefix + f"/{corrected['memory_id']}/delete", {})
                    self.assertEqual(status, 200, response)
                    self.assertEqual(response["memory"]["memory_id"], corrected["memory_id"])

    def test_deletion_verification_rejects_restored_correction_body(self):
        wrong = self._candidate("恢复副本私密旧错误。")
        original = self._request(f"memory-candidates/{wrong.candidate_id}/confirm", {})["memory"]
        self._request(f"memories/{original['memory_id']}/correct", {"text": "恢复副本私密人工判断。"})
        with psycopg.connect(self.database_url) as connection:
            evidence = connection.execute("SELECT evidence FROM public.memory_correction_decision WHERE owner_id=%s", (self.owner_id,)).fetchone()[0]
        self._delete_source(self.source_id)
        # 故障边界模拟旧备份被错误恢复；验证器须识别而不能承诺已清除。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.memory_correction_decision (id,owner_id,contact_id,scope_kind,record_kind,record_id,decision,rejected_text,corrected_text,evidence) "
                "VALUES (%s,%s,%s,'contact','contact_memory',%s,'corrected','恢复副本私密旧错误。','恢复副本私密人工判断。',%s)",
                (uuid4(), self.owner_id, self.contact_id, uuid4(), Jsonb(evidence)),
            )
        with self.assertRaises(SourceDeletionVerificationError):
            PostgresSourceDeletionRepository(self.database_url).verify_deleted(
                owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=self.source_id,
            )

    def test_deletion_verification_rejects_fake_erased_guard_and_inactive_canonical(self):
        wrong = self._candidate("墓碑复验私密旧错误。")
        self._request(f"memory-candidates/{wrong.candidate_id}/discard", {})
        self._alias_source(self.message_id)
        self._delete_source(self.source_id)
        repository = PostgresSourceDeletionRepository(self.database_url)
        repository.verify_deleted(
            owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=self.source_id,
        )
        with psycopg.connect(self.database_url) as connection:
            constraint, definition = connection.execute(
                "SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conrelid='public.memory_correction_decision'::regclass "
                "AND pg_get_constraintdef(oid) LIKE '%notalone_correction_erased_guard_shape%'",
            ).fetchone()
            # 仅本例隔离库模拟错误备份绕过写入约束，公开删除复验仍须识别残留。
            connection.execute(sql.SQL("ALTER TABLE public.memory_correction_decision DROP CONSTRAINT {}")
                               .format(sql.Identifier(constraint)))
        valid = {"version": 1, "kind": "erased_guard", "canonical_ids": [str(self.message_id)]}
        try:
            for evidence, restored_text in (
                ({**valid, "source_id": str(self.source_id), "body": "伪墓碑私密恢复副本。"}, None),
                (valid, "伪墓碑私密恢复副本。"),
                ({**valid, "canonical_ids": [str(uuid4())]}, None),
            ):
                with self.subTest(evidence=evidence, restored_body=restored_text is not None):
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(
                            "UPDATE public.memory_correction_decision SET evidence=%s,rejected_text=%s "
                            "WHERE owner_id=%s", (Jsonb(evidence), restored_text, self.owner_id),
                        )
                    with self.assertRaises(SourceDeletionVerificationError):
                        repository.verify_deleted(
                            owner_id=self.owner_id, contact_id=self.contact_id,
                            source_document_id=self.source_id,
                        )
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.memory_correction_decision SET evidence=%s,rejected_text=NULL "
                    "WHERE owner_id=%s", (Jsonb(valid), self.owner_id),
                )
                connection.execute(sql.SQL("ALTER TABLE public.memory_correction_decision ADD CONSTRAINT {} {}")
                                   .format(sql.Identifier(constraint), sql.SQL(definition)))
        repository.verify_deleted(
            owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=self.source_id,
        )
        self._assert_erased("墓碑复验私密旧错误", "伪墓碑私密恢复副本")
