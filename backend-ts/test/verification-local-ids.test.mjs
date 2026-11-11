import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseDirectExtraction} from '../src/memory/extraction/protocol.ts';
import {prepareSourceVerification,replayCompleteClaimVerification} from '../src/memory/extraction/verification/complete-claim.ts';
import {prepareMultimodalVerification,replayMultimodalVerification} from '../src/memory/extraction/multimodal.ts';

const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'];
const policy={id:'complete-claim-v1',rule_version:'a'.repeat(64)};
const archives=JSON.parse(readFileSync(new URL('./fixtures/verification-hash-archives.json',import.meta.url),'utf8'));
const blocks=value=>[{type:'tool-call',name:'SourceVerificationOutput',arguments:JSON.stringify(value)}];
function localResponse(image=false){
 const archive=archives.find(item=>item.kind===(image?'flat-fields-v2':'complete-claim-v1'));
 const value=JSON.parse(archive.blocks[0].arguments);delete value.request_fingerprint;
 if(image)for(const row of value.results)for(const ref of row.evidence){delete ref.file_id;delete ref.sha256;}
 return value;
}
function scenario(image=false){
 const bytes=Buffer.from('synthetic-image-local-ids'),fileId=id(5);
 const window={owner_id:id(1),contact_id:id(2),target_message_ids:[id(3)],messages:[
  {message_id:id(3),sender:'contact',occurred_at:null,text_representation:'text',text:'我住在海城。'},
  ...(image?[{message_id:id(4),sender:'contact',occurred_at:null,text_representation:'placeholder',text:'',content_kind:'image',
   image:{id:fileId,file_id:fileId,sha256:createHash('sha256').update(bytes).digest('hex'),mime_type:'image/png',media_generation:'0'}}]:[])]};
 const raw={text:'联系人住在海城。',subject:'contact',category:'recent_state',topic:'other',source_message_ids:image?[id(3),id(4)]:[id(3)],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成来源自述居住地。',event:null,conditions:null};
 const facts=parseDirectExtraction({scenes:[{scene_name:'居住',memories:[raw]}]},window).accepted;
 assert.equal(facts.length,1);
 return {window,facts,images:[{id:fileId,mimeType:'image/png',dataBase64:bytes.toString('base64')}],policy,requireCurrent:async()=>{}};
}
function prepare(s,image=false){return image?prepareMultimodalVerification(s):prepareSourceVerification(s);}
function noModelHashes(request){
 for(const value of [request.tool.parameters,JSON.parse(request.user)]){
  const serialized=JSON.stringify(value);
  assert.doesNotMatch(serialized,/request_fingerprint|sha256|[a-f0-9]{64}/);
 }
 assert.doesNotMatch(request.system,/回传.*(?:哈希|摘要|request_fingerprint)|sha256/);
}

test('新文字核验仅在本地保留指纹，模型请求和schema不含哈希',()=>{
 const prepared=prepare(scenario());
 assert.match(prepared.fingerprint,/^[a-f0-9]{64}$/);
 noModelHashes(prepared.request);
 assert.equal(JSON.parse(prepared.request.user).check_format,'local-ids-v3');
});

test('新图文核验请求使用消息标识，不向模型暴露文件摘要',()=>{
 const prepared=prepare(scenario(true),true);
 noModelHashes(prepared.request);
 assert.equal(JSON.parse(prepared.request.user).check_format,'local-ids-v3');
});

test('新格式解码与存档重放一致，图片文件身份由冻结窗口补全',async()=>{
 for(const image of [false,true]){
  const s=scenario(image),prepared=prepare(s,image),response=blocks(localResponse(image));
  const result=(await prepared.decode(response)).items[0];
  assert.equal(result.admitted,true);
  assert.equal(result.result.claim_validation.policy_fingerprint,prepared.fingerprint);
  if(image){
   assert.equal(result.result.content_evidence[1].file_id,id(5));
   assert.equal(result.result.content_evidence[1].sha256,s.window.messages[1].image.sha256);
  }
  const replay=image?replayMultimodalVerification:replayCompleteClaimVerification;
  const body=JSON.parse(prepared.request.user);
  assert.deepEqual(replay(s.window,s.facts,response,prepared.fingerprint,body)[0],result);
  const changed=structuredClone(body);changed.messages[0].text='其他来源';
  assert.throws(()=>replay(s.window,s.facts,response,prepared.fingerprint,changed),/stored_request_mismatch/);
 }
});

test('新图片证据拒绝未知消息、文字冒充图片和同一图片重复引用',async()=>{
 for(const mutate of [
  row=>{row.evidence[1].message_id=id(99);},
  row=>{row.evidence[1].message_id=id(3);},
  row=>{row.evidence.push({...row.evidence[1],description:'重复图片的另一描述。'});},
 ]){
  const prepared=prepare(scenario(true),true),value=localResponse(true);mutate(value.results[0]);
  await assert.rejects(prepared.decode(blocks(value)),/evidence_scope_invalid|image_evidence_invalid|evidence_duplicate/);
 }
});

test('图文消息标识沿用UUID规范化，接受窗口中的大写UUID',async()=>{
 const s=scenario(true),value=localResponse(true);
 const ids=[3,4].map(n=>`abcdef0${n}-1111-4111-8111-111111111111`);
 s.window.messages.forEach((message,index)=>{message.message_id=ids[index].toUpperCase();});
 s.window.target_message_ids=[ids[0]];s.facts[0].source_message_ids=ids;
 value.results[0].evidence.forEach((ref,index)=>{ref.message_id=ids[index];});
 const prepared=prepare(s,true);
 assert.equal((await prepared.decode(blocks(value))).items[0].admitted,true);
});

test('旧文本、nested与flat存档按冻结请求和回复重放，不接受格式篡改',()=>{
 for(const archive of archives){
  const original=JSON.stringify(archive),replay=archive.kind==='complete-claim-v1'?replayCompleteClaimVerification:replayMultimodalVerification;
  assert.equal(replay(archive.window,archive.facts,archive.blocks,archive.fingerprint,archive.body)[0].admitted,true);
  assert.equal(JSON.stringify(archive),original);
  assert.throws(()=>replay(archive.window,archive.facts,archive.blocks,'f'.repeat(64),archive.body),/stored_request_mismatch/);
  const changed={...archive.body,check_format:'local-ids-v3'};
  assert.throws(()=>replay(archive.window,archive.facts,archive.blocks,archive.fingerprint,changed),/stored_request_mismatch/);
 }
});

test('新格式不接收旧模型指纹字段，解码仍拒绝同一请求的响应变更',async()=>{
 for(const image of [false,true]){
  const prepared=prepare(scenario(image),image),value=localResponse(image);
  await prepared.request.validateOutput(blocks(value));
  value.results[0].issues.push('insufficient_evidence');
  await assert.rejects(prepared.decode(blocks(value)),/response_changed/);
  const another=prepare(scenario(image),image),legacy=localResponse(image);legacy.request_fingerprint=another.fingerprint;
  await assert.rejects(another.decode(blocks(legacy)),/structure_invalid/);
 }
});
