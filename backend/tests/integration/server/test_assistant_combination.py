"""A19多来源与后继／携入交叉验收：真实HTTP、正式迁移和合成资料。"""

from __future__ import annotations

import time
import unittest
from uuid import UUID, uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture


class AssistantCombinationHttpTest(FidelityHttpFixture, unittest.TestCase):
    def _session(self, contact_id: str) -> str:
        saved = self._get_or_post(f"/api/contacts/{contact_id}/assistant-session/default", {})
        return f"/api/contacts/{contact_id}/assistant-sessions/{saved['session_id']}"

    def _get_or_post(self, path: str, body: dict | None = None) -> dict:
        status, data = self.backend.request(path, body)
        self.assertEqual(status, 200, data)
        return data

    def _generate(self, path: str, contact_id: str, text: str, *, target: str | None = None) -> tuple[dict, dict]:
        current = self._get_or_post(path)["current_input_version_id"]
        content = ({"type": "reply_to_message", "target_message_id": target, "direction": text}
                   if target else {"type": "rewrite_draft", "draft_text": text})
        body = {"contact_id": contact_id, "idempotency_key": str(uuid4()), "content": content}
        if current:
            body["expected_input_version_id"] = current
        self.reply_model.plans.append({"text": text, "basis": "保留本次合成明确意愿。"})
        return self._get_or_post(path + "/replies", body), body

    def _carry(self, path: str, generated: dict) -> str:
        candidate = generated["candidates"][0]["candidate_id"]
        version = self._get_or_post(path + f"/candidates/{candidate}/versions")["versions"][0]["version_id"]
        selected = self._get_or_post(path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate, "version_id": version,
        })
        carried = self._get_or_post(path + "/new-with-candidate", {
            "expected_selection_id": selected["selection_id"], "candidate_id": candidate, "version_id": version,
        })
        return path.rsplit("/", 1)[0] + "/" + carried["session_id"]

    def _share_target_source(self, contact_id: str, target_id: str) -> str:
        """仅安排第二份合成原始来源；业务结果仍从公开HTTP读取。"""
        source_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-combination-second.jsonl',%s,1)",
                (source_id, self.owner_id, UUID(contact_id), uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic:second','{}'::jsonb)",
                (UUID(target_id), self.owner_id, UUID(contact_id), source_id),
            )
        return str(source_id)

    def _delete_source(self, contact_id: str, source_id: str) -> None:
        path = f"/api/contacts/{contact_id}/sources"
        status, result = self.backend.request(path + "/" + source_id, method="DELETE")
        self.assertEqual(status, 202, result)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            source = next(item for item in self._get_or_post(path)["sources"] if item["source_id"] == source_id)
            self.assertNotEqual(source["task_status"], "failed", source)
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                return
            time.sleep(0.02)
        self.fail("本轮合成来源删除未可靠完成。")

    def _assert_redacted(self, path: str, body: dict) -> None:
        saved = self._get_or_post(path)
        self.assertIsNone(saved["current_input_version_id"])
        self.assertEqual(len(saved["inputs"]), 2)
        self.assertEqual(len(saved["turns"]), 1)
        self.assertTrue(all(item["state"] == "redacted" and item["content"] is None for item in saved["inputs"]))
        self.assertTrue(all(turn["state"] == "redacted" and turn["input"] is None and turn["reply"] is None
                            for turn in saved["turns"]))
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 409)

    def test_two_sources_delete_transitive_successors_and_carries_without_reviving_other_contact(self) -> None:
        contact_a, target, source_a = self.prepare_contact(self.owner_id)
        assert target is not None and source_a is not None
        source_b = self._share_target_source(contact_a, target)
        contact_b, _, _ = self.prepare_contact(self.owner_id, history=False)
        path_a, path_b = self._session(contact_a), self._session(contact_b)
        self._generate(path_b, contact_b, "乙的独立合成讨论与候选。")
        kept_b = self._get_or_post(path_b)
        foreign = self._backend(self.other_owner_id)
        self.assertEqual(foreign.request(path_a), (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(path_a.replace(contact_a, contact_b)), (404, {"error": "not_found"}))

        first, first_body = self._generate(path_a, contact_a, "甲第一轮依赖两份来源的合成候选。", target=target)
        child = self._carry(path_a, first)
        successor, successor_body = self._generate(child, contact_a, "甲携入后继续生成的合成后继。")
        independent = self._get_or_post(path_a + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "与原始来源无关的独立合成讨论。"},
        })
        calls = len(self.reply_model.seen_model_payloads)
        self._delete_source(contact_a, source_a)
        messages = self._get_or_post(f"/api/contacts/{contact_a}/messages")["messages"]
        self.assertTrue(any(item["message_id"] == target for item in messages))
        self._assert_redacted(child, successor_body)
        remaining = self._get_or_post(path_a)
        self.assertEqual(remaining["current_input_version_id"], independent["input_version_id"])
        self.assertEqual(remaining["turns"][0]["state"], "redacted")
        self.assertIsNone(remaining["turns"][0]["reply"])
        self.assertEqual(self.backend.request(path_a + "/replies", first_body)[0], 409)
        self.assertEqual(self.backend.request(f"/api/contacts/{contact_a}/replies/{successor['reply_request_id']}/evidence")[0], 404)
        self.assertEqual(self._get_or_post(path_b), kept_b)
        self.assertEqual(len(self.reply_model.seen_model_payloads), calls)

        # 尚有合法来源时，由用户明确新请求；原失效键和携入副本不会因此恢复。
        fresh, fresh_body = self._generate(path_a, contact_a, "甲仅凭仍有效来源重新确认的合成候选。", target=target)
        fresh_child = self._carry(path_a, fresh)
        _, fresh_successor = self._generate(fresh_child, contact_a, "甲第二来源携入后生成的合成后继。")
        calls = len(self.reply_model.seen_model_payloads)
        self._delete_source(contact_a, source_b)
        self.assertFalse(any(item["message_id"] == target for item in
                             self._get_or_post(f"/api/contacts/{contact_a}/messages")["messages"]))
        self._assert_redacted(child, successor_body)
        self._assert_redacted(fresh_child, fresh_successor)
        self.assertEqual(self.backend.request(path_a + "/replies", fresh_body)[0], 409)
        remaining = self._get_or_post(path_a)
        self.assertIsNone(remaining["current_input_version_id"])
        self.assertEqual(next(item["state"] for item in remaining["inputs"]
                              if item["input_version_id"] == independent["input_version_id"]), "active")
        self.assertEqual(next(item["content"]["purpose_hint"] for item in remaining["inputs"]
                              if item["input_version_id"] == independent["input_version_id"]),
                         "与原始来源无关的独立合成讨论。")
        self.assertEqual(self._get_or_post(path_b), kept_b)
        self.assertEqual(len(self.reply_model.seen_model_payloads), calls)
        self.assertEqual(calls, 5)
        print("assistant_combination_http: contacts=2 sources=2 models=5 "
              "deleted_replay_delta=0 successors_redacted=true independent_discussion_kept=true")


if __name__ == "__main__":
    unittest.main()
