"""整理与回复读取的独立质量身份；未知证据不能签发资格。"""

from dataclasses import dataclass, field
from contextvars import ContextVar
import hashlib
import json

from notalone.memory.layered import OrganizationBudget, LayeredMemoryConflict

FACT_PREPARATION_DATASET_VERSION = 'fact-correction-path-preparation-v1'


def content_digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(',', ':'), default=str).encode()).hexdigest()


def _source_identity(names):
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    paths = [root / name for name in names]
    return content_digest({str(path.relative_to(root)): content_digest(path.read_text())
                           for path in sorted(set(paths)) if path.is_file()})


def organization_rules_identity():
    """明确整理语义依赖；同文件内纯回复capture/read改动不废弃整理结论。"""
    import ast
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    names = {
        'application/layered_memory_service.py': {'run_batch', '_organize_profile', '_call', '_model_memories', '_model_scenarios', '_correction_arguments', '_organization_available', '_publication_guard'},
        'application/organization_runtime.py': {'ConfiguredSuiteSource'},
        'memory/organization_quality.py': {'qualification', 'snapshot', 'validate_qualification', 'publication_guard', 'check_response_identity'},
        'persistence/layered_memory.py': {'transaction', 'eligible', '_manifest', 'prepare', '_input', '_check', 'publish', 'reserve_model_call', 'organization_context_inputs'},
        'persistence/layered_profile.py': {'prepare_profile', 'profile_input_entries', '_check_profile', 'publish_profile'},
        'memory/layered.py': {'OrganizationBudget', 'OrganizationInput', 'ScenarioProposalPort', 'ScenarioVerificationPort', 'ProfileProposalPort', 'ProfileVerificationPort'},
    }
    values = {}
    for name, selected in names.items():
        tree = ast.parse((root / name).read_text())
        values[name] = [ast.dump(node, include_attributes=False) for node in ast.walk(tree)
                        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in selected]
    for name in ('application/organization_call.py', 'memory/owner_organization_input.py',
                 'memory/scenario_validation.py', 'memory/scenario_publication.py', 'memory/profile_validation.py', 'memory/organization_isolation.py',
                 'persistence/layered_coverage.py', 'persistence/layered_corrections.py',
                 'memory/layered_correction_validation.py', 'memory/personal_background.py', 'memory/personal_organization.py'):
        path = root / name
        values[name] = ast.dump(ast.parse(path.read_text()), include_attributes=False) if path.exists() else 'not_installed'
    return content_digest(values)


def organization_prompt_identity():
    from notalone.memory.organization_sdk import (POLICY, SCENARIO_PROMPT, CORRECTED_SCENARIO_PROMPT,
        PROFILE_PROMPT, VERIFICATION_PROMPT, PROFILE_VERIFICATION_PROMPT, SCENARIO_ITEM_VERIFICATION_PROMPT)
    from notalone.memory import personal_organization
    return content_digest([personal_organization.POLICY, personal_organization.SCENARIO_PROMPT, personal_organization.PROFILE_PROMPT, personal_organization.VERIFICATION_PROMPT, POLICY, SCENARIO_PROMPT, CORRECTED_SCENARIO_PROMPT,
        PROFILE_PROMPT, VERIFICATION_PROMPT, PROFILE_VERIFICATION_PROMPT, SCENARIO_ITEM_VERIFICATION_PROMPT])


def organization_evaluation_identity():
    return _source_identity(['application/organization_evaluation.py', 'memory/organization_quality_report.py',
        'memory/organization_quality_review.py', 'memory/organization_quality_transport.py', 'memory/organization_sdk.py', 'memory/organization_verification.py', 'memory/personal_organization.py', 'memory/personal_background.py',
        'memory/organization_quality_suite.py', 'application/organization_quality_suite.py', 'memory/organization_quality_suite_budget.py', 'persistence/organization_quality.py'])


