"""可信固定合成来源只向业务库返回无正文资格摘要；不可由HTTP上传verified。"""

from uuid import UUID
import psycopg

from notalone.memory.organization_quality import content_digest
from notalone.memory.organization_quality_report import build_quality_report
from notalone.memory.layered import LayeredMemoryConflict
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.persistence.organization_quality import PostgresOrganizationQualityStore


class PostgresOrganizationQualificationSource:
    def __init__(self, *, database_url, expected_database, owner_id, run_id):
        if not isinstance(expected_database, str) or not expected_database.endswith('_test'):
            raise ValueError('质量来源必须固定为明确归属的合成测试库。')
        self._database_url = database_url
        self._expected_database = expected_database
        self._owner_id, self._run_id = UUID(str(owner_id)), UUID(str(run_id))

    def resolve(self, contract, *, connection=None):
        unknown = {'stage': {'status': 'unknown', 'reasons': ['qualification_source_unavailable'],
                    'contract_id': contract.identity, 'report_id': str(self._run_id)},
                   'receipt': None, 'model_identities': []}
        try:
            with psycopg.connect(self._database_url, connect_timeout=2) as source_connection:
                if source_connection.info.dbname != self._expected_database:
                    return unknown
            store = PostgresOrganizationQualityStore(PostgresLayeredMemoryStore(self._database_url))
            run, cases, attempts = store.report_rows(self._owner_id, self._run_id)
            return self._summary(contract, run, cases, attempts)
        except (psycopg.Error, LookupError, LayeredMemoryConflict):
            return unknown

    @staticmethod
    def _summary(contract, run, cases, attempts):
        report = build_quality_report(run, cases, attempts, contract.identity)
        receipt = content_digest({'report_id': report['report_id'], 'contract_id': report['contract_id'],
            'dataset_sha256': report['dataset_sha256'], 'input_review_sha256': report['input_review_sha256'],
            'calibration': report['calibration'], 'stage': report['organization'],
            'outputs': [content_digest({'output': case['output'], 'review': case['output_review']}) for case in report['cases']]})
        identities = [{key: a[key] for key in ('phase', 'request_model', 'response_model', 'system_fingerprint', 'request_route')} for a in report['attempts']]
        return {'stage': report['organization'], 'receipt': receipt,
                'model_identities': identities}

    def hold(self, contract, snapshot):
        from contextlib import contextmanager
        from psycopg.rows import dict_row
        from notalone.persistence.locks import lock_owner_scope
        @contextmanager
        def held():
            with psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=2) as connection:
                if connection.info.dbname != self._expected_database:
                    raise LayeredMemoryConflict('资格来源库身份已变化。')
                connection.execute("SET LOCAL lock_timeout='2s'")
                connection.execute("SET LOCAL statement_timeout='5s'")
                lock_owner_scope(connection, owner_id=self._owner_id)
                store = PostgresOrganizationQualityStore(PostgresLayeredMemoryStore(self._database_url))
                current = self._summary(contract, *store.report_rows_in_transaction(connection, self._owner_id, self._run_id))
                if current['stage']['status'] != 'verified' or current['receipt'] != snapshot['receipt']:
                    raise LayeredMemoryConflict('来源报告已失效，旧结果不能提交。')
                yield
        return held()

    def validate_target(self, database_url):
        with psycopg.connect(database_url, connect_timeout=2) as connection:
            if connection.info.dbname == self._expected_database:
                raise ValueError('业务目标库须与固定合成资格来源库隔离，避免来源与writer重入同一范围锁。')
