import {randomUUID} from 'node:crypto';
import {registry as base} from './quarantine-registry.mjs';
import {assertSourceEligibility} from '../../../src/history/sqlite/source.ts';

export const registry={...base,actions:[...base.actions,
 {name:'fixture.seedLegacyScope',mode:'write',retryBusy:false,execute(tx,i){
  const original=tx.get(`SELECT r.*,c.goal_id,c.read_epoch,c.runtime_token,c.captured_at,c.adapter_version FROM capture_record r
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id WHERE r.owner_id=? AND r.contact_id=? AND r.id=?`,[i.ownerId,i.contactId,i.recordId]);
  const goal=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?',[i.ownerId,original.goal_id]);
  const target=JSON.parse(goal.target_json),eligibility=JSON.parse(goal.eligibility_json),support=JSON.parse(goal.support_json);
  target.sourceGeneration=i.otherTable||i.currentScope?target.sourceGeneration:'retired-source-generation';
  if(i.otherTable)target.tables=target.tables.map(table=>({...table,instance:'retired-table-instance'}));
  target.descriptor+='-legacy';eligibility.source_generation=target.sourceGeneration;support.sourceGeneration=target.sourceGeneration;
  const goalId=randomUUID(),captureId=randomUUID(),recordId='00000000-0000-4000-8000-000000000099';
  tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,created_at,completed_partitions)
   VALUES(?,?,?,?,?,?,?,'history',?,?,?,?,?,'complete','complete',?,?)`,[i.ownerId,goalId,i.contactId,goal.binding_id,goal.grant_id,goal.accepted_data_generation,goal.accepted_barrier_generation,target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(eligibility),JSON.stringify(support),goal.created_at-1000n,JSON.stringify(target.partitions)]);
  tx.run(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest)
   VALUES(?,?,?,?,?,?,?,?,NULL,NULL,'accepted',?)`,[i.ownerId,captureId,i.contactId,goalId,original.read_epoch,original.runtime_token,original.captured_at,original.adapter_version,'a'.repeat(64)]);
  const raw=JSON.parse(original.raw_payload);raw.table=target.tables[0].instance;
  const key=JSON.stringify([target.sourceGeneration,raw.partition,raw.table,raw.localId]);
  tx.run(`INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version)
   VALUES(?,?,?,?,0,'normalized',?,?,'source-table-local-v1',?,'1')`,[i.ownerId,recordId,i.contactId,captureId,original.message_id,JSON.stringify(raw),key]);
  const unknown={...raw,localId:'500',sender:'unknown',stateAssurance:'unverified',text:null};
  tx.run(`INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code)
   VALUES(?,?,?,?,1,'quarantined',?,'source-table-local-v1',?,'1','message_state_unverified')`,[i.ownerId,randomUUID(),i.contactId,captureId,JSON.stringify(unknown),JSON.stringify([target.sourceGeneration,unknown.partition,unknown.table,unknown.localId])]);
  if(i.oldOnly){
   const id=randomUUID(),key=JSON.stringify([target.sourceGeneration,raw.partition,raw.table,'99']);
   tx.run(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,display_no)
    SELECT owner_id,?,contact_id,binding_id,identity_scheme,?,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,(SELECT max(display_no)+1 FROM message) FROM message WHERE owner_id=? AND id=?`,[id,key,i.ownerId,original.message_id]);
   tx.run(`INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version)
    VALUES(?,?,?,?,2,'normalized',?,?,'source-table-local-v1',?,'1')`,[i.ownerId,randomUUID(),i.contactId,captureId,id,JSON.stringify({...raw,localId:'99'}),key]);
  }
  return {recordId,messageId:String(original.message_id)};
 }},
 {name:'fixture.reorderImplicitRows',mode:'write',retryBusy:false,execute(tx,i){
  const rows=tx.all('SELECT rowid FROM capture_record WHERE owner_id=? AND contact_id=? ORDER BY rowid DESC',[i.ownerId,i.contactId]);
  let next=tx.get('SELECT coalesce(max(rowid),0) n FROM capture_record').n;
  for(const row of rows)tx.run('UPDATE capture_record SET rowid=? WHERE rowid=?',[++next,row.rowid]);
 }},
 {name:'fixture.compact',mode:'maintenance',retryBusy:false,execute(maintenance){maintenance.checkpoint();maintenance.vacuum();}},
 {name:'fixture.assertSource',mode:'read',retryBusy:false,execute(tx,i){assertSourceEligibility(tx,i);return true;}},
]};
