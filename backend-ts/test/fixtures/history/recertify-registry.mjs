import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {randomUUID} from 'node:crypto';
import {saveHistoryQuoteInTransaction} from '../../../src/history/sqlite/quote-store.ts';
const actions=[{name:'fixture.recertifyQuoteWrite',mode:'write',retryBusy:true,execute:(tx,i)=>saveHistoryQuoteInTransaction(tx,i.input,i.cap)},
 {name:'fixture.recertifyCheckedManifest',mode:'write',retryBusy:true,execute(tx,i){const r=tx.get('SELECT tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]),target=JSON.parse(r.tables_json);target.checkedPartitions=i.checked;tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[JSON.stringify(target),i.ownerId,i.contactId]);return true;}},{name:'fixture.recertifySnapshot',mode:'read',retryBusy:true,execute(tx,i){
 const rows=table=>tx.all(`SELECT * FROM ${table} WHERE owner_id=? AND contact_id=? ORDER BY rowid`,[i.ownerId,i.contactId]);
 return {messages:rows('message'),captures:rows('capture_record'),aliases:rows('message_alias'),operations:rows('history_source_recertification'),terminals:rows('history_source_terminal'),fences:rows('history_continuity_fence'),leases:rows('history_guard_lease'),quotes:rows('history_quote'),quoteAttempts:rows('history_quote_attempt')};
}},{name:'fixture.recertifyTerminal',mode:'write',retryBusy:true,execute(tx,i){
 const m=tx.get('SELECT * FROM message WHERE owner_id=? AND contact_id=? LIMIT 1',[i.ownerId,i.contactId]),b=tx.get('SELECT * FROM conversation_binding WHERE owner_id=? AND id=?',[i.ownerId,m.binding_id]);
 const local=tx.get("SELECT * FROM message_alias WHERE owner_id=? AND message_id=? AND scheme='local'",[i.ownerId,m.id]);
 if(i.mode==='rawTerminal'){
  const r=tx.get('SELECT * FROM capture_record WHERE owner_id=? AND message_id=? LIMIT 1',[i.ownerId,m.id]),key=JSON.parse(local.external_key);key[3]='999';
  const item=tx.get('SELECT max(item_no)+1 next FROM capture_record WHERE owner_id=? AND capture_id=?',[i.ownerId,r.capture_id]).next;
  tx.run("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code) VALUES(?,?,?,?,?,'excluded',NULL,?,'source-table-local-v1',?,'1','source_recalled')",[i.ownerId,randomUUID(),i.contactId,r.capture_id,item,JSON.stringify({originalType:'1',serverId:'999',text:null}),JSON.stringify(key)]);return true;
 }
 if(i.mode==='globalFence')tx.run('INSERT INTO history_deletion_fence VALUES(?,?,?)',[i.ownerId,i.contactId,'synthetic-preserved-global-fence']);
 else if(i.mode==='exclusion')tx.run("INSERT INTO history_source_exclusion VALUES(?,?,'local',?,?)",[i.ownerId,b.conversation_id,local.external_key,'synthetic-prior-exclusion']);
 else if(i.mode==='quarantine')tx.run('INSERT INTO history_message_quarantine VALUES(?,?,?,?)',[i.ownerId,i.contactId,m.id,'source_recalled']);
 else tx.run('INSERT INTO history_source_terminal VALUES(?,?,?,?,?,?,?)',[i.ownerId,randomUUID(),i.contactId,m.binding_id,local.external_key,'source_recalled',0n]);
 if(i.server)tx.run("INSERT INTO message_alias VALUES(?,?,?,?,'server','999',?)",[i.ownerId,randomUUID(),i.contactId,m.binding_id,m.id]);return true;
}}];
export const registry={...base,actions:[...base.actions,...actions]};
