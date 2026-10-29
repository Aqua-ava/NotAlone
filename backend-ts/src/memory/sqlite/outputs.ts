import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {VerifiedExtractionOutputReference} from './contracts.ts';
import {assertInputs,fail,textId} from './qualification.ts';
/** 08须在创建正式候选的同一短事务调用；阶段产物不授予自动采纳资格。 */
export function verifiedExtractionOutput(tx:StorageTransaction,ref:VerifiedExtractionOutputReference){
 const ownerId=textId(ref.ownerId),eventId=textId(ref.eventId);
 const e=tx.get(`SELECT e.*,t.run_id,t.scope_kind,t.contact_id FROM execution_event e
 JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
 JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 WHERE e.owner_id=? AND e.id=? AND e.kind='verified_output' AND a.state='succeeded'
 AND s.state='succeeded' AND s.successful_attempt_id=a.id AND t.state IN ('succeeded','awaiting_decision')`,[ownerId,eventId]);
 if(!e)return fail('memory_extraction_output_not_eligible');
 const payload=JSON.parse(String(e.payload));
 if(payload.scopeKind!==e.scope_kind||payload.contactId!==e.contact_id||payload.origin!=='auto'||typeof payload.fact?.text!=='string'||!payload.fact.text.trim())fail('memory_extraction_output_not_eligible');
 const inputs=tx.all(`SELECT i.* FROM execution_input x JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no WHERE x.owner_id=? AND x.event_id=? ORDER BY x.presentation_no`,[ownerId,eventId]);
 if(!inputs.length)fail('memory_extraction_output_not_eligible');assertInputs(tx,ownerId,String(e.run_id),inputs);
 const sources=tx.all('SELECT source_contact_id,record_id FROM event_source WHERE owner_id=? AND event_id=?',[ownerId,eventId]);
 const expected=new Set(inputs.map(i=>JSON.stringify([i.source_contact_id,i.record_id])));
 if(sources.length!==expected.size||sources.some(s=>!expected.has(JSON.stringify([s.source_contact_id,s.record_id]))))fail('memory_extraction_output_not_eligible');
 return {eventId,ownerId,scopeKind:e.scope_kind as 'self'|'contact',contactId:e.contact_id===null?null:String(e.contact_id),producedAttemptId:String(e.step_attempt_id),outputNo:e.event_no as bigint,proposedBody:payload.fact.text as string,fact:payload.fact,origin:'auto' as const,
  sources:inputs.map(i=>({contactId:String(i.source_contact_id),recordId:String(i.record_id),messageId:String(i.message_id),interpretationRevision:i.accepted_interpretation_revision as bigint}))};
}
