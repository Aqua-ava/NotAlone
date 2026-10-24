import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildReplyComparisonReport,createReplyComparisonPlan} from '../src/reply-comparison.ts';

const manifestText=await readFile(new URL('../../.scratch/dsh-ts-migration/baseline/material-manifest.json',import.meta.url),'utf8');
const datasetText=await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8');
const manifest=JSON.parse(manifestText),dataset=JSON.parse(datasetText);
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const dimensions=['evidence_correctness','intent_preservation','no_unsupported_content','relationship_fit','chinese_usability'];
const inputFields=['current_intent','available_facts','unknowns','allowed_changes','current_message','recent_context'];
const inputFor=member=>Object.fromEntries(inputFields.filter(k=>k in member).map(k=>[k,member[k]]));
function markTerminal(row,status){row.terminal_status=status;row.output=null;row.reviews=[];row.timing.final_persisted_result_ms=null;row.timing.phases.network_model.ended_ms=100;row.timing.phases.validation={started_ms:100,ended_ms:100};row.timing.phases.persistence={started_ms:100,ended_ms:100};}
function fixture(){
 const configuration={provider:'synthetic-local',endpoint:'http://synthetic.invalid',request_model:'synthetic-model',temperature:0,top_p:1,reasoning:'off',max_output_tokens:256,stop:[],timeout_ms:20000,max_retries:0,seed:102,prompt_hash:'a'.repeat(64),tool_schema_hash:'b'.repeat(64),environment_hash:'c'.repeat(64)};
 const run={schema_version:'reply-migration-run-v1',protocol_version:'migration-comparison-v1',evidence_kind:'reporter_fixture',synthetic_only:true,
  manifest_sha256:hash(manifestText),dataset_sha256:hash(datasetText),config_hash:hash(configuration),configuration,
  bindings:{old:{commit:manifest.baseline_commit,lock_hash:'d'.repeat(64),profile_hash:'e'.repeat(64)},new:{commit:'2'.repeat(40),lock_hash:'f'.repeat(64),profile_hash:'0'.repeat(64),dsh_commit:'687f282e8625c6b8d11ff58211a90524be2e4317'}},
  price_snapshot:{currency:'CNY',sha256:'3'.repeat(64)},records:[]};
 let blind=0;
 for(const member of dataset.cases)for(let repeat=1;repeat<=3;repeat++)for(const arm of ['old','new']){
  const order=createReplyComparisonPlan(manifestText,datasetText).find(p=>p.case_id===member.case_id&&p.repeat===repeat).order;
  const pairIndex=dataset.cases.indexOf(member)*3+repeat-1,armOffset=arm===(order==='AB'?'old':'new')?0:100;
  const started=Date.UTC(2026,9,24)+pairIndex*200+armOffset;
  const row={case_id:member.case_id,arm,repeat,order,blind_id:`blind-${++blind}`,case_sha256:hash(member),input_sha256:hash(inputFor(member)),config_hash:run.config_hash,
   commit:run.bindings[arm].commit,generated_by:`generator-${arm}`,terminal_status:'succeeded',logical_calls:1,physical_calls:1,
   actual_model:'synthetic-response-model',model_fingerprint:'synthetic-model-version',started_at:new Date(started).toISOString(),ended_at:new Date(started+100).toISOString(),latency_ms:100,
   usage:{input_tokens:10,output_tokens:2,reasoning_tokens:0,cache_hit_tokens:0,cache_miss_tokens:10},cost:{amount:0.01,currency:'CNY',price_snapshot_sha256:run.price_snapshot.sha256},
   request_sha256:'4'.repeat(64),deterministic_checks:{status:'passed',source_binding_sha256:hash(inputFor(member))},
   output:{candidates:[{candidate_id:'candidate-1',text:'合成回复',basis:'冻结合成输入',citation_ids:[]}]},reviews:[]};
  row.timing={schema_version:'reply-latency-v1',clock:'monotonic',observed_ms:100,first_event_ms:20,first_token_ms:30,final_persisted_result_ms:100,phases:{queue:{started_ms:0,ended_ms:10},retrieval:{started_ms:10,ended_ms:20},network_model:{started_ms:20,ended_ms:80},validation:{started_ms:80,ended_ms:90},persistence:{started_ms:90,ended_ms:100}}};
  row.deterministic_checks.output_sha256=hash(row.output);
  const subject={blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output};
  row.reviews=['independent-1','independent-2'].map((reviewer,i)=>({review_id:`${row.blind_id}-review-${i}`,blind_id:row.blind_id,subject_sha256:hash(subject),reviewer_id:reviewer,reviewer_type:'agent',reviewer_model:'synthetic-review-model',reviewer_version:'synthetic-review-model-v1',independent:true,blinded:true,
   candidates:[{candidate_id:'candidate-1',scores:Object.fromEntries(dimensions.map(k=>[k,2])),severe_errors:{false_fact:0,wrong_person:0,unsupported_commitment:0},basis:'报告器合成标注，不是真实模型质量证据。'}]}));
  run.records.push(row);
 }
 return run;
}
test('完整16例×双臂×3次相等证据可离线审计，保留96分母且不冒充真实模型评测',()=>{
 const run=fixture(),before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');assert.equal(report.semantic_quality.status,'passed');
 assert.equal(report.population.planned,96);assert.equal(report.arms.old.denominator,48);assert.equal(report.arms.new.denominator,48);
 assert.deepEqual(report.semantic_quality.pass_rate_difference.ci95,[0,0]);
 assert.equal(report.bootstrap.unit,'case');assert.equal(report.bootstrap.clusters,16);assert.equal(report.bootstrap.resamples,10000);assert.equal(report.bootstrap.seed,102);
 assert.equal(report.real_model_quality_verified,false);assert.equal(report.evidence_kind,'reporter_fixture');assert.deepEqual(run,before);
});
test('真实时间与seed102配对顺序矛盾或请求重叠时完整审计失败',()=>{
 const run=fixture();run.records[1].started_at=run.records[0].started_at;
 run.records[1].ended_at=run.records[0].ended_at;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.semantic_quality.status,'passed');assert.equal(report.overall.status,'failed');
 assert.ok(report.failures.some(f=>f.reason==='execution_order_or_concurrency'));
});
test('来源绑定即使只剩一个审阅者仍不能接受过期输出摘要',()=>{
 const run=fixture();run.records[0].reviews.pop();run.records[0].reviews[0].subject_sha256='9'.repeat(64);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/review_binding/);
});
test('缺臂与缺重复保留计划全集、失败及未知不缩分母',async t=>{
 await t.test('缺整臂',()=>{const run=fixture();run.records=run.records.filter(r=>r.arm==='old');const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.population.planned,96);assert.equal(report.population.missing,48);assert.equal(report.arms.new.denominator,48);assert.equal(report.arms.new.missing,48);assert.equal(report.arms.new.pass_rate,0);assert.equal(report.arms.new.usability_mean,null);assert.equal(report.metrics.cost.totals.new.total,null);assert.notEqual(report.overall.status,'passed');});
 await t.test('缺一次重复',()=>{const run=fixture();run.records.splice(1,1);const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.population.missing,1);assert.equal(report.arms.new.denominator,48);assert.equal(report.arms.new.passed,47);assert.equal(report.arms.new.pass_rate,47/48);assert.equal(report.semantic_quality.pass_rate_difference,null);assert.notEqual(report.overall.status,'passed');});
 for(const status of ['failed','cancelled','timeout','unknown'])await t.test(status,()=>{const run=fixture(),row=run.records.find(r=>r.arm==='new');markTerminal(row,status);const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.arms.new[status],1);assert.equal(report.arms.new.denominator,48);assert.equal(report.arms.new.pass_rate,47/48);assert.equal(report.arms.new.usability_mean,status==='unknown'?null:94/48);assert.notEqual(report.overall.status,'passed');});
});
test('未知调用、费用、用量、模型、版本及必要hash与语义结论分开',async t=>{
 for(const field of ['physical_calls','usage','cost','latency_ms','actual_model','model_fingerprint','request_sha256'])await t.test(field,()=>{const run=fixture();run.records[0][field]=null;const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.semantic_quality.status,'passed');assert.equal(report.overall.status,['actual_model','model_fingerprint'].includes(field)?'passed':'undetermined');assert.ok(report.unknowns.length);if(['physical_calls','usage','cost','latency_ms'].includes(field)){const metric=report.metrics[field==='usage'?'total_tokens':field==='latency_ms'?'latency_p50':field];assert.equal(metric.totals.old.denominator,48);assert.equal(metric.totals.old.total,null);assert.equal(metric.totals.old.known,47);}});
 const run=fixture();run.bindings.new.lock_hash=null;const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(i=>i.reason==='new_lock_hash_unknown'));
});
test('冻结摘要、case全集、配置和输出审阅绑定损坏时拒绝',()=>{
 assert.throws(()=>buildReplyComparisonReport(manifestText+' ',datasetText,fixture()),/manifest_sha256/);
 const changed=JSON.parse(datasetText);changed.cases[1]=changed.cases[0];assert.throws(()=>buildReplyComparisonReport(manifestText,JSON.stringify(changed),fixture()),/dataset_sha256/);
 const changes=[r=>r.records.push(structuredClone(r.records[0])),r=>r.records[0].case_id='未冻结case',r=>r.records[0].repeat=4,r=>r.records[0].case_sha256='5'.repeat(64),r=>r.records[0].input_sha256='6'.repeat(64),r=>r.records[0].config_hash='7'.repeat(64),r=>r.records[0].commit='8'.repeat(40),r=>r.configuration.temperature=1,r=>r.records[0].output.candidates[0].text='改过的合成输出',r=>r.records[0].order=r.records[0].order==='AB'?'BA':'AB'];
 for(const change of changes){const run=fixture();change(run);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/reply_comparison_invalid/);}
});
test('缺审阅与分歧未裁决不能通过，第三位独立裁决须绑定双方审阅',()=>{
 const missing=fixture();missing.records[0].reviews=[];let report=buildReplyComparisonReport(manifestText,datasetText,missing);assert.equal(report.semantic_quality.status,'undetermined');assert.equal(report.arms.old.reviewed,47);
 const run=fixture(),row=run.records[0];row.reviews[1].candidates[0].scores.relationship_fit=1;report=buildReplyComparisonReport(manifestText,datasetText,run);assert.ok(report.unknowns.some(i=>i.reason==='review_disagreement_unresolved'));assert.notEqual(report.overall.status,'passed');
 row.adjudication={...structuredClone(row.reviews[0]),review_id:'third-decision',reviewer_id:'independent-3',resolves_review_ids:row.reviews.map(r=>r.review_id)};report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.semantic_quality.status,'passed');assert.equal(report.records[0].reviews.length,3);
 row.adjudication.reviewer_id=row.reviews[0].reviewer_id;assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/third_reviewer/);
 const same=fixture();same.records[0].reviews[1].reviewer_id=same.records[0].reviews[0].reviewer_id;assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,same),/reviewer_independence/);
 const leaked=fixture();leaked.records[0].reviews[0].blinded=false;assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,leaked),/blind_review/);
});
test('五维评分覆盖全部候选，事实意图任一项1不算满足且中文关系各自检查',()=>{
 for(const dimension of dimensions){const run=fixture();for(const row of run.records.filter(r=>r.arm==='new'))for(const review of row.reviews)review.candidates[0].scores[dimension]=1;const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.arms.new.passed,0,dimension);assert.equal(report.semantic_quality.status,'failed',dimension);}
 const run=fixture(),row=run.records[0];row.output.candidates.push({...row.output.candidates[0],candidate_id:'candidate-2'});
 const subject=hash({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output});row.reviews.forEach(r=>r.subject_sha256=subject);row.deterministic_checks.output_sha256=hash(row.output);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/all_candidates/);
 for(const review of row.reviews){review.candidates.push({...structuredClone(review.candidates[0]),candidate_id:'candidate-2'});review.candidates[1].scores.evidence_correctness=1;}
 const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.arms.old.passed,47);assert.equal(report.arms.old.denominator,48);
});
test('bootstrap单位为16个case，三次完全相关重复的解析95%区间为±0.5而非48次独立',()=>{
 const run=fixture();for(const row of run.records){const index=dataset.cases.findIndex(c=>c.case_id===row.case_id),weak=index<8?row.arm==='old':row.arm==='new';if(weak)for(const review of row.reviews)review.candidates[0].scores.relationship_fit=1;}
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.semantic_quality.pass_rate_difference.estimate,0);assert.deepEqual(report.semantic_quality.pass_rate_difference.ci95,[-0.5,0.5]);assert.equal(report.semantic_quality.status,'undetermined');
 assert.deepEqual(buildReplyComparisonReport(manifestText,datasetText,run).semantic_quality.pass_rate_difference,report.semantic_quality.pass_rate_difference);
});
test('明显语义退化、严重错人新增、物理调用和费用退化均真实报告失败',()=>{
 const run=fixture();for(const row of run.records.filter(r=>r.arm==='new'))for(const review of row.reviews)review.candidates[0].scores.relationship_fit=1;
 let report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.overall.status,'failed');assert.deepEqual(report.semantic_quality.pass_rate_difference.ci95,[-1,-1]);assert.equal(report.semantic_quality.usability_difference.estimate,-0.5);
 const severe=fixture();for(const review of severe.records[1].reviews)review.candidates[0].severe_errors.wrong_person=1;report=buildReplyComparisonReport(manifestText,datasetText,severe);assert.equal(report.semantic_quality.status,'failed');
 const expensive=fixture();for(const row of expensive.records.filter(r=>r.arm==='new')){row.physical_calls=2;row.cost.amount=0.02;}report=buildReplyComparisonReport(manifestText,datasetText,expensive);assert.equal(report.metrics.physical_calls.status,'failed');assert.equal(report.metrics.cost.status,'failed');assert.equal(report.semantic_quality.status,'passed');assert.equal(report.overall.status,'failed');
});
test('未裁决审阅仍留在审计轨迹中，运行来源标签不能认证真实模型质量',()=>{
 const run=fixture();run.records[0].reviews[1].candidates[0].scores.relationship_fit=1;
 let report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.records[0].reviews.length,2);
 assert.equal(report.records[0].input_sha256,run.records[0].input_sha256);assert.equal(report.records[0].actual_model,run.records[0].actual_model);
 run.records[0].reviews[1].candidates[0].scores.relationship_fit=2;run.evidence_kind='model_run';
 report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
});
test('零基线要求新值同为零，费用未知不可以0补齐；模型版本漂移必须另组',()=>{
 const run=fixture();for(const row of run.records)row.cost.amount=0;
 let report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.metrics.cost.status,'passed');assert.equal(report.metrics.cost.interval,null);
 run.records[1].cost.amount=0.01;report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.metrics.cost.status,'failed');
 run.records[1].cost=null;report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.metrics.cost.status,'undetermined');assert.equal(report.metrics.cost.totals.new.total,null);assert.equal(report.metrics.cost.totals.new.known_total,0);assert.equal(report.metrics.cost.totals.new.known,47);
 const drift=fixture();drift.records[1].model_fingerprint='another-synthetic-version';report=buildReplyComparisonReport(manifestText,datasetText,drift);assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(i=>i.reason.includes('drift_requires_split')));
});
test('本地CLI在禁止网络的子进程生成报告，缺失退出2，坏摘要退出1，原始输入不变',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'notalone-reply-comparison-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const guard=join(directory,'deny-network.mjs');await writeFile(guard,"import http from 'node:http';import https from 'node:https';import net from 'node:net';import dns from 'node:dns';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw Error('离线报告器禁止网络');};globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;dns.lookup=deny;syncBuiltinESMExports();\n");
 const paths={manifest:join(directory,'manifest.json'),dataset:join(directory,'dataset.json'),run:join(directory,'run.json')};
 await writeFile(paths.manifest,manifestText);await writeFile(paths.dataset,datasetText);const original=JSON.stringify(fixture());await writeFile(paths.run,original);
 const invoke=output=>spawnSync(process.execPath,['--import',guard,fileURLToPath(new URL('../src/reply-comparison.ts',import.meta.url)),'--manifest',paths.manifest,'--dataset',paths.dataset,'--run',paths.run,'--output',output],{encoding:'utf8',timeout:10000});
 const output=join(directory,'report.json'),ok=invoke(output);assert.equal(ok.status,0,ok.stderr);const report=JSON.parse(await readFile(output,'utf8'));assert.equal(report.overall.status,'passed');assert.equal(report.real_model_quality_verified,false);assert.equal(report.population.planned,96);assert.equal(await readFile(paths.run,'utf8'),original);
 const incomplete=fixture();incomplete.records=[];await writeFile(paths.run,JSON.stringify(incomplete));const pending=invoke(join(directory,'incomplete.json'));assert.equal(pending.status,2,pending.stderr);assert.equal(JSON.parse(await readFile(join(directory,'incomplete.json'),'utf8')).population.missing,96);
 const bad=fixture();bad.records[0].input_sha256='bad';await writeFile(paths.run,JSON.stringify(bad));assert.equal(invoke(join(directory,'bad.json')).status,1);
 await writeFile(paths.run,original);assert.equal(invoke(paths.run).status,1);assert.equal(await readFile(paths.run,'utf8'),original);
});
test('零延迟基准标不可比较，均值未明显下降但区间不足时仍未定',()=>{
 const zero=fixture();for(const row of zero.records){row.latency_ms=0;row.ended_at=row.started_at;row.timing.observed_ms=0;row.timing.first_event_ms=0;row.timing.first_token_ms=0;row.timing.final_persisted_result_ms=0;for(const phase of Object.values(row.timing.phases)){phase.started_ms=0;phase.ended_ms=0;}}
 let report=buildReplyComparisonReport(manifestText,datasetText,zero);assert.equal(report.metrics.latency_p50.status,'undetermined');assert.equal(report.metrics.latency_p95.status,'undetermined');assert.equal(report.overall.status,'undetermined');
 const uncertain=fixture();for(const review of uncertain.records[1].reviews)review.candidates[0].scores.relationship_fit=1;
 report=buildReplyComparisonReport(manifestText,datasetText,uncertain);assert.ok(report.semantic_quality.pass_rate_difference.estimate>-0.03);assert.ok(report.semantic_quality.pass_rate_difference.ci95[0]<-0.03);assert.equal(report.semantic_quality.status,'undetermined');
});
test('未知字符串不能伪装为已知币种或响应模型版本',()=>{
 const currency=fixture();currency.price_snapshot.currency='unknown';currency.records.forEach(r=>r.cost.currency='unknown');
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,currency),/price_snapshot/);
 const version=fixture();version.records[0].model_fingerprint=' unknown ';const report=buildReplyComparisonReport(manifestText,datasetText,version);assert.equal(report.overall.status,'passed');assert.equal(report.model_equivalence.conclusion,'same_request_configuration_only');assert.ok(report.unknowns.some(i=>i.reason==='model_fingerprint_unknown'));
});
test('审阅Agent须记录实际模型与版本，身份字符串不能代替模型观测',()=>{
 const run=fixture();run.records[0].reviews[0].reviewer_model=null;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.semantic_quality.status,'undetermined');assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(i=>i.reason==='reviewer_version_unknown'));
});

