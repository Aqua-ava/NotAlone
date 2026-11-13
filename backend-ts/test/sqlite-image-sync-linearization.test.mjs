import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './media-support.mjs';
import {SCENARIO_NOW,buildEdgeScenario,buildLargeScenario,collectCases,databasePath} from './fixtures/sqlite-image-sync/scenarios.mjs';
import {imageSyncWorkSql} from '../src/media/sqlite/image-sync-actions.ts';

const here=dirname(fileURLToPath(import.meta.url));
const golden=JSON.parse(await readFile(join(here,'fixtures','sqlite-image-sync','golden.json'),'utf8'));

/** 规格目标：大联系人夹具上 `media.imageSyncTargets` P95 ≤ 100ms；留下最大耗时余量防止机器抖动。 */
const P95_TARGET_MS=100;
const MAX_TARGET_MS=250;
const SAMPLE_RUNS=12;
const WARMUP_RUNS=3;

const ascending=(values)=>values.every((value,index)=>index===0||value>values[index-1]);

/** 计划里相关子查询内部再次扫描尝试表，即说明 legacy cutoff 仍按行重算。 */
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
   .map(row=>`${node.detail} → ${row.detail}`);
 });
}

function percentiles(samples){
 const sorted=[...samples].sort((left,right)=>left-right);
 const at=quantile=>sorted[Math.min(sorted.length-1,Math.ceil(quantile*sorted.length)-1)];
 return {p50Ms:Number(at(0.5).toFixed(3)),p95Ms:Number(at(0.95).toFixed(3)),maxMs:Number(sorted.at(-1).toFixed(3))};
}

test('大联系人图片同步查询不随消息数×尝试数增长，P95 在规格目标内',{timeout:120000},async t=>{
 const f=await fixture(t),scenario=buildLargeScenario(f),contactId=scenario.contacts.large.contactId;
 const input={ownerId:scenario.owner,contactId,after:'0',now:SCENARIO_NOW};
 try{
  for(let index=0;index<WARMUP_RUNS;index++)await f.storage.execute('media.imageSyncTargets',input);
  const samples=[];
  for(let index=0;index<SAMPLE_RUNS;index++){
   const started=performance.now();
   const rows=await f.storage.execute('media.imageSyncTargets',input);
   samples.push(performance.now()-started);
   if(index===0)assert.ok(rows.length>0,'大联系人夹具应存在到期目标');
  }
  const measured=percentiles(samples);
  const dataset={imageMessages:1200,extractionAttempts:6936};
  t.diagnostic(JSON.stringify({action:'media.imageSyncTargets',dataset,samplesMs:samples.map(value=>Number(value.toFixed(3))),...measured}));
  assert.ok(measured.p95Ms<=P95_TARGET_MS,`P95 ${measured.p95Ms}ms 超过规格目标 ${P95_TARGET_MS}ms：${JSON.stringify(measured)}`);
  assert.ok(measured.maxMs<=MAX_TARGET_MS,`最大耗时 ${measured.maxMs}ms 超过 ${MAX_TARGET_MS}ms：${JSON.stringify(measured)}`);

  // 查询计划层面确认 legacy cutoff 只计算一次，而不是按当前版本尝试行重算。
  const placeholderPairs=(imageSyncWorkSql.match(/\?/g)??[]).length/2;
  assert.equal(Number.isInteger(placeholderPairs),true,'图片同步 SQL 的占位符必须成对出现');
  const parameters=[];
  for(let pair=0;pair<placeholderPairs;pair++)parameters.push(scenario.owner,contactId);
  const db=new DatabaseSync(databasePath(f.root),{readOnly:true});
  let plan;
  try{
   plan=db.prepare(`EXPLAIN QUERY PLAN ${imageSyncWorkSql}SELECT * FROM work WHERE display_no>? AND next_due<=? ORDER BY display_no LIMIT 64`)
    .all(...parameters,BigInt(0),BigInt(SCENARIO_NOW)).map(row=>({id:row.id,parent:row.parent,detail:row.detail}));
  }finally{db.close();}
  t.diagnostic(JSON.stringify({plan:plan.map(row=>row.detail)}));
  assert.deepEqual(correlatedAttemptScans(plan),[],'查询计划不应在相关子查询内扫描提取尝试表');
  assert.ok(plan.some(row=>/legacy/.test(row.detail)),'查询计划应包含一次性 legacy CTE');
 }finally{void f;}
});

