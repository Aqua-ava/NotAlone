"""固定旧树公开 LayeredMemoryService；官方 SDK、旧事务和新宿主许可独立留证。"""
import dataclasses
import importlib.util
import json
import pickle
import socket
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4


def main():
    value = json.loads(Path(sys.argv[1]).read_text())
    assert value["database"].startswith("notalone_ts_host_") and value["database"].endswith("_test")
    assert value["provider"].startswith("http://127.0.0.1:")
    original = socket.socket.connect

    def local_only(sock, address):
        assert (isinstance(address, str) and (address.startswith("/tmp/.s.PGSQL.") or address == value["permit_socket"])) or (
            isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1")), "external_network_forbidden"
        return original(sock, address)

    socket.socket.connect = local_only
    sys.path.insert(0, value["frozen_source"])
    from notalone.scopes import ContactScope
    from notalone.application.layered_memory_service import LayeredMemoryService
    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
    from notalone.memory.layered import OrganizationBudget
    from notalone.memory.organization_sdk import DeepSeekOrganizationProposal, DeepSeekOrganizationVerification
    from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport
    from notalone.memory.organization_quality import OrganizationQualityContract, OrganizationQualityService
    from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
    from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
    from notalone.tasks.models import BackgroundTaskStepName
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model
    import httpx

    # 新宿主的公开客户端只作跨进程许可适配；旧业务包仍全部来自 OLD。
    spec = importlib.util.spec_from_file_location("layered_model_host_bridge", value["model_host_bridge"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    priority = module.SharedModelPriorityControl(socket_path=value["permit_socket"], token=value["permit_token"], background_limit=1)
    scope = ContactScope(UUID(value["scope"]["owner_id"]), UUID(value["scope"]["contact_id"]))
    dsn = "host=/tmp dbname=" + value["database"]
    budget = OrganizationBudget(max_memories=120, max_batch_memories=20, max_model_calls=16,
        max_characters=128000, max_scenarios=15, max_paragraphs=40, max_profile_entries=16)
    transport = OrganizationQualityHTTPTransport()
    client = httpx.Client(transport=transport, timeout=20, follow_redirects=False, trust_env=False)
    model = build_deepseek_model(api_key="synthetic-only", model_name="deepseek-flash", base_url=value["provider"],
        timeout_seconds=20, max_retries=0, http_client=client, extra_body={"thinking": {"type": "disabled"}})
    assert model.max_retries == 0
    ports = [cls(model, layer=layer, budget=budget, transport=transport, personal=True, document_tools=True)
        for cls, layer in ((DeepSeekOrganizationProposal, "l2"), (DeepSeekOrganizationVerification, "l2"),
                          (DeepSeekOrganizationProposal, "l3"), (DeepSeekOrganizationVerification, "l3"))]
    assert value["clock_mode"] in ("wall", "frozen_content")
    clock = (lambda: datetime.now(timezone.utc)) if value["clock_mode"] == "wall" else (lambda: datetime.fromisoformat(value["as_of"]))
    store = PostgresLayeredMemoryStore(dsn, clock=clock)
    contract = OrganizationQualityContract(provider="deepseek", request_model="deepseek-flash",
        verifier_provider="deepseek", verifier_model="deepseek-flash", budget=budget)
    quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract)
    dispatched = []
    service = LayeredMemoryService(store, proposer=ports[0], verifier=ports[1], profile_proposer=ports[2],
        profile_verifier=ports[3], quality=quality, model_priority=priority, dispatcher=lambda scope, task_id, **kw: dispatched.append(task_id),
        budget=budget, runtime_policy="verified_items")
    action = value["action"]
    try:
        if action == "prepare":
            service.organize(scope)
            assert len(dispatched) == 1, "old_public_entry_did_not_enqueue"
            claim = PostgresBackgroundTaskRepository(dsn).claim_next_step(owner_id=scope.owner_id, contact_id=scope.contact_id,
                task_id=dispatched[0], worker_id=uuid4(), lease_duration=timedelta(minutes=5),
                supported_steps=(BackgroundTaskStepName.ORGANIZE_MEMORY,))
            assert claim is not None, "old_public_claim_missing"
            claim_path = Path(value["claim_file"])
            claim_path.write_bytes(pickle.dumps(claim)); claim_path.chmod(0o600)
            result = {"taskId": str(claim.task_id), "stepId": str(claim.step_id), "workerId": str(claim.worker_id),
                "leaseGeneration": claim.lease_generation, "sdk_retry": model.max_retries, "business_retry": 0}
        elif action == "run":
            claim = pickle.loads(Path(value["claim_file"]).read_bytes())
            result = {"processed_count": service.run_batch(claim), "state": store.read(scope)}
        elif action == "cancel":
            state = store.read(scope)[0]
            service.command(scope, "disable", state["settings_generation"])
            result = {"state": store.read(scope)}
        elif action == "read":
            result = {"state": store.read(scope)}
        else:
            raise ValueError("unknown_old_action")
        print(json.dumps(result, default=lambda v: dataclasses.asdict(v) if dataclasses.is_dataclass(v) else str(v), ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
