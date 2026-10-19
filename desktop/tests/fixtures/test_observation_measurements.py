"""只用合成stderr核验验收计数，不运行探针或读取微信。"""

import unittest
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from observation_measurements import install, summarize_native, native_result


class ObservationMeasurementsTests(unittest.TestCase):
    def test_native_failure_does_not_become_successful_observation(self):
        self.assertEqual(native_result('{"ok":false,"error":"合成私密失败"}'), "native-failed")
        self.assertEqual(native_result('{"ok":true,"wechat_in_front":false}'), "paused")
        self.assertEqual(native_result('{"ok":true,"wechat_in_front":true,"display_name":"合成甲"}'), "recognized")
        self.assertEqual(native_result('私人文字'), "invalid")

    def test_probe_start_is_visible_before_boundary_returns(self):
        from notalone.server.app import BackendApp
        from notalone.front_sync.session_worker import NativeSessionWorker

        original_run, original_handle = subprocess.run, BackendApp.handle
        original_worker_observe = NativeSessionWorker.observe
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "numeric.jsonl"
            destination.touch(mode=0o600)

            def boundary(*args, **kwargs):
                records = [json.loads(line) for line in destination.read_text().splitlines()]
                self.assertEqual([record["kind"] for record in records], ["installed", "probe-start"])
                return subprocess.CompletedProcess(args[0], 0, '{"ok":false}', '')

            try:
                with patch.dict(os.environ, {"NOTALONE_OBSERVATION_MEASUREMENT_FILE": str(destination),
                                             "NOTALONE_SYNC_PROBE": "synthetic-probe"}):
                    subprocess.run = boundary
                    install()
                    subprocess.run(["synthetic-probe"])
            finally:
                subprocess.run, BackendApp.handle = original_run, original_handle
                NativeSessionWorker.observe = original_worker_observe

    def test_measurement_keeps_real_subprocess_output_and_timeout_semantics(self):
        from notalone.server.app import BackendApp
        from notalone.front_sync.session_worker import NativeSessionWorker

        original_run, original_handle = subprocess.run, BackendApp.handle
        original_worker_observe = NativeSessionWorker.observe
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "numeric.jsonl"
            destination.touch(mode=0o600)
            try:
                with patch.dict(os.environ, {"NOTALONE_OBSERVATION_MEASUREMENT_FILE": str(destination),
                                             "NOTALONE_SYNC_PROBE": sys.executable}):
                    install()
                    result = subprocess.run([sys.executable, "-c", "print('合成私密名称')"],
                                            capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.stdout, "合成私密名称\n")
                    with self.assertRaises(subprocess.TimeoutExpired):
                        subprocess.run([sys.executable, "-c", "import time; time.sleep(1)"],
                                       capture_output=True, text=True, timeout=0.01)
            finally:
                subprocess.run, BackendApp.handle = original_run, original_handle
                NativeSessionWorker.observe = original_worker_observe
            saved = destination.read_text()
            self.assertNotIn("合成私密名称", saved)
            records = [json.loads(line) for line in saved.splitlines()]
            self.assertEqual([record["kind"] for record in records], ["installed", "probe-start", "probe", "probe-start", "probe"])
            completed = [record for record in records if record["kind"] == "probe"]
            self.assertEqual([record["outcome"] for record in completed], ["returned", "timeout"])
            self.assertTrue(all(record["complete"] is False for record in completed))

    def test_single_header_frame_and_monotonic_durations(self):
        events = [
            ("started", 1), ("foregroundAccepted", 1.01),
            ("captureRequested", 1.02), ("captureCompleted", 1.12),
            ("frameReceived", 1.13), ("headerOcrStarted", 1.2),
            ("headerOcrCompleted", 1.4), ("finished", 1.5),
        ]
        result = summarize_native("".join(f"notalone-observation-v1 {key} {value}\n" for key, value in events))
        self.assertTrue(result["complete"])
        self.assertEqual(result["capture_requests"], 1)
        self.assertEqual(result["frames_received"], 1)
        self.assertAlmostEqual(result["native_ms"], 500)
        self.assertAlmostEqual(result["ocr_ms"], 200)

    def test_non_foreground_and_timeout_are_not_fabricated_success(self):
        idle = summarize_native("notalone-observation-v1 started 1\nnotalone-observation-v1 finished 1.01\n")
        self.assertTrue(idle["complete"])
        self.assertEqual(idle["capture_requests"], 0)
        partial = summarize_native(b"notalone-observation-v1 started 1\nnotalone-observation-v1 captureRequested 1.1\n")
        self.assertFalse(partial["complete"])
        self.assertEqual(partial["capture_requests"], 1)
        self.assertIsNone(partial["native_ms"])

    def test_invalid_or_private_content_never_enters_report(self):
        for raw in ["私人文字", "notalone-observation-v1 私人文字 1\n",
                    "notalone-observation-v1 started nan\n",
                    "notalone-observation-v1 started 2\nnotalone-observation-v1 finished 1\n",
                    "notalone-observation-v1 started 1\n" * 50]:
            result = summarize_native(raw)
            self.assertFalse(result["complete"])
            self.assertNotIn("私人文字", str(result))


if __name__ == "__main__":
    unittest.main()
