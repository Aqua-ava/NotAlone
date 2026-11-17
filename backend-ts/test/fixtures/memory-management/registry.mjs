import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createMemoryKnowledgeReader} from '../../../src/memory/sqlite/management/knowledge.ts';
import {createReplyLocalKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
import {qualificationSources,mergeKnowledgeSources} from '../../../src/memory/sqlite/management/dependencies.ts';
import {requireSources} from '../../../src/memory/sqlite/management/qualification.ts';
import {readMemories} from '../reply-knowledge.mjs';
const reader=createMemoryKnowledgeReader();
const localReader=createReplyLocalKnowledgeReader();
const candidateSources=(tx,i)=>{
 const citationSources=requireSources(tx,i.ownerId,{candidateId:i.candidateId}).map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_revision}));
 const dependencies=qualificationSources(tx,i.ownerId,{candidateId:i.candidateId});
 return {citationSources,qualificationSources:dependencies,sources:mergeKnowledgeSources(citationSources,dependencies)};
};
export const registry={...base,actions:[...base.actions,
 {name:'fixture.memoryKnowledge',mode:'read',retryBusy:false,execute:(tx,scope)=>readMemories(reader,tx,scope)},
 {name:'fixture.candidateSources',mode:'read',retryBusy:false,execute:candidateSources},
 {name:'fixture.legacyCandidateSnapshot',mode:'read',retryBusy:false,execute(tx,i){
  // 仅模拟历史材料冻结形状；公开读者没有候选枚举或注入入口。
  const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[i.ownerId,i.candidateId]);
  const item={kind:'memory_candidate',id:String(c.id),versionNo:1n,headRevision:c.state_revision,scopeKind:c.scope_kind==='self'?'owner':'contact',contactId:c.contact_id,publicationId:null,text:c.proposed_body,qualification:'unconfirmed',...candidateSources(tx,i)};
  return {item,headers:reader.list(tx,i),opened:reader.open(tx,i,item)};
 }},
 {name:'fixture.legacyCandidateRequireCurrent',mode:'read',retryBusy:false,execute(tx,input){localReader.requireCurrent(tx,input.scope,input.item);return true;}},
 {name:'fixture.reviseCandidate',mode:'write',retryBusy:false,execute(tx,input){tx.run('UPDATE memory_candidate SET state_revision=state_revision+1 WHERE owner_id=? AND id=?',[input.ownerId,input.candidateId]);}},
 {name:'fixture.memoryRequireCurrent',mode:'read',retryBusy:false,execute(tx,input){reader.requireCurrent(tx,input.scope,input.item);return true;}},
]};
