"""主体与事实状态场景经公开接口进入有界提取窗口。"""

import unittest
from dataclasses import asdict, replace
from datetime import datetime

from notalone.memory_extraction.flow import ExtractionFlow

from notalone.memory_extraction.fidelity_cases import (
    FIDELITY_CASES,
    build_fidelity_window,
    candidate_payloads,
)
from tests.unit.memory_extraction.test_flow import RecordingRuntime


class FidelityWindowTest(unittest.TestCase):
    def test_window_replays_fixed_source_time_and_preserves_target_context(self):
        case = FIDELITY_CASES[0]

        window = build_fidelity_window(case)

        self.assertEqual(window, build_fidelity_window(case))
        self.assertEqual(window.messages[0].text, "你平时参加什么活动？")
        self.assertEqual(window.messages[1].text, "我一直在社区做自行车安全讲解。")
        self.assertEqual(window.messages[0].sender.value, "contact")
        self.assertEqual(window.messages[1].sender.value, "self")
        self.assertEqual(window.messages[0].occurred_at,
                         datetime.fromisoformat("2026-07-06T10:00:00+08:00"))
        self.assertEqual(window.target_message_id_set, {window.messages[1].message_id})
        self.assertNotIn(window.messages[0].message_id, window.target_message_id_set)

    def test_frozen_suite_covers_eight_subject_and_eight_state_scenarios(self):
        self.assertEqual(len(FIDELITY_CASES), 16)
        self.assertEqual(sum(case.dimension == "subject" for case in FIDELITY_CASES), 8)
        self.assertEqual(sum(case.dimension == "state" for case in FIDELITY_CASES), 8)
        self.assertEqual(len({case.case_id for case in FIDELITY_CASES}), 16)
        windows = [build_fidelity_window(case) for case in FIDELITY_CASES]
        self.assertEqual(len({window.owner_id for window in windows}), 1)
        self.assertEqual(len({window.contact_id for window in windows}), 16)
        source_ids = [message.message_id for window in windows for message in window.messages]
        self.assertEqual(len(set(source_ids)), len(source_ids))

    def test_candidates_enter_public_flow_without_date_or_source_failures(self):
        for case in FIDELITY_CASES:
            with self.subTest(case=case.case_id):
                window = build_fidelity_window(case)
                payloads = candidate_payloads(case)

                outcome = ExtractionFlow(runtime=RecordingRuntime(payloads)).run(window)

                self.assertIsNone(outcome.failure_reason)
                self.assertEqual(outcome.rejected_count, 0)
                self.assertEqual(len(outcome.accepted), 2)
                for fact in outcome.accepted:
                    self.assertTrue(set(fact.source_message_ids) <= window.message_id_set)
                    self.assertTrue(set(fact.source_message_ids) & window.target_message_id_set)
                    self.assertIsNone(fact.valid_at)
                    self.assertIsNone(fact.invalid_at)
                    self.assertTrue(fact.timing.source_time_complete)
                first, second = payloads
                self.assertEqual(first["source_message_ids"], second["source_message_ids"])
                for key in ("category", "topic", "confidence", "risk_flags",
                            "valid_at", "invalid_at", "figurative_type", "alternatives"):
                    self.assertEqual(first[key], second[key])
                if case.dimension == "subject":
                    for key in ("speech_act", "assertion_status"):
                        self.assertEqual(first[key], second[key])
                else:
                    self.assertEqual(first["subject"], second["subject"])

    def test_gold_has_correct_controls_and_state_labels_do_not_require_auto(self):
        cases = {case.case_id: case for case in FIDELITY_CASES}
        for case in FIDELITY_CASES:
            with self.subTest(case=case.case_id):
                self.assertEqual([gold.candidate_index for gold in case.gold], [0, 1])
                self.assertEqual(case.gold[0].verdict, "supported")
                self.assertEqual(case.gold[0].issues, ())
                self.assertIn(case.gold[1].verdict, ("unsupported", "uncertain"))
                self.assertTrue(case.gold[1].issues)
                self.assertTrue(all(gold.reason for gold in case.gold))
        self.assertEqual(cases["subject-04"].candidates[0].subject, "self")
        self.assertEqual(cases["subject-03"].candidates[0].subject, "shared")
        self.assertEqual(cases["subject-06"].candidates[0].text,
                         "联系人的妹妹拥有那台扫描仪。")
        self.assertEqual(cases["state-04"].gold[0].expected_destination, "pending")
        self.assertEqual(cases["state-06"].gold[0].expected_destination, "pending")
        self.assertEqual(cases["state-06"].gold[1].verdict, "uncertain")
        self.assertEqual(cases["state-07"].gold[1].issues, ("pragmatics",))
        self.assertEqual(cases["state-08"].gold[1].verdict, "uncertain")

    def test_invalid_targets_and_candidate_sources_fail_before_model_use(self):
        base = FIDELITY_CASES[0]
        for targets in ((), (-1,), (2,), (1, 1)):
            with self.subTest(targets=targets), self.assertRaises(ValueError):
                build_fidelity_window(replace(base, targets=targets))
        for source_indices in ((), (-1,), (2,), (1, 1), (0,)):
            with self.subTest(source_indices=source_indices):
                malformed = replace(
                    base,
                    candidates=(replace(base.candidates[0], source_indices=source_indices),
                                base.candidates[1]),
                )
                with self.assertRaises(ValueError):
                    candidate_payloads(malformed)

    def test_payload_edit_cannot_change_frozen_cases_or_next_replay(self):
        before = asdict(FIDELITY_CASES[0])
        payloads = candidate_payloads(FIDELITY_CASES[0])
        payloads[0]["text"] = "调用者改写的合成内容"
        payloads[0]["source_message_ids"].append("不是来源")

        replay = candidate_payloads(FIDELITY_CASES[0])

        self.assertEqual(asdict(FIDELITY_CASES[0]), before)
        self.assertEqual(replay[0]["text"], "用户一直在社区做自行车安全讲解。")
        self.assertEqual(len(replay[0]["source_message_ids"]), 1)


if __name__ == "__main__":
    unittest.main()