test('大联系人结果集合、目标顺序与刷新语义与黄金样例完全一致',{timeout:120000},async t=>{
 const f=await fixture(t),scenario=buildLargeScenario(f);
 const actual=await collectCases(f.storage,scenario);
 assert.deepEqual(actual,golden.large,'大联系人公开动作结果必须与黄金样例相同');

 const known=new Set(scenario.contacts.large.displayNos);
 const firstPage=actual['large/first-page'].map(row=>row.displayNo);
 const secondPage=actual['large/second-page'].map(row=>row.displayNo);
 const traversal=actual['large/traversal'];
 assert.equal(firstPage.length,64);
 assert.ok(firstPage.every(displayNo=>known.has(displayNo)),'第一页只包含本联系人消息');
 assert.ok(ascending(firstPage),'第一页按 display_no 升序');
 assert.equal(secondPage.length,64);
 assert.ok(ascending(secondPage),'第二页按 display_no 升序');
 assert.ok(secondPage[0]>firstPage.at(-1),'第二页从第一页末尾继续');
 assert.ok(traversal.displayNos.every(displayNo=>known.has(displayNo)),'遍历只包含本联系人消息');
 assert.ok(ascending(traversal.displayNos),'遍历顺序稳定且无重复');
 assert.equal(traversal.count,traversal.displayNos.length,'遍历计数与显示号数量一致');

 // 明确被排除的变体不得出现在结果中：清除、原图、隔离、已有 main 分类、缺规范化捕获、运行中。
 for(const index of [17,19,29,31,37,43])assert.ok(!traversal.displayNos.includes(String(3000+index)),`被排除的变体 ${3000+index} 不应出现`);
 // 退避未到期的消息不在当前遍历中，但下一个时间窗口会返回。
 assert.ok(!traversal.displayNos.includes('3053'),'命中刷新退避的图片当前不应到期');
 assert.ok(actual['large/refresh-after'].some(row=>row.displayNo==='3053'),'下一个刷新窗口应返回 3053');
 assert.equal(actual['large/pending'],true,'大联系人仍有待处理图片');
});

test('边界场景空 cutoff、已有 cutoff、多个 legacy 尝试和退避阶梯与黄金样例一致',{timeout:60000},async t=>{
 const f=await fixture(t),scenario=buildEdgeScenario(f);
 const actual=await collectCases(f.storage,scenario);
 assert.deepEqual(actual,golden.edge,'边界场景公开动作结果必须与黄金样例相同');

 const displayNos=name=>actual[name].map(row=>row.displayNo);
 // 无尝试的普通图片按 display_no 翻页；已有可查看图片（含旧库的缩略图／未知分类副本）的消息不再入选。
 assert.deepEqual(displayNos('edge/page-first'),Array.from({length:64},(_,index)=>String(1001+index)));
 assert.deepEqual(displayNos('edge/page-second'),['1065','1066','1067','1068','1069','1070','1101','1111','1114','1115','1116']);
 // 下一个刷新窗口只多出退避到期的历史尝试图片。
 assert.deepEqual(displayNos('edge/page-second-refresh-window'),['1065','1066','1067','1068','1069','1070','1101','1111','1113','1114','1115','1116']);
 assert.equal(actual['edge/page-pending'],true);
 // 已有 legacy cutoff：cutoff 之前的当前版本尝试不计入 preparation，全部立即到期。
 assert.deepEqual(displayNos('edge/cutoff'),['3001','3002','3003','3004','3005','3006','3007','3008','3009','3010']);
 assert.equal(actual['edge/cutoff-pending'],true);
 // 空 cutoff：当前版本尝试次数决定联系人级退避，对应延迟到达前不返回。
 const ladders=[
  {count:1,offset:0,displayNos:['4000','4019']},
  {count:2,offset:5*60_000,displayNos:['4020','4021','4039']},
  {count:3,offset:30*60_000,displayNos:['4040','4041','4042','4059']},
  {count:4,offset:6*60*60_000,displayNos:['4060','4061','4062','4063','4079']},
  {count:5,offset:24*60*60_000,displayNos:['4080','4081','4082','4083','4084','4099']},
 ];
 for(const ladder of ladders){
  assert.deepEqual(displayNos(`edge/ladder-${ladder.count}-before`),[],`退避未到期时不应返回 ${ladder.count}`);
  assert.deepEqual(displayNos(`edge/ladder-${ladder.count}-due`),ladder.displayNos,`退避到期后应返回 ${ladder.count}`);
  assert.equal(actual[`edge/ladder-${ladder.count}-pending`],true);
 }
 // 单图重试阶梯：历史适配器命中 v5 键的尝试次数逐级延长退避。
 assert.deepEqual(displayNos('edge/retry-0'),[]);
 assert.deepEqual(displayNos('edge/retry-61000'),['5001']);
 assert.deepEqual(displayNos('edge/retry-301000'),['5001','5002']);
 assert.deepEqual(displayNos('edge/retry-1801000'),['5001','5002','5003']);
 assert.deepEqual(displayNos('edge/retry-21601000'),['5001','5002','5003','5004']);
 // 自动尝试用满 5 次后停止（5005、5006），本次运行内不再按时间排队。
 assert.deepEqual(displayNos('edge/retry-86401000'),['5001','5002','5003','5004']);
});
