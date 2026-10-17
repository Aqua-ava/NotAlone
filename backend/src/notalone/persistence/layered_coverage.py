"""首次覆盖的持久目标与步骤回执，租约仍由既有任务仓储拥有。"""

from uuid import uuid4
from psycopg.types.json import Jsonb

from notalone.memory.layered import LayeredMemoryConflict
from notalone.persistence.background_tasks import _insert_task_steps
from notalone.tasks.models import BackgroundTaskStepName


def current_job(connection, scope):
    return connection.execute("SELECT * FROM public.layered_memory_job WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s "
        "ORDER BY settings_generation DESC, created_at DESC, task_id DESC", (scope.owner_id,scope.contact_id)).fetchall()


def cancel_jobs(connection, scope, *, erase=False):
    connection.execute("UPDATE public.background_task SET status='cancelled' WHERE id IN ("
        "SELECT task_id FROM public.layered_memory_job WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s) "
        "AND status<>'succeeded'", (scope.owner_id,scope.contact_id))
    connection.execute("UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,"
        "lease_generation=lease_generation+1 WHERE task_id IN (SELECT task_id FROM public.layered_memory_job "
        "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s) AND status<>'succeeded'", (scope.owner_id,scope.contact_id))
    if erase:
        connection.execute("DELETE FROM public.layered_memory_job WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                           (scope.owner_id,scope.contact_id))
    else:
        connection.execute("UPDATE public.layered_memory_job SET state='invalidated',target_manifest='[]',"
            "dependency_ids='{}',revision=revision+1 WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND state<>'complete'",
            (scope.owner_id,scope.contact_id))


def enqueue_coverage(connection, scope, state, manifest, dependencies, contract, budget, *, action, revision, profile_required=False):
    from notalone.persistence.layered_memory import _digest
    key = _digest({"inputs":manifest,"settings_generation":state['settings_generation'],
                   "contract":contract,"budget":budget.to_payload()})
    jobs = current_job(connection,scope)
    job = next((row for row in jobs if row['target_key']==key), None)
    if action in {'pause','continue'}:
        job = next((row for row in jobs if row['settings_generation']==state['settings_generation']),None)
        if not job or revision is None:
            raise LayeredMemoryConflict('首次覆盖工作已变化。')
        if job['revision'] != revision:
            if job['revision']==revision+1 and job['last_action']==action:
                return job['task_id'], False
            raise LayeredMemoryConflict('首次覆盖进度已变化。')
        if job['target_key'] != key or job['state']=='invalidated':
            raise LayeredMemoryConflict('首次覆盖的实际资料已变化。')
        if action=='pause':
            connection.execute("UPDATE public.layered_memory_job SET state='paused',revision=revision+1,last_action='pause' "
                               "WHERE task_id=%s", (job['task_id'],))
            connection.execute("UPDATE public.layered_memory_state SET status='paused' WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                               (scope.owner_id,scope.contact_id))
            connection.execute("UPDATE public.background_task_step SET status='pending',worker_id=NULL,lease_expires_at=NULL,"
                "lease_generation=lease_generation+1 WHERE task_id=%s",(job['task_id'],))
            return job['task_id'],False
        if job['state']=='complete':
            return job['task_id'],False
        if job['state'] not in {'paused','failed'}:
            raise LayeredMemoryConflict('当前工作无需继续。')
        connection.execute("UPDATE public.layered_memory_job SET state='active',revision=revision+1,last_action='continue',"
            "run_remaining=1,model_call_limit=model_call_limit+%s WHERE task_id=%s", (budget.max_model_calls,job['task_id'],))
        connection.execute("UPDATE public.background_task SET status='queued',last_error_code=NULL,finished_at=NULL "
                           "WHERE id=%s", (job['task_id'],))
        connection.execute("UPDATE public.background_task_step SET status='pending',attempt_count=0,worker_id=NULL,"
            "lease_expires_at=NULL,lease_generation=lease_generation+1,last_error_code=NULL WHERE task_id=%s", (job['task_id'],))
        connection.execute("UPDATE public.layered_memory_state SET status='updating',error_code=NULL "
                           "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id,scope.contact_id))
        return job['task_id'],True
    if job:
        if job['state'] == 'complete':
            connection.execute("UPDATE public.layered_memory_state SET consumed_revision=dirty_revision,next_due_at=NULL "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id, scope.contact_id))
        # 画像重试复用已提交L2的精确回执，只有用户continue才增加授权额度。
        if profile_required and job['pending_receipt'] and job['state'] in {'failed','paused'}:
            if job['model_calls_used'] >= job['model_call_limit']:
                connection.execute("UPDATE public.layered_memory_job SET state='paused' WHERE task_id=%s",(job['task_id'],))
                connection.execute("UPDATE public.layered_memory_state SET status='paused',error_code='model_call_budget_exhausted' "
                    "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",(scope.owner_id,scope.contact_id))
                return job['task_id'],False
            error=connection.execute("SELECT error_code FROM public.layered_memory_state WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                (scope.owner_id,scope.contact_id)).fetchone()['error_code']
            if job['state']=='failed' and error in {'model_call_failed','model_call_timeout','profile_attempt_interrupted'}:
                connection.execute("UPDATE public.layered_memory_job SET state='active',profile_status='pending' WHERE task_id=%s",(job['task_id'],))
                connection.execute("UPDATE public.background_task SET status='queued',finished_at=NULL,last_error_code=NULL WHERE id=%s",(job['task_id'],))
                connection.execute("UPDATE public.background_task_step SET status='pending',attempt_count=0,worker_id=NULL,"
                    "lease_expires_at=NULL,last_error_code=NULL WHERE task_id=%s",(job['task_id'],))
                return job['task_id'],True
        return job['task_id'],job['state']=='active'
    cancel_jobs(connection,scope)
    task_id=uuid4()
    connection.execute("INSERT INTO public.background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) "
        "VALUES(%s,%s,%s,'layered_memory','queued','organize_memory',%s)", (task_id,scope.owner_id,scope.contact_id,len(manifest)))
    _insert_task_steps(connection,task_id=task_id,steps=((BackgroundTaskStepName.ORGANIZE_MEMORY,1),),total_count=len(manifest))
    connection.execute("INSERT INTO public.layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,"
        "contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required,profile_status) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'active',1,%s,%s,%s)",
        (task_id,scope.owner_id,scope.contact_id,state['settings_generation'],key,contract,Jsonb(manifest),sorted(dependencies),budget.max_model_calls,profile_required,'pending' if profile_required else 'not_required'))
    connection.execute("UPDATE public.layered_memory_job SET target_dirty_revision=%s WHERE task_id=%s",
                       (state['dirty_revision'], task_id))
    connection.execute("UPDATE public.layered_memory_state SET next_due_at=NULL WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                       (scope.owner_id,scope.contact_id))
    covered={item['memory_id'] for row in connection.execute(
        "SELECT b.input_manifest FROM public.layered_memory_generation g JOIN public.scenario_document_version v "
        "ON v.id=ANY(g.scenario_version_ids) AND v.owner_id=g.owner_id AND v.contact_id IS NOT DISTINCT FROM g.contact_id "
        "JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE g.owner_id=%s AND g.contact_id IS NOT DISTINCT FROM %s "
        "AND g.organization_generation=%s",(scope.owner_id,scope.contact_id,state['organization_generation'])).fetchall()
        for item in row['input_manifest']}
    if not {item['memory_id'] for item in manifest}-covered and not (profile_required and manifest):
        connection.execute("UPDATE public.layered_memory_job SET state='complete' WHERE task_id=%s",(task_id,))
        connection.execute("UPDATE public.background_task SET status='succeeded',finished_at=now() WHERE id=%s",(task_id,))
        connection.execute("UPDATE public.background_task_step SET status='succeeded',finished_at=now() WHERE task_id=%s",(task_id,))
        connection.execute("UPDATE public.layered_memory_state SET status=%s,covered_count=%s,error_code=NULL WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
            ('ready' if manifest or covered else 'empty',len(covered | {item['memory_id'] for item in manifest}),scope.owner_id,scope.contact_id))
        connection.execute("UPDATE public.layered_memory_state SET consumed_revision=dirty_revision WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                           (scope.owner_id,scope.contact_id))
        return task_id,False
    connection.execute("UPDATE public.layered_memory_state SET status='updating',error_code=NULL WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                       (scope.owner_id,scope.contact_id))
    return task_id,True


def finish_coverage_receipt(connection, claim):
    """同一正式回执收口两层；L3失败不抹掉已发布L2或吞掉画像暂停。"""
    job=connection.execute("SELECT state,pending_receipt,profile_required,profile_status,model_calls_used,model_call_limit "
        "FROM public.layered_memory_job WHERE task_id=%s FOR UPDATE",(claim.task_id,)).fetchone()
    if not job or job[0]!='active':
        raise LayeredMemoryConflict('覆盖工作已撤销或暂停。')
    _,receipt,profile_required,profile_status,used,limit=job
    proof=connection.execute("SELECT j.target_manifest,j.receipt_lease_generation,b.status,b.settings_generation,j.settings_generation,"
        "j.receipt_batch_id,s.covered_count,s.error_code FROM public.layered_memory_job j "
        "JOIN public.layered_memory_state s ON s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id "
        "LEFT JOIN public.layered_memory_batch b ON b.id=j.receipt_batch_id AND b.task_id=j.task_id "
        "WHERE j.task_id=%s",(claim.task_id,)).fetchone()
    profile_only=profile_required and proof[5] is None and proof[6]>=len(proof[0])
    if receipt and proof[0] and not profile_only and (proof[2]!='succeeded' or proof[3]!=proof[4]
            or proof[1] is None or proof[1]>claim.lease_generation):
        raise LayeredMemoryConflict('精确批次的发布证明已变化。')
    if receipt and profile_required and profile_status!='succeeded' and proof[0]:
        exhausted=proof[7]=='model_call_budget_exhausted'
        error='model_call_budget_exhausted' if exhausted else proof[7] or 'profile_attempt_interrupted'
        state='paused' if exhausted else 'failed'
        # 保留精确L2回执，恢复仅补画像；不递减本批推进数或再次生成L2。
        connection.execute("UPDATE public.layered_memory_job SET state=%s WHERE task_id=%s",(state,claim.task_id))
        connection.execute("UPDATE public.background_task SET status='failed',finished_at=now(),last_error_code=%s WHERE id=%s",(error,claim.task_id))
        connection.execute("UPDATE public.background_task_step SET status='failed',last_error_code=%s WHERE id=%s",(error,claim.step_id))
        connection.execute("UPDATE public.layered_memory_state SET status=%s,error_code=%s WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
            (state,error,claim.owner_id,claim.contact_id))
        return
    connection.execute("UPDATE public.layered_memory_job SET pending_receipt=false,receipt_batch_id=NULL,receipt_lease_generation=NULL,"
        "run_remaining=GREATEST(0,run_remaining-1) WHERE task_id=%s",(claim.task_id,))
    row=connection.execute("SELECT j.target_manifest,j.run_remaining,s.covered_count FROM public.layered_memory_job j "
        "JOIN public.layered_memory_state s ON s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id WHERE task_id=%s",
        (claim.task_id,)).fetchone()
    exhausted=proof[7] in {'model_budget_exhausted','model_call_budget_exhausted'}
    failed=not receipt and not exhausted
    remaining=max(0,len(row[0])-row[2])
    job_state='failed' if failed else 'paused' if exhausted or remaining and row[1]==0 else 'active' if remaining else 'complete'
    if job_state == 'complete':
        connection.execute("UPDATE public.layered_memory_state s SET consumed_revision=GREATEST(s.consumed_revision,j.target_dirty_revision) "
            "FROM public.layered_memory_job j WHERE j.task_id=%s AND s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id",
            (claim.task_id,))
    connection.execute("UPDATE public.layered_memory_job SET state=%s WHERE task_id=%s", (job_state,claim.task_id))
    connection.execute("UPDATE public.background_task SET status=%s,finished_at=CASE WHEN %s THEN now() ELSE NULL END "
        "WHERE id=%s", ('failed' if failed else 'queued' if remaining else 'succeeded',not remaining,claim.task_id))
    if remaining and not failed:
        connection.execute("UPDATE public.background_task_step SET status='pending',attempt_count=0,worker_id=NULL,"
            "lease_expires_at=NULL,finished_at=NULL WHERE task_id=%s",(claim.task_id,))
    connection.execute("UPDATE public.layered_memory_state SET status=%s WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
        ('failed' if failed else 'paused' if remaining else 'ready' if row[0] else 'empty',claim.owner_id,claim.contact_id))
