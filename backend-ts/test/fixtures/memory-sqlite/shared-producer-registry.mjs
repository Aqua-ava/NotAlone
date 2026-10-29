import {randomUUID} from 'node:crypto';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
function reply(tx,owner,contact,message,record){
 const id=randomUUID(),request=randomUUID(),entry=randomUUID(),attempt=randomUUID(),context=randomUUID(),operation=randomUUID(),call=randomUUID(),event=randomUUID();
 const grant=tx.get('SELECT * FROM read_grant WHERE owner_id=? AND contact_id=? AND revoked_at IS NULL',[owner,contact]);
 tx.run("INSERT INTO assistant_discussion(owner_id,id,contact_id,title,state,created_at,last_activity_at) VALUES(?,?,?,NULL,'active',1,1)",[owner,id,contact]);
 tx.run("INSERT INTO reply_request(owner_id,id,contact_id,discussion_id,request_key,trigger_entry_id,kind,identity_origin,binding_id,verification_id,state) VALUES(?,?,?,?,?,?,'discussion','binding',?,?,'accepted')",[owner,request,contact,id,randomUUID(),entry,grant.binding_id,grant.verification_id]);
 tx.run("INSERT INTO discussion_entry VALUES(?,?,?,?,1,'user','合成请求',?,NULL,NULL,'available')",[owner,entry,contact,id,request]);
 tx.run("INSERT INTO reply_attempt VALUES(?,?,?,1,'running',?,0,0,0,1,NULL,NULL)",[owner,attempt,request,randomUUID()]);
 tx.run("INSERT INTO reply_context VALUES(?,?,?,?,'request',?,?,0,0,0,0,'{}',1,'active')",[owner,context,contact,id,attempt,request]);
 tx.run("INSERT INTO reply_context_item VALUES(?,?,1,'message','context',1,?,?,?,1,NULL,NULL,NULL)",[owner,context,contact,message,record]);
 tx.run("INSERT INTO reply_context_item VALUES(?,?,2,'entry','context',2,NULL,NULL,NULL,NULL,?,NULL,NULL)",[owner,context,entry]);
 tx.run("INSERT INTO model_operation(owner_id,id,purpose,reply_request_id,slot,input_seal,state) VALUES(?,?,'discussion',?,0,'synthetic','resolved')",[owner,operation,request]);
 tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,reply_attempt_id,reply_context_id,provider,request_key,state,reserved_budget_units,settlement_state) VALUES(?,?,?,1,?,?,'synthetic',?,'succeeded',10,'settled')",[owner,call,operation,attempt,context,randomUUID()]);
 tx.run("INSERT INTO execution_event(owner_id,id,reply_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,1,'assistant_message',?,'{\"text\":\"合成回答\"}',1)",[owner,event,attempt,call]);
 tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,reply_context_id,context_item_no) VALUES(?,?,1,'context',1,?,1)",[owner,event,context]);
 tx.run('INSERT INTO event_source VALUES(?,?,?,?)',[owner,event,contact,record]);
 tx.run("INSERT INTO discussion_entry VALUES(?,?,?,?,2,'assistant','合成回答',?,?,?,'available')",[owner,randomUUID(),contact,id,request,call,event]);
 return {discussion:id,request,entry,attempt,context,operation,call,event,contact,message,record};
}
function memory(tx,owner,contact,message,record){
 const run=randomUUID(),item=randomUUID(),task=randomUUID(),step=randomUUID(),attempt=randomUUID(),operation=randomUUID(),call=randomUUID(),event=randomUUID();
 const g=tx.get(`SELECT c.*,g.id AS grant_id,g.binding_id,b.identity_generation,a.scope_revision,a.source_generation FROM contact c JOIN read_grant g ON g.owner_id=c.owner_id AND g.contact_id=c.id AND g.revoked_at IS NULL JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id JOIN channel_conversation cv ON cv.owner_id=b.owner_id AND cv.id=b.conversation_id JOIN channel_account a ON a.owner_id=cv.owner_id AND a.id=cv.account_id WHERE c.owner_id=? AND c.id=?`,[owner,contact]);
 tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'preparing',1,0,'{}')",[owner,run,randomUUID()]);
 tx.run("INSERT INTO run_contact VALUES(?,?,?,?,?,?,?,?,?,?,?,'active')",[owner,run,contact,g.grant_id,g.binding_id,g.selection_generation,g.data_generation,g.identity_generation,g.scope_revision,g.source_generation,g.feedback_revision]);
 tx.run("INSERT INTO processing_item VALUES(?,?,?,?,'memory_extraction','pending','pending',NULL)",[owner,item,contact,message]);
 tx.run("INSERT INTO run_input VALUES(?,?,1,'target','message',?,?,?,?,1)",[owner,run,contact,item,message,record]);
 tx.run("UPDATE processing_run SET state='running' WHERE owner_id=? AND id=?",[owner,run]);
 tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,contact_id,state) VALUES(?,?,?,'contact',?,'running')",[owner,task,run,contact]);
 tx.run('INSERT INTO task_contribution VALUES(?,?,?,?)',[owner,task,run,contact]);
 tx.run("INSERT INTO processing_step VALUES(?,?,?,1,'extraction_verification','running','frozen',NULL)",[owner,step,task]);
 tx.run('INSERT INTO step_input VALUES(?,?,1,?,1)',[owner,step,run]);
 tx.run("INSERT INTO step_attempt VALUES(?,?,?,1,0,'synthetic',9999999999999,0,'synthetic','running',1,NULL,NULL)",[owner,attempt,step]);
 tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,'extraction',?,0,'synthetic','resolved')",[owner,operation,step]);
 tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,step_attempt_id,provider,request_key,state,reserved_budget_units,settlement_state) VALUES(?,?,?,1,?,'synthetic',?,'succeeded',10,'settled')",[owner,call,operation,attempt,randomUUID()]);
 tx.run("INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,1,'model_output',?,'{\"blocks\":[]}',1)",[owner,event,attempt,call]);
 tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,1,'target',1,?,1)",[owner,event,step]);
 tx.run('INSERT INTO event_source VALUES(?,?,?,?)',[owner,event,contact,record]);
 return {run,item,task,step,attempt,operation,call,event,contact,message,record};
}
const actions=[{name:'fixture.sharedSeed',mode:'write',retryBusy:false,execute(tx,i){
 const a=reply(tx,i.owner,i.contacts[0].contactId,i.contacts[0].messageId,i.contacts[0].recordId);
 const b=reply(tx,i.owner,i.contacts[1].contactId,i.contacts[1].messageId,i.contacts[1].recordId);
 const m=memory(tx,i.owner,i.contacts[0].contactId,i.contacts[0].messageId,i.contacts[0].recordId);
 return {a,b,m};
}},{name:'fixture.sharedViolation',mode:'write',retryBusy:false,execute(tx,i){const {owner,a,b,m,kind}=i;
 switch(kind){
 case 'operation_parent':tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,reply_request_id,slot,input_seal,state) VALUES(?,?,'discussion',?,?,0,'bad','prepared')",[owner,randomUUID(),m.step,a.request]);break;
 case 'reply_call_request':{const op=randomUUID();tx.run("INSERT INTO model_operation(owner_id,id,purpose,reply_request_id,slot,input_seal,state) VALUES(?,?,'discussion',?,3,'bad','prepared')",[owner,op,b.request]);tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,reply_attempt_id,reply_context_id,provider,request_key,state,reserved_budget_units,settlement_state) VALUES(?,?,?,1,?,?,'synthetic',?,'prepared',10,'reserved')",[owner,randomUUID(),op,a.attempt,a.context,randomUUID()]);break;}
 case 'reply_call_context':tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,reply_attempt_id,reply_context_id,provider,request_key,state,reserved_budget_units,settlement_state) VALUES(?,?,?,2,?,?,'synthetic',?,'prepared',10,'reserved')",[owner,randomUUID(),a.operation,a.attempt,b.context,randomUUID()]);break;
 case 'event_call_attempt':tx.run("INSERT INTO execution_event(owner_id,id,reply_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,3,'assistant_message',?,'{}',1)",[owner,randomUUID(),b.attempt,a.call]);break;
 case 'event_mixed_producer':tx.run("INSERT INTO execution_event(owner_id,id,step_attempt_id,reply_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,3,'mixed','{}',1)",[owner,randomUUID(),m.attempt,a.attempt]);break;
 case 'input_context':tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,reply_context_id,context_item_no) VALUES(?,?,3,'context',3,?,1)",[owner,a.event,b.context]);break;
 case 'input_mixed':tx.run("INSERT INTO execution_input VALUES(?,?,3,'context',3,?,1,?,1)",[owner,a.event,m.step,a.context]);break;
 case 'input_memory_reply':tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,3,'target',3,?,1)",[owner,a.event,m.step]);break;
 case 'event_source':tx.run('INSERT INTO event_source VALUES(?,?,?,?)',[owner,a.event,b.contact,b.record]);break;
 case 'assistant_body':tx.run("INSERT INTO discussion_entry VALUES(?,?,?,?,3,'assistant','伪造其他回答',?,?,?,'available')",[owner,randomUUID(),a.contact,a.discussion,a.request,a.call,a.event]);break;
 case 'call_detach':tx.run('UPDATE model_call SET step_attempt_id=NULL WHERE owner_id=? AND id=?',[owner,m.call]);break;
 case 'foreign_owner_call':{const foreignOwner=randomUUID();tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,1)',[foreignOwner]);tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,reply_attempt_id,reply_context_id,provider,request_key,state,reserved_budget_units,settlement_state) VALUES(?,?,?,2,?,?,'synthetic',?,'prepared',10,'reserved')",[foreignOwner,randomUUID(),a.operation,a.attempt,a.context,randomUUID()]);break;}
 case 'event_move':tx.run('UPDATE execution_event SET reply_attempt_id=? WHERE owner_id=? AND id=?',[b.attempt,owner,a.event]);break;
 case 'seal_detach':tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=1,memory_step_id=NULL WHERE owner_id=? AND id=?",[owner,m.operation]);tx.run('UPDATE model_call SET step_attempt_id=NULL WHERE owner_id=? AND id=?',[owner,m.call]);break;
 default:throw new Error('unknown test');
 }return true;
}}];
export const registry={migrations:base.migrations,actions:[...base.actions,...actions]};
