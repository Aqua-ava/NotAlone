import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBlindPacket,digest,verifyBlindPacket,bindSubmittedReview} from '../experiments/reply-blind-packet.mjs';
import {auditReplyRuntimeSources} from '../src/diagnostics/reply-comparison-sources.ts';
const capture=JSON.parse(await readFile(new URL('./fixtures/reply-blind-packet-pilot.json',import.meta.url),'utf8'));
const dataset=JSON.parse(await readFile(new URL('./fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'));
const seed='91'.repeat(32);
// 为新增反例保持原DTO、PG快照及已有摘要自洽；这不是新的模型采集。
function editOutput(capture,edit,index=0){
 const changed=structuredClone(capture),row=changed.records[index];
 edit(row.output);row.actual.result=structuredClone(row.output);
 const persistence=row.runtime_sources.persistence;
 persistence.output=structuredClone(row.output);persistence.output_sha256=digest(row.output);
 persistence.candidate_snapshot=row.output.candidates.map(candidate=>({...structuredClone(candidate),owner_id:row.scope.owner_id,contact_id:row.scope.contact_id,conversation_binding_id:row.scope.conversation_binding_id,reply_request_id:row.output.reply_request_id}));
 row.deterministic_checks.output_sha256=digest(row.output);row.deterministic_checks.runtime_sources_sha256=digest(row.runtime_sources);
 return changed;
}
// SDK envelope 反例只重签给定合成请求；不改变模型材料，不产生实际HTTP。
function editSdkRequest(edit,identity){
 const changed=structuredClone(capture),row=changed.records[0],attempt=row.runtime_sources.attempts[0];
 edit(attempt.request.body);
 attempt.request.sha256=digest(attempt.request.body);row.request_sha256=attempt.request.sha256;attempt.catalog.request_sha256=attempt.request.sha256;
 attempt.catalog_sha256=digest(attempt.catalog);row.runtime_sources.persistence.catalog_sha256=attempt.catalog_sha256;
 row.physical_attempts[0].request=structuredClone(attempt.request.body);row.physical_attempts[0].request_sha256=attempt.request.sha256;row.physical_attempts[0].source_catalog=structuredClone(attempt.catalog);row.physical_attempts[0].source_catalog_sha256=attempt.catalog_sha256;
 row.deterministic_checks.runtime_sources_sha256=digest(row.runtime_sources);
 return identity===undefined?changed:editOutput(changed,output=>output.candidates[0].basis='原SDK调用 '+identity);
}
test('实际两臂完整采集可交付风险、分段及引用原文，且别名不暴露旧新实现',()=>{
 const {visible,binding}=createBlindPacket({capture,dataset,seed});
 assert.equal(visible.items.length,2);
 assert.deepEqual(new Set(visible.items.map(item=>item.label)),new Set(['A','B']));
 for(const item of visible.items){
  assert.equal(item.candidates[0].text,'本机供应商响应已被两臂消费');
  assert.deepEqual(item.candidates[0].risk_notes,['合成验收：仅按本次意图表达，不补充未提供事实。']);
  assert.equal(item.candidates[0].messages[0].text,item.candidates[0].text);
  assert.equal(item.sources.find(source=>source.source_id===item.candidates[0].citation_ids[0]).text,'这次明确拒绝邀请');
  assert.deepEqual(item.input.unknowns,['对方情绪']);
  assert.deepEqual(item.input.allowed_changes,['措辞自然，语义保持']);
  const privateRow=binding.items.find(row=>row.blind_id===item.blind_id);
  assert.ok(privateRow.reporter_subject_sha256.match(/^[a-f0-9]{64}$/));
  assert.ok(privateRow.raw_output_sha256.match(/^[a-f0-9]{64}$/));
 }
 const rendered=JSON.stringify(visible);
 for(const hidden of ['"arm"','input_budget','context_receipt','provider','runtime_sources','reply_request_id','message_id','candidate_id','deepseek','"order"','"started_at"'])assert.ok(!rendered.includes(hidden),hidden);
 assert.equal(visible.real_model_quality_verified,false);
 assert.equal(visible.production_switch_approved,false);
});
test('官方DeepSeek冻结采集保留真实来源标记，但不认证质量或切换',()=>{
 const vendor=structuredClone(capture);vendor.evidence_kind='official_deepseek_full_comparison_v1';
 const {visible,binding}=createBlindPacket({capture:vendor,dataset,seed});
 assert.equal(visible.fake_supplier_response,false);
 assert.equal(visible.evidence_origin,'official_deepseek_full_comparison');
 assert.equal(visible.real_model_quality_verified,false);
 assert.equal(visible.production_switch_approved,false);
 assert.equal(binding.fake_supplier_response,false);
 assert.equal(binding.evidence_origin,'official_deepseek_full_comparison');
 assert.equal(binding.internal_consistency_only,true);
 assert.equal(verifyBlindPacket({visible,binding,capture:vendor,dataset}).status,'verified_internal_consistency_only');
});
test('未声明的采集来源不能被当作供应商证据',()=>{
 const unknown=structuredClone(capture);unknown.evidence_kind='unverified_vendor_claim';
 assert.throws(()=>createBlindPacket({capture:unknown,dataset,seed}),/synthetic_capture_required/);
});
test('同组重复候选ID不能经中性别名掩盖',()=>{
 const bad=editOutput(capture,output=>output.candidates.push(structuredClone(output.candidates[0])));
 assert.throws(()=>createBlindPacket({capture:bad,dataset,seed}),/duplicate_candidate_identity/);
});
test('整capture身份：本联系人ID不能从候选依据进入可见包',()=>{
 const changed=editOutput(capture,output=>output.candidates[0].basis='本联系人记录 '+capture.records[0].scope.contact_id);
 const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
 assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
});
test('整capture身份：原blind_id不能从候选依据进入可见包',()=>{
 const changed=editOutput(capture,output=>output.candidates[0].basis='本轮原始样本 '+capture.records[0].blind_id);
 const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
 assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
});
test('整capture身份：另一臂请求ID不能从当前候选依据进入可见包',()=>{
 const changed=editOutput(capture,output=>output.candidates[0].basis='另一记录 '+capture.records[1].output.reply_request_id);
 const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
 assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
});
test('整capture身份：普通UUID形状的非身份正文原样保留',()=>{
 const ordinary='efa0291b-62f8-49c6-bd97-55d567993f30';
 const changed=editOutput(capture,output=>output.candidates[0].basis='用户正文中的示例编号 '+ordinary);
 const {visible}=createBlindPacket({capture:changed,dataset,seed});
 assert.ok(visible.items.some(item=>item.candidates[0].basis==='用户正文中的示例编号 '+ordinary));
});
test('整capture身份：跨记录owner、binding、attempt及已声明permit和ledger身份都受保护',()=>{
 const withMetadata=structuredClone(capture);
 withMetadata.records[1].permit={permit_id:'permit-05-review-probe'};
 withMetadata.records[1].ledger={id:'ledger-05-review-probe'};
 for(const identity of [withMetadata.records[1].scope.owner_id,withMetadata.records[1].scope.conversation_binding_id,withMetadata.records[1].runtime_sources.attempts[0].attempt_id,'permit-05-review-probe','ledger-05-review-probe']){
  const changed=editOutput(withMetadata,output=>output.candidates[0].basis='本次依据 '+identity);
  assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
 }
});
test('整capture身份：来源选择说明含另一记录身份时也拒绝，完整来源审计仍自洽',()=>{
 const identity=capture.records[1].scope.owner_id;
 const changed=editSource((sources,entries)=>{sources[0].selection_reason='原来源说明 '+identity;entries[0].selection_reason='原来源说明 '+identity;});
 const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
 assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
});
test('SDK身份：Anthropic content tool_use.id不能进入依据，自洽来源审计仍verified',()=>{
 const identity='toolu_declared_call_05';
 const changed=editSdkRequest(body=>body.messages.push({role:'assistant',content:[{type:'tool_use',id:identity,name:'synthetic_read',input:{}}]}),identity);
 const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
 assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
});
test('SDK身份：Anthropic tool_result.tool_use_id不能进入依据，自洽来源审计仍verified',()=>{
 const identity='toolu_declared_result_05';
 const changed=editSdkRequest(body=>body.messages.push({role:'user',content:[{type:'tool_result',tool_use_id:identity,content:'synthetic only'}]}),identity);
 const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
 assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
});
test('SDK身份：OpenAI tool_calls.id与tool_call_id对称拒绝，已有调用保护不回退',()=>{
 for(const [identity,message] of [['call_declared_openai_05',{role:'assistant',content:null,tool_calls:[{id:'call_declared_openai_05',type:'function',function:{name:'synthetic_read',arguments:'{}'}}]}],['call_declared_result_05',{role:'tool',tool_call_id:'call_declared_result_05',content:'synthetic only'}]]){
  const changed=editSdkRequest(body=>body.messages.push(message),identity);
  assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
 }
});
test('SDK响应身份：已记录request字段及响应header请求ID不能进入依据',()=>{
 const variants=[['req_recorded_sdk_05',{_request_id:'req_recorded_sdk_05'}],['req_recorded_header_05',{'request-id':'req_recorded_header_05'}],['req_recorded_x_header_05',{'X-Request-Id':'req_recorded_x_header_05'}],['req_existing_field_05',{request_id:'req_existing_field_05'}]];
 const accepted=variants.map(([identity,metadata])=>{
  const recorded=structuredClone(capture);recorded.records[1].actual.response_metadata=metadata;
  const changed=editOutput(recorded,output=>output.candidates[0].basis='原SDK响应 '+identity);
  try{createBlindPacket({capture:changed,dataset,seed});return identity;}catch(error){assert.match(String(error),/raw_identity_in_semantic_text/);return null;}
 });
 assert.deepEqual(accepted,[null,null,null,null]);
});
test('SDK响应身份：Anthropic与OpenAI类型明确的响应envelope.id不能跨记录进入依据',()=>{
 const variants=[{type:'message',role:'assistant',id:'msg_recorded_anthropic_05',content:[]},{object:'chat.completion',id:'chatcmpl_recorded_openai_05',choices:[]}];
 for(const response of variants){
  const recorded=structuredClone(capture);recorded.records[1].actual.sdk_response=response;
  const changed=editOutput(recorded,output=>output.candidates[0].basis='原SDK响应 '+response.id);
  const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
  assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
  assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/raw_identity_in_semantic_text/);
 }
});
test('SDK身份：真实声明不外露时合法，普通术语、非身份UUID及正文JSON保持原文',()=>{
 const changed=editSdkRequest(body=>body.messages.push({role:'assistant',content:[{type:'tool_use',id:'toolu_present_without_echo_05',name:'synthetic_read',input:{}}]},{role:'assistant',content:null,tool_calls:[{id:'call_present_without_echo_05',type:'function',function:{name:'synthetic_read',arguments:'{}'}}]}));
 const text='tool_use、tool_result、tool_calls、tool_call_id、synthetic_read 都是术语。示例正文 {"tool_use_id":"efa0291b-62f8-49c6-bd97-55d567993f30"}';
 const withText=editOutput(changed,output=>output.candidates[0].basis=text);
 const {visible}=createBlindPacket({capture:withText,dataset,seed});
 assert.ok(visible.items.some(item=>item.candidates[0].basis===text));
 assert.ok(!JSON.stringify(visible).includes('toolu_present_without_echo_05'));
 assert.ok(!JSON.stringify(visible).includes('call_present_without_echo_05'));
});
test('两臂都可呈现多候选、有序分段、全部风险提示及引用，不截成四字段',()=>{
 let changed=structuredClone(capture);
 for(let index=0;index<2;index++)changed=editOutput(changed,output=>{
  output.candidates[0].text='第一段。\n\n第二段。';
  output.candidates[0].messages=[{message_id:'23ab6623-5600-4444-8222-2555d25cd320',text:'第一段。'},{message_id:'23ab6623-5600-4444-8222-2555d25cd321',text:'第二段。'}];
  output.candidates[0].risk_notes.push('还不清楚对方情绪。');
  const another=structuredClone(output.candidates[0]);another.candidate_id='23ab6623-5600-4444-8222-2555d25cd322';another.text='第三段。';another.messages=[{message_id:'23ab6623-5600-4444-8222-2555d25cd323',text:'第三段。'}];output.candidates.push(another);
 },index);
 const {visible}=createBlindPacket({capture:changed,dataset,seed});
 for(const item of visible.items){
  assert.equal(item.candidates.length,2);
  assert.deepEqual(item.candidates[0].messages.map(message=>message.text),['第一段。','第二段。']);
  assert.deepEqual(item.candidates[0].risk_notes,['合成验收：仅按本次意图表达，不补充未提供事实。','还不清楚对方情绪。']);
  assert.equal(item.candidates[1].text,'第三段。');
 }
});
test('遗漏风险、分段、来源原文或插入运行身份的可见包不能沿用绑定',()=>{
 const packet=createBlindPacket({capture,dataset,seed});
 for(const edit of [p=>p.items[0].candidates[0].risk_notes=[],p=>p.items[0].candidates[0].messages=[],p=>p.items[0].sources[0].text='改写来源',p=>p.items[0].provider='实现身份']){
  const visible=structuredClone(packet.visible);edit(visible);
  assert.throws(()=>verifyBlindPacket({...packet,visible,capture,dataset}),/visible_packet_changed/);
 }
});
test('原始DTO语义变化及隐藏预算元数据变化都更新评审对象，旧包不可复用',()=>{
 const packet=createBlindPacket({capture,dataset,seed});
 for(const changed of [editOutput(capture,output=>output.candidates[0].risk_notes.push('新增已知风险。')),editOutput(capture,output=>output.input_budget.measurement_id='another-measurement')]){
  const next=createBlindPacket({capture:changed,dataset,seed});
  const changedId=packet.binding.items.find(row=>row.arm===capture.records[0].arm).blind_id;
  assert.notEqual(packet.visible.items.find(item=>item.blind_id===changedId).review_subject_sha256,next.visible.items.find(item=>item.blind_id===changedId).review_subject_sha256);
  assert.notEqual(packet.binding.items.find(row=>row.blind_id===changedId).raw_output_sha256,next.binding.items.find(row=>row.blind_id===changedId).raw_output_sha256);
  assert.throws(()=>verifyBlindPacket({...packet,capture:changed,dataset}),/visible_packet_changed/);
 }
});
test('未知或未呈现的额外语义必须明确拒绝，不能静默截断',()=>{
 for(const edit of [output=>output.explanation='额外有意义的输出',output=>output.candidates[0].qualification='只在周末适用',output=>output.candidates[0].messages[0].condition='请先确认',output=>output.basis_changes=[{reason:'原依据已删除'}]]){
  assert.throws(()=>createBlindPacket({capture:editOutput(capture,edit),dataset,seed}),/complete_output|complete_candidate|complete_message|basis_changes_semantics_unsupported/);
 }
});
test('重复消息、缺失引用及未绑定来源不能作为正常评审项',()=>{
 for(const edit of [output=>{const candidate=output.candidates[0];candidate.messages.push(structuredClone(candidate.messages[0]));candidate.text=candidate.messages.map(message=>message.text).join('\n\n');},output=>output.candidates[0].citation_ids=['23ab6623-5600-4444-8222-2555d25cd320']]){
  assert.throws(()=>createBlindPacket({capture:editOutput(capture,edit),dataset,seed}),/complete_message_identity|complete_candidate_structure|context_receipt_evidence/);
 }
 const changed=structuredClone(capture);changed.records[0].runtime_sources.attempts[0].catalog.entries.push(structuredClone(changed.records[0].runtime_sources.attempts[0].catalog.entries[0]));
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/catalog_hash/);
});
test('不完整成对、重复原始blindID及失败记录会整体拒绝而非缩分母',()=>{
 for(const edit of [value=>value.records.pop(),value=>value.records[1].blind_id=value.records[0].blind_id,value=>value.records[0].actual.status='failed']){
  const changed=structuredClone(capture);edit(changed);
  assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/complete_pair_required|record_identity|non_success_requires_separate_failure_review/);
 }
});
test('重排采集数组不泄露原执行顺序；私密种子可重现中性顺序',()=>{
 const packet=createBlindPacket({capture,dataset,seed});
 const reversed=structuredClone(capture);reversed.records.reverse();
 const next=createBlindPacket({capture:reversed,dataset,seed});
 assert.deepEqual(next.visible,packet.visible);
 assert.equal(verifyBlindPacket({...packet,capture,dataset}).status,'verified_internal_consistency_only');
});
test('原样接收评审者的未知评分，用私有清单恢复reporter绑定而不编造身份或分数',()=>{
 const packet=createBlindPacket({capture,dataset,seed}),item=packet.visible.items[0];
 const submitted={review_id:'test-unknown-review',blind_id:item.blind_id,subject_sha256:item.review_subject_sha256,reviewer_id:'independent-test-reviewer',reviewer_type:'agent',reviewer_model:null,reviewer_version:null,independent:true,blinded:true,candidates:item.candidates.map(candidate=>({candidate:candidate.candidate,basis:'这里只验证别名恢复，尚未实际评分。',scores:{evidence_correctness:null,intent_preservation:null,no_unsupported_content:null,relationship_fit:null,chinese_usability:null},severe_errors:{false_fact:null,wrong_person:null,unsupported_commitment:null}}))};
 const bound=bindSubmittedReview({...packet,capture,dataset,review:submitted});
 const privateRow=packet.binding.items.find(row=>row.blind_id===item.blind_id);
 assert.equal(bound.blind_id,privateRow.original_blind_id);
 assert.equal(bound.subject_sha256,privateRow.reporter_subject_sha256);
 assert.equal(bound.candidates[0].candidate_id,privateRow.aliases.candidates[0].original);
 assert.deepEqual(bound.candidates[0].scores,submitted.candidates[0].scores);
 assert.equal(bound.reviewer_model,null);
 assert.throws(()=>bindSubmittedReview({...packet,capture,dataset,review:{...submitted,subject_sha256:'0'.repeat(64)}}),/submitted_review_binding/);
 assert.throws(()=>bindSubmittedReview({...packet,capture,dataset,review:{...submitted,independent:false}}),/submitted_review_binding/);
});
test('报告器subject与独立Python规范JSON计算的冻结结果一致',()=>{
 const {binding}=createBlindPacket({capture,dataset,seed});
 assert.equal(binding.items.find(row=>row.arm==='new').reporter_subject_sha256,'d10954276d68814dba9dab6d4e650d286a33299e5d6f7c0c25c9716afaceaad2');
 assert.equal(binding.items.find(row=>row.arm==='old').reporter_subject_sha256,'a63dfb87aa150391a9648c99b5c498dcffc6e37560f3eabb754d5a4cd121b461');
});
// 改写实际SDK请求中的唯一业务payload并重绑现有采集摘要，不伪称新运行。
function editSource(edit){
 const changed=structuredClone(capture),row=changed.records[0],attempt=row.runtime_sources.attempts[0];
 const block=attempt.request.body.messages[0].content[0],payload=JSON.parse(block.text);
 edit(payload.evidence,attempt.catalog.entries);block.text=JSON.stringify(payload);
 attempt.request.sha256=digest(attempt.request.body);row.request_sha256=attempt.request.sha256;attempt.catalog.request_sha256=attempt.request.sha256;
 attempt.catalog_sha256=digest(attempt.catalog);row.runtime_sources.persistence.catalog_sha256=attempt.catalog_sha256;
 row.deterministic_checks.runtime_sources_sha256=digest(row.runtime_sources);
 return changed;
}
test('即使动态来源审计自洽，未识别来源语义仍须拒绝而非从展示静默删除',()=>{
 const changed=editSource((sources,entries)=>{sources[0].semantic_warning='只在周六适用';entries[0].semantic_warning='只在周六适用';});
 const row=changed.records[0],member=dataset.cases.find(member=>member.case_id===row.case_id);
 assert.equal(auditReplyRuntimeSources(member,row,row.output).status,'verified');
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/source_fields_unknown/);
});
test('完整自洽摘要不能使重复来源ID变成合法来源',()=>{
 const changed=editSource((sources,entries)=>{sources[0].evidence_id=sources[1].evidence_id;entries[0].evidence_id=entries[1].evidence_id;});
 assert.throws(()=>createBlindPacket({capture:changed,dataset,seed}),/payload_sources/);
});
test('消息ID在不同候选内复用保留合法分组语义，私有别名映射按候选区分',()=>{
 const changed=editOutput(capture,output=>{const another=structuredClone(output.candidates[0]);another.candidate_id='23ab6623-5600-4444-8222-2555d25cd322';output.candidates.push(another);});
 const packet=createBlindPacket({capture:changed,dataset,seed}),row=packet.binding.items.find(row=>row.arm===capture.records[0].arm);
 assert.equal(row.aliases.messages[0].original,row.aliases.messages[1].original);
 assert.notEqual(row.aliases.messages[0].candidate,row.aliases.messages[1].candidate);
 assert.notEqual(row.aliases.messages[0].alias,row.aliases.messages[1].alias);
});
