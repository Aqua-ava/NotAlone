/** 只读本轮合成持久证据；不补造模型评分，也不访问业务库。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const base=new URL('./',import.meta.url);
async function evidence(label){
  const report=JSON.parse(await readFile(new URL(`${label}/report.json`,base),'utf8'));
  const directory=join(tmpdir(),report.private_evidence_directory_label);
  const records=(await readFile(join(directory,'observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  return {report,directory,records};
}
test('三域持久取消后释放的迟到结果均不新增业务版本或草稿',async()=>{
  const {records}=await evidence('cancel-wire-final');
  assert.equal(records.length,6);
  for(const row of records){
    assert.equal(row.terminal_status,'cancelled');assert.equal(row.physical_calls,1);
    assert.deepEqual(row.event_receipts.map(e=>e.event),['start','cancel','synthetic_late_result']);
    assert.equal(row.event_receipts[2].mutating_response,true);
    assert.match(row.event_receipts[2].payload_sha256,/^[a-f0-9]{64}$/);
    assert.match(row.event_receipts[2].response_sha256,/^[a-f0-9]{64}$/);
    const frozenText=row.adaptation.events.find(e=>e.event==='synthetic_late_result').text;
    assert.ok(row.audit.response_bodies.some(response=>response.body.includes(frozenText)));
    assert.ok(Object.values(row.audit.final_state.counts).every(n=>n===0||n===null));
    assert.equal(row.audit.final_state.existing_skill_unchanged,true);
    assert.equal(row.audit.persisted_physical_count,1);
  }
});
test('学习真实capture保留联系人说话人、普通观察与当前联系人Skill v1',async()=>{
  const {records}=await evidence('speaker-capture');assert.equal(records.length,2);
  for(const row of records){
    assert.equal(row.physical_calls,0);const batch=row.output.batch_preview;
    assert.equal(batch.materials.length,1);assert.equal(batch.materials[0].priority,'ordinary');
    assert.equal(batch.materials[0].external_messages[0].speaker,'contact');
    assert.equal(batch.targets[0].version_number,1);assert.equal(batch.targets[0].scope.kind,'contact');
    assert.equal(batch.targets[0].scope.contact_id,row.scope.contact_id);
  }
});
test('非空E/V完整捕获并逐HTTP持久记账，最终盲包不暴露运行标签',async()=>{
  const {records,directory}=await evidence('extraction-ev-ledger');
  for(const row of records){
    assert.equal(row.terminal_status,'succeeded');assert.equal(row.physical_calls,2);assert.equal(row.audit.persisted_physical_count,2);
    assert.equal(row.audit.trace_events.filter(e=>e.stage==='model_request').length,2);
  }
  const receipt=JSON.parse(await readFile(new URL('neutral-ev-final-receipt.json',base),'utf8'));
  assert.equal(receipt.ev_complete,2);assert.equal(receipt.independent_reviews_completed,0);
  for(const reviewer of ['reviewer-a','reviewer-b']){
    const text=await readFile(join(directory,'neutral-ev-final',reviewer,'packet.json'),'utf8');
    assert.doesNotMatch(text,/typescript|langchain|langgraph|lc_run|4f89bb|3c168296|model_accounting_owner/i);
    const packet=JSON.parse(text);assert.equal(packet.records.length,2);
    for(const row of packet.records)assert.deepEqual(row.coverage,{extraction_requests:1,extraction_responses:1,verification_requests:1,verification_responses:1});
  }
});
test('方法修正只保存pending草稿，引用s4与已启用v1且不自动发布',async()=>{
  const {records}=await evidence('correction-proposals');
  for(const row of records.filter(r=>r.domain==='skill_learning')){
    const state=row.audit.final_state,source=row.adaptation.sources.find(s=>s.source_id.endsWith('-s4'));
    assert.equal(state.draft_states.length,1);assert.equal(state.draft_states[0].status,'pending');
    assert.equal(state.draft_states[0].target_versions[0].version_number,1);
    assert.ok(state.draft_states[0].dependency_ids.includes(source.storage_id));
    assert.ok(state.draft_states[0].dependency_ids.includes(source.message_id));
    assert.equal(state.existing_skill_unchanged,true);
  }
});
test('L2修正结果引用s4并保留三个原来源版本；旧no_change不冒充语义成功',async()=>{
  const {records}=await evidence('correction-l2-final');const row=records.find(r=>r.arm==='new');
  assert.equal(row.terminal_status,'succeeded');
  const correction=row.adaptation.sources.find(s=>s.source_id.endsWith('-s4'));
  assert.ok(row.business_output.scenarios.flatMap(s=>s.paragraphs).some(p=>p.references.some(r=>r.memory_id===correction.memory_id&&r.revision===1)));
  assert.equal(row.audit.final_state.actual_memory_versions.length,3);
  assert.ok(row.audit.final_state.actual_memory_versions.every(m=>m.revision===1));
});
test('冻结初始删除态经公开管理入口无活动来源与零HTTP，精确自有夹具均已删除',async()=>{
  const {records,directory,report}=await evidence('deletion-public-entry');assert.equal(records.length,2);
  assert.equal(report.cleanup.owned_source_snapshot_removed,true);
  for(const row of records){
    assert.equal(row.terminal_status,'succeeded');assert.equal(row.physical_calls,0);
    assert.ok(row.audit.final_state.actual_sources.every(s=>s.status==='deleted'&&s.content_sha256===null));
    assert.equal(row.audit.final_state.actual_memory_versions.length,0);
  }
  const receipts=(await readdir(directory)).filter(p=>p.startsWith('fixture-')&&p.endsWith('.json'));
  assert.equal(receipts.length,2);
  for(const name of receipts)assert.equal(JSON.parse(await readFile(join(directory,name),'utf8')).dropped,true);
});
