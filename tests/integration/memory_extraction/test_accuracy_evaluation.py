"""合成准确率冒烟：只有专用凭据才调用模型，完全不访问数据库。"""
import os
import unittest

from notalone.memory_extraction.evaluation import API_KEY_ENV, build_window, evaluate_case
from notalone.memory_extraction.evaluation_cases import CASES


@unittest.skipUnless(os.environ.get(API_KEY_ENV, '').strip(), '未提供专用评测凭据。')
class AccuracyEvaluationSmokeTest(unittest.TestCase):
    def test_synthetic_cases(self) -> None:
        from notalone.memory_extraction.adapters import LangChainExtractionRuntime
        from notalone.reply.adapters.deepseek_provider import build_deepseek_model

        runtime = LangChainExtractionRuntime(
            model=build_deepseek_model(api_key=os.environ[API_KEY_ENV])
        )
        for case in CASES:
            with self.subTest(case=case.name):
                result = evaluate_case(case, build_window(case), runtime)
                self.assertTrue(result.passed, result)
