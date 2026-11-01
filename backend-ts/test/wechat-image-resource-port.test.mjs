import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWechatImageResourcePort} from '../src/media/visual/wechat.ts';
import {loadNarrowWechatOptions,supportsWechatImageKeyChannel,supportsWechatOriginalImages} from '../src/history/wechat/artifacts.ts';
import {NarrowWechatClient} from '../src/history/wechat/native-client.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const account='synthetic-owner',conversation='synthetic-friend',generation='a'.repeat(64),partition='d'.repeat(64),table='c'.repeat(64),schemaFingerprint='b'.repeat(64);
const token={owner_id:'00000000-0000-4000-8000-000000000091',contact_id:'00000000-0000-4000-8000-000000000092',account_id:'00000000-0000-4000-8000-000000000093',conversation_id:'00000000-0000-4000-8000-000000000094',binding_id:'00000000-0000-4000-8000-000000000095',grant_id:'00000000-0000-4000-8000-000000000096',verification_id:'00000000-0000-4000-8000-000000000097',read_epoch:'1',selection_generation:'1',data_generation:'1',identity_generation:'1',scope_revision:'1',barrier_generation:'1',source_generation:generation};
const resourceId='9007199254740993',resourceInfoId='9007199254741000',matchingResourceIds=[resourceId,'9007199254740994'];
function imageBytes(length){const bytes=Buffer.alloc(length);for(let index=0;index<length;index++)bytes[index]=index%251;return bytes;}

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

