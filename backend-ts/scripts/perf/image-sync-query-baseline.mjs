#!/usr/bin/env node
/**
 * 候选回复生成准备延迟优化 P01 的可重复基线/对照脚本。
 *
 * 在同一套确定性合成数据集上：
 *   1. 通过公开存储动作运行 `media.imageSyncTargets`／`media.imageRefreshPending`；
 *   2. 直接执行修改前冻结的相关子查询 SQL，记录耗时与查询计划；
 *   3. 按 `--emit-golden` 采集公开动作的黄金样例，供回归测试比较修改前后结果。
 *
 * 用法（在仓库根目录）：
 *   node backend-ts/scripts/perf/image-sync-query-baseline.mjs
 *   node backend-ts/scripts/perf/image-sync-query-baseline.mjs --emit-golden
 *   node backend-ts/scripts/perf/image-sync-query-baseline.mjs --label=after --runs=12
 *
 * 只读本地合成数据库；不启动 App、不访问网络、不读取真实聊天资料。
 *
 * ADR-170 之后：冻结的修改前 SQL 仅用于对照耗时与查询计划；它仍把缩略图／未知分类图片当作待办，
 * 因此 `firstPageAgainstFrozenLegacy` 预期为 false，不再表示回归。
 */
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from '../../test/media-support.mjs';
import {
 SCENARIO_NOW,buildEdgeScenario,buildLargeScenario,collectCases,databasePath,normalizeTargets,
} from '../../test/fixtures/sqlite-image-sync/scenarios.mjs';
import {legacyImageSyncWorkSql} from '../../test/fixtures/sqlite-image-sync/legacy-work-sql.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
const goldenPath=resolve(root,'test/fixtures/sqlite-image-sync/golden.json');

const args=new Map(process.argv.slice(2).map(argument=>{
 const [key,value='true']=argument.replace(/^--/,'').split('=');
 return [key,value];
}));
const runs=Number(args.get('runs')??10);
const label=args.get('label')??'current';
const emitGolden=args.has('emit-golden');
if(!Number.isSafeInteger(runs)||runs<3||runs>50)throw new Error('--runs 必须是 3–50 的整数');

function stats(samples){
 const sorted=[...samples].sort((left,right)=>left-right);
 const at=quantile=>sorted[Math.min(sorted.length-1,Math.ceil(quantile*sorted.length)-1)];
 const round=value=>Number(value.toFixed(3));
 return {samples:samples.length,p50Ms:round(at(0.5)),p95Ms:round(at(0.95)),maxMs:round(sorted.at(-1)),meanMs:round(samples.reduce((sum,value)=>sum+value,0)/samples.length)};
}

async function sample(fn,warmups=2,count=runs){
 for(let index=0;index<warmups;index++)await fn();
 const samples=[];
 for(let index=0;index<count;index++){
  const started=performance.now();await fn();
  samples.push(performance.now()-started);
 }
 return stats(samples);
}

function sampleSync(fn,warmups=2,count=runs){
 for(let index=0;index<warmups;index++)fn();
 const samples=[];
 for(let index=0;index<count;index++){
  const started=performance.now();fn();
  samples.push(performance.now()-started);
 }
 return stats(samples);
}

/** 参数按 owner/contact 成对出现；返回与占位符数量一致的值数组。 */
function scopedParameters(sql,owner,contact){
 const placeholders=(sql.match(/\?/g)??[]).length;
 if(placeholders%2!==0)throw new Error(`unexpected placeholder count ${placeholders}`);
 return Array.from({length:placeholders/2},()=>[owner,contact]).flat();
}

/** 找出“相关子查询内部扫描尝试表”的计划节点；修改前实现应命中，修改后应为空。 */
function correlatedAttemptScans(plan){
 const parentById=new Map(plan.map(row=>[row.id,row.parent]));
 return plan.flatMap(node=>{
  if(!/^CORRELATED SCALAR SUBQUERY/.test(node.detail))return [];
  const descendants=new Set();
  for(const row of plan){
   let parent=row.parent;
   while(parent){
    if(parent===node.id){descendants.add(row.id);break;}
    parent=parentById.get(parent);
   }
  }
  return plan
   .filter(row=>descendants.has(row.id)&&/media_attempt_record|media_extraction_attempt/.test(row.detail))
   .map(row=>({subquery:node.detail,scan:row.detail}));
 });
}

