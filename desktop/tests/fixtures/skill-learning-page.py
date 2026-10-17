"""有限学习页面的真实HTTP/隔离库夹具；只替换外部模型。"""

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
    """本轮页面可固定独立守卫，且须在项目导入前安装。"""
    keys = ('NOTALONE_LEARNING_GUARD_ADAPTER_PATH', 'NOTALONE_LEARNING_GUARD_ADAPTER_SHA256',
            'NOTALONE_LEARNING_GUARD_DATABASE_GUARD_PATH', 'NOTALONE_LEARNING_GUARD_DATABASE_GUARD_SHA256')
    if not any(os.environ.get(key) for key in keys):
        return None
    if not all(os.environ.get(key) for key in keys):
        raise RuntimeError('审核页面守卫须固定完整路径与摘要。')
    path = Path(os.environ[keys[0]])
    expected = os.environ[keys[1]]
    if not path.is_absolute() or not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise RuntimeError('审核页面守卫身份无效。')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        metadata = os.fstat(source.fileno())
        raw = source.read(256 * 1024 + 1)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600 or len(raw) > 256 * 1024
            or hashlib.sha256(raw).hexdigest() != expected):
        raise RuntimeError('审核页面守卫原字节不可核验。')
    namespace = {'__file__': str(path), '__name__': 'notalone11_page_resource_guard'}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace['install'](ROOT, ownership_path, database_name)


def record_failure():
    """先保存实际原栈；清理和守卫的后续异常各自记录。"""
    try:
        directory = Path(os.environ['NOTALONE_LEARNING_EVIDENCE_DIR'])
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


