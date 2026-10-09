"""资料编辑的真实 HTTP/PG 回归；只迁移本轮随机库，不启动桌面。"""

from __future__ import annotations

import importlib.util
import inspect
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[3]


class MemoryEditingHttpCheck(unittest.TestCase):
    """仅从认证 HTTP 的操作与读取结果核验资料变化。"""

    def setUp(self) -> None:
        if os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone":
            raise RuntimeError("资料编辑回归须激活 Conda NotAlone。")
        self.temporary = tempfile.TemporaryDirectory(prefix="notalone-memory-editing-http-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.info = self.directory / "backend.info"
        self.original_environment = dict(os.environ)
        self.addCleanup(self.restore_environment)
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
        self.data = database_fixture.create_database()
        self.addCleanup(database_fixture.contact_database.drop_database, self.data["database_name"])
        os.environ.update({
            "NOTALONE_DATABASE_URL": self.data["database_url"],
            "NOTALONE_OWNER_ID": self.data["owner_id"],
        })
        self.child = subprocess.Popen(
            [sys.executable, "-m", "notalone.server.command"], cwd=ROOT, env=dict(os.environ),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self.stop_owned_backend)
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

    def restore_environment(self) -> None:
        os.environ.clear()
        os.environ.update(self.original_environment)

    def request(self, path: str, body: dict[str, object] | None = None) -> tuple[int, dict]:
        fields = dict(line.split("=", 1) for line in self.info.read_text().strip().splitlines())
        request = Request(
            "http://" + fields["address"] + path,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers={"Authorization": "Bearer " + fields["token"], "Content-Type": "application/json"},
        )
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def get(self, path: str) -> dict:
        status, payload = self.request(path)
        self.assertEqual(status, 200, payload)
        return payload

    def stop_owned_backend(self) -> None:
        """认证停读优先；失败只回收本方法仍持有的自有子进程。"""
        if self.child.poll() is not None:
            return
        try:
            status, state = self.request("/api/runtime/shutdown", {})
            if status != 200 or state.get("state") != "stopped":
                raise RuntimeError("本轮资料编辑后端停读未确认。")
            self.child.wait(timeout=10)
        finally:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=5)

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
