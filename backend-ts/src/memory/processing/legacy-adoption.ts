/** 启动前把证据唯一的旧记忆任务接入新管理元数据；旧停止与不明确归属不猜成运行意图。 */
import type pg from 'pg';
import type {TaskScope} from '../../tasks/task-control.ts';

type Phase = 'extraction'|'verification'|'topics'|'profile'|'retry';
interface LegacyTask extends pg.QueryResultRow {
  id:string;
  owner_id:string;
  contact_id:string|null;
  source_document_id:string|null;
  task_type:'import'|'observation'|'layered_memory';
  status:string;
  current_step:string;
}
interface Candidate extends pg.QueryResultRow {
  contact_id:string|null;
}
interface Evidence {
  code:string;
  phase:Phase;
  unit:'messages'|'memories';
  count:number;
  messageTargetIds:string[];
}
const incomplete = `task.status IN ('queued','running','verifying','failed','paused')`;

function phase(step:string):Phase {
  if (['parse','normalize','extract_memory'].includes(step)) return 'extraction';
  if (['index','verify'].includes(step)) return 'verification';
  if (step === 'organize_memory') return 'topics';
  return 'retry';
}

async function extractionEvidence(
  client:pg.ClientBase,
  task:LegacyTask,
  importTask:boolean,
):Promise<Evidence|null> {
  if (importTask) {
    const source = (await client.query(
      `SELECT 1 FROM public.source_document source
       JOIN public.import_confirmation confirmation
         ON confirmation.owner_id=source.owner_id
         AND confirmation.contact_id=source.contact_id
         AND confirmation.source_document_id=source.id
       WHERE source.id=$1 AND source.owner_id=$2 AND source.contact_id=$3
         AND source.status='active'`,
      [task.source_document_id,task.owner_id,task.contact_id],
    )).rowCount === 1;
    if (!source) return null;
  }
  const plan = (await client.query(
    'SELECT 1 FROM public.memory_processing_plan WHERE task_id=$1 AND owner_id=$2 AND contact_id=$3',
    [task.id,task.owner_id,task.contact_id],
  )).rowCount === 1;
  if (!plan) return null;
  const sourceValidity=importTask
    ? `EXISTS(
         SELECT 1 FROM public.message_source_ref ref
         JOIN public.source_document source
           ON source.id=ref.source_document_id
           AND source.owner_id=ref.owner_id
           AND source.contact_id=ref.contact_id
         WHERE ref.message_id=target.message_id
           AND ref.owner_id=target.owner_id
           AND ref.contact_id=target.contact_id
           AND source.id=$4 AND source.status='active'
       )`
    : `EXISTS(
         SELECT 1 FROM public.message_source_ref ref
         JOIN public.local_wechat_observation observation
           ON observation.id=ref.observation_id
           AND observation.owner_id=ref.owner_id
           AND observation.contact_id=ref.contact_id
         JOIN public.conversation_binding binding
           ON binding.id=observation.binding_id
           AND binding.owner_id=observation.owner_id
           AND binding.contact_id=observation.contact_id
         WHERE ref.message_id=target.message_id
           AND ref.owner_id=target.owner_id
           AND ref.contact_id=target.contact_id
           AND binding.status='active'
       )`;
  const targets = (await client.query<{message_id:string;source_valid:boolean}>(
    `SELECT target.message_id,
       ${sourceValidity} AS source_valid
     FROM public.memory_processing_target target
     WHERE target.task_id=$1 AND target.owner_id=$2 AND target.contact_id=$3
     ORDER BY target.message_id`,
    importTask
      ? [task.id,task.owner_id,task.contact_id,task.source_document_id]
      : [task.id,task.owner_id,task.contact_id],
  )).rows;
  if (targets.length === 0) return null;
  if (targets.some(target=>!target.source_valid)) return null;
  let ids=targets.map(target=>target.message_id);
  if (importTask && ids.length) {
    const sourceMatches = await client.query<{n:number}>(
      `SELECT count(DISTINCT message_id)::int AS n FROM public.message_source_ref
       WHERE message_id=ANY($1::uuid[]) AND owner_id=$2 AND contact_id=$3
         AND source_document_id=$4`,
      [ids,task.owner_id,task.contact_id,task.source_document_id],
    );
    if (sourceMatches.rows[0].n !== ids.length) return null;
    // 只保留原任务计划中的身份，不扩大到同来源后来新增的消息。
    ids=[...new Set(ids)];
  }
  return {
    code:importTask?'import_confirmed':'observation_binding',
    phase:phase(task.current_step),
    unit:'messages',
    count:ids.length,
    messageTargetIds:ids,
  };
}

