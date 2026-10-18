"""合成suite的文件与PostgreSQL适配；只向业务提供无正文回执。"""
from contextlib import ExitStack, contextmanager
import os
import time
from pathlib import Path
from uuid import UUID

from notalone.memory.organization_quality import content_digest
from notalone.memory.organization_quality_suite import (
    build_suite_report, contract_identity, feedback_snapshot_matches, suite_receipt, fact_correction_matches,
)
from notalone.memory.organization_quality_suite_budget import (
    PersistentSuiteBudget, SuiteBudgetError, atomic_json, private_json,
)

def _source_connection(source, *, connect_timeout=5):
    import psycopg
    from psycopg.rows import dict_row
    database_url = os.environ.get(source['database_url_env'])
    if not database_url:
        raise SuiteBudgetError('operator指定的合成源环境变量不可用。')
    connection = psycopg.connect(database_url, connect_timeout=connect_timeout, row_factory=dict_row)
    if connection.info.dbname != source['expected_database'] or not connection.info.dbname.endswith('_test'):
        connection.close()
        raise SuiteBudgetError('实际来源数据库与明确_test身份不一致。')
    return connection, database_url


def _store(database_url):
    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
    from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
    return PostgresOrganizationQualityStore(PostgresLayeredMemoryStore(database_url))


