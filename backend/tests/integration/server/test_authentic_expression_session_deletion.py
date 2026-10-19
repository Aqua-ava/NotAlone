"""表达样本独立保留沿A正式会话删除入口验收；不实现另一删除器。"""

from __future__ import annotations

import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from notalone.persistence.locks import lock_owner_scope
from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.persistence.concurrency import wait_for_blocked_operations


class AuthenticExpressionSessionDeletionTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    def test_saved_samples_remain_usable_after_session_delete_then_sample_delete_erases_derivatives(self):
        self._exercise_retention("sample")

    def test_saved_samples_remain_usable_after_session_delete_then_raw_delete_erases_derivatives(self):
        self._exercise_retention("source")

    def test_history_sample_delete_erases_running_draft_without_relationship_context(self):
        contact, _, _ = self.prepare_contact(self.owner_id)
        status, saved = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": "合成旧样本：说话轻一点。", "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, saved)
        sample_id = saved["sample"]["sample_id"]
        session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})[1]
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        previous = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                    "content": {"type": "rewrite_draft", "draft_text": "上次明确拒绝。", "include_relationship_context": True}}
        self.reply_model.plans.append({"text": "上次不参加。", "basis": "保留明确拒绝。"})
        status, reply = self.backend.request(path + "/replies", previous)
        self.assertEqual(status, 200, reply)
        self.assertEqual(reply["context_receipt"]["style_sample_ids"], [sample_id])
        current = {**previous, "idempotency_key": str(uuid4()), "content": {
            "type": "rewrite_draft", "draft_text": "本次仍明确拒绝。", "include_relationship_context": False,
        }}
        self.reply_model.plans.append({"text": "本次不参加。", "basis": "保留本次明确拒绝。"})
        self.reply_model.entered.clear()
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.backend.request, path + "/replies", current)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, deleted = self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")
                self.assertEqual(status, 200, deleted)
                restored = self._get(self._backend(self.owner_id), path)
            finally:
                gate.set()
            status, result = future.result(timeout=10)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(restored["turns"]), 2)
        for turn in restored["turns"]:
            self.assertEqual(turn["state"], "redacted")
            self.assertIsNone(turn["input"])
            self.assertIsNone(turn["reply"])
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute(
                "SELECT current_input_version_id FROM public.assistant_session WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (self.owner_id, contact, session["session_id"]),
            ).fetchone()
            self.assertEqual(row, (None,))
            remaining = connection.execute(
                "SELECT count(*) FROM public.assistant_session_input WHERE owner_id=%s AND session_id=%s AND state<>'redacted'",
                (self.owner_id, session["session_id"]),
            ).fetchone()[0]
            self.assertEqual(remaining, 0)
        self.assertNotEqual(self.backend.request(path + "/replies", current)[0], 200)
        self.assertEqual(self.reply_model.payloads[-1]["style_references"], [])
        self.assertEqual(len(self.reply_model.payloads), 2)

    def test_candidate_save_and_session_delete_follow_actual_owner_lock_order(self):
        for save_first in (True, False):
            with self.subTest(save_first=save_first):
                contact, target, source = self.prepare_contact(self.owner_id)
                session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})[1]
                path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
                calls = len(self.reply_model.payloads)
                self.reply_model.plans.append({"text": "本次不参加。", "basis": "仅表达合成拒绝。"})
                status, reply = self.backend.request(path + "/replies", {
                    "contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                    "content": {"type": "reply_to_message", "target_message_id": target,
                                "direction": "明确拒绝，不承诺其他安排。"},
                })
                self.assertEqual(status, 200, reply)
                sample_path = f"/api/contacts/{contact}/style-samples"
                save_body = {"idempotency_key": str(uuid4()), "text": "主动另存的合成拒绝。",
                             "origin": {"kind": "candidate", "id": reply["candidates"][0]["candidate_id"]}}
                operations = {
                    "save": lambda: self.backend.request(sample_path, save_body),
                    "delete": lambda: self.backend.request(path, {"confirmed": True}, method="DELETE"),
                }
                order = ("save", "delete") if save_first else ("delete", "save")
                # 两个真实 HTTP 事务先后进入同一 owner 锁队列，不以线程启动时间猜顺序。
                with ThreadPoolExecutor(max_workers=2) as executor:
                    with psycopg.connect(self.database_url) as blocker:
                        lock_owner_scope(blocker, owner_id=self.owner_id)
                        blocker_pid = blocker.execute("SELECT pg_backend_pid()").fetchone()[0]
                        first = executor.submit(operations[order[0]])
                        waiting = wait_for_blocked_operations(self.database_url, {blocker_pid}, 1)
                        second = executor.submit(operations[order[1]])
                        wait_for_blocked_operations(self.database_url, {blocker_pid, *waiting}, 2)
                    results = {order[0]: first.result(timeout=10), order[1]: second.result(timeout=10)}
                self.assertEqual(results["delete"][0], 200, results)
                rebuilt = self._backend(self.owner_id)
                self.assertEqual(rebuilt.request(path), (404, {"error": "not_found"}))
                if save_first:
                    self.assertEqual(results["save"][0], 200, results)
                    sample = results["save"][1]["sample"]
                    self.assertIn(source, sample["source_ids"])
                    self.assertEqual(self._get(rebuilt, sample_path)["samples"], [sample])
                    self.assertEqual(rebuilt.request(sample_path, save_body), results["save"])
                else:
                    self.assertEqual(results["save"][0], 404, results)
                    self.assertEqual(self._get(rebuilt, sample_path)["samples"], [])
                    self.assertEqual(rebuilt.request(sample_path, save_body)[0], 404)
                self.assertEqual(rebuilt.request(sample_path, {**save_body, "idempotency_key": str(uuid4())})[0], 404)
                with psycopg.connect(self.database_url) as connection:
                    self.assertEqual(connection.execute(
                        "SELECT count(*) FROM public.assistant_session_input WHERE owner_id=%s AND session_id=%s AND content IS NOT NULL",
                        (self.owner_id, session["session_id"]),
                    ).fetchone()[0], 0)
                    self.assertEqual(connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND id=%s",
                        (self.owner_id, reply["reply_request_id"]),
                    ).fetchone()[0], 0)
                self.assertEqual(len(self.reply_model.payloads), calls + 1)

    def test_legacy_saved_sample_is_backfilled_before_its_origin_session_is_deleted(self):
        self._exercise_retention("sample", legacy=True)

    def test_unknown_legacy_sample_stays_auditable_but_cannot_enter_generation(self):
        self._exercise_retention("sample", unknown=True)

    def _exercise_retention(self, removal: str, *, legacy=False, unknown=False) -> None:
        contact, target, source = self.prepare_contact(self.owner_id)
        saved = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})[1]
        old_path = f"/api/contacts/{contact}/assistant-sessions/{saved['session_id']}"
        old_body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                    "content": {"type": "reply_to_message", "target_message_id": target,
                                "direction": "拒绝这次合成邀请，不新增安排。"}}
        self.reply_model.plans.append({"text": "本次不参加。", "basis": "只表达当前拒绝。"})
        status, old_reply = self.backend.request(old_path + "/replies", old_body)
        self.assertEqual(status, 200, old_reply)
        sample_body = {"idempotency_key": str(uuid4()), "text": "主动保存的合成拒绝说法。",
                       "origin": {"kind": "candidate", "id": old_reply["candidates"][0]["candidate_id"]}}
        status, saved_sample = self.backend.request(f"/api/contacts/{contact}/style-samples", sample_body)
        self.assertEqual(status, 200, saved_sample)
        sample_id = saved_sample["sample"]["sample_id"]
        self.assertIn(source, saved_sample["sample"]["source_ids"])
        status, manual = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": "独立手写的合成短句说法。", "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, manual)
        manual_id = manual["sample"]["sample_id"]
        with psycopg.connect(self.database_url) as connection:
            turns = connection.execute(
                "SELECT input_payload FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND session_id=%s",
                (self.owner_id, contact, saved["session_id"]),
            ).fetchall()
            self.assertEqual(len(turns), 1)
            self.assertEqual(turns[0][0]["content"]["direction"], old_body["content"]["direction"])

        if legacy:
            # 模拟迁移前已保存且原候选仍存在的样本；不能用空集假装已核验。
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DELETE FROM public.style_sample_generation_dependency WHERE owner_id=%s AND sample_id=%s",
                                   (self.owner_id, sample_id))
        status, deleted = self.backend.request(old_path, {"confirmed": True}, method="DELETE")
        self.assertEqual(status, 200, deleted)
        reopened = self._backend(self.owner_id)
        self.assertEqual(reopened.request(old_path)[0], 404)
        self.assertNotEqual(reopened.request(old_path + "/replies", old_body)[0], 200)
        self.assertNotEqual(reopened.request(f"/api/contacts/{contact}/replies/{old_reply['reply_request_id']}/evidence")[0], 200)
        self.assertEqual(self._get(reopened, f"/api/contacts/{contact}/style-samples/{sample_id}")["sample"], saved_sample["sample"])
        self.assertEqual(reopened.request(f"/api/contacts/{contact}/style-samples", sample_body), (200, saved_sample))
        self.assertNotEqual(reopened.request(f"/api/contacts/{contact}/style-samples", {
            **sample_body, "idempotency_key": str(uuid4()),
        })[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual({item["sample_id"] for item in self._get(reopened, f"/api/contacts/{contact}/style-samples")["samples"]},
                         {sample_id, manual_id})
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND input_payload IS NOT NULL",
                (self.owner_id, contact, saved["session_id"]),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.assistant_session_input WHERE owner_id=%s AND session_id=%s AND content IS NOT NULL",
                                                (self.owner_id, saved["session_id"])).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND id=%s",
                                                (self.owner_id, old_reply["reply_request_id"])).fetchone()[0], 0)

        if unknown:
            # 模拟原候选早已删除且没有历史快照的存量；此时不能重造依赖。
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DELETE FROM public.style_sample_generation_dependency WHERE owner_id=%s AND sample_id=%s",
                                   (self.owner_id, sample_id))
        new_session = reopened.request(f"/api/contacts/{contact}/assistant-session/default", {})[1]
        self.assertNotEqual(new_session["session_id"], saved["session_id"])
        new_path = f"/api/contacts/{contact}/assistant-sessions/{new_session['session_id']}"
        self.assertEqual(self._get(reopened, new_path)["turns"], [])
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "initiate_conversation", "purpose": "本次仍然拒绝，不增加约定。",
                            "clarification_answer": "不陪同，不承诺时间。"}}
        self.reply_model.plans.append({"text": "这次不参加。", "basis": "参考说法但保留当前拒绝。"})
        status, generated = reopened.request(new_path + "/replies", body)
        self.assertEqual(status, 200, generated)
        expected_samples = {manual_id} if unknown else {sample_id, manual_id}
        self.assertEqual(set(generated["context_receipt"]["style_sample_ids"]), expected_samples)
        self.assertEqual({item["sample_id"] for item in self.reply_model.payloads[-1]["style_references"]}, expected_samples)
        self.assertEqual(self.reply_model.payloads[-1]["fidelity_contract"]["current_intent"]["text"], body["content"]["purpose"])
        self.assertEqual(len(self.reply_model.payloads), 2)

        if removal == "sample":
            self.assertEqual(reopened.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")[0], 200)
            state = next(item for item in self._get(reopened, f"/api/contacts/{contact}/sources")["sources"] if item["source_id"] == source)
            self.assertEqual(state["status"], "active")
        else:
            status, result = reopened.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
            self.assertEqual(status, 202, result)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = next(item for item in self._get(reopened, f"/api/contacts/{contact}/sources")["sources"] if item["source_id"] == source)
                self.assertNotEqual(state["task_status"], "failed", state)
                if state["status"] == "deleted" and state["task_status"] == "succeeded":
                    break
                time.sleep(.02)
            else:
                self.fail("本轮合成来源删除未完成。")
        self.assertEqual(reopened.request(f"/api/contacts/{contact}/style-samples/{sample_id}")[0], 410)
        self.assertEqual(self._get(reopened, f"/api/contacts/{contact}/style-samples/{manual_id}")["sample"], manual["sample"])
        after = self._get(self._backend(self.owner_id), new_path)
        if unknown:
            self.assertEqual(after["turns"][0]["reply"]["candidates"], generated["candidates"])
            self.assertEqual(len(self.reply_model.payloads), 2)
            return
        self.assertEqual(after["turns"][0]["state"], "redacted")
        self.assertIsNone(after["turns"][0]["input"])
        self.assertIsNone(after["turns"][0]["reply"])
        self.assertNotEqual(reopened.request(new_path + "/replies", body)[0], 200)
        self.assertEqual(reopened.request(old_path)[0], 404)
        self.assertEqual(len(self.reply_model.payloads), 2)


if __name__ == "__main__":
    unittest.main()
