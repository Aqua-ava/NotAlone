"""主题资料页面与实际 App 共用的合成 HTTP/PG 边界夹具。"""

import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[3]


def main():
    if Path.cwd() != ROOT / "backend" or os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone":
        raise RuntimeError("主题资料夹具须使用本工作树和指定环境。")
    directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent
    evidence = Path(os.environ["NOTALONE_LAYERED_TEST_EVIDENCE_DIR"])
    if not evidence.is_absolute() or evidence.stat().st_mode & 0o777 != 0o700 or evidence.is_relative_to(ROOT):
        raise RuntimeError("主题资料证据目录不可核验。")
    name = f"notalone_core_flow_{uuid4().hex}_test"
    url = f"host=/tmp dbname={name}"
    os.environ.update(NOTALONE_DISABLE_DOTENV="1", PYTHON_DOTENV_DISABLED="1",
                      NOTALONE_DATABASE_URL=url, NOTALONE_TEST_DATABASE_URL=url,
                      NOTALONE_EXPECTED_TEST_DATABASE=name)
    marker = directory / "database-ownership.json"
    marker.write_text(json.dumps({"database_name": name, "child_pid": os.getpid(), "phase": "planned"}))
    marker.chmod(0o600)
    sys.path[:0] = [str(ROOT / "backend/src"), str(ROOT / "backend")]
    import psycopg
    from psycopg import sql
    from notalone.database_migrations import migrate
    from unittest.mock import patch
    from notalone.server.app import create_app
    from notalone.server.connection_info import write_backend_info
    from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
    from tests.integration.server.test_layered_reply_context import LayeredReplyHttpTest

    class Fixture(LayeredReplyHttpTest):
        def _backend(self, owner_id, **kwargs):
            if hasattr(self, "layered_reply_options"):
                self.layered_reply_options["layered_reply_budget"] = LayeredReplyBudget(
                    4, 4, 4000, scenario_read=ScenarioReadBudget(3, 4, 4000))
            def combined_app(**options):
                if hasattr(self, "service"):
                    options["layered_memory"] = self.service
                return create_app(**options)
            with patch("tests.integration.server.overview_reply_support.create_app", side_effect=combined_app):
                return super()._backend(owner_id, **kwargs)

    fixture = None
    created = False
    proof = {"database_name": name, "child_pid": os.getpid()}
    proof_path = evidence / f"layered-reply-runtime-{uuid4().hex}.json"
    try:
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        created = True
        applied = migrate(url, ROOT / "backend/database/migrations")
        expected_migrations = sorted(p.name for p in (ROOT / "backend/database/migrations").glob("*.sql"))
        if list(applied) != expected_migrations or migrate(url, ROOT / "backend/database/migrations"):
            raise RuntimeError("主题资料须完整正式迁移且重复为零。")
        Fixture.setUpClass()
        fixture = Fixture(methodName="runTest")
        fixture.setUp()
        contact, source, management, ready, reply_path = fixture.prepare_layered_reply()
        status, other = fixture.backend.request("/api/contacts", {"request_id": str(uuid4()), "display_name": "合成隔离联系人"})
        fixture.assertEqual(status, 201, other)
        empty, _, other_message = fixture.import_contact("另一联系人独有的合成旅行资料。", contact_id=other["contact"]["contact_id"])
        fixture.confirm(empty, "另一联系人独有的合成旅行资料。", other_message)
        fixture.activate_replies(empty)
        backend = fixture.backend
        fixture.reply_model.plans.extend([{ "text": "想聊聊一起参加课程的经历。", "basis": "尊重本次草稿，尚未核实的情况保持未知。" } for _ in range(12)])
        scenario = ready["scenarios"][0]

        def plan_scenario_reads(text="想聊聊一起参加课程的经历。"):
            arguments = {"scenario_id": scenario["scenario_id"], "paragraph_start": 0, "paragraph_end": 1}
            fixture.reply_model.plans[:0] = [
                {"history": {"name": "read_scenario", "args": dict(arguments)}},
                {"history": {"name": "read_scenario", "args": dict(arguments)}},
                {"text": text, "basis": "使用本次实际读入的历史课程正文，当前情况保持未知。"},
            ]
            return {"statuses": ["succeeded", "duplicate"], "paragraph_range": [0, 1]}

        if os.environ.get("NOTALONE_LAYERED_SCENARIO_READS") == "1":
            plan_scenario_reads()
        (directory / "synthetic.env").write_text(f"NOTALONE_DATABASE_URL={url}\nNOTALONE_OWNER_ID={fixture.owner_id}\n")
        (directory / "synthetic.env").chmod(0o600)
        expected = json.loads(os.environ["NOTALONE_LAYERED_EXPECTED_MODULES"])
        observed = {}
        for module_name, value in expected.items():
            module = sys.modules[module_name]
            actual = Path(module.__file__).resolve()
            digest = hashlib.sha256(actual.read_bytes()).hexdigest()
            if actual != ROOT / value["path"] or digest != value["sha256"]:
                raise RuntimeError("主题资料夹具加载了其它工作树模块。")
            observed[module_name] = {"path": str(actual), "sha256": digest}
        proof.update(migrations=expected_migrations, migration_repeat=0, modules=observed,
                     external_model_calls=0, quality="synthetic")
        write_backend_info(address=backend.base_url.removeprefix("http://"), token=backend.token)
        print(json.dumps({"ready": {"database_url": url, "owner_id": str(fixture.owner_id),
            "contact_ids": [contact, empty], "other_contact_id": empty, "empty_contact_id": empty}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "delete_source":
                result = fixture.delete_source(contact, source)
            elif operation == "add_memory":
                status, result = fixture.backend.request("/api/memories/manual-contact", {
                    "contact_id": contact, "text": "双方新近完成合成复习。", "category": "common_fact"})
                fixture.assertEqual(status, 200, result)
            elif operation == "runtime_proof":
                result = {**proof, "reply_model_calls": len(fixture.reply_model.payloads)}
            elif operation == "prepared":
                result = {"contact_id": contact, "source_id": source, "other_contact_id": empty, "profile_version_id": ready["profile"]["version_id"],
                    "scenario_id": scenario["scenario_id"], "scenario_version_id": scenario["version_id"],
                    "scenario_text": scenario["paragraphs"][0]["text"], "scenario_references": scenario["paragraphs"][0]["references"],
                    "scenario_paragraph_count": len(scenario["paragraphs"]), "profile_text": ready["profile"]["entries"][0]["text"]}
            elif operation == "plan_scenario_reads":
                result = plan_scenario_reads(command.get("text", "想聊聊一起参加课程的经历。"))
            elif operation == "saved_scenario_evidence":
                plan_scenario_reads()
                status, turn = backend.request(reply_path + "/replies",
                    fixture.rewrite_body(contact, "聊聊共同参加的课程。"), timeout=30)
                fixture.assertEqual(status, 200, turn)
                result = fixture._get(backend, fixture.evidence_path(contact, turn))
            elif operation == "plan":
                fixture.reply_model.plans.insert(0, command["plan"])
                result = {}
            elif operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            else:
                raise ValueError("主题资料合成夹具操作无效。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        instance_ok = fixture.doCleanups() if fixture else True
        if created:
            with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
                created = admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)", (name,)).fetchone()[0]
        proof.update(cleanup_confirmed=instance_ok and not created, database_remaining=created)
        proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        proof_path.chmod(0o600)
        if not instance_ok or created:
            raise RuntimeError("主题资料夹具清理未确认。")
        print(json.dumps({"cleanup": {"instance_ok": True, "class_ok": True,
            "database_remaining": False}, "cleanupConfirmed": True}), flush=True)


if __name__ == "__main__":
    main()