test('引用必须属于冻结case且确定性来源回执绑定实际输出',()=>{
 const invalidCitation=fixture(),row=invalidCitation.records[0];row.output.candidates[0].citation_ids=['outside-frozen-case'];
 const subject=hash({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output});row.reviews.forEach(r=>r.subject_sha256=subject);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,invalidCitation),/citation_allowlist/);
 const stale=fixture(),changed=stale.records[0];changed.output.candidates[0].text='另一个合成候选';
 const changedSubject=hash({blind_id:changed.blind_id,case_sha256:changed.case_sha256,input_sha256:changed.input_sha256,output:changed.output});changed.reviews.forEach(r=>r.subject_sha256=changedSubject);
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,stale),/deterministic_output_binding/);
});

test('旧case修复不能抵消另一配对case或类别的严重错误新增',()=>{
 const run=fixture(),old=run.records.find(r=>r.arm==='old'),fresh=run.records.find(r=>r.arm==='new'&&r.case_id!==old.case_id);
 for(const row of [old,fresh])for(const review of row.reviews){review.candidates[0].severe_errors.wrong_person=1;review.candidates[0].scores.evidence_correctness=0;}
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.semantic_quality.severe_errors.wrong_person.old,1);assert.equal(report.semantic_quality.severe_errors.wrong_person.new,1);
 assert.equal(report.semantic_quality.status,'failed');assert.equal(report.semantic_quality.severe_errors.wrong_person.newly_introduced,1);
 assert.deepEqual(report.semantic_quality.severe_errors.wrong_person.introduced_at,[`${fresh.case_id}:${fresh.repeat}`]);
});

