"""E2 全140的固定薄入口；执行复用已审全140 worker。"""
from functools import partial
import importlib.util
from pathlib import Path


from notalone.memory_extraction.evaluation_provider_contract import FULL140_E2_PLAN as PLAN
spec = importlib.util.spec_from_file_location("full140_e2_shared", Path(__file__).with_name("full140-v4-public.py"))
if spec is None or spec.loader is None:
    raise ValueError("full140_shared_runner_required")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
helpers = shared.helpers
FIXED = shared._fixed(PLAN)
prepare = partial(shared.prepare, _plan=PLAN)
validate = partial(shared.validate, _plan=PLAN)
verify_claim = partial(shared.verify_claim, _plan=PLAN)
worker = partial(shared.worker, _plan=PLAN)
launch = partial(shared.launch, _plan=PLAN)


if __name__ == "__main__":
    shared.main(PLAN)