@dataclass(frozen=True, slots=True)
class OrganizationQualityContract:
    provider: str = 'unconfigured'
    request_model: str = 'unconfigured'
    verifier_provider: str = 'unconfigured'
    verifier_model: str = 'unconfigured'
    rules_version: str = field(default_factory=organization_rules_identity)
    prompt_version: str = field(default_factory=organization_prompt_identity)
    schema_version: str = field(default_factory=lambda: _source_identity(['memory/scenario_validation.py', 'memory/profile_validation.py', 'memory/organization_verification.py', 'memory/personal_background.py', 'memory/personal_organization.py']))
    purpose_version: str = 'layered-background-v1'
    input_projection_version: str = 'scope-projection-correction-v3'
    evaluation_version: str = field(default_factory=organization_evaluation_identity)
    budget: OrganizationBudget = field(default_factory=lambda: OrganizationBudget(max_model_calls=4))

    def to_payload(self) -> dict:
        return {name: (value.to_payload() if name == 'budget' else value)
                for name in self.__dataclass_fields__ if (value := getattr(self, name)) is not None}

    @property
    def identity(self) -> str:
        return content_digest(self.to_payload())


@dataclass(frozen=True, slots=True)
class ReplyQualityContract:
    """回复读取预算单独变更，不改变整理质量身份。"""
    model_version: str = 'unconfigured'
    rules_version: str = 'layered-reply-v1'
    schema_version: str = 'layered-read-v1'
    purpose_version: str = 'layered-background-v1'
    budget_version: str = 'uncalibrated'
    evaluation_version: str = 'reply-comparison-v1'

    def to_payload(self) -> dict:
        return {name: getattr(self, name) for name in self.__dataclass_fields__}

    @property
    def identity(self) -> str:
        return content_digest(self.to_payload())


