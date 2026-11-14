import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {withReplyLocalSourceEligibility} from '../../../history/sqlite/reply-local-source.ts';
import type {DiscussionScope} from '../contracts.ts';
import type {ReplyKnowledgeItem,ReplyKnowledgeReader} from './contracts.ts';

interface ValidationScope {revision:number;verified:WeakMap<ReplyKnowledgeReader,Set<string>>}
const scopes=new WeakMap<StorageTransaction,ValidationScope>();
const key=(scope:DiscussionScope,kind:string,value:unknown)=>JSON.stringify([scope.ownerId,scope.contactId,scope.discussionId,kind,value],(_key,item)=>typeof item==='bigint'?{$integer:item.toString()}:item);
function remember(state:ValidationScope,reader:ReplyKnowledgeReader,keys:readonly string[]):void{
 const verified=state.verified.get(reader)??new Set<string>();for(const item of keys)verified.add(item);state.verified.set(reader,verified);
}

/** 仅由同步存储动作建立；任何写入或派生结清均作废，退出即销毁，不跨动作保留资格。 */
export function withReplyValidation<T>(tx:StorageTransaction,work:(scoped:StorageTransaction)=>T):T{
 if(scopes.has(tx))return work(tx);
 const state:ValidationScope={revision:0,verified:new WeakMap()};
 const invalidate=()=>{state.revision++;state.verified=new WeakMap();};
 const guarded:StorageTransaction={...tx,run(sql,values){invalidate();tx.run(sql,values);},
  ...(tx.flushDerived?{flushDerived(){invalidate();tx.flushDerived!();}}:{})};
 return withReplyLocalSourceEligibility(guarded,scoped=>{
  scopes.set(scoped,state);try{return work(scoped);}finally{scopes.delete(scoped);}
 });
}

/** 只复用完整成功的验证；工作期间发生写入时不能登记写入前的成功。 */
export function requireReplyValidation(tx:StorageTransaction,reader:ReplyKnowledgeReader,scope:DiscussionScope,kind:'request'|'context',identity:unknown,validate:()=>void):void{
 const state=scopes.get(tx),identityKey=key(scope,kind,identity);
 if(state?.verified.get(reader)?.has(identityKey))return;
 const revision=state?.revision;validate();
 if(state&&state.revision===revision)remember(state,reader,[identityKey]);
}

/** 身份包含完整冻结快照，正文、投影、发布集合、来源或修订不同均不能沿用既有成功。 */
export function requireFrozenReplyKnowledge(tx:StorageTransaction,scope:DiscussionScope,items:readonly ReplyKnowledgeItem[],reader:ReplyKnowledgeReader):void{
 const state=scopes.get(tx);
 if(!state){
  if(reader.requireFrozenBatch)reader.requireFrozenBatch(tx,scope,items);
  else for(const item of items)(reader.requireFrozen??reader.requireCurrent)(tx,scope,item);
  return;
 }
 const verified=state.verified.get(reader),pending=new Map<string,ReplyKnowledgeItem>();
 for(const item of items){const identity=key(scope,'knowledge',item);if(!verified?.has(identity))pending.set(identity,item);}
 if(!pending.size)return;
 const revision=state?.revision,missing=[...pending.values()];
 if(reader.requireFrozenBatch)reader.requireFrozenBatch(tx,scope,missing);
 else for(const item of missing)(reader.requireFrozen??reader.requireCurrent)(tx,scope,item);
 if(state&&state.revision===revision)remember(state,reader,[...pending.keys()]);
}