async function layeredEvidence(
  client:pg.ClientBase,
  task:LegacyTask,
):Promise<Evidence|null> {
  const row = (await client.query<{
    target_manifest:unknown;
    profile_required:boolean;
    profile_status:string;
  }>(
    `SELECT job.target_manifest,job.profile_required,job.profile_status
     FROM public.layered_memory_job job
     JOIN public.layered_memory_state state
       ON state.owner_id=job.owner_id
       AND state.contact_id IS NOT DISTINCT FROM job.contact_id
     WHERE job.task_id=$1 AND job.owner_id=$2
       AND job.contact_id IS NOT DISTINCT FROM $3::uuid
       AND job.state='active' AND state.enabled
       AND job.settings_generation=state.settings_generation
     FOR SHARE OF job,state`,
    [task.id,task.owner_id,task.contact_id],
  )).rows[0];
  if (!row || !Array.isArray(row.target_manifest) || row.target_manifest.length === 0) return null;
  return {
    code:'layered_job',
    phase:row.profile_required
      && !['succeeded','not_required'].includes(row.profile_status)
      ? 'profile' : 'topics',
    unit:'memories',
    count:row.target_manifest.length,
    messageTargetIds:[],
  };
}

async function createAdoption(
  client:pg.ClientBase,
  ownerId:string,
  contactId:string|null,
  task:LegacyTask,
  evidence:Evidence|null,
  unresolvedCode:string,
):Promise<void> {
  const decision=evidence?'adopted':'unresolved';
  const scope=(await client.query<{id:string}>(
    `INSERT INTO public.memory_processing_scope(owner_id,contact_id,intent,control_generation)
     VALUES($1,$2,'run',0) RETURNING id`,
    [ownerId,contactId],
  )).rows[0].id;
  const round=(await client.query<{id:string}>(
    `INSERT INTO public.memory_processing_round
     (scope_id,owner_id,contact_id,round_number,control_generation,status,phase,target_unit,target_count)
     VALUES($1,$2,$3,1,0,'blocked',$4,$5,$6) RETURNING id`,
    [scope,ownerId,contactId,evidence?.phase??phase(task.current_step),evidence?.unit??null,evidence?.count??null],
  )).rows[0].id;
  await client.query(
    'UPDATE public.memory_processing_scope SET active_round_id=$1 WHERE id=$2',
    [round,scope],
  );
  if (evidence) {
    await client.query(
      `INSERT INTO public.memory_processing_round_task
       (round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)`,
      [round,task.id,ownerId,contactId],
    );
    if (evidence.messageTargetIds.length) {
      await client.query(
        `INSERT INTO public.memory_processing_round_target(round_id,task_id,message_id)
         SELECT $1,$2,message_id FROM unnest($3::uuid[]) message_id`,
        [round,task.id,evidence.messageTargetIds],
      );
    }
  }
  const reason=decision==='adopted'?null:unresolvedCode;
  await client.query(
    `INSERT INTO public.memory_processing_legacy_adoption
     (owner_id,contact_id,scope_id,round_id,task_id,decision,evidence_code,resume_required,reason_code)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ownerId,contactId,scope,round,evidence?task.id:null,decision,
      evidence?.code??unresolvedCode,evidence!==null,reason],
  );
}

function legacyUnresolvedReason(task:LegacyTask):string {
  return task.status==='paused'?'legacy_paused_unverified':'legacy_evidence_unavailable';
}

export async function legacyAdoptionAwaitingContinue(
  client:pg.ClientBase,
  scope:TaskScope,
  roundId:string|null,
):Promise<boolean> {
  if (roundId === null) return false;
  return (await client.query(
    `SELECT 1 FROM public.memory_processing_legacy_adoption
     WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
       AND round_id=$3 AND decision='adopted' AND resume_required`,
    [scope.ownerId,scope.contactId,roundId],
  )).rowCount === 1;
}

export async function markLegacyAdoptionResumed(
  client:pg.ClientBase,
  scope:TaskScope,
  roundId:string|null,
):Promise<void> {
  if (roundId === null) return;
  await client.query(
    `UPDATE public.memory_processing_legacy_adoption
     SET resume_required=false,resumed_at=clock_timestamp()
     WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
       AND round_id=$3 AND decision='adopted' AND resume_required`,
    [scope.ownerId,scope.contactId,roundId],
  );
}

/**
 * 每个范围只接入证据唯一的单个未完成任务。多个未完成候选、旧暂停或证据
 * 不完整时只建立 blocked 元数据，确保旧 Worker 不能绕过统一入口领取。
 */
export async function adoptLegacyMemoryProcessing(
  pool:pg.Pool,
  ownerId:string,
):Promise<void> {
  let cursor:string|null=null;
  while (true) {
    const candidates:Candidate[]=(await pool.query<Candidate>(
      `SELECT task.contact_id
       FROM public.background_task task
       LEFT JOIN public.memory_processing_scope scope
         ON scope.owner_id=task.owner_id
         AND scope.contact_id IS NOT DISTINCT FROM task.contact_id
       WHERE task.owner_id=$1
         AND task.task_type IN ('import','observation','layered_memory')
         AND scope.id IS NULL
         AND (task.contact_id IS NOT NULL OR task.task_type='layered_memory')
         AND ($2::uuid IS NULL OR COALESCE(task.contact_id,task.owner_id)>$2::uuid)
       GROUP BY task.owner_id,task.contact_id
       HAVING bool_or(${incomplete})
       ORDER BY COALESCE(task.contact_id,task.owner_id)
       LIMIT 64`,
      [ownerId,cursor],
    )).rows;
    if (!candidates.length) break;
    cursor=candidates.at(-1)!.contact_id??ownerId;
    for (const candidate of candidates) {
      const contactId=candidate.contact_id;
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        if (contactId!==null) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`contact:${ownerId}:${contactId}`],
          );
        }
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`owner:${ownerId}`],
        );
        if ((await client.query(
          `SELECT 1 FROM public.memory_processing_scope
           WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
          [ownerId,contactId],
        )).rowCount) {
          await client.query('COMMIT');
          continue;
        }
        const tasks=(await client.query<LegacyTask>(
          `SELECT task.id,task.owner_id,task.contact_id,task.source_document_id,task.task_type,task.status,task.current_step
           FROM public.background_task task
           WHERE task.owner_id=$1 AND task.contact_id IS NOT DISTINCT FROM $2::uuid
             AND task.task_type IN ('import','observation','layered_memory')
             AND ${incomplete}
           ORDER BY task.created_at DESC,task.id DESC FOR UPDATE`,
          [ownerId,contactId],
        )).rows;
        if (!tasks.length) {
          await client.query('COMMIT');
          continue;
        }
        let evidence:Evidence|null=null;
        if (tasks.length===1 && tasks[0].status!=='paused') {
          const task=tasks[0];
          evidence=task.task_type==='layered_memory'
            ? await layeredEvidence(client,task)
            : await extractionEvidence(client,task,task.task_type==='import');
        }
        const unresolvedCode=tasks.length>1?'ambiguous_incomplete_tasks':legacyUnresolvedReason(tasks[0]);
        await createAdoption(
          client,ownerId,contactId,tasks[0],evidence,unresolvedCode,
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>{});
        throw error;
      } finally {
        client.release();
      }
    }
    if (candidates.length<64) break;
  }
}