class OrganizationQualityService:
    def __init__(self, store=None, *, organization_contract=None, reply_contract=None, evaluation_runtime=None, qualification_source=None, runtime_unavailable_reason=None):
        self._store = store
        self.evaluation_runtime = evaluation_runtime
        self.qualification_source = qualification_source
        self.runtime_unavailable_reason = runtime_unavailable_reason
        self.organization_contract = organization_contract or OrganizationQualityContract()
        self.reply_contract = reply_contract or ReplyQualityContract()
        self.reply_source = None
        self._reply_revocations = set()
        self._reading_hold = ContextVar('reply_qualification_hold', default=None)
        if qualification_source is not None and store is not None:
            qualification_source.validate_target(store._layered._database_url)

    def report(self, owner_id, run_id=None, *, connection=None):
        from notalone.memory.organization_quality_report import build_quality_report
        rows = (self._store.report_rows_in_transaction(connection, owner_id, run_id) if connection is not None
                else self._store.report_rows(owner_id, run_id))
        return build_quality_report(*rows, self.organization_contract.identity)

    def create_run(self, owner_id, payload):
        if (not isinstance(payload, dict) or set(payload) != {'case_ids', 'max_http_attempts', 'dataset_version', 'data_kind', 'purpose_confirmed'}
                or payload['purpose_confirmed'] is not True):
            raise ValueError('评测用途及有限合成范围须明确确认。')
        identifier = self._store.create_run(owner_id, payload['case_ids'], self.organization_contract,
            max_http_attempts=payload['max_http_attempts'], dataset_version=payload['dataset_version'], data_kind=payload['data_kind'])
        return self.report(owner_id, identifier)

    def execute(self, owner_id, run_id, payload):
        if not isinstance(payload, dict) or set(payload) != {'allow_unreviewed_smoke'} or type(payload['allow_unreviewed_smoke']) is not bool:
            raise ValueError('须明确区分人工冻结评测与未审工程冒烟。')
        if self.evaluation_runtime is None:
            raise RuntimeError('未装配实际候选或显式受控评测Adapter。')
        self.evaluation_runtime.execute_next(self._store, owner_id, run_id, self.organization_contract,
                                            allow_unreviewed_smoke=payload['allow_unreviewed_smoke'])
        return self.report(owner_id, run_id)

    def qualification(self, owner_id, *, connection=None):
        if self.runtime_unavailable_reason is not None:
            return {'stage': {'status': 'unknown', 'reasons': [self.runtime_unavailable_reason],
                'contract_id': self.organization_contract.identity, 'report_id': None}, 'receipt': None, 'model_identities': []}
        if self.qualification_source is not None:
            return self._apply_revocation(owner_id, self.qualification_source.resolve(self.organization_contract, connection=connection), connection=connection)
        try:
            report = self.report(owner_id, connection=connection)
        except (LookupError, LayeredMemoryConflict):
            return {'stage': {'status': 'unknown', 'reasons': ['no_evaluation_report'],
                             'contract_id': self.organization_contract.identity, 'report_id': None},
                    'receipt': None, 'model_identities': []}
        return self._apply_revocation(owner_id, {'stage': report['organization'],
                'receipt': content_digest({'contract': report['contract_id'], 'dataset': report['dataset_sha256'],
                    'input_review': report['input_review_sha256'], 'calibration': report['calibration'],
                    'outputs': [content_digest({'output': c['output'], 'review': c['output_review']}) for c in report['cases']]}),
                'model_identities': [{key: a[key] for key in ('phase', 'request_model', 'response_model', 'system_fingerprint', 'request_route')} for a in report['attempts']]}, connection=connection)

    def _apply_revocation(self, owner_id, result, *, connection=None):
        if self._store is not None and result['receipt']:
            reason = self._store.revocation(owner_id, self.organization_contract.identity, result['receipt'], connection=connection)
            if reason:
                return {**result, 'stage': {**result['stage'], 'status': 'unknown', 'reasons': [reason]}}
        return result

    def snapshot(self, owner_id, *, connection=None):
        result = self.qualification(owner_id, connection=connection)
        if result['stage']['status'] != 'verified' or result['stage']['contract_id'] != self.organization_contract.identity or not result['receipt']:
            raise LayeredMemoryConflict('实际整理合同尚无完整有效资格。')
        return result

    def validate_qualification(self, owner_id, snapshot, *, connection=None):
        current = self.snapshot(owner_id, connection=connection)
        if current['receipt'] != snapshot['receipt']:
            raise LayeredMemoryConflict('质量报告或人工支持决定已失效。')

    def publication_guard(self, owner_id, snapshot):
        from contextlib import contextmanager
        @contextmanager
        def held():
            if self.qualification_source is not None:
                with self.qualification_source.hold(self.organization_contract, snapshot):
                    def local_guard(connection):
                        if self._store.revocation(owner_id, self.organization_contract.identity, snapshot['receipt'], connection=connection):
                            raise LayeredMemoryConflict('本机实际模型身份已撤销该资格回执。')
                    yield local_guard
            else:
                yield lambda connection: self.validate_qualification(owner_id, snapshot, connection=connection)
        return held()

    def check_response_identity(self, owner_id, snapshot, phase, request, response, request_route):
        identity = {'phase': phase, 'request_model': request.get('model'), 'response_model': response.get('model'),
                    'system_fingerprint': response.get('system_fingerprint'), 'request_route': request_route}
        if not any(all(item.get(key) == value for key, value in identity.items()) for item in snapshot['model_identities']):
            self._store.revoke(owner_id, self.organization_contract.identity, snapshot['receipt'], 'candidate_model_changed')
            raise LayeredMemoryConflict('实际响应模型身份已变化，旧质量资格失效。')

    def configure_reply(self, contract, source):
        """只装配独立读取合同与operator来源，不改整理合同。"""
        self.reply_contract, self.reply_source = contract, source

    def reply_qualification(self, owner_id, *, connection=None):
        missing = {'stage': {'status': 'unknown', 'reasons': ['no_reply_evaluation_report'],
            'contract_id': self.reply_contract.identity, 'report_id': None}, 'receipt': None, 'model_identities': []}
        if self.reply_source is None:
            return missing
        try:
            result = self.reply_source.resolve(self.reply_contract, connection=connection)
            if (result['stage']['contract_id'] != self.reply_contract.identity
                    or not result.get('receipt')):
                return missing
            revoked = (self._store.revocation(owner_id, self.reply_contract.identity, result['receipt'], connection=connection)
                       if self._store is not None else None)
            if revoked or (str(owner_id), result['receipt']) in self._reply_revocations:
                return {**result, 'stage': {**result['stage'], 'status': 'unknown',
                        'reasons': ['reply_candidate_model_changed']}}
            return result
        except Exception:
            return missing

    def reading_receipt(self, owner_id, *, connection=None):
        held = self._reading_hold.get()
        if held is not None and held['owner_id'] == owner_id:
            refresh = getattr(self.reply_source, 'read_evidence_receipt', None)
            if refresh is not None and refresh(self.reply_contract) != held['reply_receipt']:
                return None
            if connection is not None:
                held['guard'](connection)
                if self._store is not None and self._store.revocation(owner_id,
                        self.reply_contract.identity, held['reply_receipt'], connection=connection):
                    return None
            return held['receipt']
        organization, reply = self.qualification(owner_id), self.reply_qualification(owner_id)
        if (organization['stage']['status'] != 'verified' or reply['stage']['status'] != 'verified'
                or not organization.get('receipt') or not reply.get('receipt')):
            return None
        return content_digest({'organization_contract': self.organization_contract.identity,
            'organization': organization['receipt'], 'reply_contract': self.reply_contract.identity,
            'reply': reply['receipt']})

    def reading_guard(self, owner_id, receipt):
        """正式writer复用整理来源锁直至业务事务提交，避免删除跨库竞态。"""
        from contextlib import contextmanager, nullcontext
        @contextmanager
        def held():
            if receipt != self.reading_receipt(owner_id) or receipt is None:
                raise LayeredMemoryConflict('读取质量回执已经失效。')
            organization, reply = self.snapshot(owner_id), self.reply_qualification(owner_id)
            guarded = (self.publication_guard(owner_id, organization)
                if self._store is not None else nullcontext(lambda connection: None))
            with guarded as local_guard:
                token = self._reading_hold.set({'owner_id': owner_id, 'receipt': receipt,
                    'reply_receipt': reply['receipt'], 'guard': local_guard})
                try:
                    yield
                finally:
                    self._reading_hold.reset(token)
        return held()

    def check_reply_identity(self, owner_id, model, message):
        result = self.reply_qualification(owner_id)
        metadata = message.response_metadata or {}
        identity = {'request_model': model.model_name,
            'response_model': metadata.get('model_name') or metadata.get('model'),
            'system_fingerprint': metadata.get('system_fingerprint'),
            'request_route': str(model.root_async_client.base_url).rstrip('/') + '/chat/completions'}
        if (result['stage']['status'] != 'verified' or not any(
                all(item.get(key) == value for key, value in identity.items())
                for item in result['model_identities'])):
            self._reply_revocations.add((str(owner_id), result.get('receipt')))
            if self._store is not None and result.get('receipt'):
                self._store.revoke(owner_id, self.reply_contract.identity, result['receipt'], 'reply_candidate_model_changed')
            raise LayeredMemoryConflict('实际回复响应身份变化，旧读取资格失效。')

    def status(self, owner_id, *, synthetic=False) -> dict:
        def missing(contract):
            return {'status': 'unknown', 'reasons': ['no_evaluation_report'],
                    'contract_id': contract.identity, 'report_id': None}
        organization = self.qualification(owner_id)['stage'] if self._store is not None or self.qualification_source is not None else missing(self.organization_contract)
        reply = self.reply_qualification(owner_id)['stage']
        if synthetic and organization['status'] == 'verified':
            organization = {**organization, 'status': 'unknown', 'reasons': ['actual_model_evidence_missing']}
        return {'organization': organization, 'reply': reply, 'synthetic': synthetic,
                'automatic_use_allowed': not synthetic and organization['status'] == reply['status'] == 'verified'
                    and self.reading_receipt(owner_id) is not None}
