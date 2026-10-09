"""资料编辑的真实 HTTP/PG 回归；只迁移本轮随机库，不启动桌面。"""

from __future__ import annotations

import importlib.util
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[3]


class NoRedirect(HTTPRedirectHandler):
    """本轮认证请求不可被重定向到另一个目标。"""

    def redirect_request(self, request, response, code, message, headers, url):
        return None


class MemoryEditingHttpCheck(unittest.TestCase):
    """仅从认证 HTTP 的操作与读取结果核验资料变化。"""

    def setUp(self) -> None:
        if os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone":
            raise RuntimeError("资料编辑回归须激活 Conda NotAlone。")
        self.directory = Path(tempfile.mkdtemp(prefix="notalone-memory-editing-http-"))
        self.info = self.directory / "backend.info"
        self.original_environment = dict(os.environ)
        self.data = None
        self.child = None
        self.database_fixture = None
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.addCleanup(self.cleanup_owned_resources)
        for key in list(os.environ):
            if key.startswith(("NOTALONE_", "DEEPSEEK_", "LANGSMITH_", "LANGCHAIN_", "OTEL_")):
                del os.environ[key]
        os.environ.update({
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_ENV_FILE": str(self.directory / "synthetic.env"),
            "NOTALONE_BACKEND_INFO": str(self.info),
            "NOTALONE_DEEPSEEK_API_KEY": "", "DEEPSEEK_API_KEY": "",
            "NOTALONE_DEEPSEEK_BASE_URL": "http://127.0.0.1:1",
            "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false",
            "LANGCHAIN_TRACING": "false",
            "NOTALONE_WECHAT_CLI": str(self.directory / "unavailable-cli"),
            "NOTALONE_SYNC_PROBE": str(self.directory / "unavailable-probe"),
            "PYTHONNOUSERSITE": "1", "PYTHONPATH": str(ROOT / "backend/src"),
        })
        from notalone.application.memory_service import MemoryService

        if not Path(inspect.getfile(MemoryService)).resolve().is_relative_to(ROOT / "backend/src"):
            raise RuntimeError("资料编辑回归必须加载当前工作树的后端模块。")
        spec = importlib.util.spec_from_file_location(
            "memory_editing_database", Path(__file__).with_name("memory-database.py"),
        )
        assert spec is not None and spec.loader is not None
        database_fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(database_fixture)
        self.database_fixture = database_fixture
        self.data = database_fixture.create_database()
        os.environ.update({
            "NOTALONE_DATABASE_URL": self.data["database_url"],
            "NOTALONE_OWNER_ID": self.data["owner_id"],
        })
        self.child = subprocess.Popen(
            [sys.executable, "-m", "notalone.server.command"], cwd=ROOT, env=dict(os.environ),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 20
        while True:
            if self.child.poll() is not None:
                raise RuntimeError("本轮资料编辑后端未启动。")
            try:
                status, state = self.request("/api/runtime/status")
                if status == 200 and state.get("state") == "running":
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("本轮资料编辑后端启动超时。")
            time.sleep(0.05)

    def request(self, path: str, body: dict[str, object] | None = None) -> tuple[int, dict]:
        lines = self.info.read_text().splitlines()
        fields = dict(line.split("=", 1) for line in lines)
        address = fields.get("address", "")
        if (len(lines) != 3 or set(fields) != {"address", "token", "pid"}
                or not re.fullmatch(r"127\.0\.0\.1:[1-9][0-9]{0,4}", address)
                or int(address.rsplit(":", 1)[1]) > 65535
                or not re.fullmatch(r"[A-Za-z0-9_-]+", fields["token"])
                or self.child is None or fields["pid"] != str(self.child.pid)
                or not path.startswith("/api/") or any(character in path for character in "\r\n")):
            raise ValueError("本轮资料编辑握手或请求目标无效。")
        request = Request(
            "http://" + address + path,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers={"Authorization": "Bearer " + fields["token"], "Content-Type": "application/json"},
        )
        try:
            response = self.opener.open(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def get(self, path: str) -> dict:
        status, payload = self.request(path)
        self.assertEqual(status, 200, payload)
        return payload

    def cleanup_owned_resources(self) -> None:
        """确认认证停读、子进程与精确库收尾；不确定时保留诊断目录。"""
        shutdown_confirmed = False
        database_remaining = None
        failure = None
        try:
            if self.child is not None and self.child.poll() is None:
                try:
                    status, state = self.request("/api/runtime/shutdown", {})
                    shutdown_confirmed = status == 200 and state.get("state") == "stopped"
                    if not shutdown_confirmed:
                        raise RuntimeError("本轮资料编辑后端停读未确认。")
                    self.child.wait(timeout=10)
                except Exception as error:
                    failure = error
                finally:
                    if self.child.poll() is None:
                        self.child.terminate()
                        try:
                            self.child.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            self.child.kill()
                            self.child.wait(timeout=5)
            exited = self.child is None or self.child.poll() is not None
            if self.data is not None and exited:
                self.database_fixture.contact_database.drop_database(self.data["database_name"])
                import psycopg

                with psycopg.connect("host=/tmp dbname=postgres", connect_timeout=3) as admin:
                    database_remaining = admin.execute(
                        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)",
                        (self.data["database_name"],),
                    ).fetchone()[0]
            confirmed = ((self.child is None or shutdown_confirmed and self.child.poll() == 0)
                         and (self.data is None or database_remaining is False))
            if confirmed:
                shutil.rmtree(self.directory)
            print(json.dumps({"memory_editing_cleanup": {
                "authenticated_stopped": shutdown_confirmed,
                "backend_exit_code": self.child.poll() if self.child else None,
                "owned_database_remaining": database_remaining,
                "cleanup_confirmed": confirmed,
                **({"retained_directory": str(self.directory)} if not confirmed else {}),
            }}), flush=True)
            if not confirmed or failure is not None:
                raise RuntimeError("本轮资料编辑资源收尾未完全确认。") from failure
        finally:
            os.environ.clear()
            os.environ.update(self.original_environment)

    def test_owner_correction_creates_manual_version_and_retires_previous_version(self) -> None:
        before = self.get("/api/memories/owner")["memories"]
        previous = next(item for item in before if item["source_candidate_id"] == self.data["owner_candidate_id"])
        status, result = self.request(f"/api/memories/owner/{previous['memory_id']}/correct", {
            "text": "本人改为喜欢合成白茶。", "category": "preference",
        })
        self.assertEqual(status, 200, result)
        corrected = result["memory"]
        self.assertNotEqual(corrected["memory_id"], previous["memory_id"])
        self.assertEqual(corrected["supersedes_memory_id"], previous["memory_id"])
        self.assertEqual((corrected["level"], corrected["adoption_method"], corrected["status"], corrected["revision"]),
                         ("owner", "manual", "active", 2))
        self.assertEqual((corrected["text"], corrected["category"]), ("本人改为喜欢合成白茶。", "preference"))
        self.assertEqual(corrected["source_ids"], previous["source_ids"])
        for field in ("source_started_at", "source_ended_at", "source_time_complete"):
            self.assertEqual(corrected["timing"][field], previous["timing"][field])
        self.assertGreater(datetime.fromisoformat(corrected["timing"]["recorded_at"]),
                           datetime.fromisoformat(previous["timing"]["recorded_at"]))
        after = self.get("/api/memories/owner")["memories"]
        self.assertEqual({item["memory_id"] for item in after},
                         {item["memory_id"] for item in before if item != previous} | {corrected["memory_id"]})
        self.assertEqual(next(item for item in after if item["memory_id"] == corrected["memory_id"]), corrected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
