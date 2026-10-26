import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {replyGeneratedPayload} from '../src/reply/generation/reply-result.ts';
test('稳定回复DTO只含候选/引用和生成回执，保留Skill执行范围与读取失败',()=>{
 const contact=randomUUID(),evidence=randomUUID(),id=randomUUID(),preference=randomUUID();
 const result={reply_request_id:id,candidates:[{candidate_id:id,text:'合成',basis:'本次目的',citation_ids:[evidence,evidence],risk_notes:[],messages:[{message_id:id,text:'合成'}]}],skill_library_revision:1,
  context_snapshot:{scope:{contact_id:contact},private_source:'不应出站的快照',layered_read_failed:true,expression_preferences:[{preference_id:preference,text:'简短',revision:9007199254740993n,scope:{contact_id:contact,reply_mode:null}}]},
  used_skill:{skill_id:id,version_id:id,name:'合成策略',version_number:3,selection_method:'user',selection_reason:'用户选择',resource_paths:[],load_state:'loaded',scope_kind:'contact',scope_contact_id:contact,scope_scene:null,execution_view:{policy_revision:0,method_ids:[],sha256:'a'.repeat(64)}}};
 const payload=replyGeneratedPayload(result,contact,[]);
 assert.deepEqual(payload.context_receipt.evidence_ids,[evidence]);
 assert.equal(payload.context_receipt.expression_preferences[0].revision,9007199254740993n);
 assert.equal(payload.context_receipt.layered_read_failed,true);assert.equal(payload.context_receipt.overview_read_failed,false);
 assert.deepEqual(payload.used_skill.scope,{kind:'contact',contact_id:contact,scene:null});
 assert.deepEqual(payload.used_skill.execution_view,result.used_skill.execution_view);
 assert.ok(!JSON.stringify(payload,(_,v)=>typeof v==='bigint'?String(v):v).includes('不应出站'));
 result.context_snapshot.layered_read_failed='false';
 assert.throws(()=>replyGeneratedPayload(result,contact,[]),{code:'reply_result_invalid'});
});
test('生成时偏好回执必须属于本联系人，损坏或重复修订不得作为完成回复',()=>{
 const contact=randomUUID(),id=randomUUID();
 const result={reply_request_id:id,candidates:[],skill_library_revision:0,used_skill:null,context_snapshot:{expression_preferences:[{preference_id:id,text:'合成',revision:1,scope:{contact_id:randomUUID(),reply_mode:null}}]}};
 assert.throws(()=>replyGeneratedPayload(result,contact,[]),{code:'reply_result_invalid'});
 result.context_snapshot.expression_preferences[0].scope.contact_id=contact;
 result.context_snapshot.expression_preferences[0].revision=0;
 assert.throws(()=>replyGeneratedPayload(result,contact,[]),{code:'reply_result_invalid'});
});
