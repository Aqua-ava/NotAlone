import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReplyPayload,replyPayloadText} from '../src/reply-payload.ts';
import {parseReplyRequest,validateReplyCandidates} from '../src/reply-contract.ts';
import {aliasReplyEvidenceReferences,createEvidenceAliases,restoreReplyEvidenceAliases} from '../src/reply-evidence-alias.ts';
import {REPLY_SYSTEM_PROMPT} from '../src/reply-prompts.ts';
import {replySystemPrompt} from '../src/reply-system-prompt.ts';

const contact='30000000-0000-4000-8000-000000000001';
const realIds=[
  '30000000-0000-4000-8000-000000000010',
  '30000000-0000-4000-8000-000000000020',
  '30000000-0000-4000-8000-000000000030',
];
const alternateIds=[
  '40000000-0000-4000-8000-000000000010',
  '40000000-0000-4000-8000-000000000020',
  '40000000-0000-4000-8000-000000000030',
];
function subject(ids){
  const request=parseReplyRequest({contact_id:contact,idempotency_key:contact,
    content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'问候近况',
      include_relationship_context:true,user_instruction:JSON.stringify({unknowns:['联系间隔']})}});
  const evidence=ids.map((evidence_id,index)=>({evidence_id,kind:['user_purpose','user_draft','user_current_chat'][index],
    text:['帮我表达','问候近况','{"available_facts":[]}'][index],status:'user_input',selection_reason:'本机合成输入',
    timing:{source_started_at:null},event:null,conditions:null,evolution:null,valid_at:null,invalid_at:null,
    speaker_role:'unknown',model_visible:true,source_ids:[]}));
  const context={scope:{owner_id:contact,contact_id:contact},command:request,current_text:'问候近况',evidence,risk_notes:[]};
  return {request,context,aliases:createEvidenceAliases(evidence.map(item=>item.evidence_id))};
}
test('相同内容的模型 payload 不随真实证据 UUID 改变且不泄露 UUID',()=>{
  const first=subject(realIds),second=subject(alternateIds);
  const firstText=replyPayloadText(first),secondText=replyPayloadText(second);
  assert.equal(firstText,secondText);
  for(const id of [...realIds,...alternateIds])assert.ok(!firstText.includes(id)&&!secondText.includes(id));
  const payload=JSON.parse(firstText.slice(0,firstText.indexOf('\n\n本轮候选数量上限')));
  assert.deepEqual(payload.evidence.map(item=>item.evidence_id),['c1','c2','c3']);
  assert.deepEqual(payload.citation_policy.allowed_evidence_ids,['c1','c2','c3']);
});
test('模型引用别名按重复与顺序精确还原为真实证据并在准入后保存',()=>{
  const aliases=createEvidenceAliases(realIds);
  const raw={candidates:[{text:'明天见',basis:'本次输入',citation_ids:['c2','c1','c2'],risk_notes:[]}]};
  const restored=restoreReplyEvidenceAliases(raw,aliases);
  assert.deepEqual(validateReplyCandidates(restored,new Set(realIds)),[
    {text:'明天见',basis:'本次输入',citation_ids:[realIds[1],realIds[0],realIds[1]],risk_notes:[],messages:[]},
  ]);
  for(const citation_ids of [['c99'],['c1',realIds[0]]])assert.throws(
    ()=>validateReplyCandidates(restoreReplyEvidenceAliases({candidates:[{...raw.candidates[0],citation_ids}]},aliases),new Set(realIds)),
    {code:'reply_candidates_rejected'},
  );
});
test('从空映射开始先固定顶层 c1..cN，再处理嵌套来源引用',()=>{
  const owner='10000000-0000-4000-8000-000000000001';
  const contact='20000000-0000-4000-8000-000000000001';
  const nested=['40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002'];
  const request=parseReplyRequest({contact_id:contact,idempotency_key:contact,content:{type:'initiate_conversation',purpose:'问候'}});
  const row=(evidence_id,kind,evolution=null)=>({evidence_id,kind,text:'合成资料',status:'active',selection_reason:'合成',
    timing:{source_started_at:null},event:null,conditions:null,evolution,valid_at:null,invalid_at:null,speaker_role:'unknown',model_visible:true,source_ids:[]});
  const context={scope:{owner_id:owner,contact_id:contact},command:request,current_text:'问候',risk_notes:[],evidence:[
    row('30000000-0000-4000-8000-000000000001','confirmed_memory',{kind:'supplement',evidence_message_ids:nested}),
    row('30000000-0000-4000-8000-000000000002','owner_memory'),
  ]};
  const payload=buildReplyPayload({request,context,aliases:createEvidenceAliases()});
  assert.deepEqual(payload.evidence.map(item=>item.evidence_id),['c1','c2']);
  assert.deepEqual(payload.evidence[0].evolution.evidence_message_ids,['c3','c4']);
  assert.deepEqual(payload.citation_policy.allowed_evidence_ids,['c1','c2']);
});
test('续写和讨论的全部模型可见标识使用请求局部别名且不泄漏真实 UUID',()=>{
  const owner='10000000-0000-4000-8000-000000000001';
  const contact='20000000-0000-4000-8000-000000000001';
  const binding='40000000-0000-4000-8000-000000000001';
  const candidate='30000000-0000-4000-8000-000000000001';
  const message='50000000-0000-4000-8000-000000000001';
  const version='60000000-0000-4000-8000-000000000001';
  const request=parseReplyRequest({contact_id:contact,idempotency_key:contact,continued_from_candidate_id:candidate,
    content:{type:'rewrite_draft',draft_text:'新的表达'}});
  const evidence={evidence_id:candidate,kind:'continued_candidate',text:'旧候选',status:'candidate',selection_reason:'合成',
    timing:{source_started_at:null},event:null,conditions:null,evolution:null,valid_at:null,invalid_at:null,speaker_role:'unknown',model_visible:true,source_ids:[]};
  const context={scope:{owner_id:owner,contact_id:contact},command:request,conversation_binding_id:binding,current_text:'新的表达',risk_notes:[],evidence:[evidence],
    continuation_basis:{candidate_id:candidate,scope:{owner_id:owner,contact_id:contact},conversation_binding_id:binding,text:'旧候选',basis_revision_sha256:'a'.repeat(64),basis_changes:[]}};
  const discussion={scope:{owner_id:owner,contact_id:contact},session_id:binding,request_key:contact,current_input_version_id:version,notice:'合成',snapshot:{},
    items:[{kind:'candidate_version',text:JSON.stringify({messages:[{message_id:message,text:'旧候选'}]}),input_version_id:version,turn_id:version,
      reply_request_id:binding,candidate_id:candidate,version_id:version,parent_version_id:null,candidate_number:1,version_number:0,
      is_default_display:true,is_explicitly_selected:true,basis_changes:[]}]};
  const authenticated={continuation:{},continuation_reference:{candidate_id:candidate,version_id:version,messages:[{message_id:message,text:'旧候选'}]}};
  const aliases=createEvidenceAliases(),payload=buildReplyPayload({request,context,discussion,authenticated,aliases}),wire=JSON.stringify(payload);
  assert.deepEqual([binding,candidate,message,version].filter(id=>wire.includes(id)),[]);
  assert.equal(payload.assistant_discussion.session_id,'s1');
  assert.match(payload.assistant_discussion.items[0].text,/"message_id":"r\d+"/);
  assert.equal(payload.continuation_reference.candidate_id,'c1');
  assert.match(payload.continuation_reference.messages[0].message_id,/^r\d+$/);
  assert.equal(new Set(aliases.entries().map(item=>item.evidence_id)).size,1);
});
test('状态标识按请求隔离，旧会话 alias 不能在新请求反向解析',()=>{
  const session='40000000-0000-4000-8000-000000000001',first=createEvidenceAliases(),second=createEvidenceAliases();
  assert.equal(first.sessionFor(session),'s1');
  assert.equal(first.resolveSession('s1'),session);
  assert.equal(second.resolveSession('s1'),undefined);
  assert.equal(second.resolve(first.referenceFor('50000000-0000-4000-8000-000000000001')),undefined);
});
test('普通 generation_input 全量递归投影 message/request/input/turn 关联标识',()=>{
 const owner='10000000-0000-4000-8000-000000000001',contact='20000000-0000-4000-8000-000000000002';
 const message='40000000-0000-4000-8000-000000000004',version='50000000-0000-4000-8000-000000000005';
 const requestKey='60000000-0000-4000-8000-000000000006',binding='70000000-0000-4000-8000-000000000007';
 const request=parseReplyRequest({contact_id:contact,idempotency_key:requestKey,content:{type:'rewrite_draft',draft_text:'新的表达',include_relationship_context:false}});
 const context={scope:{owner_id:owner,contact_id:contact},command:request,conversation_binding_id:binding,current_text:'新的表达',risk_notes:[],evidence:[]};
 const discussion={scope:{owner_id:owner,contact_id:contact},session_id:binding,request_key:requestKey,current_input_version_id:version,notice:'合成',snapshot:{},items:[{
  kind:'generation_input',text:JSON.stringify({content:{type:'reply_to_message',target_message_id:message,excluded_message_ids:[message]},idempotency_key:requestKey,operation_key:requestKey,origin_session_id:binding,input_version:version,expected_input_version_id:version,previous_id:version}),
  input_version_id:version,turn_id:version,reply_request_id:requestKey,candidate_id:null,version_id:null,parent_version_id:null,candidate_number:null,version_number:null,
  is_default_display:false,is_explicitly_selected:false,basis_changes:[]}]};
 const payload=buildReplyPayload({request,context,discussion,aliases:createEvidenceAliases()}),wire=JSON.stringify(payload);
 for(const id of [message,requestKey,version,binding])assert.ok(!wire.includes(id),id);
 const input=JSON.parse(payload.assistant_discussion.items[0].text);
 assert.match(input.content.target_message_id,/^r\d+$/);assert.match(input.content.excluded_message_ids[0],/^r\d+$/);
 assert.match(input.idempotency_key,/^r\d+$/);assert.match(input.operation_key,/^r\d+$/);assert.match(input.input_version,/^r\d+$/);
 assert.match(input.expected_input_version_id,/^r\d+$/);assert.match(input.previous_id,/^r\d+$/);assert.match(input.origin_session_id,/^s\d+$/);
});
test('系统拥有的内嵌JSON有界投影，业务JSON及普通文本逐字保留',()=>{
 const aliases=createEvidenceAliases();
 const message='40000000-0000-4000-8000-000000000004',request='50000000-0000-4000-8000-000000000005';
 const version='60000000-0000-4000-8000-000000000006',session='70000000-0000-4000-8000-000000000007';
 const skill='80000000-0000-4000-8000-000000000008';
 const deepest=JSON.stringify({message_id:message,message_ids:[message],session_id:session,skill_version_id:skill});
 const nested=JSON.stringify({submission:JSON.stringify({target_message_id:message,continuation:deepest}),request_id:request});
 const doubleEncoded=JSON.stringify(JSON.stringify({session_id:session,message_id:message}));
 const human='{ "order_id": "INV-42", "number": 9007199254740993 }';
 const value={kind:'generation_input',text:nested,human,scalar:'123',payload_json:JSON.stringify({version_id:version}),input_payload:doubleEncoded};
 const first=aliasReplyEvidenceReferences(value,aliases),second=aliasReplyEvidenceReferences(first,aliases);
 assert.deepEqual(second,first);
 const wire=JSON.stringify(first);
 for(const id of [message,request,version,session,skill])assert.ok(!wire.includes(id),id);
 assert.equal(first.human,human);assert.equal(first.scalar,'123');
 const outer=JSON.parse(first.text),middle=JSON.parse(outer.submission),inner=JSON.parse(middle.continuation);
 assert.equal(middle.target_message_id,inner.message_id);assert.match(middle.target_message_id,/^r\d+$/);
 assert.equal(inner.message_ids[0],inner.message_id);assert.match(inner.session_id,/^s\d+$/);assert.match(inner.skill_version_id,/^k\d+$/);
 assert.match(JSON.parse(first.payload_json).version_id,/^r\d+$/);
 const decoded=JSON.parse(JSON.parse(first.input_payload));assert.match(decoded.session_id,/^s\d+$/);assert.match(decoded.message_id,/^r\d+$/);
 let deep=JSON.stringify({message_id:message});
 for(let index=0;index<20;index++)deep=JSON.stringify({continuation:deep});
 assert.throws(()=>aliasReplyEvidenceReferences({input_payload:deep},createEvidenceAliases()),{code:'reply_context_unavailable'});
});
test('静态提示明确 evidence_id 是不得猜测或改写的不透明 alias',()=>{
  assert.match(REPLY_SYSTEM_PROMPT,/evidence_id 是不透明字符串/);
  assert.match(REPLY_SYSTEM_PROMPT,/不得猜测或改写 alias/);
  const prompt=replySystemPrompt({scope:{owner_id:contact,contact_id:contact},evidence:[]},null);
  assert.match(prompt,/不透明版本 alias（以 k 开头）/);
  assert.doesNotMatch(prompt,/版本 UUID 回执/);
});