function planFor(db,sql,tail,parameters){
 return db.prepare(`EXPLAIN QUERY PLAN ${sql}${tail}`).all(...parameters).map(row=>({id:row.id,parent:row.parent,detail:row.detail}));
}

function datasetCounts(db,owner,contactId){
 const count=(sql)=>{const row=db.prepare(sql).get(owner,contactId);return Number(Object.values(row)[0]);};
 return {
  imageMessages:count("SELECT count(*) FROM message WHERE owner_id=? AND contact_id=? AND kind='image'"),
  availableImageMessages:count("SELECT count(*) FROM message WHERE owner_id=? AND contact_id=? AND kind='image' AND availability='available'"),
  mediaHeads:count('SELECT count(*) FROM message_media WHERE owner_id=? AND contact_id=?'),
  mediaFiles:count('SELECT count(*) FROM media_file WHERE owner_id=? AND contact_id=?'),
  extractionAttempts:count('SELECT count(*) FROM media_extraction_attempt WHERE owner_id=? AND contact_id=?'),
  legacyAttempts:count("SELECT count(*) FROM media_extraction_attempt WHERE owner_id=? AND contact_id=? AND adapter_version<>'image-preflight-v1'"),
  preparationAttempts:count("SELECT count(*) FROM media_extraction_attempt WHERE owner_id=? AND contact_id=? AND adapter_version='image-preflight-v1'"),
  captures:count('SELECT count(*) FROM capture_record WHERE owner_id=? AND contact_id=?'),
 };
}

async function openScenarioFixture(kind,builder){
 const cleanups=[];
 const f=await fixture({after:handler=>cleanups.push(handler)},null);
 const scenario=await builder(f);
 return {
  f,scenario,
  cleanup:async()=>{for(const handler of cleanups.reverse())await handler();},
 };
}

