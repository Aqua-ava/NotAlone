"""分阶段输出上限经实际SDK冻结及故障硬停验证。"""
import unittest
from tests.integration.memory_extraction import test_evaluation_reference16_teaching as shared

class Reference16VToken32kSDKTest(unittest.TestCase):
    _exercise_sdk = shared.Reference16TeachingSDKTest._exercise_sdk

    def test_actual_sdk_uses_unchanged_e_and_independent_thinking_v(self):
        self._exercise_sdk(execution_plan="reference16-pro-retention-v-token32k-v1", verification_profile="reference-retention-v1")

    def test_source_drift_stops_before_v_dispatch(self):
        self._exercise_sdk(execution_plan="reference16-pro-retention-v-token32k-v1", verification_profile="reference-retention-v1", source_drift=True)

    def test_last_unknown_is_not_plan_complete(self):
        result = self._exercise_sdk(execution_plan="reference16-pro-retention-v-token32k-v1", verification_profile="reference-retention-v1", unknown_at_last=True)
        self.assertEqual(result["outcomes"][-1]["status"], "unknown")
        self.assertFalse(result["receipt"]["plan_complete"])
        self.assertFalse(result["summary"]["plan_complete"])

    def test_invalid_v_completion_stops_after_one_v_attempt(self):
        for fault in ("missing_tool", "multiple_tools", "length", "content_filter", "model_identity"):
            with self.subTest(fault=fault):
                result = self._exercise_sdk(execution_plan="reference16-pro-retention-v-token32k-v1",
                    verification_profile="reference-retention-v1", verification_fault=fault)
                self.assertNotEqual(result["stopped_code"], "synthetic_raw_review_stop")

    def test_invalid_nested_v_json_keeps_digest_and_unknown_without_retry(self):
        result = self._exercise_sdk(execution_plan="reference16-pro-retention-v-token32k-v1",
            verification_profile="reference-retention-v1", verification_fault="nested_json_invalid")
        gap, = result["receipt"]["capture_gaps"]
        self.assertEqual(gap["redaction_failure_code"], "nested_json_invalid")
        self.assertEqual(gap["capture_form"], "digest_only")
        self.assertEqual(result["outcomes"][0]["status"], "unknown")
