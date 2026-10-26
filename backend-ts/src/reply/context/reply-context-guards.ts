import type {Client} from 'pg';
import type {ReplyStoreEvidence} from '../generation/reply-store.ts';
import {canonicalJSON} from '../../memory/overview/evidence/sources.ts';
import {readContextMemories,memoryEvidence,pendingSelectionReason,type MemoryKind} from './reply-context-memory.ts';
import {ReplyContextError,type ContextScope} from './reply-context-types.ts';
/** 必须由实际writer在同一owner锁事务调用；状态、正文及当前语义投影逐字段比较。 */
export async function requireCurrentReplyMemory(client:Client,scope:ContextScope,evidence:readonly ReplyStoreEvidence[]):Promise<void>{
 for(const kind of ['confirmed_memory','owner_memory','pending_candidate'] as MemoryKind[]){
  const expected=evidence.filter(item=>item.kind===kind);if(!expected.length)continue;
  if(new Set(expected.map(item=>item.evidence_id)).size!==expected.length)throw new ReplyContextError('记忆依据重复。');
  const rows=await readContextMemories(client,scope,kind,expected.map(item=>item.evidence_id));
  for(const item of expected){
   const row=rows.find(value=>value.id===item.evidence_id);if(!row)throw new ReplyContextError('记忆依据已失效。');
   const actual=memoryEvidence(row,scope,kind),stored=item as Record<string,any>;
   for(const field of ['text','status','revision','valid_at','invalid_at','timing','event','conditions','evolution'])if(canonicalJSON(actual[field as keyof typeof actual])!==canonicalJSON(stored[field]))throw new ReplyContextError('记忆依据版本或语义已变化。');
   if(item.source_ids.length!==actual.source_ids.length||canonicalJSON([...item.source_ids].sort())!==canonicalJSON([...actual.source_ids].sort()))throw new ReplyContextError('记忆来源已变化。');
   if(stored.freshness_sha256!==undefined&&stored.freshness_sha256!==actual.freshness_sha256)throw new ReplyContextError('记忆来源世代已变化。');
   if(kind==='pending_candidate'&&!item.selection_reason.startsWith(pendingSelectionReason(row)))throw new ReplyContextError('待确认属性已变化。');
  }
 }
}
