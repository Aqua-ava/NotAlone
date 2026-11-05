import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWechatImageResourcePort} from '../src/media/visual/wechat.ts';
import {loadNarrowWechatOptions,supportsWechatImageKeyChannel,supportsWechatOriginalImages} from '../src/history/wechat/artifacts.ts';
import {SharedWechatClient} from '../src/history/wechat/shared-client.ts';
import {NarrowWechatClient} from '../src/history/wechat/native-client.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const account='synthetic-owner',conversation='synthetic-friend',generation='a'.repeat(64),partition='d'.repeat(64),table='c'.repeat(64),schemaFingerprint='b'.repeat(64);
const token={owner_id:'00000000-0000-4000-8000-000000000091',contact_id:'00000000-0000-4000-8000-000000000092',account_id:'00000000-0000-4000-8000-000000000093',conversation_id:'00000000-0000-4000-8000-000000000094',binding_id:'00000000-0000-4000-8000-000000000095',grant_id:'00000000-0000-4000-8000-000000000096',verification_id:'00000000-0000-4000-8000-000000000097',read_epoch:'1',selection_generation:'1',data_generation:'1',identity_generation:'1',scope_revision:'1',barrier_generation:'1',source_generation:generation};
const resourceId='9007199254740993',resourceInfoId='9007199254741000',matchingResourceIds=[resourceId,'9007199254740994'];
function imageBytes(length){const bytes=Buffer.alloc(length);for(let index=0;index<length;index++)bytes[index]=index%251;return bytes;}

function classifiedImageProof(sourceVariant='thumbnail',original=false){
 const digest=hash(imageBytes(70_000));
 const proof={kind:'wechat-message-image-content-v2',resourceInfoId,matchingResourceIds,resourceSize:70_000,
  verifiedBytes:70_000,verifiedSha256:digest,sourceSha256:digest,conversion:'none',contentWidth:96,contentHeight:210,
  sourceVariant,matchingResources:matchingResourceIds.map(resourceId=>({resourceId,resourceTypeRaw:65537})),originalProof:null};
 if(original)proof.originalProof={kind:'wechat-cdn-big-hd-exact-content-v4',messageMd5:'f'.repeat(32),hdLength:70_000,
  hdWidth:null,hdHeight:null,bigImageUrlPresent:true,resourceSize:70_000,verifiedBytes:70_000,verifiedSha256:digest,
  contentWidth:96,contentHeight:210,resourceInfoId,matchingResourceIds,sourceSha256:digest,conversion:'none'};
 return proof;
}

