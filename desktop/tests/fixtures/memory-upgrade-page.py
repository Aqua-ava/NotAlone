"""显式旧资料升级的有限页面夹具；不启动真实App或读取业务历史。"""

import json
import os
from pathlib import Path
import sys
from contextlib import ExitStack
import hashlib
import re
import stat
import traceback
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]


def install_resource_guard(ownership_path, database_name):
    """有限验收可固定私有守卫；生产装配不读取这些参数。"""
    keys = ('NOTALONE_UPGRADE_GUARD_ADAPTER_PATH', 'NOTALONE_UPGRADE_GUARD_ADAPTER_SHA256',
            'NOTALONE_UPGRADE_DATABASE_GUARD_PATH', 'NOTALONE_UPGRADE_DATABASE_GUARD_SHA256')
    if not any(os.environ.get(key) for key in keys):
        return None
    if not all(os.environ.get(key) for key in keys):
        raise RuntimeError('升级页面守卫须固定完整路径与摘要。')
    path = Path(os.environ[keys[0]])
    expected = os.environ[keys[1]]
    if not path.is_absolute() or not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise RuntimeError('升级页面守卫身份无效。')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        metadata = os.fstat(source.fileno())
        raw = source.read(256 * 1024 + 1)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600 or len(raw) > 256 * 1024
            or hashlib.sha256(raw).hexdigest() != expected):
        raise RuntimeError('升级页面守卫原字节不可核验。')
    namespace = {'__file__': str(path), '__name__': 'notalone10_page_resource_guard'}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace['install'](ROOT, ownership_path, database_name)


