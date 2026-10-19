"""基准公开命令在连接前拒绝 libpq 的远程端点覆盖。"""

import os
from pathlib import Path
import subprocess
import sys
import unittest


class SourceProcessingBenchmarkCommandTest(unittest.TestCase):
    def test_remote_address_and_service_overrides_fail_before_database_access(self):
        script = Path(__file__).resolve().parents[3] / "benchmarks/source_processing_batch.py"
        cases = (
            ("host=localhost hostaddr=203.0.113.1", {}),
            ("host=/tmp service=synthetic_service", {}),
            ("host=/tmp", {"PGHOSTADDR": "203.0.113.1"}),
            ("host=/tmp", {"PGSERVICE": "synthetic_service"}),
            ("host=/tmp", {"PGSERVICEFILE": "/tmp/synthetic-service.conf"}),
        )
        for instance, overrides in cases:
            with self.subTest(instance=instance, overrides=overrides):
                environment = dict(os.environ)
                for name in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
                    environment.pop(name, None)
                environment.update(PYTHONHASHSEED="0", NOTALONE_DISABLE_DOTENV="1", **overrides)
                result = subprocess.run(
                    [sys.executable, str(script), "--revision", "HEAD", "--mode", "count",
                     "--instance", instance, "--output", "/tmp/synthetic-rejected-benchmark.json"],
                    env=environment, capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("禁止 hostaddr/service", result.stderr)
