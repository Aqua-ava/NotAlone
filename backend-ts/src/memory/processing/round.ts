/** 固定轮次的执行收口；轮次只为真实任务记录聚合，不另建第二套执行状态。 */
import type pg from 'pg';
import {
  managementInputs,
  managementState,
  refreshManagementGeneration,
  enqueueManagementJob,
} from '../records/documents/store.ts';
import type {L2ScenarioBudget} from '../scenarios/workspace.ts';

interface RoundTaskScope {
  ownerId: string;
  contactId: string | null;
  taskId: string;
}

export interface AcceptedProcessingRound {
  id: string;
  round_number: number;
  control_generation: number;
}

/**
 * 新任务只在范围没有当前轮次时接纳首轮。已有完成或受阻轮次时保留新任务
 * 为后续待处理，由下一轮的显式调度合同接管。
 */
export async function acceptTaskIntoProcessingRound(
  client: pg.ClientBase,
  scope: {ownerId:string;contactId:string|null},
  taskId: string,
  options: {
    unit?:'messages'|'memories'|'steps';
    targetCount?:number;
    reuseActiveRound?:boolean;
  } = {},
): Promise<AcceptedProcessingRound | null> {
  await client.query(
    `INSERT INTO public.memory_processing_scope(owner_id,contact_id)
     VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [scope.ownerId, scope.contactId],
  );
  const control = (await client.query(
    `SELECT * FROM public.memory_processing_scope
     WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
     FOR UPDATE`,
    [scope.ownerId, scope.contactId],
  )).rows[0];
  const unit = options.unit ?? 'messages';
  if (!control) return null;
  let activeRound: {
    id:string;
    round_number:string;
    control_generation:string;
    status:string;
  } | null = null;
  let reuseActiveRound = false;
  if (control.active_round_id) {
    activeRound = (await client.query(
      `SELECT id,round_number,control_generation,status
       FROM public.memory_processing_round WHERE id=$1`,
      [control.active_round_id],
    )).rows[0] ?? null;
    if (!activeRound) return null;
    if (unit === 'messages') {
      return activeRound.status === 'completed'
        ? startNextMemoryProcessingRoundIfReady(client, scope)
        : null;
    }
    if (unit !== 'memories') return null;
    if (activeRound.status === 'completed') {
      activeRound = null;
    } else if (options.reuseActiveRound
      && ['waiting','processing'].includes(activeRound.status)) {
      reuseActiveRound = true;
    } else {
      return null;
    }
  }
  let targetCount = options.targetCount ?? null;
  let targetIds: string[] = [];
  if (unit === 'messages') {
    targetIds = (await client.query(
      `SELECT target.message_id
       FROM public.memory_processing_target target
       WHERE target.task_id=$1 AND target.owner_id=$2
         AND target.contact_id IS NOT DISTINCT FROM $3::uuid
         AND target.completed_at IS NULL
         AND NOT EXISTS(
           SELECT 1 FROM public.memory_processing_round_target assigned
           WHERE assigned.task_id=target.task_id
             AND assigned.message_id=target.message_id
         )`,
      [taskId, scope.ownerId, scope.contactId],
    )).rows.map((row: {message_id:string}) => row.message_id);
    targetCount = targetIds.length;
  }
  if (targetCount !== null && (!Number.isSafeInteger(targetCount) || targetCount < 0)) {
    throw new Error('memory_processing_round_target_invalid');
  }
  if (targetCount === 0) return null;
  let round;
  if (reuseActiveRound && activeRound) {
    round = activeRound;
    await client.query(
      `UPDATE public.memory_processing_round_task membership SET active=false
       FROM public.background_task task
       WHERE membership.round_id=$1 AND membership.active
         AND task.id=membership.task_id AND task.task_type='layered_memory'
         AND membership.owner_id=$2
         AND membership.contact_id IS NOT DISTINCT FROM $3::uuid`,
      [round.id, scope.ownerId, scope.contactId],
    );
  } else {
    const next = Number((await client.query(
      `SELECT COALESCE(max(round_number),0)+1 AS round_number
       FROM public.memory_processing_round WHERE scope_id=$1`,
      [control.id],
    )).rows[0].round_number);
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new Error('memory_processing_round_number_invalid');
    }
    round = (await client.query(
      `INSERT INTO public.memory_processing_round
         (scope_id,owner_id,contact_id,round_number,control_generation,status,phase)
       VALUES($1,$2,$3,$4,$5,'waiting','extraction')
       RETURNING id,round_number,control_generation,status`,
      [control.id, scope.ownerId, scope.contactId, next, control.control_generation],
    )).rows[0];
    await client.query(
      'UPDATE public.memory_processing_scope SET active_round_id=$2,updated_at=clock_timestamp() WHERE id=$1',
      [control.id, round.id],
    );
    await client.query(
      `UPDATE public.memory_processing_round_task SET active=false
       WHERE task_id=$1 AND owner_id=$2
         AND contact_id IS NOT DISTINCT FROM $3::uuid AND active`,
      [taskId, scope.ownerId, scope.contactId],
    );
  }
  await client.query(
    `INSERT INTO public.memory_processing_round_task
       (round_id,task_id,owner_id,contact_id,active)
     VALUES($1,$2,$3,$4,true)
     ON CONFLICT(round_id,task_id) DO UPDATE SET active=true`,
    [round.id, taskId, scope.ownerId, scope.contactId],
  );
  if (unit === 'messages') {
    const frozen = await client.query(
      `INSERT INTO public.memory_processing_round_target(round_id,task_id,message_id)
       SELECT $1,$2,message_id FROM unnest($3::uuid[]) message_id
       ON CONFLICT DO NOTHING RETURNING message_id`,
      [round.id, taskId, targetIds],
    );
    if (frozen.rowCount !== targetCount) {
      throw new Error('memory_processing_round_target_snapshot_invalid');
    }
  }
  await client.query(
    `UPDATE public.memory_processing_round round
     SET target_unit=$2,target_count=$3,
       phase=CASE WHEN $2='memories' THEN 'topics' ELSE phase END
     WHERE id=$1`,
    [round.id, unit, targetCount],
  );
  return {
    id: round.id,
    round_number: Number(round.round_number),
    control_generation: Number(round.control_generation),
  };
}

/** 当前轮结束后，只把尚未归轮的合法消息目标及所属真实任务组成下一轮。 */
export async function startNextMemoryProcessingRoundIfReady(
  client: pg.ClientBase,
  scope: {ownerId:string;contactId:string|null},
): Promise<AcceptedProcessingRound | null> {
  if (scope.contactId === null) return null;
  const control = (await client.query(
    `SELECT * FROM public.memory_processing_scope
     WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE`,
    [scope.ownerId, scope.contactId],
  )).rows[0];
  if (!control?.active_round_id || control.intent === 'pause') return null;
  const active = (await client.query(
    `SELECT id,status,control_generation
     FROM public.memory_processing_round
     WHERE id=$1 AND scope_id=$2
     FOR UPDATE`,
    [control.active_round_id, control.id],
  )).rows[0];
  if (!active || active.status !== 'completed'
    || Number(active.control_generation) !== Number(control.control_generation)) {
    return null;
  }
  const pending = (await client.query(
    `SELECT DISTINCT ON (target.message_id) target.task_id,target.message_id
     FROM public.memory_processing_target target
     JOIN public.background_task task
       ON task.id=target.task_id AND task.owner_id=target.owner_id
       AND task.contact_id=target.contact_id
     WHERE target.owner_id=$1 AND target.contact_id=$2
       AND target.completed_at IS NULL
       AND task.task_type IN ('import','observation')
       AND task.status IN ('queued','running','verifying','succeeded')
       AND (
         task.task_type='import' AND EXISTS(
           SELECT 1 FROM public.source_document source
           WHERE source.id=task.source_document_id AND source.owner_id=task.owner_id
             AND source.contact_id=task.contact_id AND source.status='active'
         )
         OR task.task_type='observation' AND EXISTS(
           SELECT 1 FROM public.conversation_binding binding
           WHERE binding.owner_id=task.owner_id AND binding.contact_id=task.contact_id
             AND binding.status='active'
         )
       )
       AND NOT EXISTS(
         SELECT 1 FROM public.memory_processing_round_target assigned
         WHERE assigned.task_id=target.task_id
           AND assigned.message_id=target.message_id
       )
       AND NOT EXISTS(
         SELECT 1 FROM public.memory_processing_receipt receipt
         WHERE receipt.message_id=target.message_id
           AND receipt.owner_id=target.owner_id
           AND receipt.contact_id=target.contact_id
       )
     ORDER BY target.message_id,target.task_id`,
    [scope.ownerId, scope.contactId],
  )).rows as {task_id:string;message_id:string}[];
  if (!pending.length) return null;
  const taskIds = [...new Set(pending.map(row => row.task_id))];
  const messageIds = new Set(pending.map(row => row.message_id));
  const next = Number((await client.query(
    `SELECT COALESCE(max(round_number),0)+1 AS round_number
     FROM public.memory_processing_round WHERE scope_id=$1`,
    [control.id],
  )).rows[0].round_number);
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error('memory_processing_round_number_invalid');
  }
  const round = (await client.query(
    `INSERT INTO public.memory_processing_round
       (scope_id,owner_id,contact_id,round_number,control_generation,status,phase,target_unit,target_count)
     VALUES($1,$2,$3,$4,$5,'waiting','extraction','messages',$6)
     RETURNING id,round_number,control_generation`,
    [
      control.id,
      scope.ownerId,
      scope.contactId,
      next,
      control.control_generation,
      messageIds.size,
    ],
  )).rows[0];
  await client.query(
    `UPDATE public.memory_processing_scope
     SET active_round_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [control.id, round.id],
  );
  // 同一观察任务可能在本轮运行中登记了后续目标；前一轮结束后从提取阶段
  // 重新排队该原任务。保留重试与回执，不新建任务或刷新累计预算。
  await client.query(
    `UPDATE public.background_task_step step
     SET status='pending',attempt_count=0,processed_count=0,
       total_count=CASE WHEN step.step_name IN ('extract_memory','index','verify')
         THEN $3 ELSE step.total_count END,
       worker_id=NULL,lease_expires_at=NULL,last_error_code=NULL,
       started_at=NULL,finished_at=NULL,updated_at=clock_timestamp()
     FROM public.background_task task
     WHERE step.task_id=task.id AND task.id=ANY($1::uuid[])
       AND task.owner_id=$2 AND task.contact_id=$4 AND task.status='succeeded'`,
    [taskIds, scope.ownerId, messageIds.size, scope.contactId],
  );
  await client.query(
    `UPDATE public.background_task task
     SET status='queued',
       current_step=CASE WHEN task.task_type='observation' THEN 'extract_memory' ELSE 'parse' END,
       message_count=GREATEST(task.message_count,$3),observation_pending=false,
       last_error_code=NULL,started_at=NULL,finished_at=NULL,updated_at=clock_timestamp()
     WHERE task.id=ANY($1::uuid[]) AND task.owner_id=$2
       AND task.contact_id=$4 AND task.status='succeeded'`,
    [taskIds, scope.ownerId, messageIds.size, scope.contactId],
  );
  await client.query(
    `UPDATE public.memory_processing_round_task SET active=false
     WHERE task_id=ANY($1::uuid[]) AND owner_id=$2
       AND contact_id=$3 AND active`,
    [taskIds, scope.ownerId, scope.contactId],
  );
  await client.query(
    `INSERT INTO public.memory_processing_round_task
       (round_id,task_id,owner_id,contact_id,active)
     SELECT $1,task_id,$2,$3,true FROM unnest($4::uuid[]) task_id
     ON CONFLICT(round_id,task_id) DO UPDATE SET active=true`,
    [round.id, scope.ownerId, scope.contactId, taskIds],
  );
  const frozen = await client.query(
    `INSERT INTO public.memory_processing_round_target(round_id,task_id,message_id)
     SELECT $1,task_id,message_id FROM unnest($2::uuid[],$3::uuid[]) AS pending(task_id,message_id)
     ON CONFLICT DO NOTHING RETURNING message_id`,
    [
      round.id,
      pending.map(row => row.task_id),
      pending.map(row => row.message_id),
    ],
  );
  if (frozen.rowCount !== pending.length) {
    throw new Error('memory_processing_round_target_snapshot_invalid');
  }
  return {
    id: round.id,
    round_number: Number(round.round_number),
    control_generation: Number(round.control_generation),
  };
}

