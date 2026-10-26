/** 管理纠错的来源排除策略；只过滤真实版本/消息身份，不修改记忆或模型算法。 */
import type {Client} from 'pg';
import type {ContextMetadata} from '../../reply/context/reply-context-types.ts';
import type {L2ScenarioScope} from './l2-scenario-workspace.ts';

export async function filterLayeredMemoryManagementEntries(client:Client,scope:L2ScenarioScope,
  entries:readonly ContextMetadata[]):Promise<ContextMetadata[]>{
  const feedback=(await client.query(`SELECT protected_memory_ids,protected_message_ids
    FROM public.layered_memory_feedback WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
    AND state IN ('active','erased_guard')`,[scope.owner_id,scope.contact_id])).rows;
  const pending=(await client.query(`SELECT memory_id,memory_revision FROM public.layered_memory_fact_correction
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,[scope.owner_id,scope.contact_id])).rows;
  if(!feedback.length&&!pending.length)return [...entries];
  const memoryGuard=new Set<string>(feedback.flatMap(row=>row.protected_memory_ids));
  const messageGuard=new Set<string>(feedback.flatMap(row=>row.protected_message_ids));
  const facts=new Set(pending.map(row=>`${row.memory_id}:${Number(row.memory_revision)}`));
  const table=scope.contact_id===null?'owner_memory':'confirmed_memory';
  const contact=scope.contact_id===null?'$2::uuid IS NULL':'m.contact_id=$2';
  const lineages=memoryGuard.size?(await client.query(`WITH RECURSIVE lineage AS (
    SELECT m.id AS leaf_id,m.id,m.supersedes_memory_id,ARRAY[m.id] AS path FROM public.${table} m
      WHERE m.owner_id=$1 AND ${contact} AND m.id=ANY($3::uuid[])
    UNION ALL SELECT l.leaf_id,m.id,m.supersedes_memory_id,l.path||m.id
      FROM lineage l JOIN public.${table} m ON m.id=l.supersedes_memory_id AND m.owner_id=$1
      WHERE ${contact} AND NOT m.id=ANY(l.path)
  ) SELECT leaf_id,array_agg(id) AS ids FROM lineage GROUP BY leaf_id`,
  [scope.owner_id,scope.contact_id,entries.map(entry=>entry.memory.memory_id)])).rows:[];
  const ancestors=new Map<string,string[]>(lineages.map(row=>[row.leaf_id,row.ids]));
  return entries.filter(entry=>!facts.has(`${entry.memory.memory_id}:${entry.memory.revision}`)
    && !(ancestors.get(entry.memory.memory_id)??[entry.memory.memory_id]).some(id=>memoryGuard.has(id))
    && !(entry.provenance?.references??[]).some((ref:Record<string,any>)=>messageGuard.has(ref.message_id)));
}
