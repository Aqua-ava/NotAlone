"""正式后端默认逐项核验维护；显式operator配置保留独立评测模式。"""

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
        from notalone.memory.organization_sdk import build_deepseek_organization_adapters
        budget = OrganizationBudget(max_memories=120, max_batch_memories=20, max_model_calls=4, max_characters=128000, max_scenarios=15, max_paragraphs=40, max_profile_entries=16)
        contract = OrganizationQualityContract(provider='deepseek', request_model='deepseek-flash',
            verifier_provider='deepseek', verifier_model='deepseek-flash', budget=budget)
        quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract)
        try:
            ports, close = build_deepseek_organization_adapters(budget=budget, runtime_policy='verified_items')
        except (ValueError, RuntimeError):
            return LayeredMemoryService(store, budget=budget, model_priority=model_priority,
                runtime_policy='verified_items', quality=quality)
        contract = OrganizationQualityContract(provider='deepseek', request_model=ports[0].model.model_name,
            verifier_provider='deepseek', verifier_model=ports[1].model.model_name, budget=budget)
        quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract)
        try:
            return LayeredMemoryService(store, proposer=ports[0], verifier=ports[1],
                profile_proposer=ports[2], profile_verifier=ports[3], budget=budget,
                model_priority=model_priority, adapter_close=close, runtime_policy='verified_items', quality=quality)
        except Exception:
            close()
            raise
    path = Path(configured)
    if not path.is_absolute():
        raise ValueError('整理operator配置须是明确绝对路径。')
    value = private_json(path)
    fields = {'schema_version', 'suite_directory', 'organization_budget'}
    if (not isinstance(value, dict) or set(value) - (fields | {'reply'}) or not fields <= set(value)
            or value['schema_version'] not in {'organization-runtime-v1', 'organization-runtime-v2'}
            or not isinstance(value['suite_directory'], str) or not Path(value['suite_directory']).is_absolute()
            or not isinstance(value['organization_budget'], dict)
            or set(value['organization_budget']) != set(OrganizationBudget.__dataclass_fields__)):
        raise ValueError('整理operator配置结构无效。')
    reply_configuration = None
    if value.get('reply') is not None:
        from notalone.application.reply_qualification import ReplyReadConfiguration
        try:
            reply_configuration = ReplyReadConfiguration(value['reply'])
        except (ValueError, TypeError, KeyError):
            pass  # 回复配置无效只关闭读取；原整理合同和L1继续独立工作。
    budget = OrganizationBudget(**value['organization_budget'])
    if budget.max_model_calls != 4:
        raise ValueError('整理候选装配要求明确四阶段有限预算。')
    source = ConfiguredSuiteSource(Path(value['suite_directory']))
    contract = OrganizationQualityContract(provider='deepseek', request_model='deepseek-flash',
        verifier_provider='deepseek', verifier_model='deepseek-flash', budget=budget)
    if reply_configuration is not None:
        reply_configuration.source.bind_organization(source, contract)
    quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract,
        qualification_source=source)
    from notalone.memory.organization_sdk import build_deepseek_organization_adapters
    try:
        ports, close = build_deepseek_organization_adapters(budget=budget)
    except (ValueError, RuntimeError):
        quality.runtime_unavailable_reason = 'organization_adapter_unavailable'
        service = LayeredMemoryService(store, budget=budget, model_priority=model_priority, quality=quality)
        service.reply_configuration = reply_configuration
        return service
    try:
        service = LayeredMemoryService(store, proposer=ports[0], verifier=ports[1], profile_proposer=ports[2],
            profile_verifier=ports[3], budget=budget, model_priority=model_priority, quality=quality, adapter_close=close)
        service.reply_configuration = reply_configuration
        return service
    except Exception:
        close()
        raise