async function fixture(t,{proof:proofOverride,nativeError=null,dataLength=70_000,openAudit={},representativeId=resourceId,capability='wechat-cdn-big-hd-exact-content-v4'}={}){
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
const account=${JSON.stringify(account)},conversation=${JSON.stringify(conversation)},target='synthetic-target',resourceToken='synthetic-opaque-resource-token';let blockReads=false,imageAttempts=0;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),scopeDigest=hash(account+'\\0'+conversation),expectedSha256=hash(data);
fs.writeFileSync(pidFile,String(process.pid));if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest,sourceGeneration:generation,schemaFingerprint:fingerprint,tables:[{target:table,partition,role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:'2'}],checkedPartitions:[partition]};
const support={protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:account,conversationKey:conversation,sourceGeneration:generation,programVersion:'synthetic',build:'1',artifactSha256:hash(fs.readFileSync(process.argv[1])),schemaFingerprint:fingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-v1',continuity:'synthetic-fixed-source-v1'};
const proof=${JSON.stringify(proof)},nativeError=${JSON.stringify(nativeError)};
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(r)+'\\n');let value;
if(r.op==='image-open'&&nativeError&&imageAttempts++===0){console.log(JSON.stringify({ok:false,error:{code:nativeError}}));return;}
if(r.op==='image-open'&&r.serverId==='999'){console.log(JSON.stringify({ok:false,error:{code:'history_image_original_unavailable'}}));return;}
if(r.op==='resolve')value={accountKey:account,conversationKey:conversation,displayName:'合成甲',sourceGeneration:generation};
else if(r.op==='inspect')value=schema;
else if(r.op==='support')value=support;
else if(r.op==='target')value={protocol:'private-history-v1',descriptor:target,partitions:[partition],tables:[{partition,instance:table}],sourceGeneration:generation,checkedPartitions:[partition]};
else if(r.op==='image-open'){if(r.imageKeySupplied){const raw=fs.readFileSync(3),payload=JSON.parse(raw.toString('utf8')),aes=Buffer.from(payload.aesKey,'base64');fs.writeFileSync(keySeenFile,JSON.stringify({fd:process.env.NOTALONE_IMAGE_KEY_FD,accountKey:payload.accountKey,rootSha256:payload.rootSha256,aesBytes:aes.length,xorKey:payload.xorKey}));raw.fill(0);aes.fill(0);}blockReads=r.localId==='125';value={protocol:'wechat-original-image-v1',resourceToken,sourceGeneration:generation,resourceSourceGeneration:${JSON.stringify(resourceSourceGeneration)},target:r.target,partition:r.partition,table:r.table,localId:r.localId==='124'?'125':r.localId,serverId:r.serverId,sentAt:r.sentAt,resourceTable:'wechat-message-resource-v1',resourceId:representativeId,resourceTypeRaw:audit.resourceTypeRaw??3,variantCode:audit.variantCode??1,complete:true,quality:audit.quality??'original',qualityProof:proof,expectedBytes:data.length,expectedSha256,mimeType:'image/png',envelope:'plain',sourceEnvelope:'wechat_dat'};}
else if(r.op==='image-read'){if(blockReads)return;const chunk=data.subarray(r.offset,Math.min(data.length,r.offset+65536));value={resourceToken,sourceGeneration:generation,offset:r.offset,bytesRead:chunk.length,totalBytes:data.length,chunkBase64:chunk.toString('base64'),eof:r.offset+chunk.length===data.length,...(r.offset+chunk.length===data.length?{verifiedSha256:expectedSha256}:{})};}
else if(r.op==='image-close')value={closed:true};
else{console.log(JSON.stringify({ok:false,error:{code:'history_operation_unsupported'}}));return;}
console.log(JSON.stringify({ok:true,data:value}));});`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-wcdb');await writeFile(join(artifact,'lib','libWCDB.dylib'),wcdb);
 await writeFile(join(artifact,'manifest.json'),JSON.stringify({formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,
  sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',
  signing:'ad-hoc-development',realWechatVerified:false,cliSha256:hash(script),wcdbSha256:hash(wcdb),
  originalImageProtocol:'wechat-original-image-v1',originalImageQualityProof:capability}));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,executable,requestsFile,pidFile,keySeenFile,bytes,expectedSha256,resourceSourceGeneration};
}
async function requests(f){return (await readFile(f.requestsFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
async function waitForOperation(f,op){
 const has=async()=>{try{return (await requests(f)).some(row=>row.op===op);}catch{return false;}};if(await has())return;
 await new Promise((resolve,reject)=>{let watcher;const timer=setTimeout(()=>{watcher?.close();reject(new Error('synthetic_request_missing'));},5000);const check=async()=>{if(await has()){clearTimeout(timer);watcher?.close();resolve();}};watcher=watch(f.requestsFile,()=>void check());void check();});
}
const selection=(signal=new AbortController().signal)=>({contactId:token.contact_id,messageId:'00000000-0000-4000-8000-000000000098',kind:'image',goal:'original_upgrade',token:{...token},source:{recordId:'00000000-0000-4000-8000-000000000099',contactId:token.contact_id,messageId:'00000000-0000-4000-8000-000000000098',captureId:'00000000-0000-4000-8000-000000000100',goalId:'history-goal',itemNo:1,capturedAt:'2026-10-31T00:00:00.000Z',adapterVersion:'synthetic-v1',normalizerVersion:'synthetic-v1',cursorIn:null,cursorOut:null,
 raw:{partition,table,localId:'123',serverId:'456',sender:'contact',kind:'image',text:null,originalType:'3',sentAt:'1700000000000',timePrecision:'millisecond',orderScheme:null,orderKey:null,status:null,stateAssurance:'verified'},support:{protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:account,conversationKey:conversation,sourceGeneration:generation,programVersion:'synthetic',build:'1',artifactSha256:'0'.repeat(64),schemaFingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-v1',continuity:'synthetic-fixed-source-v1'}},signal,checkpoint:async()=>{}});

test('已授权图片资源按原始来源元组读取并校验完整原图',async t=>{
 const f=await fixture(t),request=selection(),port=createWechatImageResourcePort(f.executable),resource=await port.open(request);
 assert.equal(resource.envelope,'plain');assert.equal(resource.complete,true);assert.equal(resource.expectedBytes,f.bytes.length);assert.equal(resource.expectedSha256,f.expectedSha256);
 assert.equal(resource.quality.kind,'original');assert.match(resource.quality.proof,/^wechat-cdn-big-hd-exact-content-v1:/);assert.deepEqual(resource.authority,token);
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

test('v2证明允许原文未声明尺寸并将实读尺寸纳入质量证明',async t=>{
 const proof={kind:'wechat-cdn-big-hd-exact-content-v2',messageMd5:'f'.repeat(32),hdLength:70_000,hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:70_000,verifiedBytes:70_000,verifiedSha256:hash(Buffer.from(Array.from({length:70_000},(_,index)=>index%251))),contentWidth:280,contentHeight:250};
 const f=await fixture(t,{proof}),resource=await createWechatImageResourcePort(f.executable).open(selection());
 assert.equal(resource.quality.kind,'original');
 const proofFields=[proof.kind,proof.messageMd5,proof.hdLength,proof.hdWidth,proof.hdHeight,proof.contentWidth,proof.contentHeight,
  proof.bigImageUrlPresent,proof.resourceSize,proof.verifiedBytes,proof.verifiedSha256];
 assert.equal(resource.quality.proof,`${proof.kind}:${hash(JSON.stringify(proofFields))}`);
 await resource.close();
});

test('v2声明尺寸伪造或证明字段不完整时拒绝原图',async t=>{
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

test('v3验证封装长度与明文长度分离，并以Info和匹配detail集合建立质量与资源身份',async t=>{
 const bytes=imageBytes(41_987),proof={kind:'wechat-cdn-big-hd-exact-content-v3',messageMd5:'f'.repeat(32),hdLength:bytes.length,hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:42_018,verifiedBytes:bytes.length,verifiedSha256:hash(bytes),contentWidth:280,contentHeight:250,
  resourceInfoId,matchingResourceIds};
 const f=await fixture(t,{proof,dataLength:bytes.length}),resource=await createWechatImageResourcePort(f.executable).open(selection());
 assert.equal(resource.expectedBytes,41_987);assert.equal(resource.quality.kind,'original');
 const fields=[proof.kind,proof.messageMd5,proof.hdLength,proof.hdWidth,proof.hdHeight,proof.contentWidth,proof.contentHeight,
  proof.resourceInfoId,proof.matchingResourceIds,proof.bigImageUrlPresent,proof.resourceSize,proof.verifiedBytes,proof.verifiedSha256];
 assert.equal(resource.quality.proof,`${proof.kind}:${hash(JSON.stringify(fields))}`);
 const chunks=[];for await(const chunk of resource.bytes)chunks.push(Buffer.from(chunk));assert.deepEqual(Buffer.concat(chunks),bytes);
 await resource.close();

 const alternate=await fixture(t,{proof,dataLength:bytes.length,openAudit:{resourceTypeRaw:5,variantCode:99}});
 const alternateResource=await createWechatImageResourcePort(alternate.executable).open(selection());
 assert.equal(alternateResource.association.resourceIdentity,resource.association.resourceIdentity);
 await alternateResource.close();
});

test('v4质量证明覆盖WXGF源摘要和转换，并把两者纳入资源关联身份',async t=>{
 const bytes=imageBytes(41_987),shared={kind:'wechat-cdn-big-hd-exact-content-v4',messageMd5:'f'.repeat(32),hdWidth:null,hdHeight:null,
  bigImageUrlPresent:true,resourceSize:42_018,verifiedBytes:bytes.length,verifiedSha256:hash(bytes),contentWidth:280,contentHeight:250,
  resourceInfoId,matchingResourceIds};
 const plain={...shared,hdLength:bytes.length,sourceSha256:hash(bytes),conversion:'none'};
 const plainFixture=await fixture(t,{proof:plain,dataLength:bytes.length}),plainResource=await createWechatImageResourcePort(plainFixture.executable).open(selection());
 const plainFields=[plain.kind,plain.messageMd5,plain.hdLength,plain.hdWidth,plain.hdHeight,plain.contentWidth,plain.contentHeight,
  plain.resourceInfoId,plain.matchingResourceIds,plain.bigImageUrlPresent,plain.resourceSize,plain.verifiedBytes,plain.verifiedSha256,plain.sourceSha256,plain.conversion];
 assert.equal(plainResource.quality.proof,`${plain.kind}:${hash(JSON.stringify(plainFields))}`);
 const converted={...shared,hdLength:41_123,sourceSha256:hash(Buffer.from('synthetic decrypted WXGF source')),conversion:'wxgf-to-png-v1'};
 const convertedFixture=await fixture(t,{proof:converted,dataLength:bytes.length}),convertedResource=await createWechatImageResourcePort(convertedFixture.executable).open(selection());
 assert.notEqual(convertedResource.quality.proof,plainResource.quality.proof);
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


test('已关联图片无需原图字段也可按完整内容读取，不冒充原图',async t=>{
 const bytes=imageBytes(70_000),sha=hash(bytes);
 const proof={kind:'wechat-message-image-content-v1',resourceInfoId,matchingResourceIds,resourceSize:70_000,
  verifiedBytes:70_000,verifiedSha256:sha,sourceSha256:sha,conversion:'none',contentWidth:280,contentHeight:250};
 const f=await fixture(t,{proof,openAudit:{quality:'unknown'},capability:proof.kind});
 const request={...selection(),goal:'extract'},resource=await createWechatImageResourcePort(f.executable).open(request);
 try{
  assert.deepEqual(resource.quality,{kind:'unknown',proof:null});
  const chunks=[];for await(const chunk of resource.bytes)chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks),bytes);
  assert.equal(resource.association.recordId,request.source.recordId);
 }finally{await resource.close();}
});


test('图片取消原图门槛后仍拒绝传输摘要和来源资源集合不一致',async t=>{
 const sha=hash(imageBytes(70_000));
 const valid={kind:'wechat-message-image-content-v1',resourceInfoId,matchingResourceIds,resourceSize:70_000,
  verifiedBytes:70_000,verifiedSha256:sha,sourceSha256:sha,conversion:'none',contentWidth:280,contentHeight:250};
 for(const override of [{verifiedBytes:69_999},{verifiedSha256:'f'.repeat(64)},{sourceSha256:'f'.repeat(64)},
  {matchingResourceIds:[matchingResourceIds[1],matchingResourceIds[0]]}]){
  const proof={...valid,...override};const f=await fixture(t,{proof,openAudit:{quality:'unknown'},capability:proof.kind});
  await assert.rejects(createWechatImageResourcePort(f.executable).open({...selection(),goal:'extract'}));
 }
});
