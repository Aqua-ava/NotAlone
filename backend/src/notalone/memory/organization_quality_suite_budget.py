"""自有合成suite的跨进程物理额度；无正文、预留不退款。"""

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
from uuid import UUID, uuid4

from notalone.memory.organization_quality import content_digest
from notalone.memory.layered import OrganizationBudgetExhausted
from notalone.memory.organization_quality_report import REQUIRED_PHASES, SEMANTIC_DIMENSIONS


SUITE_SCHEMA = 'organization-synthetic-suite-v2'
CURRENT_SUITE_ATTEMPT_LIMIT = 800


class SuiteBudgetError(RuntimeError):
    pass


class SuiteBudgetExhausted(OrganizationBudgetExhausted, SuiteBudgetError):
    pass


def validate_manifest(value: dict) -> dict:
    if (not isinstance(value, dict) or set(value) != {
            'schema_version', 'dataset_version', 'contract_id', 'max_http_attempts', 'fixtures'}
            or value['schema_version'] != SUITE_SCHEMA or not isinstance(value['dataset_version'], str)
            or not 1 <= len(value['dataset_version'].strip()) <= 160
            or type(value['max_http_attempts']) is not int or not 1 <= value['max_http_attempts'] <= CURRENT_SUITE_ATTEMPT_LIMIT
            or not isinstance(value['fixtures'], list) or not 1 <= len(value['fixtures']) <= 240):
        raise SuiteBudgetError('合成suite清单版本、范围或全局额度无效。')
    if not re.fullmatch('[0-9a-f]{64}', value['contract_id']):
        raise SuiteBudgetError('suite合同摘要无效。')
    identities, case_ids, sources, allocation = set(), set(), {}, 0
    for fixture in value['fixtures']:
        fields = {
                'scenario_key', 'dimension', 'scope_kind', 'feedback_mode', 'feedback_layer', 'source_ref',
                'owner_id', 'run_id', 'case_id', 'input_sha256', 'annotation_sha256', 'allocated_attempts'}
        if isinstance(fixture, dict) and fixture.get('feedback_mode') == 'fact_corrected':
            fields.add('fact_error_command')
        if not isinstance(fixture, dict) or set(fixture) != fields:
            raise SuiteBudgetError('suite成员字段无效。')
        if (not isinstance(fixture['scenario_key'], str) or not 1 <= len(fixture['scenario_key']) <= 160
                or fixture['dimension'] not in SEMANTIC_DIMENSIONS or fixture['scope_kind'] not in {'owner', 'contact'}
                or fixture['feedback_mode'] not in {'baseline', 'summary_error', 'fact_corrected'}
                or (fixture['feedback_layer'] is not None if fixture['feedback_mode'] == 'baseline'
                    else fixture['feedback_layer'] not in {'l2', 'l3'})
                or type(fixture['allocated_attempts']) is not int or not 1 <= fixture['allocated_attempts'] <= 750):
            raise SuiteBudgetError('suite成员范围、维度、反馈层或额度无效。')
        if fixture['feedback_mode'] == 'fact_corrected':
            command = fixture['fact_error_command']
            if (not isinstance(command, dict) or set(command) != {'settings_generation', 'organization_generation',
                    'target_kind', 'version_id', 'item_index', 'memory_id'}
                    or any(type(command[key]) is not int or command[key] < 0
                        for key in ('settings_generation', 'organization_generation', 'item_index'))
                    or command['target_kind'] != ('scenario' if fixture['feedback_layer'] == 'l2' else 'profile')):
                raise SuiteBudgetError('事实支线须绑定实际原HTTP命令的无正文身份。')
            for key in ('version_id', 'memory_id'):
                if str(UUID(command[key])) != command[key]:
                    raise SuiteBudgetError('事实命令须使用实际规范UUID。')
        source = fixture['source_ref']
        if (not isinstance(source, dict) or set(source) != {'key', 'database_url_env', 'expected_database'}
                or not re.fullmatch('[A-Za-z0-9_-]{1,120}', source['key'])
                or not re.fullmatch('[A-Z_][A-Z0-9_]{0,119}', source['database_url_env'])
                or not re.fullmatch('[A-Za-z0-9_]{1,58}_test', source['expected_database'])):
            raise SuiteBudgetError('来源仅接受operator环境变量名和明确_test库身份，不接受连接串。')
        if source['key'] in sources and sources[source['key']] != source:
            raise SuiteBudgetError('同一来源key不能重定向到另一环境或数据库。')
        if any(item['expected_database'] == source['expected_database']
                and item['database_url_env'] != source['database_url_env'] for item in sources.values()):
            raise SuiteBudgetError('同名来源库须共用一个明确连接引用，不能用别名建立重复锁连接。')
        sources[source['key']] = source
        for field in ('owner_id', 'run_id', 'case_id'):
            if str(UUID(fixture[field])) != fixture[field]:
                raise SuiteBudgetError('suite成员标识须为规范UUID。')
        for field in ('input_sha256', 'annotation_sha256'):
            if not re.fullmatch('[0-9a-f]{64}', fixture[field]):
                raise SuiteBudgetError('suite成员摘要无效。')
        identity = (source['key'], fixture['owner_id'], fixture['run_id'], fixture['case_id'])
        if identity in identities or fixture['case_id'] in case_ids:
            raise SuiteBudgetError('suite成员不得重复。')
        identities.add(identity)
        case_ids.add(fixture['case_id'])
        allocation += fixture['allocated_attempts']
    if allocation > value['max_http_attempts']:
        raise SuiteBudgetError('所有子运行的预分配之和超过全局物理额度。')
    return value