def _run(resources):
    if (os.environ.get('CONDA_DEFAULT_ENV') != 'NotAlone' or Path.cwd() != ROOT / 'backend'
            or os.environ.get('PYTHONPATH', '').split(os.pathsep)[:2] != [str(ROOT / 'backend/src'), str(ROOT / 'backend')]):
        raise RuntimeError('学习页面须使用当前工作树、明确PYTHONPATH与Conda。')
    if (ROOT / 'backend/database/pending/09_skill_learning_drafts.sql').exists():
        raise RuntimeError('学习页面须等待正式连续迁移。')
    os.environ.update(NOTALONE_DISABLE_DOTENV='1', PYTHON_DOTENV_DISABLED='1',
                      LANGSMITH_TRACING='false', LANGCHAIN_TRACING_V2='false')
    from fixture_cleanup import cleanup_fixture
    from module_guard import bind_test_database_before_import, guard_modules, guard_test_migrations
    ownership_path = Path(os.environ["NOTALONE_ENV_FILE"]).parent / "database-ownership.json"
    database_name = bind_test_database_before_import(ownership_path)
    resource_guard = install_resource_guard(ownership_path, database_name)
    if resource_guard is not None:
        resources.callback(resource_guard.close)
    from notalone.server.connection_info import write_backend_info
    from notalone.database_migrations import migrate
    from notalone.application.setup_service import SetupService
    from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
    from tests.integration.server.test_skill_learning import SkillLearningHttpTest, ControlledLearningModel, synthetic_proposal, tool_response

    reviewing = os.environ.get('NOTALONE_SKILL_REVIEW_PAGE') == '1'
    base = SkillLearningHttpTest
    if reviewing:
        if list((ROOT / 'backend/database/pending').glob('*skill_review*.sql')):
            raise RuntimeError('审核页面须等待正式连续迁移。')
        from tests.integration.server.test_skill_review import SkillReviewHttpTest
        # 这些生产模块稍后才懒加载；ready前实际导入并核摘要。
        from notalone.application import skill_review
        from notalone.persistence import skill_review_navigation, skill_version_lineage
        from notalone.skills import review
        base = SkillReviewHttpTest
    lifecycle = os.environ.get('NOTALONE_SKILL_LIFECYCLE_PAGE') == '1'
    if lifecycle:
        from tests.integration.server.test_skill_lifecycle import SkillLifecycleHttpTest
        from notalone.persistence import skill_history
        base = SkillLifecycleHttpTest
    feedback = os.environ.get('NOTALONE_SKILL_FEEDBACK_PAGE') == '1'
    if feedback:
        from tests.integration.server.test_skill_feedback import SkillFeedbackHttpTest
        from notalone.persistence import skill_history, skill_policies, skill_execution_view
        base = SkillFeedbackHttpTest

    expected = json.loads(os.environ['NOTALONE_LEARNING_EXPECTED_MODULES'])
    directory = Path(os.environ['NOTALONE_LEARNING_EVIDENCE_DIR']).resolve()
    if (not directory.is_dir() or directory.is_relative_to(ROOT) or directory.stat().st_mode & 0o777 != 0o700):
        raise RuntimeError('学习页面证据须保存到仓库外700目录。')
    proof_path = directory / f'learning-page-{uuid4().hex}.json'

    class PageLearningModel(ControlledLearningModel):
        started_calls: int = 0

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self.started_calls >= 1:
                raise AssertionError("学习页面只允许1次受控模型调用。")
            self.started_calls += 1
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    reply_call_limit = 15 if feedback else 4 if lifecycle else 9

    class PageReplyModel(base.reply_model_factory):
        started_calls: int = 0

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self.started_calls >= reply_call_limit:
                raise AssertionError(f'审核页面只允许{reply_call_limit}次受控回复模型调用。')
            self.started_calls += 1
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    class PageFixture(base):
        extraction_model_factory = PageLearningModel
        reply_model_factory = PageReplyModel

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
        migration_proof = guard_test_migrations(fixture.database_url, fixture.database_name, ROOT,
            expected_count=72, expected_tail='072_scoped_media_lifecycle.sql')
        fixture.setUp()
        if reviewing:
            import psycopg
            with psycopg.connect(fixture.database_url) as connection:
                for identifier, display_name in ((fixture.contact_id, '合成学习甲联系人'),
                                                 (fixture.second_contact_id, '合成学习乙联系人')):
                    connection.execute('UPDATE public.contact SET display_name=%s WHERE owner_id=%s AND id=%s',
                                       (display_name, fixture.owner_id, identifier))
        fixture._bind(fixture.contact_id)
        fixture._bind(fixture.second_contact_id)
        if lifecycle or feedback:
            fixture._get(fixture.backend, f'/api/contacts/{fixture.contact_id}/skill-learning/skills')
        if feedback:
            fixture._get(fixture.backend, f'/api/contacts/{fixture.contact_id}/skill-learning/policies')
        if migrate(fixture.database_url, ROOT / 'backend/database/migrations'):
            raise RuntimeError('学习页面重复正式迁移必须无新增。')
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
            if operation == 'prepare_feedback' and feedback:
                published, source = fixture._publish_two_methods(bind=False)
                result = {**published, 'source_id': str(source)}
            elif operation == 'feedback_reply' and feedback:
                contact = fixture.second_contact_id if command.get('other') else fixture.contact_id
                reply = fixture._reply(contact, command['version_id'], scene=command.get('scene'))
                actual = reply['used_skill']
                result = {'used': actual is not None, 'view': actual.get('execution_view') if actual else None,
                          'excluded_text_present': '合成被排除方法甲' in str(fixture.reply_model.seen_calls[-1])}
            elif operation == 'feedback_observation' and feedback:
                result = {'excluded_text_present': '合成被排除方法甲' in str(fixture.reply_model.seen_calls[-1])}
            elif operation == 'prepare_merge' and lifecycle:
                from uuid import UUID, uuid5
                targets = [fixture._import(name) for name in ('careful-response', 'calm-response')]
                source, message = fixture._source_message()
                methods = [str(uuid5(UUID(value), 'whole_strategy')) for value in targets]
                fixture.extraction_model.responses.append(tool_response('SkillLearningProposal',
                    synthetic_proposal(kind='merge', targets=targets, replaces=methods)))
                _, material = fixture._discussion(target=message)
                result = {'source_id': str(source), 'material_id': material, 'targets': targets}
            elif operation == 'prepare_source':
                source, message = fixture._source_message()
                fixture.extraction_model.responses.append(tool_response('SkillLearningProposal', synthetic_proposal()))
                session, material = fixture._discussion(target=message)
                result = {'source_id': str(source), 'session_path': session, 'material_id': material}
            elif operation == 'restart_backend':
                fixture.backend.close()
                fixture.backend = fixture._production_backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix('http://'), token=fixture.backend.token)
                result = {'state': 'restarted'}
            elif operation == 'observations':
                result = {'model_calls': len(fixture.extraction_model.seen_calls),
                          'reply_calls': len(fixture.reply_model.seen_calls),
                          'skills': fixture._get(fixture.backend, '/api/skills')['skills']}
                if feedback:
                    result['policies'] = fixture._get(fixture.backend, fixture.path + '/policies')
            else:
                raise ValueError('未知学习页面夹具操作。')
            print(json.dumps({'id': command['id'], 'result': result}), flush=True)
    finally:
        active_failure = sys.exc_info()[0] is not None
        if active_failure:
            record_failure()
        cleanup_errors = []
        try:
            guard_modules(ROOT, expected=expected, evidence_path=proof_path, phase='complete')
            proof = json.loads(proof_path.read_text())
            proof.update(migration_proof, database_name=fixture.database_name, child_pid=os.getpid(),
                         model_call_limit=1, reply_call_limit=reply_call_limit, external_model_calls=0,
                         started_calls=fixture.extraction_model.started_calls,
                         reply_started_calls=fixture.reply_model.started_calls,
                         before_import_ownership=json.loads((ownership_path.parent / "import-database-ownership.json").read_text()),
                         core_ownership=json.loads(ownership_path.read_text()),
                         model_calls=len(fixture.extraction_model.seen_calls),
                         migrations=[path.name for path in sorted((ROOT / 'backend/database/migrations').glob('*.sql'))])
            proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        except BaseException as error:
            record_failure()
            cleanup_errors.append(error)
        try:
            cleanup_fixture(fixture)
            if proof_path.exists():
                proof = json.loads(proof_path.read_text())
                proof.update(database_remaining=False, fixture_cleanup_completed=True)
                proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        except BaseException as error:
            record_failure()
            cleanup_errors.append(error)
        if cleanup_errors and not active_failure:
            raise cleanup_errors[0]


if __name__ == '__main__':
    main()
