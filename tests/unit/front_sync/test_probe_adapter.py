"""macOS 前台定位探针适配器的单元测试。

只验证进程输出契约的解析与失败关闭行为，不截取屏幕、不连接数据库。
"""

from __future__ import annotations

import json
import subprocess
import unittest
from dataclasses import dataclass

from notalone.front_sync.probe_adapter import (
    FrontSessionProbeObservation,
    MacosFrontSessionProbe,
    ProbeAdapterError,
)


@dataclass(frozen=True)
class FakeCommandResult:
    returncode: int
    stdout: str
    stderr: str = ""


class MacosFrontSessionProbeTest(unittest.TestCase):
    def _probe(self, runner) -> MacosFrontSessionProbe:
        return MacosFrontSessionProbe(runner=runner)

    def test_parses_full_evidence_from_front_session(self) -> None:
        stdout = json.dumps(
            {
                "ok": True,
                "wechat_in_front": True,
                "display_name": "合成甲",
                "selected_row_name": "合成甲",
                "last_time_text": "19:59",
                "preview_text": "合成预览",
            },
            ensure_ascii=False,
        )
        calls: list[tuple[str, ...]] = []

        def runner(command: tuple[str, ...]) -> FakeCommandResult:
            calls.append(command)
            return FakeCommandResult(returncode=0, stdout=stdout)

        observation = self._probe(runner).observe()

        self.assertEqual(calls, [("notalone-sync-probe", "--session", "--json")])
        self.assertTrue(observation.wechat_in_front)
        self.assertIsNotNone(observation.evidence)
        assert observation.evidence is not None
        self.assertEqual(observation.evidence.display_name, "合成甲")
        self.assertEqual(observation.evidence.last_time_text, "19:59")
        self.assertEqual(observation.evidence.preview_text, "合成预览")

    def test_not_frontmost_returns_no_evidence(self) -> None:
        stdout = json.dumps({"ok": True, "wechat_in_front": False})
        observation = self._probe(
            lambda command: FakeCommandResult(returncode=0, stdout=stdout)
        ).observe()

        self.assertIsInstance(observation, FrontSessionProbeObservation)
        self.assertFalse(observation.wechat_in_front)
        self.assertIsNone(observation.evidence)

    def test_frontmost_without_readable_evidence_returns_null_fields(
        self,
    ) -> None:
        stdout = json.dumps({"ok": True, "wechat_in_front": True})
        observation = self._probe(
            lambda command: FakeCommandResult(returncode=0, stdout=stdout)
        ).observe()

        self.assertTrue(observation.wechat_in_front)
        self.assertIsNotNone(observation.evidence)
        assert observation.evidence is not None
        self.assertIsNone(observation.evidence.display_name)
        self.assertIsNone(observation.evidence.last_time_text)
        self.assertIsNone(observation.evidence.preview_text)

    def test_failure_envelope_keeps_probe_error_code(self) -> None:
        stdout = json.dumps(
            {"ok": False, "error": "screen_capture_permission_missing"}
        )
        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(
                lambda command: FakeCommandResult(returncode=0, stdout=stdout)
            ).observe()
        self.assertEqual(caught.exception.code, "screen_capture_permission_missing")

    def test_invalid_json_fails_closed(self) -> None:
        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(
                lambda command: FakeCommandResult(returncode=0, stdout="不是 JSON")
            ).observe()
        self.assertEqual(caught.exception.code, "probe_output_invalid")

    def test_missing_frontmost_flag_fails_closed(self) -> None:
        stdout = json.dumps({"ok": True})
        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(
                lambda command: FakeCommandResult(returncode=0, stdout=stdout)
            ).observe()
        self.assertEqual(caught.exception.code, "probe_output_invalid")

    def test_non_text_evidence_field_fails_closed(self) -> None:
        stdout = json.dumps(
            {"ok": True, "wechat_in_front": True, "display_name": 123}
        )
        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(
                lambda command: FakeCommandResult(returncode=0, stdout=stdout)
            ).observe()
        self.assertEqual(caught.exception.code, "probe_output_invalid")

    def test_failed_exit_without_envelope_maps_to_probe_failed(self) -> None:
        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(
                lambda command: FakeCommandResult(returncode=1, stdout="")
            ).observe()
        self.assertEqual(caught.exception.code, "probe_failed")

    def test_missing_executable_maps_to_probe_not_found(self) -> None:
        def runner(command: tuple[str, ...]) -> FakeCommandResult:
            raise FileNotFoundError(command[0])

        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(runner).observe()
        self.assertEqual(caught.exception.code, "probe_not_found")

    def test_timeout_maps_to_probe_timeout(self) -> None:
        def runner(command: tuple[str, ...]) -> FakeCommandResult:
            raise subprocess.TimeoutExpired(cmd=command, timeout=1.0)

        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(runner).observe()
        self.assertEqual(caught.exception.code, "probe_timeout")

    def test_error_message_does_not_echo_probe_output(self) -> None:
        secret_marker = "不应出现在错误中的正文片段"
        with self.assertRaises(ProbeAdapterError) as caught:
            self._probe(
                lambda command: FakeCommandResult(
                    returncode=0, stdout=secret_marker
                )
            ).observe()
        self.assertNotIn(secret_marker, str(caught.exception))
        self.assertNotIn(secret_marker, caught.exception.code)

    def test_empty_executable_rejected(self) -> None:
        with self.assertRaises(ValueError):
            MacosFrontSessionProbe(executable="  ")


if __name__ == "__main__":
    unittest.main()
