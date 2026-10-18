"""升级任务显式使用当前完整记忆生成与独立来源核验。"""

from notalone.memory_extraction.cli_support import build_extraction_components
from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime


def build_upgrade_components(database_url):
    # 一个高层调用只对应一次HTTP；Worker重试仍沿用户总预算重新扣额。
    return build_extraction_components(database_url, max_retries=0)


def build_upgrade_runtime(components):
    return dict(
        extraction=DirectExtractionRuntime(model=components.model, max_retries=0),
        verification=LangChainSourceVerificationRuntime(model=components.model, isolate_items=True,
            ledger=components.ledger, provider="deepseek", force_tool_choice=False),
        adjudication=LangChainAdjudicationRuntime(model=components.model),
        ledger=components.ledger, model_name=components.model_name,
    )


class UpgradeRuntimeBuilder:
    """每个装配持有实际模型；批准与执行读取同一有效配置及最新规则摘要。"""

    def __init__(self, database_url, *, dimension_release=None):
        self.database_url = database_url
        self.dimension_release = dimension_release
        self._components = None

    def _active(self):
        if self._components is None:
            self._components = build_upgrade_components(self.database_url)
        return self._components

    def identity(self):
        from notalone.memory.upgrade_algorithm import upgrade_algorithm
        active = self._active()
        return upgrade_algorithm(active, build_upgrade_runtime(active), dimension_release=self.dimension_release)

    def __call__(self):
        return build_upgrade_runtime(self._active())
