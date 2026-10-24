"""合成HTTP尝试：没有网络模型，仅在预约ACK后登记模拟派发。"""
import json
import sys
from datetime import datetime
from uuid import UUID, uuid4
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.application.model_call_accounting import SharedModelCallAccounting, ModelCallAssociation
from notalone.application.model_priority import ModelWorkStopped
from notalone.ledger.models import LedgerEntry, LedgerOutcome

config = json.loads(sys.stdin.readline())
control = SharedModelPriorityControl(socket_path=config["path"], token=config["token"])
accounting = SharedModelCallAccounting(control)
kwargs = {key: UUID(config[key]) for key in ("owner_id", "contact_id", "request_id")}
kwargs.update(provider="synthetic", model="synthetic-model", called_at=datetime.fromisoformat(config["called_at"]))
with control.background_call():
    if config.get("input_budget"):
        first = ModelCallAssociation(uuid4(), UUID(control.current_call_identity["permit_id"]),
            kwargs["request_id"], kwargs["owner_id"], kwargs["contact_id"], "contact",
            kwargs["provider"], kwargs["model"], kwargs["called_at"], uuid4())
        control.reserve_physical_call(first.receipt() | {"input_budget": config["input_budget"]})
    else:
        first = accounting.reserve(call_id=uuid4(), **kwargs)
    print("reserved", flush=True)
    sys.stdin.readline()  # TS核验pending已实际持久化后才模拟HTTP返回。
    second = accounting.reserve(call_id=uuid4(), **kwargs)
    try:
        accounting.reserve(call_id=uuid4(), **kwargs)
        raise AssertionError("超额调用不应派发")
    except ModelWorkStopped:
        pass
entry = LedgerEntry(UUID(config["legacy_id"]), kwargs["owner_id"], kwargs["contact_id"],
    kwargs["provider"], kwargs["model"], None, None, 12, LedgerOutcome.SUCCEEDED, kwargs["called_at"])
accounting.link_existing(first, entry, response_observed=True)
accounting.record_unknown(second)
print(json.dumps({"first": str(first.attempt_id), "second": str(second.attempt_id),
                  "permit": str(first.permit_id)}), flush=True)
