"""升级单元夹具使用真实身份生成器，只有模型边界为合成。"""

from types import SimpleNamespace

from notalone.application.memory_upgrade_runtime import build_upgrade_runtime
from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.memory.upgrade_algorithm import upgrade_algorithm
from notalone.memory_extraction.dimensions import DimensionRelease
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


def synthetic_upgrade_algorithm(*, model_name="synthetic-upgrade-unit", release=None):
    components = SimpleNamespace(model=ToolCallingFakeModel(responses=[], model_name=model_name),
        ledger=InMemoryOutboundLedger(), model_name=model_name)
    return upgrade_algorithm(components, build_upgrade_runtime(components),
                             dimension_release=release or DimensionRelease())
