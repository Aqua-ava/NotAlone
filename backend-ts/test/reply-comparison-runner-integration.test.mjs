import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {collectLocal} from '../../.scratch/dsh-ts-migration/ticket25-final-run/runner.mjs';

const SOURCE_COMMIT=process.env.NOTALONE_COMPARISON_SOURCE_COMMIT??execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('../..',import.meta.url),encoding:'utf8'}).trim();
assert.match(SOURCE_COMMIT,/^[a-f0-9]{40}$/);
const collectCaptured=options=>collectLocal({...options,sourceCommit:SOURCE_COMMIT});

test('固定runner经本机双臂实际业务和PG后产生可审计来源，不使用真实预算', {timeout:60000}, async()=>{
 const capture=await collectCaptured({localOnly:true,caseId:'paired-decline'});
 assert.equal(capture.received,2);
 assert.equal(capture.records.every(row=>row.source_audit.status==='verified'),true,JSON.stringify(capture.records.map(row=>({arm:row.arm,status:row.actual.status,error:row.actual.error}))));
 assert.equal(capture.records.find(row=>row.arm==='new').runtime_sources.attempts[0].catalog.schema_version,'reply-runtime-source-catalog-v2');
 assert.equal(capture.records.every(row=>row.physical_calls===1),true);
 assert.equal(capture.records.every(row=>row.timing!==null),true);
 assert.equal(capture.evidence_kind,'localhost_fake_provider_actual_business_pipelines');
 assert.equal(capture.problem_budget.external_execution_enabled,false);
});

