import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {auditReplyRuntimeSources} from '../src/reply-comparison-sources.ts';
const bytes=await readFile(new URL('./fixtures/reply-comparison-multi-attempt-v4.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'7ccaff5445d3ba12db5bd7483e6732ab88a5e54153ebba688260a8cdd4c334b6');
const records=JSON.parse(bytes).records,dataset=JSON.parse(await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'));
const clone=arm=>structuredClone(records.find(row=>row.arm===arm));
const audit=row=>auditReplyRuntimeSources(dataset.cases.find(member=>member.case_id===row.case_id),row,row.output);
function unknown(row){let result;try{result=audit(row);}catch(error){assert.match(error.message,/^reply_comparison_invalid:runtime_/);return;}assert.equal(result.status,'undetermined');assert.equal(result.derived_proof,undefined);assert.equal(result.attempt_count,2);}
function oldEvent(type,change){const row=clone('old');change(row.partial_observations.events.find(event=>event.type===type));row.actual.partial_observations=structuredClone(row.partial_observations);return row;}
test('P2原反例：旧拒绝callback异owner/contact不得作为本scope拒绝证明',()=>{unknown(oldEvent('actual_read_file_scope_denied',event=>{event.scope={ownerId:'10000000-0000-4000-8000-000000000001',contactId:'10000000-0000-4000-8000-000000000002',scene:''};}));});
test('P2原反例：旧拒绝callback显式另一工具不能忽略',()=>{unknown(oldEvent('actual_read_file_scope_denied',event=>{event.tool='history_search';}));});
test('P2原反例：旧拒绝callback成功结果及新正文不能忽略',()=>{unknown(oldEvent('actual_read_file_scope_denied',event=>{event.outcome='succeeded';event.result='新增历史正文';}));});
for(const [name,change]of [
 ['异scope',event=>{event.scope={ownerId:'10000000-0000-4000-8000-000000000001',contactId:'10000000-0000-4000-8000-000000000002'};}],
 ['异tool',event=>{event.tool='history_search';}],
 ['成功result',event=>{event.outcome='succeeded';event.result='新增历史正文';}],
])test('相邻旧start callback也不能夹带'+name,()=>{unknown(oldEvent('tool_start_read_file',change));});
for(const [name,change]of [
 ['新增result',event=>{event.result='新增历史正文';}],
 ['异tool',event=>{event.tool='history_search';}],
 ['成功outcome',event=>{event.outcome='succeeded';}],
])test('新臂原明确拒绝结构对同形矛盾保持未定 / '+name,()=>{const row=clone('new');change(row.partial_observations.primary_tool_events[0]);unknown(row);});
test('新臂scope未知字段不能充当原绑定',()=>{const row=clone('new');row.partial_observations.primary_tool_events[0].scope.extra_scope={contactId:'different'};unknown(row);});
for(const arm of ['old','new'])test('v4实际capture '+arm+' 保持原样及同形派生proof，不伪补旧scope',()=>{
 const row=clone(arm),before=structuredClone(row),result=audit(row),other=audit(clone(arm==='old'?'new':'old'));
 assert.equal(result.status,'verified');assert.deepEqual(Object.keys(result.derived_proof).sort(),Object.keys(other.derived_proof).sort());
 assert.equal(result.derived_proof.real_model_quality_verified,false);assert.equal(result.derived_proof.production_switch_approved,false);assert.deepEqual(row,before);
 if(arm==='old')for(const event of row.partial_observations.events)assert.deepEqual(Object.keys(event).sort(),['at_ms','type']);
});
