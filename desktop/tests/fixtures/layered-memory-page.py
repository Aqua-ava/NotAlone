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
    from notalone.application.layered_memory_service import LayeredMemoryService
    from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
    from notalone.application.memory_service import MemoryService
    from notalone.application.setup_service import SetupService
    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
    from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
    from notalone.server.app import create_app
    from notalone.server.connection_info import write_backend_info
    from tests.integration.server.core_business_flow_support import HttpBackend
    from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture

    class Fixture(MemoryOverviewHttpFixture, unittest.TestCase):
        pass

    class Proposal:
        timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

        calls = 0

        def propose(self, *, memories, budget, deadline):
            deadline.check()
            self.calls += 1
            return {"scenarios": [{"topic_key": "synthetic-learning", "title": "合成学习记录",
                "hint": "双方共同学习的合成记录", "paragraphs": [{"text": item.text,
                "references": [{"memory_id": str(item.memory_id), "revision": item.revision}]}
                for item in memories]}]}

    class Verification:
        timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

        calls = 0

        def verify(self, *, memories, proposal, deadline):
            deadline.check()
            self.calls += 1
            available = {(str(item.memory_id), item.revision): item.text for item in memories}
            return all(len(paragraph["references"]) == 1 and available.get((
                paragraph["references"][0]["memory_id"], paragraph["references"][0]["revision"])) == paragraph["text"]
                for scenario in proposal["scenarios"] for paragraph in scenario["paragraphs"])

    fixture = None
    created = False
    proof = {"database_name": name, "child_pid": os.getpid()}
    proof_path = evidence / f"layered-runtime-{uuid4().hex}.json"
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
        contact, source, message = fixture.import_contact("双方共同参加合成学习课程。")
        fixture.confirm(contact, "双方共同参加合成学习课程。", message)
        status, created_contact = fixture.backend.request("/api/contacts", {
            "request_id": str(uuid4()), "display_name": "空资料联系人"})
        fixture.assertEqual(status, 201, created_contact)
        empty = created_contact["contact"]["contact_id"]
        (directory / "synthetic.env").write_text(f"NOTALONE_DATABASE_URL={url}\nNOTALONE_OWNER_ID={fixture.owner_id}\n")
        (directory / "synthetic.env").chmod(0o600)
        proposal, verification = Proposal(), Verification()
        service = LayeredMemoryService(PostgresLayeredMemoryStore(url), proposer=proposal,
                                       verifier=verification, synthetic=True)
        backend = HttpBackend(create_app(database_url=url, owner_id=fixture.owner_id,
            token="synthetic-layered-page-token", memory_service=MemoryService(
                contact_memory=PostgresMemoryStore(url), owner_memory=PostgresOwnerMemoryStore(url)),
            layered_memory=service, runtime_shutdown=lambda: None,
            setup_service=SetupService(owner_directory=PostgresOwnerDirectory(url),
                env_path=directory / "synthetic.env")), fixture.owner_id)
        fixture.addCleanup(backend.close)
        fixture.backend = backend
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
            elif operation == "runtime_proof":
                result = {**proof, "proposal_calls": proposal.calls, "verification_calls": verification.calls}
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
