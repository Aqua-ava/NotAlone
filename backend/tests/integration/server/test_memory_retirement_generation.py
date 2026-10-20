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

    def test_contact_state_change_preserves_audit_but_blocks_continuation(self):
        self._state_change_blocks_continuation("contact")

    def test_owner_state_change_preserves_audit_but_blocks_continuation(self):
        self._state_change_blocks_continuation("owner")

    def _state_change_blocks_continuation(self, kind):
        memory_id, _, generated = self._generate(kind)
        self._correct(kind, memory_id, change_kind="state_changed")
        calls = len(self.fixture.model.seen_calls)
        body = self.fixture._body(draft="这次先轻松问候")
        body["continued_from_candidate_id"] = generated["candidates"][0]["candidate_id"]
        status, result = self.fixture.backend.request(self.path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.fixture.model.seen_calls), calls)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertIn("memory_generation_forbidden", [
            item["reason"] for turn in saved["turns"] for item in turn["basis_changes"]])

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