test('单项有限而累计费用溢出时拒绝，不能序列化null后声称通过',()=>{
 const run=fixture();for(const row of run.records)row.cost.amount=Number.MAX_VALUE;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/statistical_overflow/);
});

test('普通旧臂失败保留固定分母并可比较，新臂失败率不得增加',()=>{
 const run=fixture(),old=run.records.find(r=>r.arm==='old');markTerminal(old,'failed');
 let report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.arms.old.denominator,48);assert.equal(report.arms.old.failed,1);assert.equal(report.arms.old.pass_rate,47/48);
 assert.equal(report.arms.old.usability_mean,94/48);assert.ok(report.arms.old.known_failure_ids.includes(`${old.case_id}:old:${old.repeat}`));
 assert.ok(report.semantic_quality.pass_rate_difference);assert.ok(report.semantic_quality.usability_difference);assert.equal(report.semantic_quality.status,'passed');
 assert.equal(report.failure_rate.status,'passed');assert.equal(report.failure_rate.old,1/48);assert.equal(report.failure_rate.new,0);
 assert.equal(report.metrics.cost.totals.old.known,48);assert.equal(report.metrics.latency_p50.samples.paired_successes,47);
 assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(item=>item.reason==='latency_phase_persistence_unknown'));
 const worse=fixture(),fresh=worse.records.find(r=>r.arm==='new');markTerminal(fresh,'failed');
 report=buildReplyComparisonReport(manifestText,datasetText,worse);assert.equal(report.failure_rate.status,'failed');assert.equal(report.overall.status,'failed');
});

test('严重错误非零即使维度全满分也不能把该组记为通过',()=>{
 const run=fixture();for(const row of run.records.filter(r=>r.repeat===1&&r.case_id===dataset.cases[0].case_id))for(const review of row.reviews)review.candidates[0].severe_errors.false_fact=1;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.arms.old.passed,47);assert.equal(report.arms.new.passed,47);
 assert.ok(report.arms.old.known_failure_ids.includes(`${dataset.cases[0].case_id}:old:1`));
 assert.equal(report.records.find(r=>r.case_id===dataset.cases[0].case_id&&r.arm==='new'&&r.repeat===1).pass,0);
});

