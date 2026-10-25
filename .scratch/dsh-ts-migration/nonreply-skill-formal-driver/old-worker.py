"""冻结Python公开Skill入口的私有隔离对照；不改变模型结果或时钟。"""
import dataclasses
import json
import socket
import sys
import time
from pathlib import Path
from uuid import UUID, uuid4
from datetime import timedelta, datetime, timezone


def main():
    value = json.loads(Path(sys.argv[1]).read_text())
    assert value['database'].startswith('notalone_ts_host_') and value['database'].endswith('_test')
    original_connect = socket.socket.connect

    def local_only(sock, address):
        assert (isinstance(address, str) and address.startswith('/tmp/.s.PGSQL.')) or \
            (isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1')), 'external_network_forbidden'
        return original_connect(sock, address)

    socket.socket.connect = local_only
    sys.path.insert(0, value['frozen_source'])
    from notalone.scopes import ContactScope
    from notalone.persistence import PostgresOutboundLedger
    from notalone.persistence.skill_learning import PostgresSkillLearningStore
    from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
    from notalone.tasks.models import BackgroundTaskStepName
    from notalone.skills.learning_runtime import LangChainSkillProposalRuntime
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model
    from langchain_core.callbacks import BaseCallbackHandler
    scope = ContactScope(UUID(value['scope']['owner_id']), UUID(value['scope']['contact_id']))
    dsn = 'host=/tmp dbname=' + value['database']
    store = PostgresSkillLearningStore(dsn)
    tasks = PostgresBackgroundTaskRepository(dsn)
    if value.get('cancel_only'):
        store.configure(scope, enabled=False, operation_key=uuid4(), expected_revision=1)
        print(json.dumps({'cancelled_persisted': True}))
        return
    started = time.perf_counter()
    events = []

    def event(kind, **details):
        events.append({'type': kind, 'at_ms': (time.perf_counter() - started) * 1000, **details})

    event('business_service_start', at_ms=0, wall_at=datetime.now(timezone.utc).isoformat())
    store.configure(scope, enabled=True, operation_key=uuid4(), expected_revision=0)
    task = store.enqueue(scope)
    assert task, 'nonempty_learning_batch_required'
    claim = tasks.claim_next_step(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task,
        worker_id=uuid4(), lease_duration=timedelta(minutes=2), supported_steps=(BackgroundTaskStepName.PROPOSE_SKILL,))
    assert claim, 'learning_claim_required'
    event('queue_end')
    batch = store.capture(scope)

    class Observer(BaseCallbackHandler):
        def on_chat_model_start(self, *args, **kwargs):
            event('network_start')

        def on_llm_new_token(self, token, **kwargs):
            chunk = kwargs.get('chunk')
            message = getattr(chunk, 'message', None)
            incremental = bool(token or getattr(message, 'tool_call_chunks', None))
            event('model_stream_chunk', is_token_delta=incremental)

        def on_llm_end(self, *args, **kwargs):
            event('network_end')

        def on_llm_error(self, *args, **kwargs):
            event('network_end')

    model = build_deepseek_model(api_key='synthetic-only', model_name='deepseek-flash',
        base_url=value['provider'] + '/v1', timeout_seconds=20, max_retries=0,
        extra_body={'thinking': {'type': 'disabled'}, 'top_p': 1})
    model.max_tokens = 393216
    model.streaming = True
    model.callbacks = [Observer()]
    runtime = LangChainSkillProposalRuntime(model=model, ledger=PostgresOutboundLedger(dsn))
    claim_value = {'taskId': str(claim.task_id), 'stepId': str(claim.step_id), 'workerId': str(claim.worker_id),
        'leaseGeneration': claim.lease_generation, 'stepName': claim.name.value}
    print(json.dumps({'kind': 'ready', 'claim': claim_value, 'batch': {**dataclasses.asdict(batch), 'ready': batch.ready}}, default=str), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        if command['action'] == 'close':
            return
        assert command['action'] == 'run', 'single_runner_command_required'
        terminal, error_code, processed = 'succeeded', None, 0
        try:
            store.validate(scope, claim, batch)
            proposal = runtime.propose(scope=scope, batch=batch)
            event('persistence_start')
            try:
                processed = store.save(scope, claim, batch, proposal)
            finally:
                event('persistence_end')
            tasks.complete_step(claim, processed_count=processed, total_count=processed)
            verification = tasks.claim_next_step(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task,
                worker_id=uuid4(), lease_duration=timedelta(minutes=2), supported_steps=(BackgroundTaskStepName.VERIFY_SKILL_DRAFTS,))
            assert verification, 'verification_claim_required'
            store.verify(scope)
            tasks.complete_step(verification, processed_count=0, total_count=processed)
        except Exception as error:
            error_code = type(error).__name__
            import psycopg
            with psycopg.connect(dsn) as connection:
                enabled = connection.execute('SELECT enabled FROM skill_learning_scope WHERE owner_id=%s AND contact_id=%s',
                    (scope.owner_id, scope.contact_id)).fetchone()[0]
            terminal = 'failed' if enabled else 'cancelled'
            if enabled:
                tasks.fail_step(claim, error_code='skill_learning_model_failed', retryable=False)
        event('business_service_end', outcome=terminal)
        print(json.dumps({'kind': 'result', 'terminal_status': terminal, 'error_code': error_code,
            'processed_count': processed, 'events': events, 'automatic_retries': 0}, default=str), flush=True)
        # 一次claim/一次propose；不进入生产Worker自动调度循环。
        return


if __name__ == '__main__':
    main()
