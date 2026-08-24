"""后端连接信息握手文件的单元测试。"""

from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from notalone.server.connection_info import (
    backend_info_path,
    has_active_backend,
    remove_backend_info,
    write_backend_info,
)


class BackendInfoPathTest(unittest.TestCase):
    def test_default_path_is_home_dotnotalone(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                backend_info_path(),
                Path.home() / ".notalone" / "backend.info",
            )

    def test_env_variable_overrides_path(self) -> None:
        with patch.dict(
            os.environ,
            {"NOTALONE_BACKEND_INFO": "/tmp/notalone-test-backend.info"},
            clear=True,
        ):
            self.assertEqual(
                backend_info_path(),
                Path("/tmp/notalone-test-backend.info"),
            )


class BackendInfoRoundTripTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.info_path = Path(self._temp_dir.name) / "backend.info"
        self._env = patch.dict(
            os.environ,
            {"NOTALONE_BACKEND_INFO": str(self.info_path)},
            clear=True,
        )
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        remove_backend_info()
        self._temp_dir.cleanup()

    def test_write_creates_0600_file_with_address_token_and_pid(self) -> None:
        write_backend_info(address="127.0.0.1:54567", token="secret-token")

        self.assertTrue(self.info_path.is_file())
        mode = stat.S_IMODE(self.info_path.stat().st_mode)
        self.assertEqual(mode, 0o600)
        lines = self.info_path.read_text(encoding="utf-8").splitlines()
        self.assertIn("address=127.0.0.1:54567", lines)
        self.assertIn("token=secret-token", lines)
        self.assertTrue(
            any(line.startswith("pid=") for line in lines),
            "握手文件应记录 pid 供单实例检测。",
        )

    def test_has_active_backend_true_when_pid_alive(self) -> None:
        write_backend_info(address="127.0.0.1:54567", token="t", pid=os.getpid())

        self.assertTrue(has_active_backend())

    def test_has_active_backend_false_after_process_exit(self) -> None:
        import subprocess
        import sys

        # 用一个已退出的进程 pid：子进程启动后立刻结束。
        exited = subprocess.Popen([sys.executable, "-c", "pass"])
        exited.wait()
        write_backend_info(
            address="127.0.0.1:54567", token="t", pid=exited.pid
        )

        self.assertFalse(has_active_backend())

    def test_has_active_backend_false_without_file(self) -> None:
        self.assertFalse(has_active_backend())

    def test_has_active_backend_false_with_invalid_pid_line(self) -> None:
        self.info_path.write_text("address=127.0.0.1:1\n" "token=t\n", encoding="utf-8")
        self.assertFalse(has_active_backend())

    def test_write_is_atomic_replace(self) -> None:
        write_backend_info(address="127.0.0.1:1", token="first")
        write_backend_info(address="127.0.0.1:2", token="second")

        self.assertEqual(
            self.info_path.read_text(encoding="utf-8"),
            "address=127.0.0.1:2\n" "token=second\n" f"pid={os.getpid()}\n",
        )

    def test_remove_deletes_file(self) -> None:
        write_backend_info(address="127.0.0.1:1", token="first")
        remove_backend_info()

        self.assertFalse(self.info_path.exists())

    def test_remove_missing_file_is_noop(self) -> None:
        remove_backend_info()
        self.assertFalse(self.info_path.exists())

    def test_rejects_empty_address_or_token(self) -> None:
        with self.assertRaises(ValueError):
            write_backend_info(address="", token="secret")
        with self.assertRaises(ValueError):
            write_backend_info(address="127.0.0.1:1", token="")


if __name__ == "__main__":
    unittest.main()