import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareSourceVerification} from '../src/memory/extraction/verification/complete-claim.ts';
import {prepareMultimodalVerification} from '../src/memory/extraction/multimodal.ts';

const archives=JSON.parse(readFileSync(new URL('./fixtures/verification-hash-archives.json',import.meta.url),'utf8'));
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const hashPattern=/[a-f0-9]{64}/iu;

/** 沿用旧存档中的合成资料，仅扩展候选数和共享图片数。 */
function scenario(candidateCount,imageCount){
 const archive=archives.find(item=>item.kind===(imageCount?'flat-fields-v2':'complete-claim-v1'));
 const window=structuredClone(archive.window),template=window.messages[0],textCount=Math.min(candidateCount,20);
 window.messages=Array.from({length:textCount},(_,index)=>({...template,message_id:id(100+index)}));
 window.target_message_ids=window.messages.map(message=>message.message_id);
 const imageMessages=Array.from({length:imageCount},(_,index)=>{
  const message=structuredClone(archive.window.messages[1]);
  message.message_id=id(1000+index);
  message.image.id=id(2000+index);
  message.image.file_id=message.image.id;
  return message;
 });
 window.messages.push(...imageMessages);
 const facts=Array.from({length:candidateCount},(_,index)=>({
  ...structuredClone(archive.facts[0]),
  source_message_ids:[window.messages[index%textCount].message_id,...imageMessages.map(message=>message.message_id)],
 }));
 const bytes=Buffer.from('synthetic-image-local-ids');
 return {window,facts,images:imageMessages.map(message=>({id:message.image.id,mimeType:'image/png',dataBase64:bytes.toString('base64')})),
  policy:{id:'complete-claim-v1',rule_version:'a'.repeat(64)},requireCurrent:async()=>{}};
}

function assertNoModelHash(prepared){
 assert.match(prepared.fingerprint,/^[a-f0-9]{64}$/u,'核验指纹仍在本地保留');
 const request=prepared.request;
 assert.ok(request);
 assert.equal(JSON.parse(request.user).check_format,'local-ids-v3');
 for(const [part,text] of Object.entries({system:request.system,payload:request.user,schema:JSON.stringify(request.tool.parameters)})){
  assert.doesNotMatch(text,hashPattern,`${part} 不应泄漏任意64位十六进制串`);
  assert.doesNotMatch(text,/request_fingerprint|sha256/iu,`${part} 不应要求模型处理哈希字段`);
 }
}

for(const candidateCount of [5,20,60]){
 test(`完整命题 ${candidateCount} 候选请求的 system、payload、schema 均无哈希`,()=>{
  assertNoModelHash(prepareSourceVerification(scenario(candidateCount,0)));
 });
 for(const imageCount of [1,3])test(`图文 ${candidateCount} 候选/${imageCount} 图片请求的 system、payload、schema 均无哈希`,()=>{
  assertNoModelHash(prepareMultimodalVerification(scenario(candidateCount,imageCount)));
 });
}
