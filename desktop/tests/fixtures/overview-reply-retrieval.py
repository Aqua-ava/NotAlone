"""07 的合成桌面验收：公开导入、人工确认与正式回复装配。"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
from traceback import format_exc
from unittest import TestCase
from unittest.mock import patch
from uuid import UUID, uuid4


ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
    if (os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone"
            or not os.environ.get("CONDA_PREFIX") or Path.cwd() != ROOT / "backend"):
        raise RuntimeError("概览回复夹具须从本工作树backend在Conda NotAlone中运行。")
    if os.environ.get("PYTHONPATH", "").split(os.pathsep)[0] != str(ROOT / "backend/src"):
        raise RuntimeError("概览回复夹具须显式使用本工作树生产模块。")
    os.environ.update({"NOTALONE_DISABLE_DOTENV": "1", "PYTHON_DOTENV_DISABLED": "1",
                       "LANGCHAIN_TRACING_V2": "false", "LANGCHAIN_TRACING": "false",
                       "LANGSMITH_TRACING": "false"})
    database_name = f"notalone_core_flow_{uuid4().hex}_test"
    database_url = f"host=/tmp dbname={database_name}"
    os.environ.update({"NOTALONE_TEST_DATABASE_URL": database_url, "NOTALONE_DATABASE_URL": database_url,
                       "NOTALONE_EXPECTED_TEST_DATABASE": database_name})
    directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent
    evidence_directory = Path(os.environ["NOTALONE_REPLY_OVERVIEW_TEST_EVIDENCE_DIR"])
    if (not evidence_directory.is_absolute() or not evidence_directory.is_dir()
            or evidence_directory.stat().st_mode & 0o777 != 0o700
            or evidence_directory.is_relative_to(ROOT)):
        raise RuntimeError("概览回复证据必须保存到仓库外的700目录。")
    evidence_path = evidence_directory / f"overview-reply-runtime-{uuid4().hex}.json"
    expected = json.loads(os.environ["NOTALONE_REPLY_OVERVIEW_TEST_EXPECTED_MODULES"])
    if not isinstance(expected, dict) or len(expected) != 22:
        raise RuntimeError("概览回复夹具缺少调用方的固定模块摘要。")
    descriptor = os.open(directory / "database-ownership.json",
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump({"database_name": database_name, "child_pid": os.getpid(), "phase": "planned"}, output)
        output.flush()
        os.fsync(output.fileno())
    sys.path.insert(0, str(ROOT / "backend/src"))
    sys.path.insert(1, str(ROOT / "backend"))

    # 双URL、工作树来源与自有库身份先固定，再导入生产模块与公共HTTP夹具。
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
                raise RuntimeError("本轮概览回复测试库仍有残留。")
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
                raise RuntimeError(f"概览回复验收模块加载到其它目录：{name}")
            observed.append({"module": name, "path": str(actual_path),
                             "sha256": hashlib.sha256(actual_path.read_bytes()).hexdigest()})
        by_name = {entry["module"]: entry for entry in observed}
        for name, fixed in expected.items():
            actual = by_name.get(name)
            if (not isinstance(fixed, dict) or actual is None
                    or actual["path"] != str((ROOT / fixed["path"]).resolve())
                    or actual["sha256"] != fixed["sha256"]):
                raise RuntimeError(f"概览回复验收实际模块摘要不符：{name}")
        calls = len(fixture.reply_model.payloads) if fixture is not None and hasattr(fixture, "reply_model") else 0
        proof.update({"phase": "running", "loaded_modules": observed,
                      "critical_modules": {name: by_name[name] for name in expected},
                      "model_attempt_count": len(model_attempts), "controlled_model_calls": calls,
                      "environment": {"conda": os.environ["CONDA_DEFAULT_ENV"], "cwd": str(Path.cwd()),
                                      "pythonpath": os.environ["PYTHONPATH"],
                                      "dual_url_equal": os.environ["NOTALONE_TEST_DATABASE_URL"] == os.environ["NOTALONE_DATABASE_URL"],
                                      "dotenv_disabled": True, "tracing_disabled": True}})
        save_proof()
        return {"loaded_module_count": len(observed), "critical_module_count": len(expected),
                "environment_verified": True, "evidence_file": evidence_path.name,
                "child_pid": os.getpid(), "database_name": database_name,
                "model_calls": calls, "external_model_attempts": len(model_attempts)}

    try:
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database_name)))
            created = True
        from notalone.database_migrations import migrate
        from notalone.server.connection_info import write_backend_info
        from notalone.memory.models import FactSubject, MemoryCandidate, MemoryCategory
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.scopes import ContactScope
        from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture

        def reject_model(*args, **kwargs):
            model_attempts.append(True)
            raise RuntimeError("概览回复验收不允许调用外部模型。")

        with patch("notalone.memory_extraction.cli_support.build_deepseek_model", side_effect=reject_model), \
                patch("notalone.server.reply_wiring.build_deepseek_model", side_effect=reject_model):
            applied = migrate(database_url, ROOT / "backend/database/migrations")
            official = sorted(path.name for path in (ROOT / "backend/database/migrations").glob("[0-9][0-9][0-9]_*.sql"))
            if ([int(name[:3]) for name in official] != list(range(1, len(official) + 1))
                    or len(applied) != 65 or len(official) != 65
                    or official[-1] != "065_memory_upgrade_batches.sql"):
                raise RuntimeError("概览回复夹具须使用正式连续001–当前迁移，精确到065。")
            if migrate(database_url, ROOT / "backend/database/migrations"):
                raise RuntimeError("概览回复迁移重复执行不应新增迁移。")
            with psycopg.connect(database_url) as connection:
                if connection.execute("SELECT current_database()").fetchone()[0] != database_name:
                    raise RuntimeError("概览回复数据库身份不匹配。")
            proof["migrations"] = official
            proof["migration_repeat"] = 0

            class DesktopOverviewReplyFixture(OverviewReplyHttpFixture, TestCase):
                pass

            DesktopOverviewReplyFixture.database_name = database_name
            DesktopOverviewReplyFixture.setUpClass()
            fixture = DesktopOverviewReplyFixture(methodName="runTest")
            fixture.setUp()
            raw = "去年散步时对方在准备合成课程。"
            contact, source, message = fixture.import_contact(raw, owner_text="本人散步时偏好安静路线。")
            history = fixture.confirm(contact, "去年散步时对方在准备课程。", message, category="recent_state",
                                      valid_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
                                      invalid_at=datetime(2024, 2, 1, tzinfo=timezone.utc))
            owner_message = next(item for item in fixture._get(fixture.backend, f"/api/contacts/{contact}/messages")["messages"]
                                 if item["speaker"] == "user")
            self_memory = fixture.confirm(contact, "本人散步时偏好安静路线。", UUID(owner_message["message_id"]),
                                          subject=FactSubject.SELF, category="preference")
            _, _, unknown_message = fixture.import_contact("周末散步安排还没有确定。", contact_id=contact,
                                                          when=datetime(2024, 1, 2, tzinfo=timezone.utc))
            unknown = fixture.confirm(contact, "近期散步安排还没有确定。", unknown_message, category="recent_state")
            manual_contact = fixture.manual_contact(contact, "对方明确偏好慢慢散步。", category="preference")
            manual_owner = fixture.manual_owner("本人明确喜欢散步。", category="preference")
            pending = PostgresMemoryStore(database_url).create_candidate(MemoryCandidate(
                candidate_id=uuid4(), scope=ContactScope(fixture.owner_id, UUID(contact)),
                text="未确认参考：对方或许愿意一起散步。", category=MemoryCategory.PREFERENCE,
                source_ids=(unknown_message,), confidence=0.8, interpretation_reason="合成提取边界提出的待确认参考。",
            ))
            other_private = "另一位联系人的私密散步原话不可进入当前关系。"
            other_contact, _, other_message = fixture.import_contact(other_private, owner_text="本人散步时喜欢带水。")
            fixture.confirm(other_contact, "另一位联系人的私密散步事实。", other_message)
            other_owner_message = next(item for item in fixture._get(fixture.backend, f"/api/contacts/{other_contact}/messages")["messages"]
                                       if item["speaker"] == "user")
            other_self = fixture.confirm(other_contact, "本人散步时喜欢带水。", UUID(other_owner_message["message_id"]),
                                         subject=FactSubject.SELF, category="preference")
            fixture.activate_replies(contact)
            prepared = {"contactId": contact, "otherContactId": other_contact, "sourceToDelete": source,
                        "draft": "想聊散步，先问安排。", "rawText": raw,
                        "otherPrivateText": other_private, "history": history, "unknown": unknown,
                        "manualContact": manual_contact, "manualOwner": manual_owner,
                        "self": self_memory, "otherSelf": other_self,
                        "pending": {"candidate_id": str(pending.candidate_id), "text": pending.text}}
            write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
            runtime_proof = guard_modules()
            print(json.dumps({"ready": {"database_url": database_url, "owner_id": str(fixture.owner_id),
                                        "contact_ids": [contact, other_contact], "other_contact_id": other_contact,
                                        "empty_contact_id": other_contact, "migration_count": len(applied),
                                        "migration_repeat": 0, "runtime_proof": runtime_proof}}), flush=True)
            for line in sys.stdin:
                command = json.loads(line)
                operation = command["operation"]
                if operation == "stop":
                    print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                    break
                if operation == "reply_overview_prepared":
                    result = prepared
                elif operation == "plan":
                    fixture.reply_model.plans.append(command["plan"])
                    result = {}
                elif operation == "observations":
                    result = {"payloads": fixture.reply_model.payloads, "model_calls": len(fixture.reply_model.payloads)}
                elif operation == "more_related":
                    for number in range(5):
                        fixture.manual_contact(contact, f"散步补充资料{number}：对方有不同明确偏好。", category="preference")
                    for number in range(2):
                        fixture.manual_owner(f"本人散步偏好补充{number}：使用合成薄帽。", category="preference")
                    for number in range(3):
                        PostgresMemoryStore(database_url).create_candidate(MemoryCandidate(
                            candidate_id=uuid4(), scope=ContactScope(fixture.owner_id, UUID(contact)),
                            text=f"散步待确认参考{number}：还有一种可能安排。", category=MemoryCategory.PREFERENCE,
                            source_ids=(unknown_message,), confidence=0.8,
                        ))
                    result = {}
                elif operation == "runtime_proof":
                    result = guard_modules()
                else:
                    raise ValueError("概览回复合成夹具操作无效。")
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
            raise RuntimeError("概览回复夹具HTTP或自有测试库清理未确认。")
        print(json.dumps({"cleanup": {"instance_ok": instance_ok, "class_ok": True,
                                      "database_remaining": False}, "cleanupConfirmed": True}), flush=True)


if __name__ == "__main__":
    main()
