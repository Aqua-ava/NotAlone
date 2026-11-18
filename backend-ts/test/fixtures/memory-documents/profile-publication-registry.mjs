import {registry as base} from './unknown-registry.mjs';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {memoryBasis} from '../../../src/memory/sqlite/documents/basis.ts';
import {memoryDocumentsPublicationActions} from '../../../src/memory/sqlite/documents/publication.ts';

/** 仅用于独立合成库的故障注入，不在产品 registry 中注册。 */
export const registry={...base,actions:[...base.actions,
 {name:'fixture.profilePublicationMetrics',mode:'write',retryBusy:false,execute(tx,{ownerId,taskId,runId,stage},lease){
  let queries=0,semanticSourceChecks=0,writes=0;
  const measured={...tx,all:(sql,args)=>{queries++;if(sql.startsWith('SELECT v.restored_from_version_no,d.action '))semanticSourceChecks++;return tx.all(sql,args);},get:(sql,args)=>{queries++;if(sql.startsWith('SELECT v.restored_from_version_no,d.action '))semanticSourceChecks++;return tx.get(sql,args);},run:(sql,args)=>{writes++;return tx.run(sql,args);}};
  const action=memoryDocumentsPublicationActions.find(a=>a.name===`memoryDocuments.${stage}`),result=action.execute(measured,{ownerId,taskId,runId},lease);
  return {result,queries,semanticSourceChecks,writes};
 }},
 {name:'fixture.profilePublicationMemoBoundary',mode:'write',retryBusy:false,execute(tx,{ownerId,taskId,runId,stage},lease){
  const memory=tx.get("SELECT m.*,v.* FROM step_input i JOIN memory m ON m.owner_id=i.owner_id AND m.id=i.memory_id JOIN memory_version v ON v.owner_id=i.owner_id AND v.memory_id=i.memory_id AND v.version_no=i.memory_version_no JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id WHERE i.owner_id=? AND s.task_id=? AND i.kind='memory' LIMIT 1",[ownerId,taskId]);
  const m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,memory.memory_id]),v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memory.memory_id,memory.version_no]);
  const action=memoryDocumentsPublicationActions.find(a=>a.name===`memoryDocuments.${stage}`);
  return action.execute({...tx,run:()=>{
   tx.run(`UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND id IN (SELECT message_id FROM memory_citation WHERE owner_id=? AND memory_id=? AND version_no=?)`,[ownerId,ownerId,m.id,v.version_no]);
   let rejected=false;try{memoryBasis(tx,ownerId,m,v);}catch(error){rejected=['memory_source_stale','document_source_stale'].includes(error.code);}
   throw new StorageFailure(rejected?'fixture_memo_boundary_safe':'fixture_memo_crossed_write');
  }},{ownerId,taskId,runId},lease);
 }},
]};
