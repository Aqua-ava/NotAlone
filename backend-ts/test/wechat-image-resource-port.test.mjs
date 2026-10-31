import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWechatImageResourcePort} from '../src/media/visual/wechat.ts';
import {supportsWechatOriginalImages} from '../src/history/wechat/artifacts.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const account='synthetic-owner',conversation='synthetic-friend',generation='a'.repeat(64),partition='d'.repeat(64),table='c'.repeat(64),schemaFingerprint='b'.repeat(64);
const token={owner_id:'00000000-0000-4000-8000-000000000091',contact_id:'00000000-0000-4000-8000-000000000092',account_id:'00000000-0000-4000-8000-000000000093',conversation_id:'00000000-0000-4000-8000-000000000094',binding_id:'00000000-0000-4000-8000-000000000095',grant_id:'00000000-0000-4000-8000-000000000096',verification_id:'00000000-0000-4000-8000-000000000097',read_epoch:'1',selection_generation:'1',data_generation:'1',identity_generation:'1',scope_revision:'1',barrier_generation:'1',source_generation:generation};

test('旧读取组件没有声明原图协议时不启用自动取图',async t=>{
 const f=await fixture(t);assert.equal(await supportsWechatOriginalImages(f.executable),false);
 const path=join(f.executable,'../../manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));
 manifest.originalImageProtocol='wechat-original-image-v1';await writeFile(path,JSON.stringify(manifest));
 assert.equal(await supportsWechatOriginalImages(f.executable),true);
 assert.equal(await supportsWechatOriginalImages(undefined),false);
});

async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-wechat-image-resource-'))),artifact=join(root,'artifact');
 await mkdir(join(artifact,'bin'),{recursive:true});await mkdir(join(artifact,'lib'));
 const executable=join(artifact,'bin','wx-cli'),requestsFile=join(root,'requests'),pidFile=join(root,'pid');
 const bytes=Buffer.alloc(70_000);for(let index=0;index<bytes.length;index++)bytes[index]=index%251;
 const expectedSha256=hash(bytes),resourceSourceGeneration=hash('synthetic-message-resource-instance'),base64=bytes.toString('base64');
 const script=`#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
const log=${JSON.stringify(requestsFile)},pidFile=${JSON.stringify(pidFile)},data=Buffer.from(${JSON.stringify(base64)},'base64');
const generation=${JSON.stringify(generation)},partition=${JSON.stringify(partition)},table=${JSON.stringify(table)},fingerprint=${JSON.stringify(schemaFingerprint)};
const account=${JSON.stringify(account)},conversation=${JSON.stringify(conversation)},target='synthetic-target',resourceToken='synthetic-opaque-resource-token';let blockReads=false;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),scopeDigest=hash(account+'\\0'+conversation),expectedSha256=hash(data);
fs.writeFileSync(pidFile,String(process.pid));if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest,sourceGeneration:generation,schemaFingerprint:fingerprint,tables:[{target:table,partition,role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:'2'}],checkedPartitions:[partition]};
const support={protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:account,conversationKey:conversation,sourceGeneration:generation,programVersion:'synthetic',build:'1',artifactSha256:hash(fs.readFileSync(process.argv[1])),schemaFingerprint:fingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-v1',continuity:'synthetic-fixed-source-v1'};
const proof={kind:'wechat-cdn-big-hd-exact-content-v1',messageMd5:'f'.repeat(32),hdLength:data.length,hdWidth:1,hdHeight:1,bigImageUrlPresent:true,resourceSize:data.length,verifiedBytes:data.length,verifiedSha256:expectedSha256};
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(r)+'\\n');let value;
if(r.op==='image-open'&&r.serverId==='999'){console.log(JSON.stringify({ok:false,error:{code:'history_image_original_unavailable'}}));return;}
if(r.op==='resolve')value={accountKey:account,conversationKey:conversation,displayName:'合成甲',sourceGeneration:generation};
else if(r.op==='inspect')value=schema;
else if(r.op==='support')value=support;
else if(r.op==='target')value={protocol:'private-history-v1',descriptor:target,partitions:[partition],tables:[{partition,instance:table}],sourceGeneration:generation,checkedPartitions:[partition]};
else if(r.op==='image-open'){blockReads=r.localId==='125';value={protocol:'wechat-original-image-v1',resourceToken,sourceGeneration:generation,resourceSourceGeneration:${JSON.stringify(resourceSourceGeneration)},target:r.target,partition:r.partition,table:r.table,localId:r.localId==='124'?'125':r.localId,serverId:r.serverId,sentAt:r.sentAt,resourceTable:'wechat-message-resource-v1',resourceId:'9007199254740993',resourceTypeRaw:3,variantCode:1,complete:true,quality:'original',qualityProof:proof,expectedBytes:data.length,expectedSha256,mimeType:'image/png',envelope:'plain',sourceEnvelope:'wechat_dat'};}
else if(r.op==='image-read'){if(blockReads)return;const chunk=data.subarray(r.offset,Math.min(data.length,r.offset+65536));value={resourceToken,sourceGeneration:generation,offset:r.offset,bytesRead:chunk.length,totalBytes:data.length,chunkBase64:chunk.toString('base64'),eof:r.offset+chunk.length===data.length,...(r.offset+chunk.length===data.length?{verifiedSha256:expectedSha256}:{})};}
else if(r.op==='image-close')value={closed:true};
else{console.log(JSON.stringify({ok:false,error:{code:'history_operation_unsupported'}}));return;}
console.log(JSON.stringify({ok:true,data:value}));});`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-wcdb');await writeFile(join(artifact,'lib','libWCDB.dylib'),wcdb);
 await writeFile(join(artifact,'manifest.json'),JSON.stringify({formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,
  sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',
  signing:'ad-hoc-development',realWechatVerified:false,cliSha256:hash(script),wcdbSha256:hash(wcdb)}));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,executable,requestsFile,pidFile,bytes,expectedSha256,resourceSourceGeneration};
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
