"""维度评测 runner 的安全早停契约测试；不读取凭据、不联网。"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


REPO = Path(__file__).resolve().parents[4]
RUNNER = REPO / ".scratch" / "memory-accuracy-next" / "release-eval" / "run_tier_a.py"


def _load_runner():
    spec = importlib.util.spec_from_file_location("memory_dimension_runner", RUNNER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MemoryDimensionRunnerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runner = _load_runner()

    def test_safety_error_stops_on_false_fact_or_wrong_subject(self) -> None:
        for field in ("false_fact_count", "wrong_subject_count"):
            with self.subTest(field=field):
                result = type("Result", (), {
                    "false_fact_count": 0,
                    "wrong_subject_count": 0,
                })()
                setattr(result, field, 1)
                self.assertIsNotNone(self.runner.safety_stop_reason(result))

    def test_clean_result_does_not_stop(self) -> None:
        result = type("Result", (), {
            "false_fact_count": 0,
            "wrong_subject_count": 0,
        })()
        self.assertIsNone(self.runner.safety_stop_reason(result))


if __name__ == "__main__":
    unittest.main()
