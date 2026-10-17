"""本人概览的合成验收：真实初始化、导入、HTTP 与自有隔离库。"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
from traceback import format_exc
from unittest.mock import patch
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
    evidence_directory = Path(os.environ["NOTALONE_OWNER_OVERVIEW_TEST_EVIDENCE_DIR"])
    if (not evidence_directory.is_absolute() or not evidence_directory.is_dir()
            or evidence_directory.stat().st_mode & 0o777 != 0o700
            or evidence_directory.is_relative_to(ROOT)):
        raise RuntimeError("概览证据必须保存到仓库外的700目录。")
    evidence_path = evidence_directory / f"owner-overview-runtime-{uuid4().hex}.json"
    expected = json.loads(os.environ["NOTALONE_OWNER_OVERVIEW_TEST_EXPECTED_MODULES"])
    if not isinstance(expected, dict) or len(expected) != 9:
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
    model_attempts = []
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
                      "model_attempt_count": len(model_attempts),
                      "environment": {"conda": os.environ["CONDA_DEFAULT_ENV"],
                                      "cwd": str(Path.cwd()), "pythonpath": os.environ["PYTHONPATH"],
                                      "dual_url_equal": os.environ["NOTALONE_TEST_DATABASE_URL"] == os.environ["NOTALONE_DATABASE_URL"],
                                      "dotenv_disabled": True, "tracing_disabled": True}})
        save_proof()
        return {"loaded_module_count": len(observed), "critical_module_count": len(expected),
                "environment_verified": True, "evidence_file": evidence_path.name,
                "child_pid": os.getpid(), "database_name": database_name,
                "model_calls": len(model_attempts)}

    try:
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database_name)))
            created = True
        with psycopg.connect(database_url) as connection:
            if connection.execute("SELECT current_database()").fetchone()[0] != database_name:
                raise RuntimeError("本人概览夹具数据库身份不一致。")
        from notalone.database_migrations import migrate
        from notalone.server.connection_info import write_backend_info
        from tests.integration.server.test_owner_memory_overview import OwnerMemoryOverviewHttpTest
        from notalone.memory.models import FactSubject
        from notalone.application.model_priority import ModelPriorityControl

        applied = migrate(database_url, ROOT / "backend/database/migrations")
        official = sorted(path.name for path in (ROOT / "backend/database/migrations").glob("[0-9][0-9][0-9]_*.sql"))
        if (len(applied) != 65 or list(applied) != official
                or [int(name[:3]) for name in official] != list(range(1, 66))
                or official[-1] != "065_memory_upgrade_batches.sql"):
            raise RuntimeError("本人概览夹具须使用正式连续001–当前迁移，包含065。")
        if migrate(database_url, ROOT / "backend/database/migrations"):
            raise RuntimeError("本人概览迁移重复执行不应新增迁移。")
        proof["migrations"] = official
        OwnerMemoryOverviewHttpTest.database_name = database_name
        OwnerMemoryOverviewHttpTest.setUpClass()
        fixture = OwnerMemoryOverviewHttpTest(methodName="runTest")
        fixture.setUp()
        # 桌面复用服务必须提供真实运行时资源的停读回调，不能用HTTP关闭代替公开停读确认。
        priority = ModelPriorityControl()
        fixture.backend = fixture._backend(fixture.owner_id, runtime_shutdown=priority.stop)
        def reject_model(*args, **kwargs):
            model_attempts.append(True)
            raise RuntimeError("本人概览验收不允许调用外部模型。")
        model_guard = patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                            side_effect=reject_model)
        model_guard.start()
        fixture.addCleanup(model_guard.stop)
        guard_modules()
        manual_fact = fixture.add_owner("本人稳定事实：已完成合成学业。")
        manual_preference = fixture.add_owner("本人明确偏好合成温茶。", category="preference")
        excluded = fixture.add_owner("本人近期忙于合成项目。", category="recent_state")
        fixture.add_owner("一次性合成关系备注。", category="relationship_note")
        contact, source, message = fixture.import_self("本人明确喜欢合成热茶。")
        # 未采纳候选是受控提取边界；人工confirm才沿公开用例产生本人事实，不证明提取语义质量。
        self_memory = fixture.confirm(contact, "本人明确喜欢合成热茶。", message,
                                      subject=FactSubject.SELF, category="preference")
        private_text = "合成联系人私密资料：对方最近在安排合成行程。"
        private_message = next(item for item in fixture._get(fixture.backend, f"/api/contacts/{contact}/messages")["messages"]
                               if item["text"] == private_text)
        private_memory = fixture.confirm(contact, "对方最近在安排合成行程。", UUID(private_message["message_id"]))
        other_contact, other_source, other_message = fixture.import_self("本人稳定事实：曾学合成绘画。")
        other_self = fixture.confirm(other_contact, "本人稳定事实：曾学合成绘画。", other_message, subject=FactSubject.SELF)
        actual = fixture.owner_overview()
        fixture.assertEqual(len(actual["entries"]), 4)
        for item in actual["entries"]:
            fixture.assertEqual(item["memory"]["level"], "owner")
            for reference in item["provenance"]["references"]:
                fixture.assertIsNone(reference["locator"])
        fixture.assertNotIn(private_memory["memory_id"], str(actual))
        fixture.assertNotIn(excluded["memory_id"], str(actual))
        prepared = {"contactId": contact, "otherContactId": other_contact, "sourceToDelete": source,
                    "otherSourceId": other_source, "self": self_memory, "otherSelf": other_self,
                    "manualFact": manual_fact, "manualPreference": manual_preference,
                    "privateContactText": private_memory["text"], "excludedText": excluded["text"], "overview": actual}
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        runtime_proof = guard_modules()
        print(json.dumps({"ready": {"database_url": database_url, "owner_id": str(fixture.owner_id),
                                    "contact_ids": [contact, other_contact], "other_contact_id": other_contact,
                                    "empty_contact_id": other_contact, "migration_count": len(applied), "migration_repeat": 0,
                                    "runtime_proof": runtime_proof}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            if operation == "owner_overview_prepared":
                result = prepared
            elif operation == "remove_contact_fixture":
                # 产品尚无联系人DELETE；本工程夹具仅验证真实FK与目录缓存边界。
                with psycopg.connect(database_url) as connection:
                    connection.execute("DELETE FROM public.contact WHERE owner_id=%s AND id=%s", (fixture.owner_id, contact))
                status, result = fixture.backend.request(f"/api/contacts/{contact}/relationship-overview")
                fixture.assertEqual(status, 404, result)
                result = {"http_status": status, "fixture_contact_removed": True}
            elif operation == "runtime_proof":
                result = guard_modules()
            else:
                raise ValueError("本人概览合成夹具操作无效。")
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
