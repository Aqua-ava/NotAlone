import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {parseDirectExtraction} from '../src/memory/extraction/protocol.ts';
import {prepareMultimodalVerification,assertMultimodalAdmission} from '../src/memory/extraction/multimodal.ts';
import {prepareSourceVerification,assertCompleteClaimAdmission} from '../src/memory/extraction/verification/complete-claim.ts';
import {windowDigestStats} from '../src/memory/evidence/window-digest.ts';

const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];

function multimodalScenario(){
 const textId=randomUUID(),imageId=randomUUID(),fileId=randomUUID(),bytes=Buffer.from('synthetic-image-bytes');
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const image={id:fileId,file_id:fileId,sha256,mime_type:'image/png',media_generation:'0'};
 const window={owner_id:randomUUID(),contact_id:randomUUID(),target_message_ids:[imageId],messages:[
  {message_id:textId,sender:'contact',occurred_at:'2026-11-03T00:00:00Z',text:'这是我家的豆豆。',text_representation:'text'},
  {message_id:imageId,sender:'contact',occurred_at:'2026-11-03T00:00:01Z',text:'',text_representation:'placeholder',content_kind:'image',image}]};
 const fact={text:'联系人养了一只叫豆豆的橘猫。',subject:'contact',category:'common_fact',topic:'other',source_message_ids:[textId,imageId],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'文字表明归属与名字，实际图片表明猫的外观。',event:null,conditions:null};
 return {window,images:[{id:fileId,mimeType:'image/png',dataBase64:bytes.toString('base64')}],fact,textId,imageId,image};
}
function multimodalResponse(fingerprint,s){
 const facet=field=>({field,verdict:'supported',evidence_indices:[0,1],explanation:'使用本次固定文字与实际图片共同核验。'});
 return {results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[
  {message_id:s.textId,kind:'text',quote:'这是我家的豆豆。',description:null},
  {message_id:s.imageId,kind:'image',quote:null,description:'图片中是一只橘猫。'}],
  scope_subject:'contact',actor_kind:'contact',resolution:'explicit',checks:['attribution','body','temporal_and_modality',...fields].map(facet)}]};
}
test('多模态核验内 window 摘要只序列化一次，断言侧全部命中记忆化',async()=>{
 const s=multimodalScenario();
 windowDigestStats.computed=0;windowDigestStats.hits=0;
 const prepared=prepareMultimodalVerification({window:s.window,facts:[s.fact],images:s.images,requireCurrent:async()=>{}});
 assert.equal(windowDigestStats.computed,1);
 const blocks=[{type:'tool-call',name:'SourceVerificationOutput',arguments:JSON.stringify(multimodalResponse(prepared.fingerprint,s))}];
 const {items}=await prepared.decode(blocks);
 assert.equal(items[0].admitted,true);
 // 解码侧的绑定复用准备阶段摘要，不再按条重算整个窗口。
 assert.equal(windowDigestStats.computed,1);
 const bound={...s.fact,event:items[0].result.event,conditions:items[0].result.conditions};
 for(let n=0;n<3;n++)assertMultimodalAdmission(s.window,bound,items[0].result);
 assert.equal(windowDigestStats.computed,1);
 assert.equal(windowDigestStats.hits,3);
 // 不同对象实例、相同内容：摘要值一致，断言仍通过，只是记忆化未命中。
 assertMultimodalAdmission(structuredClone(s.window),bound,items[0].result);
 assert.equal(windowDigestStats.computed,2);
});

function claimScenario(){
 const message=randomUUID();
 const window={owner_id:randomUUID(),contact_id:randomUUID(),target_message_ids:[message],messages:[
  {message_id:message,sender:'contact',occurred_at:null,text_representation:'text',text:'我住在海城。'}]};
 const raw={text:'联系人住在海城。',subject:'contact',category:'recent_state',topic:'other',source_message_ids:[message],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话自述居住地。',event:null,conditions:null};
 const [fact]=parseDirectExtraction({scenes:[{scene_name:'居住',memories:[raw]}]},window).accepted;
 assert.ok(fact);
 return {window,fact};
}
function claimBlocks(prepared,window){
 const facet=verdict=>({verdict,evidence_indices:[0]});
 const span=(text,quote)=>{const start=[...text.slice(0,text.indexOf(quote))].length;return {start,end:start+[...quote].length};};
 const item={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:window.messages[0].message_id,quote:'我住在海城。'}],
  claim_check:{version:2,field_checks:Object.fromEntries(fields.map(name=>[name,facet('supported')])),parts:[{
   candidate_span:{start:0,end:8},
   attribution:{...facet('supported'),scope_subject:'contact',actor_kind:'contact',resolution:'explicit',
    subject_mentions:[{kind:'first_person',evidence_index:0,source_span:span('我住在海城。','我'),candidate_span:{start:0,end:3}}]},
   arguments_and_relation:facet('supported'),temporal_and_modality:facet('supported')}]}};
 return [{type:'tool-call',name:'SourceVerificationOutput',arguments:JSON.stringify({results:[item]})}];
}
test('完整命题核验内 window 摘要只序列化一次，断言侧全部命中记忆化',async()=>{
 const s=claimScenario();
 windowDigestStats.computed=0;windowDigestStats.hits=0;
 const policy={id:'complete-claim-v1',rule_version:'a'.repeat(64)};
 const prepared=prepareSourceVerification({window:s.window,facts:[s.fact],policy,requireCurrent:async()=>{}});
 assert.equal(windowDigestStats.computed,1);
 const {items}=await prepared.decode(claimBlocks(prepared,s.window));
 assert.equal(items[0].admitted,true);
 assert.equal(windowDigestStats.computed,1);
 const bound={...s.fact,event:items[0].result.event,conditions:items[0].result.conditions};
 assertCompleteClaimAdmission(s.window,bound,items[0].result);
 assertCompleteClaimAdmission(s.window,bound,items[0].result);
 assert.equal(windowDigestStats.computed,1);
 assert.equal(windowDigestStats.hits,2);
});
