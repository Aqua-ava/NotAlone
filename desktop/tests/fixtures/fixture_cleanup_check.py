"""仅通过合成子进程、真实 HTTP/PG 检查两类夹具的清理失败。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import tempfile
import unittest
from urllib.request import Request, urlopen

import psycopg
from psycopg import sql


ROOT = Path(__file__).resolve().parents[3]
CHILD = r'''
import json, pathlib, runpy, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
namespace = runpy.run_path(sys.argv[1])
fixture_class = namespace[sys.argv[2]]
from fixture_cleanup import bind_prepared_database
fixture_class._prepared_database_name = bind_prepared_database()
mode = sys.argv[3]
instances = []
original_setup = fixture_class.setUp
original_drop = fixture_class._drop_database
def setup(self):
    original_setup(self)
    instances.append(self)
    if mode == "instance_failure":
        def close_then_fail():
            self.backend.close()
            raise RuntimeError("合成关闭故障。")
        self.addCleanup(close_then_fail)
def drop(cls):
    if mode == "drop_failure":
        raise RuntimeError("合成 DROP 故障。")
    original_drop()
    if mode == "class_failure":
        raise RuntimeError("合成类清理故障。")
fixture_class.setUp = setup
fixture_class._drop_database = classmethod(drop)
failed = False
try:
    namespace["main"]()
except BaseException:
    failed = True
finally:
    fixture = instances[0]
    print(json.dumps({"observed": {
        "admin_closed": fixture_class.admin.closed,
        "http_alive": fixture.backend.thread.is_alive() or fixture.other_backend.thread.is_alive(),
        "temporary_remaining": pathlib.Path(fixture.temporary.name).exists(),
    }}), flush=True)
if failed:
    raise SystemExit(1)
'''


class FixtureCleanupCheck(unittest.TestCase):
    def check_fixture(self, script: str, class_name: str, mode: str) -> None:
        database_name = None
        with tempfile.TemporaryDirectory(prefix="notalone-cleanup-check-") as directory:
            current = Path(directory)
            env = dict(os.environ, **{
                "NOTALONE_DISABLE_DOTENV": "1",
                "NOTALONE_ENV_FILE": str(current / "synthetic.env"),
                "NOTALONE_BACKEND_INFO": str(current / "backend.info"),
                "NOTALONE_DATABASE_URL": "", "NOTALONE_OWNER_ID": "",
                "NOTALONE_DEEPSEEK_API_KEY": "", "DEEPSEEK_API_KEY": "",
                "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false",
                "NOTALONE_DEEPSEEK_BASE_URL": "http://127.0.0.1:1",
                "NOTALONE_WECHAT_CLI": str(current / "unavailable-cli"),
                "NOTALONE_SYNC_PROBE": str(current / "unavailable-probe"),
                "PYTHONPATH": f"{ROOT / 'backend/src'}:{ROOT / 'backend'}",
                "PYTHONNOUSERSITE": "1",
            })
            child = subprocess.Popen(
                [sys.executable, "-c", CHILD, str(Path(__file__).parent / script),
                 class_name, mode], cwd=ROOT, env=env, text=True,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            try:
                self.assertTrue(select.select([child.stdout], [], [], 20)[0])
                ready = json.loads(child.stdout.readline())["ready"]
                candidate = ready["database_url"].split("dbname=", 1)[1]
                self.assertRegex(candidate, r"^notalone_core_flow_[0-9a-f]{32}_test$")
                database_name = candidate
                info = (current / "backend.info").read_text(encoding="utf-8")
                address = re.search(r"^address=(127\.0\.0\.1:\d+)$", info, re.M)[1]
                token = re.search(r"^token=([^\n]+)$", info, re.M)[1]
                with urlopen(Request(f"http://{address}/api/contacts", headers={
                    "Authorization": f"Bearer {token}",
                }), timeout=5) as response:
                    self.assertEqual(response.status, 200)
                child.stdin.write(json.dumps({"id": 1, "operation": "stop"}) + "\n")
                child.stdin.flush()
                output, _ = child.communicate(timeout=20)
                frames = [json.loads(line) for line in output.splitlines()]
                observed = next(frame["observed"] for frame in frames if "observed" in frame)
                self.assertEqual(observed, {"admin_closed": True, "http_alive": False,
                                            "temporary_remaining": False})
                self.assertEqual(child.returncode, 0 if mode == "normal" else 1)
                report = next((frame["cleanup"] for frame in frames if "cleanup" in frame), None)
                if mode != "normal":
                    self.assertIsNotNone(report)
                if report is not None:
                    self.assertEqual(report["instance_ok"], mode != "instance_failure")
                    self.assertEqual(report["class_ok"], mode not in ("class_failure", "drop_failure"))
                with psycopg.connect("host=/tmp dbname=postgres") as admin:
                    remaining = admin.execute(
                        "SELECT count(*) FROM pg_database WHERE datname = %s",
                        (database_name,),
                    ).fetchone()[0]
                if report is not None:
                    self.assertEqual(report["database_remaining"], remaining != 0)
                self.assertEqual(remaining, 1 if mode == "drop_failure" else 0)
                print(json.dumps({"fixture": class_name, "fault": mode,
                                  "exit": child.returncode,
                                  "database_remaining_before_check_cleanup": remaining}), flush=True)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate(timeout=10)
                if database_name is not None:
                    with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
                        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                            sql.Identifier(database_name),
                        ))
                        self.assertEqual(admin.execute(
                            "SELECT count(*) FROM pg_database WHERE datname = %s",
                            (database_name,),
                        ).fetchone()[0], 0)
                    print(json.dumps({"fixture": class_name, "fault": mode,
                                      "database_remaining_after_check_cleanup": 0}), flush=True)

    def test_import_cleanup(self) -> None:
        for mode in ("normal", "instance_failure", "class_failure", "drop_failure"):
            with self.subTest(mode=mode):
                self.check_fixture("import_backend.py", "DesktopImportFixture", mode)

    def test_rewrite_cleanup(self) -> None:
        for mode in ("normal", "instance_failure", "class_failure", "drop_failure"):
            with self.subTest(mode=mode):
                self.check_fixture("rewrite-backend.py", "DesktopRewriteFixture", mode)


if __name__ == "__main__":
    unittest.main(verbosity=2)
