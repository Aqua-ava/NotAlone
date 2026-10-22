"""评测代码与生产导入路径的隔离：懒加载导出仍可用，但不在 import 时加载。"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


class RetrievalEvaluationLazyExportTest(unittest.TestCase):
    def test_public_names_still_importable(self) -> None:
        from notalone.retrieval import (  # noqa: F401
            EvaluationRate,
            RetrievalEvaluationCase,
            RetrievalEvaluationReport,
            SyntheticRetrievalFixture,
            build_synthetic_retrieval_fixture,
            evaluate_retrieval,
        )

        self.assertTrue(callable(evaluate_retrieval))
        self.assertTrue(callable(build_synthetic_retrieval_fixture))
        self.assertTrue(isinstance(EvaluationRate, type))
        self.assertTrue(isinstance(RetrievalEvaluationCase, type))
        self.assertTrue(isinstance(RetrievalEvaluationReport, type))
        self.assertTrue(isinstance(SyntheticRetrievalFixture, type))

    def test_unknown_attribute_still_raises(self) -> None:
        import notalone.retrieval as retrieval

        with self.assertRaises(AttributeError):
            retrieval.not_a_real_export  # noqa: B018

    def test_production_import_does_not_load_evaluation_module(self) -> None:
        backend = Path(__file__).resolve().parents[3]
        script = (
            "import sys; import notalone.server.app, notalone.reply.context, notalone.retrieval;"
            "print('notalone.retrieval.evaluation' in sys.modules)"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=backend,
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        self.assertEqual(result.stdout.strip(), "False")