def main():
    try:
        with ExitStack() as resources:
            _run(resources)
    except BaseException:
        # 通道故障也保留本轮私人原栈，不让无头runner吞掉准备失败。
        try:
            directory = Path(os.environ['NOTALONE_UPGRADE_EVIDENCE_DIR'])
            metadata = directory.lstat()
            if (not directory.is_absolute() or directory.is_relative_to(ROOT)
                    or not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                    or stat.S_IMODE(metadata.st_mode) != 0o700):
                raise OSError('升级失败证据目录不可核验。')
            descriptor = os.open(directory / f'fixture-failure-{uuid4().hex}.log',
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                traceback.print_exc(file=output)
                output.flush()
                os.fsync(output.fileno())
        except (OSError, KeyError):
            pass
        raise


def _run(resources):
    if (os.environ.get('CONDA_DEFAULT_ENV') != 'NotAlone' or Path.cwd() != ROOT / 'backend'
            or os.environ.get('PYTHONPATH', '').split(os.pathsep)[:2] != [str(ROOT / 'backend/src'), str(ROOT / 'backend')]):
        raise RuntimeError('升级页面须使用当前工作树、明确PYTHONPATH与Conda。')
    if (ROOT / 'backend/database/pending/13_memory_upgrade_batches.sql').exists():
        raise RuntimeError('升级页面须等待正式连续迁移。')
    os.environ.update(NOTALONE_DISABLE_DOTENV='1', PYTHON_DOTENV_DISABLED='1',
                      LANGSMITH_TRACING='false', LANGCHAIN_TRACING_V2='false')
    from fixture_cleanup import cleanup_fixture
    from module_guard import bind_test_database_before_import, guard_modules, guard_test_migrations
    ownership_path = Path(os.environ['NOTALONE_ENV_FILE']).parent / 'database-ownership.json'
    database_name = bind_test_database_before_import(ownership_path)
    resource_guard = install_resource_guard(ownership_path, database_name)
    if resource_guard is not None:
        resources.callback(resource_guard.close)
    from notalone.server.connection_info import write_backend_info
    from notalone.database_migrations import migrate
    from notalone.application.setup_service import SetupService
    from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
    from tests.integration.server.test_memory_upgrade import MemoryUpgradeHttpTest
    # 固定稍后比较／应用才会懒加载的模块；此处只导入，不执行工作或模型。
    from notalone.application import memory_upgrade_preview
    from notalone.memory import upgrade_algorithm
    from notalone.persistence import memory_upgrade_apply
    import psycopg

    expected = json.loads(os.environ['NOTALONE_UPGRADE_EXPECTED_MODULES'])
    directory = Path(os.environ['NOTALONE_UPGRADE_EVIDENCE_DIR']).resolve()
    if (not directory.is_dir() or directory.is_relative_to(ROOT) or directory.stat().st_mode & 0o777 != 0o700):
        raise RuntimeError('升级页面证据须保存到仓库外700目录。')
    proof_path = directory / f'upgrade-page-{uuid4().hex}.json'

    class PageUpgradeModel(MemoryUpgradeHttpTest.extraction_model_factory):
        started_calls: int = 0

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self.started_calls >= 4:
                raise AssertionError('升级页面只允许4次受控模型调用。')
            self.started_calls += 1
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    class PageFixture(MemoryUpgradeHttpTest):
        extraction_model_factory = PageUpgradeModel

        def build_setup_service(self):
            return SetupService(owner_directory=PostgresOwnerDirectory(self.database_url),
                                env_path=Path(os.environ['NOTALONE_ENV_FILE']))

    fixture = PageFixture(methodName='runTest')
    PageFixture._prepared_database_name = database_name
    PageFixture._database_ownership_path = ownership_path
    if resource_guard is not None:
        resource_guard.register(PageFixture)
    migration_proof = {}
    try:
        fixture.setUpClass()
        os.environ.update(NOTALONE_DATABASE_URL=fixture.database_url, NOTALONE_TEST_DATABASE_URL=fixture.database_url)
        migration_proof = guard_test_migrations(fixture.database_url, fixture.database_name, ROOT)
        fixture.setUp()
        with psycopg.connect(fixture.database_url) as connection:
            for contact, name in ((fixture.contact_id, '合成升级甲联系人'), (fixture.second_contact_id, '合成升级乙联系人')):
                connection.execute('UPDATE public.contact SET display_name=%s WHERE owner_id=%s AND id=%s',
                                   (name, fixture.owner_id, contact))
        source, _ = fixture._raw()
        status, result = fixture.backend.request('/api/memories/manual-contact',
            {'contact_id': str(fixture.contact_id), 'text': '合成旧人工事实：联系人喜欢合成白茶。',
             'category': 'preference', 'topic': 'other'})
        if status != 200:
            raise RuntimeError('合成旧资料准备失败。')
        manual_query = '''SELECT to_jsonb(m),to_jsonb(c) FROM public.confirmed_memory m
            JOIN public.memory_candidate c ON c.id=m.source_candidate_id
                AND c.owner_id=m.owner_id AND c.contact_id=m.contact_id
            WHERE m.owner_id=%s AND m.contact_id=%s AND m.id=%s'''
        manual_parameters = (fixture.owner_id, fixture.contact_id, result['memory']['memory_id'])
        with psycopg.connect(fixture.database_url) as connection:
            manual_snapshot = connection.execute(manual_query, manual_parameters).fetchone()
            if manual_snapshot is None:
                raise RuntimeError('人工旧资料及其已确认候选必须真实保留。')
        if migrate(fixture.database_url, ROOT / 'backend/database/migrations'):
            raise RuntimeError('升级页面重复正式迁移必须无新增。')
        write_backend_info(address=fixture.backend.base_url.removeprefix('http://'), token=fixture.backend.token)
        proof = guard_modules(ROOT, expected=expected, evidence_path=proof_path, phase='ready')
        proof.update(migration_proof)
        print(json.dumps({'ready': {'database_url': fixture.database_url, 'owner_id': str(fixture.owner_id),
            'contact_ids': [str(fixture.contact_id), str(fixture.second_contact_id)],
            'other_contact_id': str(fixture.second_contact_id), 'empty_contact_id': str(fixture.second_contact_id), **proof}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command['operation']
            if operation == 'stop':
                print(json.dumps({'id': command['id'], 'result': {}}), flush=True)
                break
            if operation == 'restart_backend':
                fixture.backend.close()
                fixture.backend = fixture._production_backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix('http://'), token=fixture.backend.token)
                result = {'state': 'restarted'}
            elif operation == 'observations':
                with psycopg.connect(fixture.database_url) as connection:
                    candidates = connection.execute("SELECT count(*) FROM public.memory_candidate WHERE owner_id=%s AND contact_id=%s AND status='pending'", (fixture.owner_id, fixture.contact_id)).fetchone()[0]
                    manual_unchanged = connection.execute(manual_query, manual_parameters).fetchone() == manual_snapshot
                result = {'model_calls': len(fixture.extraction_model.seen_calls), 'pending_candidates': candidates,
                          'manual_unchanged': manual_unchanged,
                          'source_id': str(source)}
            else:
                raise ValueError('未知升级页面夹具操作。')
            print(json.dumps({'id': command['id'], 'result': result}), flush=True)
    finally:
        try:
            guard_modules(ROOT, expected=expected, evidence_path=proof_path, phase='complete')
            proof = json.loads(proof_path.read_text())
            proof.update(migration_proof, database_name=fixture.database_name, child_pid=os.getpid(),
                         model_call_limit=4, external_model_calls=0,
                         started_calls=fixture.extraction_model.started_calls,
                         before_import_ownership=json.loads((ownership_path.parent / 'import-database-ownership.json').read_text()),
                         core_ownership=json.loads(ownership_path.read_text()),
                         model_calls=len(fixture.extraction_model.seen_calls),
                         migrations=[path.name for path in sorted((ROOT / 'backend/database/migrations').glob('*.sql'))])
            proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        finally:
            cleanup_fixture(fixture)
            proof = json.loads(proof_path.read_text()) if proof_path.exists() else {'phase': 'failed_before_module_proof'}
            proof.update(database_remaining=False, fixture_cleanup_completed=True)
            proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
