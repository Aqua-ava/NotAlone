"""原L2/L3公开organize的空输入终态；实际任务保留，网络只准PG。"""
import json
from pathlib import Path
import socket
import sys
from uuid import UUID


def main():
    value = json.loads(Path(sys.argv[1]).read_text())
    assert value['database'].startswith('notalone_ts_host_') and value['database'].endswith('_test')
    original = socket.socket.connect

    def pg_only(sock, address):
        assert isinstance(address, str) and address.startswith('/tmp/.s.PGSQL.'), 'zero_call_model_dispatch_forbidden'
        return original(sock, address)

    socket.socket.connect = pg_only
    sys.path.insert(0, value['frozen_source'])
    from notalone.scopes import ContactScope
    from notalone.application.layered_memory_service import LayeredMemoryService
    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
    from notalone.memory.layered import OrganizationBudget
    from notalone.memory.organization_sdk import DeepSeekOrganizationProposal, DeepSeekOrganizationVerification
    from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport
    from notalone.memory.organization_quality import OrganizationQualityContract, OrganizationQualityService
    from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model
    import httpx

    scope = ContactScope(UUID(value['scope']['owner_id']), UUID(value['scope']['contact_id']))
    store = PostgresLayeredMemoryStore('host=/tmp dbname=' + value['database'])
    budget = OrganizationBudget(max_memories=120, max_batch_memories=20, max_model_calls=16,
        max_characters=128000, max_scenarios=15, max_paragraphs=40, max_profile_entries=16)
    transport = OrganizationQualityHTTPTransport()
    client = httpx.Client(transport=transport, timeout=20, follow_redirects=False, trust_env=False)
    try:
        model = build_deepseek_model(api_key='synthetic-only', model_name='deepseek-flash',
            base_url='http://127.0.0.1:9/v1', timeout_seconds=20, max_retries=0,
            http_client=client, extra_body={'thinking': {'type': 'disabled'}})
        ports = [cls(model, layer=layer, budget=budget, transport=transport, personal=True, document_tools=True)
            for cls, layer in ((DeepSeekOrganizationProposal, 'l2'), (DeepSeekOrganizationVerification, 'l2'),
                              (DeepSeekOrganizationProposal, 'l3'), (DeepSeekOrganizationVerification, 'l3'))]
        dispatched = []
        quality = OrganizationQualityService(PostgresOrganizationQualityStore(store),
            organization_contract=OrganizationQualityContract(provider='deepseek', request_model='deepseek-flash',
                verifier_provider='deepseek', verifier_model='deepseek-flash', budget=budget))
        service = LayeredMemoryService(store, proposer=ports[0], verifier=ports[1], profile_proposer=ports[2],
            profile_verifier=ports[3], budget=budget, quality=quality, runtime_policy='verified_items',
            dispatcher=lambda *args, **kwargs: dispatched.append(True))
        service.organize(scope)
        assert not dispatched, 'empty_input_must_not_dispatch_worker'
        state = store.read(scope)
        print(json.dumps({'state': state, 'dispatched': len(dispatched),
            'entry': 'LayeredMemoryService.organize → PostgresLayeredMemoryStore.read'}, default=str))
    finally:
        client.close()


if __name__ == '__main__':
    main()
