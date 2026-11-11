import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../../../src/storage/sqlite/client.ts';
import {owner} from '../memory-sqlite/support.mjs';
import {memory as memoryProducer} from '../memory-sqlite/shared-producer-registry.mjs';
import assert from 'node:assert/strict';

/** v11 的历史种子只写当时真实存在的表，不调用现行联系人、来源核对或记忆 Controller。 */
export const legacyHistorySeed={name:'fixture.legacyHistorySeed',mode:'write',retryBusy:false,execute(tx,{withOwnerMessages=false}){
 const account=randomUUID(),contacts=[];let display=0;
 tx.run('INSERT INTO owner(owner_id,read_enabled,created_at) VALUES(?,1,1)',[owner]);
 tx.run("INSERT INTO channel_account(owner_id,id,identity_scheme,external_key,identity_state,source_generation) VALUES(?,?,'wechat.account.v1','synthetic-account','verified','synthetic-generation')",[owner,account]);
 for(let index=0;index<2;index++){
  const contact=randomUUID(),conversation=randomUUID(),binding=randomUUID(),verification=randomUUID(),grant=randomUUID(),goal=randomUUID(),capture=randomUUID();
  tx.run('INSERT INTO contact(owner_id,id,display_name,selection_generation) VALUES(?,?,?,1)',[owner,contact,`历史合成联系人${index}`]);
  tx.run("INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key,display_name) VALUES(?,?,?,'wechat.conversation.v1',?,?)",[owner,conversation,account,`historical-friend-${index}`,`历史合成联系人${index}`]);
  tx.run("INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,state) VALUES(?,?,?,?,'verified')",[owner,binding,contact,conversation]);
  tx.run("INSERT INTO binding_verification(owner_id,id,binding_id,identity_generation,method,proof_format,proof,verified_at) VALUES(?,?,?,0,'channel_metadata','identity-metadata-v1','{}',1)",[owner,verification,binding]);
  tx.run('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at) VALUES(?,?,?,?,?,1,1)',[owner,grant,contact,binding,verification]);
  tx.run("INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,created_at) VALUES(?,?,?,?,?,0,0,'history','private-history-v1','historical-synthetic','{}','{}','{}','complete','complete',1)",[owner,goal,contact,binding,grant]);
  tx.run("INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,state,response_digest) VALUES(?,?,?,?,0,'historical-runtime',1,'synthetic-v1','accepted',?)",[owner,capture,contact,goal,'a'.repeat(64)]);
  const messages=[];
  for(const [item,sender] of (withOwnerMessages?['contact','owner']:['contact']).entries()){
   const message=randomUUID(),record=randomUUID(),text=sender==='owner'?'我长期偏好合成绿茶。':'我长期住在合成海城。';
   tx.run("INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,display_no) VALUES(?,?,?,?,'synthetic.local',?,?,'text',?,'1',1700000000,'second',?)",[owner,message,contact,binding,String(item+1),sender,text,++display]);
   tx.run("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version) VALUES(?,?,?,?,?,'normalized',?,?,'local',?,'synthetic-v1')",[owner,record,contact,capture,item,message,JSON.stringify({synthetic:true,text}),String(item+1)]);
   messages.push({contactId:contact,messageId:message,recordId:record,text,sender});
  }
  contacts.push({contactId:contact,bindingId:binding,messages,...messages[0]});
 }
 return contacts;
}};

/** 按 v11 真实生产者、固定输入和外键建立旧候选；不把现行模型回复写回旧合同。 */
export const legacyCandidateSeed={name:'fixture.legacyCandidateSeed',mode:'write',retryBusy:false,execute(tx,{contacts,ownerCopies=1,onlyOwner=false}){
 const candidates=[];
 for(const contact of contacts)for(const message of contact.messages){
  if(onlyOwner&&message.sender!=='owner')continue;
  const self=message.sender==='owner',contexts=self?contacts.filter(other=>other.contactId!==message.contactId).flatMap(other=>other.messages.filter(row=>row.sender==='owner')):[];
  const m=memoryProducer(tx,owner,message.contactId,message.messageId,message.recordId,self?'self':'contact',contexts);
  tx.run("UPDATE step_attempt SET state='succeeded',finished_at=1 WHERE owner_id=? AND id=?",[owner,m.attempt]);
  tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[m.attempt,owner,m.step]);
  tx.run("UPDATE processing_task SET state='succeeded' WHERE owner_id=? AND id=?",[owner,m.task]);
  tx.run("UPDATE processing_item SET extraction_state='succeeded' WHERE owner_id=? AND id=?",[owner,m.item]);
  for(let copy=0;copy<(self?ownerCopies:1);copy++){
   const id=randomUUID(),event=randomUUID(),output=copy+2,body=message.text.replace(/^我/,self?'用户':'联系人');
   const fact={text:body,subject:self?'self':'contact',source_message_ids:[message.messageId]};
   tx.run("INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,?,'verified_output',?,?,1)",[owner,event,m.attempt,output,m.call,JSON.stringify({fact,outputNo:output,scopeKind:self?'self':'contact',contactId:self?null:message.contactId,origin:'auto',state:'verified_pending_decision'})]);
   tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,1,'target',1,?,1)",[owner,event,m.step]);
   tx.run('INSERT INTO event_source VALUES(?,?,?,?)',[owner,event,message.contactId,message.recordId]);
   tx.run("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state) VALUES(?,?,?,?,?,?,?,?,'pending')",[owner,id,self?'self':'contact',self?null:message.contactId,body,m.attempt,event,output]);
   tx.run('INSERT INTO memory_required_message VALUES(?,?,?,NULL,NULL,?,?)',[owner,randomUUID(),id,message.contactId,message.messageId]);
   tx.run('INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation) VALUES(?,?,?,NULL,NULL,?,?,?,1,0,?,NULL)',[owner,randomUUID(),id,message.contactId,message.messageId,message.recordId,Array.from(message.text).length]);
   candidates.push({id,scopeKind:self?'self':'contact',contactId:message.contactId,...m});
  }
 }
 return candidates;
}};

export const legacyWithdraw={name:'fixture.legacyWithdraw',mode:'write',retryBusy:false,execute(tx,{owner,memoryId}){
 const memory=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,memoryId]);
 tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,target_memory_id,expected_version_no,expected_head_revision,created_at,outcome) VALUES(?,?,?,'withdraw','user',?,?,?,1,'applied')",[owner,randomUUID(),randomUUID(),memoryId,memory.current_version_no,memory.head_revision]);
 tx.run("UPDATE memory SET state='withdrawn',head_revision=head_revision+1 WHERE owner_id=? AND id=?",[owner,memoryId]);
 return tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,memoryId]);
}};

export async function legacyAdjudicationFixture(t,registryModule,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-adjudication-v11-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 assert.equal(storage.status.schemaVersion,11,'历史种子必须运行在真正 v11 结构');
 const contacts=await storage.execute('fixture.legacyHistorySeed',options);
 return {root,storage,contacts,saved:contacts.map(c=>({contact_id:c.contactId,binding_id:c.bindingId}))};
}
