"""第三计划实际SDK只改变V提示，遇到冻结漂移与unknown停止。"""
import unittest
from tests.integration.memory_extraction import test_evaluation_reference16_teaching as teaching_tests


class Reference16RetentionSDKTest(unittest.TestCase):
    _exercise_sdk = teaching_tests.Reference16TeachingSDKTest._exercise_sdk

    def test_actual_sdk_keeps_teaching_e_and_freezes_new_retention_v(self):
        self._exercise_sdk(execution_plan="reference16-pro-retention-v1", verification_profile="reference-retention-v1")

    def test_source_drift_between_e_and_v_stops_before_second_dispatch(self):
        self._exercise_sdk(execution_plan="reference16-pro-retention-v1", verification_profile="reference-retention-v1", source_drift=True)

    def test_last_unknown_does_not_become_completed_plan(self):
        result = self._exercise_sdk(execution_plan="reference16-pro-retention-v1", verification_profile="reference-retention-v1", unknown_at_last=True)
        self.assertEqual(result["outcomes"][-1]["status"], "unknown")
        self.assertFalse(result["summary"]["plan_complete"])
        self.assertFalse(result["receipt"]["plan_complete"])
        self.assertTrue(result["receipt"]["budget"]["closed"])
