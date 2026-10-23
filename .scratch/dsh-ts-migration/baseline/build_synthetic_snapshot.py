"""用正式迁移和既有合成 HTTP 夹具生成可恢复的旧后端数据基线。"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
BASELINE_COMMIT = "3c168296e9e8edaa43b8b323ff693e790e709069"
os.environ["NOTALONE_DISABLE_DOTENV"] = "1"
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend/src"))

import psycopg
from psycopg import sql
from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
from tests.integration.persistence.skill_fixture import insert_file_skill
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture


def fingerprint(database_url: str) -> dict:
    """只接收本轮夹具地址，按完整行值比较恢复前后身份和状态。"""
    result = {}
    with psycopg.connect(database_url) as connection:
        tables = connection.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        ).fetchall()
        for (table,) in tables:
            rows = connection.execute(sql.SQL("SELECT row_to_json(t) FROM public.{} t").format(
                sql.Identifier(table))).fetchall()
            encoded = sorted(json.dumps(row[0], ensure_ascii=False, sort_keys=True) for row in rows)
            result[table] = {"rows": len(rows), "sha256": hashlib.sha256(
                "\n".join(encoded).encode()).hexdigest()}
    return result


class SyntheticSnapshot(CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = RELEASE_ALL_DIMENSIONS
    output: Path

    def test_snapshot(self) -> None:
        identities = []
        for backend, label, tea in ((self.backend, "A", "茉莉茶"),
                                    (self.backend, "B", "乌龙茶"),
                                    (self.other_backend, "另一用户", "大红袍")):
            imported = self._import(backend, label, tea)
            self._run_import(backend, imported)
            body, reply = self._reply(backend, imported)
            self.assertEqual(backend.request("/api/reply/generate", body), (200, reply))
            contact = imported["contact_id"]
            status, session = backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
            self.assertEqual(status, 200, session)
            path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
            status, discussion = backend.request(path + "/inputs", {
                "content": {"type": "purpose_exploration", "purpose_hint": "合成讨论：自然回应并保留明确含义。"}})
            self.assertEqual(status, 200, discussion)
            if backend is self.backend:
                self.assertEqual(self.other_backend.request(path)[0], 404)
            skill_id, version_id = uuid4(), uuid4()
            with psycopg.connect(self.database_url) as connection:
                insert_file_skill(connection, owner_id=backend.owner_id,
                                  skill_id=skill_id, version_id=version_id,
                                  name="synthetic-reply-" + contact[:8], contact_id=contact,
                                  content="使用温和而明确的文字；保留用户的原意。")
            identities.append({"owner_id": str(backend.owner_id), "contact_id": contact,
                               "source_id": imported["source"]["source_id"],
                               "memory_id": imported["memory"]["memory_id"],
                               "task_id": imported["task_id"], "reply_request_id": reply["reply_request_id"],
                               "session_id": session["session_id"],
                               "input_version_id": discussion["input_version_id"],
                               "skill_id": str(skill_id), "skill_version_id": str(version_id)})
        # 授权状态是存储兼容夹具，不冒充真实用户授权或开启同步。
        with psycopg.connect(self.database_url) as connection:
            for decision, owner_id in (("accepted", self.owner_id), ("declined", self.other_owner_id)):
                connection.execute(
                    "INSERT INTO public.wechat_history_sync_authorization "
                    "(owner_id,channel,account_scope,version,decision,decided_at) "
                    "VALUES (%s,'wechat','synthetic-baseline-account',1,%s,now())", (owner_id, decision))
                connection.execute(
                    "INSERT INTO public.wechat_sync_scope(owner_id,channel,account_scope,mode) "
                    "VALUES (%s,'wechat','synthetic-baseline-account','selected')", (owner_id,))
        before = fingerprint(self.database_url)
        for table in ("owner", "contact", "source_document", "message", "memory_candidate",
                      "confirmed_memory", "reply_skill", "reply_skill_version", "assistant_session",
                      "assistant_session_input", "conversation_binding", "wechat_history_sync_authorization"):
            self.assertGreater(before[table]["rows"], 0, table)
        dump = self.output / "old-backend.dump"
        binaries = Path(sys.executable).parent
        subprocess.run([str(binaries / "pg_dump"), "--format=custom", "--no-owner", "--no-privileges",
                        "--file", str(dump), self.database_url], check=True, timeout=60, capture_output=True)
        skill_root = Path(os.environ["NOTALONE_SKILLS_DIR"])
        shutil.copytree(skill_root, self.output / "skills")
        restored = "notalone_baseline_restore_" + uuid4().hex
        type(self).restored_database_name = restored
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(restored)))
        try:
            restored_url = "host=/tmp dbname=" + restored
            subprocess.run([str(binaries / "pg_restore"), "--exit-on-error", "--no-owner", "--no-privileges",
                            "--dbname", restored_url, str(dump)], check=True, timeout=60, capture_output=True)
            self.assertEqual(fingerprint(restored_url), before)
        finally:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(restored)))
        manifest = {"format": 1, "synthetic_only": True, "baseline_commit": BASELINE_COMMIT,
                    "restored_all_public_rows_equal": True, "identities": identities, "tables": before,
                    "dump_sha256": hashlib.sha256(dump.read_bytes()).hexdigest(),
                    "original_skill_root": str(skill_root),
                    "skill_files": {str(p.relative_to(skill_root)): hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in sorted(skill_root.rglob("*")) if p.is_file()}}
        (self.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("用法：python build_synthetic_snapshot.py <不存在的输出目录>")
    subprocess.run(["git", "diff", "--quiet", BASELINE_COMMIT, "--", "backend"],
                   cwd=ROOT, check=True, timeout=15)
    output = Path(sys.argv[1]).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    SyntheticSnapshot.output = output
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SyntheticSnapshot)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    with psycopg.connect("host=/tmp dbname=postgres") as connection:
        remaining = connection.execute("SELECT datname FROM pg_database WHERE datname = ANY(%s)",
                                       ([SyntheticSnapshot.database_name,
                                         SyntheticSnapshot.restored_database_name],)).fetchall()
        if remaining:
            raise SystemExit("本轮合成数据库未清理完成。")
    (output / "cleanup.json").write_text(json.dumps({"owned_databases_remaining": 0}) + "\n")
    print("合成快照生成并恢复比对通过；临时数据库已按夹具生命周期删除。")
