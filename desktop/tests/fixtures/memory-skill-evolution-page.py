"""同一来源的有限组合页面夹具；用户决定由真实 React 页面提交。"""

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import traceback
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]


def install_resource_guard(ownership_path, database_name):
    """本轮页面可固定独立守卫，且须在项目导入前安装。"""
    keys = ('NOTALONE_EVOLUTION_GUARD_ADAPTER_PATH', 'NOTALONE_EVOLUTION_GUARD_ADAPTER_SHA256',
            'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_PATH', 'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_SHA256')
    if not any(os.environ.get(key) for key in keys):
        return None
    if not all(os.environ.get(key) for key in keys):
        raise RuntimeError('组合页面守卫须固定完整路径与摘要。')
    path = Path(os.environ[keys[0]])
    expected = os.environ[keys[1]]
    if not path.is_absolute() or not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise RuntimeError('组合页面守卫身份无效。')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        metadata = os.fstat(source.fileno())
        raw = source.read(256 * 1024 + 1)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600 or len(raw) > 256 * 1024
            or hashlib.sha256(raw).hexdigest() != expected):
        raise RuntimeError('组合页面守卫原字节不可核验。')
    namespace = {'__file__': str(path), '__name__': 'notalone15_page_resource_guard'}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace['install'](ROOT, ownership_path, database_name)


