import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateExplorationOutput} from '../src/exploration-runtime.ts';
const context={owner_id:'10000000-0000-4000-8000-000000000001',contact_id:'20000000-0000-4000-8000-000000000001',request_id:'30000000-0000-4000-8000-000000000001',input:{scene:'initiate_conversation'},evidence:[{evidence_id:'source-a'}],skill:null};
const output=()=>({understanding:'对方提出邀约，用户尚未确认意愿',ambiguities:[],citation_ids:['source-a'],options:[{intent:' 接受 ',label:'接受',reason:'愿意参与时适用',citation_ids:['source-a'],recommended:true,pause:false},{intent:'保留',label:'保留',reason:'暂未决定时适用',citation_ids:[],recommended:false,pause:true}],question:null,current_step:'先明确意愿',tradeoffs:[]});
test('探索保留未确认意愿并校验当前来源、不同方向与换组',()=>{
 assert.equal(validateExplorationOutput(output(),context).options[0].intent,'接受');
 const foreign=output();foreign.options[0].citation_ids=['other-contact'];assert.throws(()=>validateExplorationOutput(foreign,context));
 const repeated=output();repeated.options[1].intent='接受';assert.throws(()=>validateExplorationOutput(repeated,context));
 assert.throws(()=>validateExplorationOutput(output(),{...context,previous_intents:['接受','保留']}));
});
import {startExplorationRuntimeHost,sendEvents,useTool} from './exploration-runtime-support.mjs';
test('官方profile自动策略选择和探索分别一次，共用原request身份及真实共享宿主许可',{timeout:30000},async t=>{
 const host=await startExplorationRuntimeHost(t,(_req,res,requests,events)=>{
  if(requests.length===1)useTool(events,'ExplorationSkillSelection',{version_id:'60000000-0000-4000-8000-000000000001'});
  else useTool(events,'ExplorationOutput',output());sendEvents(res,events);
 });
 const request_id='30000000-0000-4000-8000-000000000099';
 const result=await host.request('/run',{auto:true,request_id});
 assert.equal(result.selected,'60000000-0000-4000-8000-000000000001');assert.equal(result.result.options[0].intent,'接受');
 assert.equal(host.requests.length,2);
 assert.deepEqual(host.requests.map(r=>r.body.tools.map(t=>t.name)),[['ExplorationSkillSelection'],['ExplorationOutput']]);
 const state=await host.request('/health');assert.equal(state.records.length,2);assert.ok(state.records.every(r=>r.request_id===request_id&&r.cost.amount===null));
 assert.equal(state.permits.foregroundActive,false);
 assert.match(JSON.stringify(host.requests[1].body),/合成策略只作本轮辅助/);
});
for(const mode of [{name:'禁用策略',body:{}},{name:'空自动目录',body:{auto:true,empty:true}},{name:'显式静态Skill',body:{skill:{version_id:'60000000-0000-4000-8000-000000000001',content:'静态合成正文'}}}])test(`官方探索${mode.name}只调用一次且不提供资源或历史工具`,{timeout:30000},async t=>{
 const host=await startExplorationRuntimeHost(t,(_req,res,_requests,events)=>{useTool(events,'ExplorationOutput',output());sendEvents(res,events);});
 const result=await host.request('/run',mode.body);assert.equal(result.selected,null);assert.equal(host.requests.length,1);
 assert.deepEqual(host.requests[0].body.tools.map(t=>t.name),['ExplorationOutput']);
 assert.equal((await host.request('/health')).permits.foregroundActive,false);
});
for(const forbidden of ['read_file','conversation_search','send_message'])test(`官方探索拒绝${forbidden}且没有修复重试`,{timeout:30000},async t=>{
 const host=await startExplorationRuntimeHost(t,(_req,res,_requests,events)=>{useTool(events,forbidden,{});sendEvents(res,events);});
 await assert.rejects(host.request('/run',{}));assert.equal(host.requests.length,1);const state=await host.request('/health');assert.equal(state.records[0].outcome,'failed');assert.equal(state.permits.foregroundActive,false);
});
test('官方探索拒绝同次响应多个输出工具，不追加调用',{timeout:30000},async t=>{
 const host=await startExplorationRuntimeHost(t,(_req,res,_requests,events)=>{
  useTool(events,'ExplorationOutput',output());events.splice(4,0,{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'second',name:'ExplorationOutput',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:JSON.stringify(output())}},{type:'content_block_stop',index:1});sendEvents(res,events);
 });
 await assert.rejects(host.request('/run',{}));assert.equal(host.requests.length,1);assert.equal((await host.request('/health')).records[0].outcome,'failed');
});
test('官方探索缺少结构化输出只失败，不追加修复或语义复核',{timeout:30000},async t=>{
 const host=await startExplorationRuntimeHost(t,(_req,res,_requests,events)=>sendEvents(res,events));
 await assert.rejects(host.request('/run',{}));assert.equal(host.requests.length,1);assert.equal((await host.request('/health')).permits.foregroundActive,false);
});
test('完整序列化预算与Skill撤权均在物理发送前拒绝',{timeout:30000},async t=>{
 const host=await startExplorationRuntimeHost(t,(_req,res,_requests,events)=>{useTool(events,'ExplorationOutput',output());sendEvents(res,events);});
 await assert.rejects(host.request('/run',{exceeded:true}));await assert.rejects(host.request('/run',{invalidSkill:true}));
 assert.equal(host.requests.length,0);const state=await host.request('/health');assert.equal(state.reservations.length,0);assert.equal(state.permits.foregroundActive,false);
});
test('响应等待中来源撤销拒绝晚结果且真实SDK无追加调用',{timeout:30000},async t=>{
 let host;host=await startExplorationRuntimeHost(t,async(_req,res,_requests,events)=>{await host.request('/revoke');useTool(events,'ExplorationOutput',output());sendEvents(res,events);});
 await assert.rejects(host.request('/run',{}),/exploration_context_invalidated/);assert.equal(host.requests.length,1);assert.equal((await host.request('/health')).permits.foregroundActive,false);
});
test('真实在途取消排空SDK后才结算共享前台许可',{timeout:30000},async t=>{
 let entered;const ready=new Promise(resolve=>entered=resolve);
 const host=await startExplorationRuntimeHost(t,()=>entered());
 const active=host.request('/run',{});await ready;assert.equal((await host.request('/health')).permits.foregroundActive,true);
 await host.request('/cancel');await assert.rejects(active);const state=await host.request('/health');assert.equal(host.requests.length,1);assert.equal(state.records.length,1);assert.equal(state.records[0].outcome,'cancelled');assert.equal(state.records[0].usage,null);assert.equal(state.records[0].cost.amount,null);assert.equal(state.permits.foregroundActive,false);
});
test('真实SDK超时仅一次调用，未知token/费用不伪零',{timeout:30000},async t=>{
 const host=await startExplorationRuntimeHost(t,()=>{});
 await assert.rejects(host.request('/run',{deadline_ms:100}));const state=await host.request('/health');assert.equal(host.requests.length,1);assert.equal(state.records[0].usage,null);assert.equal(state.records[0].cost.amount,null);assert.equal(state.records[0].outcome,'cancelled');assert.equal(state.permits.foregroundActive,false);
});
