import {registry as base} from '../../../src/storage/sqlite/registry.ts';

const decide=base.actions.find(action=>action.name==='memory.applyDecision');
export const registry={...base,actions:[...base.actions,{
 name:'fixture.seedManagementMemories',mode:'write',retryBusy:false,
 execute(tx,{ownerId,contactId,count,start=0},lease){
  for(let index=start;index<start+count;index++)decide.execute(tx,{ownerId,request:{requestKey:`pagination-${index}`,action:'manual',scope:{scopeKind:'contact',contactId},body:`第${index+1}条合成记忆`}},lease);
  return count;
 },
},{name:'fixture.updateManagementSourceTime',mode:'write',retryBusy:false,execute(tx,{ownerId,memoryId,sentAt}){
 tx.run('UPDATE message SET sent_at=? WHERE owner_id=? AND id IN(SELECT message_id FROM memory_citation WHERE owner_id=? AND memory_id=?)',[BigInt(sentAt),ownerId,ownerId,memoryId]);return true;
}}]};
