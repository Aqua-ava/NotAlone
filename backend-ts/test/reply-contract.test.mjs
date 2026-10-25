import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyRequest, validateReplyCandidates,normalizeReplyInput } from '../src/reply-contract.ts';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {resolve} from 'node:path';

const id='10000000-0000-4000-8000-000000000001';
test('公开回复输入拒绝伪造内部续写和讨论资格',()=>{
 const payload={contact_id:id,idempotency_key:id,content:{type:'rewrite_draft',draft_text:'合成'}};
 for(const field of ['continuation','continuation_reference','assistant_discussion','assistant_discussion_snapshot'])
  assert.throws(()=>parseReplyRequest({...payload,[field]:{}}),{code:'reply_request_invalid'});
});
test('旧Python累计续写完整保留；只有可信内部逐字匹配要求可以超4096字',()=>{
 const script=`import json\nfrom uuid import UUID\nfrom notalone.application.reply_remote import reply_remote_payload\nfrom notalone.application.reply_request import parse_reply_request,ReplyRequestInvalid\nfrom notalone.reply.assistant_continuation_reference import ContinuationGenerateReply\nfrom notalone.reply.interface import AccumulatedReplyRequirements,ConfirmedDirection,DirectionSource,InitiateConversation,ReplyToMessage\nfrom notalone.scopes import ContactScope,VerifiedConversationScope\nscope=VerifiedConversationScope(UUID('${id}'),UUID('${id}'),UUID('${id}'))\nrequirements=('甲'*4000,'乙'*4000,'丙'*4000)\nmetadata={'version':1,'scope':'this_assistant_session_only','candidate_id':None,'version_id':None,'effective_requirements':list(requirements)}\nfor content in (InitiateConversation(ConfirmedDirection('问候',DirectionSource.DIRECT_INPUT),user_instruction=AccumulatedReplyRequirements(requirements)),ReplyToMessage(UUID('${id}'),ConfirmedDirection('回应',DirectionSource.DIRECT_INPUT),user_instruction=AccumulatedReplyRequirements(requirements))):\n command=ContinuationGenerateReply(idempotency_key=UUID('${id}'),scope=ContactScope(scope.owner_id,scope.contact_id),conversation_binding_id=scope.conversation_binding_id,content=content,continuation=metadata,continuation_reference=None)\n assert command.has_valid_content()\n envelope=reply_remote_payload(command,scope,scope.owner_id)\n try:\n  parse_reply_request(json.dumps(envelope['request'],ensure_ascii=False).encode())\n  public_rejected=False\n except ReplyRequestInvalid:\n  public_rejected=True\n print(json.dumps({'envelope':envelope,'public_rejected':public_rejected},ensure_ascii=False))\n`;
 const baseline=spawnSync(resolve(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-B','-c',script],{cwd:resolve(import.meta.dirname,'../../backend'),env:{...process.env,NOTALONE_DISABLE_DOTENV:'1'},encoding:'utf8'});
 assert.equal(baseline.status,0,baseline.stderr);
 for(const {envelope,public_rejected} of baseline.stdout.trim().split('\n').map(JSON.parse)){
  const input=envelope.request,auth=envelope.internal.authenticatedContinuation;
  assert.equal(public_rejected,true);assert.equal(input.content.user_instruction.length,12002);
  assert.equal(auth.continuation_reference,null);
  assert.throws(()=>parseReplyRequest(input),{code:'reply_request_invalid'});
  assert.ok(parseReplyRequest(input,auth).content.user_instruction===input.content.user_instruction,'完整累计要求不得改变');
  const padded={...auth,continuation:{...auth.continuation,effective_requirements:auth.continuation.effective_requirements.map((value,index)=>index===0?' '+value:index===2?value+' ':value)}};
  const complete={...input,content:{...input.content,user_instruction:' '+input.content.user_instruction+' '}};
  assert.ok(parseReplyRequest(complete,padded).content.user_instruction===complete.content.user_instruction,'可信累计值的首尾字符也必须保留');
  for(const requirements of [[],['甲'.repeat(4000),'乙'.repeat(4000)],['甲'.repeat(4000),'','丙'.repeat(4000)],['甲'.repeat(4000),42,'丙'.repeat(4000)]])
   assert.throws(()=>parseReplyRequest(input,{...auth,continuation:{...auth.continuation,effective_requirements:requirements}}),{code:'reply_request_invalid'});
  assert.throws(()=>parseReplyRequest({...input,continuation:auth.continuation}),{code:'reply_request_invalid'});
  assert.throws(()=>parseReplyRequest({...input,content:{...input.content,user_instruction:' '+input.content.user_instruction}},auth),{code:'reply_request_invalid'});
  assert.throws(()=>parseReplyRequest({...input,content:{...input.content,understanding_correction:'甲'.repeat(4097)}},auth),{code:'reply_request_invalid'});
 }
});
test('工作区保留空草稿建议与手动表达的区别',()=>{
  const payload={contact_id:id,idempotency_key:id,content:{type:'rewrite_draft',draft_text:'',input_kind:'workspace',workspace_action:'suggest'}};
  assert.equal(parseReplyRequest(payload).content.workspace_action,'suggest');
  assert.throws(()=>parseReplyRequest({...payload,content:{...payload.content,workspace_action:'express'}}),{code:'reply_request_invalid'});
});
test('原Python规范化指纹保持三种模式、Skill选择及建议摘要兼容',()=>{
  const values=[
    {type:'initiate_conversation',purpose:'  明天一起吃饭  '},
    {type:'reply_to_message',target_message_id:id,direction:' 谢谢 ',understanding_correction:'不要扩充承诺'},
    {type:'rewrite_draft',draft_text:'  有空见面  '},
    {type:'rewrite_draft',draft_text:'',input_kind:'workspace',workspace_action:'suggest',context_text:'合成当下文字',excluded_message_ids:[id,id]},
    {type:'rewrite_draft',draft_text:'谢谢',input_kind:'current_chat',pasted_direction:'礼貌回应'},
  ].map(content=>({idempotency_key:id,contact_id:id,content,allow_incomplete_history:true,skill_disabled:true}));
  const script=`import json,sys\nfrom uuid import UUID\nfrom notalone.application.reply_request import parse_reply_request\nfrom notalone.reply.context_validation import normalize_reply_input\nfor payload in json.load(sys.stdin):\n contact,request=parse_reply_request(json.dumps(payload).encode())\n command=request.build_command(owner_id=UUID('${id}'),contact_id=contact,binding_id=UUID('${id}'))\n print(json.dumps(normalize_reply_input(command),ensure_ascii=False))\n`;
  const result=spawnSync(resolve(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script],{cwd:resolve(import.meta.dirname,'../../backend'),input:JSON.stringify(values),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(values.map(v=>normalizeReplyInput(parseReplyRequest(v))),result.stdout.trim().split('\n').map(JSON.parse));
});
test('候选只能引用本轮证据且消息组与正文一致',()=>{
  const candidate={text:'好呀\n\n明天见',basis:'按本次目的回应',citation_ids:[id],risk_notes:[],messages:['好呀','明天见']};
  assert.deepEqual(validateReplyCandidates({candidates:[candidate]},new Set([id])),[candidate]);
  assert.throws(()=>validateReplyCandidates({candidates:[candidate]},new Set()),{code:'reply_candidates_rejected'});
  assert.throws(()=>validateReplyCandidates({candidates:[{...candidate,text:'别的正文'}]},new Set([id])),{code:'reply_candidates_rejected'});
});
test('多消息候选仅补齐消息边界空行，不改写任何消息文字',()=>{
  const candidate={text:'好呀明天见',basis:'按本次目的回应',citation_ids:[id],risk_notes:[],messages:['好呀','明天见']};
  assert.deepEqual(validateReplyCandidates({candidates:[candidate]},new Set([id])),[{...candidate,text:'好呀\n\n明天见'}]);
  for(const text of ['好呀\n明天见','好呀，明天见','好呀 \n\n明天见'])assert.throws(
    ()=>validateReplyCandidates({candidates:[{...candidate,text}]},new Set([id])),
    {code:'reply_candidates_rejected'},
  );
});
