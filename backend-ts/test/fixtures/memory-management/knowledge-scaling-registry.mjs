import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createMemoryKnowledgeReader} from '../../../src/memory/sqlite/management/knowledge.ts';
import {readReplyKnowledgeSource,selectReplyKnowledge} from '../../../src/reply/sqlite/candidates/knowledge-budget.ts';

const reader=createMemoryKnowledgeReader();
const counting=tx=>{
 const state={queries:0};const counted={...tx};
 for(const method of ['get','all','run'])counted[method]=(sql,values)=>{state.queries++;return tx[method](sql,values);};
 return {state,counted};
};
export const registry={...base,actions:[...base.actions,{
 // 回复挑选记忆的实际路径：先低成本列出，再只对入选条目逐条核验；与整体读取后再排序的结果对照。
 name:'fixture.measureSelection',mode:'read',retryBusy:false,
 execute(tx,input){
  const {state,counted}=counting(tx),start=performance.now();
  const lazy=selectReplyKnowledge(readReplyKnowledgeSource(counted,input.scope,reader),input.query);
  const lazyQueries=state.queries,lazyMs=performance.now()-start;
  state.queries=0;
  const eager=selectReplyKnowledge(reader.read(counted,input.scope),input.query);
  return {lazyIds:lazy.map(item=>item.id),eagerIds:eager.map(item=>item.id),lazyQueries,eagerQueries:state.queries,lazyMs,poolSize:reader.list(counted,input.scope).length};
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
  const start=performance.now(),items=reader.read(counted,scope);
  for(const item of items)reader.requireCurrent(counted,scope,item);
  return {count:items.length,ids:items.map(item=>item.id),queries,fullScans,elapsedMs:performance.now()-start};
 },
}]};
