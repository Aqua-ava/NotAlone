"""07 的生产装配在最后事务、迟到与真实 SQL 故障下的公共行为。"""

from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from notalone.application.source_service import SourceService
from notalone.memory.models import FactSubject
from tests.integration.persistence.concurrency import wait_for_blocked_operations
from tests.integration.server import test_historical_reply_basis as commit_support
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OverviewReplyRacesHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    def test_interrupted_generation_cannot_commit_late_and_explicit_recovery_saves_a_fresh_receipt(self):
        contact, _, message = self.import_contact("合成原话：对方喜欢热茶。")
        self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "喜欢热茶，想聊热茶。")
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.reply_model.plans.append({"text": "合成中断迟到候选。", "basis": "保留本次草稿。"})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5), pending.result(timeout=1) if pending.done() else "模型尚未进入")
                identity = {"request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"]}
                status, interrupted = self.backend.request(path + "/interrupt", identity)
                self.assertEqual(status, 200, interrupted)
                self.assertEqual(interrupted["interruption_reason"], "app_quit")
                self.assertEqual(self.backend.request(path + "/interrupt", identity), (200, interrupted))
                self.assertEqual(self.backend.request(path + "/replies", body),
                                 (409, {"error": "assistant_session_rejected", "reason": "generation_interrupted"}))
                gate.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                gate.set()
        self.backend = self._backend(self.owner_id)
        failed = self._get(self.backend, path)["turns"][0]
        self.assertEqual(failed["state"], "failed")
        self.assertIsNone(failed["reply"])
        self.reply_model.plans.append({"text": "合成明确恢复的新候选。", "basis": "沿已保存本次输入恢复。"})
        status, completed = self.backend.request(path + "/retry-interrupted", {
            "original_turn_id": prepared["turn_id"], "original_input_version_id": prepared["input_version_id"],
            "request_key": str(uuid4()),
        })
        self.assertEqual(status, 200, completed)
        self.assertNotEqual(completed["turn_id"], prepared["turn_id"])
        evidence = self._get(self.backend, self.evidence_path(contact, completed))
        self.assertEqual(evidence["retrieval"]["status"], "succeeded")
        self.assertNotIn("合成中断迟到候选", str(self._get(self.backend, path)))
        self.assertEqual(len(self.reply_model.payloads), 2)

    def test_owner_fact_from_another_relationship_never_reads_its_raw_window_and_source_deletion_erases_the_reply(self):
        contact, _, _ = self.import_contact("当前联系人的合成普通原话。")
        other, source, _ = self.import_contact("另一关系合成私密原话：喜欢热茶。", owner_text="本人最近喜欢热茶。")
        own_message = next(item for item in self._get(self.backend, f"/api/contacts/{other}/messages")["messages"]
                           if item["speaker"] == "user")
        owner = self.confirm(other, "本人最近喜欢热茶。", UUID(own_message["message_id"]), subject=FactSubject.SELF)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "本人最近喜欢热茶，想聊热茶。")
        self.reply_model.plans.append({"text": "想聊聊热茶。", "basis": "本次明确草稿和本人资料。", "cite_kinds": ["owner_memory"]})
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        evidence_path = self.evidence_path(contact, turn)
        evidence = self._get(self.backend, evidence_path)
        own = next(item for item in evidence["evidence"] if item["evidence_id"] == owner["memory_id"])
        self.assertEqual(own["navigation"]["scope_kind"], "owner")
        self.assertEqual(own["timing"]["current_status"], "current_unverified")
        self.assertFalse(any(item["kind"] == "message" for item in evidence["evidence"]))
        self.assertEqual(evidence["retrieval"]["budgets"]["source_messages"]["used_calls"], 0)
        self.assertNotIn("另一关系合成私密原话", str(self.reply_model.payloads))
        self.delete_source(other, source)
        self.assertEqual(self.backend.request(evidence_path)[0], 404)
        self.assertNotIn(body["content"]["draft_text"], str(self._get(self.backend, path)))
        self.assertNotEqual(self._backend(self.owner_id).request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_queued_source_deletion_erases_prepared_input_and_rejects_late_and_duplicate_same_key_results(self):
        contact, source, message = self.import_contact("合成原话：双方去年喝过热茶。")
        self.confirm(contact, "双方去年喝过热茶。", message)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "双方去年喝过热茶，想聊热茶。")
        self.reply_model.plans.append({"text": "合成迟到候选不得恢复。", "basis": "保留本次草稿。"})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                with patch.object(SourceService, "_start", return_value=None):
                    status, queued = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
                self.assertEqual((status, queued["status"]), (202, "queued"))
                prepared = self._get(self.backend, path)
                self.assertNotIn(body["content"]["draft_text"], str(prepared))
                gate.set()
                status, rejected = pending.result(timeout=10)
            finally:
                gate.set()
        self.assertNotEqual(status, 200, rejected)
        self.assertNotIn("合成迟到候选", str(self._get(self.backend, path)))
        calls = len(self.reply_model.payloads)
        restarted = self._backend(self.owner_id)
        self.assertNotEqual(restarted.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), calls)
        finished = self.delete_source(contact, source)
        self.assertEqual(finished["task_id"], queued["task_id"])
        self.assertEqual(self.delete_source(contact, source)["task_id"], queued["task_id"])
        self.assertNotIn(body["content"]["draft_text"], str(self._get(restarted, path)))

    def _remove_write_failure(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DROP TRIGGER IF EXISTS synthetic_reply_write_failure ON public.reply_candidate")
            connection.execute("DROP FUNCTION IF EXISTS public.synthetic_reply_write_failure()")

    def test_real_candidate_insert_failure_retries_the_same_key_and_restores_navigation_after_reassembly(self):
        contact, _, message = self.import_contact("合成原话：对方喜欢热茶。")
        memory = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "喜欢热茶，想聊热茶。")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE FUNCTION public.synthetic_reply_write_failure() RETURNS trigger LANGUAGE plpgsql "
                               "AS $$ BEGIN RAISE EXCEPTION 'synthetic reply insert failure'; END $$")
            connection.execute("CREATE TRIGGER synthetic_reply_write_failure BEFORE INSERT ON public.reply_candidate "
                               "FOR EACH ROW EXECUTE FUNCTION public.synthetic_reply_write_failure()")
        self.addCleanup(self._remove_write_failure)
        self.reply_model.plans.append({"text": "合成失败候选不能展示。", "basis": "保留本次草稿。"})
        status, rejected = self.backend.request(path + "/replies", body)
        self.assertEqual((status, rejected), (503, {"error": "assistant_session_save_failed"}))
        failed = self._get(self.backend, path)["turns"][0]
        self.assertEqual(failed["state"], "failed")
        self.assertIsNone(failed["reply"])
        self.assertNotIn("合成失败候选", str(failed))
        self._remove_write_failure()
        self.backend = self._backend(self.owner_id)
        self.reply_model.plans.append({"text": "想聊聊热茶。", "basis": "根据实际保存资料。", "cite_kinds": ["confirmed_memory"]})
        status, completed = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, completed)
        self.assertEqual(completed["turn_id"], failed["turn_id"])
        evidence_path = self.evidence_path(contact, completed)
        saved = self._get(self.backend, evidence_path)
        item = next(item for item in saved["evidence"] if item["evidence_id"] == memory["memory_id"])
        self.assertTrue(item["cited"])
        self.assertEqual(item["navigation"]["memory_id"], memory["memory_id"])
        restarted = self._backend(self.owner_id)
        self.assertEqual(restarted.request(path + "/replies", body), (200, completed))
        self.assertEqual(self._get(restarted, evidence_path), saved)
        self.assertEqual(len(self.reply_model.payloads), 2)

    def test_last_writer_owner_lock_serializes_contact_correction_and_keeps_the_saved_snapshot(self):
        contact, _, message = self.import_contact("合成原话：对方喜欢热茶。")
        memory = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        identifiers = commit_support.CommitIdentifierFactory()
        store = commit_support.CommitBoundaryReplyStore(self.database_url, id_factory=identifiers)
        with patch("notalone.server.reply_wiring.PostgresReplyStore", return_value=store):
            self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "聊聊热茶吧。", "basis": "保留本次草稿。", "cite_kinds": ["confirmed_memory"]})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=2) as pool:
            generated = pool.submit(self.backend.request, path + "/replies", self.rewrite_body(contact, "喜欢热茶，想聊热茶。"))
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                identifiers.armed = True
                gate.set()
                self.assertTrue(identifiers.entered.wait(5), "实际 writer 最后复验已完成，候选尚未 INSERT。")
                with psycopg.connect(self.database_url) as connection:
                    blockers = {row[0] for row in connection.execute(
                        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted "
                        "AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").fetchall()}
                corrected = pool.submit(self.backend.request, f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct",
                                        {"text": "对方喜欢温茶。"})
                wait_for_blocked_operations(self.database_url, blockers, 1)
                self.assertFalse(corrected.done())
                identifiers.release.set()
                self.assertEqual(corrected.result(timeout=10)[0], 200)
                status, turn = generated.result(timeout=10)
            finally:
                gate.set()
                identifiers.release.set()
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        old = next(item for item in evidence["evidence"] if item["evidence_id"] == memory["memory_id"])
        self.assertEqual(old["text"], "对方喜欢热茶。")
        self.assertEqual(old["snapshot_status"], "active")
        self.assertEqual(evidence["basis_changes"], [{"evidence_id": memory["memory_id"], "kind": "confirmed_memory", "reason": "memory_revised"}])
        self.assertEqual(self._get(self.backend, path)["turns"][0]["state"], "completed")

    def test_contact_and_owner_revision_changes_after_model_validation_are_rechecked_by_actual_writer(self):
        for level in ("contact", "owner"):
            with self.subTest(level=level):
                contact, _, message = self.import_contact("合成原话：对方喜欢热茶。")
                relationship = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
                owner = self.manual_owner("本人喜欢热茶。", category="preference")
                store = commit_support.CommitBoundaryReplyStore(self.database_url)
                with patch("notalone.server.reply_wiring.PostgresReplyStore", return_value=store):
                    self.activate_replies(contact)
                path = self.reply_path(contact)
                body = self.rewrite_body(contact, "喜欢热茶，想聊热茶。")
                self.reply_model.plans.append({"text": "想聊聊热茶。", "basis": "保留本次草稿。"})
                store.hold_before_commit = True
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(self.backend.request, path + "/replies", body)
                    try:
                        self.assertTrue(store.entered.wait(5), "实际模型后复验必须已完成。")
                        correction_path = (f"/api/contacts/{contact}/memories/{relationship['memory_id']}/correct"
                                           if level == "contact" else f"/api/memories/owner/{owner['memory_id']}/correct")
                        status, corrected = self.backend.request(correction_path, {"text": "现在喜欢温茶。"})
                        self.assertEqual(status, 200, corrected)
                        store.release.set()
                        status, rejected = pending.result(timeout=10)
                    finally:
                        store.release.set()
                self.assertNotEqual(status, 200, rejected)
                failed = self._get(self.backend, path)["turns"][0]
                self.assertEqual(failed["state"], "failed")
                self.assertIsNone(failed["reply"])
