"""operator固定的回复比较来源；逐次重读真实证据和原物理账本。"""
from pathlib import Path
import json
import sqlite3
from uuid import UUID

from notalone.memory.organization_quality_suite_budget import private_json
from notalone.reply.quality import comparison_report


class ReplyComparisonSource:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.organization_source = None
        self.organization_contract = None
        if not self.directory.is_absolute():
            raise ValueError('回复质量来源须使用明确绝对路径。')

    def bind_organization(self, source, contract):
        self.organization_source, self.organization_contract = source, contract

    def resolve(self, contract, *, connection=None):
        try:
            path = self.directory / 'bundle.json'
            if path.stat().st_size > 16 * 1024 * 1024:
                raise ValueError('回复比较证据超过有限大小。')
            bundle = private_json(path)
            result = comparison_report(bundle, contract)
            if 'reply_contract_changed' in result['stage']['reasons']:
                return result
            self._validate_ledger(bundle)
            if result['stage']['status'] == 'verified':
                try:
                    self._validate_original_sources(bundle)
                except Exception:
                    return {**result, 'stage': {**result['stage'], 'status': 'unknown',
                            'reasons': ['reply_original_sources_changed']}, 'receipt': None}
            return result
        except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            return {'stage': {'status': 'unknown', 'reasons': ['reply_qualification_source_unavailable'],
                    'contract_id': contract.identity, 'report_id': None}, 'receipt': None, 'model_identities': []}

    def read_evidence_receipt(self, contract):
        """已持有原来源锁的writer只复验文件/账本，不重入来源PG锁。"""
        try:
            bundle = private_json(self.directory / 'bundle.json')
            report = comparison_report(bundle, contract)
            self._validate_ledger(bundle)
            return report['receipt'] if report['stage']['status'] == 'verified' else None
        except Exception:
            return None

    def _validate_original_sources(self, bundle):
        """正式正例绑定活的整理来源及每例原输入，不把文件当永久授权。"""
        from notalone.application.organization_quality_suite import SyntheticSuiteReader
        source, contract = self.organization_source, self.organization_contract
        if source is None or contract is None:
            raise ValueError('缺少已绑定的实时整理来源。')
        current = source.resolve(contract)
        manifest = bundle['manifest']
        if (current['stage']['status'] != 'verified' or not current.get('receipt')
                or current['receipt'] != manifest.get('organization_qualification_receipt')):
            raise ValueError('原整理资格回执已经变化。')
        report = SyntheticSuiteReader(source.directory).report(contract)
        members = {row['case_id']: row for row in report['members']}
        outputs = {row['case_id']: row for row in report['cases']}
        reply_cases = {row['case_id']: row for row in manifest['cases']}
        dependencies = manifest.get('organization_dependencies', [])
        if (len(dependencies) != len(manifest['cases'])
                or len({row['case_id'] for row in dependencies}) != len(dependencies)
                or {row['reply_case_id'] for row in dependencies} != {row['case_id'] for row in manifest['cases']}):
            raise ValueError('回复案例未完整绑定原整理输入。')
        for row in dependencies:
            actual = members.get(row['case_id'])
            if actual is None or any(row.get(key) != actual[key]
                    for key in ('input_sha256', 'case_evidence_sha256')):
                raise ValueError('原整理case输入、版本或输出已变化。')
            # 原case回执与回复所装候选须属于同一实际输出，不能借另一已过case背书。
            reply_case = reply_cases[row['reply_case_id']]
            if outputs[row['case_id']]['output_sha256'] != reply_case.get('organization_output_sha256'):
                raise ValueError('回复安装候选不属于原获审整理输出。')

    def _validate_ledger(self, bundle):
        receipt = bundle['budget_receipt']
        run_id = str(UUID(receipt['run_id']))
        root = Path.home() / '.notalone-memory-evaluations' / run_id
        for path in (root / 'budget.sqlite3', root / 'closed'):
            if path.is_symlink() or path.stat().st_mode & 0o777 != 0o600:
                raise ValueError('回复物理账本身份不安全。')
        with sqlite3.connect(f'file:{root / "budget.sqlite3"}?mode=ro', uri=True) as db:
            state = db.execute('SELECT manifest,closed FROM state').fetchall()
            attempts = db.execute('SELECT sequence,endpoint FROM requests ORDER BY sequence').fetchall()
        manifest = {key: value for key, value in receipt.items() if key not in {'closed', 'reserved_requests'}}
        if (state != [(json.dumps(manifest, sort_keys=True), 1)]
                or len(attempts) != receipt['reserved_requests']
                or Path(manifest['output_directory']).resolve() != self.directory.resolve()
                or attempts != [(c['sequence'], c['request_route']) for c in bundle['calls']]):
            raise ValueError('回复捕获与原关闭账本不一致。')


class ReplyReadConfiguration:
    """两侧预算与独立证据目录只由operator配置。"""
    def __init__(self, value):
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        if not isinstance(value, dict) or set(value) != {'directory', 'contact_budget', 'owner_budget'}:
            raise ValueError('回复读取配置结构无效。')
        self.source = ReplyComparisonSource(value['directory'])
        def budget(payload):
            if payload is None:
                return None
            payload = dict(payload)
            if payload.get('scenario_read') is not None:
                payload['scenario_read'] = ScenarioReadBudget(**payload['scenario_read'])
            return LayeredReplyBudget(**payload)
        self.contact_budget, self.owner_budget = budget(value['contact_budget']), budget(value['owner_budget'])
