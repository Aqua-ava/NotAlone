"""评测用例集结构测试：维度拆分后仍保持导出兼容与顺序。

这些测试只读合成用例的元数据，不调用模型、不读真实聊天。
"""

from __future__ import annotations

import unittest

from notalone.memory_extraction.cases import (
    media,
    paraphrase,
    reference,
    reported,
    subject,
    time,
    truth_intent,
)
from notalone.memory_extraction.evaluation_cases import (
    CASES,
    ClaimExpectation,
    EvaluationCase,
    ExpectedDestination,
)

# 维度模块与评测维度名的对应；新增维度时这里必须一起改。
DIMENSION_MODULES = {
    "reference": reference,
    "subject": subject,
    "truth_intent": truth_intent,
    "paraphrase": paraphrase,
    "time": time,
    "reported": reported,
    "media": media,
}


class CasesStructureTest(unittest.TestCase):
    def test_cases_export_covers_exactly_the_dimension_modules(self) -> None:
        """`CASES` 必须恰好由各维度模块组成，既不漏也不多。"""

        module_cases = tuple(
            case for module in DIMENSION_MODULES.values() for case in module.CASES
        )
        self.assertEqual(len(CASES), len(module_cases))
        self.assertCountEqual((case.name for case in CASES),
                              (case.name for case in module_cases))

    def test_every_case_uses_the_expected_destination_enum(self) -> None:
        """期望去向必须用评测层枚举，不能再出现裸字符串。"""

        for case in CASES:
            with self.subTest(case=case.name):
                self.assertIsInstance(case.expect, ExpectedDestination)
                self.assertIn(case.expect, tuple(ExpectedDestination))
                for claim in case.expected_claims or ():
                    self.assertIsInstance(claim, ClaimExpectation)
                    self.assertIsInstance(claim.destination, ExpectedDestination)

    def test_dimension_module_membership_matches_case_dimension(self) -> None:
        """每条用例必须落在与自身 `dimension` 一致的模块里。"""

        for dimension, module in DIMENSION_MODULES.items():
            for case in module.CASES:
                with self.subTest(case=case.name):
                    self.assertEqual(case.dimension, dimension)
                    self.assertIsInstance(case, EvaluationCase)

    def test_case_names_are_unique(self) -> None:
        """严格命题 oracle 按名字索引，重名会让覆盖静默错位。"""

        names = [case.name for case in CASES]
        self.assertEqual(len(names), len(set(names)))

    def test_compatibility_entry_point_reexports_same_objects(self) -> None:
        """兼容入口必须导出同一批对象，避免两处真相。"""

        from notalone.memory_extraction import evaluation_cases

        self.assertIs(evaluation_cases.CASES, CASES)
        self.assertIs(evaluation_cases.EvaluationCase, EvaluationCase)
        self.assertIs(evaluation_cases.ExpectedDestination, ExpectedDestination)


if __name__ == "__main__":
    unittest.main()
