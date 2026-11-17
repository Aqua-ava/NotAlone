import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createMemoryKnowledgeReader} from '../../../src/memory/sqlite/management/knowledge.ts';
import {selectRankedReplyMemories} from '../../../src/reply/sqlite/candidates/knowledge-budget.ts';
import {REPLY_SEARCH_BUDGET} from '../../../src/reply/sqlite/retrieval-policy.ts';
import {rankReplyRetrieval} from '../../../src/retrieval/sqlite/search.ts';
import {sha256} from '../../../src/platform/sha256.ts';
import {readMemories} from '../reply-knowledge.mjs';

const reader=createMemoryKnowledgeReader();
const counting=tx=>{
 const state={queries:0};const counted={...tx};
 for(const method of ['get','all','run'])counted[method]=(sql,values)=>{state.queries++;return tx[method](sql,values);};
 return {state,counted};
};
export const registry={...base,actions:[...base.actions,{
 // 联系人 BM25 召回、资格补位与预算选择的局部测量；不包含正式请求的票据、最终冻结及深复验。
 name:'fixture.measureSelection',mode:'read',retryBusy:false,
 execute(tx,input){
  const {state,counted}=counting(tx),start=performance.now();
  const headers=reader.list(counted,input.scope).filter(item=>item.kind==='memory'&&item.scopeKind==='contact');
  const byId=new Map(headers.map(item=>[item.id,item])),opened=new Map();let openCount=0;
  const open=header=>{if(!opened.has(header.id)){openCount++;opened.set(header.id,reader.open(counted,input.scope,header));}return opened.get(header.id);};
  const select=(headers,open)=>{
   const result=rankReplyRetrieval(counted,{ownerId:input.scope.ownerId,contactId:input.scope.contactId,kind:'memory',query:input.query,
    scope:{kind:'memory',anchors:headers.map(item=>({id:item.id,versionNo:item.versionNo,textSeal:sha256(item.text)}))},limit:REPLY_SEARCH_BUDGET.contactMemories*3,
    qualify:hit=>{const header=byId.get(hit.id);return !!header&&header.versionNo===hit.versionNo&&!!open(header);}});
   return selectRankedReplyMemories({memories:headers,open},result.hits,{contact:REPLY_SEARCH_BUDGET.contactMemories,owner:0});
  };
  const lazy=select(headers,open);
  const lazyQueries=state.queries,lazyMs=performance.now()-start;
  state.queries=0;
  const eagerItems=readMemories(reader,counted,input.scope).filter(item=>item.kind==='memory'&&item.scopeKind==='contact'),eagerById=new Map(eagerItems.map(item=>[item.id,item]));
  const eager=select(eagerItems,header=>eagerById.get(header.id)??null);
  return {lazyIds:lazy.map(item=>item.id),eagerIds:eager.map(item=>item.id),lazyQueries,eagerQueries:state.queries,lazyMs,openCount,poolSize:headers.length};
 },
},{
 name:'fixture.measureKnowledge',mode:'read',retryBusy:false,
 execute(tx,scope){
  let queries=0,fullScans=0;
  const counted={...tx};
  for(const method of ['get','all','run'])counted[method]=(sql,values)=>{
   queries++;
   if(method==='all'&&sql.includes('FROM memory WHERE')&&!sql.includes('AND id='))fullScans++;
   return tx[method](sql,values);
  };
  const start=performance.now(),items=readMemories(reader,counted,scope);
  for(const item of items)reader.requireCurrent(counted,scope,item);
  return {count:items.length,ids:items.map(item=>item.id),queries,fullScans,elapsedMs:performance.now()-start};
 },
}]};
