"""核心状态提示经实际SDK送达；给定标签不代签模型分类收益。"""
import hashlib
import unittest
from unittest.mock import Mock, patch
from tests.integration.memory_extraction import test_evaluation_wire_contract as wire_tests
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels

PROFILE = "core-current-state-v1"

class CoreCurrentStateProfileTest(unittest.TestCase):
    setUp = wire_tests.EvaluationWireContractTest.setUp
    model = wire_tests.EvaluationWireContractTest.model

    def test_actual_sdk_profile_preserves_current_state_and_default_protocols(self):
        from notalone.memory_extraction import grounded_adapter as adapter
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        source = window("现阶段，我可以临时调整练习顺序。")
        for runtime_type, events in ((adapter.GroundedV2ExtractionRuntime, False), (adapter.GroundedExtractionRuntime, True)):
            draft = labels(row("0:0", "prefix"), row("0:1", "state"))
            if events:
                for value in draft["units"].values():
                    value["event"] = None
            original = runtime_type(model=self.model(tool_name="GroundedMemoryLabels", arguments=draft))
            original.extract(source)
            baseline = self.requests[-1][2]
            with patch.object(adapter, "record") as record:
                facts = original.for_prompt_profile(PROFILE).extract(source)
            actual = self.requests[-1][2]
            self.assertEqual(actual["messages"][1:], baseline["messages"][1:])
            self.assertEqual(actual["tools"], baseline["tools"])
            self.assertIn("当前条件下的能力、可行性或可用性", actual["messages"][0]["content"])
            self.assertEqual(actual["messages"][0]["content"], adapter.grounded_v2_prompt(PROFILE, events=events))
            if not events:
                self.assertEqual(extraction_contract("grounded-v2", source, prompt_profile=PROFILE)[0], actual["messages"][0]["content"])
            fact, = facts
            self.assertEqual((fact["category"], fact["speech_act"], fact["assertion_status"]), ("recent_state", "assertion", "asserted"))
            self.assertEqual(fact["valid_at"], source.messages[0].occurred_at.isoformat())
            self.assertIsNone(fact["invalid_at"])
            self.assertIn("截至", fact["text"])
            self.assertIn(source.messages[0].text, fact["text"])
            for call in record.call_args_list:
                self.assertEqual(call.args[1]["prompt_profile"], PROFILE)
            original.extract(source)
            self.assertEqual(self.requests[-1][2], baseline)

    def test_default_and_other_profiles_remain_isolated(self):
        from notalone.memory_extraction import grounded_adapter as adapter
        from notalone.memory_extraction.evaluation_extraction import extraction_contract, extraction_runtime
        self.assertEqual(hashlib.sha256(adapter.grounded_v2_prompt().encode()).hexdigest(), "837344477304319f03f770e2d94571755d5cee8b445c6f3b3c7c1eeb63fa6a52")
        self.assertNotIn("<core_current_state_v1>", adapter.grounded_v2_prompt(adapter.BOUNDED_STAGE_PROMPT_PROFILE))
        self.assertNotIn("<bounded_stage_teaching_v1>", adapter.grounded_v2_prompt(PROFILE))
        for mode in ("legacy-e14", "grounded-v3", "grounded-v4"):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                extraction_contract(mode, window("合成来源。"), prompt_profile=PROFILE)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                extraction_runtime(mode, Mock(), prompt_profile=PROFILE)

    def test_given_completion_plan_skill_and_habit_keep_existing_interpretation(self):
        from notalone.memory_extraction.grounded_adapter import GroundedV2ExtractionRuntime
        for text, kind in (("我会雕版印刷。", "event"), ("我现在已经调好了刻刀。", "event"),
                           ("我明天调整刻刀。", "plan"), ("我每周都练习篆刻。", "preference")):
            with self.subTest(kind=kind):
                source = window(text)
                model = self.model(tool_name="GroundedMemoryLabels", arguments=labels(row("0:0", kind)))
                original = GroundedV2ExtractionRuntime(model=model)
                self.assertEqual(original.extract(source), original.for_prompt_profile(PROFILE).extract(source))

    def test_given_wrong_event_remains_wrong_without_automatic_relabeling(self):
        from notalone.memory_extraction.grounded_adapter import GroundedV2ExtractionRuntime
        source = window("现阶段，我可以临时调整练习顺序。")
        draft = labels(row("0:0", "prefix"), row("0:1", "event"))
        runtime = GroundedV2ExtractionRuntime(model=self.model(tool_name="GroundedMemoryLabels", arguments=draft), prompt_profile=PROFILE)
        fact, = runtime.extract(source)
        self.assertEqual(fact["category"], "common_fact")
        self.assertIsNone(fact["valid_at"])
        self.assertNotIn("截至", fact["text"])

if __name__ == "__main__":
    unittest.main()
