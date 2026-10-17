"""场景正文工具穿过公开HTTP、真实PG与受控模型的合同。"""

import json
import unittest

from langchain_core.messages import ToolMessage

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server.test_layered_reply_context import LayeredReplyHttpTest


class ScenarioReadHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    controlled = LayeredReplyHttpTest.controlled
    read = LayeredReplyHttpTest.read
    enable = LayeredReplyHttpTest.enable
    prepare_layered_reply = LayeredReplyHttpTest.prepare_layered_reply

    def test_actual_tool_paragraphs_are_sent_and_saved_for_evidence(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        self.layered_reply_options["layered_reply_budget"] = LayeredReplyBudget(4, 4, 4000,
            scenario_read=ScenarioReadBudget(3, 4, 4000))
        self.backend = self._backend(self.owner_id)
        scenario = ready["scenarios"][0]
        self.reply_model.plans.extend([
            {"history": {"name": "read_scenario", "args": {
                "scenario_id": scenario["scenario_id"], "paragraph_start": 0, "paragraph_end": 1}}},
            {"text": "我们一起上过课。", "basis": "按本次实际读取的主题正文。"},
        ])
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊一起上课。"))
        self.assertEqual(status, 200, turn)
        tool = next(message for message in self.reply_model.seen_calls[1]
                    if isinstance(message, ToolMessage) and message.name == "read_scenario")
        self.assertTrue(tool.content.startswith("{"), tool.content)
        receipt = json.loads(tool.content)
        self.assertEqual(receipt["status"], "succeeded")
        document = receipt["document"]
        self.assertEqual(document["version_id"], scenario["version_id"])
        self.assertEqual(document["paragraph_range"], [0, 1])
        self.assertEqual(document["paragraphs"], scenario["paragraphs"][:1])
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(evidence["layered_scenario_reads"], [receipt])
        self.assertNotIn("paragraphs", evidence["layered_context"]["directory"][0])
        self.assertEqual(evidence["retrieval"]["budgets"]["source_messages"]["used_calls"], 0)
