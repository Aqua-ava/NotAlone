import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {registry as seed} from './v25-quote-registry.mjs';
import {historyTarget} from '../../../src/history/sqlite/deletion-target.ts';
import {historyDeletionDomain} from '../../../src/history/sqlite/deletion.ts';
import {createDeletionActions,deletionTargetKey} from '../../../src/storage/sqlite/deletion/actions.ts';
import {deletionLedgerPruneMigration} from '../../../src/storage/sqlite/migrations/deletion-ledger-prune.ts';
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
// 截断迁移序列须携带删除模块的现行schema：当前动作完成时写target_summary并清逐行台账，该列由台账收敛迁移提供。
const version=Number(new URL(import.meta.url).searchParams.get('version')||46);
const migrations=base.migrations.filter(m=>m.version<=version);
if(version>=46)migrations.push(deletionLedgerPruneMigration(version+1));
export const registry={...base,migrations,actions:[...base.actions.filter(a=>!a.name.startsWith('deletion.')),...createDeletionActions({domains:[historyDeletionDomain],requiredDomains:['history'],authority:{fence(){return 1n;},verify(){return {result:'passed',proof:'synthetic'};}}}),...seed.actions,{name:'fixture.seedOldDelete',mode:'write',retryBusy:false,execute(tx,i){
const original=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?',[i.ownerId,i.goalId]);
const firstToken=JSON.parse(original.eligibility_json);
const appendGoal=(token,id,createdAt)=>tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,
 kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,created_at,creation_no)
 VALUES(?,?,?,?,?,?,?,'history',?,?,?,?,?,'running','running',?,(SELECT coalesce(max(creation_no),0)+1 FROM read_goal))`,
 [token.owner_id,id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),
  original.target_protocol,original.target_descriptor,original.target_json,JSON.stringify(token),original.support_json,createdAt]);
// 后插入的较大ID反而更早创建，不能用ID或插入顺序替代正式收集器的目标顺序。
appendGoal(firstToken,'z-synthetic-earlier-goal',original.created_at-1n);
if(i.scopeKind==='account'){
 const token={...firstToken,contact_id:'synthetic-secondary-contact',conversation_id:'synthetic-secondary-conversation',
  binding_id:'synthetic-secondary-binding',grant_id:'synthetic-secondary-grant',verification_id:'synthetic-secondary-verification'};
 tx.run('INSERT INTO contact(owner_id,id,selection_generation) VALUES(?,?,1)',[i.ownerId,token.contact_id]);
 tx.run("INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key) VALUES(?,?,?,'wechat.conversation.v1','synthetic-secondary-key')",[i.ownerId,token.conversation_id,token.account_id]);
 tx.run("INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,state) VALUES(?,?,?,?,'verified')",[i.ownerId,token.binding_id,token.contact_id,token.conversation_id]);
 const proof=JSON.stringify({support_profile:'synthetic-metadata-v1',source_generation:token.source_generation,account_id:token.account_id,conversation_id:token.conversation_id});
 tx.run("INSERT INTO binding_verification VALUES(?,?,?,0,'channel_metadata','identity-metadata-v1',?,?)",[i.ownerId,token.verification_id,token.binding_id,proof,original.created_at]);
 tx.run('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at) VALUES(?,?,?,?,?,1,?)',[i.ownerId,token.grant_id,token.contact_id,token.binding_id,token.verification_id,original.created_at]);
 const scope=tx.get('SELECT tables_json FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);
 tx.run('INSERT INTO history_continuity_scope VALUES(?,?,?,?,?)',[i.ownerId,token.contact_id,token.conversation_id,token.source_generation,scope.tables_json]);
 appendGoal(token,'synthetic-secondary-goal',original.created_at+1n);
}
const manifest='["history"]';
tx.run("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,accepted_generation,state,plan_revision,domain_manifest,runner_token,runner_runtime,created_at) VALUES('synthetic-delete',?,'test','synthetic-delete',?, ?,1,'cleaning',1,?,'old-runner','old-runtime',0)",[i.ownerId,i.scopeKind,i.scopeKind==='account'?null:i.contactId,manifest]);
const contacts=tx.all(`SELECT id FROM contact WHERE owner_id=?${i.scopeKind==='account'?'':' AND id=?'}`,
 i.scopeKind==='account'?[i.ownerId]:[i.ownerId,i.contactId]);
const goalIds=tx.all(`SELECT id FROM read_goal WHERE owner_id=?${i.scopeKind==='account'?'':' AND contact_id=? AND accepted_data_generation<1'}`,
 i.scopeKind==='account'?[i.ownerId]:[i.ownerId,i.contactId]);
const goals=goalIds.map(goal=>tx.get('SELECT id,contact_id,created_at FROM read_goal WHERE owner_id=? AND id=?',[i.ownerId,goal.id]));
for(const [index,contact] of contacts.entries()){
 const target=historyTarget('history_continuity_scope',{owner_id:i.ownerId,contact_id:contact.id});target.holderKeys=goals.map(goal=>'history:'+goal.id);
 tx.run("INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,expected_identity,target_payload,plan_revision,state,attempts) VALUES('synthetic-delete',?,'row','history',?,?,?,?,?,1,'pending',0)",[index+1,deletionTargetKey(target),target.rowKind,canonical(target.key),JSON.stringify(target.identity),canonical(target)]);
}
return {contacts:contacts.map(contact=>contact.id),goals};
}},{name:'fixture.migratedDeletionTargets',mode:'read',retryBusy:false,execute(tx,i){
 const row=tx.get("SELECT * FROM deletion_operation WHERE operation_id='synthetic-delete'");
 const op={ownerId:i.ownerId,operationId:'synthetic-delete',acceptedGeneration:row.accepted_generation,
  scope:row.scope_kind==='account'?{kind:'account'}:{kind:'contact',contactId:row.contact_identity}};
 return {stored:tx.all("SELECT target_payload FROM deletion_target WHERE operation_id='synthetic-delete' AND row_kind='source_proof'").map(row=>JSON.parse(row.target_payload)),
  collected:historyDeletionDomain.collect(tx,op).filter(target=>target.rowKind==='source_proof')};
}},{name:'fixture.migratedDeletionState',mode:'read',retryBusy:false,execute(tx){return {proofs:tx.all('SELECT * FROM source_proof'),goals:tx.all('SELECT id FROM read_goal')};}}]};
