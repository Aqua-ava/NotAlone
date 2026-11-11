import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {fixture} from './media-support.mjs';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {UnifiedDiagnosticLog,readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
import {recordImageCallDiagnostic} from '../src/platform/models/image-call-diagnostics.ts';

async function imageFixture(t){
 const bytes=await sharp({create:{width:16,height:12,channels:3,background:'blue'}}).png().toBuffer();
 const adapter={version:'synthetic-image-diagnostic-delete-v1',supports:kind=>kind==='image',async execute(context){
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),
   bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-image-diagnostic-delete-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image-diagnostic-delete'}};
 }};
 const f=await fixture(t,adapter),first=f.messages.find(message=>message.kind==='image');
 const saved=await f.media.extract(f.contact,first.id,{requestKey:'diagnostic-image-a',goal:'extract'});
 const otherContact=f.saved[1].contact_id;await f.history.synchronize(otherContact);
 const second=(await f.history.read(otherContact)).messages.find(message=>message.kind==='image');
 const other=await f.media.extract(otherContact,second.id,{requestKey:'diagnostic-image-b',goal:'extract'});
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-image-delete-diagnostic-')));
 const backend=configureDiagnosticLog(root,{proc:'backend'}),main=new UnifiedDiagnosticLog(root,{proc:'main'});
 t.after(async()=>{await backend.close();await main.close();await rm(root,{recursive:true,force:true});});
 const add=(fileId,contactId)=>recordImageCallDiagnostic({callId:randomUUID(),traceId:randomUUID(),contactPrefix:contactId.slice(0,8),
  images:[{id:fileId,originalBytes:bytes.length,sentBytes:128,width:16,height:12,mimeType:'image/jpeg'}],requestBytes:512,durationMs:1,
  stage:'response_received',failureCategory:'none',outcome:'succeeded'});
 add(saved.files[0].fileId,f.contact);add(other.files[0].fileId,otherContact);await backend.flush();
 for(const record of await readDiagnosticRecords(root))if(record.event==='processing.model_image'){
  const {time,proc,level,...event}=record;main.diagnose(event);
 }
 await main.flush();
 return {...f,first,second,otherContact,fileId:saved.files[0].fileId,otherFileId:other.files[0].fileId,diagnosticRoot:root,backend,main,
  records:async()=>(await readDiagnosticRecords(root)).filter(record=>record.event.startsWith('processing.model_'))};
}

test('正式图片清除排空最后持有者后擦除main/backend图片标识，独立图片与汇总保留',async t=>{
 const f=await imageFixture(t);assert.equal((await f.records()).length,6);let closed=false;
 f.media.holders.register({key:`mediaFile:${f.fileId}`,ownerId:f.owner,contactId:f.contact,generation:0n,async close(){
  closed=true;
  f.backend.diagnose({event:'processing.model_image',callId:randomUUID(),imageId:f.fileId,contactPrefix:f.contact.slice(0,8),originalBytes:128,sentBytes:128,imageCount:1,requestBytes:512,stage:'awaiting_response',failureCategory:'socket_closed'});
 }});
 const value=await f.media.clear(f.contact,f.first.id,'clear-image-diagnostics');
 assert.equal(closed,true);assert.equal(value.state,'cleared');assert.equal(value.cleanup,null);
 await Promise.all([f.backend.flush(),f.main.flush()]);
 const records=await f.records();assert.equal(records.length,4);
 assert.equal(records.filter(record=>record.event==='processing.model_call').length,2);
 assert.equal(records.filter(record=>record.imageId===f.otherFileId).length,2);
 assert.doesNotMatch(JSON.stringify(records),new RegExp(f.fileId));
 assert.equal((await f.media.read(f.otherContact,f.second.id)).files[0].fileId,f.otherFileId);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('诊断擦除失败使正式图片删除保持blocked，恢复后沿原操作完成而不重建资料',async t=>{
 const f=await imageFixture(t);await chmod(f.diagnosticRoot,0o777);let blocked;
 try{
  const value=await f.media.clear(f.contact,f.first.id,'clear-image-diagnostic-failure');
  assert.equal(value.cleanup.state,'blocked');
  blocked=await f.media.deletion.status({ownerId:f.owner,operationId:value.cleanup.operationId});
  assert.equal(blocked.state,'blocked');assert.equal(blocked.completedAt,null);
  assert.ok(blocked.checks.some(check=>check.result.result==='blocked'&&check.result.proof==='diagnostic_image_cleanup_failed'));
  assert.ok(blocked.targets.some(item=>item.target?.kind==='file'&&item.target.domain==='media'&&item.state==='failed'));
 }finally{await chmod(f.diagnosticRoot,0o700);}
 assert.equal((await f.records()).filter(record=>record.imageId===f.fileId).length,2);
 await f.media.resumeCleanup();
 const done=await f.media.deletion.status({ownerId:f.owner,operationId:blocked.operationId});
 assert.equal(done.operationId,blocked.operationId);assert.equal(done.state,'completed');
 assert.equal((await f.media.read(f.contact,f.first.id)).cleanup,null);
 assert.doesNotMatch(JSON.stringify(await f.records()),new RegExp(f.fileId));
 assert.equal((await f.media.read(f.otherContact,f.second.id)).files[0].fileId,f.otherFileId);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正式联系人删除复用相同媒体文件闭包，不残留该联系人的图片标识',async t=>{
 const f=await imageFixture(t);
 const planned=await f.media.deletion.plan({ownerId:f.owner,requestKey:'contact-image-diagnostic-delete',scope:{kind:'contact',contactId:f.contact}});
 assert.ok(planned.targets.some(item=>item.target?.kind==='file'&&item.target.domain==='media'&&item.target.fileId===f.fileId));
 const done=await f.media.deletion.advance({ownerId:f.owner,operationId:planned.operationId});assert.equal(done.state,'completed');
 assert.doesNotMatch(JSON.stringify(await f.records()),new RegExp(f.fileId));
 assert.equal((await f.records()).filter(record=>record.imageId===f.otherFileId).length,2);
 assert.equal((await f.media.read(f.otherContact,f.second.id)).files[0].fileId,f.otherFileId);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
