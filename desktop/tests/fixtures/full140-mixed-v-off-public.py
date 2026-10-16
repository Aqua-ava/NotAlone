"""完整140的唯一分阶段配对薄入口；共用已审完整流程，不接任意配置。"""
from functools import partial
import importlib.util
from pathlib import Path

from notalone.memory_extraction.evaluation_provider_contract import MIXED_PLAN


spec = importlib.util.spec_from_file_location("full140_fixed_variants", Path(__file__).with_name("full140-v4-public.py"))
if spec is None or spec.loader is None:
    raise ValueError("full140_shared_runner_required")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
helpers = shared.helpers
FIXED = shared._fixed(MIXED_PLAN)
prepare = partial(shared.prepare, _plan=MIXED_PLAN)
validate = partial(shared.validate, _plan=MIXED_PLAN)
verify_claim = partial(shared.verify_claim, _plan=MIXED_PLAN)
worker = partial(shared.worker, _plan=MIXED_PLAN)
launch = partial(shared.launch, _plan=MIXED_PLAN)


if __name__ == "__main__":
    shared.main(MIXED_PLAN)
