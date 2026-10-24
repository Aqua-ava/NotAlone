/** 唯一任务 Worker 的 L2 执行 seam；Runner 不领租约，完成函数不越过原事务。 */
import type pg from 'pg';
import type {L2ScenarioHostCandidate} from './l2-scenario-host.ts';
import type {L2ScenarioClaim} from './l2-scenario-service.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface L2ScenarioWorkerClaim {
  ownerId: string;
  contactId: string | null;
  taskId: string;
  stepId: string;
  stepName: string;
  workerId: string;
  leaseGeneration: number;
  messageCount: number;
}

export interface L2ScenarioWorkerRun {
  processedCount: number;
  totalCount: number;
}

export interface L2ScenarioWorkerCompletion extends L2ScenarioWorkerRun {
  state: 'active' | 'complete' | 'failed' | 'paused';
}

export class L2ScenarioWorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

function workerConflict(code: string, retryable = false): never {
  throw new L2ScenarioWorkerError(code, retryable);
}

function checkedClaim(claim: L2ScenarioWorkerClaim): void {
  if (
    !claim
    || claim.stepName !== 'organize_memory'
    || ![claim.ownerId, claim.contactId, claim.taskId, claim.stepId, claim.workerId]
      .filter((value): value is string => value !== null)
      .every(value => UUID.test(value))
    || claim.contactId !== null && !UUID.test(claim.contactId)
    || !Number.isSafeInteger(claim.leaseGeneration)
    || claim.leaseGeneration < 1
    || !Number.isSafeInteger(claim.messageCount)
    || claim.messageCount < 0
  ) workerConflict('l2_scenario_worker_claim_invalid');
}

function modelClaim(claim: L2ScenarioWorkerClaim): L2ScenarioClaim {
  return {
    task_id: claim.taskId,
    step_id: claim.stepId,
    step_name: 'organize_memory',
    worker_id: claim.workerId,
    lease_generation: claim.leaseGeneration,
  };
}

/** Worker 只调用 L2 暂存/发布；任务完成与回执仍由唯一任务存储负责。 */
export function createL2ScenarioWorkerRunner(
  host: Pick<L2ScenarioHostCandidate, 'run'>,
): {run(claim: L2ScenarioWorkerClaim, signal: AbortSignal): Promise<L2ScenarioWorkerRun>} {
  return {
    async run(claim, signal) {
      checkedClaim(claim);
      signal.throwIfAborted();
      const result = await host.run(
        {owner_id: claim.ownerId, contact_id: claim.contactId},
        modelClaim(claim),
        signal,
      );
      signal.throwIfAborted();
      return {
        processedCount: result.processed_count,
        totalCount: claim.messageCount,
      };
    },
  };
}

/**
 * 在唯一任务 Worker 的同一事务内完成 organize_memory 步骤并收口 L2 回执。
 * profile_required 属票14 L3；已发布的L2回执保持待处理，任务按原失败/暂停
 * 语义交给后续L3，不伪造完成或再次生成L2。
 */