test('延迟必须绑定最终持久结果、首事件首token和完整阶段，伪造更快数值不能通过',()=>{
 const forged=fixture();for(const row of forged.records.filter(r=>r.arm==='new'))row.latency_ms=1;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,forged),/latency/);
 const incomplete=fixture();delete incomplete.records[0].timing;
 const report=buildReplyComparisonReport(manifestText,datasetText,incomplete);assert.equal(report.overall.status,'undetermined');
 assert.equal(report.metrics.latency_p50.status,'undetermined');assert.ok(report.unknowns.some(i=>i.reason==='latency_evidence_unknown'));
});

test('响应版本不可辨认时保留unknown并仅给同请求配置结论',()=>{
 const run=fixture();for(const row of run.records)row.model_fingerprint=null;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');assert.equal(report.model_equivalence.conclusion,'same_request_configuration_only');
 assert.ok(report.unknowns.some(i=>i.reason==='model_fingerprint_unknown'&&i.blocking===false));
 assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
});

test('首事件token、阶段和墙钟持久时间相矛盾时均拒绝，诊断未知时资格未定',()=>{
 const mutations=[r=>r.timing.first_event_ms=40,r=>r.timing.first_token_ms=95,r=>r.timing.final_persisted_result_ms=90,r=>r.timing.phases.persistence.started_ms=101,r=>r.timing.phases.network_model.ended_ms=101,r=>r.ended_at=new Date(Date.parse(r.started_at)+1000).toISOString()];
 for(const mutate of mutations){const run=fixture();mutate(run.records[0]);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency/);}
 const unknown=fixture();unknown.records[0].timing.first_token_ms=null;
 let report=buildReplyComparisonReport(manifestText,datasetText,unknown);assert.equal(report.overall.status,'undetermined');assert.equal(report.metrics.latency_p50.status,'passed');assert.ok(report.unknowns.some(item=>item.reason==='latency_first_token_ms_unknown'));
 const timeout=fixture(),row=timeout.records.find(r=>r.arm==='old');markTerminal(row,'timeout');
 report=buildReplyComparisonReport(manifestText,datasetText,timeout);const observed=report.latency_observations.find(r=>r.record_id===`${row.case_id}:old:${row.repeat}`);
 assert.equal(observed.kind,'timeout_lower_bound');assert.equal(observed.elapsed_ms,100);assert.equal(report.metrics.latency_p50.samples.paired_successes,47);
});
test('严重错误不得在同case其他重复或其他类别之间抵消',()=>{
 for(const differentCategory of [true,false]){const run=fixture(),old=run.records.find(r=>r.arm==='old'),fresh=run.records.find(r=>r.arm==='new'&&r.case_id===old.case_id&&r.repeat===(differentCategory?old.repeat:2));
  for(const review of old.reviews)review.candidates[0].severe_errors.false_fact=1;
  for(const review of fresh.reviews)review.candidates[0].severe_errors[differentCategory?'unsupported_commitment':'false_fact']=1;
  const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.semantic_quality.status,'failed');
  assert.equal(report.semantic_quality.severe_errors[differentCategory?'unsupported_commitment':'false_fact'].newly_introduced,1);
 }
});

test('一臂失败时仍保留另一臂对应的成功延迟，不能删掉慢成功样本',()=>{
 const run=fixture();for(const member of dataset.cases.slice(0,3)){
  markTerminal(run.records.find(r=>r.case_id===member.case_id&&r.arm==='old'&&r.repeat===1),'failed');
  const fresh=run.records.find(r=>r.case_id===member.case_id&&r.arm==='new'&&r.repeat===1);fresh.latency_ms=1000;fresh.timing.observed_ms=1000;fresh.timing.final_persisted_result_ms=1000;fresh.timing.phases.network_model.ended_ms=980;fresh.timing.phases.validation={started_ms:980,ended_ms:990};fresh.timing.phases.persistence={started_ms:990,ended_ms:1000};
 }
 let cursor=Date.UTC(2026,9,24);for(const pair of createReplyComparisonPlan(manifestText,datasetText))for(const arm of pair.order==='AB'?['old','new']:['new','old']){const row=run.records.find(r=>r.case_id===pair.case_id&&r.repeat===pair.repeat&&r.arm===arm);row.started_at=new Date(cursor).toISOString();cursor+=row.latency_ms;row.ended_at=new Date(cursor).toISOString();}
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.arms.old.reviewed,45);assert.equal(report.arms.old.scored,48);
 assert.equal(report.metrics.latency_p50.samples.old_successes,45);assert.equal(report.metrics.latency_p50.samples.new_successes,48);
 assert.equal(report.metrics.latency_p50.samples.basis,'all_successes_by_case');
 assert.ok(Math.abs(report.metrics.latency_p95.observed.new-685)<1e-8);assert.notEqual(report.metrics.latency_p95.status,'passed');
});

test('真实工具轮可交错或嵌套，阶段重叠用并集保留而不强制互斥',()=>{
 const run=fixture(),row=run.records[0];row.timing.phases.retrieval=[{started_ms:10,ended_ms:20},{started_ms:40,ended_ms:50}];row.timing.phases.network_model=[{started_ms:20,ended_ms:40},{started_ms:50,ended_ms:80}];
 let report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.overall.status,'passed');
 row.timing.phases.network_model[1].started_ms=49;report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');assert.equal(report.latency_observations[0].phase_coverage.observed_phase_union_ms,100);
});

function setSevereCounts(row,counts){
 const original=row.output.candidates[0];row.output.candidates=counts.map((_,i)=>({...structuredClone(original),candidate_id:`candidate-${i+1}`}));
 row.deterministic_checks.output_sha256=hash(row.output);
 const subject=hash({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output});
 for(const review of row.reviews){const originalReview=review.candidates[0];review.candidates=counts.map((count,i)=>({...structuredClone(originalReview),candidate_id:`candidate-${i+1}`,severe_errors:{false_fact:0,wrong_person:count,unsupported_commitment:0}}));review.subject_sha256=subject;}
}
test('合法候选计数相加越过安全整数时拒绝，不能舍入吞掉严重错误新增',()=>{
 const max=Number.MAX_SAFE_INTEGER;
 for(const [oldCounts,newCounts] of [[[max,1,0],[max,1,1]],[[max,max,1],[max,max,2]]]){
  const run=fixture(),old=run.records.find(r=>r.arm==='old'),fresh=run.records.find(r=>r.case_id===old.case_id&&r.repeat===old.repeat&&r.arm==='new');
  setSevereCounts(old,oldCounts);setSevereCounts(fresh,newCounts);
  assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/integer_aggregate_overflow/);
 }
});

test('各record计数合法但跨record合成臂总量越界时拒绝',()=>{
 const run=fixture(),rows=run.records.filter(r=>r.arm==='old').slice(0,2);
 for(const [i,old] of rows.entries()){const fresh=run.records.find(r=>r.case_id===old.case_id&&r.repeat===old.repeat&&r.arm==='new');setSevereCounts(old,[i===0?Number.MAX_SAFE_INTEGER:1]);setSevereCounts(fresh,[i===0?Number.MAX_SAFE_INTEGER:1]);}
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/integer_aggregate_overflow/);
});

test('有未知审阅时已知配对新增合计仍不得越过安全整数',()=>{
 const run=fixture(),fresh=run.records.filter(r=>r.arm==='new');setSevereCounts(fresh[0],[Number.MAX_SAFE_INTEGER]);setSevereCounts(fresh[1],[1]);
 run.records.at(-1).reviews=[];
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/integer_aggregate_overflow/);
});

