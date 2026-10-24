import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startReplyRuntimeHost,sendEvents,useTool} from './reply-runtime-support.mjs';
test('官方provider物理请求保留未知费用、独立缓存token并释放许可',{timeout:30000},async t=>{
  const host=await startReplyRuntimeHost(t,(_req,res,_requests,events)=>{
    events[0].message.usage.cache_read_input_tokens=7;
    useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次目的',citation_ids:['40000000-0000-4000-8000-000000000001'],risk_notes:[]}]});
    sendEvents(res,events);
  });
  await host.request('/loop',{});
  assert.equal(host.requests.length,1);
  const status=await host.request('/health');
  assert.equal(status.records[0].cost.status,'unknown');
  assert.equal(status.records[0].cost.amount,null);
  assert.deepEqual(status.records[0].usage,{input_tokens:19,output_tokens:9,cache_read_tokens:7,cache_write_tokens:0});
  assert.equal(status.records.length,1);assert.equal(status.permits,0);
});
test('官方Agent完整序列化预算先预留，超预算不出站、不生成台账尝试',{timeout:30000},async t=>{
  const host=await startReplyRuntimeHost(t,(_req,res,_requests,events)=>{
    useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次目的',citation_ids:['40000000-0000-4000-8000-000000000001'],risk_notes:[]}]});sendEvents(res,events);
  });
  await assert.rejects(host.request('/loop',{exceeded:true}));
  assert.equal(host.requests.length,0);
  assert.equal((await host.request('/health')).reservations.length,0);
  const result=await host.request('/loop',{});
  const status=await host.request('/health');
  assert.equal(status.reservations.length,1);assert.equal(status.records.length,1);
  assert.equal(status.reservations[0].outcome,'pending');
  assert.equal(status.reservations[0].dispatch,'authorized_unconfirmed');
  assert.equal(status.records[0].dispatch,'http_accepted');
  assert.equal(status.records[0].attempt_id,status.reservations[0].attempt_id);
  assert.equal(status.records[0].permit_id,status.reservations[0].permit_id);
  assert.equal(result.budgets[0].serialized_bytes,Buffer.byteLength(JSON.stringify(host.requests[0].body)));
  assert.deepEqual(result.budgets[0].covered_components,['messages','system','tools','controls']);
  assert.equal(status.permits,0);
});
test('官方Agent输出工具成功即结束，不追加语义复核调用',{timeout:30000},async t=>{
  const host=await startReplyRuntimeHost(t,(_req,res,_requests,events)=>{
    useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次目的',citation_ids:['40000000-0000-4000-8000-000000000001'],risk_notes:[]}]});
    sendEvents(res,events);
  });
  const result=await host.request('/loop',{});
  assert.equal(result.candidates[0].text,'明天见');
  assert.equal(host.requests.length,1);
  const status=await host.request('/health');
  assert.equal(status.records.length,1);assert.equal(status.permits,0);
});
test('官方Agent坏输出结构直接拒绝，不让模型隐式修复重试',{timeout:30000},async t=>{
  const host=await startReplyRuntimeHost(t,(_req,res,_requests,events)=>{
    useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'缺少依据'}]});sendEvents(res,events);
  });
  await assert.rejects(host.request('/loop',{}),/reply_candidates_rejected/);
  assert.equal(host.requests.length,1);
  assert.equal((await host.request('/health')).permits,0);
});
test('预算发送前拒绝且超时真实调用记账未知usage不重试',{timeout:30000},async t=>{
  const host=await startReplyRuntimeHost(t,()=>{});
  await assert.rejects(host.request('/loop',{exceeded:true}),/reply_budget_exceeded/);
  assert.equal(host.requests.length,0);
  await assert.rejects(host.request('/loop',{deadline_ms:100}));
  assert.equal(host.requests.length,1);
  const status=await host.request('/health');
  assert.equal(status.records.length,1);assert.equal(status.records[0].usage,null);
  assert.equal(status.records[0].outcome,'cancelled');assert.equal(status.permits,0);
});
for(const status of [401,429,500])test(`官方Adapter的HTTP ${status}保留真实响应观测且不重试`,{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:'合成错误'}}));});
 await assert.rejects(host.request('/loop',{}));
 const state=await host.request('/health');
 assert.equal(host.requests.length,1);assert.equal(state.reservations.length,1);assert.equal(state.records.length,1);
 assert.equal(state.records[0].dispatch,'response_observed');assert.equal(state.records[0].outcome,'failed');
 assert.equal(state.records[0].usage,null);assert.equal(state.records[0].cost.amount,null);assert.equal(state.permits,0);
});
test('官方Adapter真实HTTP上下文超限保留原错误合同和一次物理调用回执',{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(_req,res)=>{
  res.writeHead(400,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{type:'invalid_request_error',code:'context_length_exceeded',message:'合成供应商私密错误，不得回显'}}));
 });
 await assert.rejects(host.request('/loop',{}),error=>error.message==='{"error":"provider_context_limit"}');
 const state=await host.request('/health');
 assert.equal(host.requests.length,1);assert.equal(state.reservations.length,1);assert.equal(state.records.length,1);
 assert.equal(state.records[0].attempt_id,state.reservations[0].attempt_id);
 assert.equal(state.records[0].permit_id,state.reservations[0].permit_id);
 assert.equal(state.records[0].dispatch,'response_observed');assert.equal(state.records[0].outcome,'failed');
 assert.equal(state.records[0].usage,null);assert.equal(state.records[0].cost.amount,null);assert.equal(state.permits,0);
});
test('官方Adapter真实SSE上下文超限按标准错误码拒绝，不复制供应商正文或重试',{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(_req,res)=>sendEvents(res,[{type:'error',error:{type:'invalid_request_error',code:'context_length_exceeded',message:'合成流内私密错误，不得回显'}}]));
 await assert.rejects(host.request('/loop',{}),error=>error.message==='{"error":"provider_context_limit"}');
 const state=await host.request('/health');
 assert.equal(host.requests.length,1);assert.equal(state.reservations.length,1);assert.equal(state.records.length,1);
 assert.equal(state.records[0].dispatch,'http_accepted');assert.equal(state.records[0].outcome,'failed');
 assert.equal(state.records[0].usage,null);assert.equal(state.records[0].cost.amount,null);assert.equal(state.permits,0);
});
test('官方Adapter非上下文400保持普通失败，不能凭本地包装文字冒充超限',{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(_req,res)=>{
  res.writeHead(400,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{type:'invalid_request_error',code:'invalid_parameter',message:'合成非法参数 provider_context_limit'}}));
 });
 await assert.rejects(host.request('/loop',{}),error=>error.message==='{"error":"reply_generation_failed"}');
 const state=await host.request('/health');
 assert.equal(host.requests.length,1);assert.equal(state.records.length,1);assert.equal(state.records[0].dispatch,'response_observed');assert.equal(state.permits,0);
});
test('官方Adapter连接中断保留发送未知，不猜测HTTP响应或重放',{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(req)=>req.socket.destroy());
 await assert.rejects(host.request('/loop',{}));
 const state=await host.request('/health');
 assert.equal(host.requests.length,1);assert.equal(state.records.length,1);
 assert.equal(state.records[0].dispatch,'authorized_unconfirmed');assert.equal(state.records[0].usage,null);assert.equal(state.permits,0);
});
test('同轮工具前后各物理请求使用独立attempt、共享整轮permit，调用上限阻止下一次HTTP',{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(_req,res,requests,events)=>{
  if(requests.length%2===1)useTool(events,'conversation_search',{query:'合成'});
  else useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次目的',citation_ids:['40000000-0000-4000-8000-000000000001'],risk_notes:[]}]});
  sendEvents(res,events);
 });
 await host.request('/loop',{withTool:true});
 const state=await host.request('/health');
 assert.equal(host.requests.length,2);assert.equal(state.reservations.length,2);assert.equal(state.records.length,2);
 assert.equal(state.records[0].permit_id,state.records[1].permit_id);
 assert.notEqual(state.records[0].attempt_id,state.records[1].attempt_id);
 assert.equal(state.permits,0);
 await assert.rejects(host.request('/loop',{withTool:true,physical_limit:1}),/reply_budget_exceeded/);
 assert.equal(host.requests.length,3);assert.equal((await host.request('/health')).permits,0);
});
test('工具后资格撤销阻止下次物理请求并保留已发生调用回执',{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(_req,res,_requests,events)=>{useTool(events,'conversation_search',{query:'合成'});sendEvents(res,events);});
 await assert.rejects(host.request('/loop',{withTool:true,revokeAfterTool:true}));
 const state=await host.request('/health');assert.equal(host.requests.length,1);assert.equal(state.records.length,1);assert.equal(state.permits,0);
});
test('官方Agent scope按实际Skill读取生成回执，持久提交先于scope清理',{timeout:30000},async t=>{
 const host=await startReplyRuntimeHost(t,(_req,res,requests,events)=>{
  if(requests.length===1)useTool(events,'read_file',{file_path:'/notalone/reply-skills/synthetic/SKILL.md'});
  else useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'当前目的',citation_ids:['40000000-0000-4000-8000-000000000001'],risk_notes:[]}]});
  sendEvents(res,events);
 });
 await host.request('/loop',{withSkill:true});
 const state=await host.request('/health');assert.equal(host.requests.length,2);assert.equal(state.skillChecks.length,1);
 const check=state.skillChecks[0];assert.equal(check.open_at_commit,true);assert.equal(check.closed_after,true);
 assert.equal(check.use.version_id,'60000000-0000-4000-8000-000000000001');assert.equal(check.use.selection_method,'user');
 assert.equal(state.permits,0);
});
