"""联系人概览的合成验收：真实初始化、导入、HTTP 与自有隔离库。"""

from __future__ import annotations

import hashlib
import json
import os
from copy import deepcopy
from pathlib import Path
import sys
from traceback import format_exc
import unittest
from uuid import UUID, uuid4


ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
    if (os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone"
            or not os.environ.get("CONDA_PREFIX") or Path.cwd() != ROOT / "backend"):
        raise RuntimeError("概览夹具须从本工作树backend在Conda NotAlone中运行。")
    if os.environ.get("PYTHONPATH", "").split(os.pathsep)[0] != str(ROOT / "backend/src"):
        raise RuntimeError("概览夹具须显式使用本工作树生产模块。")
    os.environ.update({"NOTALONE_DISABLE_DOTENV": "1", "PYTHON_DOTENV_DISABLED": "1",
                       "LANGCHAIN_TRACING_V2": "false", "LANGCHAIN_TRACING": "false",
                       "LANGSMITH_TRACING": "false"})
    database_name = f"notalone_core_flow_{uuid4().hex}_test"
    database_url = f"host=/tmp dbname={database_name}"
    os.environ.update({"NOTALONE_TEST_DATABASE_URL": database_url,
                       "NOTALONE_DATABASE_URL": database_url, "NOTALONE_EXPECTED_TEST_DATABASE": database_name})
    directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent
    evidence_directory = Path(os.environ["NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR"])
    if (not evidence_directory.is_absolute() or not evidence_directory.is_dir()
            or evidence_directory.stat().st_mode & 0o777 != 0o700
            or evidence_directory.is_relative_to(ROOT)):
        raise RuntimeError("概览证据必须保存到仓库外的700目录。")
    evidence_path = evidence_directory / f"overview-runtime-{uuid4().hex}.json"
    expected = json.loads(os.environ["NOTALONE_OVERVIEW_TEST_EXPECTED_MODULES"])
    if not isinstance(expected, dict) or len(expected) != 8:
        raise RuntimeError("概览夹具缺少调用方的固定模块摘要。")
    descriptor = os.open(directory / "database-ownership.json",
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as record:
        json.dump({"database_name": database_name, "child_pid": os.getpid(), "phase": "planned"}, record)
        record.flush()
        os.fsync(record.fileno())
    sys.path.insert(0, str(ROOT / "backend/src"))
    sys.path.insert(1, str(ROOT / "backend"))

    # 双连接URL与来源路径在任何产品、测试装配导入之前固定。
    import psycopg
    from psycopg import sql

    created = False
    fixture = None
    proof = {"database_name": database_name, "child_pid": os.getpid(), "phase": "planned"}

    def save_proof() -> None:
        descriptor = os.open(evidence_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(proof, output, ensure_ascii=False, indent=2)

    def drop_owned() -> None:
        nonlocal created
        if not created:
            return
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database_name)))
            remaining = admin.execute("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)",
                                      (database_name,)).fetchone()[0]
            if remaining:
                raise RuntimeError("本轮概览测试库仍有残留。")
        created = False
        proof["database_remaining"] = False

    def guard_modules() -> dict:
        observed = []
        for name, module in tuple(sys.modules.items()):
            if name != "notalone" and not name.startswith(("notalone.", "tests.")):
                continue
            source = getattr(module, "__file__", None)
            if source is None:
                continue
            actual_path = Path(source).resolve()
            if not actual_path.is_relative_to(ROOT / "backend"):
                raise RuntimeError(f"概览验收模块加载到其它目录：{name}")
            observed.append({"module": name, "path": str(actual_path),
                             "sha256": hashlib.sha256(actual_path.read_bytes()).hexdigest()})
        by_name = {entry["module"]: entry for entry in observed}
        for name, fixed in expected.items():
            actual = by_name.get(name)
            if (not isinstance(fixed, dict) or actual is None
                    or actual["path"] != str((ROOT / fixed["path"]).resolve())
                    or actual["sha256"] != fixed["sha256"]):
                raise RuntimeError(f"概览验收实际模块摘要不符：{name}")
        proof.update({"phase": "running", "loaded_modules": observed,
                      "critical_modules": {name: by_name[name] for name in expected},
                      "environment": {"conda": os.environ["CONDA_DEFAULT_ENV"],
                                      "cwd": str(Path.cwd()), "pythonpath": os.environ["PYTHONPATH"],
                                      "dual_url_equal": os.environ["NOTALONE_TEST_DATABASE_URL"] == os.environ["NOTALONE_DATABASE_URL"],
                                      "dotenv_disabled": True, "tracing_disabled": True}})
        save_proof()
        return {"loaded_module_count": len(observed), "critical_module_count": len(expected),
                "environment_verified": True, "evidence_file": evidence_path.name,
                "child_pid": os.getpid(), "database_name": database_name,
                "model_calls": len(fixture.extraction_model.seen_calls) if fixture is not None else 0}

    try:
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database_name)))
            created = True
        with psycopg.connect(database_url) as connection:
            if connection.execute("SELECT current_database()").fetchone()[0] != database_name:
                raise RuntimeError("概览夹具数据库身份与本轮随机名称不一致。")
        from notalone.database_migrations import migrate
        from notalone.server.connection_info import write_backend_info
        from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
        from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture

        class DesktopOverviewFixture(MemoryOverviewHttpFixture, unittest.TestCase):
            _wait_finished = CoreBusinessFlowFixture._wait_finished

        applied = migrate(database_url, ROOT / "backend/database/migrations")
        official = sorted(path.name for path in (ROOT / "backend/database/migrations").glob("[0-9][0-9][0-9]_*.sql"))
        if (len(applied) != len(official) or list(applied) != official
                or [int(name[:3]) for name in official] != list(range(1, len(official) + 1))
                or "089_style_sample_generation_dependencies.sql" not in official):
            raise RuntimeError("概览夹具须使用正式连续001–当前迁移，包含089。")
        if migrate(database_url, ROOT / "backend/database/migrations"):
            raise RuntimeError("概览迁移重复执行不应新增迁移。")
        proof["migrations"] = official
        DesktopOverviewFixture.database_name = database_name
        DesktopOverviewFixture.setUpClass()
        fixture = DesktopOverviewFixture(methodName="runTest")
        fixture.setUp()
        fixture.activate_historical_review_worker()
        guard_modules()
        first = fixture.import_event(
            original="合成计划：明天参加读书会。",
            claim="计划参加读书会。", when="2026-08-04T10:00:00+08:00",
            fact_overrides={"speech_act": "plan"},
            event_spec={"stage": "planned", "occurrence_start": "2026-08-05T00:00:00+08:00",
                        "occurrence_end": "2026-08-06T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        contact_id, source_id = first["contact_id"], first["source"]["source_id"]
        prefix = f"/api/contacts/{contact_id}"
        pending = fixture._get(fixture.backend, prefix + "/memory-candidates")["candidates"]
        fixture.assertEqual(fixture.overview(contact_id)["entries"], [])
        status, result = fixture.backend.request(prefix + f"/memory-candidates/{pending[0]['candidate_id']}/confirm", {})
        fixture.assertEqual(status, 200, result)
        old = result["memory"]
        second = fixture.import_event(
            original="合成经历：今天已参加读书会。",
            claim="已参加读书会。", when="2026-08-05T12:00:00+08:00", contact_id=contact_id,
            action="update", replaced_id=old["memory_id"],
            event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T00:00:00+08:00",
                        "occurrence_end": "2026-08-06T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        pending = fixture._get(fixture.backend, prefix + "/memory-candidates")["candidates"]
        fixture.assertEqual([entry["memory"]["memory_id"] for entry in fixture.overview(contact_id)["entries"]], [old["memory_id"]])
        status, result = fixture.backend.request(prefix + f"/memory-candidates/{pending[0]['candidate_id']}/apply-update", {
            "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
            "correction_decision_ids": [item["decision_id"] for item in pending[0].get("correction_review", [])],
        })
        fixture.assertEqual(status, 200, result)
        current = result["memory"]
        status, result = fixture.backend.request("/api/memories/manual-contact", {
            "contact_id": contact_id, "text": "我们一起经历过合成活动。", "category": "common_fact",
        })
        fixture.assertEqual(status, 200, result)
        manual = result["memory"]
        # 另一联系人仅通过无Worker的真实HTTP导入，避免本票安排外的模型任务。
        worker_backend = fixture.backend
        fixture.backend = fixture._backend(fixture.owner_id)

        def import_independent_contact(text: str) -> tuple[str, str, UUID]:
            # 沿已成功导入的本人身份准备新会话，不另造本人wxid绕过身份冲突门。
            locator = f"wxid_overview_contact_{uuid4().hex}"
            records = deepcopy(first["records"])
            for row in records:
                row["id"].update({"server_id_str": uuid4().hex, "talker": locator})
                if not row["is_from_me"]:
                    row.update({"sender": "合成概览联系人", "sender_wxid": locator, "text": text})
            source_path = Path(fixture.temporary.name) / f"independent-{uuid4().hex}.jsonl"
            source_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records), encoding="utf-8")
            status, preview = fixture.backend.request("/api/imports/preview", {"path": str(source_path)})
            fixture.assertEqual(status, 200, preview)
            fixture.assertTrue(preview["valid"])
            status, imported = fixture.backend.request("/api/imports/commit", {
                "path": str(source_path), "expected_content_sha256": preview["content_sha256"],
                "new_contact_name": "合成概览联系人",
            })
            fixture.assertEqual(status, 200, imported)
            fixture.assertEqual(imported["imported_count"], 2)
            contact = imported["contact_id"]
            message = next(item for item in fixture._get(fixture.backend, f"/api/contacts/{contact}/messages")["messages"]
                           if item["text"] == text)
            source = next(item for item in fixture._get(fixture.backend, f"/api/contacts/{contact}/sources")["sources"]
                          if item["file_name"] == source_path.name)
            fixture.assertEqual(source["status"], "active")
            return contact, source["source_id"], UUID(message["message_id"])

        other_contact, other_source, other_message = import_independent_contact("另一位联系人的合成独立经历。")
        other = fixture.confirm(other_contact, "另一位联系人的合成独立经历。", other_message)
        empty_contact, _, _ = import_independent_contact("仅有来源，尚未保存记忆的合成联系人。")
        fixture.backend = worker_backend
        actual = fixture.overview(contact_id)
        fixture.assertEqual(len(actual["entries"]), 3)
        prepared = {"contactId": contact_id, "otherContactId": other_contact,
                    "sourceToDelete": source_id, "otherSourceId": other_source,
                    "newSourceId": second["source"]["source_id"],
                    "old": old, "current": current, "manual": manual, "other": other,
                    "overview": actual}
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        runtime_proof = guard_modules()
        print(json.dumps({"ready": {"database_url": database_url, "owner_id": str(fixture.owner_id),
                                    "contact_ids": [contact_id, other_contact],
                                    "other_contact_id": other_contact, "empty_contact_id": empty_contact,
                                    "migration_count": len(applied), "migration_repeat": 0,
                                    "runtime_proof": runtime_proof}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            if operation == "overview_prepared":
                result = prepared
            elif operation == "delete_source":
                result = fixture.delete_source(contact_id, source_id)
            elif operation == "remove_contact_fixture":
                # 工程夹具验证真实FK删除；产品并无公开联系人DELETE能力。
                with psycopg.connect(database_url) as connection:
                    connection.execute("DELETE FROM public.contact WHERE owner_id=%s AND id=%s",
                                       (fixture.owner_id, contact_id))
                status, result = fixture.backend.request(f"/api/contacts/{contact_id}/relationship-overview")
                fixture.assertEqual(status, 404, result)
                result = {"http_status": status, "fixture_contact_removed": True}
            elif operation == "runtime_proof":
                result = guard_modules()
            else:
                raise ValueError("概览合成夹具操作无效。")
            guard_modules()
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    except BaseException as error:
        proof["failure"] = {"type": type(error).__name__, "message": str(error), "traceback": format_exc()}
        raise
    finally:
        instance_ok = fixture.doCleanups() if fixture is not None else True
        drop_owned()
        proof.update({"phase": "cleaned", "instance_cleanup_ok": instance_ok, "cleanup_confirmed": instance_ok and not created})
        save_proof()
        if not instance_ok or created:
            raise RuntimeError("概览夹具HTTP或自有测试库清理未确认。")
        print(json.dumps({"cleanup": {"instance_ok": instance_ok, "class_ok": True,
                                      "database_remaining": False}, "cleanupConfirmed": True}), flush=True)


if __name__ == "__main__":
    main()
