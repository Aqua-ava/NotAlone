import {registry as base} from './adjudication-registry.mjs';

const claim=base.actions.find(action=>action.name==='memoryAdjudication.claim');

/** 完整执行正式领取及触发器后回滚；只统计语句数量与时间，不镜像业务判断。 */
const measuredClaim={name:'fixture.measuredAdjudicationClaim',mode:'write',retryBusy:false,execute(tx,input,lease){
 const counts={get:0,all:0,run:0,qualificationQueries:0,maxQualificationRows:0,executionInputs:0,eventSources:0};
 const statements=new Map();
 const count=sql=>{const key=sql.replace(/\s+/g,' ').trim();statements.set(key,(statements.get(key)??0)+1);};
 const measured={...tx,
  get(sql,values){counts.get++;count(sql);return tx.get(sql,values);},
  all(sql,values){counts.all++;count(sql);const rows=tx.all(sql,values);if(/^\s*WITH RECURSIVE versions/.test(sql)){counts.qualificationQueries++;counts.maxQualificationRows=Math.max(counts.maxQualificationRows,rows.length);}return rows;},
  run(sql,values){counts.run++;count(sql);if(/^INSERT INTO execution_input/.test(sql))counts.executionInputs++;if(/^INSERT OR IGNORE INTO event_source/.test(sql))counts.eventSources++;return tx.run(sql,values);},
 };
 tx.run('SAVEPOINT synthetic_adjudication_growth');const began=performance.now();
 try{
  const result=claim.execute(measured,input,lease);
  if(!result)throw new Error('synthetic_growth_claim_not_available');
  return {parents:result.basis.parents.length,...counts,reads:counts.get+counts.all,total:counts.get+counts.all+counts.run,elapsedMs:performance.now()-began,
   mostRepeated:Math.max(0,...statements.values())};
 }finally{tx.run('ROLLBACK TO synthetic_adjudication_growth');tx.run('RELEASE synthetic_adjudication_growth');}
}};

export const registry={...base,actions:[...base.actions,measuredClaim]};
