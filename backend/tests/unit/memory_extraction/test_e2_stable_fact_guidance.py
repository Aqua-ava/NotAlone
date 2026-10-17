"""E2指导经实际SDK发送；给定标签不代签模型分类质量。"""

from __future__ import annotations

from contextlib import ExitStack
import json
import os
import socket
from typing import Any
import unittest
from unittest.mock import patch

import httpx

from notalone.memory_extraction.evaluation_extraction import extraction_contract
from notalone.memory_extraction.grounded_adapter import (
    GroundedExtractionRuntime, GroundedV2ExtractionRuntime, grounded_schema,
)
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction.runtime import ExtractionPayload
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels
from tests.unit.memory_extraction.test_grounded_v3_runtime import response


class E2StableFactGuidanceTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def sdk_result(
        self, source: ExtractionWindow, draft: dict[str, Any], *, events: bool = False,
    ) -> tuple[dict[str, Any], ExtractionPayload]:
        requests: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(json.loads(request.content))
            payload = response(draft, name="GroundedMemoryLabels").json()
            payload["model"] = "deepseek-flash"
            return httpx.Response(200, json=payload)

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(
                api_key="synthetic-secret", model_name="deepseek-flash",
                base_url="https://api.deepseek.com", http_client=client,
            )
            runtime = GroundedExtractionRuntime if events else GroundedV2ExtractionRuntime
            facts = runtime(model=model).extract(source)

        self.assertEqual(len(requests), 1)
        return requests[0], facts

    def test_stable_occupation_uses_guided_existing_kind_without_observation_date(self) -> None:
        source = window("我目前是桥梁检测员。")
        request, facts = self.sdk_result(source, labels(row("0:0", "event", topic="work")))
        prompt = request["messages"][0]["content"]
        self.assertIn("稳定身份、职业、专业", prompt)
        self.assertIn("真实开始日", prompt)
        self.assertIn("第三方身份仍用third_party_fact", prompt)
        self.assertEqual(extraction_contract("grounded-v2", source), (prompt, grounded_schema(source)))
        tool = request["tools"][0]["function"]
        self.assertEqual(tool["name"], "GroundedMemoryLabels")
        self.assertEqual(tool["parameters"]["properties"], grounded_schema(source)["properties"])
        self.assertEqual(tool["parameters"]["required"], ["units"])
        self.assertFalse(tool["parameters"]["additionalProperties"])
        self.assertNotIn("tool_choice", request)
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["text"], "联系人原话：“我目前是桥梁检测员。”")
        self.assertEqual(facts[0]["category"], "common_fact")
        self.assertEqual(facts[0]["speech_act"], "assertion")
        self.assertEqual(facts[0]["assertion_status"], "asserted")
        self.assertIsNone(facts[0]["valid_at"])
        self.assertIsNone(facts[0]["invalid_at"])

    def test_default_event_protocol_keeps_e2_stable_semantics_and_its_independent_schema(self) -> None:
        source = window("我目前是桥梁检测员。")
        request, facts = self.sdk_result(source, labels(row("0:0", "event", topic="work")), events=True)
        self.assertIn("稳定身份、职业、专业", request["messages"][0]["content"])
        self.assertIn("event为null或受控对象", request["messages"][0]["content"])
        slot = request["tools"][0]["function"]["parameters"]["properties"]["units"]["properties"]["0:0"]
        self.assertIn("event", slot["required"])
        self.assertNotIn("event", grounded_schema(source)["properties"]["units"]["properties"]["0:0"]["properties"])
        self.assertEqual(facts[0]["text"], "联系人原话：“我目前是桥梁检测员。”")
        self.assertEqual((facts[0]["valid_at"], facts[0]["invalid_at"]), (None, None))

    def test_given_labels_preserve_types_dates_and_existing_kind_enum(self) -> None:
        controls = (
            ("我学的是水文勘测。", "event", "common_fact", "assertion", "asserted", False),
            ("我领到工具了。", "event", "common_fact", "assertion", "asserted", False),
            ("我还不知道轮班结果。", "state", "recent_state", "assertion", "asserted", True),
            ("我本周临时在西岸值班。", "state", "recent_state", "assertion", "asserted", True),
            ("我明天去踏勘。", "plan", "recent_state", "plan", "asserted", True),
            ("我哥是模型师。", "third_party_fact", "relationship_note", "report", "reported", False),
            ("我不是测绘员。", "event", "common_fact", "assertion", "asserted", False),
            ("我的岗位还不清楚。", "unknown", "relationship_note", "unknown", "unknown", False),
        )
        for text, kind, category, speech, assertion, dated in controls:
            with self.subTest(text=text):
                source = window(text)
                request, facts = self.sdk_result(source, labels(row("0:0", kind)))
                self.assertEqual(len(facts), 1)
                fact = facts[0]
                self.assertIn(text, fact["text"])
                self.assertEqual((fact["category"], fact["speech_act"], fact["assertion_status"]),
                                 (category, speech, assertion))
                self.assertEqual(fact["valid_at"] is not None, dated)
                parameters = request["tools"][0]["function"]["parameters"]
                label = parameters["properties"]["units"]["properties"]["0:0"]
                kind_choices = label["properties"]["kind"]["enum"]
                self.assertNotIn("stable_fact", kind_choices)


if __name__ == "__main__":
    unittest.main()
