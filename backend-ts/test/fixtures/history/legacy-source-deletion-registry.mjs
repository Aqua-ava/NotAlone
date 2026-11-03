import {registry as base} from './legacy-terminal-registry.mjs';
import {registry as diagnostics} from './source-epoch-deletion-registry.mjs';
import {randomUUID} from 'node:crypto';

export const registry={...base,actions:[...base.actions,...diagnostics.actions.filter(action=>action.name.startsWith('diag.')),
 {name:'fixture.legacyRecallCount',mode:'write',retryBusy:false,execute(tx,i){
  const rows=tx.all("SELECT r.* FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE r.owner_id=? AND r.contact_id=? AND r.reason_code='source_recalled' AND json_extract(g.target_json,'$.sourceGeneration')=? ORDER BY r.item_no",[i.ownerId,i.contactId,i.generation]);
  if(i.count<rows.length)for(const row of rows.slice(i.count))tx.run('DELETE FROM capture_record WHERE owner_id=? AND id=?',[i.ownerId,row.id]);
  else if(i.count>rows.length){const row=rows[0],key=JSON.parse(row.observed_key);key[3]='7';tx.run("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code) VALUES(?,?,?,?,?,'excluded',NULL,?,'source-table-local-v1',?,'1','source_recalled')",[i.ownerId,randomUUID(),i.contactId,row.capture_id,3,JSON.stringify({originalType:'1',serverId:'0',text:null}),JSON.stringify(key)]);}
 }},
 {name:'fixture.legacyNormal',mode:'write',retryBusy:false,execute(tx,i){
  const original=tx.get("SELECT * FROM capture_record WHERE owner_id=? AND contact_id=? AND state='normalized' AND json_extract(observed_key,'$[3]')=? LIMIT 1",[i.ownerId,i.contactId,i.localId]);
  const capture=tx.get("SELECT c.* FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE c.owner_id=? AND c.contact_id=? AND json_extract(g.target_json,'$.sourceGeneration')=? LIMIT 1",[i.ownerId,i.contactId,i.generation]);
  const key=JSON.stringify([i.generation,...JSON.parse(original.observed_key).slice(1)]);
  const message={...tx.get('SELECT * FROM message WHERE owner_id=? AND id=?',[i.ownerId,original.message_id]),id:randomUUID(),external_key:key,display_no:tx.get('SELECT max(display_no)+1 n FROM message').n};
  const insert=(table,row)=>{const keys=Object.keys(row);tx.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,keys.map(key=>row[key]));};
  insert('message',message);
  const alias=tx.get("SELECT * FROM message_alias WHERE owner_id=? AND message_id=? AND scheme='local'",[i.ownerId,original.message_id]);
  insert('message_alias',{...alias,id:randomUUID(),message_id:message.id,external_key:key});
  const source={...original,id:randomUUID(),capture_id:capture.id,message_id:message.id,observed_key:key,item_no:tx.get('SELECT max(item_no)+1 n FROM capture_record WHERE owner_id=? AND capture_id=?',[i.ownerId,capture.id]).n};
  insert('capture_record',source);return {sourceId:source.id,messageId:message.id,key};
 }},
 {name:'fixture.legacyAuditChange',mode:'write',retryBusy:false,execute(tx,i){
  const row=tx.get("SELECT * FROM history_source_recertification WHERE owner_id=? AND contact_id=? AND state='completed' ORDER BY started_at DESC LIMIT 1",[i.ownerId,i.contactId]);
  if(i.variant==='incomplete'){tx.run("UPDATE history_source_recertification SET state='failed' WHERE owner_id=? AND id=?",[i.ownerId,row.id]);return;}
  const archived=JSON.parse(row.old_fence_json);
  if(i.variant==='missing')delete archived.legacy_terminal_mapping;
  if(i.variant==='digest')archived.legacy_terminal_mapping.digest='0'.repeat(64);
  tx.run('UPDATE history_source_recertification SET old_fence_json=? WHERE owner_id=? AND id=?',[JSON.stringify(archived),i.ownerId,row.id]);
 }},
 {name:'fixture.legacyExclusions',mode:'read',retryBusy:false,execute(tx,i){return tx.all("SELECT external_key FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? AND scheme='local' ORDER BY external_key",[i.ownerId,i.conversationId]).map(row=>row.external_key);}}
]};
