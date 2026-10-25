import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {buildReplyPayload,replyPayloadText} from '../src/reply-payload.ts';
import {parseReplyRequest} from '../src/reply-contract.ts';
const id='00000000-0000-4000-8000-000000000001';
function input(content,evidence=[]){const request=parseReplyRequest({contact_id:id,idempotency_key:id,content});return {request,context:{scope:{owner_id:id,contact_id:id},command:request,current_text:'合成来信',evidence,risk_notes:[]}};}
test('五种输入保真合同与原Python逐项一致，建议动作不制造当前意图',()=>{
 const values=[{type:'rewrite_draft',draft_text:'暂时不参加'},
 {type:'rewrite_draft',draft_text:'你来吗',input_kind:'current_chat',pasted_direction:'婉拒'},
 {type:'rewrite_draft',draft_text:'',input_kind:'workspace',workspace_action:'suggest'},
 {type:'reply_to_message',target_message_id:id,direction:'婉拒'},
 {type:'initiate_conversation',purpose:'约明天吃饭'}].map(c=>buildReplyPayload(input(c)));
 const script='import json,sys\nfrom notalone.reply.fidelity import generation_contract\nprint(json.dumps([generation_contract(x) for x in json.load(sys.stdin)],ensure_ascii=False))';
 const expected=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script],{input:JSON.stringify(values),env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8',timeout:10000}));
 assert.deepEqual(values.map(v=>v.fidelity_contract),expected);
 assert.equal(values[2].fidelity_contract.current_intent,null);
});
test('逐例候选上限与未知禁区进入用户消息并保持每项明确',()=>{
 const first=input({type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'主动问候',user_instruction:JSON.stringify({unknowns:['是否突然想到对方']})});
 const second=input({type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'确认近况',user_instruction:JSON.stringify({unknowns:['联系间隔']})});
 const firstText=replyPayloadText(first),secondText=replyPayloadText(second);
 assert.notEqual(firstText,secondText);
 assert.match(firstText,/本轮候选数量上限是 1 条/);
 assert.match(firstText,/不得在候选正文中填写成事实、原因、心理、间隔、动作或安排）：是否突然想到对方/);
 assert.match(firstText,/只返回一条不依赖这些未知的候选/);
 assert.match(secondText,/联系间隔/);assert.doesNotMatch(secondText,/是否突然想到对方/);
});
test('只传模型可见资料，保留未确认标记并按微秒排序，不泄露内部来源字段',()=>{
 const row=(n,time,kind='message')=>({evidence_id:String(n),kind,text:'合成资料',status:kind==='pending_candidate'?'pending':'active',selection_reason:'未确认候选、仅供参考',timing:{source_started_at:time},event:null,conditions:null,evolution:null,valid_at:null,invalid_at:null,speaker_role:'contact',model_visible:true,source_ids:['不得出站'],freshness_sha256:'不得出站'});
 const x=input({type:'initiate_conversation',purpose:'问候'},[row(1,null),row(2,'2026-01-01T00:00:00.000002+00:00'),row(3,null,'pending_candidate'),row(4,'2026-01-01T00:00:00.000001+00:00'),{...row(5,null),model_visible:false}]);
 const result=buildReplyPayload(x);
 assert.deepEqual(result.evidence.map(e=>e.evidence_id),['4','2','3','1']);
 assert.equal(result.evidence[2].factual_role,'unconfirmed_reference');
 assert.equal(result.evidence[2].status,'pending');
 assert.ok(!JSON.stringify(result).includes('不得出站'));
 assert.deepEqual(result.citation_policy.allowed_evidence_ids,['4','2','3','1']);
});
test('无历史授权时拒绝历史资料，偏好只投影表达字段且大修订号不截断',()=>{
 const x=input({type:'rewrite_draft',draft_text:'明天聊'},[{kind:'message',model_visible:false}]);
 assert.throws(()=>buildReplyPayload(x),{code:'reply_context_unavailable'});
 x.context.evidence=[];x.preferences=[{preference_id:id,revision:9007199254740993n,text:'简短',scope:{contact_id:id,reply_mode:null},source_ids:['私有来源']}];
 const text=replyPayloadText(x);assert.ok(text.includes('9007199254740993'));assert.ok(!text.includes('私有来源'));
 assert.equal(buildReplyPayload(x).fidelity_contract.priority[2],'long_term_expression_preference');
});
test('续写只接受已捕获的同范围版本，模型保留候选低事实角色与依据变更',()=>{
 const x=input({type:'rewrite_draft',draft_text:'按现在意愿表达'});
 x.request.continued_from_candidate_id=id;
 assert.throws(()=>buildReplyPayload(x),{code:'reply_context_unavailable'});
 x.context.conversation_binding_id=id;
 x.context.continuation_basis={candidate_id:id,scope:x.context.scope,conversation_binding_id:id,text:'旧候选措辞',basis_revision_sha256:'a'.repeat(64),basis_changes:[{kind:'memory_changed',evidence_id:id}]};
 x.context.evidence=[{evidence_id:id,kind:'continued_candidate',text:'旧候选措辞',status:'candidate',selection_reason:'只参考说法',timing:{source_started_at:null},event:null,conditions:null,evolution:null,valid_at:null,invalid_at:null,model_visible:true}];
 const payload=buildReplyPayload(x);
 assert.equal(payload.evidence[0].factual_role,'previous_assistant_candidate');
 assert.deepEqual(payload.evidence[0].basis_changes,x.context.continuation_basis.basis_changes);
 assert.equal(payload.fidelity_contract.current_intent.text,'按现在意愿表达');
 x.context.continuation_basis.text='被篡改';
 assert.throws(()=>buildReplyPayload(x),{code:'reply_context_unavailable'});
});
test('完整助手讨论与明确选择的编辑版本只作为低权重参考，不冒充已发送事实',()=>{
 const x=input({type:'rewrite_draft',draft_text:'现在的意愿'}),messages=[{message_id:id,text:'合成用户编辑版'}];
 x.discussion={scope:x.context.scope,session_id:id,request_key:id,current_input_version_id:id,notice:'合成历史讨论',snapshot:{},items:[{kind:'candidate_version',text:JSON.stringify({messages}),input_version_id:id,turn_id:id,reply_request_id:id,candidate_id:id,version_id:id,parent_version_id:null,candidate_number:1,version_number:0,is_default_display:true,is_explicitly_selected:true,basis_changes:[]}]};
 const ordinary=buildReplyPayload(x);assert.equal(ordinary.assistant_discussion.weight,'low');assert.equal(ordinary.assistant_discussion.items[0].is_sent,false);
 assert.equal(ordinary.assistant_discussion.items[0].role,'assistant_candidate');
 x.request.continued_from_candidate_id=id;x.context.conversation_binding_id=id;
 x.context.continuation_basis={candidate_id:id,scope:x.context.scope,conversation_binding_id:id,text:'旧候选',basis_revision_sha256:'a'.repeat(64),basis_changes:[]};
 x.context.evidence=[{evidence_id:id,kind:'continued_candidate',text:'旧候选',status:'candidate',selection_reason:'措辞参考',timing:{source_started_at:null},event:null,conditions:null,evolution:null,valid_at:null,invalid_at:null,model_visible:true}];
 x.authenticated={continuation:{},continuation_reference:{candidate_id:id,version_id:id,messages}};
 const selected=buildReplyPayload(x);assert.equal(selected.continuation_reference.weight,'low');assert.deepEqual(selected.continuation_reference.messages,messages);
 assert.equal(selected.fidelity_contract.current_intent.text,'现在的意愿');
 x.authenticated.continuation_reference.messages[0].text='被篡改';
 assert.throws(()=>buildReplyPayload(x),{code:'reply_context_invalidated'});
});
