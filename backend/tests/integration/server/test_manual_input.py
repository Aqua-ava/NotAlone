"""手动输入的公开认证 HTTP 补充回归；最高接缝仍为实际 App。"""

import json
from pathlib import Path
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class ManualInputHttpTest(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    def manual_request(self, path, body=None, *, contact_id=None, backend=None):
        backend = backend or self.backend
        headers = {"Authorization": f"Bearer {backend.token}", "Content-Type": "application/json"}
        if contact_id is not None:
            headers["X-NotAlone-Manual-Contact"] = contact_id
        request = Request(backend.base_url + path, data=json.dumps(body).encode() if body is not None else None,
                          headers=headers, method="POST" if body is not None else "GET")
        try:
            with urlopen(request, timeout=20) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def create_contact(self, name="合成手动联系人"):
        request = {"request_id": str(uuid4()), "display_name": name}
        status, value = self.manual_request("/api/contacts", request)
        self.assertEqual(status, 201, value)
        self.assertEqual(value["contact"]["display_name"], name)
        return value["contact"]["contact_id"], request

    def test_creation_is_idempotent_and_manual_confirmation_never_becomes_a_channel_binding(self):
        contact, request = self.create_contact()
        self.assertEqual(self.manual_request("/api/contacts", request)[0], 201)
        directory = self.manual_request("/api/contacts")[1]["contacts"]
        self.assertEqual(len(directory), 1)
        self.assertEqual(directory[0]["data_status"], {"message_count": 0, "source_count": 0})
        default = f"/api/contacts/{contact}/assistant-session/default"
        self.assertEqual(self.manual_request(default, {}, contact_id=contact)[0], 409)
        self.assertEqual(self.manual_request(f"/api/contacts/{contact}/manual-confirmation", {})[0], 200)
        self.assertEqual(self.manual_request(default, {})[0], 409)
        self.assertEqual(self.manual_request(default, {}, contact_id=contact)[0], 200)
        self.assertEqual(self.manual_request("/api/sync/foreground/observe", {}, contact_id=contact)[0], 400)
        other, _ = self.create_contact("另一位合成联系人")
        self.assertEqual(self.manual_request(f"/api/contacts/{other}/assistant-session/default", {}, contact_id=contact)[0], 400)
        self.assertEqual(self.manual_request(default, {}, contact_id=contact, backend=self.other_backend)[0], 404)

    def test_pasted_current_text_is_distinct_from_the_owners_draft_and_requires_direction(self):
        contact, _ = self.create_contact()
        self.assertEqual(self.manual_request(f"/api/contacts/{contact}/manual-confirmation", {})[0], 200)
        status, value = self.manual_request(f"/api/contacts/{contact}/assistant-session/default", {}, contact_id=contact)
        self.assertEqual(status, 200, value)
        session = value["session_id"]
        path = f"/api/contacts/{contact}/assistant-sessions/{session}"
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {
            "type": "rewrite_draft", "input_kind": "current_chat", "draft_text": "合成甲：今晚要一起去吗？",
            "pasted_direction": "今天不去，简短婉拒", "include_relationship_context": False}}
        self.reply_model.plans.append({"text": "今天先不去了，下次再约。", "basis": "沿用你明确的婉拒方向。"})
        missing_direction = {**body, "content": {**body["content"], "pasted_direction": ""}}
        self.assertEqual(self.manual_request(path + "/replies", missing_direction, contact_id=contact)[0], 400)
        status, prepared = self.manual_request(path + "/replies/prepare", body, contact_id=contact)
        self.assertEqual(status, 200, prepared)
        self.assertEqual(prepared["request_key"], body["idempotency_key"])
        status, value = self.manual_request(path + "/replies", body, contact_id=contact)
        self.assertEqual(status, 200, value)
        status, evidence = self.manual_request(f"/api/contacts/{contact}/replies/{value['reply_request_id']}/evidence")
        self.assertEqual(status, 200, evidence)
        self.assertIn("user_current_chat", [item["kind"] for item in evidence["evidence"]])
        self.assertEqual(self.manual_request(path + "/replies", body, contact_id=contact)[1]["reply_request_id"], value["reply_request_id"])
        self.assertEqual(self.manual_request(f"/api/contacts/{contact}/memories")[1]["memories"], [])
        self.assertEqual(self.manual_request(f"/api/contacts/{contact}/memory-candidates")[1]["candidates"], [])
        self.reply_model.plans.append({"text": "今天先不去啦，下次再约。", "basis": "保留原方向，只调整语气。"})
        histories = [self.manual_request(path + f"/candidates/{candidate['candidate_id']}/versions", contact_id=contact)[1]
                     for candidate in value["candidates"]]
        continuation = {"idempotency_key": str(uuid4()), "expected_input_version_id": value["input_version_id"],
                        "instruction": "自然一点", "displayed_group": {"session_id": session,
                        "candidate_group_id": value["reply_request_id"], "candidates": [
                            {"number": history["candidate_number"], "candidate_id": history["candidate_id"],
                             "version_id": history["default_display_version_id"]} for history in histories]}}
        status, continued = self.manual_request(path + "/continue", continuation, contact_id=contact)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["effective_input"]["input_kind"], "current_chat")
        self.assertEqual(continued["effective_input"]["pasted_direction"], "今天不去，简短婉拒")
        self.assertEqual(continued["effective_input"]["draft_text"], "合成甲：今晚要一起去吗？")
        self.assertEqual(self.manual_request(path + "/continue", continuation)[0], 409)
        status, saved = self.manual_request(path, contact_id=contact)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][-1]["input"]["content"]["input_kind"], "current_chat")

    def test_new_internal_contact_accepts_only_confirmed_single_contact_import_and_source_deletion(self):
        contact, _ = self.create_contact()
        fixtures = Path(__file__).resolve().parents[2] / "fixtures"
        for name in ("mixed_contacts.jsonl", "invalid_json.jsonl"):
            status, value = self.manual_request("/api/imports/preview", {"path": str(fixtures / name), "contact_id": contact})
            self.assertEqual(status, 422, value)
        status, preview = self.manual_request("/api/imports/preview", {
            "path": str(fixtures / "valid_single_contact.jsonl"), "contact_id": contact})
        self.assertEqual(status, 200, preview)
        self.assertEqual(preview["record_count"], 6)
        self.assertEqual(self.manual_request("/api/contacts")[1]["contacts"][0]["data_status"], {"message_count": 0, "source_count": 0})
        status, receipt = self.manual_request("/api/imports/commit", {"path": str(fixtures / "valid_single_contact.jsonl"),
            "contact_id": contact, "expected_content_sha256": preview["content_sha256"]})
        self.assertEqual(status, 200, receipt)
        self.assertEqual(receipt["contact_id"], contact)
        self.assertEqual(receipt["imported_count"], 6)
        self.assertEqual(self.manual_request(f"/api/contacts/{contact}/assistant-session/default", {})[0], 409)
        status, sources = self.manual_request(f"/api/contacts/{contact}/sources")
        self.assertEqual(status, 200, sources)
        self.assertEqual(sources["sources"][0]["status"], "active")
        source = sources["sources"][0]["source_id"]
        self.assertEqual(self.other_backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")[0], 404)
        status, deleted = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, deleted)
        status, started = self.manual_request("/api/tasks/run", {"contact_id": contact, "task_id": deleted["task_id"]})
        self.assertEqual(status, 200, started)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current = self.manual_request(f"/api/contacts/{contact}/sources")[1]["sources"][0]
            if current["status"] == "deleted":
                break
            time.sleep(0.02)
        self.assertEqual(current["status"], "deleted", current)
        current = self.manual_request(f"/api/contacts/{contact}/sources")[1]["sources"][0]
        self.assertIn(current["status"], {"delete_requested", "deleted"}, current)
        self.assertEqual(self.manual_request(f"/api/contacts/{contact}/messages")[1]["messages"], [])

    def test_manual_confirmation_cannot_reauthorize_an_external_prepared_generation(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        path = f"/api/contacts/{contact}/assistant-session/default"
        status, session = self.manual_request(path, {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {
            "type": "rewrite_draft", "draft_text": "合成已确认外部范围的草稿。"}}
        status, prepared = self.manual_request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.assertEqual(self.manual_request(f"/api/contacts/{contact}/manual-confirmation", {})[0], 200)
        status, rejected = self.manual_request(path + "/replies", body, contact_id=contact)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(len(self.reply_model.seen_calls), 0)
        body["idempotency_key"] = str(uuid4())
        status, prepared = self.manual_request(path + "/replies/prepare", body, contact_id=contact)
        self.assertEqual(status, 200, prepared)
        status, rejected = self.manual_request(path + "/replies", body)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(len(self.reply_model.seen_calls), 0)

    def test_interrupted_manual_paste_requires_reconfirmation_and_preserves_its_source(self):
        contact, _ = self.create_contact()
        self.manual_request(f"/api/contacts/{contact}/manual-confirmation", {})
        status, session = self.manual_request(f"/api/contacts/{contact}/assistant-session/default", {}, contact_id=contact)
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {
            "type": "rewrite_draft", "input_kind": "current_chat", "draft_text": "合成甲：今晚要一起去吗？",
            "pasted_direction": "今天不去，简短婉拒", "include_relationship_context": False}}
        status, prepared = self.manual_request(path + "/replies/prepare", body, contact_id=contact)
        self.assertEqual(status, 200, prepared)
        status, interrupted = self.manual_request(path + "/interrupt", {"request_key": prepared["request_key"],
            "input_version_id": prepared["input_version_id"], "reason": "configuration_reload"}, contact_id=contact)
        self.assertEqual(status, 200, interrupted)
        self.assertEqual(interrupted["interruption_reason"], "configuration_reload")
        recovery = {"original_turn_id": prepared["turn_id"], "original_input_version_id": prepared["input_version_id"],
                    "request_key": str(uuid4())}
        self.assertEqual(self.manual_request(path + "/retry-interrupted/prepare", recovery)[0], 409)
        # 被拒的准备键有明确未领取证明且不可复用；重新确认后用新的操作键。
        recovery["request_key"] = str(uuid4())
        status, recovered = self.manual_request(path + "/retry-interrupted/prepare", recovery, contact_id=contact)
        self.assertEqual(status, 200, recovered)
        self.reply_model.plans.append({"text": "今天先不去了，下次再约。", "basis": "保留本次明确的婉拒方向。"})
        status, result = self.manual_request(path + "/retry-interrupted", recovery, contact_id=contact)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["restored_input"]["content"]["input_kind"], "current_chat")
        self.assertEqual(result["restored_input"]["content"]["pasted_direction"], "今天不去，简短婉拒")
        self.assertEqual(result["restored_input"]["continuation"]["effective_intent"]["source"], "direction")
        self.assertEqual(self.reply_model.payloads[-1]["input_mode"], "reply_to_pasted_text")

    def test_unconfigured_model_proves_only_a_genuinely_unreserved_prepare(self):
        from notalone.server.app import create_app
        from tests.integration.server.core_business_flow_support import HttpBackend
        contact, _ = self.create_contact()
        self.manual_request(f"/api/contacts/{contact}/manual-confirmation", {})
        unavailable = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
            token="synthetic-manual-no-model"), self.owner_id)
        self.addCleanup(unavailable.close)
        status, session = self.manual_request(f"/api/contacts/{contact}/assistant-session/default", {}, contact_id=contact, backend=unavailable)
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/replies/prepare"
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {
            "type": "rewrite_draft", "draft_text": "合成模型尚未配置。"}}
        status, rejected = self.manual_request(path, body, contact_id=contact, backend=unavailable)
        self.assertEqual(status, 503, rejected)
        self.assertEqual(rejected.get("no_generation"), {"contact_id": contact, "session_id": session["session_id"],
            "request_key": body["idempotency_key"], "state": "not_reserved"})
        status, invalidated = self.manual_request(path, body, contact_id=contact)
        self.assertEqual(status, 409, invalidated)
        self.assertEqual(invalidated.get("reason"), "request_deleted")
        self.assertEqual(len(self.reply_model.seen_calls), 0)
        body["idempotency_key"] = str(uuid4())
        status, prepared = self.manual_request(path, body, contact_id=contact)
        self.assertEqual(status, 200, prepared)
        status, rejected = self.manual_request(path, body, contact_id=contact, backend=unavailable)
        self.assertEqual(status, 503, rejected)
        self.assertNotIn("no_generation", rejected)
        # 已排队／准备身份已存在时，不能发未领取证明；实际运行和完成也相同。
        from concurrent.futures import ThreadPoolExecutor
        gate = self.reply_model.pause_next_response()
        self.reply_model.entered.clear()
        self.reply_model.plans.append({"text": "合成正常执行。", "basis": "仅使用本次合成草稿。"})
        with ThreadPoolExecutor(max_workers=1) as executor:
            generating = executor.submit(self.manual_request, path.removesuffix("/prepare"), body, contact_id=contact)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, running = self.manual_request(path, body, contact_id=contact, backend=unavailable)
                self.assertEqual(status, 503, running)
                self.assertNotIn("no_generation", running)
            finally:
                gate.set()
            self.assertEqual(generating.result(timeout=10)[0], 200)
        status, completed = self.manual_request(path, body, contact_id=contact, backend=unavailable)
        self.assertEqual(status, 503, completed)
        self.assertNotIn("no_generation", completed)