test('安全整数边界保留精确一条新增，合理小数费用仍按浮点规则比较',()=>{
 const run=fixture(),old=run.records.find(r=>r.arm==='old'),fresh=run.records.find(r=>r.case_id===old.case_id&&r.repeat===old.repeat&&r.arm==='new');
 setSevereCounts(old,[Number.MAX_SAFE_INTEGER-1,0,0]);setSevereCounts(fresh,[Number.MAX_SAFE_INTEGER-1,1,0]);
 for(const row of run.records)row.cost.amount=0.0125;
 let report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.semantic_quality.severe_errors.wrong_person.old,Number.MAX_SAFE_INTEGER-1);assert.equal(report.semantic_quality.severe_errors.wrong_person.new,Number.MAX_SAFE_INTEGER);
 assert.equal(report.semantic_quality.severe_errors.wrong_person.newly_introduced,1);assert.equal(report.semantic_quality.status,'failed');assert.equal(report.metrics.cost.status,'passed');
 setSevereCounts(old,[Number.MAX_SAFE_INTEGER-1,1,0]);report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.semantic_quality.severe_errors.wrong_person.old,Number.MAX_SAFE_INTEGER);assert.equal(report.semantic_quality.severe_errors.wrong_person.newly_introduced,0);assert.equal(report.overall.status,'passed');
});

test('首token未知仍保留已验证的100ms最终持久延迟，诊断未知继续阻断整体资格',()=>{
 const run=fixture(),row=run.records[0];row.timing.first_token_ms=null;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 for(const name of ['latency_p50','latency_p95']){
  const metric=report.metrics[name];assert.equal(metric.totals.old.known,48);assert.equal(metric.totals.old.denominator,48);assert.equal(metric.totals.old.total,4800);assert.equal(metric.interval.estimate,1);assert.deepEqual(metric.interval.ci95,[1,1]);assert.equal(metric.status,'passed');
 }
 assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(item=>item.reason==='latency_first_token_ms_unknown'&&item.blocking===true));assert.ok(!report.unknowns.some(item=>item.reason==='latency_ms_unknown'));
 assert.equal(row.timing.first_token_ms,null);assert.equal(row.timing.final_persisted_result_ms,100);assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
});
test('首事件或两项诊断未知仍分别报告，完整最终结果不派生假未知',()=>{
 for(const fields of [['first_event_ms'],['first_event_ms','first_token_ms']]){
  const run=fixture(),row=run.records[0];for(const field of fields)row.timing[field]=null;
  const report=buildReplyComparisonReport(manifestText,datasetText,run);
  assert.equal(report.metrics.latency_p50.totals.old.known,48);assert.equal(report.metrics.latency_p95.totals.old.total,4800);assert.equal(report.metrics.latency_p50.status,'passed');assert.equal(report.overall.status,'undetermined');
  for(const field of fields)assert.ok(report.unknowns.some(item=>item.reason==='latency_'+field+'_unknown'&&item.blocking===true));
  assert.ok(!report.unknowns.some(item=>item.reason==='latency_ms_unknown'));assert.equal(report.metrics.latency_p50.limit,1.15);assert.equal(report.metrics.latency_p95.limit,1.25);
 }
});
test('最终持久点缺证据时100ms声明仍不能进入最终结果统计，各未知分别保留',()=>{
 for(const missingDiagnostics of [false,true]){
  const run=fixture(),row=run.records[0];row.timing.final_persisted_result_ms=null;
  if(missingDiagnostics){row.timing.first_event_ms=null;row.timing.first_token_ms=null;}
  const report=buildReplyComparisonReport(manifestText,datasetText,run);
  for(const name of ['latency_p50','latency_p95']){assert.equal(report.metrics[name].totals.old.known,47);assert.equal(report.metrics[name].totals.old.denominator,48);assert.equal(report.metrics[name].totals.old.total,null);assert.equal(report.metrics[name].status,'undetermined');}
  assert.ok(report.unknowns.some(item=>item.reason==='latency_final_persisted_result_unknown'));assert.ok(report.unknowns.some(item=>item.reason==='latency_ms_unknown'));
  if(missingDiagnostics)for(const field of ['first_event_ms','first_token_ms'])assert.ok(report.unknowns.some(item=>item.reason==='latency_'+field+'_unknown'));
  assert.equal(row.latency_ms,100);assert.equal(report.overall.status,'undetermined');
 }
});
test('墙钟、阶段或延迟本身缺证据不冒充已知最终结果',()=>{
 for(const [mutate,reason]of [[row=>row.started_at=null,'run_times_unknown'],[row=>row.timing=null,'latency_evidence_unknown'],[row=>row.latency_ms=null,'latency_ms_unknown']]){
  const run=fixture();mutate(run.records[0]);const report=buildReplyComparisonReport(manifestText,datasetText,run);
  assert.equal(report.metrics.latency_p50.totals.old.known,47);assert.equal(report.metrics.latency_p95.status,'undetermined');assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(item=>item.reason===reason));
 }
 const malformed=fixture();delete malformed.records[0].timing.phases.retrieval;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,malformed),/latency_phases/);
});
test('独立诊断未知不能跳过已知的首token、阶段、持久点或墙钟矛盾',()=>{
 for(const mutate of [row=>row.timing.first_token_ms=95,row=>row.timing.final_persisted_result_ms=90,row=>row.timing.phases.persistence.started_ms=101,row=>row.ended_at=new Date(Date.parse(row.started_at)+1000).toISOString()]){
  const run=fixture(),row=run.records[0];row.timing.first_event_ms=null;mutate(row);
  assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency/);
 }
});

