/** 场景与画像共同管理范围内的窄恢复端口；只恢复成功批次后待补的画像。 */
import type pg from 'pg';

export interface ProfileRecoveryScope {
  ownerId:string;
  contactId:string|null;
}

export async function profileOnlyRecoveryAllowed(
  client:pg.ClientBase,
  scope:ProfileRecoveryScope,
  taskId:string,
):Promise<boolean>{
  return Boolean((await client.query(`SELECT 1
   FROM layered_memory_job job
   JOIN background_task task ON task.id=job.task_id
   JOIN layered_memory_batch batch ON batch.id=job.receipt_batch_id
     AND batch.task_id=job.task_id AND batch.owner_id=job.owner_id
     AND batch.contact_id IS NOT DISTINCT FROM job.contact_id
   JOIN layered_memory_state state ON state.owner_id=job.owner_id
     AND state.contact_id IS NOT DISTINCT FROM job.contact_id
   WHERE job.task_id=$1 AND job.owner_id=$2
     AND job.contact_id IS NOT DISTINCT FROM $3::uuid
     AND job.pending_receipt AND job.profile_required
     AND job.profile_status='failed' AND batch.status='succeeded'
     AND batch.settings_generation=job.settings_generation
     AND state.enabled AND state.settings_generation=job.settings_generation
     AND job.model_calls_used<job.model_call_limit
     AND COALESCE(task.last_error_code,'') NOT IN (
       'model_call_outcome_unknown','l3_profile_model_ack_unknown',
       'l3_profile_source_changed','l3_profile_generation_changed',
       'l3_profile_input_budget_exceeded','model_call_budget_exhausted'
     )
     AND COALESCE(task.last_error_code,'') NOT LIKE '%unknown%'
   LIMIT 1`,
  [taskId,scope.ownerId,scope.contactId])).rowCount);
}

export async function resumeProfileOnlyRecovery(
  client:pg.ClientBase,
  scope:ProfileRecoveryScope,
  roundId:string|null,
):Promise<number>{
  if (roundId === null) return 0;
  const resumed = await client.query(`UPDATE layered_memory_job job
   SET state='active',profile_status='pending'
   FROM memory_processing_round_task member,
     layered_memory_batch batch
   WHERE member.round_id=$1 AND member.task_id=job.task_id
     AND member.active AND job.owner_id=$2
     AND job.contact_id IS NOT DISTINCT FROM $3::uuid
     AND batch.id=job.receipt_batch_id
     AND batch.task_id=job.task_id AND batch.owner_id=job.owner_id
     AND batch.contact_id IS NOT DISTINCT FROM job.contact_id
     AND job.pending_receipt AND job.profile_required
     AND job.profile_status='failed' AND batch.status='succeeded'
     AND batch.settings_generation=job.settings_generation
     AND job.model_calls_used<job.model_call_limit
   RETURNING job.task_id`,
  [roundId,scope.ownerId,scope.contactId]);
  if (!resumed.rowCount) return 0;
  await client.query(`UPDATE layered_memory_state state
   SET status='updating',error_code=NULL,updated_at=clock_timestamp()
   WHERE state.owner_id=$1 AND state.contact_id IS NOT DISTINCT FROM $2::uuid
     AND state.enabled
     AND EXISTS(
       SELECT 1 FROM layered_memory_job job
       WHERE job.task_id=ANY($3::uuid[])
         AND job.owner_id=state.owner_id
         AND job.contact_id IS NOT DISTINCT FROM state.contact_id
         AND job.settings_generation=state.settings_generation
         AND job.pending_receipt AND job.profile_status='pending'
     )`,
  [scope.ownerId,scope.contactId,resumed.rows.map((row: {task_id:string}) => row.task_id)]);
  return resumed.rowCount;
}
