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

    def test_reusable_information_boundaries_reach_both_e2_requests(self) -> None:
        source = window("这件事情请先保密。")
        for events in (False, True):
            with self.subTest(events=events):
                request, facts = self.sdk_result(
                    source, labels(row("0:0", "request", unresolved=True)), events=events,
                )
                prompt = request["messages"][0]["content"]
                for rule in ("事项、对象及角色", "不能仅因家里／住处或来访就选family",
                             "一次性消息传递动作", "纯礼貌谢语用greeting", "明确承诺、关系约束"):
                    self.assertTrue(rule in prompt, f"实际E2请求缺少边界指导：{rule}")
                self.assertTrue(facts[0]["alternatives"])
                self.assertEqual(facts[0]["speech_act"], "request")

    def test_given_omissions_do_not_erase_neighboring_facts_or_real_commitments(self) -> None:
        controls = (
            ("我完成了说明书，辛苦你啦。", ("event", "greeting"), 1, "assertion"),
            ("我稍后把文件发过去。", ("not_memory",), 0, None),
            ("我保证明天把合同交给你。", ("plan",), 1, "plan"),
            ("我明天按约定把签好的合同发给你。", ("plan",), 1, "plan"),
            ("以后别公开我的地址。", ("request",), 1, "request"),
            ("我弟弟明天来访。", ("plan",), 1, "plan"),
        )
        for text, kinds, count, speech in controls:
            for events in (False, True):
                with self.subTest(text=text, events=events):
                    source = window(text)
                    _, facts = self.sdk_result(source, labels(*(row(f"0:{index}", kind)
                        for index, kind in enumerate(kinds))), events=events)
                    self.assertEqual(len(facts), count)
                    if facts:
                        self.assertEqual(facts[0]["speech_act"], speech)
                        self.assertIn(text.split("，")[0], facts[0]["text"])
                        self.assertEqual(facts[0]["source_message_ids"], [str(source.messages[0].message_id)])

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
