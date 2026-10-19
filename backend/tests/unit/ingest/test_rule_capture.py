"""规则摘要反映每次执行边界读取的真实文件，不沿用旧版本。"""

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import tempfile
import unittest

from notalone.source_processing.rule_capture import capture_execution


class RuleCaptureTest(unittest.TestCase):
    def test_each_execution_reads_changed_rule_file(self):
        started_at = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            rule = Path(directory) / "synthetic_rule.py"
            rule.write_bytes(b"synthetic rule one\n")
            first = capture_execution(started_at, str(rule))
            rule.write_bytes(b"synthetic rule two\n")
            second = capture_execution(started_at, str(rule))
        self.assertEqual(first["rule_version"], hashlib.sha256(b"synthetic rule one\n").hexdigest())
        self.assertEqual(second["rule_version"], hashlib.sha256(b"synthetic rule two\n").hexdigest())
        self.assertEqual(first["started_at"], started_at.isoformat())
        self.assertLessEqual(first["finished_at"], second["finished_at"])