test('固定96本机采集经盲包、normalizer和报告器仍明确为fixture', {timeout:90000}, async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const root=new URL('../..',import.meta.url).pathname,dir=await mkdtemp(join(tmpdir(),'notalone-runner-v2-'));
 try{
  const {runFixed96}=await import('../../.scratch/dsh-ts-migration/ticket25-final-run/run-full.mjs');
  const sourceCommit=SOURCE_COMMIT;
  const summary=await runFixed96({localOnly:true,sourceCommit,output:join(dir,'fixed96')});
  assert.equal(summary.received,96);assert.equal(summary.physical_calls,96);assert.equal(summary.ledger_created,false);
  const capture=JSON.parse(await readFile(join(dir,'fixed96/capture.raw-96.json'),'utf8'));
  assert.equal(capture.records.length,96);assert.equal(capture.records.filter(row=>row.actual.status==='succeeded').length,96);
  await normalizedFixture(capture,dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('实际wire映射缺失或篡改、旧臂来源不完整都阻断资格', {timeout:60000},async()=>{
 const {verifyCapturedSources}=await import('../../.scratch/dsh-ts-migration/ticket25-final-run/capture-contract.mjs');
 const {readFile}=await import('node:fs/promises');
 const {randomUUID}=await import('node:crypto');
 const dataset=JSON.parse(await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'));
 const captured=await collectCaptured({localOnly:true});
 assert.match(verifyCapturedSources(captured,dataset).prompt_hash,/^[a-f0-9]{64}$/);
 const mutations=[
  [value=>{delete value.records.find(row=>row.arm==='new').runtime_sources.attempts[0].model_alias_mapping;},/model_alias_mapping_required/],
  [value=>{value.records.find(row=>row.arm==='new').runtime_sources.attempts[0].model_alias_mapping[0].evidence_id=randomUUID();},/source_identity_or_status|model_alias_mapping/],
  [value=>{value.records.find(row=>row.arm==='new').runtime_sources.attempts[0].request.raw_utf8+=' ';},/request_wire_hash/],
  [value=>{delete value.records.find(row=>row.arm==='old').runtime_sources.attempts[0].source_binding;},/legacy_attempt_source_incomplete/],
  [value=>{delete value.source_bindings.old_profile;},/legacy_source_or_profile_incomplete/],
  [value=>{delete value.records.find(row=>row.arm==='new').runtime_sources.persistence.request_snapshot;},/runtime_complete_persistence_missing/],
 ];
 for(const [mutate,expected]of mutations){const invalid=structuredClone(captured);mutate(invalid);assert.throws(()=>verifyCapturedSources(invalid,dataset),expected);}
});

test('供应商失败保留实际调用、失败分母并拒绝盲包', {timeout:60000},async()=>{
 const {readFile}=await import('node:fs/promises'),{createBlindPacket}=await import('../experiments/reply-blind-packet.mjs');
 const dataset=JSON.parse(await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'));
 const capture=await collectCaptured({localOnly:true,localFaults:{new:'provider_failure'}}),row=capture.records.find(row=>row.arm==='new');
 assert.equal(capture.records.length,2);assert.equal(row.actual.status,'failed');assert.equal(row.physical_calls,1);
 assert.equal(row.output,null);assert.equal(row.source_storage_receipt,null);assert.equal(row.source_audit.status,'undetermined');
 assert.equal(row.usage,null);assert.equal(row.cost,null);
 assert.throws(()=>createBlindPacket({capture,dataset,seed:'3'.repeat(64)}),/non_success_requires_separate_failure_review/);
});

test('真实业务取消保留取消终态和物理请求，拒绝保存与盲包', {timeout:60000},async()=>{
 const {readFile}=await import('node:fs/promises'),{createBlindPacket}=await import('../experiments/reply-blind-packet.mjs');
 const dataset=JSON.parse(await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'));
 const capture=await collectCaptured({localOnly:true,localFaults:{new:'cancel'}}),row=capture.records.find(row=>row.arm==='new');
 assert.equal(capture.records.length,2);assert.equal(row.actual.status,'cancelled');assert.equal(row.physical_calls,1);
 assert.equal(row.output,null);assert.equal(row.persisted_candidates.length,0);assert.equal(row.source_audit.status,'undetermined');
 assert.throws(()=>createBlindPacket({capture,dataset,seed:'4'.repeat(64)}),/non_success_requires_separate_failure_review/);
});

async function normalizedFixture(capture,dir){
 const {writeFile,readFile}=await import('node:fs/promises');
 const {join}=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const {createHash}=await import('node:crypto');
 const {createBlindPacket}=await import('../experiments/reply-blind-packet.mjs');
 const {buildReplyComparisonReport}=await import('../src/reply-comparison.ts');
 const root=new URL('../..',import.meta.url).pathname;
 const hash=text=>createHash('sha256').update(text).digest('hex');
  const datasetText=await readFile(join(root,'backend/tests/fixtures/fidelity/synthetic-v1.json'),'utf8'),dataset=JSON.parse(datasetText);
  const paired=capture.records.filter(row=>capture.records.filter(other=>other.case_id===row.case_id&&other.repeat===row.repeat).every(other=>other.actual.status==='succeeded'));
  const packet=createBlindPacket({capture:{...capture,records:paired,received:paired.length},dataset,seed:'2'.repeat(64)}),visibleText=JSON.stringify(packet.visible);
  const price={source_page_sha256:hash('local-fixture-price-only'),currency:'USD',billed_model:'deepseek-flash',cache_hit_usd_per_million:1,cache_miss_usd_per_million:1,output_usd_per_million:1};
  await Promise.all(Object.entries({'capture.json':capture,'visible.json':packet.visible,'binding.json':packet.binding,'config.json':{price_snapshot:price}}).map(([name,body])=>writeFile(join(dir,name),JSON.stringify(body))));
  for(const id of ['review1','review2'])await writeFile(join(dir,id+'.json'),JSON.stringify({schema_version:'reply-independent-review-v1',reviewer_id:id,reviewer_type:'agent',reviewer_model:'local-test-fixture',reviewer_version:'fixture-v1',independent:true,blinded:true,packet_sha256:hash(visibleText),items:packet.visible.items.map(item=>({blind_id:item.blind_id,subject_sha256:item.review_subject_sha256,review_id:id+item.blind_id,candidates:item.candidates.map(candidate=>({candidate:candidate.candidate,scores:{evidence_correctness:2,intent_preservation:2,no_unsupported_content:2,relationship_fit:2,chinese_usability:2},severe_errors:{false_fact:0,wrong_person:0,unsupported_commitment:0},basis:'合成格式验证；没有实际独立评分。'}))}))}));
  execFileSync(process.execPath,[join(root,'.scratch/dsh-ts-migration/ticket25-final-run/normalize.mjs'),'--mode','local-only','--source-commit',capture.source_bindings.new_commit,'--capture',join(dir,'capture.json'),'--dataset',join(root,'backend/tests/fixtures/fidelity/synthetic-v1.json'),'--visible',join(dir,'visible.json'),'--binding',join(dir,'binding.json'),'--config',join(dir,'config.json'),'--review',join(dir,'review1.json'),'--review',join(dir,'review2.json'),'--output',join(dir,'run.json'),'--summary-output',join(dir,'summary.json')],{stdio:'pipe'});
  const run=JSON.parse(await readFile(join(dir,'run.json'),'utf8'));
  assert.equal(run.evidence_kind,'reporter_fixture');
  assert.match(run.configuration.prompt_hash,/^[a-f0-9]{64}$/);assert.match(run.configuration.tool_schema_hash,/^[a-f0-9]{64}$/);
  assert.match(run.bindings.old.profile_hash,/^[a-f0-9]{64}$/);
  const report=buildReplyComparisonReport(await readFile(join(root,'.scratch/dsh-ts-migration/baseline/material-manifest.json'),'utf8'),datasetText,run);
  assert.deepEqual(report.population,{planned:96,received:96,missing:0});
  assert.equal(report.real_model_quality_verified,false);assert.equal(report.production_switch_approved,false);
  return {run,report,packet};
}


test('失败与取消仍进入96分母，正常配对盲评不能将其抹去', {timeout:90000},async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'notalone-runner-terminals-'));
 try{
  const capture=await collectCaptured({localOnly:true,full:true,localFaults:{new:[{case_id:'paired-decline',repeat:1,action:'provider_failure'},{case_id:'paired-decline',repeat:2,action:'cancel'}]}});
  assert.equal(capture.records.filter(row=>row.actual.status==='succeeded').length,94);
  const {run,packet,report}=await normalizedFixture(capture,dir);
  assert.equal(run.records.length,96);assert.equal(packet.visible.items.length,92);
  assert.equal(run.records.filter(row=>row.terminal_status==='failed').length,1);
  assert.equal(run.records.filter(row=>row.terminal_status==='cancelled').length,1);
  assert.notEqual(report.overall.status,'passed');
 }finally{await rm(dir,{recursive:true,force:true});}
});
