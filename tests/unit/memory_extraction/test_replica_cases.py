"""固定合成复刻场景通过公开窗口接口进入同一提取边界。"""

import json
import unittest
from dataclasses import asdict, replace
from datetime import datetime

from notalone.memory_extraction.replica_cases import ReplicaCase, build_replica_window


class ReplicaWindowTest(unittest.TestCase):
    def test_window_preserves_source_times_unknown_and_target_boundary(self):
        case = ReplicaCase(
            case_id="窗口公开构造",
            split="development",
            dimension="source",
            messages=(
                ("self", "合成上下文。", "2026-09-30T23:50:00+08:00"),
                ("contact", "合成时间未知的回答。", None),
                ("contact", "合成下一日陈述。", "2026-10-01T00:10:00+08:00"),
            ),
            targets=(1, 2),
            gold=(),
            forbidden=(),
        )
        first = build_replica_window(case)
        replay = build_replica_window(case)
        self.assertEqual(first, replay)
        self.assertEqual(first.messages[0].occurred_at,
                         datetime.fromisoformat("2026-09-30T23:50:00+08:00"))
        self.assertIsNone(first.messages[1].occurred_at)
        self.assertEqual(first.messages[2].occurred_at,
                         datetime.fromisoformat("2026-10-01T00:10:00+08:00"))
        self.assertEqual(first.target_message_id_set,
                         {first.messages[1].message_id, first.messages[2].message_id})
        self.assertNotIn(first.messages[0].message_id, first.target_message_id_set)
        self.assertEqual(len(first.message_id_set), 3)

    def test_frozen_cases_expose_development_holdout_and_source_bound_gold(self):
        from notalone.memory_extraction.replica_cases import REPLICA_CASES

        self.assertEqual(len(REPLICA_CASES), 24)
        self.assertEqual(sum(case.split == "development" for case in REPLICA_CASES), 8)
        self.assertEqual(sum(case.split == "holdout" for case in REPLICA_CASES), 16)
        self.assertEqual(len({case.case_id for case in REPLICA_CASES}), 24)
        claim_ids = [claim.claim_id for case in REPLICA_CASES for claim in case.gold]
        self.assertEqual(len(set(claim_ids)), len(claim_ids))
        self.assertTrue(any(not case.gold for case in REPLICA_CASES))
        for case in REPLICA_CASES:
            with self.subTest(case=case.case_id):
                window = build_replica_window(case)
                self.assertLessEqual(len(window.target_message_id_set), 20)
                self.assertEqual(len(window.messages), len(case.messages))
                for claim in case.gold:
                    self.assertTrue(set(claim.source_indices) & set(case.targets))
                    self.assertTrue(set(claim.source_indices) <= set(range(len(case.messages))))
                    self.assertTrue(claim.meaning)
                    for oracle in (claim.valid_at, claim.invalid_at):
                        if oracle.mode == "allowed":
                            self.assertTrue(oracle.allowed)
                            for allowed in oracle.allowed:
                                if allowed is not None:
                                    self.assertIsNotNone(datetime.fromisoformat(allowed).tzinfo)
                json.dumps(asdict(case), ensure_ascii=False)

    def test_source_window_rejects_target_outside_scope_duplicates_and_over_budget(self):
        from notalone.memory_extraction.replica_cases import REPLICA_CASES

        base = REPLICA_CASES[0]
        for targets in ((-1,), (2,), (0, 0)):
            with self.subTest(targets=targets), self.assertRaises(ValueError):
                build_replica_window(replace(base, targets=targets))
        over_budget = replace(
            base,
            messages=tuple(("contact", f"合成第{index}条。", None) for index in range(21)),
            targets=tuple(range(21)),
        )
        with self.assertRaises(ValueError):
            build_replica_window(over_budget)

    def test_independent_cases_use_distinct_contacts_and_source_ids(self):
        from notalone.memory_extraction.replica_cases import REPLICA_CASES

        windows = [build_replica_window(case) for case in REPLICA_CASES]
        self.assertEqual(len({window.owner_id for window in windows}), 1)
        self.assertEqual(len({window.contact_id for window in windows}), 24)
        source_ids = [message.message_id for window in windows for message in window.messages]
        self.assertEqual(len(set(source_ids)), len(source_ids))


if __name__ == "__main__":
    unittest.main()
