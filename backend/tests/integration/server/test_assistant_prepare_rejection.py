"""明确未领取凭证必须在同一 owner 事务中封住旧键；只用合成 HTTP/PG。"""

from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture


class AssistantPrepareRejectionHttpTest(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    def _post(self, path: str, body: dict) -> dict:
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        return result

    def test_first_prepare_cas_rejection_proves_no_generation_and_blocks_old_queued_key(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        stale = str(uuid4())
        command = {"contact_id": contact, "idempotency_key": str(uuid4()),
                   "expected_input_version_id": stale,
                   "content": {"type": "rewrite_draft", "draft_text": "合成被拒旧请求。"}}
        before = self.backend.request(path)

        status, rejected = self.backend.request(path + "/replies/prepare", command)

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "assistant_session_input_conflict")
        self.assertEqual(rejected.get("no_generation"), {
            "contact_id": contact, "session_id": session["session_id"],
            "request_key": command["idempotency_key"], "state": "not_reserved",
        })
        self.assertEqual(self.backend.request(path), before)
        self.assertEqual(len(self.reply_model.seen_calls), 0)
        # 先前排队的同键稍后到达，不能换正文或省略CAS后再生成。
        late = {**command, "content": {"type": "rewrite_draft", "draft_text": "合成排队旧键。"}}
        late.pop("expected_input_version_id")
        self.assertEqual(self.backend.request(path + "/replies/prepare", late)[0], 409)
        self.assertEqual(self.backend.request(path + "/replies", late)[0], 409)
        self.assertEqual(self.backend.request(path), before)
        self.assertEqual(len(self.reply_model.seen_calls), 0)
        fresh = {**late, "idempotency_key": str(uuid4())}
        self.assertEqual(self.backend.request(path + "/replies/prepare", fresh)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), 0)

    def test_existing_key_actually_in_model_never_gets_no_generation_proof_after_binding_revoke(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        command = {"contact_id": contact, "idempotency_key": str(uuid4()),
                   "content": {"type": "rewrite_draft", "draft_text": "合成已有实际运行请求。"}}
        prepared = self._post(path + "/replies/prepare", command)
        self.reply_model.plans.append({"text": "合成迟到响应。", "basis": "原合成草稿。"})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", command)
            try:
                self.assertTrue(self.reply_model.entered.wait(5), "原同键必须真正进入模型。")
                observed = self.backend.request(path)[1]
                self.assertEqual(observed["turns"][0]["state"], "running")
                self.assertEqual(observed["turns"][0]["turn_id"], prepared["turn_id"])
                self.bindings.revoke_binding(owner_id=self.owner_id, contact_id=UUID(contact),
                                             binding_id=UUID(observed["inputs"][0]["conversation_binding_id"]))

                status, rejected = self.backend.request(path + "/replies/prepare", command)

                self.assertEqual(status, 409, rejected)
                self.assertEqual(rejected["reason"], "no_active_binding")
                self.assertNotIn("no_generation", rejected)
            finally:
                gate.set()
                running.result(timeout=10)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_typed_prepare_source_pending_proves_new_key_only_and_blocks_later_execution(self):
        contact, target, source = self.prepare_contact(self.owner_id)
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        self.reply_model.plans.append({"text": "这次不参加。", "basis": "原本次拒绝。"})
        original = self._post(path + "/replies", {
            "contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
            "content": {"type": "reply_to_message", "target_message_id": target, "direction": "拒绝本次邀约。"},
        })
        candidate = original["candidates"][0]
        history = self.backend.request(path + f"/candidates/{candidate['candidate_id']}/versions")[1]
        command = {"idempotency_key": str(uuid4()), "expected_input_version_id": original["input_version_id"],
                   "instruction": "第一条自然一点", "displayed_group": {
                       "session_id": session["session_id"], "candidate_group_id": original["reply_request_id"],
                       "candidates": [{"number": history["candidate_number"], "candidate_id": candidate["candidate_id"],
                                       "version_id": history["default_display_version_id"]}],
                   }}
        # 合成worker前状态是输入；业务结果和领取身份仍只观察公开HTTP。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' "
                               "WHERE owner_id=%s AND contact_id=%s AND id=%s", (self.owner_id, contact, source))
        before = self.backend.request(path)
        status, rejected = self.backend.request(path + "/continue/prepare", command)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected.get("no_generation"), {"contact_id": contact, "session_id": session["session_id"],
                                                         "request_key": command["idempotency_key"], "state": "not_reserved"})
        self.assertEqual(self.backend.request(path), before)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='active' "
                               "WHERE owner_id=%s AND contact_id=%s AND id=%s", (self.owner_id, contact, source))
        self.assertEqual(self.backend.request(path + "/continue", command)[0], 409)
        self.assertEqual(len(self.reply_model.payloads), 1)
        command["idempotency_key"] = str(uuid4())
        self.assertEqual(self.backend.request(path + "/continue/prepare", command)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_previously_reserved_typed_key_cannot_return_zero_generation_clarification(self):
        contact, target, source = self.prepare_contact(self.owner_id)
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        self.reply_model.plans.append({"text": "本次不参加。", "basis": "当前合成拒绝。"})
        original = self._post(path + "/replies", {"contact_id": contact, "idempotency_key": str(uuid4()),
            "skill_disabled": True, "content": {"type": "reply_to_message", "target_message_id": target,
                                                  "direction": "拒绝本次邀约。"}})
        candidate = original["candidates"][0]
        history = self.backend.request(path + f"/candidates/{candidate['candidate_id']}/versions")[1]
        command = {"idempotency_key": str(uuid4()), "expected_input_version_id": original["input_version_id"],
                   "instruction": "第一条自然一点", "displayed_group": {
                       "session_id": session["session_id"], "candidate_group_id": original["reply_request_id"],
                       "candidates": [{"number": history["candidate_number"], "candidate_id": candidate["candidate_id"],
                                       "version_id": history["default_display_version_id"]}],
                   }}
        self._post(path + "/continue/prepare", command)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' "
                               "WHERE owner_id=%s AND contact_id=%s AND id=%s", (self.owner_id, contact, source))
        status, rejected = self.backend.request(path + "/continue/prepare", command)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "assistant_session_input_conflict")
        self.assertNotIn("clarification", rejected)
        self.assertNotIn("no_generation", rejected)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_failed_proof_commit_never_returns_positive_metadata_or_leaves_barrier(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        command = {"contact_id": contact, "idempotency_key": str(uuid4()),
                   "expected_input_version_id": str(uuid4()),
                   "content": {"type": "rewrite_draft", "draft_text": "合成证明提交故障。"}}
        with psycopg.connect(self.database_url) as connection:
            connection.execute("CREATE FUNCTION public.prepare_proof_fault() RETURNS trigger LANGUAGE plpgsql "
                               "AS $$ BEGIN RAISE EXCEPTION 'synthetic-proof-write-failure'; END $$")
            connection.execute("CREATE TRIGGER prepare_proof_fault BEFORE INSERT ON public.reply_invalidated_key "
                               "FOR EACH ROW EXECUTE FUNCTION public.prepare_proof_fault()")
        try:
            status, rejected = self.backend.request(path + "/replies/prepare", command)
            self.assertEqual(status, 503, rejected)
            self.assertNotIn("no_generation", rejected)
            self.assertEqual(self.backend.request(path)[1]["turns"], [])
            self.assertEqual(len(self.reply_model.payloads), 0)
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DROP TRIGGER prepare_proof_fault ON public.reply_invalidated_key")
                connection.execute("DROP FUNCTION public.prepare_proof_fault()")
        command.pop("expected_input_version_id")
        self.assertEqual(self.backend.request(path + "/replies/prepare", command)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 0)
