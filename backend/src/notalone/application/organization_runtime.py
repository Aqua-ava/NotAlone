"""正式后端的显式operator装配；可信来源与实际候选沿同一资格门禁。"""

import os
from contextlib import contextmanager
from pathlib import Path

from notalone.application.layered_memory_service import LayeredMemoryService
from notalone.application.organization_quality_suite import SyntheticSuiteReader
from notalone.memory.layered import OrganizationBudget
from notalone.memory.organization_quality import OrganizationQualityContract, OrganizationQualityService
from notalone.memory.organization_quality_suite_budget import private_json
from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
from notalone.persistence.organization_quality import PostgresOrganizationQualityStore


class ConfiguredSuiteSource:
    """每次重开私有来源；来源暂失只撤资格，不阻止App读取L1。"""

    def __init__(self, directory):
        self.directory = directory
        self.database_url = None

    def validate_target(self, database_url):
        self.database_url = database_url

    def _reader(self):
        reader = SyntheticSuiteReader(self.directory)
        reader.validate_target(self.database_url)
        return reader

    def resolve(self, contract, connection=None):
        try:
            return self._reader().resolve(contract, connection=connection)
        except Exception:
            return {'stage': {'status': 'unknown', 'reasons': ['qualification_source_unavailable'],
                'contract_id': contract.identity, 'report_id': None}, 'receipt': None, 'model_identities': []}

    @contextmanager
    def hold(self, contract, snapshot):
        with self._reader().hold(contract, snapshot) as current:
            yield current


def build_layered_memory_service(database_url, *, model_priority=None):
    store = PostgresLayeredMemoryStore(database_url)
    configured = os.environ.get('NOTALONE_ORGANIZATION_QUALITY_CONFIG')
    if not configured:
        return LayeredMemoryService(store, model_priority=model_priority)
    path = Path(configured)
    if not path.is_absolute():
        raise ValueError('整理operator配置须是明确绝对路径。')
    value = private_json(path)
    if (not isinstance(value, dict) or set(value) != {'schema_version', 'suite_directory', 'organization_budget'}
            or value['schema_version'] != 'organization-runtime-v1'
            or not isinstance(value['suite_directory'], str) or not Path(value['suite_directory']).is_absolute()
            or not isinstance(value['organization_budget'], dict)
            or set(value['organization_budget']) != set(OrganizationBudget.__dataclass_fields__)):
        raise ValueError('整理operator配置结构无效。')
    budget = OrganizationBudget(**value['organization_budget'])
    if budget.max_model_calls != 4:
        raise ValueError('整理候选装配要求明确四阶段有限预算。')
    source = ConfiguredSuiteSource(Path(value['suite_directory']))
    contract = OrganizationQualityContract(provider='deepseek', request_model='deepseek-flash',
        verifier_provider='deepseek', verifier_model='deepseek-flash', budget=budget)
    quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract,
        qualification_source=source)
    from notalone.memory.organization_sdk import build_deepseek_organization_adapters
    try:
        ports, close = build_deepseek_organization_adapters(budget=budget)
    except (ValueError, RuntimeError):
        quality.runtime_unavailable_reason = 'organization_adapter_unavailable'
        return LayeredMemoryService(store, budget=budget, model_priority=model_priority, quality=quality)
    try:
        return LayeredMemoryService(store, proposer=ports[0], verifier=ports[1], profile_proposer=ports[2],
            profile_verifier=ports[3], budget=budget, model_priority=model_priority, quality=quality, adapter_close=close)
    except Exception:
        close()
        raise
