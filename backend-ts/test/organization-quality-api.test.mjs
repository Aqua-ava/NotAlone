import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {organizationQualityFixture, inputAnnotations} from './organization-quality-fixture.mjs';

test('公开质量输入与运行持久重读，Agent审核保持未知，无运行时拒绝执行且删除不复活', async t=>{
  const f=await organizationQualityFixture(t);
  const created=await f.createInput();
  assert.equal(created.status,200);
  const input=created.body.quality_input;
  assert.equal(input.quality_verified,false);
  assert.equal(input.model_input.memories[0].memory_id,f.memoryId);
  const read=await f.request(`quality-inputs/${input.case_id}`);
  assert.equal(read.status,200);
  assert.equal(read.body.quality_input.input_sha256,input.input_sha256);
  const reviewed=await f.request(`quality-inputs/${input.case_id}/annotations`,inputAnnotations(input));
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.body.quality_input.review_status,'unknown');
  const run=await f.createRun([input.case_id]);
  assert.equal(run.status,200);
  const report=run.body.quality_report;
  assert.equal(report.case_count,1);
  assert.equal(report.http_attempts_used,0);
  assert.equal(report.organization.status,'unknown');
  assert.ok(report.organization.reasons.includes('coverage_insufficient'));
  assert.equal(report.automatic_use_allowed,false);
  const reopened=await f.request(`quality-runs/${report.report_id}`);
  assert.deepEqual(reopened.body.quality_report,report);
  assert.deepEqual(await f.request(`quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true}),
    {status:503,body:{error:'quality_evaluation_unavailable'}});
  assert.equal((await f.request(`quality-inputs/${input.case_id}`,undefined,'GET',randomUUID())).status,404);
  assert.equal((await f.request(`quality-runs/${report.report_id}`,undefined,'DELETE')).status,200);
  assert.equal((await f.request(`quality-inputs/${input.case_id}`)).status,404);
});

test('一次性事实路径预备绑定精确单叶，禁止冒充质量审核或扩大用途',async t=>{
  const f=await organizationQualityFixture(t);
  const input=(await f.createInput()).body.quality_input;
  assert.equal((await f.createRun([input.case_id],{dataset_version:'fact-correction-path-preparation-v1'})).status,409);
  const response=await f.createRun([input.case_id],{dataset_version:'fact-correction-path-preparation-v1',max_http_attempts:1});
  assert.equal(response.status,200);
  const report=response.body.quality_report;
  assert.equal(report.preparation.purpose,'fact_correction_path');
  assert.equal(report.preparation.old_memory_id,f.memoryId);
  assert.equal(report.preparation.quality_verified,false);
  assert.equal(report.preparation.human_review,false);
  assert.equal(report.preparation.state,'armed');
  assert.equal((await f.request(`quality-inputs/${input.case_id}/annotations`,inputAnnotations(input,'human'))).status,409);
  assert.equal(report.organization.status,'unknown');
});

test('未选择的同联系人来源不参与冻结输入，也不误删独立质量报告',async t=>{
  const f=await organizationQualityFixture(t);
  const unrelatedSource=randomUUID(),unrelatedMemory=randomUUID();
  await f.pool.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'manual','独立合成来源',$4,1)`,[unrelatedSource,f.ownerId,f.contactId,'b'.repeat(64)]);
  await f.pool.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,'另一份独立的合成手录。','common_fact','other',$4,'manual')`,[unrelatedMemory,f.ownerId,f.contactId,[unrelatedSource]]);
  const input=(await f.createInput()).body.quality_input;
  assert.equal(input.model_input.memories.length,1);
  const report=(await f.createRun([input.case_id])).body.quality_report;
  await f.pool.query('DELETE FROM source_document WHERE id=$1',[unrelatedSource]);
  assert.equal((await f.request(`quality-runs/${report.report_id}`)).status,200);
});

test('输入摘要、实际版本与owner拒绝伪造，来源删除清除整份报告及审核副本',async t=>{
  const f=await organizationQualityFixture(t);
  const input=(await f.createInput()).body.quality_input;
  const annotations=inputAnnotations(input);
  assert.equal((await f.request(`quality-inputs/${input.case_id}/annotations`,{...annotations,input_sha256:'0'.repeat(64)})).status,409);
  assert.equal((await f.request(`quality-inputs/${input.case_id}/annotations`,{...annotations,quality_verified:true})).status,400);
  assert.equal((await f.request(`quality-inputs/${input.case_id}/review`,{})).status,409);
  const invalid=await f.request(`/api/contacts/${f.contactId}/layered-memory/quality-input`,{memory_versions:[{memory_id:f.memoryId,revision:2}]});
  assert.equal(invalid.status,409);
  const human=await f.request(`quality-inputs/${input.case_id}/annotations`,inputAnnotations(input,'human'));
  assert.equal(human.body.quality_input.review_status,'human_reviewed');
  assert.equal(human.body.quality_input.quality_verified,false);
  const report=(await f.createRun([input.case_id])).body.quality_report;
  assert.equal((await f.createRun([input.case_id])).status,409);
  assert.equal((await f.request(`quality-runs/${report.report_id}/calibration`,{contract_id:report.contract_id,
    reviewer:{kind:'human',name:'合成审阅者'},decision:'approved',notes:'运行尚未执行，不能标定。'})).status,409);
  assert.equal((await f.request(`quality-runs/${report.report_id}`,undefined,'GET',randomUUID())).status,404);
  await f.pool.query('DELETE FROM public.source_document WHERE owner_id=$1 AND id=$2',[f.ownerId,f.sourceId]);
  assert.equal((await f.request(`quality-inputs/${input.case_id}`)).status,404);
  assert.equal((await f.request(`quality-runs/${report.report_id}`)).status,404);
});
