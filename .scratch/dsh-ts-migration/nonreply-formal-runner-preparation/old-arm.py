"""固定旧Git树的正式业务入口；socket只允许localhost与本机PG。"""
import dataclasses
import json
from pathlib import Path
import socket
import sys
from uuid import UUID


def main():
    value = json.loads(Path(sys.argv[1]).read_text())
    assert value['database'].startswith('notalone_ts_host_') and value['database'].endswith('_test')
    assert value['provider'].startswith('http://127.0.0.1:')
    original = socket.socket.connect
    def local_only(sock, address):
        assert isinstance(address, str) and (address.startswith('/tmp/.s.PGSQL.') or address==value.get('permit_socket')) or \
            isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1'), 'external_network_forbidden'
        return original(sock, address)
    socket.socket.connect = local_only
    sys.path.insert(0, value['frozen_source'])
    from notalone.scopes import ContactScope
    from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore, PostgresOutboundLedger, PostgresWatermarkStore
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model
    scope = ContactScope(UUID(value['run']['scope']['owner_id']), UUID(value['run']['scope']['contact_id']))
    dsn = 'host=/tmp dbname=' + value['database']
    model = build_deepseek_model(api_key='synthetic-only', model_name='deepseek-flash',
        base_url=value['provider'], timeout_seconds=20, max_retries=0,
        extra_body={'thinking': {'type': 'disabled'}})
    if value['run']['domain'] == 'memory_extraction':
        from notalone.memory_extraction.command import run_extraction
        from notalone.memory_extraction.cli_support import load_contact_messages
        from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
        from notalone.memory_extraction.dimensions import DimensionRelease
        stats = run_extraction(scope=scope, messages=load_contact_messages(scope, dsn), watermark_message_id=None,
            runtime=DirectExtractionRuntime(model=model, max_retries=0),
            verification_runtime=LangChainSourceVerificationRuntime(model=model, ledger=PostgresOutboundLedger(dsn)),
            memory_port=PostgresMemoryStore(dsn), owner_memory_port=PostgresOwnerMemoryStore(dsn),
            ledger=PostgresOutboundLedger(dsn), watermark_port=PostgresWatermarkStore(dsn),
            trace_store=PostgresExtractionTraceStore(dsn), model_name='deepseek-flash',
            target_message_ids=tuple(UUID(value['prepared']['messages'][i]) for i in value['run']['material']['targets']),
            batch_size=len(value['prepared']['messages']),context_before=len(value['prepared']['messages']),
            context_after=len(value['prepared']['messages']),batch_concurrency=1,
            dimension_release=DimensionRelease(verified_sources=True))
        output = dataclasses.asdict(stats)
    elif value['run']['domain'].startswith('l'):
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.memory.layered import OrganizationBudget
        from notalone.memory.organization_sdk import DeepSeekOrganizationProposal, DeepSeekOrganizationVerification
        from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport
        from notalone.tasks.models import BackgroundTaskStepName
        from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
        from notalone.memory.organization_quality import OrganizationQualityContract, OrganizationQualityService
        from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
        import httpx
        from datetime import datetime, timezone, timedelta
        budget = OrganizationBudget(max_memories=120,max_batch_memories=20,max_model_calls=16,
            max_characters=128000,max_scenarios=15,max_paragraphs=40,max_profile_entries=16)
        transport = OrganizationQualityHTTPTransport()
        client=httpx.Client(transport=transport,timeout=20,follow_redirects=False,trust_env=False)
        model=build_deepseek_model(api_key='synthetic-only',model_name='deepseek-flash',
            base_url=value['provider'],timeout_seconds=20,max_retries=0,http_client=client)
        ports = [cls(model, layer=layer, budget=budget, transport=transport, personal=True, document_tools=True)
            for cls, layer in ((DeepSeekOrganizationProposal,'l2'), (DeepSeekOrganizationVerification,'l2'),
                (DeepSeekOrganizationProposal,'l3'), (DeepSeekOrganizationVerification,'l3'))]
        store=PostgresLayeredMemoryStore(dsn, clock=lambda: datetime.fromisoformat(value['adaptation']['as_of']))
        contract=OrganizationQualityContract(provider='deepseek',request_model='deepseek-flash',
            verifier_provider='deepseek',verifier_model='deepseek-flash',budget=budget)
        quality=OrganizationQualityService(PostgresOrganizationQualityStore(store),organization_contract=contract)
        dispatched=[]
        service = LayeredMemoryService(store, proposer=ports[0], verifier=ports[1],
            profile_proposer=ports[2],profile_verifier=ports[3],quality=quality,
            dispatcher=lambda scope,task_id,**kwargs:dispatched.append(task_id),
            budget=budget, runtime_policy='verified_items')
        service.organize(scope)
        repository=PostgresBackgroundTaskRepository(dsn)
        claim=repository.claim_next_step(owner_id=scope.owner_id,contact_id=scope.contact_id,
            task_id=dispatched[0] if dispatched else None,worker_id=UUID(value['prepared']['claim']['workerId']),
            lease_duration=timedelta(minutes=5),supported_steps=(BackgroundTaskStepName.ORGANIZE_MEMORY,))
        output={'processed_count':service.run_batch(claim) if claim else 0,'state':service.read(scope)}
        client.close()
    else:
        from notalone.persistence.skill_learning import PostgresSkillLearningStore
        from notalone.skills.learning_runtime import LangChainSkillProposalRuntime
        store=PostgresSkillLearningStore(dsn)
        store.configure(scope,enabled=True,operation_key=UUID(value['prepared']['source']),expected_revision=0)
        batch=store.capture(scope)
        if not batch.ready:
            output={'status':'idle','batch_ready':False,'batch_preview':dataclasses.asdict(batch)}
        else:
            from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
            from notalone.tasks.models import BackgroundTaskStepName
            from datetime import timedelta
            from uuid import uuid4
            task=store.enqueue(scope)
            claim=PostgresBackgroundTaskRepository(dsn).claim_next_step(owner_id=scope.owner_id,
                contact_id=scope.contact_id,task_id=task,worker_id=uuid4(),lease_duration=timedelta(minutes=5),
                supported_steps=(BackgroundTaskStepName.PROPOSE_SKILL,BackgroundTaskStepName.VERIFY_SKILL_DRAFTS))
            store.validate(scope,claim,batch)
            proposal=LangChainSkillProposalRuntime(model=model,ledger=PostgresOutboundLedger(dsn)).propose(scope=scope,batch=batch)
            output={'proposal':proposal,'processed_count':store.save(scope,claim,batch,proposal)}
    failed=bool(isinstance(output,dict) and isinstance(output.get('state'),dict) and output['state'].get('error_code'))
    print(json.dumps({'terminal_status':'failed' if failed else 'succeeded','output':output},ensure_ascii=False,default=str))


if __name__ == '__main__':
    main()
