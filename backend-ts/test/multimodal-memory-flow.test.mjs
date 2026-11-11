import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runExtractionFlow} from '../src/memory/extraction/flow.ts';
import {assertMultimodalAdmission,replayMultimodalVerification} from '../src/memory/extraction/multimodal.ts';

const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
function input(){
 const textId=randomUUID(),imageId=randomUUID(),fileId=randomUUID(),bytes=Buffer.from('synthetic-image-bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
 const image={id:fileId,file_id:fileId,sha256,mime_type:'image/png',media_generation:'0'};
 const window={owner_id:randomUUID(),contact_id:randomUUID(),target_message_ids:[imageId],messages:[
  {message_id:textId,sender:'contact',occurred_at:'2026-11-03T00:00:00Z',text:'这是我家的豆豆。',text_representation:'text'},
  {message_id:imageId,sender:'contact',occurred_at:'2026-11-03T00:00:01Z',text:'',text_representation:'placeholder',content_kind:'image',image},
 ]};
 return {window,images:[{id:fileId,mimeType:'image/png',dataBase64:bytes.toString('base64')}],textId,imageId,image};
}
function fact(i){return {text:'联系人养了一只叫豆豆的橘猫。',subject:'contact',category:'common_fact',topic:'other',source_message_ids:[i.textId,i.imageId],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'文字表明归属与名字，实际图片表明猫的外观。',event:null,conditions:null};}
function verification(body,i,change=value=>value){
 const facet=field=>({field,verdict:'supported',evidence_indices:[0,1],explanation:'使用本次固定文字与实际图片共同核验。'});
 return change({results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[
  {message_id:i.textId,kind:'text',quote:'这是我家的豆豆。',description:null},
  {message_id:i.imageId,kind:'image',quote:null,description:'图片中是一只橘猫。'},
 ],scope_subject:'contact',actor_kind:'contact',resolution:'explicit',checks:['attribution','body','temporal_and_modality',...fields].map(facet)}]});
}
function nestedResponse(flat){return {results:flat.results.map(row=>{
 const checks=new Map(row.checks.map(({field,...facet})=>[field,facet]));
 return {candidate_index:row.candidate_index,verdict:row.verdict,issues:row.issues,evidence:row.evidence,
  claim_check:{version:1,attribution:{...checks.get('attribution'),scope_subject:row.scope_subject,actor_kind:row.actor_kind,resolution:row.resolution},
   body:checks.get('body'),temporal_and_modality:checks.get('temporal_and_modality'),field_checks:Object.fromEntries(fields.map(field=>[field,checks.get(field)]))}};
})};}

