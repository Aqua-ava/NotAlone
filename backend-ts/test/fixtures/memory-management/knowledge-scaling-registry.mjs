import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createMemoryKnowledgeReader} from '../../../src/memory/sqlite/management/knowledge.ts';

const reader=createMemoryKnowledgeReader();
export const registry={...base,actions:[...base.actions,{
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
