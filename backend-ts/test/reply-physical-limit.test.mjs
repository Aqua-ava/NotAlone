import test from 'node:test';
import assert from 'node:assert/strict';
import {replyPhysicalLimit,replyScenarioReadPolicy,ReplyScenarioAccess} from '../src/reply-context-scenario.ts';

const material=budget=>({snapshot:{},payload_json:JSON.stringify({directory:[],scenario_read_budget:budget})});
const withCalls=calls=>material({call_limit:calls,paragraph_limit:8,character_limit:4000});
const context=(contact=null,owner=null)=>({layered_context:contact,owner_layered_context:owner});
test('实际两层预算全组合：无层或null不加轮，有预算逐层相加且不修改冻结材料',()=>{
 const states=[null,material(null),withCalls(1),withCalls(2),withCalls(8)];
 // 旧生产16基础步骤及两侧实际读取额度的独立合同样例。
 const expected=[[8,8,9,10,16],[8,8,9,10,16],[9,9,10,11,17],[10,10,11,12,18],[16,16,17,18,24]];
 for(let contact=0;contact<states.length;contact++)for(let owner=0;owner<states.length;owner++){
  const input=context(states[contact],states[owner]),before=structuredClone(input),policy=replyScenarioReadPolicy(input);
  assert.equal(replyPhysicalLimit(input,24),expected[contact][owner],`联系人状态${contact}／本人状态${owner}`);
  assert.deepEqual(policy.reads.map(entry=>entry.side),[...(contact>=2?['contact']:[]),...(owner>=2?['owner']:[])]);
  assert.deepEqual(input,before,'政策读取不得改写冻结payload');
 }
});
test('显式更小服务端cap继续生效，裁剪后的材料才决定轮数',()=>{
 for(const [input,cap,expected] of [[context(),2,2],[context(withCalls(8)),12,12],[context(withCalls(1)),24,9],[context(withCalls(2),withCalls(3)),10,10],[context(withCalls(2),withCalls(3)),24,13],[context(),6,6]])assert.equal(replyPhysicalLimit(input,cap),expected);
 const full=context(withCalls(2),withCalls(2)),ownerOmitted={...full,owner_layered_context:null},bothOmitted={...ownerOmitted,layered_context:null};
 assert.equal(replyPhysicalLimit(full,24),12);assert.equal(replyPhysicalLimit(ownerOmitted,24),10);assert.equal(replyPhysicalLimit(bothOmitted,24),8);
});
test('非null预算必须有1至8整数call_limit，坏预算和上限在工具或HTTP之前拒绝',()=>{
 for(const value of [undefined,null,false,true,'2',0,-1,9,1.5,{},[]]){
  const invalid=withCalls(value);assert.throws(()=>replyScenarioReadPolicy(context(invalid)),/正文读取/);assert.throws(()=>new ReplyScenarioAccess(invalid),/正文读取/);
 }
 for(const budget of [0,false,[],{}])assert.throws(()=>replyPhysicalLimit(context(material(budget)),24),/正文读取/);
 for(const cap of [0,-1,1.5,NaN,Infinity,'24'])assert.throws(()=>replyPhysicalLimit(context(),cap),/调用上限/);
 assert.throws(()=>replyScenarioReadPolicy(context({payload_json:'{'})),/正文读取/);
 assert.deepEqual(replyScenarioReadPolicy(context(material(null),material(null))),{reads:[],call_limit:0});
});