async function run(i,change,encode=JSON.stringify){
 const requests=[],events=[];
 const outcome=await runExtractionFlow({window:i.window,images:i.images,signal:new AbortController().signal,mode:'legacy',max_retries:0,
  requireCurrent:async()=>{},record:async event=>{events.push(event);},
  invoke:async request=>{
   requests.push(request);const body=JSON.parse(request.user);
   const payload=request.purpose==='extraction'?{scenes:[{scene_name:'宠物',memories:[fact(i)]}]}:verification(body,i,change);
   const blocks=[{type:'tool-call',name:request.tool.name,arguments:request.purpose==='verification'?encode(payload):JSON.stringify(payload)}];
   await request.validateOutput(blocks);return {blocks};
  }});
 return {outcome,requests,events};
}
test('同一固定窗口的图文在提取和核验中均携带真实图片，图片证据没有伪造引文',async()=>{
 const i=input(),{outcome,requests,events}=await run(i);
 assert.equal(outcome.failure_kind,null);assert.equal(outcome.accepted.length,1);assert.equal(requests.length,2);
 for(const request of requests)assert.deepEqual(request.images,i.images);
 const extraction=JSON.parse(requests[0].user);assert.equal(extraction.messages[1].image_id,i.image.id);assert.equal(Object.hasOwn(extraction.messages[1],'text'),false);
 const result=outcome.verification[0].result;assert.equal(result.verification_mode,'multimodal-claim-v1');
 assert.deepEqual(result.evidence,[{message_id:i.textId,quote:'这是我家的豆豆。'}]);
 assert.equal(result.content_evidence[1].quote,null);assert.equal(result.content_evidence[1].file_id,i.image.file_id);
 assertMultimodalAdmission(i.window,outcome.accepted[0],result);
 assert.throws(()=>assertMultimodalAdmission(i.window,outcome.accepted[0],structuredClone(result)),/unbound_admission/);
 const prepared=events.find(event=>event.stage==='verification_input').payload;
 const blocks=events.find(event=>event.stage==='verification_return').payload.blocks;
 assert.equal(replayMultimodalVerification(prepared.window,prepared.facts,blocks,prepared.policy_fingerprint,JSON.parse(requests[1].user))[0].admitted,true);
 assert.throws(()=>replayMultimodalVerification({...prepared.window,contact_id:randomUUID()},prepared.facts,blocks,prepared.policy_fingerprint,JSON.parse(requests[1].user)),/stored_request_mismatch/);
});
test('图片字节缺失或不匹配固定摘要时，在提取调用之前停止',async()=>{
 const i=input();let calls=0;
 for(const images of [[],[{...i.images[0],dataBase64:Buffer.from('other-image').toString('base64')}]])
  await assert.rejects(runExtractionFlow({window:i.window,images,signal:new AbortController().signal,requireCurrent:async()=>{},record:async()=>{},invoke:async()=>{calls++;throw new Error('不得调用');}}),/images_missing/);
 assert.equal(calls,0);
});
test('图片证据不得指向别的文件、别的版本或伪造文字引文',async()=>{
 for(const change of [value=>{value.results[0].evidence[1].file_id=randomUUID();return value;},value=>{value.results[0].evidence[1].sha256='f'.repeat(64);return value;},value=>{value.results[0].evidence[1].quote='图片没有这样的聊天原文';return value;}]){
  const {outcome}=await run(input(),change);assert.equal(outcome.accepted.length,0);assert.equal(outcome.failure_kind,'invalid_output');
 }
});
test('扁平图文核验逐项要求主体归属与完整来源，缺任一支持不能采纳',async()=>{
 for(const change of [value=>{value.results[0].checks[0].verdict='uncertain';return value;},value=>{value.results[0].scope_subject='self';return value;},value=>{value.results[0].evidence.pop();for(const check of value.results[0].checks)check.evidence_indices=[0];return value;}]){
  const {outcome}=await run(input(),change);assert.equal(outcome.accepted.length,0);assert.equal(outcome.rejected_count,1);assert.equal(outcome.failure_kind,null);
 }
});
test('扁平图文核验要求15项独立检查恰好一次，不接收缺项、重复、未知或嵌套响应',async()=>{
 for(const change of [value=>{value.results[0].checks.pop();return value;},value=>{value.results[0].checks[14].field='attribution';return value;},value=>{value.results[0].checks[14].field='new_field';return value;},value=>{delete value.results[0].checks[0].verdict;return value;},value=>nestedResponse(value)]){
  const {outcome}=await run(input(),change);assert.equal(outcome.accepted.length,0);assert.equal(outcome.failure_kind,'invalid_output');
 }
 const {requests}=await run(input());const body=JSON.parse(requests[1].user);assert.equal(body.check_format,'local-ids-v3');
 const schema=requests[1].tool.parameters.properties.results.items.properties;
 assert.deepEqual(Object.keys(schema).sort(),['actor_kind','candidate_index','checks','evidence','issues','resolution','scope_subject','verdict'].sort());
 assert.equal(schema.checks.minItems,15);assert.equal(schema.checks.maxItems,15);
});
async function legacyArchive(){
 const archives=JSON.parse(readFileSync(new URL('./fixtures/verification-hash-archives.json',import.meta.url),'utf8'));
 const archive=archives.find(item=>item.kind==='nested-v1');
 return {prepared:{window:archive.window,facts:archive.facts,policy_fingerprint:archive.fingerprint},
  body:archive.body,value:JSON.parse(archive.blocks[0].arguments)};
}
function archivedReplay(archive,value,encode=JSON.stringify){
 const blocks=[{type:'tool-call',name:'SourceVerificationOutput',arguments:encode(value)}];
 const original=structuredClone(blocks);
 const result=replayMultimodalVerification(archive.prepared.window,archive.prepared.facts,blocks,archive.prepared.policy_fingerprint,archive.body);
 assert.deepEqual(blocks,original,'存档原始回复不被规范化改写');return result;
}
test('旧nested存档仅收拢已知空metadata和唯一末尾闭合，完整语义门禁不变',async()=>{
 const archive=await legacyArchive();
 const value=structuredClone(archive.value);value.results[0].claim_check.body.explanation_note=null;
 value.results[0].claim_check.temporal_and_modality.explanation_note=null;value.results[0].claim_check.issues=[];
 assert.equal(archivedReplay(archive,value,payload=>JSON.stringify(payload).replace(/\}\]\}$/u,']}'))[0].admitted,true);
 value.results[0].claim_check.attribution.scope_subject='self';
 assert.equal(archivedReplay(archive,value,payload=>JSON.stringify(payload).replace(/\}\]\}$/u,']}'))[0].admitted,false);
 value.results[0].claim_check.attribution.scope_subject='contact';value.results[0].evidence[1].sha256='f'.repeat(64);
 assert.throws(()=>archivedReplay(archive,value),/image_evidence_invalid/);
});
test('旧存档非空扩展、错误嵌套和多层缺闭合仍拒绝；新flat严格按其声明格式解码',async()=>{
 const archive=await legacyArchive();
 for(const change of [value=>{value.results[0].claim_check.body.explanation_note='有主体疑点';},value=>{value.results[0].claim_check.issues=['subject'];},value=>{const claim=value.results[0].claim_check;claim.body.temporal_and_modality=claim.temporal_and_modality;delete claim.temporal_and_modality;}]){
  const value=structuredClone(archive.value);change(value);assert.throws(()=>archivedReplay(archive,value),/structure_invalid/);
 }
 assert.throws(()=>archivedReplay(archive,archive.value,value=>JSON.stringify(value).replace(/\}\}\]\}$/u,']}')));
 const malformed=await run(input(),undefined,value=>JSON.stringify(value).replace(/\}\]\}$/u,']}'));
 assert.equal(malformed.outcome.accepted.length,0);assert.equal(malformed.outcome.failure_kind,'invalid_output');
});
