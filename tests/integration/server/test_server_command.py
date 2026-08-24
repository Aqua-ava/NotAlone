"""notalone-server 命令的进程级冒烟测试。

用子进程启动真实后端（测试库配置），验证握手文件写入、SIGTERM 优雅
关停与清理。只使用本地回环与合成 owner，不触碰生产数据。
"""

from __future__ import annotations

import os
import json
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from uuid import uuid4

import psycopg

TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class ServerCommandProcessTest(unittest.TestCase):
    """直接从终端可见的进程行为：握手信息、优雅关停与文件清理。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "命令冒烟用户"),
            )
        self._temp_dir = tempfile.TemporaryDirectory()
        self.info_path = Path(self._temp_dir.name) / "backend.info"
        env = dict(os.environ)
        env["NOTALONE_DATABASE_URL"] = TEST_DATABASE_URL
        env["NOTALONE_OWNER_ID"] = str(self.owner_id)
        env["NOTALONE_BACKEND_INFO"] = str(self.info_path)
        env["NOTALONE_DISABLE_DOTENV"] = "1"
        self.env = env

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
        self._temp_dir.cleanup()

    def _start_server(self) -> subprocess.Popen:
        return subprocess.Popen(
            [sys.executable, "-m", "notalone.server.command", "--port", "0"],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def test_writes_info_file_then_removes_on_sigterm(self) -> None:
        process = self._start_server()
        try:
            deadline = time.monotonic() + 15
            while not self.info_path.exists():
                if time.monotonic() > deadline:
                    self.fail("握手文件未在 15 秒内写入。")
                time.sleep(0.1)

            address = ""
            token = ""
            for line in self.info_path.read_text(encoding="utf-8").splitlines():
                if line.startswith("address="):
                    address = line.removeprefix("address=")
                elif line.startswith("token="):
                    token = line.removeprefix("token=")
            self.assertTrue(address, "握手文件缺少 address 行。")
            self.assertTrue(token, "握手文件缺少 token 行。")

            # 无 token 访问应被拒绝；带 token 的 contacts 返回当前 owner 范围。
            request = urllib.request.Request(
                f"http://{address}/api/contacts",
                headers={"Authorization": f"Bearer {token}"},
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertEqual(response.status, 200)

            process.send_signal(signal.SIGTERM)
            exit_code = process.wait(timeout=10)
            self.assertEqual(exit_code, 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
        self.assertFalse(
            self.info_path.exists(),
            "SIGTERM 后握手文件应被清理。",
        )

    def test_confirm_body_reaches_real_http_handler(self) -> None:
        """真实 HTTP 请求体必须被读取；绑定确认对无身份 owner 失败关闭。"""

        process = self._start_server()
        try:
            deadline = time.monotonic() + 15
            while not self.info_path.exists():
                if time.monotonic() > deadline:
                    self.fail("握手文件未在 15 秒内写入。")
                time.sleep(0.1)
            address = next(
                line.removeprefix("address=")
                for line in self.info_path.read_text(encoding="utf-8").splitlines()
                if line.startswith("address=")
            )
            token = next(
                line.removeprefix("token=")
                for line in self.info_path.read_text(encoding="utf-8").splitlines()
                if line.startswith("token=")
            )
            body = json.dumps(
                {"contact_id": str(uuid4()), "locator": "wxid_smoke"}
            ).encode("utf-8")
            request = urllib.request.Request(
                f"http://{address}/api/sync/confirm",
                data=body,
                method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
            # 冒烟 owner 没有微信渠道身份：确认被同步不可用拒绝（503），
            # 而不是"请求体无效"（400）——证明请求体真实到达 handler。
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=15)
            self.assertEqual(context.exception.code, 503)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
        self.assertFalse(self.info_path.exists())

    def test_sync_requires_token_and_unavailable_without_identity(self) -> None:
        process = self._start_server()
        try:
            deadline = time.monotonic() + 15
            while not self.info_path.exists():
                if time.monotonic() > deadline:
                    self.fail("握手文件未在 15 秒内写入。")
                time.sleep(0.1)
            address = next(
                line.removeprefix("address=")
                for line in self.info_path.read_text(encoding="utf-8").splitlines()
                if line.startswith("address=")
            )
            token = next(
                line.removeprefix("token=")
                for line in self.info_path.read_text(encoding="utf-8").splitlines()
                if line.startswith("token=")
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(f"http://{address}/api/sync/status", timeout=5)
            self.assertEqual(context.exception.code, 401)

            # 冒烟 owner 没有微信渠道身份：同步宿主不可用（失败关闭）。
            request = urllib.request.Request(
                f"http://{address}/api/sync/status",
                headers={"Authorization": f"Bearer {token}"},
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=15)
            self.assertEqual(context.exception.code, 503)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
        self.assertFalse(self.info_path.exists())


if __name__ == "__main__":
    unittest.main()