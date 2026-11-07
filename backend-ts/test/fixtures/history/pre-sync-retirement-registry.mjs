import {historicalSourceCopy} from './historical-source-copy.mjs';
import {registry as current} from '../../../src/storage/sqlite/registry.ts';
import {randomUUID} from 'node:crypto';
import {historyTarget} from '../../../src/history/sqlite/deletion-target.ts';
import {deletionTargetKey} from '../../../src/storage/sqlite/deletion/actions.ts';
import {legacyProofDigest} from '../../../src/storage/sqlite/migrations/history-legacy-proof-v1.ts';

export const registry={...current,migrations:current.migrations.filter(m=>m.version<=46),actions:[...current.actions,historicalSourceCopy,{name:'fixture.retirementArchive',mode:'write',retryBusy:false,execute(tx,i){
 const token=i.token,oldBinding=randomUUID(),old={...token,binding_id:oldBinding,grant_id:randomUUID(),verification_id:randomUUID()},legacyGeneration='legacy-proof-generation';
 const binding=tx.get('SELECT * FROM conversation_binding WHERE owner_id=? AND id=?',[token.owner_id,token.binding_id]);
 const insert=(table,row)=>{const fields=Object.keys(row);tx.run(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,Object.values(row));};
 insert('conversation_binding',{...binding,id:oldBinding,state:'revoked'});
 const target={protocol:'private-history-v1',descriptor:'synthetic-retirement-target',sourceGeneration:token.source_generation,partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],checkedPartitions:['shard-a']};
 const report={protocol:'private-history-v1',profileId:'synthetic-retirement-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:'synthetic-account',conversationKey:i.conversationKey,sourceGeneration:token.source_generation,programVersion:'synthetic',build:'1',artifactSha256:'b'.repeat(64),schemaFingerprint:'c'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',serverAliasSemantics:'unverified',continuity:'same-source-instances-normal-use-v1',capabilities:{normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported'}};
 const legacyReport={...report,artifactSha256:'a'.repeat(64),sourceGeneration:legacyGeneration};
 const legacyTarget={...target,sourceGeneration:legacyGeneration,tables:[{partition:'shard-a',instance:'legacy-live-instance'}]};
 const schema=t=>({sourceGeneration:t.sourceGeneration,checkedPartitions:t.checkedPartitions,tables:t.tables.map(x=>({partition:x.partition,target:x.instance,schemaVersion:'1',indexes:[],role:'message',columns:[],declaredPrimaryKey:['local_id'],autoIncrement:true,rootPage:'1',sqlFingerprint:'d'.repeat(64),triggerFingerprints:[]}))});
 const legacyScope={accountKey:report.accountKey,conversationKey:report.conversationKey,displayName:'合成联系人',sourceGeneration:legacyGeneration};
 const nextScope={...legacyScope,sourceGeneration:token.source_generation};
 const key=JSON.stringify([legacyGeneration,'shard-a','table-instance-1','1']);
 const candidates=[{key,target:{...target,sourceGeneration:legacyGeneration},report:legacyReport,token:{...old,source_generation:legacyGeneration}}];
 const proof={format:'notalone-legacy-recall-mapping-v1',token:old,observedAt:Date.now(),legacy:{scope:legacyScope,report:legacyReport,target:legacyTarget,schema:schema(legacyTarget)},current:{scope:nextScope,report,target,schema:schema(target)},keys:[{from:key,to:JSON.stringify([token.source_generation,'shard-a','table-instance-1','1']),reason:'source_recalled'}]};
 const mappings=[{from:JSON.stringify(['covered-point-generation','shard-a','table-instance-1','99']),to:JSON.stringify([token.source_generation,'shard-a','table-instance-1','99']),reason:'source_recalled'}];
 const archive={legacy_terminal_mapping:{proof,candidates,digest:legacyProofDigest({proof,candidates})},covered_terminal_mapping:{mappings,digest:legacyProofDigest({format:'notalone-current-recall-coverage-v1',mappings})}};
 if(i.variant==='digest'){archive.legacy_terminal_mapping.digest='0'.repeat(64);archive.covered_terminal_mapping.digest='0'.repeat(64);}
 const currentToken=i.variant==='owner'?{...token,owner_id:'wrong-owner'}:token;
 const at=Date.now(),id=randomUUID();
 insert('history_source_recertification',{owner_id:token.owner_id,id,contact_id:token.contact_id,request_key:id,runtime_id:'synthetic-old-runtime',state:i.variant==='incomplete'?'failed':'completed',stage:'completed',failure_code:null,started_at:at,updated_at:at,finished_at:at,old_binding_id:oldBinding,new_binding_id:token.binding_id,new_grant_id:token.grant_id,old_token_json:JSON.stringify(old),token_json:JSON.stringify(currentToken),target_json:JSON.stringify(target),support_json:JSON.stringify(report),guard_id:null,guard_state:'lost',goal_id:randomUUID(),preserved_message_count:0,old_fence_json:JSON.stringify(archive),old_scope_json:null,old_lease_json:null});
 if(i.variant?.startsWith('ledger')){
  const kind=i.variant==='ledger-pending-superseded'||i.variant==='ledger-completed-superseded'?'superseded_history':'contact';
  const completed=i.variant==='ledger-completed-superseded',operationId='synthetic-retired-operation';
  tx.run(`INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,accepted_generation,state,plan_revision,domain_manifest,runner_token,runner_runtime,created_at,completed_at)
   VALUES(?,?,?,?,?,?,0,?,1,'["history"]',?,?,0,?)`,[operationId,token.owner_id,'test',operationId,kind,token.contact_id,completed?'completed':'cleaning',completed?null:'old-runner',completed?null:'old-runtime',completed?1:null]);
  const key={owner_id:i.variant==='ledger-owner'?'other-owner':token.owner_id,id},target=historyTarget('history_source_recertification',key);
  const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  if(i.variant==='ledger-contact')tx.run('UPDATE deletion_operation SET contact_identity=? WHERE operation_id=?',[i.otherContactId,operationId]);
  tx.run(`INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,expected_identity,target_payload,plan_revision,state)
   VALUES(?,1,'row','history',?,'history_source_recertification',?,?,?,1,?)`,[operationId,deletionTargetKey(target),canonical(key),canonical(target.identity),i.variant==='ledger-payload'?'{}':canonical(target),i.variant==='ledger-cleared'?'cleared':'pending']);
  tx.run(`INSERT INTO deletion_check VALUES(?,1,'database_rows','history','passed',0,'old','checked')`,[operationId]);
  if(i.variant==='ledger-cleared')tx.run('DELETE FROM history_source_recertification WHERE owner_id=? AND id=?',[token.owner_id,id]);
  if(completed)tx.run(`INSERT INTO request_tombstone VALUES(?,'test','retired-request','revoked',0,?,0)`,[token.owner_id,operationId]);
 }
 return {id,oldBinding};
}}]};
