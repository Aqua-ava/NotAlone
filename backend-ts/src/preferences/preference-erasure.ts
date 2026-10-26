/** 删除在owner锁内选择真实依赖；A输入先于C回复擦除，Skill发布递归复用同一事务。 */
import type pg from 'pg';
import {createAssistantErasure} from '../reply/generation/reply-assistant-erasure.ts';
import {eraseSkillLearning as eraseLearning} from '../skills/skill-cleanup.ts';
export interface ErasurePorts {
 /** 必须先核验carry/discussion真实父边，再选择并擦除A输入；返回额外受影响请求。 */
 eraseAssistantDependencies:(client:pg.Client,owner:string,removedIds:string[],requestIds:string[])=>Promise<string[]>;
 eraseSkillLearning:(client:pg.Client,owner:string,removedIds:string[])=>Promise<void>;
 eraseMemoryUpgrades:(client:pg.Client,owner:string,removedIds:string[])=>Promise<void>;
}
export async function eraseSkillLearning(client:pg.Client,owner:string,removedIds:string[],ports?:Partial<ErasurePorts>):Promise<void>{
 if(!removedIds.length)return;
 if(ports?.eraseSkillLearning){await ports.eraseSkillLearning(client,owner,removedIds);return;}
 await eraseLearning(client,owner,removedIds,async (connection,input)=>deleteSourceReplies(connection,input.ownerId,input.removedIds,input.contactId,input.revokeRunningScope,ports));
}
export async function deleteSourceReplies(client:pg.Client,owner:string,removedIds:string[],contactId:string|null=null,revokeRunningScope=false,ports?:Partial<ErasurePorts>):Promise<void>{
 if(!removedIds.length)return;
 const rows=(await client.query(`WITH RECURSIVE affected(id) AS (
 SELECT request.id FROM public.reply_request request WHERE request.owner_id=$1 AND (
 (request.state='running' AND $4 AND $3::uuid IS NOT NULL AND(request.contact_id=$3 OR EXISTS(SELECT 1 FROM public.owner_memory memory WHERE memory.owner_id=request.owner_id AND((memory.status='active' AND memory.source_ids&&$2::uuid[]) OR(to_jsonb(memory)->>'source_dependency_mode'='all' AND memory.id=ANY($2::uuid[]))))))
 OR EXISTS(SELECT 1 FROM public.assistant_session_turn turn WHERE turn.owner_id=request.owner_id AND turn.contact_id=request.contact_id AND turn.idempotency_key=request.idempotency_key AND turn.dependency_ids&&$2::uuid[])
 OR EXISTS(SELECT 1 FROM public.reply_context_evidence evidence WHERE evidence.reply_request_id=request.id AND(evidence.contact_id=$3 OR evidence.kind='owner_memory') AND(evidence.evidence_id=ANY($2::uuid[]) OR evidence.source_ids ?| $5::text[]))
 OR EXISTS(SELECT 1 FROM public.reply_original_source_use used WHERE used.reply_request_id=request.id AND used.owner_id=$1 AND used.source_id=ANY($2::uuid[]))
 OR request.skill_version_id=ANY($2::uuid[])
 OR EXISTS(SELECT 1 FROM public.reply_expression_preference_use used WHERE used.reply_request_id=request.id AND used.owner_id=$1 AND used.preference_id=ANY($2::uuid[]))
 OR request.context_snapshot->'navigation_dependency_ids' ?| $5::text[])
 UNION SELECT child.id FROM affected JOIN public.reply_candidate candidate ON candidate.reply_request_id=affected.id JOIN public.reply_request child ON child.continued_from_candidate_id=candidate.id WHERE child.owner_id=$1 AND child.contact_id=candidate.contact_id)
 SELECT id FROM affected`,[owner,removedIds,contactId,revokeRunningScope,removedIds])).rows;
 let requests:string[]=rows.map(r=>r.id);
 const eraseAssistant=ports?.eraseAssistantDependencies??createAssistantErasure({eraseSkillLearning:(connection,selectedOwner,ids)=>eraseSkillLearning(connection,selectedOwner,ids,ports)});
 requests=[...new Set([...requests,...await eraseAssistant(client,owner,removedIds,requests)])];
 if(ports?.eraseMemoryUpgrades)await ports.eraseMemoryUpgrades(client,owner,removedIds);
 else {const {eraseMemoryUpgrades}=await import('../memory/management/memory-mutations-erasure.ts');await eraseMemoryUpgrades(client,owner,removedIds);}
 await eraseSkillLearning(client,owner,[...new Set([...removedIds,...requests])],ports);
 if(!requests.length)return;
 await client.query('INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) SELECT owner_id,contact_id,idempotency_key FROM public.reply_request WHERE owner_id=$1 AND id=ANY($2::uuid[]) ON CONFLICT DO NOTHING',[owner,requests]);
 await client.query('DELETE FROM public.reply_request WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,requests]);
}
