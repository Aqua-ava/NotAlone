/** 启动时只续跑当前固定轮次中可证明安全的未完成工作。 */
import type pg from 'pg';
import type {TaskScope} from '../../tasks/task-control.ts';
import {
  memoryContinueBlocker,
  memoryHasInterruptedWork,
  type MemoryProcessingUnconfirmed,
} from './control.ts';
import { resumeInterruptedCurrentRound } from './round-recovery.ts';

export interface MemoryStartupTask {
  contact_id: string | null;
  task_id: string;
}

export interface MemoryStartupRecoveryOptions {
  pool: pg.Pool;
  ownerId: string;
  unconfirmed?: MemoryProcessingUnconfirmed;
}

/**
 * 受控启动入口：只检查当前有效轮次，不创建轮次、不扫描未归属旧任务，
 * 不唤醒页面，也不把启动本身解释为新的资料来源或用户继续意图。
 */
export async function recoverMemoryProcessingOnStartup(
  options: MemoryStartupRecoveryOptions,
): Promise<MemoryStartupTask[]> {
  const recovered: MemoryStartupTask[] = [];
  let cursor: string | null = null;
  while (true) {
    const scopes: {id:string;contact_id:string|null}[] = (await options.pool.query<{id:string;contact_id:string|null}>(
      `SELECT id,contact_id
       FROM public.memory_processing_scope
       WHERE owner_id=$1 AND intent='run' AND active_round_id IS NOT NULL
         AND ($2::uuid IS NULL OR id>$2::uuid)
       ORDER BY id LIMIT 64`,
      [options.ownerId, cursor],
    )).rows;
    if (!scopes.length) break;
    cursor = scopes.at(-1)!.id;
    for (const candidate of scopes) {
      const scope: TaskScope = {ownerId:options.ownerId,contactId:candidate.contact_id};
      const client = await options.pool.connect();
      try {
        await client.query('BEGIN');
        if (candidate.contact_id !== null) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`contact:${options.ownerId}:${candidate.contact_id}`],
          );
        }
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`owner:${options.ownerId}`],
        );
        const current = (await client.query<{
          active_round_id:string;
          control_generation:string;
          round_generation:string;
          round_status:string;
        }>(
          `SELECT scope.active_round_id,scope.control_generation,
             round.control_generation AS round_generation,round.status AS round_status
           FROM public.memory_processing_scope scope
           JOIN public.memory_processing_round round
             ON round.id=scope.active_round_id AND round.scope_id=scope.id
           WHERE scope.id=$1 AND scope.owner_id=$2 AND scope.intent='run'
           FOR UPDATE OF scope,round`,
          [candidate.id, options.ownerId],
        )).rows[0];
        if (!current || current.round_status === 'completed'
          || current.round_generation !== current.control_generation) {
          await client.query('COMMIT');
          continue;
        }
        if (await memoryContinueBlocker(
          client,
          scope,
          current.active_round_id,
          options.unconfirmed,
        ) !== null) {
          await client.query('COMMIT');
          continue;
        }
        if (!await memoryHasInterruptedWork(client, scope, current.active_round_id)) {
          await client.query('COMMIT');
          continue;
        }
        const taskIds = await resumeInterruptedCurrentRound(
          client,
          scope,
          current.active_round_id,
        );
        await client.query('COMMIT');
        for (const taskId of taskIds) {
          recovered.push({contact_id:candidate.contact_id,task_id:taskId});
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    if (scopes.length < 64) break;
  }
  return recovered;
}
