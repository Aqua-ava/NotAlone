import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {auditReplyRuntimeSources} from '../src/reply-comparison-sources.ts';
const text=await readFile(new URL('./fixtures/reply-comparison-multi-attempt-v4.json',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(text).digest('hex'),'7ccaff5445d3ba12db5bd7483e6732ab88a5e54153ebba688260a8cdd4c334b6');
const capture=JSON.parse(text),dataset=JSON.parse(await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'));
const memberFor=row=>dataset.cases.find(member=>member.case_id===row.case_id);
const audit=row=>auditReplyRuntimeSources(memberFor(row),row,row.output);
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const originals=capture.records;
for(const arm of ['old','new'])test('正式v4来源回放 / '+arm,()=>{
 const record=structuredClone(originals.find(record=>record.arm===arm)),before=structuredClone(record),result=audit(record);
 assert.equal(capture.provenance.source_capture_sha256,'87fdbede4768298a40ca6e5ac7f2d79dcff70057b077cec46e4a5fc1e08c8d98');
 assert.equal(capture.provenance.new_execution,false);assert.equal(result.status,'verified');assert.equal(result.output_scope,'complete_http_result');
 assert.equal(result.attempt_count,2);assert.equal(result.derived_proof.real_model_quality_verified,false);assert.equal(result.derived_proof.production_switch_approved,false);
 assert.equal(record.request_sha256,null);assert.deepEqual(record,before);
});
// 只在内存中重新绑定变异声明，防止无关的旧摘要先拦截需要验证的深层合同。
function rebind(row,index=1){
 const attempt=row.runtime_sources.attempts[index],request=attempt.request,trace=row.physical_attempts[index];
 if(request.hash_kind==='wire_utf8_sha256')request.raw_utf8=JSON.stringify(request.body);
 request.sha256=hash(request.hash_kind==='wire_utf8_sha256'?request.raw_utf8:request.body);
 attempt.catalog.request_sha256=request.sha256;attempt.catalog.request_hash_kind=request.hash_kind;
 attempt.catalog_sha256=hash(attempt.catalog);
 Object.assign(trace,{attempt_id:attempt.attempt_id,request:structuredClone(request.body),request_sha256:request.sha256,request_hash_kind:request.hash_kind,evidence:structuredClone(attempt.catalog.entries.map(({text_sha256,case_fields,origin,source_ids,not_confirmed_memory,...source})=>source)),source_catalog:structuredClone(attempt.catalog),source_catalog_sha256:attempt.catalog_sha256,response_started_at:attempt.response_started_at});
 if(request.raw_utf8!==undefined)trace.raw_utf8=request.raw_utf8;
}
function changePayload(row,change,index=1){
 const request=row.runtime_sources.attempts[index].request.body,message=request.messages[row.arm==='new'?0:1];
 const prior=row.arm==='new'?message.content[0].text:message.content;
 const payload=JSON.parse(prior);change(payload);
 if(row.arm==='new')message.content[0].text=JSON.stringify(payload);else message.content=JSON.stringify(payload);
 rebind(row,index);
 return payload;
}
function notVerified(row){
 let result;
 try{result=audit(row);}catch(error){assert.match(error.message,/^reply_comparison_invalid:runtime_/);return;}
 assert.equal(result.status,'undetermined');assert.equal(result.derived_proof,undefined);
 assert.equal(result.attempt_observations.length,row.runtime_sources.attempts.length);
}
function eachArm(name,change){
 for(const original of originals)test(name+' / '+original.arm,()=>{const row=structuredClone(original);change(row);notVerified(row);});
}
test('v4两臂两attempt恒定workspace来源及真实read_file拒绝可核验，原capture不变',()=>{
 for(const original of capture.records){
  const row=structuredClone(original),before=structuredClone(row),result=audit(row);
  assert.equal(result.status,'verified');assert.equal(result.output_scope,'complete_http_result');assert.equal(result.attempt_count,2);
  assert.deepEqual(result.attempt_ids,row.runtime_sources.attempts.map(attempt=>attempt.attempt_id));
  assert.equal(result.contract_scope,'constant_workspace_noSkill_read_denied_v1');
  assert.equal(result.derived_proof.internal_consistency_only,true);assert.equal(result.derived_proof.real_model_quality_verified,false);assert.equal(result.derived_proof.production_switch_approved,false);
  assert.equal(result.binding_sha256,hash(row.runtime_sources));
  assert.deepEqual(result.derived_proof.attempt_bundle,row.runtime_sources.attempts.map(attempt=>({attempt_id:attempt.attempt_id,request_sha256:attempt.request.sha256,catalog_sha256:attempt.catalog_sha256})));
  assert.equal(result.derived_proof.partial_observations_sha256,hash(row.partial_observations));
  const {sha256,...proof}=result.derived_proof;assert.equal(sha256,hash(proof));
  assert.equal(row.request_sha256,null);assert.deepEqual(row,before);
 }
});
eachArm('第二attempt范围改变，即使catalog重签也拒绝',row=>{row.runtime_sources.attempts[1].catalog.scope.contact_id='10000000-0000-4000-8000-000000000001';rebind(row);});
eachArm('第二attempt原请求hash损坏拒绝',row=>{row.runtime_sources.attempts[1].request.sha256='0'.repeat(64);});
eachArm('第二attempt输入改写并重签仍拒绝',row=>changePayload(row,payload=>{payload.draft_text+='变更';}));
eachArm('第二attempt引用身份全自洽变更不得并集或只取首轮',row=>{
 const attempt=row.runtime_sources.attempts[1],old=attempt.catalog.entries[0].evidence_id,replacement='10000000-0000-4000-8000-000000000002';
 changePayload(row,payload=>{payload.evidence[0].evidence_id=replacement;payload.citation_policy.allowed_evidence_ids=payload.citation_policy.allowed_evidence_ids.map(id=>id===old?replacement:id);});
 attempt.catalog.entries[0].evidence_id=replacement;rebind(row);
});
eachArm('第二attempt来源正文改变并重签拒绝',row=>{changePayload(row,payload=>{payload.evidence[0].text+='新增资料';});});
eachArm('第二attempt来源状态失效不能复活',row=>{changePayload(row,payload=>{payload.evidence[0].status='deleted';});});
eachArm('第二attempt多出有效来源拒绝',row=>{changePayload(row,payload=>{payload.evidence.push({...payload.evidence[0],evidence_id:'10000000-0000-4000-8000-000000000003'});});});
eachArm('第二attempt catalog在响应后采集拒绝',row=>{const attempt=row.runtime_sources.attempts[1];attempt.catalog.captured_at=new Date(Date.parse(attempt.response_started_at)+1).toISOString();rebind(row);});
eachArm('第二attempt早于前次响应拒绝',row=>{const attempt=row.runtime_sources.attempts[1],time=row.runtime_sources.attempts[0].catalog.captured_at;attempt.catalog.captured_at=new Date(Date.parse(time)-1).toISOString();rebind(row);});
eachArm('调换完整attempt及trace顺序拒绝',row=>{row.runtime_sources.attempts.reverse();row.physical_attempts.reverse();});
eachArm('两次attempt重复身份拒绝',row=>{row.runtime_sources.attempts[1].attempt_id=row.runtime_sources.attempts[0].attempt_id;rebind(row);});
eachArm('PG锚不能改成另一次catalog',row=>{row.runtime_sources.persistence.catalog_sha256=row.runtime_sources.attempts[1].catalog_sha256;});
eachArm('PG锚必须在原catalog列表',row=>{row.runtime_sources.persistence.catalog_sha256='0'.repeat(64);});
eachArm('PG快照正文重签仍不得背离恒定来源',row=>{const persisted=row.runtime_sources.persistence;persisted.snapshot[0].evidence_text+='新资料';persisted.snapshot_sha256=hash(persisted.snapshot);});
eachArm('多attempt不能伪填最后一次single请求hash',row=>{row.request_sha256=row.runtime_sources.attempts[1].request.sha256;});
eachArm('取消终态不能借成功持久快照通过',row=>{row.terminal_status='cancelled';});
eachArm('缺失PG完整输出仍未定',row=>{delete row.runtime_sources.persistence.candidate_snapshot;});
eachArm('物理trace请求hash种类必须与对应原请求一致',row=>{row.physical_attempts[1].request_hash_kind='unknown';});
const laterMessages=row=>row.runtime_sources.attempts[1].request.body.messages;
const callFor=row=>row.arm==='new'?laterMessages(row).at(-2).content[0]:laterMessages(row).at(-2).tool_calls[0];
const resultFor=row=>row.arm==='new'?laterMessages(row).at(-1).content[0]:laterMessages(row).at(-1);
eachArm('错误tool结果call ID即使wire重签也拒绝',row=>{const result=resultFor(row);result[row.arm==='new'?'tool_use_id':'tool_call_id']='another-call';rebind(row);});
eachArm('额外tool结果不得压成一条成功过渡',row=>{laterMessages(row).push(structuredClone(laterMessages(row).at(-1)));rebind(row);});
eachArm('成功读取不能把拒绝观察当来源证明',row=>{const result=resultFor(row);result.content=row.arm==='new'?[{type:'text',text:'成功读取的新资料'}]:'成功读取的新资料';rebind(row);});
eachArm('未知工具即使伪用相同拒绝文字仍未定',row=>{const call=callFor(row);if(row.arm==='new')call.name='history_search';else call.function.name='history_search';rebind(row);});
eachArm('非法工具参数不得借无新增来源通过',row=>{const call=callFor(row);if(row.arm==='new')call.input.owner_id='arbitrary-owner';else {const args=JSON.parse(call.function.arguments);args.owner_id='arbitrary-owner';call.function.arguments=JSON.stringify(args);}rebind(row);});
eachArm('请求schema变化不能只凭不变payload通过',row=>{row.runtime_sources.attempts[1].request.body.tools=[];rebind(row);});
eachArm('物理trace供应方接收早于catalog拒绝',row=>{row.physical_attempts[1].supplier_received_at=new Date(Date.parse(row.runtime_sources.attempts[1].catalog.captured_at)-1).toISOString();});
eachArm('actual结果与最终输出冲突不能继续借实际拒绝观察',row=>{row.actual.result.candidates[0].text+='冲突';});
for(const original of originals)test('合法不同call ID及非固定路径仍支持，不硬编码capture随机值 / '+original.arm,()=>{
 const row=structuredClone(original),call=callFor(row),result=resultFor(row);
 call.id='a-new-observed-call';result[row.arm==='new'?'tool_use_id':'tool_call_id']=call.id;
 if(row.arm==='new')call.input.file_path='/different-denied-location';else{const args=JSON.parse(call.function.arguments);args.file_path='/different-denied-location';call.function.arguments=JSON.stringify(args);}
 rebind(row);assert.equal(audit(row).status,'verified');
});
test('新臂拒绝观察scope不能替换其它联系人',()=>{const row=structuredClone(originals.find(row=>row.arm==='new'));row.partial_observations.primary_tool_events[0].scope.contactId='10000000-0000-4000-8000-000000000004';notVerified(row);});
test('新臂多条工具观察不能隐去成功读取',()=>{const row=structuredClone(originals.find(row=>row.arm==='new'));row.partial_observations.primary_tool_events.push({tool:'read_file',outcome:'succeeded'});notVerified(row);});
test('旧臂缺失实际拒绝callback仍未定',()=>{const row=structuredClone(originals.find(row=>row.arm==='old'));row.partial_observations.events=row.partial_observations.events.filter(event=>event.type!=='actual_read_file_scope_denied');row.actual.partial_observations=structuredClone(row.partial_observations);notVerified(row);});
test('旧臂实际拒绝callback不能调序到调用前',()=>{const row=structuredClone(originals.find(row=>row.arm==='old')),events=row.partial_observations.events,start=events.find(event=>event.type==='tool_start_read_file');start.at_ms+=10;row.actual.partial_observations=structuredClone(row.partial_observations);notVerified(row);});
test('旧臂未知成功工具事件不能被忽略',()=>{const row=structuredClone(originals.find(row=>row.arm==='old')),events=row.partial_observations.events;events.push({type:'actual_read_file_succeeded',at_ms:events.at(-1).at_ms+1});row.actual.partial_observations=structuredClone(row.partial_observations);notVerified(row);});
eachArm('缺窄合同原观察沿用unsupported并保留全部attempt observations',row=>{delete row.partial_observations;});
eachArm('三次attempt即使复制恒定来源仍未支持',row=>{row.runtime_sources.attempts.push(structuredClone(row.runtime_sources.attempts[1]));row.physical_calls=3;});
for(const original of originals)test('派生证明绑定完整原观察，诊断值变更不复用旧摘要 / '+original.arm,()=>{
 const row=structuredClone(original),before=audit(row);row.partial_observations.first_event_ms+=0.01;
 if(row.arm==='old')row.actual.partial_observations=structuredClone(row.partial_observations);
 const after=audit(row);assert.equal(after.status,'verified');assert.equal(after.binding_sha256,before.binding_sha256);
 assert.notEqual(after.derived_proof.sha256,before.derived_proof.sha256);
});
function constantSourceState(row,change){
 for(const index of [0,1]){
  const payload=changePayload(row,payload=>change(payload.evidence[0]),index),attempt=row.runtime_sources.attempts[index];
  attempt.catalog.entries=attempt.catalog.entries.map((entry,i)=>({...entry,...payload.evidence[i],text_sha256:hash(payload.evidence[i].text)}));rebind(row,index);
 }
 row.runtime_sources.persistence.catalog_sha256=row.runtime_sources.attempts[0].catalog_sha256;
}
eachArm('全轮都带失效时间也不能把恒定误当有效来源',row=>constantSourceState(row,source=>{source.invalid_at=row.started_at;}));
eachArm('全轮都改成当前已确认状态不在窄合同内',row=>constantSourceState(row,source=>{source.timing.current_status='current_confirmed';}));
eachArm('未知来源元数据不能凭全轮相等就被静默接受',row=>constantSourceState(row,source=>{source.unknown_authorization={status:'revoked'};}));
test('旧臂未知callback clock不拼接成原调用顺序',()=>{const row=structuredClone(originals.find(row=>row.arm==='old'));row.partial_observations.clock='unknown';row.actual.partial_observations=structuredClone(row.partial_observations);notVerified(row);});
test('旧臂非对象event诚实未定，不能变成未处理TypeError',()=>{const row=structuredClone(originals.find(row=>row.arm==='old'));row.partial_observations.events.push(null);row.actual.partial_observations=structuredClone(row.partial_observations);notVerified(row);});
test('新臂业务观察的request ID不匹配拒绝',()=>{const row=structuredClone(originals.find(row=>row.arm==='new'));row.partial_observations.events[0].request_id='10000000-0000-4000-8000-000000000005';notVerified(row);});
test('新臂未知成功工具event不能借scope拒绝声明通过',()=>{const row=structuredClone(originals.find(row=>row.arm==='new'));row.partial_observations.events.push({...row.partial_observations.events.at(-1),type:'actual_history_search_succeeded'});notVerified(row);});
eachArm('首请求不得暗含未采集的先前工具成功资料',row=>{
 const first=row.runtime_sources.attempts[0].request.body,second=row.runtime_sources.attempts[1].request.body;
 const extra=row.arm==='new'?[{role:'assistant',content:[{type:'tool_use',id:'earlier-call',name:'history_search',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'earlier-call',content:[{type:'text',text:'未采集的新资料'}],is_error:false}]}]:[{role:'assistant',content:null,tool_calls:[{type:'function',id:'earlier-call',function:{name:'history_search',arguments:'{}'}}]},{role:'tool',tool_call_id:'earlier-call',content:'未采集的新资料'}];
 first.messages.push(...structuredClone(extra));second.messages.splice(-2,0,...structuredClone(extra));
 rebind(row,0);rebind(row,1);row.runtime_sources.persistence.catalog_sha256=row.runtime_sources.attempts[0].catalog_sha256;
});
