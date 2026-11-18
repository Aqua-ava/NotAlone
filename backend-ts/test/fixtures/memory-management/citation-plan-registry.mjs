import {registry as base} from '../sqlite-reply-local-source-reuse-registry.mjs';
import {citations} from '../../../src/memory/sqlite/management/qualification.ts';

/** 合成回归：记录 citations() 实际发出的引文查询并取其查询计划；不改变任何生产动作。 */
export const registry={...base,actions:[...base.actions,{
 name:'fixture.citationPlan',mode:'read',retryBusy:false,
 execute(tx,{ownerId,parent}){
  const issued=[],recording={...tx,all(sql,values){if(/FROM memory_citation c\b/.test(sql))issued.push({sql,values});return tx.all(sql,values);}};
  let rows=null;
  try{rows=citations(recording,ownerId,{...parent,...(parent.versionNo===undefined?{}:{versionNo:BigInt(parent.versionNo)})}).length;}catch{/* 计划只取决于已发出的查询，不依赖来源资格。 */}
  return {rows,plans:issued.map(({sql,values})=>tx.all(`EXPLAIN QUERY PLAN ${sql}`,values).map(row=>String(row.detail)))};
 },
}]};
