"""通过真实 HTTP 验收核心闭环；共享夹具不收集为测试用例。"""

import json
import time
import unittest
from uuid import uuid4

from langchain_core.messages import ToolMessage

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, tool_response,
)


class CoreBusinessFlowHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    def test_import_reply_replay_isolation_and_source_deletion(self) -> None:
        a = self._import(self.backend, "A", "茉莉茶")
        self._run_import(self.backend, a)
        b = self._import(self.backend, "B", "乌龙茶")
        self._run_import(self.backend, b)
        other = self._import(self.other_backend, "另一用户", "大红袍")
        self._run_import(self.other_backend, other)
        self.assertEqual(len(self.extraction_model.seen_calls), 6)
        body, reply = self._reply(self.backend, a)
        self._reply(self.backend, b)
        self._reply(self.other_backend, other)

        # 换一个 HTTP 服务实例读取原候选，证明重放使用 PostgreSQL 持久化结果。
        reopened = self._backend(self.owner_id)
        calls = len(self.reply_model.seen_calls)
        self.assertEqual(reopened.request("/api/reply/generate", body), (200, reply))
        self.assertEqual(len(self.reply_model.seen_calls), calls)
        for backend, wrong_contact in ((self.backend, b["contact_id"]),
                                       (self.other_backend, a["contact_id"])):
            path = self._evidence_path(a, reply).replace(a["contact_id"], wrong_contact)
            self.assertEqual(backend.request(path), (404, {"error": "not_found"}))
        cross_target = {**body, "idempotency_key": str(uuid4()), "contact_id": b["contact_id"]}
        self.assertNotEqual(self.backend.request("/api/reply/generate", cross_target)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), calls)

        source_path = f"/api/contacts/{a['contact_id']}/sources/{a['source']['source_id']}"
        self.assertEqual(self.other_backend.request(source_path, method="DELETE"),
                         (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(source_path.replace(a["contact_id"], b["contact_id"]),
                                              method="DELETE"), (404, {"error": "not_found"}))
        status, deleted = self.backend.request(source_path, method="DELETE")
        self.assertEqual(status, 202, deleted)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            source = self._get(self.backend, f"/api/contacts/{a['contact_id']}/sources")["sources"][0]
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                break
            self.assertNotEqual(source["task_status"], "failed", source)
            time.sleep(0.02)
        self.assertEqual(source["status"], "deleted", source)
        self.assertEqual(source["task_status"], "succeeded")
        self.assertEqual(source["task_id"], deleted["task_id"])
        self.assertIsNone(source["file_name"])
        self.assertEqual(self._get(self.backend, f"/api/contacts/{a['contact_id']}/messages")["messages"], [])
        self.assertEqual(self._get(self.backend, f"/api/contacts/{a['contact_id']}/memories")["memories"], [])
        self.assertEqual(reopened.request(self._evidence_path(a, reply)),
                         (404, {"error": "not_found"}))
        continued = {"contact_id": a["contact_id"], "idempotency_key": str(uuid4()),
                     "continued_from_candidate_id": reply["candidates"][0]["candidate_id"],
                     "content": {"type": "rewrite_draft", "draft_text": "自然回应",}}
        self.assertNotEqual(reopened.request("/api/reply/generate", continued)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), calls)

        # 已授权背景润色仍实际执行检索；删后仅可引用本次草稿。
        self.reply_model.responses.extend([
            tool_response("conversation_search", {"query": "核心验收", "top_k": 8}),
            tool_response("ReplyRuntimeOutput", {
                "candidates": [{"text": "我们聊聊茶。", "basis": "仅依据本次草稿。",
                                "citation_ids": [str(self.draft_evidence_id)], "risk_notes": []}],
                "used_skill_version_id": None,
            }),
        ])
        status, after = reopened.request("/api/reply/generate", {
            "contact_id": a["contact_id"], "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "我们聊聊茉莉茶。",
                        "include_relationship_context": True},
        })
        self.assertEqual(status, 200, after)
        evidence = self._get(reopened, self._evidence_path(a, after))["evidence"]
        self.assertEqual([item["kind"] for item in evidence], ["user_draft"])
        tool_result = next(message for message in self.reply_model.seen_calls[-1]
                           if isinstance(message, ToolMessage) and message.name == "conversation_search")
        self.assertEqual(json.loads(tool_result.content)["status"], "empty")
        self.assertEqual(json.loads(tool_result.content)["messages"], [])
        for backend, imported in ((self.backend, b), (self.other_backend, other)):
            self.assertEqual(self._get(backend, f"/api/contacts/{imported['contact_id']}/messages")["messages"],
                             imported["messages"])
            self.assertEqual(self._get(backend, f"/api/contacts/{imported['contact_id']}/memories")["memories"],
                             [imported["memory"]])
            self.assertEqual(self._get(backend, f"/api/contacts/{imported['contact_id']}/sources")["sources"],
                             [imported["source"]])


if __name__ == "__main__":
    unittest.main()
