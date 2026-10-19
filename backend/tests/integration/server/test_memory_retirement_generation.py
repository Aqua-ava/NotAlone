"""纠错、状态变化与旧记录回看通过公开助手会话边界验收。"""

import json
import unittest
from concurrent.futures import ThreadPoolExecutor

import psycopg
from uuid import UUID, uuid4

from langchain_core.messages import HumanMessage
from tests.integration.server import test_historical_reply_basis as historical_fixture


class MemoryRetirementGenerationHttpTest(unittest.TestCase):
    setUpClass = classmethod(historical_fixture.HistoricalReplyBasisHttpTest.setUpClass.__func__)
    setUp = historical_fixture.HistoricalReplyBasisHttpTest.setUp
    _memory = historical_fixture.HistoricalReplyBasisHttpTest._memory
    _generate = historical_fixture.HistoricalReplyBasisHttpTest._generate
    _continue_command = historical_fixture.HistoricalReplyBasisHttpTest._continue_command
    _restart_backend = historical_fixture.HistoricalReplyBasisHttpTest._restart_backend

    def _correct(self, kind, memory_id, *, change_kind="error_correction"):
        path = (f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/correct"
                if kind == "contact" else f"/api/memories/owner/{memory_id}/correct")
        status, result = self.fixture.backend.request(path, {
            "text": "更正后喜欢看书，希望表达轻松自然。", "change_kind": change_kind,
        })
        self.assertEqual(status, 200, result)
        return result

    def test_contact_error_preserves_audit_but_blocks_continuation(self):
        self._error_correction_blocks("contact")

    def test_owner_error_preserves_audit_but_blocks_continuation(self):
        self._error_correction_blocks("owner")

    def _error_correction_blocks(self, kind):
        memory_id, _, generated = self._generate(kind)
        self._correct(kind, memory_id)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        turn = saved["turns"][0]
        self.assertEqual(turn["reply"]["candidates"], generated["candidates"])
        self.assertIn("memory_generation_forbidden", [item["reason"] for item in turn["basis_changes"]])
        calls = len(self.fixture.model.seen_calls)
        body = self.fixture._body(draft="重新讨论这段内容")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        status, result = self.fixture.backend.request(self.path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)

    def test_state_change_keeps_old_candidate_eligible_as_labeled_history(self):
        memory_id, _, generated = self._generate("contact")
        self._correct("contact", memory_id, change_kind="state_changed")
        body = self.fixture._body(draft="这次先轻松问候")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        status, result = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, result)
        payload = next(json.loads(item.content) for item in self.fixture.model.seen_calls[-1]
                       if isinstance(item, HumanMessage))
        self.assertTrue(any(item["kind"] == "continued_candidate" for item in payload["evidence"]))

    def test_fresh_generation_does_not_restore_corrected_candidate_from_discussion(self):
        memory_id, _, generated = self._generate("contact")
        self._correct("contact", memory_id)
        body = self.fixture._body(draft="全新合成问候")
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        status, result = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, result)
        payload = next(json.loads(item.content) for item in self.fixture.model.seen_calls[-1]
                       if isinstance(item, HumanMessage))
        self.assertNotIn(generated["candidates"][0]["candidate_id"], json.dumps(payload))

    def test_prepared_candidate_is_rejected_after_correction_and_restart(self):
        memory_id, _, generated = self._generate("owner")
        body = self.fixture._body(draft="先准备一段简短问候")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        status, receipt = self.fixture.backend.request(self.path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self._correct("owner", memory_id)
        calls = len(self.fixture.model.seen_calls)
        restarted = self._restart_backend()
        status, result = restarted.request(self.path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)

    def test_correction_during_generation_prevents_commit(self):
        memory_id, _, generated = self._generate("contact")
        body = self.fixture._body(draft="再来一段轻松问候")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.fixture.backend.request, self.path + "/replies", body)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                self._correct("contact", memory_id)
            finally:
                gate.set()
            status, result = future.result(timeout=10)
        self.assertNotEqual(status, 200, result)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertIsNone(saved["turns"][-1]["reply"])
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], generated["candidates"])

    def test_legacy_unknown_retirement_cannot_continue(self):
        memory_id, _, generated = self._generate("contact")
        # 模拟迁移保留下来的、无法推断原因的历史状态；不补造用户分类。
        with psycopg.connect(historical_fixture.session_fixture.DATABASE_URL) as connection:
            connection.execute("UPDATE public.confirmed_memory SET status='invalidated', "
                "retirement_reason='unknown',revision=revision+1 WHERE owner_id=%s AND id=%s",
                (self.fixture.owner_id, memory_id))
        body = self.fixture._body(draft="重新讨论这段内容")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        status, result = self.fixture.backend.request(self.path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_corrected_candidate_cannot_reenter_through_saved_style_sample(self):
        memory_id, _, generated = self._generate("contact")
        samples = f"/api/contacts/{self.fixture.contact_id}/style-samples"
        body = {"idempotency_key": str(uuid4()), "text": "合成错误记忆影响过的表达样本。",
            "origin": {"kind": "candidate", "id": generated["candidates"][0]["candidate_id"]}}
        status, saved = self.fixture.backend.request(samples, body)
        self.assertEqual(status, 200, saved)
        self._correct("contact", memory_id)
        self.assertEqual(self.fixture.backend.request(samples + "/" + saved["sample"]["sample_id"])[0], 200)
        body["idempotency_key"] = str(uuid4())
        self.assertNotEqual(self.fixture.backend.request(samples, body)[0], 200)
        from tests.integration.server.overview_reply_support import OverviewReplyControlledModel
        self.fixture.model = OverviewReplyControlledModel()
        self.fixture.model.plans.append({"text": "全新问候。", "basis": "沿用当前草稿。", "cite_kinds": ["user_draft"]})
        restarted = self._restart_backend()
        status, generated = restarted.request(self.path + "/replies", self.fixture._body(draft="全新问候"))
        self.assertEqual(status, 200, generated)
        payload = next(json.loads(item.content) for item in self.fixture.model.seen_calls[-1]
                       if isinstance(item, HumanMessage))
        self.assertEqual(payload["style_references"], [])

    def test_sample_only_candidate_blocks_continuation_after_origin_memory_correction(self):
        memory_id, _, original = self._generate("contact")
        samples = f"/api/contacts/{self.fixture.contact_id}/style-samples"
        status, saved = self.fixture.backend.request(samples, {
            "idempotency_key": str(uuid4()), "text": "合成表达样本，句子简短。",
            "origin": {"kind": "candidate", "id": original["candidates"][0]["candidate_id"]}})
        self.assertEqual(status, 200, saved)
        status, session = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/assistant-sessions", {})
        self.assertEqual(status, 200, session)
        path = self.fixture._path(session["session_id"])
        from tests.integration.server.overview_reply_support import OverviewReplyControlledModel
        self.fixture.model = OverviewReplyControlledModel()
        self.fixture.model.plans.append({"text": "天气不错。", "basis": "按当前草稿。", "cite_kinds": ["user_draft"]})
        restarted = self._restart_backend()
        body = self.fixture._body(draft="天气不错")
        body["content"]["include_relationship_context"] = True
        status, generated = restarted.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        payload = next(json.loads(item.content) for item in self.fixture.model.seen_calls[-1]
                       if isinstance(item, HumanMessage))
        self.assertTrue(payload["style_references"])
        self.assertNotIn(memory_id, [item["evidence_id"] for item in payload["evidence"]])
        self._correct("contact", memory_id)
        calls = len(self.fixture.model.seen_calls)
        self.fixture.model.plans.append({"text": "继续问候。", "basis": "按当前草稿。", "cite_kinds": ["user_draft"]})
        body = self.fixture._body(draft="继续问候")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        status, result = restarted.request(path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        status, audit = restarted.request(path)
        self.assertEqual(status, 200, audit)
        self.assertIn("memory_generation_forbidden",
                      [change["reason"] for change in audit["turns"][0]["basis_changes"]])
        status, fresh = restarted.request(path + "/replies", self.fixture._body(draft="全新问候"))
        self.assertEqual(status, 200, fresh)
        payload = next(json.loads(item.content) for item in self.fixture.model.seen_calls[-1]
                       if isinstance(item, HumanMessage))
        self.assertNotIn(generated["candidates"][0]["candidate_id"], json.dumps(payload))

    def test_saved_sample_chain_keeps_retirement_guards_after_both_origin_sessions_are_deleted(self):
        memory_id, _, original = self._generate("contact")
        samples = f"/api/contacts/{self.fixture.contact_id}/style-samples"

        def save_sample(generated, text):
            status, saved = self.fixture.backend.request(samples, {
                "idempotency_key": str(uuid4()), "text": text,
                "origin": {"kind": "candidate", "id": generated["candidates"][0]["candidate_id"]}})
            self.assertEqual(status, 200, saved)
            return saved["sample"]["sample_id"]

        root_sample = save_sample(original, "合成原始表达参考。")
        from tests.integration.server.overview_reply_support import OverviewReplyControlledModel
        self.fixture.model = OverviewReplyControlledModel()
        restarted = self._restart_backend()

        def new_generation():
            status, session = restarted.request(f"/api/contacts/{self.fixture.contact_id}/assistant-sessions", {})
            self.assertEqual(status, 200, session)
            path = self.fixture._path(session["session_id"])
            self.fixture.model.plans.append({"text": "天气不错。", "basis": "按当前草稿。", "cite_kinds": ["user_draft"]})
            body = self.fixture._body(draft="天气不错")
            body["content"]["include_relationship_context"] = True
            status, generated = restarted.request(path + "/replies", body)
            self.assertEqual(status, 200, generated)
            return path, generated

        child_path, child = new_generation()
        child_sample = save_sample(child, "合成间接表达参考。")
        for path in (self.path, child_path):
            status, deleted = restarted.request(path, {"confirmed": True}, method="DELETE")
            self.assertEqual(status, 200, deleted)
        path, generated = new_generation()
        self.assertEqual(set(generated["context_receipt"]["style_sample_ids"]), {root_sample, child_sample})
        with psycopg.connect(historical_fixture.session_fixture.DATABASE_URL) as connection:
            captured = dict(connection.execute(
                "SELECT sample_id,dependency_ids FROM public.style_sample_generation_dependency "
                "WHERE owner_id=%s AND contact_id=%s",
                (self.fixture.owner_id, self.fixture.contact_id)).fetchall())
        self.assertIn(UUID(str(memory_id)), captured[UUID(root_sample)])
        self.assertIn(UUID(root_sample), captured[UUID(child_sample)])
        self._correct("contact", memory_id)
        calls = len(self.fixture.model.seen_calls)
        body = self.fixture._body(draft="继续问候")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        status, result = restarted.request(path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        _, fresh = new_generation()
        self.assertEqual(fresh["context_receipt"]["style_sample_ids"], [])
        for sample in (root_sample, child_sample):
            self.assertEqual(restarted.request(samples + "/" + sample)[0], 200)
        self.assertEqual(restarted.request(samples + "/" + root_sample, method="DELETE")[0], 200)
        with psycopg.connect(historical_fixture.session_fixture.DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.style_sample_generation_dependency WHERE owner_id=%s AND contact_id=%s",
                (self.fixture.owner_id, self.fixture.contact_id)).fetchone()[0], 0)