class SyntheticSuiteReader:
    """来源引用只从operator的私有清单加载，普通产品HTTP不接收它。"""

    def __init__(self, directory: Path):
        self.budget = PersistentSuiteBudget.open(directory)
        self.directory = Path(directory)

    def _read_member(self, fixture, connection=None, store=None):
        if connection is None:
            from notalone.persistence.locks import lock_owner_scope
            checked, database_url = _source_connection(fixture['source_ref'])
            with checked:
                checked.execute("SET LOCAL lock_timeout='2s'")
                checked.execute("SET LOCAL statement_timeout='5s'")
                lock_owner_scope(checked, owner_id=UUID(fixture['owner_id']))
                return self._read_member(fixture, checked, _store(database_url))
        method = getattr(store, 'report_rows_in_transaction', None)
        if method is None:
            raise SuiteBudgetError('来源仓储尚无同连接复验合同，不能held发布。')
        return method(connection, UUID(fixture['owner_id']), UUID(fixture['run_id']))

    def _report(self, contract, snapshot, *, connections=None, expires_at=None):
        manifest = snapshot['manifest']
        current_id = contract_identity(contract)
        cases, attempts, members, errors, runs = [], [], [], [], []
        for fixture in manifest['fixtures']:
            try:
                if expires_at is not None and time.monotonic() >= expires_at:
                    raise SuiteBudgetError('完整来源复验超过有限读取期限。')
                context = connections.get(fixture['source_ref']['key']) if connections is not None else None
                if isinstance(context, Exception):
                    raise context
                if context is not None and expires_at is not None:
                    context[0].execute("SELECT set_config('statement_timeout',%s,true)",
                        (str(max(1, min(5000, int((expires_at-time.monotonic())*1000)))),))
                run, source_cases, source_attempts = self._read_member(fixture, *(context or ()))
                selected = [row for row in source_cases if str(row['id']) == fixture['case_id']]
                if len(selected) != 1 or len(source_cases) != 1:
                    raise SuiteBudgetError('子运行必须保持唯一已固定实际case。')
                case = selected[0]
                if (str(run['id']) != fixture['run_id'] or str(case['owner_id']) != fixture['owner_id']
                        or run['contract_id'] != manifest['contract_id'] or case['contract_id'] != manifest['contract_id']
                        or run['max_http_attempts'] != fixture['allocated_attempts']
                        or case['input_sha256'] != fixture['input_sha256']
                        or content_digest(case['annotations']) != fixture['annotation_sha256']
                        or ('owner' if case['contact_id'] is None else 'contact') != fixture['scope_kind']):
                    raise SuiteBudgetError('成员合同、范围、固定版本或标注摘要已变化。')
                annotation = case['annotations'] or {}
                if annotation.get('scenario_key') != fixture['scenario_key'] or annotation.get('dimension') != fixture['dimension']:
                    errors.append({'case_id': fixture['case_id'], 'reason': 'fixture_annotation_identity_missing'})
                if not feedback_snapshot_matches(fixture, case):
                    errors.append({'case_id': fixture['case_id'], 'reason': 'fixture_feedback_snapshot_mismatch'})
                if fixture['feedback_mode'] == 'fact_corrected' and not fact_correction_matches(fixture, case):
                    errors.append({'case_id': fixture['case_id'], 'reason': 'fact_correction_path_unproven'})
                if fixture['feedback_mode'] == 'summary_error':
                    output = case['output_payload'] or {}
                    items = (output.get('l3', {}).get('entries', []) if fixture['feedback_layer'] == 'l3' else
                             [paragraph for scenario in output.get('l2', {}).get('scenarios', [])
                              for paragraph in scenario.get('paragraphs', [])])
                    if not any(isinstance(item, dict) and isinstance(item.get('text'), str)
                               and item['text'].strip() for item in items):
                        errors.append({'case_id': fixture['case_id'], 'reason': 'feedback_output_missing'})
                cases.append(case)
                runs.append(run)
                attempts.extend(source_attempts)
                members.append({'source_ref': fixture['source_ref']['key'], 'owner_id': fixture['owner_id'],
                    'run_id': fixture['run_id'], 'case_id': fixture['case_id'],
                    'input_sha256': case['input_sha256'], 'annotation_sha256': content_digest(case['annotations']),
                    'case_evidence_sha256': content_digest(dict(case)),
                    'attempts_sha256': content_digest([dict(attempt) for attempt in source_attempts]),
                    'run_evidence_sha256': content_digest({key: run[key] for key in (
                        'id', 'contract_id', 'state', 'transport_kind', 'input_review_frozen',
                        'input_review_sha256', 'http_attempts_used', 'max_http_attempts')})})
            except Exception:
                errors.append({'case_id': fixture['case_id'], 'reason': 'suite_member_unavailable'})
        member_hash = content_digest(members)
        calibration = None
        calibration_path = self.directory / 'calibration.json'
        if calibration_path.exists():
            candidate = private_json(calibration_path)
            if (candidate.get('suite_id') == snapshot['suite_id']
                    and candidate.get('manifest_sha256') == snapshot['manifest_sha256']
                    and candidate.get('member_evidence_sha256') == member_hash
                    and candidate.get('contract_id') == current_id):
                calibration = candidate
        return build_suite_report(contract, snapshot, cases=cases, attempts=attempts,
            members=members, errors=errors, runs=runs, calibration=calibration)

    def report(self, contract):
        with self.budget.locked(), ExitStack() as stack:
            envelope, state = self.budget.read_locked()
            expires_at = time.monotonic() + 20
            return self._report(contract, {**envelope, **state},
                connections=self._connections(envelope, stack, expires_at), expires_at=expires_at)

    def validate_target(self, database_url):
        """业务目标与所有合成源明确分离，避免目标事务反向等待自身源锁。"""
        import psycopg
        snapshot = self.budget.snapshot()
        sources = {fixture['source_ref']['key']: fixture['source_ref'] for fixture in snapshot['manifest']['fixtures']}
        with psycopg.connect(database_url, connect_timeout=5) as target:
            if target.info.dbname in {source['expected_database'] for source in sources.values()}:
                raise SuiteBudgetError('业务目标数据库不能与任一合成资格来源同名。')

    def resolve(self, contract, connection=None):
        try:
            report = self.report(contract)
            return {'stage': report['organization'], 'receipt': suite_receipt(report), 'model_identities': report['model_identities']}
        except Exception:
            return {'stage': {'status': 'unknown', 'reasons': ['suite_unavailable'],
                              'contract_id': contract_identity(contract), 'report_id': None},
                    'receipt': None, 'model_identities': []}

    def calibrate(self, contract, payload):
        from notalone.memory.organization_quality_review import reviewer, decision
        expected = {'suite_id', 'manifest_sha256', 'member_evidence_sha256', 'contract_id',
                    'reviewer', 'decision', 'notes'}
        if not isinstance(payload, dict) or set(payload) != expected:
            raise SuiteBudgetError('全局标定须绑定suite、全部成员摘要、实际合同及审阅者。')
        reviewer(payload['reviewer'])
        decision(payload['decision'])
        if not isinstance(payload['notes'], str) or not 1 <= len(payload['notes'].strip()) <= 4000:
            raise SuiteBudgetError('全局标定必须保留有限具体观察。')
        with self.budget.locked(), ExitStack() as stack:
            envelope, state = self.budget.read_locked()
            expires_at = time.monotonic() + 20
            report = self._report(contract, {**envelope, **state},
                connections=self._connections(envelope, stack, expires_at), expires_at=expires_at)
            if (report['state'] != 'complete' or report['member_errors']
                    or any(payload[key] != report[key] for key in ('suite_id', 'manifest_sha256', 'member_evidence_sha256'))
                    or payload['contract_id'] != contract_identity(contract)):
                raise SuiteBudgetError('标定与完整live成员或当前合同不一致。')
            atomic_json(self.directory / 'calibration.json', payload)

    @contextmanager
    def hold(self, contract, snapshot):
        with self.budget.locked(), ExitStack() as stack:
            envelope, state = self.budget.read_locked()
            expires_at = time.monotonic() + 20
            connections = self._connections(envelope, stack, expires_at)
            report = self._report(contract, {**envelope, **state}, connections=connections, expires_at=expires_at)
            expected = suite_receipt(report)
            receipt = snapshot.get('receipt') if isinstance(snapshot, dict) else None
            if report['organization']['status'] != 'verified' or receipt != expected:
                raise SuiteBudgetError('持锁重验未获完整同回执资格，不能发布。')
            yield {'stage': report['organization'], 'receipt': expected, 'model_identities': report['model_identities']}

    def _connections(self, envelope, stack, expires_at):
        """同一来源仅连接一次并按owner稳定持锁，故障不按126成员重复等待。"""
        from notalone.persistence.locks import lock_owner_scope
        sources = {fixture['source_ref']['key']: fixture['source_ref'] for fixture in envelope['manifest']['fixtures']}
        groups = {}
        for key, source in sources.items():
            identity = (source['expected_database'], os.environ.get(source['database_url_env']))
            groups.setdefault(identity, []).append(key)
        connections = {}
        for _, keys in sorted(groups.items(), key=lambda group: group[0][0]):
            try:
                if time.monotonic() >= expires_at:
                    raise SuiteBudgetError('来源连接超过有限读取期限。')
                connection, database_url = _source_connection(sources[keys[0]],
                    connect_timeout=max(1, min(5, int(expires_at-time.monotonic()))))
                stack.enter_context(connection)
                connection.execute("SET LOCAL lock_timeout='2s'")
                connection.execute("SET LOCAL statement_timeout='5s'")
                store = _store(database_url)
                if not hasattr(store, 'report_rows_in_transaction'):
                    raise SuiteBudgetError('来源不支持持锁重验，资格不能发布。')
                owners = sorted({fixture['owner_id'] for fixture in envelope['manifest']['fixtures']
                                 if fixture['source_ref']['key'] in keys})
                for owner_id in owners:
                    if time.monotonic() >= expires_at:
                        raise SuiteBudgetError('来源owner锁超过有限读取期限。')
                    lock_owner_scope(connection, owner_id=UUID(owner_id))
                for key in keys:
                    connections[key] = (connection, store)
            except Exception as error:
                for key in keys:
                    connections[key] = error
        return connections
