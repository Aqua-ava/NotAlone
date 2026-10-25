import test from 'node:test';
import assert from 'node:assert/strict';
import {replyPayloadText} from '../src/reply-payload.ts';
import {parseReplyRequest,validateReplyCandidates} from '../src/reply-contract.ts';
import {createEvidenceAliases,restoreReplyEvidenceAliases} from '../src/reply-evidence-alias.ts';

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
