"""显式历史升级的持久状态；预览不写事实，批准只调度固定应用步骤。"""

from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, replace
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row, tuple_row
from psycopg.types.json import Jsonb

from notalone.memory.upgrade import UpgradeScope, UpgradeBudget, UpgradeConflict, UpgradeNotFound, UpgradeDeleted, UpgradeBudgetExceeded
from notalone.memory.upgrade_snapshot import comparison_payload, outcome_payload, upgrade_digest
from notalone.memory_extraction.models import ExtractionWindow
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.correction_evidence import capture_message_snapshot
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.persistence.memory_upgrade_generation import memory_generation, generation_current, generation_sources_current, source_current
from notalone.scopes import ContactScope


@dataclass(frozen=True)
class UpgradeInput:
    batch_id: UUID
    scope: ContactScope
    target_kind: str
    window: ExtractionWindow
    generation: dict
    memory_port: object
    owner_memory_port: object


class PostgresMemoryUpgradeStore:
    def __init__(self, database_url, *, algorithm_provider=None):
        self.database_url = database_url
        if algorithm_provider is None:
            from notalone.application.memory_upgrade_runtime import UpgradeRuntimeBuilder
            algorithm_provider = UpgradeRuntimeBuilder(database_url).identity
        self.algorithm_provider = algorithm_provider

    def _require_algorithm(self, row):
        from notalone.memory.upgrade_algorithm import require_upgrade_algorithm
        current = self.algorithm_provider()
        require_upgrade_algorithm(row.get('algorithm'), current)
        if 'job_algorithm' in row:
            require_upgrade_algorithm(row['job_algorithm'], current)

    def _connect(self):
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def prepare(self, selected: UpgradeScope, budget: UpgradeBudget, operation: UUID):
        algorithm = self.algorithm_provider()
        with self._connect() as connection:
            # 先只选无正文身份，再依联系人→owner顺序锁定，最后重新核对范围。
            rows = self._select_messages(connection, selected, budget.message_limit)
            contacts = {row['contact_id'] for row in rows}
            if selected.contact_id:
                contacts.add(selected.contact_id)
            _lock(connection, selected.owner_id, contacts)
            self._require_scope(connection, selected)
            previous = connection.execute('SELECT * FROM public.memory_upgrade_job WHERE owner_id=%s AND operation_key=%s',
                                          (selected.owner_id, operation)).fetchone()
            if previous:
                _match_scope(previous, selected)
                if previous['state'] == 'deleted':
                    raise UpgradeDeleted()
                if (previous['message_limit'], previous['batch_size'], previous['model_call_limit']) != (budget.message_limit, budget.batch_size, budget.model_calls):
                    raise UpgradeConflict('不能复用同一动作改变范围或预算。')
                self._require_algorithm(previous)
                return previous['id']
            rows = self._select_messages(connection, selected, budget.message_limit)
            if not {row['contact_id'] for row in rows} <= contacts:
                raise UpgradeConflict('历史来源范围已变化，请重新准备。')
            job_id = uuid4()
            connection.execute('INSERT INTO public.memory_upgrade_job(id,owner_id,contact_id,scope_kind,operation_key,message_limit,batch_size,model_call_limit,algorithm) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (job_id, selected.owner_id, selected.contact_id, selected.kind, operation, budget.message_limit, budget.batch_size, budget.model_calls, Jsonb(algorithm)))
            groups = {}
            for row in rows:
                groups.setdefault(row['contact_id'], []).append(row['id'])
            number = 0
            for contact_id, ids in groups.items():
                for offset in range(0, len(ids), budget.batch_size):
                    number += 1
                    messages = ids[offset:offset+budget.batch_size]
                    frozen = capture_message_snapshot(connection, owner_id=selected.owner_id, contact_id=contact_id,
                                                      message_ids=set(messages))
                    if set(frozen['message_ids']) != {str(item) for item in messages}:
                        raise UpgradeConflict('本批历史来源不可用。')
                    task_id, batch_id = uuid4(), uuid4()
                    connection.execute("INSERT INTO public.background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES(%s,%s,%s,'memory_upgrade','queued','preview_upgrade',%s)",
                                       (task_id, selected.owner_id, contact_id, len(messages)))
                    _insert_steps(connection, task_id, (('preview_upgrade', 1), ('verify_upgrade_preview', 2)), len(messages))
                    connection.execute('INSERT INTO public.memory_upgrade_batch(id,job_id,owner_id,contact_id,task_id,batch_number,message_ids,source_generation,dependency_ids,algorithm) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                        (batch_id, job_id, selected.owner_id, contact_id, task_id, number, messages, Jsonb(frozen), [UUID(item) for item in frozen['source_ids']], Jsonb(algorithm)))
            self._require_algorithm({'algorithm': algorithm})
            return job_id

    @staticmethod
    def _require_scope(connection, selected):
        if selected.kind == 'contact' and not connection.execute(
            "SELECT 1 FROM public.contact c WHERE c.owner_id=%s AND c.id=%s AND EXISTS(SELECT 1 FROM public.conversation_binding b WHERE b.owner_id=c.owner_id AND b.contact_id=c.id AND b.status='active')",
            (selected.owner_id, selected.contact_id)).fetchone():
            raise UpgradeNotFound()
        if not connection.execute('SELECT 1 FROM public.owner WHERE id=%s', (selected.owner_id,)).fetchone():
            raise UpgradeNotFound()

    @staticmethod
    def _select_messages(connection, selected, limit):
        return connection.execute(f"SELECT message.id,message.contact_id FROM public.message AS message "
            "WHERE message.owner_id=%s AND (%s::uuid IS NULL OR message.contact_id=%s) "
            "AND (%s='contact' OR message.speaker='user') AND message.speaker IN ('user','contact') "
            "AND message.occurred_at IS NOT NULL AND length(coalesce(message.text_content,message.media_placeholder,''))>0 "
            "AND EXISTS(SELECT 1 FROM public.conversation_binding b WHERE b.owner_id=message.owner_id AND b.contact_id=message.contact_id AND b.status='active') "
            f"AND {valid_source_ref_exists_sql('message')} ORDER BY message.occurred_at,message.created_at,message.id LIMIT %s",
            (selected.owner_id, selected.contact_id, selected.contact_id, selected.kind, limit)).fetchall()

    def _job(self, connection, selected, job_id, *, allow_deleted=False):
        row = connection.execute('SELECT * FROM public.memory_upgrade_job WHERE owner_id=%s AND id=%s FOR UPDATE',
                                 (selected.owner_id, job_id)).fetchone()
        if row is None:
            raise UpgradeNotFound()
        _match_scope(row, selected)
        if row['state'] == 'deleted' and not allow_deleted:
            raise UpgradeDeleted()
        return row

    def list(self, selected):
        with self._connect() as connection:
            lock_owner_scope(connection, owner_id=selected.owner_id)
            # 列表仅查工作，不自动读取历史、不建立新任务或追加预算。
            rows = connection.execute("SELECT * FROM public.memory_upgrade_job WHERE owner_id=%s AND scope_kind=%s AND contact_id IS NOT DISTINCT FROM %s AND state<>'deleted' ORDER BY created_at DESC,id DESC LIMIT 50",
                                      (selected.owner_id, selected.kind, selected.contact_id)).fetchall()
            return {'jobs': [self._payload(connection, row) for row in rows]}

    def read(self, selected, job_id):
        with self._connect() as connection:
            lock_owner_scope(connection, owner_id=selected.owner_id)
            return self._payload(connection, self._job(connection, selected, job_id))

    def _payload(self, connection, job):
        rows = connection.execute('SELECT batch.*,task.status AS task_status,task.current_step,task.last_error_code AS task_error FROM public.memory_upgrade_batch batch JOIN public.background_task task ON task.id=batch.task_id AND task.owner_id=batch.owner_id AND task.contact_id=batch.contact_id WHERE batch.owner_id=%s AND batch.job_id=%s ORDER BY batch_number',
                                  (job['owner_id'], job['id'])).fetchall()
        batches = []
        for row in rows:
            if row['state'] not in ('invalidated', 'undone'):
                try:
                    source_current(connection, job['owner_id'], row['source_generation'])
                    if row['memory_generation']:
                        generation_sources_current(connection, job['owner_id'], row['memory_generation'])
                except UpgradeConflict:
                    _invalidate(connection, row['owner_id'], [row['id']])
                    row = {**row, 'state': 'invalidated', 'revision': row['revision']+1,
                           'comparison': None, 'message_ids': [], 'error_code': 'sources_changed'}
            batches.append({'batch_id': str(row['id']), 'revision': row['revision'], 'state': row['state'],
                'algorithm': row['algorithm'],
                'number': row['batch_number'], 'contact_id': str(row['contact_id']), 'message_count': len(row['message_ids']),
                'comparison': row['comparison'], 'task_status': row['task_status'], 'current_step': row['current_step'],
                'error_code': row['error_code'] or row['task_error']})
        revision = connection.execute('SELECT revision FROM public.memory_upgrade_job WHERE id=%s', (job['id'],)).fetchone()['revision']
        return {'job_id': str(job['id']), 'scope': {'kind': job['scope_kind'], 'contact_id': str(job['contact_id']) if job['contact_id'] else None},
            'algorithm': job['algorithm'],
            'revision': revision, 'state': job['state'], 'budget': {'message_limit': job['message_limit'], 'batch_size': job['batch_size'],
            'model_calls': job['model_call_limit']}, 'model_calls_used': job['model_calls_used'], 'batches': batches}

    def pending_tasks(self, selected, job_id):
        with self._connect() as connection:
            lock_owner_scope(connection, owner_id=selected.owner_id)
            job = self._job(connection, selected, job_id)
            if job['state'] != 'active':
                return ()
            return tuple((row['contact_id'], row['task_id']) for row in connection.execute(
                "SELECT b.contact_id,b.task_id FROM public.memory_upgrade_batch b JOIN public.background_task t ON t.id=b.task_id AND t.owner_id=b.owner_id AND t.contact_id=b.contact_id WHERE b.owner_id=%s AND b.job_id=%s AND b.state IN ('queued','ready','apply_queued','applied') AND t.task_type='memory_upgrade' AND t.status IN ('queued','running','verifying') ORDER BY b.batch_number",
                (selected.owner_id, job_id)).fetchall())

    def operate(self, selected, job_id, *, action, expected_revision, operation_key, batches=()):
        with self._connect() as connection:
            contacts = {row['contact_id'] for row in connection.execute('SELECT contact_id FROM public.memory_upgrade_batch WHERE owner_id=%s AND job_id=%s',
                                                                        (selected.owner_id, job_id)).fetchall()}
            _lock(connection, selected.owner_id, contacts)
            job = self._job(connection, selected, job_id, allow_deleted=action == 'delete')
            if job['state'] == 'deleted' and action != 'delete':
                raise UpgradeDeleted()
            digest = upgrade_digest({'action': action, 'expected_revision': expected_revision, 'batches': batches})
            receipt = connection.execute('SELECT * FROM public.memory_upgrade_operation WHERE owner_id=%s AND operation_key=%s',
                                         (selected.owner_id, operation_key)).fetchone()
            if receipt:
                if receipt['job_id'] != job_id or receipt['action'] != action or receipt['request_digest'] != digest:
                    raise UpgradeConflict('动作身份已经用于不同批准。')
                if action == 'delete':
                    from notalone.managed_update_backups import erase_managed_update_backups
                    erase_managed_update_backups(connection)
                return self._payload(connection, job) if action == 'delete' else None
            if job['revision'] != expected_revision or job['state'] == 'deleted':
                raise UpgradeConflict('升级工作已变化。')
            if action in ('apply', 'resume'):
                self._require_algorithm(job)
            rows = connection.execute('SELECT * FROM public.memory_upgrade_batch WHERE owner_id=%s AND job_id=%s ORDER BY batch_number FOR UPDATE',
                                      (selected.owner_id, job_id)).fetchall()
            if action in ('apply', 'undo'):
                if job['state'] != 'active':
                    raise UpgradeConflict('请先恢复已取消工作。')
                chosen = {str(identifier): revision for identifier, revision in batches}
                owned = {str(row['id']): row for row in rows}
                if not chosen.keys() <= owned.keys():
                    raise UpgradeNotFound()
                for key, revision in chosen.items():
                    row = owned[key]
                    if row['revision'] != revision or row['state'] != ('ready' if action == 'apply' else 'applied'):
                        raise UpgradeConflict('所选批次已变化。')
                    if action == 'apply':
                        self._require_algorithm(row)
                        self._validate_sources(connection, row)
                        generation_current(connection, ContactScope(selected.owner_id, row['contact_id']), job['scope_kind'], row['memory_generation'])
                        _insert_steps(connection, row['task_id'], (('apply_upgrade', 3), ('verify_upgrade_apply', 4)), len(row['message_ids']))
                        connection.execute("UPDATE public.memory_upgrade_batch SET state='apply_queued',revision=revision+1 WHERE id=%s", (row['id'],))
                        first = _recover_committed_steps(connection, row, 'apply_queued')
                        _reset_task(connection, row['task_id'], first, preserve_succeeded=True)
                    else:
                        from notalone.persistence.memory_upgrade_apply import undo_batch
                        undo_batch(connection, self.database_url, row, job['scope_kind'])
            elif action == 'cancel':
                connection.execute("UPDATE public.memory_upgrade_job SET state='cancelled' WHERE id=%s", (job_id,))
                _cancel_tasks(connection, [row['task_id'] for row in rows if row['state'] not in ('applied','undone','invalidated')])
            elif action == 'resume':
                connection.execute("UPDATE public.memory_upgrade_job SET state='active' WHERE id=%s", (job_id,))
                for row in rows:
                    if row['state'] in ('failed', 'queued', 'apply_queued', 'ready', 'applied'):
                        self._validate_sources(connection, row)
                        state = 'apply_queued' if row['state'] == 'apply_queued' else row['state']
                        if row['error_code'] in ('sources_changed','memory_changed','comparison_changed'):
                            state = 'queued'
                            connection.execute("UPDATE public.memory_upgrade_batch SET memory_generation=NULL,extracted_outcome=NULL,comparison=NULL,adjudications=NULL WHERE id=%s", (row['id'],))
                            connection.execute("DELETE FROM public.background_task_step WHERE task_id=%s AND step_order>=3", (row['task_id'],))
                        # 已存预览只恢复核验，不调用模型；失败预览沿剩余预算重试。
                        committed = state in ('ready', 'apply_queued', 'applied')
                        step = _recover_committed_steps(connection, row, state) if committed else 'preview_upgrade'
                        if step is None:
                            continue
                        if state == 'failed':
                            state = 'queued'
                        connection.execute('UPDATE public.memory_upgrade_batch SET state=%s,error_code=NULL,revision=revision+1 WHERE id=%s', (state, row['id']))
                        _reset_task(connection, row['task_id'], step, preserve_succeeded=committed)
            elif action == 'delete':
                from notalone.managed_update_backups import erase_managed_update_backups
                erase_managed_update_backups(connection)
                _invalidate(connection, selected.owner_id, [row['id'] for row in rows])
                connection.execute("UPDATE public.memory_upgrade_job SET state='deleted' WHERE id=%s", (job_id,))
            else:
                raise ValueError('未知升级动作。')
            connection.execute('UPDATE public.memory_upgrade_job SET revision=revision+1 WHERE id=%s', (job_id,))
            connection.execute('INSERT INTO public.memory_upgrade_operation(owner_id,operation_key,job_id,action,request_digest) VALUES(%s,%s,%s,%s,%s)',
                               (selected.owner_id, operation_key, job_id, action, digest))
            if action == 'delete':
                return self._payload(connection, {**job, 'state': 'deleted'})

    def _claimed(self, connection, claim, *, validate_generation=True):
        _lock(connection, claim.owner_id, {claim.contact_id})
        with connection.cursor(row_factory=tuple_row) as cursor:
            PostgresBackgroundTaskRepository._assert_valid_claim(cursor, claim)
        row = connection.execute("SELECT b.*,j.algorithm AS job_algorithm,j.scope_kind,j.state AS job_state,j.model_calls_used,j.model_call_limit FROM public.memory_upgrade_batch b JOIN public.memory_upgrade_job j ON j.id=b.job_id AND j.owner_id=b.owner_id JOIN public.background_task t ON t.id=b.task_id AND t.owner_id=b.owner_id AND t.contact_id=b.contact_id WHERE b.task_id=%s AND b.owner_id=%s AND b.contact_id=%s AND t.task_type='memory_upgrade' FOR UPDATE OF b,j",
                                 (claim.task_id, claim.owner_id, claim.contact_id)).fetchone()
        if row is None or row['job_state'] != 'active' or row['state'] == 'invalidated' or row['scope_kind'] == 'contact' and not connection.execute('SELECT 1 FROM public.memory_upgrade_job WHERE id=%s AND contact_id=%s', (row['job_id'], claim.contact_id)).fetchone():
            raise UpgradeConflict('原范围或授权已变化。')
        self._require_algorithm(row)
        self._validate_sources(connection, row)
        if validate_generation and row['memory_generation'] and row['state'] not in ('applied','undone'):
            generation_current(connection, ContactScope(claim.owner_id, claim.contact_id), row['scope_kind'], row['memory_generation'])
        return row

    @staticmethod
    def _validate_sources(connection, row):
        if not connection.execute("SELECT 1 FROM public.conversation_binding WHERE owner_id=%s AND contact_id=%s AND status='active'", (row['owner_id'], row['contact_id'])).fetchone():
            raise UpgradeConflict('原会话绑定不可用。')
        source_current(connection, row['owner_id'], row['source_generation'])

    def validate(self, claim):
        with self._connect() as connection:
            self._claimed(connection, claim)

    def charge(self, claim):
        with self._connect() as connection:
            row = self._claimed(connection, claim)
            if row['state'] != 'queued':
                raise UpgradeConflict('当前步骤不能调用模型。')
            if row['model_calls_used'] >= row['model_call_limit']:
                raise UpgradeBudgetExceeded()
            connection.execute('UPDATE public.memory_upgrade_job SET model_calls_used=model_calls_used+1 WHERE id=%s', (row['job_id'],))

    def capture(self, claim):
        from notalone.memory_extraction.cli_support import load_contact_messages
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
        scope = ContactScope(claim.owner_id, claim.contact_id)
        with self._connect() as connection:
            row = self._claimed(connection, claim, validate_generation=False)
            if row['state'] in ('ready','applied'):
                return None
            if row['state'] != 'queued':
                raise UpgradeConflict()
            generation = memory_generation(connection, scope, row['scope_kind'])
            dependencies = set(row['dependency_ids']) | {UUID(item) for item in generation['dependency_ids']}
            connection.execute('UPDATE public.memory_upgrade_batch SET memory_generation=%s,dependency_ids=%s WHERE id=%s', (Jsonb(generation), list(dependencies), row['id']))
        messages = load_contact_messages(scope, self.database_url, message_ids=tuple(row['message_ids']))
        if {item.message_id for item in messages} != set(row['message_ids']) or sum(len(item.text) for item in messages)>24000:
            raise UpgradeConflict('历史窗口无效或超出单批正文预算。')
        self.validate(claim)
        return UpgradeInput(row['id'], scope, row['scope_kind'], ExtractionWindow(claim.owner_id, claim.contact_id, messages,
            tuple(item.message_id for item in messages)), generation, PostgresMemoryStore(self.database_url), PostgresOwnerMemoryStore(self.database_url))

    def bind_outcome(self, claim, result):
        from notalone.memory_extraction.adoption import _candidate_from_fact
        from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence
        with self._connect() as connection:
            row = self._claimed(connection, claim)
            scope = ContactScope(claim.owner_id, claim.contact_id)
            return replace(result, accepted=tuple(replace(fact, dimension_evidence=bind_stored_dimension_evidence(
                connection, _candidate_from_fact(scope, fact, namespace=row['id']))) for fact in result.accepted))

    def begin_trace(self, claim, payload):
        from notalone.persistence.memory_upgrade_traces import begin_upgrade_trace
        with self._connect() as connection:
            row = self._claimed(connection, claim)
            if row['state'] != 'queued':
                raise UpgradeConflict('原预览步骤已变化。')
            return begin_upgrade_trace(connection, self.database_url, row, payload)

    def begin_apply_trace(self, claim):
        from notalone.application.memory_upgrade_trace import upgrade_trace_versions
        from notalone.memory_trace.context import event_payload
        from notalone.persistence.memory_upgrade_traces import begin_upgrade_trace
        with self._connect() as connection:
            row = self._claimed(connection, claim)
            if row['state'] == 'applied':
                return None
            if row['state'] != 'apply_queued':
                raise UpgradeConflict('原批准步骤已变化。')
            payload = event_payload({'messages': [], 'versions': upgrade_trace_versions(),
                'execution_mode': 'approved_apply', 'watermark_commit': 'not_advanced',
                'upgrade': {'batch_id': str(row['id']), 'phase': 'apply', 'preview_trace_id': str(row['trace_id']) if row['trace_id'] else None},
                'input_message_ids': [str(identifier) for identifier in row['message_ids']]})
            return begin_upgrade_trace(connection, self.database_url, row, payload)

    def save_preview(self, claim, prepared, result, compared, decisions, *, trace_id, trace_payload):
        with self._connect() as connection:
            row = self._claimed(connection, claim)
            if row['state'] == 'ready':
                return len(row['message_ids'])
            if row['state'] != 'queued' or row['memory_generation'] != prepared.generation:
                raise UpgradeConflict()
            if row['trace_id'] != trace_id:
                raise UpgradeConflict('原追踪尝试已变化。')
            from notalone.persistence.memory_upgrade_traces import transaction_trace_store
            transaction_trace_store(connection, self.database_url).complete(prepared.scope, trace_id,
                status='succeeded', payload=trace_payload)
            connection.execute("UPDATE public.memory_upgrade_batch SET state='ready',revision=revision+1,extracted_outcome=%s,comparison=%s,adjudications=%s,error_code=NULL WHERE id=%s",
                (Jsonb(outcome_payload(result)), Jsonb(comparison_payload(compared)), Jsonb(decisions), row['id']))
            connection.execute('UPDATE public.memory_upgrade_job SET revision=revision+1 WHERE id=%s', (row['job_id'],))
            return len(row['message_ids'])

    def apply(self, claim, *, dimension_release=None, trace_id=None):
        from notalone.persistence.memory_upgrade_apply import apply_batch
        with self._connect() as connection:
            row = self._claimed(connection, claim)
            if row['state'] == 'applied':
                return len(row['message_ids'])
            if row['state'] != 'apply_queued':
                raise UpgradeConflict()
            if trace_id is None or row['trace_id'] != trace_id:
                raise UpgradeConflict('原应用追踪已变化。')
            from notalone.persistence.memory_upgrade_traces import transaction_trace_store
            from notalone.application.memory_upgrade_trace import using_upgrade_trace_store
            from notalone.memory_trace.context import current_trace
            trace=current_trace()
            if trace is None or trace.trace_id!=trace_id or trace.scope!=ContactScope(claim.owner_id,claim.contact_id):
                raise UpgradeConflict('批准应用缺少同一实际追踪。')
            with using_upgrade_trace_store(transaction_trace_store(connection, self.database_url)):
                trace.record('upgrade_apply', {'batch_id': str(row['id']), 'execution_mode': 'approved_apply'})
                apply_batch(connection, self.database_url, row, dimension_release,
                            validate_algorithm=lambda: self._require_algorithm(row))
                trace.complete(status='succeeded', payload={'execution_mode': 'approved_apply',
                    'watermark_commit': 'not_advanced', 'business_writes': 'committed_with_trace'})
            return len(row['message_ids'])

    def verify(self, claim):
        with self._connect() as connection:
            row = self._claimed(connection, claim, validate_generation=False)
            expected = ('applied',) if claim.name.value == 'verify_upgrade_apply' else ('ready', 'apply_queued', 'applied')
            if row['state'] not in expected:
                raise UpgradeConflict('批次未完成当前阶段。')

    def failed(self, claim, code):
        with self._connect() as connection:
            _lock(connection, claim.owner_id, {claim.contact_id})
            receipt = connection.execute(
                "SELECT step.lease_generation,step.status AS step_state,task.status AS task_state,step.step_name "
                "FROM public.background_task_step AS step JOIN public.background_task AS task ON task.id=step.task_id "
                "WHERE task.owner_id=%s AND task.contact_id=%s AND task.id=%s AND step.id=%s "
                "AND task.task_type='memory_upgrade' FOR UPDATE OF task,step",
                (claim.owner_id, claim.contact_id, claim.task_id, claim.step_id),
            ).fetchone()
            # Worker先提交失败回执；用户恢复、后续认领或完成之后不再接受旧回调。
            if (receipt is None or receipt['lease_generation'] != claim.lease_generation
                    or receipt['step_state'] != 'failed' or receipt['task_state'] != 'failed'
                    or receipt['step_name'] != claim.name.value):
                return
            row = connection.execute('SELECT id,job_id,state FROM public.memory_upgrade_batch WHERE owner_id=%s AND contact_id=%s AND task_id=%s FOR UPDATE',
                                     (claim.owner_id, claim.contact_id, claim.task_id)).fetchone()
            if row is not None and row['state'] not in ('invalidated','applied','undone'):
                # apply失败保留原批准阶段，恢复不得重新调用E来更换批准内容。
                state = row['state'] if row['state'] in ('ready','apply_queued') else 'failed'
                connection.execute('UPDATE public.memory_upgrade_batch SET state=%s,error_code=%s,revision=revision+1 WHERE id=%s', (state, code, row['id']))
                connection.execute('UPDATE public.memory_upgrade_job SET revision=revision+1 WHERE id=%s', (row['job_id'],))


def _match_scope(row, selected):
    if row['scope_kind'] != selected.kind or row['contact_id'] != selected.contact_id:
        raise UpgradeNotFound()


def _lock(connection, owner_id, contacts):
    for contact_id in sorted(contacts, key=str):
        lock_contact_scope(connection, owner_id=owner_id, contact_id=contact_id)
    lock_owner_scope(connection, owner_id=owner_id)


def _insert_steps(connection, task_id, steps, count):
    for name, order in steps:
        connection.execute("INSERT INTO public.background_task_step(task_id,step_name,step_order,status,total_count) VALUES(%s,%s,%s,'pending',%s) ON CONFLICT(task_id,step_name) DO NOTHING", (task_id, name, order, count))


def _recover_committed_steps(connection, row, state):
    # 批次内容与业务步骤同事务提交，恢复该事实的回执，不伪造从未执行的核验。
    names = ('preview_upgrade', 'apply_upgrade') if state == 'applied' else ('preview_upgrade',)
    count = len(row['message_ids'])
    for name in names:
        connection.execute(
            "UPDATE public.background_task_step SET status='succeeded',processed_count=%s,total_count=%s,"
            'worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,'
            "finished_at=now(),updated_at=now() WHERE task_id=%s AND step_name=%s AND status<>'succeeded'",
            (count, count, row['task_id'], name),
        )
    first = connection.execute(
        "SELECT step_name FROM public.background_task_step WHERE task_id=%s AND status<>'succeeded' ORDER BY step_order LIMIT 1",
        (row['task_id'],),
    ).fetchone()
    return first['step_name'] if first else None


def _reset_task(connection, task_id, first, *, preserve_succeeded=False):
    order = {'preview_upgrade': 1, 'verify_upgrade_preview': 2, 'apply_upgrade': 3, 'verify_upgrade_apply': 4}[first]
    pending = " AND status<>'succeeded'" if preserve_succeeded else ''
    connection.execute("UPDATE public.background_task_step SET status='pending',attempt_count=0,worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL,finished_at=NULL,updated_at=now() WHERE task_id=%s AND step_order>=%s" + pending, (task_id, order))
    connection.execute("UPDATE public.background_task SET status='queued',current_step=%s,finished_at=NULL,last_error_code=NULL,retry_count=retry_count+1,updated_at=now() WHERE id=%s", (first, task_id))


def _cancel_tasks(connection, ids):
    connection.execute("UPDATE public.background_task SET status='cancelled',finished_at=now(),updated_at=now() WHERE id=ANY(%s::uuid[]) AND status<>'succeeded'", (ids,))
    connection.execute("UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1 WHERE task_id=ANY(%s::uuid[]) AND status<>'succeeded'", (ids,))


def _invalidate(connection, owner_id, ids):
    if not ids:
        return
    from notalone.persistence.memory_upgrade_traces import erase_upgrade_traces
    erase_upgrade_traces(connection, owner_id, ids)
    rows = connection.execute("UPDATE public.memory_upgrade_batch SET state='invalidated',revision=revision+1,message_ids='{}',source_generation='{}',memory_generation=NULL,extracted_outcome=NULL,comparison=NULL,adjudications=NULL,applied_records=NULL,dependency_ids='{}',trace_id=NULL,error_code='sources_changed' WHERE owner_id=%s AND id=ANY(%s::uuid[]) AND state<>'invalidated' RETURNING task_id,job_id", (owner_id, ids)).fetchall()
    values = [(row['task_id'], row['job_id']) if isinstance(row, dict) else row for row in rows]
    _cancel_tasks(connection, [row[0] for row in values])
    connection.execute('UPDATE public.memory_upgrade_job SET revision=revision+1 WHERE owner_id=%s AND id=ANY(%s::uuid[])', (owner_id, list({row[1] for row in values})))


def erase_memory_upgrades(connection, *, owner_id, removed_ids):
    """调用者持有owner锁；全部暂存副本同原删除事务清空，不能恢复。"""
    row = connection.execute("SELECT to_regclass('public.memory_upgrade_batch') IS NOT NULL AS present").fetchone()
    if not row or not (row['present'] if isinstance(row, dict) else row[0]):
        return
    rows = connection.execute("SELECT id FROM public.memory_upgrade_batch WHERE owner_id=%s AND state<>'invalidated' AND dependency_ids && %s::uuid[]", (owner_id, list(removed_ids))).fetchall()
    _invalidate(connection, owner_id, [row['id'] if isinstance(row, dict) else row[0] for row in rows])
