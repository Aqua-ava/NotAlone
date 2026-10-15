"""评测协议选择接缝；v4只接显式固定计划，不改变生产默认。"""
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

import httpx
from langchain_core.language_models import BaseChatModel


class EvaluationExtractionTest(unittest.TestCase):
    def test_v4_selects_actual_contract_tool_and_runtime(self):
        from notalone.memory_extraction.evaluation_extraction import (
            EvaluationExtractionMode, extraction_contract, extraction_runtime, extraction_tool_name,
        )
        from notalone.memory_extraction.grounded_adapter import (
            GROUNDED_V4_PROMPT, GroundedV4ExtractionRuntime, grounded_schema_v4,
        )
        from tests.unit.memory_extraction.test_grounded_extraction import window

        source = window("我姐把她的车借给我了。")
        selected = EvaluationExtractionMode("grounded-v4")
        self.assertTrue(selected.is_grounded)
        self.assertEqual(extraction_contract(selected, source),
                         (GROUNDED_V4_PROMPT, grounded_schema_v4(source)))
        self.assertEqual(extraction_tool_name(selected), "GroundedMemoryLabelsV4")
        self.assertIsInstance(extraction_runtime(selected, Mock(spec=BaseChatModel)), GroundedV4ExtractionRuntime)

    def test_generic_offline_rejects_v4_before_budget_or_home(self):
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
        from notalone.memory_extraction.evaluation_offline import run_offline_evaluation

        with patch.object(EvaluationBudget, "create", side_effect=AssertionError("不创建预算")), \
                patch.object(Path, "home", side_effect=AssertionError("不读home")):
            with self.assertRaisesRegex(EvaluationBudgetAbort, "offline_v4_fixed_plan_required"):
                run_offline_evaluation(
                    cases=(CASES[0],), output_directory=Path("/unused"), run_id=uuid4(),
                    request_limit=2, synthetic_transport=httpx.MockTransport(lambda request: None),
                    extraction_mode="grounded-v4",
                )
