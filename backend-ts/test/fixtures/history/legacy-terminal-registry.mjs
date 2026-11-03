import {registry as base} from './recertify-registry.mjs';
import {randomUUID} from 'node:crypto';
const encode=v=>JSON.stringify(v,(_k,v)=>typeof v==='bigint'?String(v):v);
export const registry={...base,actions:[...base.actions,{name:'fixture.legacyRecalls',mode:'write',retryBusy:true,execute(tx,i){
 if(i.append){
  const r=tx.get(`SELECT c.id FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE c.owner_id=? AND c.contact_id=? AND json_extract(g.target_json,'$.sourceGeneration')=? LIMIT 1`,[i.ownerId,i.contactId,i.generation]);
  const start=Number(tx.get('SELECT coalesce(max(item_no),-1)+1 n FROM capture_record WHERE owner_id=? AND capture_id=?',[i.ownerId,r.id]).n);
  for(const [index,local]of i.locals.entries())tx.run("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code) VALUES(?,?,?,?,?,'excluded',NULL,?,?,?,'1',?)",[i.ownerId,randomUUID(),i.contactId,r.id,start+index,JSON.stringify({originalType:'1',serverId:'0',text:null}),i.scheme??'source-table-local-v1',JSON.stringify([i.generation,i.partition??'shard-a',i.table??'table-a',local]),i.reason??'source_recalled']);
  return true;
 }
 const old=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY creation_no DESC LIMIT 1',[i.ownerId,i.contactId]),goal={...old,id:randomUUID(),creation_no:tx.get('SELECT max(creation_no)+1 n FROM read_goal').n};
 const target=JSON.parse(goal.target_json),support=JSON.parse(goal.support_json),token=JSON.parse(goal.eligibility_json);target.sourceGeneration=i.generation;support.sourceGeneration=i.generation;token.source_generation=i.generation;goal.target_json=encode(target);if(i.supportStatus)support.status=i.supportStatus;goal.support_json=encode(support);goal.eligibility_json=encode(token);
 const keys=Object.keys(goal);tx.run(`INSERT INTO read_goal(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,keys.map(k=>goal[k]));
 const original=tx.get('SELECT * FROM sync_capture WHERE owner_id=? AND goal_id=? LIMIT 1',[i.ownerId,old.id]),capture={...original,id:randomUUID(),goal_id:goal.id,acceptance_no:tx.get('SELECT max(acceptance_no)+1 n FROM sync_capture').n};const captureKeys=Object.keys(capture);tx.run(`INSERT INTO sync_capture(${captureKeys.join(',')}) VALUES(${captureKeys.map(()=>'?').join(',')})`,captureKeys.map(k=>capture[k]));
 for(const [index,local]of (i.locals??['1','2','3']).entries()){const key=JSON.stringify([i.generation,i.partition??'shard-a',i.table??'table-a',local]);tx.run("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code) VALUES(?,?,?,?,?,'excluded',NULL,?,?,?,'1',?)",[i.ownerId,randomUUID(),i.contactId,capture.id,index,JSON.stringify({originalType:'1',serverId:'0',text:null}),i.scheme??'source-table-local-v1',key,i.reason??'source_recalled']);}
 if(i.currentSystem){const current=JSON.parse(old.eligibility_json);for(const local of (i.locals??['1','2','3']))tx.run('INSERT INTO history_source_terminal VALUES(?,?,?,?,?,?,?)',[i.ownerId,randomUUID(),i.contactId,current.binding_id,JSON.stringify([current.source_generation,'shard-a','table-a',local]),'source_system_replaced',BigInt(current.data_generation)]);}
 return true;
}}]};
