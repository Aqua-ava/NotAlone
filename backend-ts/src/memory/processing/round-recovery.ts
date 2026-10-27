/** 只重排当前固定轮次中已核验为安全的中断阶段。 */
import type pg from 'pg';
import type {TaskScope} from '../../tasks/task-control.ts';
import { resumeProfileOnlyRecovery } from '../records/documents/recovery.ts';

/**
 * 修复已通过资格核验的当前轮中断。调用方必须已持有范围锁，且不得借此
 * 重置尝试次数、累计预算、成功步骤或人工阻碍。
 */
export async function resumeInterruptedCurrentRound(
  client: pg.ClientBase,
  scope: TaskScope,
  roundId: string,
): Promise<string[]> {
  await resumeProfileOnlyRecovery(client, scope, roundId);
  const reset = await client.query(
    `UPDATE public.background_task_step step
     SET status='pending',worker_id=NULL,lease_expires_at=NULL,
       lease_generation=lease_generation+1,last_error_code=NULL,
       finished_at=NULL,updated_at=clock_timestamp()
     FROM public.memory_processing_round_task member
     WHERE member.round_id=$1 AND member.active
       AND member.task_id=step.task_id
       AND member.owner_id=$2
       AND member.contact_id IS NOT DISTINCT FROM $3::uuid
       AND (
         step.status IN ('failed','retryable')
         OR step.status='running' AND step.lease_expires_at<=clock_timestamp()
       )
     RETURNING step.task_id`,
    [roundId, scope.ownerId, scope.contactId],
  );
  if (reset.rowCount) {
    await client.query(
      `UPDATE public.background_task task
       SET status='queued',current_step=next_step.step_name,
         last_error_code=NULL,finished_at=NULL,updated_at=clock_timestamp()
       FROM (
         SELECT DISTINCT ON (step.task_id) step.task_id,step.step_name
         FROM public.memory_processing_round_task member
         JOIN public.background_task_step step ON step.task_id=member.task_id
         WHERE member.round_id=$1 AND member.active
           AND member.owner_id=$2
           AND member.contact_id IS NOT DISTINCT FROM $3::uuid
           AND step.status<>'succeeded'
         ORDER BY step.task_id,step.step_order
       ) next_step
       WHERE task.id=next_step.task_id
         AND task.owner_id=$2
         AND task.contact_id IS NOT DISTINCT FROM $3::uuid
         AND task.status IN ('failed','running','verifying')`,
      [roundId, scope.ownerId, scope.contactId],
    );
  }
  await client.query(
    `UPDATE public.memory_processing_round
     SET status=CASE WHEN status='blocked' THEN 'waiting' ELSE status END,
       completed_at=NULL
     WHERE id=$1 AND scope_id=(
       SELECT id FROM public.memory_processing_scope
       WHERE owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid
     ) AND status IN ('waiting','processing','blocked')`,
    [roundId, scope.ownerId, scope.contactId],
  );
  return (await client.query(
    `SELECT task.id
     FROM public.background_task task
     JOIN public.memory_processing_round_task member ON member.task_id=task.id
     WHERE member.round_id=$1 AND member.active
       AND task.owner_id=$2
       AND task.contact_id IS NOT DISTINCT FROM $3::uuid
       AND task.status IN ('queued','running','verifying')
       AND EXISTS(
         SELECT 1 FROM public.background_task_step step
         WHERE step.task_id=task.id
           AND step.status IN ('pending','retryable')
       )
     ORDER BY task.id`,
    [roundId, scope.ownerId, scope.contactId],
  )).rows.map((row: {id:string}) => row.id);
}