def record_failure():
    """先保存实际原栈；清理和守卫的后续异常各自记录。"""
    try:
        directory = Path(os.environ['NOTALONE_EVOLUTION_EVIDENCE_DIR'])
        metadata = directory.lstat()
        if (not directory.is_absolute() or directory.is_relative_to(ROOT)
                or not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o700):
            return
        descriptor = os.open(directory / f'fixture-failure-{uuid4().hex}.log',
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            traceback.print_exc(file=output)
            output.flush()
            os.fsync(output.fileno())
    except (OSError, KeyError):
        pass


def _run(resources):
    if (os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone" or Path.cwd() != ROOT / "backend"
            or os.environ.get("PYTHONPATH", "").split(os.pathsep)[:2]
            != [str(ROOT / "backend/src"), str(ROOT / "backend")]):
        raise RuntimeError("组合页面须使用当前工作树、明确 PYTHONPATH 与 Conda。")
    os.environ.update(NOTALONE_DISABLE_DOTENV="1", PYTHON_DOTENV_DISABLED="1",
                      LANGSMITH_TRACING="false", LANGCHAIN_TRACING_V2="false")
    from fixture_cleanup import cleanup_fixture
    from module_guard import bind_test_database_before_import, guard_modules, guard_test_migrations
    ownership_path = Path(os.environ["NOTALONE_ENV_FILE"]).parent / "database-ownership.json"
    database_name = bind_test_database_before_import(ownership_path)
    resource_guard = install_resource_guard(ownership_path, database_name)
    if resource_guard is None:
        raise RuntimeError("组合页面必须使用本轮有限资源守卫。")
    resources.callback(resource_guard.close)
    from notalone.application.setup_service import SetupService
    from notalone.database_migrations import migrate
    from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
    from notalone.persistence import skill_history, skill_policies, skill_execution_view
    from notalone.server.connection_info import write_backend_info
    from tests.integration.server.test_memory_skill_evolution import MemorySkillEvolutionHttpTest
    from tests.integration.server.memory_skill_evolution_models import EvolutionMemoryModel

    expected = json.loads(os.environ["NOTALONE_EVOLUTION_EXPECTED_MODULES"])
    directory = Path(os.environ["NOTALONE_EVOLUTION_EVIDENCE_DIR"]).resolve()
    if (not directory.is_dir() or directory.is_relative_to(ROOT)
            or directory.stat().st_mode & 0o777 != 0o700):
        raise RuntimeError("组合页面证据须保存到仓库外 700 目录。")
    proof_path = directory / f"evolution-page-{uuid4().hex}.json"

    class PageMemoryModel(EvolutionMemoryModel):
        model_call_limit: int = 12

    class PageReplyModel(MemorySkillEvolutionHttpTest.reply_model_factory):
        started_calls: int = 0

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self.started_calls >= 24:
                raise AssertionError("组合页面达到24次受控回复调用上限。")
            self.started_calls += 1
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    class PageFixture(MemorySkillEvolutionHttpTest):
        extraction_model_factory = PageMemoryModel
        reply_model_factory = PageReplyModel

        def build_setup_service(self):
            return SetupService(owner_directory=PostgresOwnerDirectory(self.database_url),
                                env_path=Path(os.environ["NOTALONE_ENV_FILE"]))

    fixture = PageFixture(methodName="runTest")
    PageFixture._prepared_database_name = database_name
    PageFixture._database_ownership_path = ownership_path
    resource_guard.register(PageFixture)
    migration_proof = {}
    try:
        fixture.setUpClass()
        os.environ.update(NOTALONE_DATABASE_URL=fixture.database_url,
                          NOTALONE_TEST_DATABASE_URL=fixture.database_url)
        migration_proof = guard_test_migrations(fixture.database_url, fixture.database_name, ROOT,
            expected_count=72, expected_tail="072_scoped_media_lifecycle.sql")
        fixture.setUp()
        state = fixture.prepare_evolution()
        if migrate(fixture.database_url, ROOT / "backend/database/migrations"):
            raise RuntimeError("组合页面重复正式迁移必须无新增。")

        def expose_backend():
            write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)

        expose_backend()
        proof = guard_modules(ROOT, expected=expected, evidence_path=proof_path, phase="ready")
        print(json.dumps({"ready": {"database_url": fixture.database_url, "owner_id": str(fixture.owner_id),
            "contact_ids": [state["contact_id"], state["other_contact_id"]],
            "other_contact_id": state["other_contact_id"], "empty_contact_id": state["other_contact_id"], **proof}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            if operation == "prepared":
                result = {key: state[key] for key in ("source_id", "contact_text", "owner_text")}
                result["draft_id"] = state["draft"]["draft_id"]
            elif operation == "observations":
                published = fixture._get(fixture.backend, state["draft_path"])["published"]
                fixture.assertIsNotNone(published)
                state["published"] = published
                state["publications"] = [(state["draft"]["draft_id"], published["version_id"])]
                result = {"published": published}
            elif operation == "feedback_reply":
                reply = fixture.evolution_reply(state, state["published"]["version_id"],
                    scene=command.get("scene", "核对安排"), other=command.get("other", False))
                result = {"used": reply["used_skill"] is not None,
                          "view": reply["used_skill"]["execution_view"],
                          "excluded_text_present": "合成排除方法甲" in str(fixture.reply_model.seen_calls[-1])}
            elif operation == "restart_backend":
                fixture.backend.close()
                fixture.backend = fixture._production_backend(fixture.owner_id)
                expose_backend()
                result = {"state": "restarted"}
            elif operation == "verify_deleted":
                # 删除后首次观察直接读数据库，禁止先由历史 GET 擦除副本。
                fixture.assert_evolution_deleted(state)
                result = {"verified": True}
            else:
                raise ValueError("未知组合页面夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    except BaseException:
        record_failure()
        raise
    finally:
        try:
            guard_modules(ROOT, expected=expected, evidence_path=proof_path, phase="complete")
            proof = json.loads(proof_path.read_text())
            proof.update(migration_proof, database_name=fixture.database_name, child_pid=os.getpid(),
                         model_call_limit=fixture.extraction_model.model_call_limit,
                         started_calls=fixture.extraction_model.started_calls, external_model_calls=0,
                         reply_call_limit=24, reply_started_calls=fixture.reply_model.started_calls,
                         requested_tools=fixture.extraction_model.requested_tools,
                         model_calls=len(fixture.extraction_model.seen_calls),
                         reply_calls=len(fixture.reply_model.seen_calls),
                         migrations=[item.name for item in sorted((ROOT / "backend/database/migrations").glob("*.sql"))])
            proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        finally:
            cleanup_fixture(fixture)


def main():
    resources = ExitStack()
    try:
        _run(resources)
    except BaseException:
        record_failure()
        try:
            resources.close()
        except BaseException:
            record_failure()
        raise
    else:
        resources.close()


if __name__ == "__main__":
    main()