async function main(){
 const actions=await import('../../src/media/sqlite/image-sync-actions.ts');
 const currentWorkSql=actions.imageSyncWorkSql??legacyImageSyncWorkSql;
 const sqlSource=actions.imageSyncWorkSql?'src':'frozen-legacy-fallback';

 // 边界场景：结果黄金样例。
 const edge=await openScenarioFixture('edge',f=>buildEdgeScenario(f));
 let edgeResults;
 try{edgeResults=await collectCases(edge.f.storage,edge.scenario);}
 finally{await edge.cleanup();}

 // 大联系人场景：基准测量与遍历结果。
 const large=await openScenarioFixture('large',f=>buildLargeScenario(f));
 try{
  const {f,scenario}=large;
  const contactId=scenario.contacts.large.contactId;
  const targetsInput=after=>({ownerId:scenario.owner,contactId,after,now:SCENARIO_NOW});
  const largeResults=await collectCases(f.storage,scenario);
  const counts=datasetCounts(new DatabaseSync(databasePath(f.root),{readOnly:true}),scenario.owner,contactId);

  const action=await sample(()=>f.storage.execute('media.imageSyncTargets',targetsInput('0')),2,runs);
  const pendingAction=await sample(()=>f.storage.execute('media.imageRefreshPending',{ownerId:scenario.owner,contactId}),1,5);

  const db=new DatabaseSync(databasePath(f.root),{readOnly:true});
  try{
   const tail='SELECT * FROM work WHERE display_no>? AND next_due<=? ORDER BY display_no LIMIT 64';
   const pendingTail='SELECT 1 FROM work LIMIT 1';
   const currentParameters=[...scopedParameters(currentWorkSql,scenario.owner,contactId),BigInt(0),BigInt(SCENARIO_NOW)];
   const legacyParameters=[...scopedParameters(legacyImageSyncWorkSql,scenario.owner,contactId),BigInt(0),BigInt(SCENARIO_NOW)];

   const currentRaw=await sample(()=>void db.prepare(`${currentWorkSql}${tail}`).all(...currentParameters),2,runs);
   const legacyRaw=await sample(()=>void db.prepare(`${legacyImageSyncWorkSql}${tail}`).all(...legacyParameters),2,runs);
   const currentPendingRaw=await sampleSync(()=>void db.prepare(`${currentWorkSql}${pendingTail}`).all(...scopedParameters(currentWorkSql,scenario.owner,contactId)),2,runs);

   const legacyPlan=planFor(db,legacyImageSyncWorkSql,tail,legacyParameters);
   const currentPlan=planFor(db,currentWorkSql,tail,currentParameters);
   const legacyPendingPlan=planFor(db,legacyImageSyncWorkSql,pendingTail,scopedParameters(legacyImageSyncWorkSql,scenario.owner,contactId));
   const currentPendingPlan=planFor(db,currentWorkSql,pendingTail,scopedParameters(currentWorkSql,scenario.owner,contactId));

   const legacyFirstPage=db.prepare(`${legacyImageSyncWorkSql}${tail}`).all(...legacyParameters).map(row=>String(row.display_no));
   const firstPage=largeResults['large/first-page'].map(row=>row.displayNo);
   const pendingActionValue=await f.storage.execute('media.imageRefreshPending',{ownerId:scenario.owner,contactId});
   const legacyPendingValue=Boolean(db.prepare(`${legacyImageSyncWorkSql}${pendingTail}`).get(...scopedParameters(legacyImageSyncWorkSql,scenario.owner,contactId)));
   const traversal=largeResults['large/traversal'];

   const report={
    label,
    node:process.version,
    runs,
    sqlSource,
    scenarioNow:SCENARIO_NOW,
    dataset:{...counts,contactMessages:scenario.contacts.large.displayNos.length},
    results:{
     firstPage:{count:firstPage.length,lastDisplayNo:firstPage.at(-1)},
     secondPage:largeResults['large/second-page'].length,
     traversal:{count:traversal.count,sha256:traversal.sha256},
     pending:pendingActionValue,
    },
    equivalence:{
     firstPageAgainstFrozenLegacy:JSON.stringify(firstPage)===JSON.stringify(legacyFirstPage),
     pendingAgainstFrozenLegacy:pendingActionValue===legacyPendingValue,
     goldenTraversalConsistent:traversal.count===largeResults['large/traversal'].count,
    },
    timings:{
     actionMs:action,
     pendingActionMs:pendingAction,
     currentRawMs:currentRaw,
     legacyRawMs:legacyRaw,
     currentPendingRawMs:currentPendingRaw,
    },
    plans:{
     legacy:{correlatedAttemptScans:correlatedAttemptScans(legacyPlan),rows:legacyPlan},
     current:{correlatedAttemptScans:correlatedAttemptScans(currentPlan),rows:currentPlan},
     legacyPending:{correlatedAttemptScans:correlatedAttemptScans(legacyPendingPlan),rows:legacyPendingPlan},
     currentPending:{correlatedAttemptScans:correlatedAttemptScans(currentPendingPlan),rows:currentPendingPlan},
    },
   };

   if(emitGolden){
    const golden={
     note:'ADR-170（不保存缩略图、取消原图分类）之后通过公开存储动作采集的结果黄金样例：已有可查看图片的消息不再入选；messageId 已归一为 <message>。由 backend-ts/scripts/perf/image-sync-query-baseline.mjs --emit-golden 生成。',
     scenarioNow:SCENARIO_NOW,
     source:{workSql:'linearized work query after ADR-170',action:'media.imageSyncTargets / media.imageRefreshPending'},
     edge:edgeResults,
     large:largeResults,
    };
    await writeFile(goldenPath,`${JSON.stringify(golden,null,1)}\n`);
    report.golden=goldenPath;
   }
   console.log(JSON.stringify(report,null,2));
  }finally{db.close();}
 }finally{await large.cleanup();}
}

await main();