// 仅构造报告器的合成观测合同，不冒充新增SDK请求或历史采集。
function timingV2(row,{stream=true}={}){
 const member=dataset.cases.find(member=>member.case_id===row.case_id);
 const body={model:'synthetic-model',stream,messages:[{role:'user',content:canonical(inputFor(member))}]};
 row.request_sha256=hash(body);row.request_observation={hash_kind:'canonical_json_sha256',sha256:row.request_sha256,body};
 row.timing.schema_version='reply-latency-v2';
 row.timing.diagnostics={request_sha256:row.request_sha256,
  first_event_ms:{observability:'observable',definition:stream?'first_incremental_event':'completed_sdk_response',reason:null},
  first_token_ms:{observability:stream?'observable':'unobservable',definition:'first_incremental_token',reason:stream?null:'非流式请求不提供增量token信号。'}};
 if(!stream)row.timing.first_token_ms=null;
 for(const [name,span]of Object.entries(row.timing.phases))span.markers={start:name+':start',end:name+':end'};
 return row;
}
test('资格合同：已绑定非流式不可观测诊断保留48分母和原因，不额外阻断最终指标及overall',()=>{
 const run=fixture();for(const row of run.records.filter(row=>row.arm==='old'))timingV2(row,{stream:false});
 const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');assert.equal(report.metrics.latency_p50.status,'passed');assert.equal(report.metrics.latency_p95.status,'passed');
 assert.equal(report.latency_diagnostics.first_token_ms.old.denominator,48);assert.equal(report.latency_diagnostics.first_token_ms.old.unobservable,48);assert.equal(report.latency_diagnostics.first_token_ms.old.missing,0);
 assert.equal(report.unknowns.filter(item=>item.reason==='latency_first_token_ms_unknown').length,48);
 assert.ok(report.unknowns.filter(item=>item.reason==='latency_first_token_ms_unknown').every(item=>item.blocking===false));
 assert.ok(report.latency_observations.filter(item=>item.record_id.includes(':old:')).every(item=>item.diagnostics.first_token_ms.reason==='非流式请求不提供增量token信号。'));
 assert.equal(report.arms.old.denominator,48);assert.equal(report.arms.new.denominator,48);assert.deepEqual(run,before);
 assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
});
test('资格合同：有marker的真实返回开销独立记录，不要求persistence结束等于最终可用结果',()=>{
 const run=fixture();for(const row of run.records){
  timingV2(row);row.timing.phases.persistence.ended_ms=95;
  row.timing.overhead=[{started_ms:95,ended_ms:100,kind:'framework_overhead',reason:'已保存结果的框架返回处理。',markers:{start:'persistence:end',end:'service:return'}}];
 }
 const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');assert.equal(report.metrics.latency_p50.status,'passed');assert.equal(report.metrics.latency_p95.limit,1.25);
 for(const observation of report.latency_observations){
  assert.equal(observation.phase_coverage.observed_phase_union_ms,95);assert.equal(observation.phase_coverage.framework_overhead_ms,5);
  assert.deepEqual(observation.phase_coverage.unclassified,[]);assert.equal(observation.phase_coverage.target_phases_distinguished,true);
 }
 assert.deepEqual(run,before);assert.equal(run.records[0].timing.final_persisted_result_ms,100);assert.equal(report.production_switch_approved,false);
});
test('资格合同：非流式可观测性按请求而不按arm，两项不可观测原因分别保留',()=>{
 const run=fixture();for(const row of run.records){
  timingV2(row,{stream:false});row.timing.first_event_ms=null;
  row.timing.diagnostics.first_event_ms={observability:'unobservable',definition:'first_incremental_event',reason:'非流式请求不提供增量首事件。'};
 }
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');
 for(const field of ['first_event_ms','first_token_ms'])for(const arm of ['old','new'])assert.deepEqual(report.latency_diagnostics[field][arm],{denominator:48,observed:0,unobservable:48,missing:0});
 assert.ok(report.unknowns.filter(item=>item.reason.startsWith('latency_first_')).every(item=>item.blocking===false));
});
test('资格合同：流式漏采marker仍blocking，v1缺可观测性声明也不假认证',()=>{
 for(const version of ['reply-latency-v1','reply-latency-v2']){
  const run=fixture(),row=run.records.find(row=>row.arm==='new');if(version.endsWith('v2'))timingV2(row);
  row.timing.first_token_ms=null;const report=buildReplyComparisonReport(manifestText,datasetText,run);
  assert.equal(report.overall.status,'undetermined');assert.equal(report.metrics.latency_p50.status,'passed');
  assert.ok(report.unknowns.some(item=>item.reason==='latency_first_token_ms_unknown'&&item.blocking===true));
  assert.equal(report.latency_diagnostics.first_token_ms.new.missing,1);assert.equal(report.latency_diagnostics.first_token_ms.new.denominator,48);
 }
});
test('资格合同：缺非流式请求证明保留未知，不把单独不可观测声明当证据',()=>{
 const run=fixture(),row=timingV2(run.records[0],{stream:false});delete row.request_observation;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'undetermined');assert.ok(report.unknowns.some(item=>item.reason==='latency_diagnostic_request_unknown'));
 assert.equal(report.latency_diagnostics.first_token_ms.old.unobservable,0);assert.equal(report.latency_diagnostics.first_token_ms.old.missing,1);
});
test('资格合同：可观测性与实际请求、定义或数值矛盾时拒绝',()=>{
 for(const mutate of [
  row=>{row.timing.first_token_ms=null;row.timing.diagnostics.first_token_ms={observability:'unobservable',definition:'first_incremental_token',reason:'声明无增量信号。'};},
  row=>{row.request_observation.body.stream=false;},
  row=>{row.timing.diagnostics.request_sha256='0'.repeat(64);},
  row=>{row.timing.first_event_ms=null;row.timing.diagnostics.first_event_ms={observability:'unobservable',definition:'completed_sdk_response',reason:'不能把本可观测的完成回调声明为不可观测。'};},
 ]){const run=fixture(),row=timingV2(run.records[0]);mutate(row);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_diagnostic/);}
 const known=fixture(),row=timingV2(known.records[0],{stream:false});row.timing.first_token_ms=30;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,known),/latency_diagnostic_contradiction/);
});
test('资格合同：wire请求证明按原字节校验，JSON值摘要不能代替wire摘要',()=>{
 const run=fixture(),row=timingV2(run.records[0],{stream:false}),body=row.request_observation.body,raw=JSON.stringify(body,null,2);
 row.request_observation={body,raw_utf8:raw,hash_kind:'wire_utf8_sha256',sha256:hash(raw)};
 row.request_sha256=hash(raw);row.timing.diagnostics.request_sha256=row.request_sha256;
 assert.equal(buildReplyComparisonReport(manifestText,datasetText,run).overall.status,'passed');
 row.request_observation.raw_utf8+='\n';assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_diagnostic_request_hash/);
});
test('资格合同：未分类间隙明示但不抹去已证最终延迟，目标阶段区分仍未完成',()=>{
 const run=fixture(),row=timingV2(run.records[0]);row.timing.phases.persistence.ended_ms=95;
 const report=buildReplyComparisonReport(manifestText,datasetText,run),observed=report.latency_observations.find(item=>item.record_id===row.case_id+':'+row.arm+':'+row.repeat);
 assert.equal(report.overall.status,'undetermined');assert.equal(report.metrics.latency_p50.status,'passed');assert.equal(report.metrics.latency_p50.totals.old.known,48);
 assert.deepEqual(observed.phase_coverage.unclassified,[{started_ms:95,ended_ms:100}]);assert.equal(observed.phase_coverage.unclassified_ms,5);
 assert.equal(observed.phase_coverage.target_phases_distinguished,false);assert.ok(report.unknowns.some(item=>item.reason==='latency_unclassified_may_include_target_phase'));
});
test('资格合同：全空阶段或无marker的0跨度不能被整段overhead伪装成已区分',()=>{
 for(const zero of [false,true]){
  const run=fixture(),row=timingV2(run.records[0]);for(const name of Object.keys(row.timing.phases))row.timing.phases[name]=zero?{started_ms:0,ended_ms:0}:[];
  row.timing.first_event_ms=null;row.timing.first_token_ms=null;
  row.timing.overhead=[{started_ms:0,ended_ms:100,kind:'framework_overhead',reason:'只观察到框架区间，不能证明目标阶段。',markers:{start:'framework:start',end:'framework:end'}}];
  const report=buildReplyComparisonReport(manifestText,datasetText,run),observed=report.latency_observations.find(item=>item.record_id===row.case_id+':'+row.arm+':'+row.repeat);
  assert.equal(report.overall.status,'undetermined');assert.equal(observed.phase_coverage.target_phases_distinguished,false);assert.equal(observed.phase_coverage.observed_phases.length,0);
  for(const phase of ['queue','retrieval','network_model','validation','persistence'])assert.ok(report.unknowns.some(item=>item.reason==='latency_phase_'+phase+'_unknown'));
 }
});
test('资格合同：有真实成对marker的0跨度保留，不猜未发生阶段为0',()=>{
 const run=fixture(),row=timingV2(run.records[0]);row.timing.phases.validation.ended_ms=80;row.timing.phases.persistence.started_ms=80;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.overall.status,'passed');
 assert.ok(report.latency_observations[0].phase_coverage.observed_phases.includes('validation'));
});
test('资格合同：真实重叠阶段用并集表达不相加，framework开销不能重叠目标阶段',()=>{
 const run=fixture(),row=timingV2(run.records[0]);row.timing.phases.network_model.ended_ms=85;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);assert.equal(report.overall.status,'passed');assert.equal(report.latency_observations[0].phase_coverage.observed_phase_union_ms,100);assert.equal(report.latency_observations[0].phase_coverage.durations_not_summed,true);
 row.timing.overhead=[{started_ms:82,ended_ms:88,kind:'framework_overhead',reason:'不能把实际目标阶段重标框架开销。',markers:{start:'framework:start',end:'framework:end'}}];
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_overhead_phase_overlap/);
});
test('资格合同：阶段marker时间矛盾、无依据overhead和区间越界均拒绝',()=>{
 for(const mutate of [
  row=>{row.timing.phases.persistence.markers.start='network_model:start';},
  row=>{row.timing.overhead=[{started_ms:95,ended_ms:100,kind:'framework_overhead',reason:'无marker不能证明开销。'}];},
  row=>{row.timing.phases.persistence.ended_ms=101;},
 ]){const run=fixture(),row=timingV2(run.records[0]);mutate(row);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_(phase|overhead)/);}
});
test('资格合同：最终点或持久结果绑定未知不计已知最终延迟，不造COMMIT要求',()=>{
 for(const mutate of [row=>{row.timing.final_persisted_result_ms=null;},row=>{row.deterministic_checks.status='unknown';}]){
  const run=fixture(),row=timingV2(run.records[0]);mutate(row);const report=buildReplyComparisonReport(manifestText,datasetText,run);
  assert.equal(report.overall.status,'undetermined');assert.equal(report.metrics.latency_p50.status,'undetermined');assert.equal(report.metrics.latency_p50.totals.old.known,47);assert.equal(report.metrics.latency_p50.totals.old.denominator,48);
 }
});
test('资格合同：诊断不可观测不能放宽最终延迟、调用、token及费用阈值',()=>{
 const run=fixture();for(const row of run.records)timingV2(row,{stream:false});let index=0;
 for(const pair of createReplyComparisonPlan(manifestText,datasetText))for(const arm of pair.order==='AB'?['old','new']:['new','old']){
  const row=run.records.find(row=>row.case_id===pair.case_id&&row.repeat===pair.repeat&&row.arm===arm),start=Date.UTC(2026,9,24)+index++*1000;
  if(arm==='new'){row.latency_ms=130;row.timing.observed_ms=130;row.timing.final_persisted_result_ms=130;row.timing.phases.network_model.ended_ms=110;row.timing.phases.validation.started_ms=110;row.timing.phases.validation.ended_ms=120;row.timing.phases.persistence.started_ms=120;row.timing.phases.persistence.ended_ms=130;}
  row.started_at=new Date(start).toISOString();row.ended_at=new Date(start+row.latency_ms).toISOString();
 }
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.metrics.latency_p50.limit,1.15);assert.equal(report.metrics.latency_p95.limit,1.25);assert.equal(report.metrics.physical_calls.limit,1.05);assert.equal(report.metrics.total_tokens.limit,1.10);assert.equal(report.metrics.cost.limit,1.10);
 assert.equal(report.metrics.latency_p50.status,'failed');assert.equal(report.metrics.latency_p95.status,'failed');assert.equal(report.overall.status,'failed');assert.equal(report.population.planned,96);assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
});
test('资格合同：首事件定义必须与绑定的实际stream模式一致，请求正文不复制到报告',()=>{
 for(const stream of [false,true]){
  const run=fixture(),row=timingV2(run.records[0],{stream});
  row.timing.diagnostics.first_event_ms.definition=stream?'completed_sdk_response':'first_incremental_event';
  assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_diagnostic_contradiction/);
 }
 const run=fixture(),row=timingV2(run.records[0],{stream:false});
 row.request_observation.body.metadata={synthetic_private_request_marker:'request-body-must-stay-out-of-report'};
 row.request_observation.sha256=hash(row.request_observation.body);row.request_sha256=row.request_observation.sha256;row.timing.diagnostics.request_sha256=row.request_sha256;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');assert.equal(JSON.stringify(report).includes('request-body-must-stay-out-of-report'),false);
});
test('资格修复：overhead不能通过额外调试对象把请求正文带进报告',()=>{
 const run=fixture(),row=timingV2(run.records[0]);row.timing.phases.persistence.ended_ms=95;
 row.timing.overhead=[{started_ms:95,ended_ms:100,kind:'framework_overhead',reason:'已保存结果的框架返回处理。',markers:{start:'persistence:end',end:'service:return'},request_debug:{body:{messages:[{role:'user',content:'SYNTHETIC_PRIVATE_BODY_MUST_NOT_COPY'}]}}}];
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_.*fields/);
});
test('资格修复：v1不能忽略已提供且摘要绑定的非流式请求与已知token矛盾',()=>{
 for(const keepDeclaration of [true,false]){
  const run=fixture(),row=timingV2(run.records[0],{stream:false});row.timing.schema_version='reply-latency-v1';row.timing.first_token_ms=30;
  if(!keepDeclaration)delete row.timing.diagnostics;
  assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_diagnostic_contradiction/);
 }
});
test('资格修复：timing、阶段、marker与diagnostics未知子字段都不能外带正文',()=>{
 const body={body:{messages:[{role:'user',content:'SYNTHETIC_NESTED_PRIVATE_BODY'}]}};
 const mutations=[
  row=>{row.timing.request_debug=body;},
  row=>{row.timing.phases.queue.request_debug=body;},
  row=>{row.timing.phases.queue.markers.request_debug=body;},
  row=>{row.timing.overhead[0].markers.request_debug=body;},
  row=>{row.timing.diagnostics.request_debug=body;},
  row=>{row.timing.diagnostics.first_token_ms.request_debug=body;},
  row=>{row.timing.schema_version='reply-latency-v1';row.timing.diagnostics.first_token_ms.request_debug=body;},
  row=>{row.timing.diagnostics=null;},
 ];
 for(const mutate of mutations){
  const run=fixture(),row=timingV2(run.records[0]);row.timing.phases.persistence.ended_ms=95;
  row.timing.overhead=[{started_ms:95,ended_ms:100,kind:'framework_overhead',reason:'合成返回处理。',markers:{start:'persistence:end',end:'service:return'}}];
  mutate(row);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_(timing_fields|interval_fields|phase_markers|diagnostic_)/);
 }
});
test('资格修复：v1有无请求证明分别处理，不能用声明版本跳过摘要矛盾或推断不可观测',()=>{
 const streaming=fixture(),known=timingV2(streaming.records[0]);known.timing.schema_version='reply-latency-v1';delete known.timing.diagnostics;
 assert.equal(buildReplyComparisonReport(manifestText,datasetText,streaming).overall.status,'passed');
 const legacy=fixture(),row=timingV2(legacy.records[0],{stream:false});row.timing.schema_version='reply-latency-v1';delete row.timing.diagnostics;
 let report=buildReplyComparisonReport(manifestText,datasetText,legacy);
 assert.equal(report.overall.status,'undetermined');assert.equal(report.latency_diagnostics.first_token_ms.old.unobservable,0);assert.equal(report.latency_diagnostics.first_token_ms.old.missing,1);
 assert.ok(report.unknowns.some(item=>item.reason==='latency_first_token_ms_unknown'&&item.blocking===true));
 row.request_observation.body.stream=true;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,legacy),/latency_diagnostic_request_hash/);
 const noProof=fixture();assert.equal(buildReplyComparisonReport(manifestText,datasetText,noProof).overall.status,'passed');
});
test('资格修复：model_run禁止借fixture请求观测，真实来源缺失仍记missing而非不可观测',()=>{
 const run=fixture(),row=timingV2(run.records[0],{stream:false});run.evidence_kind='model_run';
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_diagnostic_fixture_request_forbidden/);
 delete row.request_observation;
 const report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'undetermined');assert.equal(report.latency_diagnostics.first_token_ms.old.unobservable,0);assert.equal(report.latency_diagnostics.first_token_ms.old.missing,1);
 assert.ok(report.unknowns.some(item=>item.reason==='latency_diagnostic_request_unknown'&&item.blocking===true));
 assert.ok(report.unknowns.some(item=>item.reason==='latency_first_token_ms_unknown'&&item.blocking===true));
});
test('资格修复：严格元数据保留合法开销原因、诊断原因与null，已知数值矛盾仍拒绝',()=>{
 const run=fixture(),row=timingV2(run.records[0],{stream:false});row.timing.first_event_ms=null;
 row.timing.diagnostics.first_event_ms.reason='合成：完成响应marker漏采，不能写0。';row.timing.phases.persistence.ended_ms=95;
 row.timing.overhead=[{started_ms:95,ended_ms:100,kind:'framework_overhead',reason:'合成：持久化完成后的返回处理。',markers:{start:'persistence:end',end:'service:return'}}];
 const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run),observed=report.latency_observations[0];
 assert.equal(report.overall.status,'undetermined');assert.equal(report.metrics.latency_p50.status,'passed');assert.equal(report.latency_diagnostics.first_token_ms.old.unobservable,1);
 assert.equal(observed.diagnostics.first_event_ms.value_ms,null);assert.equal(observed.diagnostics.first_event_ms.reason,row.timing.diagnostics.first_event_ms.reason);
 assert.equal(observed.diagnostics.first_token_ms.reason,'非流式请求不提供增量token信号。');assert.deepEqual(observed.phase_coverage.framework_overhead,row.timing.overhead);
 assert.deepEqual(report.records[0].timing,row.timing);assert.deepEqual(run,before);
 row.timing.phases.persistence.ended_ms=101;
 assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/latency_phase_order/);
});
for(const field of ['usage','cost','deterministic_checks'])test('出口修复：'+field+'额外请求正文仅留输入，报告保留合法统计元数据',()=>{
 const run=fixture(),row=run.records[0],canary='SYNTHETIC_PRIVATE_METADATA_'+field.toUpperCase(),baseline=buildReplyComparisonReport(manifestText,datasetText,run);
 row[field].request_debug={body:{messages:[{role:'user',content:canary}]}};
 const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(JSON.stringify(report).includes(canary),false);assert.deepEqual(run,before);
 assert.deepEqual(report.population,baseline.population);assert.deepEqual(report.metrics,baseline.metrics);assert.deepEqual(report.semantic_quality,baseline.semantic_quality);assert.deepEqual(report.unknowns,baseline.unknowns);
 assert.equal(report.overall.status,'passed');assert.deepEqual(report.records[0][field],baseline.records[0][field]);
 assert.equal(report.records[0].output_sha256,hash(row.output));assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
});
test('出口修复：价格、两臂版本绑定和评审容器的额外对象不复制到报告',()=>{
 const mutations=[run=>run.price_snapshot,run=>run.bindings,run=>run.bindings.old,run=>run.bindings.new,run=>run.records[0].reviews[0],run=>run.records[0].reviews[0].candidates[0]];
 const baseline=buildReplyComparisonReport(manifestText,datasetText,fixture());
 for(const target of mutations){
  const run=fixture(),canary='SYNTHETIC_PRIVATE_METADATA_OTHER_CONTAINER';target(run).extension={body:{messages:[{role:'user',content:canary}]}};
  const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
  assert.equal(JSON.stringify(report).includes(canary),false);assert.deepEqual(run,before);assert.equal(report.overall.status,'passed');
  assert.deepEqual(report.bindings,baseline.bindings);assert.deepEqual(report.records[0].reviews,baseline.records[0].reviews);assert.deepEqual(report.metrics,baseline.metrics);assert.deepEqual(report.unknowns,baseline.unknowns);
 }
});
test('出口修复：未知的模型、版本和时间标量不能把对象作为元数据透传',()=>{
 for(const mutate of [
  (run,value)=>{run.records[0].actual_model=value;},(run,value)=>{run.records[0].model_fingerprint=value;},
  (run,value)=>{run.records[0].started_at=value;},(run,value)=>{run.records[0].ended_at=value;},
  (run,value)=>{run.records[0].reviews[0].reviewer_model=value;},(run,value)=>{run.records[0].reviews[0].reviewer_version=value;},
 ]){
  const run=fixture(),canary='SYNTHETIC_PRIVATE_METADATA_WRONG_SCALAR';mutate(run,{body:{messages:[{content:canary}]}});
  const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
  assert.equal(JSON.stringify(report).includes(canary),false);assert.deepEqual(run,before);assert.ok(report.unknowns.length>0);assert.equal(report.population.planned,96);
  assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
 }
});
test('出口修复：投影前仍校验金额、计数、评分和绑定矛盾，不以删字段掩盖错误',()=>{
 for(const mutate of [
  run=>{run.records[0].usage.input_tokens={body:{messages:[]}};},run=>{run.records[0].cost.amount=-1;},
  run=>{run.records[0].deterministic_checks.output_sha256='0'.repeat(64);},run=>{run.price_snapshot.sha256='invalid';},
  run=>{run.bindings.old.lock_hash={body:{messages:[]}};},run=>{run.records[0].reviews[0].candidates[0].scores.request_debug={body:{messages:[]}};},
 ]){const run=fixture();mutate(run);assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/usage|cost_or_price_binding|deterministic_output_binding|price_snapshot|lock_hash_unknown|review_scores/);}
});
test('出口修复：保留合同文字理由和完整原输出摘要，投影视图不冒充原证据',()=>{
 const run=fixture(),row=run.records[0],outputBody='SYNTHETIC_FULL_OUTPUT_PRIVATE_BODY',reason='合成评审理由保留字段词：request_debug/body/messages。';
 row.output.candidates[0].messages=[{message_id:'synthetic-message',text:outputBody}];row.output.candidates[0].risk_notes=['合成风险说明'];
 row.deterministic_checks.output_sha256=hash(row.output);
 const subject=hash({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output});
 for(const review of row.reviews){review.subject_sha256=subject;review.candidates[0].basis=reason;}
 const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run);
 assert.equal(report.overall.status,'passed');assert.equal(report.records[0].output_sha256,hash(row.output));assert.equal(report.records[0].deterministic_checks.output_sha256,hash(row.output));
 assert.equal(report.records[0].reviews[0].subject_sha256,subject);assert.equal(report.records[0].reviews[0].candidates[0].basis,reason);
 assert.equal(JSON.stringify(report).includes(outputBody),false);assert.deepEqual(run,before);
 report.records[0].reviews[0].candidates[0].scores.chinese_usability=0;report.records[0].usage.input_tokens=99;report.records[0].timing.phases.queue.started_ms=5;report.bindings.arms.old.commit='changed-in-report';
 assert.deepEqual(run,before);
 row.output.candidates[0].messages[0].text='摘要绑定后被改写';assert.throws(()=>buildReplyComparisonReport(manifestText,datasetText,run),/deterministic_output_binding/);
});
test('出口修复：未定的实际来源只输出完整逐次摘要，SDK请求对象仍留输入',()=>{
 const run=fixture(),row=run.records[0],canary='SYNTHETIC_PRIVATE_PENDING_REQUEST';row.physical_calls=2;
 row.runtime_sources={schema_version:'reply-runtime-sources-v1',attempts:[1,2].map(index=>({attempt_id:`a0000000-0000-4000-8000-00000000000${index}`,request:{hash_kind:'canonical_json_sha256',sha256:row.request_sha256,body:{messages:[{content:canary}]}},response_started_at:'2026-10-24T00:00:00.020Z',request_debug:{body:{messages:[{content:canary}]}}}))};
 const before=structuredClone(run),report=buildReplyComparisonReport(manifestText,datasetText,run),audit=report.records[0].source_audit;
 assert.equal(report.overall.status,'undetermined');assert.equal(audit.status,'undetermined');assert.equal(audit.attempt_count,2);assert.equal(audit.attempt_observations.length,2);
 assert.equal(audit.reason,'runtime_multiple_attempts_unsupported');assert.equal(JSON.stringify(report).includes(canary),false);assert.deepEqual(run,before);
 assert.equal(report.arms.old.denominator,48);assert.equal(report.population.planned,96);
});