def atomic_json(path: Path, value: dict) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix='.suite-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def private_json(path: Path) -> dict:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, encoding='utf-8') as stream:
        if os.fstat(stream.fileno()).st_mode & 0o777 != 0o600:
            raise SuiteBudgetError('suite文件必须为0600。')
        return json.load(stream)


class PersistentSuiteBudget:
    def __init__(self, directory: Path):
        self.directory = Path(directory)

    @contextmanager
    def locked(self):
        descriptor = os.open(self.directory / 'suite.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            if os.fstat(descriptor).st_mode & 0o777 != 0o600:
                raise SuiteBudgetError('suite锁文件必须为0600。')
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @classmethod
    def create(cls, directory: Path, manifest: dict):
        validate_manifest(manifest)
        directory = Path(directory)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        result = cls(directory)
        with result.locked():
            path = directory / 'suite.json'
            if path.exists():
                envelope, _ = result.read_locked()
                if envelope['manifest'] != manifest:
                    raise SuiteBudgetError('同一suite目录不能改清单或重置额度。')
            else:
                if (directory / 'physical-attempts.json').exists():
                    raise SuiteBudgetError('suite身份缺失，不能重建或重置已有额度。')
                envelope = {'suite_id': str(uuid4()), 'manifest_sha256': content_digest(manifest), 'manifest': manifest}
                atomic_json(path, envelope)
                atomic_json(directory / 'physical-attempts.json', {
                    'suite_id': envelope['suite_id'], 'manifest_sha256': envelope['manifest_sha256'], 'reservations': []})
        return result

    @classmethod
    def open(cls, directory: Path):
        result = cls(directory)
        with result.locked():
            result.read_locked()
        return result

    def read_locked(self):
        envelope = private_json(self.directory / 'suite.json')
        validate_manifest(envelope['manifest'])
        if envelope['manifest_sha256'] != content_digest(envelope['manifest']):
            raise SuiteBudgetError('suite不可变清单摘要不一致。')
        state = private_json(self.directory / 'physical-attempts.json')
        if (state['suite_id'] != envelope['suite_id'] or state['manifest_sha256'] != envelope['manifest_sha256']
                or not isinstance(state['reservations'], list)):
            raise SuiteBudgetError('物理额度身份不一致，不能恢复为零。')
        return envelope, state

    def reserve(self, *, source_ref: str, owner_id, run_id, case_id, phase: str) -> str:
        identity = (source_ref, str(owner_id), str(run_id), str(case_id))
        if phase not in REQUIRED_PHASES:
            raise SuiteBudgetError('物理调用阶段不属于已批准的有限流程。')
        with self.locked():
            envelope, state = self.read_locked()
            fixtures = envelope['manifest']['fixtures']
            matching = [fixture for fixture in fixtures if (
                fixture['source_ref']['key'], fixture['owner_id'], fixture['run_id'], fixture['case_id']) == identity]
            if len(matching) != 1:
                raise SuiteBudgetError('物理请求不属于已固定的suite子运行。')
            reservations = state['reservations']
            child_used = sum((row['source_ref'], row['owner_id'], row['run_id'], row['case_id']) == identity for row in reservations)
            if (len(reservations) >= envelope['manifest']['max_http_attempts']
                    or child_used >= matching[0]['allocated_attempts']):
                raise SuiteBudgetExhausted('suite或当前子运行的持久物理额度已耗尽。')
            from notalone.experiments.problem_budget import reserve_problem_attempt
            reserve_problem_attempt()
            identifier = str(uuid4())
            reservations.append({'id': identifier, 'ordinal': len(reservations) + 1, 'source_ref': source_ref,
                                 'owner_id': str(owner_id), 'run_id': str(run_id), 'case_id': str(case_id),
                                 'phase': phase, 'outcome': 'reserved', 'result': None})
            atomic_json(self.directory / 'physical-attempts.json', state)
            return identifier

    def finish(self, identifier: str, *, outcome: str, request_model=None, response_model=None,
               system_fingerprint=None, duration_ms=None, request_route=None) -> None:
        if outcome not in {'succeeded', 'failed', 'unknown'}:
            raise SuiteBudgetError('物理回执状态无效。')
        if any(value is not None and (not isinstance(value, str) or len(value) > 300)
               for value in (request_model, response_model, system_fingerprint, request_route)):
            raise SuiteBudgetError('物理回执仅保留有限无正文模型身份。')
        if duration_ms is not None and (type(duration_ms) is not int or duration_ms < 0):
            raise SuiteBudgetError('物理回执耗时无效。')
        result = {'request_model': request_model, 'response_model': response_model,
                  'system_fingerprint': system_fingerprint, 'duration_ms': duration_ms, 'request_route': request_route}
        with self.locked():
            _, state = self.read_locked()
            matches = [row for row in state['reservations'] if row['id'] == identifier]
            if len(matches) != 1:
                raise SuiteBudgetError('物理回执没有唯一先行预留。')
            row = matches[0]
            if row['outcome'] != 'reserved':
                if row['outcome'] == outcome and row['result'] == result:
                    return
                raise SuiteBudgetError('既有物理回执不能改写或退款。')
            row.update({'outcome': outcome, 'result': result})
            atomic_json(self.directory / 'physical-attempts.json', state)

    def snapshot(self) -> dict:
        with self.locked():
            envelope, state = self.read_locked()
            return {**envelope, **state, 'used_attempts': len(state['reservations']),
                    'remaining_attempts': envelope['manifest']['max_http_attempts'] - len(state['reservations'])}