test('标准图和高清图可读取；缩略图关闭句柄并以仅缩略图失败，不读字节，像素尺寸不决定类别',async t=>{
 for(const [name,proof,quality,saved] of [
  ['小尺寸高清图',classifiedImageProof('main',true),'original',true],
  ['普通标准图',classifiedImageProof('main'),'unknown',true],
  ['大尺寸缩略图',{...classifiedImageProof(),contentWidth:3000,contentHeight:2000},'thumbnail',false],
 ])await t.test(name,async t=>{
  const f=await fixture(t,{proof,capability:proof.kind,openAudit:{quality,resourceTypeRaw:65537,variantCode:1}});
  if(!saved){
   await assert.rejects(createWechatImageResourcePort(f.executable).open(selection()),{code:'media_thumbnail_only'});
   const operations=(await requests(f)).map(row=>row.op);
   assert.ok(operations.includes('image-open'));assert.ok(operations.includes('image-close'));assert.equal(operations.includes('image-read'),false);
   const pid=Number(await readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
   return;
  }
  const resource=await createWechatImageResourcePort(f.executable).open(selection());
  try{
   assert.equal('quality' in resource,false);assert.equal(resource.complete,true);assert.equal(resource.expectedBytes,70_000);
   const chunks=[];for await(const chunk of resource.bytes)chunks.push(Buffer.from(chunk));assert.deepEqual(Buffer.concat(chunks),imageBytes(70_000));
  }finally{await resource.close();}
 });
});

test('微信图片资源依据变造或不一致时拒绝',async t=>{
 const original=classifiedImageProof('main',true),thumbnail=classifiedImageProof();
 for(const [name,proof,quality,audit] of [
  ['缩略图冒充原图',thumbnail,'original',{}],
  ['未证明的主图冒充原图',classifiedImageProof('main'),'original',{}],
  ['资源类型错配',thumbnail,'thumbnail',{resourceTypeRaw:131073,variantCode:2}],
  ['资源ID错配',{...thumbnail,matchingResources:[{resourceId:'1',resourceTypeRaw:65537}]},'thumbnail',{}],
  ['原图证明来自别的内容',{...original,originalProof:{...original.originalProof,sourceSha256:'b'.repeat(64)}},'original',{}],
  ['缩略图夹带原图证明',{...thumbnail,originalProof:original.originalProof},'thumbnail',{}],
 ])await t.test(name,async t=>{
  const f=await fixture(t,{proof,capability:proof.kind,openAudit:{quality,resourceTypeRaw:65537,variantCode:1,...audit}});
  await assert.rejects(createWechatImageResourcePort(f.executable).open(selection()));
 });
});

test('旧读取组件没有声明原图协议时不启用自动取图',async t=>{
 const f=await fixture(t);
 const path=join(f.executable,'../../manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));
 delete manifest.originalImageProtocol;delete manifest.originalImageQualityProof;await writeFile(path,JSON.stringify(manifest));
 assert.equal(await supportsWechatOriginalImages(f.executable),false);
 manifest.originalImageProtocol='wechat-original-image-v1';await writeFile(path,JSON.stringify(manifest));
 assert.equal(await supportsWechatOriginalImages(f.executable),false);
 manifest.originalImageQualityProof='wechat-cdn-big-hd-exact-content-v3';await writeFile(path,JSON.stringify(manifest));
 assert.equal(await supportsWechatOriginalImages(f.executable),false);
 assert.equal(await supportsWechatImageKeyChannel(f.executable),false);
 const denied=new NarrowWechatClient({...await loadNarrowWechatOptions(f.executable),imageKeyChannel:true});
 await assert.rejects(denied.resolveSelected(conversation),{code:'history_artifact_unverified'});await denied.close();
 manifest.originalImageQualityProof='wechat-cdn-big-hd-exact-content-v4';await writeFile(path,JSON.stringify(manifest));
 assert.equal(await supportsWechatOriginalImages(f.executable),false);assert.equal(await supportsWechatImageKeyChannel(f.executable),true);
 manifest.originalImageQualityProof='wechat-message-image-content-v1';await writeFile(path,JSON.stringify(manifest));
 assert.equal(await supportsWechatOriginalImages(f.executable),true);assert.equal(await supportsWechatImageKeyChannel(f.executable),true);
 assert.equal(await supportsWechatOriginalImages(undefined),false);
});

async function fixture(t,{proof:proofOverride,nativeError=null,otherError=null,manifestExtra={},dataLength=70_000,openAudit={},representativeId=resourceId,capability='wechat-cdn-big-hd-exact-content-v4'}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-wechat-image-resource-'))),artifact=join(root,'artifact');
 await mkdir(join(artifact,'bin'),{recursive:true});await mkdir(join(artifact,'lib'));
 const executable=join(artifact,'bin','wx-cli'),requestsFile=join(root,'requests'),pidFile=join(root,'pid'),keySeenFile=join(root,'key-seen');
 const bytes=imageBytes(dataLength);
 const expectedSha256=hash(bytes),resourceSourceGeneration=hash('synthetic-message-resource-instance'),base64=bytes.toString('base64');
 const proof=proofOverride??{kind:'wechat-cdn-big-hd-exact-content-v1',messageMd5:'f'.repeat(32),hdLength:bytes.length,hdWidth:1,hdHeight:1,bigImageUrlPresent:true,resourceSize:bytes.length,verifiedBytes:bytes.length,verifiedSha256:expectedSha256};
 const script=`#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
const log=${JSON.stringify(requestsFile)},pidFile=${JSON.stringify(pidFile)},keySeenFile=${JSON.stringify(keySeenFile)},data=Buffer.from(${JSON.stringify(base64)},'base64'),audit=${JSON.stringify(openAudit)},representativeId=${JSON.stringify(representativeId)};
const generation=${JSON.stringify(generation)},partition=${JSON.stringify(partition)},table=${JSON.stringify(table)},fingerprint=${JSON.stringify(schemaFingerprint)};
const account=${JSON.stringify(account)},target='synthetic-target',resourceToken='synthetic-opaque-resource-token';let conversation=${JSON.stringify(conversation)},blockReads=false,imageAttempts=0;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),scopeDigest=hash(account+'\\0'+conversation),expectedSha256=hash(data);
fs.writeFileSync(pidFile,String(process.pid));if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest,sourceGeneration:generation,schemaFingerprint:fingerprint,tables:[{target:table,partition,role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:'2'}],checkedPartitions:[partition]};
const support={protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:account,conversationKey:conversation,sourceGeneration:generation,programVersion:'synthetic',build:'1',artifactSha256:hash(fs.readFileSync(process.argv[1])),schemaFingerprint:fingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-v1',continuity:'synthetic-fixed-source-v1'};
const proof=${JSON.stringify(proof)},nativeError=${JSON.stringify(nativeError)},otherError=${JSON.stringify(otherError)};
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(r)+'\\n');let value;
if(r.op==='image-open'&&nativeError&&imageAttempts++===0){console.log(JSON.stringify({ok:false,error:{code:nativeError}}));return;}
if(otherError&&r.op===otherError.op){console.log(JSON.stringify({ok:false,error:{code:otherError.code}}));return;}
if(r.op==='image-open'&&r.serverId==='999'){console.log(JSON.stringify({ok:false,error:{code:'history_image_original_unavailable'}}));return;}
if(r.op==='resolve'){conversation=r.displayName;schema.scopeDigest=hash(account+'\\0'+conversation);support.conversationKey=conversation;value={accountKey:account,conversationKey:conversation,displayName:'合成甲',sourceGeneration:generation};}
else if(r.op==='inspect')value=schema;
else if(r.op==='support')value=support;
else if(r.op==='target')value={protocol:'private-history-v1',descriptor:target,partitions:[partition],tables:[{partition,instance:table}],sourceGeneration:generation,checkedPartitions:[partition]};
else if(r.op==='image-open'){if(r.imageKeySupplied){const raw=fs.readFileSync(3),payload=JSON.parse(raw.toString('utf8')),aes=Buffer.from(payload.aesKey,'base64');fs.writeFileSync(keySeenFile,JSON.stringify({fd:process.env.NOTALONE_IMAGE_KEY_FD,accountKey:payload.accountKey,rootSha256:payload.rootSha256,aesBytes:aes.length,xorKey:payload.xorKey}));raw.fill(0);aes.fill(0);}blockReads=r.localId==='125';value={protocol:'wechat-original-image-v1',resourceToken,sourceGeneration:generation,resourceSourceGeneration:${JSON.stringify(resourceSourceGeneration)},target:r.target,partition:r.partition,table:r.table,localId:r.localId==='124'?'125':r.localId,serverId:r.serverId,sentAt:r.sentAt,resourceTable:'wechat-message-resource-v1',resourceId:representativeId,resourceTypeRaw:audit.resourceTypeRaw??3,variantCode:audit.variantCode??1,complete:true,quality:audit.quality??'original',qualityProof:proof,expectedBytes:data.length,expectedSha256,mimeType:'image/png',envelope:'plain',sourceEnvelope:'wechat_dat'};}
else if(r.op==='image-read'){if(blockReads)return;const chunk=data.subarray(r.offset,Math.min(data.length,r.offset+65536));value={resourceToken,sourceGeneration:generation,offset:r.offset,bytesRead:chunk.length,totalBytes:data.length,chunkBase64:chunk.toString('base64'),eof:r.offset+chunk.length===data.length,...(r.offset+chunk.length===data.length?{verifiedSha256:expectedSha256}:{})};}
else if(r.op==='image-close')value={closed:true};
else if(r.op==='release-selection')value={released:true};
else{console.log(JSON.stringify({ok:false,error:{code:'history_operation_unsupported'}}));return;}
console.log(JSON.stringify({ok:true,data:value}));});`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-wcdb');await writeFile(join(artifact,'lib','libWCDB.dylib'),wcdb);
 await writeFile(join(artifact,'manifest.json'),JSON.stringify({formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,
  sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',
  signing:'ad-hoc-development',realWechatVerified:false,cliSha256:hash(script),wcdbSha256:hash(wcdb),
  originalImageProtocol:'wechat-original-image-v1',originalImageQualityProof:capability,...manifestExtra}));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,executable,requestsFile,pidFile,keySeenFile,bytes,expectedSha256,resourceSourceGeneration};
}
async function requests(f){return (await readFile(f.requestsFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
async function waitForOperation(f,op){
 const has=async()=>{try{return (await requests(f)).some(row=>row.op===op);}catch{return false;}};if(await has())return;
 await new Promise((resolve,reject)=>{let watcher;const timer=setTimeout(()=>{watcher?.close();reject(new Error('synthetic_request_missing'));},5000);const check=async()=>{if(await has()){clearTimeout(timer);watcher?.close();resolve();}};watcher=watch(f.requestsFile,()=>void check());void check();});
}
const selection=(signal=new AbortController().signal)=>({contactId:token.contact_id,messageId:'00000000-0000-4000-8000-000000000098',kind:'image',goal:'extract',token:{...token},source:{recordId:'00000000-0000-4000-8000-000000000099',contactId:token.contact_id,messageId:'00000000-0000-4000-8000-000000000098',captureId:'00000000-0000-4000-8000-000000000100',goalId:'history-goal',itemNo:1,capturedAt:'2026-10-31T00:00:00.000Z',adapterVersion:'synthetic-v1',normalizerVersion:'synthetic-v1',cursorIn:null,cursorOut:null,
 raw:{partition,table,localId:'123',serverId:'456',sender:'contact',kind:'image',text:null,originalType:'3',sentAt:'1700000000000',timePrecision:'millisecond',orderScheme:null,orderKey:null,status:null,stateAssurance:'verified'},support:{protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:account,conversationKey:conversation,sourceGeneration:generation,programVersion:'synthetic',build:'1',artifactSha256:'0'.repeat(64),schemaFingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-v1',continuity:'synthetic-fixed-source-v1'}},signal,checkpoint:async()=>{}});

test('已授权图片资源按原始来源元组读取并校验完整原图',async t=>{
 const f=await fixture(t),request=selection(),port=createWechatImageResourcePort(f.executable),resource=await port.open(request);
 assert.equal(resource.envelope,'plain');assert.equal(resource.complete,true);assert.equal(resource.expectedBytes,f.bytes.length);assert.equal(resource.expectedSha256,f.expectedSha256);
 assert.equal('quality' in resource,false);assert.deepEqual(resource.authority,token);
 assert.equal(resource.association.protocol,'media-association-v1');assert.equal(resource.association.recordId,request.source.recordId);assert.equal(resource.association.messageId,request.messageId);
 const chunks=[];for await(const chunk of resource.bytes)chunks.push(Buffer.from(chunk));assert.deepEqual(Buffer.concat(chunks),f.bytes);
 await resource.close();const rows=await requests(f);
 assert.deepEqual(rows.map(row=>row.op),['resolve','inspect','support','target','image-open','image-read','image-read','image-close']);
 assert.deepEqual({target:rows[4].target,partition:rows[4].partition,table:rows[4].table,localId:rows[4].localId,serverId:rows[4].serverId,sentAt:rows[4].sentAt},
  {target:'synthetic-target',partition,table,localId:'123',serverId:'456',sentAt:'1700000000000'});
 const pid=Number(await readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('v4仅在选定账号遇到缺图密钥后通过一次性fd3传递密钥并重试',async t=>{
 const f=await fixture(t,{nativeError:'history_image_key_unavailable'}),options=await loadNarrowWechatOptions(f.executable);
 const client=new NarrowWechatClient(options),request=selection(),identity={partition,table,localId:'123',serverId:'456',sentAt:'1700000000000'};
 t.after(()=>client.close());
 await client.resolveSelected(conversation);await client.inspectSelected();await client.supportSelected();const target=await client.targetSelected();
 await assert.rejects(client.openImageSelected(target,identity),{code:'history_image_key_unavailable'});assert.equal(client.stoppedReason,null);
 const aesKey=Uint8Array.from({length:16},(_,index)=>index+1);
 await client.supplyImageRuntimeKey({accountKey:account,rootSha256:'a'.repeat(64),aesKey,xorKey:91});
 assert.deepEqual([...aesKey],Array(16).fill(0));
 const opened=await client.openImageSelected(target,identity);assert.equal(opened.quality,'original');
 const seen=JSON.parse(await readFile(f.keySeenFile,'utf8'));assert.deepEqual(seen,{fd:'3',accountKey:account,rootSha256:'a'.repeat(64),aesBytes:16,xorKey:91});
 const imageOpens=(await requests(f)).filter(row=>row.op==='image-open');assert.equal('imageKeySupplied' in imageOpens[0],false);assert.equal(imageOpens[1].imageKeySupplied,true);
 await client.closeImageSelected(opened.resourceToken);
});

test('v2证明允许原文未声明尺寸',async t=>{
 const proof={kind:'wechat-cdn-big-hd-exact-content-v2',messageMd5:'f'.repeat(32),hdLength:70_000,hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:70_000,verifiedBytes:70_000,verifiedSha256:hash(Buffer.from(Array.from({length:70_000},(_,index)=>index%251))),contentWidth:280,contentHeight:250};
 const f=await fixture(t,{proof}),resource=await createWechatImageResourcePort(f.executable).open(selection());
 assert.equal(resource.expectedBytes,70_000);
 await resource.close();
});

test('v2声明尺寸伪造或证明字段不完整时拒绝',async t=>{
 const base={kind:'wechat-cdn-big-hd-exact-content-v2',messageMd5:'f'.repeat(32),hdLength:70_000,hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:70_000,verifiedBytes:70_000,verifiedSha256:hash(Buffer.from(Array.from({length:70_000},(_,index)=>index%251))),contentWidth:280,contentHeight:250};
 for(const proof of [
  {...base,hdLength:69_999},
  {...base,hdWidth:281,hdHeight:250},
  {...base,hdWidth:null,hdHeight:250},
  {...base,contentWidth:100_001,contentHeight:1},
  {...base,contentWidth:10_000,contentHeight:10_001},
  Object.fromEntries(Object.entries(base).filter(([key])=>key!=='contentHeight')),
 ]){
  const f=await fixture(t,{proof});
  await assert.rejects(createWechatImageResourcePort(f.executable).open(selection()),{code:'media_quality_unverified'});
 }
});

test('v3验证封装长度与明文长度分离，并以Info和匹配detail集合建立资源身份',async t=>{
 const bytes=imageBytes(41_987),proof={kind:'wechat-cdn-big-hd-exact-content-v3',messageMd5:'f'.repeat(32),hdLength:bytes.length,hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:42_018,verifiedBytes:bytes.length,verifiedSha256:hash(bytes),contentWidth:280,contentHeight:250,
  resourceInfoId,matchingResourceIds};
 const f=await fixture(t,{proof,dataLength:bytes.length}),resource=await createWechatImageResourcePort(f.executable).open(selection());
 assert.equal(resource.expectedBytes,41_987);
 const chunks=[];for await(const chunk of resource.bytes)chunks.push(Buffer.from(chunk));assert.deepEqual(Buffer.concat(chunks),bytes);
 await resource.close();

 const alternate=await fixture(t,{proof,dataLength:bytes.length,openAudit:{resourceTypeRaw:5,variantCode:99}});
 const alternateResource=await createWechatImageResourcePort(alternate.executable).open(selection());
 assert.equal(alternateResource.association.resourceIdentity,resource.association.resourceIdentity);
 await alternateResource.close();
});

test('v4证明覆盖WXGF源摘要和转换，并把两者纳入资源关联身份',async t=>{
 const bytes=imageBytes(41_987),shared={kind:'wechat-cdn-big-hd-exact-content-v4',messageMd5:'f'.repeat(32),hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:42_018,verifiedBytes:bytes.length,verifiedSha256:hash(bytes),contentWidth:280,contentHeight:250,
  resourceInfoId,matchingResourceIds};
 const plain={...shared,hdLength:bytes.length,sourceSha256:hash(bytes),conversion:'none'};
 const plainFixture=await fixture(t,{proof:plain,dataLength:bytes.length}),plainResource=await createWechatImageResourcePort(plainFixture.executable).open(selection());
 const converted={...shared,hdLength:41_123,sourceSha256:hash(Buffer.from('synthetic decrypted WXGF source')),conversion:'wxgf-to-png-v1'};
 const convertedFixture=await fixture(t,{proof:converted,dataLength:bytes.length}),convertedResource=await createWechatImageResourcePort(convertedFixture.executable).open(selection());
 assert.notEqual(convertedResource.association.resourceIdentity,plainResource.association.resourceIdentity);
 await plainResource.close();await convertedResource.close();
});

test('v4校验原始解密长度、64MiB封装上限和none转换的源内容摘要',async t=>{
 const bytes=imageBytes(41_987),base={kind:'wechat-cdn-big-hd-exact-content-v4',messageMd5:'f'.repeat(32),hdLength:41_123,hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:42_018,verifiedBytes:bytes.length,verifiedSha256:hash(bytes),contentWidth:280,contentHeight:250,
  resourceInfoId,matchingResourceIds,sourceSha256:hash(Buffer.from('synthetic decrypted WXGF source')),conversion:'wxgf-to-png-v1'};
 const invalid=[
  {...base,conversion:'wxgf-to-png-v2'},
  {...base,sourceSha256:'x'.repeat(64)},
  {...base,hdLength:0},
  {...base,resourceSize:67_108_865},
  {...base,conversion:'none'},
  {...base,conversion:'none',hdLength:bytes.length,sourceSha256:'0'.repeat(64)},
 ];
 for(const proof of invalid){
  const f=await fixture(t,{proof,dataLength:bytes.length});
  await assert.rejects(createWechatImageResourcePort(f.executable).open(selection()),{code:'media_quality_unverified'});
 }
});

test('v3必须包含有序且唯一的detail ID集合，并核对代表ID与封装长度上限',async t=>{
 const bytes=imageBytes(41_987),base={kind:'wechat-cdn-big-hd-exact-content-v3',messageMd5:'f'.repeat(32),hdLength:bytes.length,hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:42_018,verifiedBytes:bytes.length,verifiedSha256:hash(bytes),contentWidth:280,contentHeight:250,
  resourceInfoId,matchingResourceIds};
 const invalid=[
  {...base,matchingResourceIds:[matchingResourceIds[1],matchingResourceIds[0]]},
  {...base,matchingResourceIds:[resourceId,resourceId]},
  {...base,matchingResourceIds:['9007199254740995','9007199254740996']},
  {...base,matchingResourceIds:Array.from({length:33},(_,index)=>String(BigInt(resourceId)+BigInt(index)))},
  {...base,resourceInfoId:'0'},
  {...base,resourceSize:67_108_865},
 ];
 for(const proof of invalid){
  const f=await fixture(t,{proof,dataLength:bytes.length});
  await assert.rejects(createWechatImageResourcePort(f.executable).open(selection()),{code:'media_quality_unverified'});
 }
 const f=await fixture(t,{proof:base,dataLength:bytes.length,representativeId:'9007199254740994'});
 await assert.rejects(createWechatImageResourcePort(f.executable).open(selection()),{code:'media_quality_unverified'});
});

test('原生图片获取阶段错误保留为明确媒体状态',async t=>{
 for(const [nativeError,mediaError] of [
  ['history_image_metadata_invalid','media_metadata_invalid'],
  ['history_image_local_file_missing','media_local_file_missing'],
  ['history_image_key_unavailable','needs_image_key'],
  ['history_image_quality_unverified','media_quality_unverified'],
  ['history_image_thumbnail_only','media_thumbnail_only'],
  ['history_image_format_unsupported','media_format_unsupported'],
  ['history_image_decoder_unavailable','media_validator_unavailable'],
 ]){
  const f=await fixture(t,{nativeError});
  await assert.rejects(createWechatImageResourcePort(f.executable).open(selection()),{code:mediaError});
 }
});


test('原图缺失返回媒体获取失败并释放原生客户端',async t=>{
 const f=await fixture(t),request=selection();request.source.raw.serverId='999';const port=createWechatImageResourcePort(f.executable);
 await assert.rejects(port.open(request),{code:'media_original_unavailable'});
 const rows=await requests(f);assert.deepEqual(rows.map(row=>row.op),['resolve','inspect','support','target','image-open']);
 const pid=Number(await readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('返回前必须复验已保存消息的精确身份，失配时不读取字节',async t=>{
 const f=await fixture(t),request=selection();request.source.raw.localId='124';const port=createWechatImageResourcePort(f.executable);
 await assert.rejects(port.open(request),{code:'media_association_unverified'});
 const rows=await requests(f);assert.deepEqual(rows.map(row=>row.op),['resolve','inspect','support','target','image-open']);
 const pid=Number(await readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});


test('取消在途原图读取会关闭原生客户端',async t=>{
 const f=await fixture(t),controller=new AbortController(),request=selection(controller.signal);request.source.raw.localId='125';
 const resource=await createWechatImageResourcePort(f.executable).open(request),pending=resource.bytes[Symbol.asyncIterator]().next();
 await waitForOperation(f,'image-read');controller.abort();
 await assert.rejects(pending,{code:'media_interrupted'});await resource.close();
 const pid=Number(await readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});


test('已关联图片按完整内容读取',async t=>{
 const bytes=imageBytes(70_000),sha=hash(bytes);
 const proof={kind:'wechat-message-image-content-v1',resourceInfoId,matchingResourceIds,resourceSize:70_000,
  verifiedBytes:70_000,verifiedSha256:sha,sourceSha256:sha,conversion:'none',contentWidth:280,contentHeight:250};
 const f=await fixture(t,{proof,openAudit:{quality:'unknown'},capability:proof.kind});
 const request={...selection(),goal:'extract'},resource=await createWechatImageResourcePort(f.executable).open(request);
 try{
  assert.equal('quality' in resource,false);
  const chunks=[];for await(const chunk of resource.bytes)chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks),bytes);
  assert.equal(resource.association.recordId,request.source.recordId);
 }finally{await resource.close();}
});


test('仍拒绝传输摘要和来源资源集合不一致',async t=>{
 const sha=hash(imageBytes(70_000));
 const valid={kind:'wechat-message-image-content-v1',resourceInfoId,matchingResourceIds,resourceSize:70_000,
  verifiedBytes:70_000,verifiedSha256:sha,sourceSha256:sha,conversion:'none',contentWidth:280,contentHeight:250};
 for(const override of [{verifiedBytes:69_999},{verifiedSha256:'f'.repeat(64)},{sourceSha256:'f'.repeat(64)},
  {matchingResourceIds:[matchingResourceIds[1],matchingResourceIds[0]]}]){
  const proof={...valid,...override};const f=await fixture(t,{proof,openAudit:{quality:'unknown'},capability:proof.kind});
  await assert.rejects(createWechatImageResourcePort(f.executable).open({...selection(),goal:'extract'}));
 }
});


test('共享图片资源持有完整流租约，关闭后下一资源复用同一进程',async t=>{
 const f=await fixture(t),shared=new SharedWechatClient(()=>loadNarrowWechatOptions(f.executable));
 t.after(()=>shared.close());
 const port=createWechatImageResourcePort(f.executable,shared),first=await port.open(selection());
 const pid=Number(await readFile(f.pidFile,'utf8'));
 let nextOpened=false;
 const secondRequest=selection();secondRequest.contactId='00000000-0000-4000-8000-000000000093';secondRequest.token={...secondRequest.token,contact_id:secondRequest.contactId};secondRequest.source.contactId=secondRequest.contactId;secondRequest.source.support.conversationKey='synthetic-friend-b';
 const next=port.open(secondRequest).then(resource=>{nextOpened=true;return resource;});
 for await(const chunk of first.bytes)assert.ok(chunk.length>0);
 assert.equal(nextOpened,false);
 await first.close();const second=await next;
 assert.equal(Number(await readFile(f.pidFile,'utf8')),pid);
 const recorded=await requests(f),operations=recorded.map(row=>row.op);
 assert.deepEqual(recorded.filter(row=>row.op==='resolve').map(row=>row.displayName),[conversation,'synthetic-friend-b']);
 assert.equal(operations.filter(op=>op==='release-selection').length,1);
 assert.ok(operations.indexOf('image-close')<operations.indexOf('release-selection'));
 for await(const chunk of second.bytes)assert.ok(chunk.length>0);
 await second.close();assert.doesNotThrow(()=>process.kill(pid,0));
 await shared.close();assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});


// 单图 image-open 失败的进程隔离：仅声明 imageOpenIsolation 的制品、仅 image-open、仅封闭集合内的错误码才保留进程。
const isolationManifest={imageOpenIsolation:'wechat-image-open-local-v1'};
const openIdentity={partition,table,localId:'123',serverId:'456',sentAt:'1700000000000'};
async function openedClient(f){
 const client=new NarrowWechatClient(await loadNarrowWechatOptions(f.executable));
 await client.resolveSelected(conversation);await client.inspectSelected();await client.supportSelected();
 return {client,target:await client.targetSelected()};
}
const pidOf=async f=>Number(await readFile(f.pidFile,'utf8'));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('已声明单图隔离的制品：封闭集合内的 image-open 错误只拒绝本次请求，进程和选择保留',async t=>{
 for(const code of ['history_image_association_unverified','history_image_local_file_missing','history_image_quality_unverified','history_image_format_unsupported','history_image_decoder_unavailable'])await t.test(code,async t=>{
  const f=await fixture(t,{nativeError:code,manifestExtra:isolationManifest}),{client,target}=await openedClient(f);
  t.after(()=>client.close());
  const pid=await pidOf(f);
  await assert.rejects(client.openImageSelected(target,openIdentity),{code});
  assert.equal(client.stoppedReason,null);assert.equal(alive(pid),true);
  const opened=await client.openImageSelected(target,openIdentity);
  assert.equal(opened.sourceGeneration,generation);assert.equal(client.stoppedReason,null);assert.equal(await pidOf(f),pid);
  const ops=(await requests(f)).map(row=>row.op);
  assert.deepEqual(ops,['resolve','inspect','support','target','image-open','image-open'],'失败后不得重新 resolve 或重建进程');
 });
});

test('单图隔离不放行来源、会话、资源状态与未知错误，这些仍终止读取',async t=>{
 for(const code of ['history_image_source_changed','history_image_read_failed','history_image_request_invalid','history_image_too_large','history_image_token_invalid',
  'history_image_offset_invalid','history_image_resource_invalid','history_image_metadata_invalid','history_image_original_unavailable','history_image_thumbnail_only',
  'history_source_changed','history_source_unverified','history_target_unverified','history_target_ambiguous','history_scope_unverified','history_support_unverified',
  'history_snapshot_closed','history_account_changed','history_scope_changed','sensitive-arbitrary-native-value'])await t.test(code,async t=>{
  const f=await fixture(t,{nativeError:code,manifestExtra:isolationManifest}),{client,target}=await openedClient(f);
  t.after(()=>client.close());
  const pid=await pidOf(f),expected=code==='sensitive-arbitrary-native-value'?'history_protocol_invalid':code;
  await assert.rejects(client.openImageSelected(target,openIdentity),{code:expected});
  assert.equal(client.stoppedReason,expected);
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(alive(pid),false);
 });
});

test('旧制品没有声明单图隔离时，同样的 image-open 错误仍终止读取',async t=>{
 const f=await fixture(t,{nativeError:'history_image_association_unverified'}),{client,target}=await openedClient(f);
 t.after(()=>client.close());
 const pid=await pidOf(f);
 assert.equal((await loadNarrowWechatOptions(f.executable)).imageOpenIsolation,undefined);
 const forced=new NarrowWechatClient({...await loadNarrowWechatOptions(f.executable),imageOpenIsolation:true});
 await assert.rejects(forced.resolveSelected(conversation),{code:'history_artifact_unverified'});await forced.close();
 await assert.rejects(client.openImageSelected(target,openIdentity),{code:'history_image_association_unverified'});
 assert.equal(client.stoppedReason,'history_image_association_unverified');
 await new Promise(resolve=>setTimeout(resolve,50));assert.equal(alive(pid),false);
});

test('未知或不同的隔离声明不启用单图隔离',async t=>{
 for(const value of ['unverified','wechat-image-open-local-v2',true,1]){
  const f=await fixture(t,{manifestExtra:{imageOpenIsolation:value}});
  assert.equal((await loadNarrowWechatOptions(f.executable)).imageOpenIsolation,undefined,String(value));
 }
 const f=await fixture(t,{manifestExtra:isolationManifest});
 assert.equal((await loadNarrowWechatOptions(f.executable)).imageOpenIsolation,true);
});

test('image-read 与 image-close 不因错误码相同而获得可恢复资格',async t=>{
 for(const op of ['image-read','image-close'])await t.test(op,async t=>{
  const f=await fixture(t,{otherError:{op,code:'history_image_association_unverified'},manifestExtra:isolationManifest}),{client,target}=await openedClient(f);
  t.after(()=>client.close());
  const pid=await pidOf(f),opened=await client.openImageSelected(target,openIdentity);
  await assert.rejects(op==='image-read'?client.readImageSelected(opened.resourceToken,0):client.closeImageSelected(opened.resourceToken),{code:'history_image_association_unverified'});
  assert.equal(client.stoppedReason,'history_image_association_unverified');
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(alive(pid),false);
 });
});