export async function markRoundTaskProcessing(
  client: pg.ClientBase,
  scope: RoundTaskScope,
  phase: 'extraction'|'verification'|'topics'|'profile'|'retry',
): Promise<void> {
  await client.query(
    `UPDATE public.memory_processing_round round
     SET status='processing',phase=$4
     FROM public.memory_processing_round_task membership,
       public.memory_processing_scope control
     WHERE membership.round_id=round.id AND membership.task_id=$1
       AND control.id=round.scope_id AND control.active_round_id=round.id
       AND membership.owner_id=$2
       AND membership.contact_id IS NOT DISTINCT FROM $3::uuid
       AND membership.active AND control.intent='run'
       AND round.control_generation=control.control_generation
       AND round.status IN ('waiting','processing')`,
    [scope.taskId, scope.ownerId, scope.contactId, phase],
  );
}

/** 旧主题画像入口的显式继续只重开由该原任务造成的受阻轮次。 */
export async function reopenMemoryProcessingRoundForExplicitTaskContinue(
  client: pg.ClientBase,
  scope: RoundTaskScope,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE public.memory_processing_round round
     SET status='waiting',completed_at=NULL
     FROM public.memory_processing_round_task membership,
       public.memory_processing_scope control
     WHERE membership.round_id=round.id AND membership.task_id=$3
       AND control.id=round.scope_id AND control.active_round_id=round.id
       AND membership.owner_id=$1
       AND membership.contact_id IS NOT DISTINCT FROM $2::uuid
       AND membership.active AND control.intent='run'
       AND round.owner_id=$1 AND round.contact_id IS NOT DISTINCT FROM $2::uuid
       AND round.status='blocked'
       AND NOT EXISTS(
         SELECT 1 FROM public.memory_processing_round_task other_membership
         JOIN public.background_task other_task ON other_task.id=other_membership.task_id
         WHERE other_membership.round_id=round.id AND other_membership.active
           AND other_membership.task_id<>membership.task_id
           AND other_task.status IN ('failed','cancelled')
       )
     RETURNING round.id`,
    [scope.ownerId, scope.contactId, scope.taskId],
  );
  return result.rowCount === 1;
}

export interface MemoryProcessingOrganization {
  budget: L2ScenarioBudget;
  contract?: string;
}

/** 仅在轮次内全部有效任务成功且没有继续等待时完成；失败仍由任务事实保留。 */
export async function completeMemoryProcessingRoundIfReady(
  client: pg.ClientBase,
  scope: RoundTaskScope,
): Promise<boolean> {
  const result = await client.query(
    `WITH candidate AS (
       SELECT round.id
       FROM public.memory_processing_round_task membership
       JOIN public.memory_processing_round round
         ON round.id=membership.round_id AND round.owner_id=membership.owner_id
       JOIN public.memory_processing_scope control
         ON control.id=round.scope_id AND control.active_round_id=round.id
       WHERE membership.task_id=$1 AND membership.owner_id=$2
         AND membership.contact_id IS NOT DISTINCT FROM $3::uuid
         AND membership.active AND control.intent='run'
         AND round.status IN ('waiting','processing')
         AND (round.target_unit IS DISTINCT FROM 'messages' OR (
           round.target_count=(
             SELECT count(*) FROM public.memory_processing_round_target snapshot
             WHERE snapshot.round_id=round.id
           )
           AND NOT EXISTS(
             SELECT 1
             FROM public.memory_processing_round_target snapshot
             JOIN public.memory_processing_target target
               ON target.task_id=snapshot.task_id AND target.message_id=snapshot.message_id
             WHERE snapshot.round_id=round.id
               AND (target.completed_at IS NULL
                OR target.outcome NOT IN ('succeeded','skipped'))
           )
         ))
         AND NOT EXISTS(
           SELECT 1
           FROM public.memory_processing_round_task active_membership
           JOIN public.background_task task ON task.id=active_membership.task_id
           WHERE active_membership.round_id=round.id AND active_membership.active
             AND task.status<>'succeeded'
         )
       FOR UPDATE OF round
     )
     UPDATE public.memory_processing_round round
     SET status='completed',completed_at=clock_timestamp()
     FROM candidate
     WHERE round.id=candidate.id
     RETURNING round.id`,
    [scope.taskId, scope.ownerId, scope.contactId],
  );
  if (result.rowCount !== 1) return false;
  await startNextMemoryProcessingRoundIfReady(client, scope);
  return true;
}

/** 当前轮次之外新增、仍未归入任何轮次的合法消息目标；供 04 自动接纳后续轮次。 */
export async function pendingProcessingTargetCount(
  client: pg.ClientBase,
  scope: {ownerId:string;contactId:string|null},
): Promise<number> {
  if (scope.contactId === null) return 0;
  const count = Number((await client.query(
    `SELECT count(DISTINCT target.message_id)::int AS n
     FROM public.memory_processing_target target
     JOIN public.memory_processing_scope control
       ON control.owner_id=target.owner_id
       AND control.contact_id IS NOT DISTINCT FROM target.contact_id
     WHERE target.owner_id=$1 AND target.contact_id=$2
       AND target.completed_at IS NULL
       AND control.active_round_id IS NOT NULL
       AND EXISTS(
         SELECT 1 FROM public.memory_processing_round_target snapshot
         WHERE snapshot.round_id=control.active_round_id
       )
       AND NOT EXISTS(
         SELECT 1 FROM public.memory_processing_round_target assigned
         WHERE assigned.task_id=target.task_id
           AND assigned.message_id=target.message_id
       )
       AND NOT EXISTS(
         SELECT 1 FROM public.memory_processing_receipt receipt
         WHERE receipt.message_id=target.message_id
           AND receipt.owner_id=target.owner_id
           AND receipt.contact_id=target.contact_id
       )`,
    [scope.ownerId, scope.contactId],
  )).rows[0].n);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('memory_processing_pending_count_invalid');
  }
  return count;
}

/** 任务失败或中断时保留真实执行事实，让统一状态显示受阻而非继续处理中。 */
export async function blockMemoryProcessingRound(
  client: pg.ClientBase,
  scope: RoundTaskScope,
): Promise<void> {
  await client.query(
    `UPDATE public.memory_processing_round round
     SET status='blocked'
     FROM public.memory_processing_round_task membership,
       public.memory_processing_scope control
     WHERE membership.round_id=round.id AND membership.task_id=$1
       AND control.id=round.scope_id AND control.active_round_id=round.id
       AND membership.owner_id=$2
       AND membership.contact_id IS NOT DISTINCT FROM $3::uuid
       AND membership.active AND round.status IN ('waiting','processing')`,
    [scope.taskId, scope.ownerId, scope.contactId],
  );
}

/**
 * 提取完成后的唯一阶段衔接。只把本轮消息产生的合法记忆交给现有 L2/L3
 * 管理任务；无主题工作即结束阶段，不创建空模型调用。
 */
export async function continueMemoryProcessingAfterExtraction(
  client: pg.PoolClient,
  scope: RoundTaskScope,
  organization: MemoryProcessingOrganization | undefined,
): Promise<'organization'|'completed'|'blocked'|'waiting'> {
  const round = (await client.query(
    `SELECT round.id,round.status,round.control_generation,control.control_generation
     FROM public.memory_processing_round_task membership
     JOIN public.memory_processing_round round
       ON round.id=membership.round_id AND round.owner_id=membership.owner_id
     JOIN public.memory_processing_scope control
       ON control.id=round.scope_id AND control.active_round_id=round.id
     WHERE membership.task_id=$1 AND membership.owner_id=$2
       AND membership.contact_id IS NOT DISTINCT FROM $3::uuid
       AND membership.active AND control.intent='run'
       AND round.control_generation=control.control_generation
       AND round.status IN ('waiting','processing')
     FOR UPDATE OF round,control`,
    [scope.taskId, scope.ownerId, scope.contactId],
  )).rows[0];
  if (!round) return 'blocked';
  const pending = (await client.query(
    `SELECT 1
     FROM public.memory_processing_round_task membership
     JOIN public.background_task task ON task.id=membership.task_id
     WHERE membership.round_id=$1 AND membership.active AND task.status<>'succeeded'
     LIMIT 1`,
    [round.id],
  )).rowCount === 1;
  if (pending) return 'waiting';

  if (!organization) {
    return await completeMemoryProcessingRoundIfReady(client, scope)
      ? 'completed'
      : 'blocked';
  }

  const layer = (await client.query(
    `SELECT enabled
     FROM public.layered_memory_state
     WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
    [scope.ownerId, scope.contactId],
  )).rows[0];
  if (!layer?.enabled) {
    return await completeMemoryProcessingRoundIfReady(client, scope)
      ? 'completed'
      : 'blocked';
  }

  // PoolClient 与 Client 的公开 query 合同相同；管理模块沿用既有 Client 类型。
  const managementClient = client as unknown as pg.Client;
  const inputs = await managementInputs(
    managementClient,
    {owner_id:scope.ownerId, contact_id:scope.contactId},
    new Date(),
  );
  const relevant = new Set(
    (await client.query(
      `SELECT DISTINCT memory.id
       FROM (
         SELECT id,contact_id,source_ids
         FROM public.confirmed_memory
         WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
           AND status='active'
         UNION ALL
         SELECT id,NULL::uuid,source_ids
         FROM public.owner_memory
         WHERE owner_id=$1 AND status='active'
       ) memory
       WHERE $2::uuid IS NOT NULL
         AND EXISTS(
           SELECT 1
           FROM public.memory_processing_round_task membership
           JOIN public.memory_processing_target target
             ON target.task_id=membership.task_id
           JOIN public.message_source_ref ref
             ON ref.message_id=target.message_id AND ref.owner_id=target.owner_id
              AND ref.contact_id=target.contact_id
           WHERE membership.round_id=$3 AND membership.active
             AND (
               NOT EXISTS(
                 SELECT 1 FROM public.memory_processing_round_target snapshot
                 WHERE snapshot.round_id=$3
               )
               OR EXISTS(
                 SELECT 1 FROM public.memory_processing_round_target snapshot
                 WHERE snapshot.round_id=$3 AND snapshot.task_id=target.task_id
                   AND snapshot.message_id=target.message_id
               )
             )
             AND (
               target.message_id=ANY(memory.source_ids)
               OR ref.source_document_id=ANY(memory.source_ids)
               OR ref.observation_id=ANY(memory.source_ids)
             )
         )`,
      [scope.ownerId, scope.contactId, round.id],
    )).rows.map((row: {id:string}) => row.id),
  );
  if (!relevant.size) {
    return await completeMemoryProcessingRoundIfReady(client, scope)
      ? 'completed'
      : 'blocked';
  }
  const entries = inputs.entries.filter(entry =>
    relevant.has(entry.memory.memory_id));
  const manifest = inputs.manifest.filter(item =>
    relevant.has(String(item.memory_id)));
  if (!manifest.length) {
    return await completeMemoryProcessingRoundIfReady(client, scope)
      ? 'completed'
      : 'blocked';
  }
  const dependencies = [...new Set(entries.flatMap(entry => [
    entry.memory.memory_id,
    ...(entry.dependency_ids ?? []),
  ]))].sort();
  const narrowed = {entries, manifest, dependencies};
  const current = await refreshManagementGeneration(
    managementClient,
    {owner_id:scope.ownerId, contact_id:scope.contactId},
    await managementState(managementClient, {
      owner_id:scope.ownerId,
      contact_id:scope.contactId,
    }),
    narrowed,
  );
  const queued = await enqueueManagementJob(
    managementClient,
    {owner_id:scope.ownerId, contact_id:scope.contactId},
    current,
    narrowed,
    organization.budget,
    organization.contract
      ?? 'scenario-v3:verified_items:document-tools-v1:profile-tools-v1:typescript-management-v1',
    'refresh',
  );
  await client.query(
    `INSERT INTO public.memory_processing_round_task
       (round_id,task_id,owner_id,contact_id,active)
     VALUES($1,$2,$3,$4,true)
     ON CONFLICT(round_id,task_id) DO UPDATE SET active=true`,
    [round.id, queued.taskId, scope.ownerId, scope.contactId],
  );
  await client.query(
    `UPDATE public.memory_processing_round
     SET status='processing',phase='topics'
     WHERE id=$1 AND status IN ('waiting','processing')`,
    [round.id],
  );
  if (!queued.execute) {
    return await completeMemoryProcessingRoundIfReady(client, scope)
      ? 'completed'
      : 'waiting';
  }
  return 'organization';
}
