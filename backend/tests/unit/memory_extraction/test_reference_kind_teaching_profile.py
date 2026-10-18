"""第三人类型教学只改变显式提示；合成传输不认证模型语义质量。"""

import hashlib
import json
import unittest
from unittest.mock import patch

from notalone.memory_extraction import grounded_adapter as adapter
from tests.integration.memory_extraction import test_evaluation_wire_contract as wire_tests
from tests.unit.memory_extraction.test_bounded_runtime_proof import window_for


PROFILE = "reference-kind-teaching-v1"


class ReferenceKindTeachingProfileTest(unittest.TestCase):
    setUp = wire_tests.EvaluationWireContractTest.setUp
    model = wire_tests.EvaluationWireContractTest.model

    def test_factory_isolates_new_profile_and_preserves_frozen_prompt_bytes(self):
        frozen = {
            ("default", False): "837344477304319f03f770e2d94571755d5cee8b445c6f3b3c7c1eeb63fa6a52",
            ("default", True): "ae042d59290766b3fa0a302354af35b97fa550eff3739fbc27ba322e8ef2ac33",
            ("bounded-stage-teaching-v1", False): "abfb51c173c181bacfa180dc696bd4ef5f1978a05b5dc80ccff2b6cde70aa7ce",
            ("bounded-stage-teaching-v1", True): "0d7aad2af7ce64b7304eea5eea0f6324be83f41b0d182826656c2778c76ee16d",
        }
        for (profile, events), digest in frozen.items():
            with self.subTest(profile=profile, events=events):
                prompt = adapter.grounded_v2_prompt(profile, events=events)
                self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(), digest)
        for events in (False, True):
            base = adapter.grounded_v2_prompt(events=events)
            selected = adapter.grounded_v2_prompt(PROFILE, events=events)
            self.assertTrue(selected.startswith(base))
            self.assertIn("<reference_kind_teaching_v1>", selected[len(base):])
            self.assertNotIn("<bounded_stage_teaching_v1>", selected)
        for profile in (None, True, [], "reference-kind-teaching-v2", "reference-uniqueness-v1"):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                adapter.grounded_v2_prompt(profile)
        with self.assertRaises(ValueError):
            adapter.grounded_v4_prompt(PROFILE)

    def test_actual_sdk_selection_preserves_schema_compiler_and_records_prompt_identity(self):
        from notalone.memory_extraction.grounded import compile_labels, compile_event_labels
        window = window_for("我已经收好雨伞了。")
        for runtime_type, events in ((adapter.GroundedExtractionRuntime, True),
                                     (adapter.GroundedV2ExtractionRuntime, False)):
            row = {"kind": "event", "subject": "contact", "topic": "other", "dependency": None,
                   "unresolved": False, "confidence": .6, "sensitivity": "none",
                   **({"event": None} if events else {})}
            draft = {"units": {"0:0": row}}
            original = runtime_type(model=self.model(tool_name="GroundedMemoryLabels", arguments=draft))
            original.extract(window)
            baseline = self.requests[-1][2]
            selected = original.for_prompt_profile(PROFILE)
            with patch.object(adapter, "record") as record:
                facts = selected.extract(window)
            self.assertEqual(facts, (compile_event_labels if events else compile_labels)(window, draft))
            actual = self.requests[-1][2]
            self.assertEqual(actual["tools"], baseline["tools"])
            self.assertEqual(actual["messages"][1:], baseline["messages"][1:])
            prompt = adapter.grounded_v2_prompt(PROFILE, events=events)
            self.assertEqual(actual["messages"][0]["content"], prompt)
            self.assertTrue(record.call_args_list)
            for call in record.call_args_list:
                self.assertEqual(call.args[1]["prompt_profile"], PROFILE)
                self.assertEqual(call.args[1]["prompt_sha256"], hashlib.sha256(json.dumps(
                    prompt, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
            original.extract(window)
            self.assertEqual(self.requests[-1][2], baseline)


if __name__ == "__main__":
    unittest.main()