export async function completeL2ScenarioWorkerStep(
  client: pg.ClientBase,
  claim: L2ScenarioWorkerClaim,
  processedCount: number,
): Promise<L2ScenarioWorkerCompletion> {
  checkedClaim(claim);
  if (!Number.isSafeInteger(processedCount) || processedCount < 0) {
    workerConflict('l2_scenario_worker_count_invalid');
  }
  const row = (await client.query(`SELECT t.status AS task_status,s.status AS step_status,
    s.worker_id,s.lease_generation AS step_lease_generation,
    s.lease_expires_at>clock_timestamp() AS lease_valid,
    j.contract,j.state AS job_state,j.pending_receipt,j.profile_required,j.profile_status,
    j.settings_generation,j.target_manifest,j.receipt_batch_id,j.receipt_lease_generation,j.run_remaining,
    b.status AS batch_status,b.settings_generation AS batch_settings_generation,b.input_manifest AS batch_input_manifest,
    state.enabled,state.settings_generation AS state_settings_generation,
    state.covered_count,state.error_code
    FROM public.background_task t
    JOIN public.background_task_step s ON s.task_id=t.id
    JOIN public.layered_memory_job j ON j.task_id=t.id AND j.owner_id=t.owner_id
      AND j.contact_id IS NOT DISTINCT FROM t.contact_id
    JOIN public.layered_memory_state state ON state.owner_id=j.owner_id
      AND state.contact_id IS NOT DISTINCT FROM j.contact_id
    LEFT JOIN public.layered_memory_batch b ON b.id=j.receipt_batch_id AND b.task_id=j.task_id
      AND b.owner_id=j.owner_id AND b.contact_id IS NOT DISTINCT FROM j.contact_id
    WHERE t.id=$1 AND s.id=$2 AND t.owner_id=$3 AND t.contact_id IS NOT DISTINCT FROM $4::uuid
      AND s.step_name='organize_memory'
    FOR UPDATE OF t,s,j,state`,
  [claim.taskId, claim.stepId, claim.ownerId, claim.contactId])).rows[0];
  if (
    !row
    || row.task_status !== 'running'
    || row.step_status !== 'running'
    || row.worker_id !== claim.workerId
    || Number(row.step_lease_generation) !== claim.leaseGeneration
    || row.lease_valid !== true
  ) workerConflict('l2_scenario_worker_lease_stale');
  if (!row.enabled) workerConflict('l2_scenario_disabled');
  if (row.job_state !== 'active') workerConflict('l2_scenario_job_stale');
  if (!row.profile_required && row.profile_status !== 'not_required') {
    workerConflict('l2_scenario_profile_required');
  }
  if (!String(row.contract).split(':').includes('document-tools-v1')) {
    workerConflict('l2_scenario_contract_unsupported');
  }
  if (Number(row.settings_generation) !== Number(row.state_settings_generation)) {
    workerConflict('l2_scenario_changed');
  }
  if (
    !Array.isArray(row.target_manifest)
    || !Number.isSafeInteger(Number(row.run_remaining))
    || Number(row.run_remaining) < 0
    || !Number.isSafeInteger(Number(row.covered_count))
    || Number(row.covered_count) < 0
  ) workerConflict('l2_scenario_receipt_stale', true);
  const target = row.target_manifest;
  if (target.length) {
    if (
      row.pending_receipt !== true
      || typeof row.receipt_batch_id !== 'string'
      || row.batch_status !== 'succeeded'
      || Number(row.batch_settings_generation) !== Number(row.settings_generation)
      || row.receipt_lease_generation === null
      || Number(row.receipt_lease_generation) > claim.leaseGeneration
    ) workerConflict('l2_scenario_receipt_stale', true);
  }
  const receiptProcessedCount = row.pending_receipt === true
    ? Array.isArray(row.batch_input_manifest) ? row.batch_input_manifest.length : -1
    : null;
  if (row.pending_receipt === true && (
    receiptProcessedCount === null
    || receiptProcessedCount < 1
    || processedCount !== 0 && processedCount !== receiptProcessedCount
  )) workerConflict('l2_scenario_receipt_stale', true);
  const completedCount = receiptProcessedCount ?? processedCount;
  const profilePending = row.profile_required
    && !['succeeded', 'not_required'].includes(String(row.profile_status));
  if (profilePending) {
    const exhausted = String(row.error_code ?? '') === 'model_call_budget_exhausted';
    const error = exhausted
      ? 'model_call_budget_exhausted'
      : String(row.error_code ?? '') || 'profile_attempt_interrupted';
    const profileState = exhausted ? 'paused' : 'failed';
    const step = await client.query(`UPDATE public.background_task_step
      SET status='failed',worker_id=NULL,lease_expires_at=NULL,last_error_code=$2,
        finished_at=now(),updated_at=now()
      WHERE id=$1 AND status='running' AND worker_id=$3 AND lease_generation=$4`,
    [claim.stepId, error, claim.workerId, claim.leaseGeneration]);
    if (step.rowCount !== 1) workerConflict('l2_scenario_worker_lease_stale');
    const task = await client.query(`UPDATE public.background_task
      SET status='failed',finished_at=now(),last_error_code=$2,updated_at=now()
      WHERE id=$1 AND status='running'`,
    [claim.taskId, error]);
    if (task.rowCount !== 1) workerConflict('l2_scenario_job_stale');
    const job = await client.query(`UPDATE public.layered_memory_job
      SET state=$2 WHERE task_id=$1 AND state='active'`,
    [claim.taskId, profileState]);
    if (job.rowCount !== 1) workerConflict('l2_scenario_job_stale');
    const state = await client.query(`UPDATE public.layered_memory_state
      SET status=$2,error_code=$3,updated_at=now()
      WHERE owner_id=$4 AND contact_id IS NOT DISTINCT FROM $5::uuid
        AND settings_generation=$1`,
    [row.settings_generation, profileState, error, claim.ownerId, claim.contactId]);
    if (state.rowCount !== 1) workerConflict('l2_scenario_changed');
    return {
      processedCount: completedCount,
      totalCount: claim.messageCount,
      state: profileState,
    };
  }

  const step = await client.query(`UPDATE public.background_task_step
    SET status='succeeded',processed_count=$2,total_count=$3,worker_id=NULL,
      lease_expires_at=NULL,finished_at=now(),updated_at=now()
    WHERE id=$1 AND status='running' AND worker_id=$4 AND lease_generation=$5`,
  [claim.stepId, completedCount, claim.messageCount, claim.workerId, claim.leaseGeneration]);
  if (step.rowCount !== 1) workerConflict('l2_scenario_worker_lease_stale');

  const runRemaining = Math.max(0, Number(row.run_remaining) - 1);
  const job = await client.query(`UPDATE public.layered_memory_job
    SET pending_receipt=false,receipt_batch_id=NULL,receipt_lease_generation=NULL,run_remaining=$2
    WHERE task_id=$1 AND state='active'`,
  [claim.taskId, runRemaining]);
  if (job.rowCount !== 1) workerConflict('l2_scenario_job_stale');
  const remaining = Math.max(0, target.length - Number(row.covered_count));
  const exhausted = ['model_budget_exhausted', 'model_call_budget_exhausted'].includes(
    String(row.error_code ?? ''),
  );
  const jobState = exhausted ? 'paused' : remaining && runRemaining === 0 ? 'paused' : remaining ? 'active' : 'complete';
  if (jobState === 'complete') {
    await client.query(`UPDATE public.layered_memory_state state
      SET consumed_revision=GREATEST(state.consumed_revision,job.target_dirty_revision)
      FROM public.layered_memory_job job
      WHERE job.task_id=$1 AND job.owner_id=state.owner_id
        AND job.contact_id IS NOT DISTINCT FROM state.contact_id`,
    [claim.taskId]);
  }
  await client.query("UPDATE public.layered_memory_job SET state=$2 WHERE task_id=$1",
    [claim.taskId, jobState]);
  if (remaining) {
    await client.query(`UPDATE public.background_task_step
      SET status='pending',attempt_count=0,processed_count=0,worker_id=NULL,
        lease_expires_at=NULL,
        last_error_code=CASE WHEN $2 THEN last_error_code ELSE NULL END,
        finished_at=NULL,updated_at=now()
      WHERE task_id=$1 AND step_name='organize_memory'`,
    [claim.taskId, exhausted]);
  }
  const task = await client.query(`UPDATE public.background_task
    SET status=$2,finished_at=CASE WHEN $2='succeeded' THEN now() ELSE NULL END,
      last_error_code=CASE WHEN $3 THEN last_error_code ELSE NULL END,updated_at=now()
    WHERE id=$1`,
  [claim.taskId, remaining ? 'queued' : 'succeeded', exhausted]);
  if (task.rowCount !== 1) workerConflict('l2_scenario_job_stale');
  const state = await client.query(`UPDATE public.layered_memory_state
    SET status=$2
    WHERE owner_id=$3 AND contact_id IS NOT DISTINCT FROM $4::uuid
      AND settings_generation=$1`,
  [row.settings_generation, remaining ? 'paused' : target.length ? 'ready' : 'empty',
    claim.ownerId, claim.contactId]);
  if (state.rowCount !== 1) workerConflict('l2_scenario_changed');
  return {
    processedCount: completedCount,
    totalCount: claim.messageCount,
    state: jobState,
  };
}
