import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {fenceSource,getProof,isSourceBlocked,putScope} from '../../../src/history/sqlite/source-proof.ts';
import {historySourceProofMigration} from '../../../src/history/sqlite/source-proof-schema.ts';
import {historyTarget} from '../../../src/history/sqlite/deletion-target.ts';
import {deletionTargetKey} from '../../../src/storage/sqlite/deletion/actions.ts';

const options=new URL(import.meta.url).searchParams;
const attempts=new Map();
const migrations=base.migrations.filter(m=>m.version<=45);
export const registry={migrations:options.get('mode')==='upgrade'?[...migrations,historySourceProofMigration(46)]:migrations,actions:[
 {name:'fixture.seedProofs',mode:'write',retryBusy:false,execute(tx){
  const owner='synthetic-owner';tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,0)',[owner]);
  tx.run("INSERT INTO channel_account(owner_id,id,identity_scheme,external_key,identity_state,source_generation) VALUES(?,?,'wechat.account.v1',?,'verified',?)",[owner,'account-a','account-key-a','generation-a']);
  for(const contact of ['a','b','c']){
   tx.run('INSERT INTO contact(owner_id,id) VALUES(?,?)',[owner,contact]);
   tx.run("INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key) VALUES(?,?,'account-a','wechat.private.v1',?)",[owner,'conversation-'+contact,'conversation-key-'+contact]);
   tx.run("INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,state) VALUES(?,?,?,?,'verified')",[owner,'binding-'+contact,contact,'conversation-'+contact]);
   const tables=JSON.stringify({accountKey:contact==='c'?'other-account':'account-key-a',partitions:['partition-a'],tables:[['partition-a','table-a']],checkedPartitions:['partition-a']});
   tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[owner,contact,'conversation-'+contact,'generation-a',tables]);
   tx.run("INSERT INTO history_guard_lease VALUES(?,?,?,?,?,?,?,'lost')",[owner,contact,'binding-'+contact,'conversation-'+contact,'generation-a','guard-'+contact,'old-runtime']);
  }
  tx.run('INSERT INTO history_continuity_fence VALUES(?,?,?)',[owner,'b','history_source_continuity_unverified']);
  return owner;
 }},
 {name:'fixture.seedProofDeletion',mode:'write',retryBusy:false,execute(tx){
  tx.run("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,accepted_generation,state,plan_revision,domain_manifest,runner_token,runner_runtime,created_at) VALUES('delete-a','synthetic-owner','test','delete-a','contact','a',0,'cleaning',1,'[\"history\"]','old-runner','old-runtime',0)");
  const kinds=['history_continuity_fence','history_continuity_scope','history_guard_lease'];
  for(const [index,kind]of kinds.entries()){
   const target=historyTarget(kind,{owner_id:'synthetic-owner',contact_id:'a'});
   tx.run('INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,expected_identity,target_payload,plan_revision,state,attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',['delete-a',index+1,'row','history',deletionTargetKey(target),kind,JSON.stringify(target.key),JSON.stringify(target.identity),JSON.stringify(target),1,index===0?'cleared':index===1?'pending':'failed',index]);
  }
  return null;
 }},
 {name:'fixture.breakProofScope',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE history_continuity_scope SET tables_json=? WHERE owner_id=? AND contact_id=?',[i.tablesJson,'synthetic-owner','a']);return null;}},
 {name:'fixture.fenceProof',mode:'write',retryBusy:false,execute(tx,i){fenceSource(tx,{owner_id:'synthetic-owner',contact_id:i.contactId},'G01');return {blocked:isSourceBlocked(tx,'synthetic-owner',i.contactId),proof:getProof(tx,'synthetic-owner',i.contactId),revision:tx.get('SELECT source_revision FROM contact WHERE owner_id=? AND id=?',['synthetic-owner',i.contactId]).source_revision};}},
 {name:'fixture.proofLedger',mode:'read',retryBusy:false,execute(tx){return tx.all('SELECT version,checksum FROM schema_migration ORDER BY version');}},
 {name:'fixture.legacyProofSnapshot',mode:'read',retryBusy:false,execute(tx){return {tables:tx.all("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map(r=>r.name),scopes:tx.all('SELECT * FROM history_continuity_scope ORDER BY contact_id'),ledger:tx.all('SELECT version,checksum FROM schema_migration ORDER BY version')};}},
 {name:'fixture.corruptProofDeletion',mode:'write',retryBusy:false,execute(tx){tx.run("UPDATE deletion_target SET row_key_snapshot=? WHERE operation_id='delete-a' AND target_no=2",[JSON.stringify({owner_id:'other-owner',contact_id:'a'})]);return null;}},
 {name:'fixture.refreshProof',mode:'write',retryBusy:false,execute(tx,i){const token={owner_id:'synthetic-owner',contact_id:'b',account_id:'account-a',conversation_id:'conversation-b',source_generation:'generation-a'};const prior=getProof(tx,token.owner_id,token.contact_id);putScope(tx,token,prior.tables_json,{checkedAt:123,...(i.confirm?{state:'ok'}:{})});return getProof(tx,token.owner_id,token.contact_id);}},
 {name:'fixture.proofSnapshot',mode:'read',retryBusy:false,execute(tx){return {tables:tx.all("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map(r=>r.name),proofs:tx.all('SELECT * FROM source_proof ORDER BY owner_id,contact_id'),targets:tx.all('SELECT * FROM deletion_target ORDER BY operation_id,target_no'),operations:tx.all('SELECT * FROM deletion_operation ORDER BY operation_id'),ledger:tx.all('SELECT version,checksum FROM schema_migration ORDER BY version')};}},
 {name:'fixture.runtimeWrite',mode:'write',retryBusy:true,execute(tx,i){tx.runtimeSet('history-source-guard',i.key,i.value);return tx.runtimeGet('history-source-guard',i.key);}},
 {name:'fixture.runtimeFailure',mode:'write',retryBusy:true,execute(tx,i){
  const before=tx.runtimeGet('history-source-guard',i.key);
  if(i.failure==='delete')tx.runtimeDelete('history-source-guard',i.key);else tx.runtimeSet('history-source-guard',i.key,i.value);
  if(i.failure==='clone')return ()=>null;
  if(i.failure==='commit'){tx.run('PRAGMA defer_foreign_keys=ON');tx.run("INSERT INTO contact(owner_id,id) VALUES('missing-owner','bad-contact')");return null;}
  if(i.failure==='busy'){
   const attempt=(attempts.get(i.key)??0)+1;attempts.set(i.key,attempt);
   if(attempt===1)throw Object.assign(new Error('synthetic busy'),{errcode:5});return {before,attempt};
  }
  throw new Error('synthetic rollback');
 }},
 {name:'fixture.runtimeReadMutation',mode:'read',retryBusy:false,execute(tx,i){tx.runtimeSet('history-source-guard',i.key,i.value);return null;}},
 {name:'fixture.runtimeAlias',mode:'write',retryBusy:false,execute(tx,i){tx.runtimeSet('history-source-guard',i.key,i.value);i.value.state='mutated-input';const got=tx.runtimeGet('history-source-guard',i.key);got.state='mutated-output';return got;}},
 {name:'fixture.runtimeRemove',mode:'write',retryBusy:false,execute(tx,i){tx.runtimeDelete('history-source-guard',i.key);return tx.runtimeGet('history-source-guard',i.key)??null;}},
 {name:'fixture.runtimeRead',mode:'read',retryBusy:false,execute(tx,i){return tx.runtimeGet('history-source-guard',i.key)??null;}},
]};
