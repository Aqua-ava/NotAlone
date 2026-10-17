"""长期偏好普通页面的隔离HTTP夹具；只使用合成模型和正式迁移。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
    if os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone" or Path.cwd() != ROOT / "backend":
        raise RuntimeError("长期偏好页面须使用本工作树与Conda NotAlone。")
    if os.environ.get("PYTHONPATH", "").split(os.pathsep)[0] != str(ROOT / "backend/src"):
        raise RuntimeError("长期偏好页面须显式加载本工作树模块。")
    if (ROOT / "backend/database/pending/08_expression_preferences.sql").exists():
        raise RuntimeError("长期偏好页面验收须等待正式连续迁移，不使用pending代替。")
    os.environ.update({"NOTALONE_DISABLE_DOTENV": "1", "PYTHON_DOTENV_DISABLED": "1",
                       "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false"})
    from fixture_cleanup import cleanup_fixture
    from module_guard import bind_test_database_before_import, guard_modules, guard_test_migrations
    ownership_path = Path(os.environ["NOTALONE_ENV_FILE"]).parent / "database-ownership.json"
    database_name = bind_test_database_before_import(ownership_path)
    from notalone.server.connection_info import write_backend_info
    from notalone.database_migrations import migrate
    from tests.integration.server.test_expression_preferences import ExpressionPreferencesHttpTest, PreferenceAwareModel
    import psycopg
    from notalone.application.setup_service import SetupService
    from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory

    expected = json.loads(os.environ['NOTALONE_PREFERENCE_EXPECTED_MODULES'])
    evidence_directory = Path(os.environ['NOTALONE_PREFERENCE_EVIDENCE_DIR']).resolve()
    if (not evidence_directory.is_dir() or evidence_directory.is_relative_to(ROOT)
            or evidence_directory.stat().st_mode & 0o777 != 0o700):
        raise RuntimeError('页面证据须保存到仓库外700目录。')
    evidence_path = evidence_directory / f'preference-page-{uuid4().hex}.json'

    class PagePreferenceModel(PreferenceAwareModel):
        started_calls: int = 0

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self.started_calls >= 4:
                raise AssertionError("本轮页面最多4次受控模型调用，禁止额外调用。")
            self.started_calls += 1
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    class DesktopPreferencesFixture(ExpressionPreferencesHttpTest):
        reply_model_factory = PagePreferenceModel

        def build_setup_service(self):
            return SetupService(owner_directory=PostgresOwnerDirectory(self.database_url),
                                env_path=Path(os.environ['NOTALONE_ENV_FILE']))

    fixture = DesktopPreferencesFixture(methodName="runTest")
    DesktopPreferencesFixture._prepared_database_name = database_name
    DesktopPreferencesFixture._database_ownership_path = ownership_path
    migration_proof = {}
    observations = []
    try:
        fixture.setUpClass()
        os.environ.update({"NOTALONE_DATABASE_URL": fixture.database_url,
                           "NOTALONE_TEST_DATABASE_URL": fixture.database_url})
        migration_proof = guard_test_migrations(fixture.database_url, fixture.database_name, ROOT)
        fixture.setUp()
        fixture._bind(fixture.contact_id)
        fixture._bind(fixture.second_contact_id)
        if migrate(fixture.database_url, ROOT / 'backend/database/migrations'):
            raise RuntimeError('页面只允许正式迁移且重复执行无新增。')
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        loaded = [Path(module.__file__).resolve() for name, module in tuple(sys.modules.items())
                  if name.startswith("notalone.") and getattr(module, "__file__", None)]
        if not loaded or any(not path.is_relative_to(ROOT / "backend/src") for path in loaded):
            raise RuntimeError("长期偏好页面加载了其他工作树代码。")
        proof = guard_modules(ROOT, expected=expected, evidence_path=evidence_path, phase='ready')
        proof.update(migration_proof)
        print(json.dumps({"ready": {"database_url": fixture.database_url,
                                    "owner_id": str(fixture.owner_id),
                                    "contact_ids": [str(fixture.contact_id), str(fixture.second_contact_id)],
                                    "other_contact_id": str(fixture.second_contact_id),
                                    "empty_contact_id": str(fixture.second_contact_id), **proof}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "stop":
                for gate in fixture.reply_model.response_gates.values():
                    gate.set()
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            if operation == "pause_response":
                fixture.reply_model.entered.clear()
                fixture.reply_model.pause_next_response()
                result = {"state": "paused"}
            elif operation == "await_model":
                if not fixture.reply_model.entered.wait(3):
                    raise TimeoutError("页面受控模型未在有限等待内进入。")
                result = {"state": "entered", "started_calls": fixture.reply_model.started_calls}
            elif operation == "release_response":
                for gate in fixture.reply_model.response_gates.values():
                    gate.set()
                result = {"state": "released"}
            elif operation == "prepare_source":
                source_id, message_id = fixture._source_message()
                preference = fixture._save("有来源的合成表达要求。", contact_id=fixture.contact_id,
                                           origin={"kind": "message", "id": str(message_id)})
                result = {"source_id": str(source_id), "preference": preference}
            elif operation == 'restart_backend':
                # PageHost.close真实停读后，重新装配同库服务；不伪装已停止实例仍可工作。
                fixture.backend.close()
                fixture.backend = fixture._production_backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix('http://'), token=fixture.backend.token)
                result = {'state': 'restarted'}
            elif operation == "observations":
                with psycopg.connect(fixture.database_url) as connection:
                    turns = connection.execute(
                        "SELECT idempotency_key,state,prepared_context FROM public.assistant_session_turn "
                        "WHERE owner_id=%s AND contact_id=%s ORDER BY created_at,id",
                        (fixture.owner_id, fixture.contact_id),
                    ).fetchall()
                result = {"model_calls": len(fixture.reply_model.seen_calls),
                          "started_calls": fixture.reply_model.started_calls,
                          "loaded_module_count": len(loaded),
                          "turns": [{"request_key": str(key), "state": state,
                                     "schema_revision": context.get("schema_revision") if context else None,
                                     "preference_revisions": [item["fields"]["revision"] for item in context["context"]["expression_preferences"]] if context else []}
                                    for key, state, context in turns]}
                observations.append(result)
            else:
                raise ValueError("未知长期偏好页面夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        for gate in getattr(getattr(fixture, "reply_model", None), "response_gates", {}).values():
            gate.set()
        try:
            guard_modules(ROOT, expected=expected, evidence_path=evidence_path, phase='complete')
            proof = json.loads(evidence_path.read_text())
            proof.update(migration_proof, database_name=fixture.database_name, child_pid=os.getpid(),
                         model_calls=len(fixture.reply_model.seen_calls), started_calls=fixture.reply_model.started_calls,
                         observations=observations, model_call_limit=4, external_model_calls=0,
                         before_import_ownership=json.loads((ownership_path.parent / "import-database-ownership.json").read_text()),
                         core_ownership=json.loads(ownership_path.read_text()),
                         migrations=[path.name for path in sorted((ROOT / 'backend/database/migrations').glob('*.sql'))])
            evidence_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        finally:
            cleanup_fixture(fixture)
            proof = json.loads(evidence_path.read_text())
            proof.update(database_remaining=False, fixture_cleanup_completed=True)
            evidence_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
