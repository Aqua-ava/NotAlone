import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture} from './media-support.mjs';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
test('取图的缩略图拒绝、成功和异常用固定原因及耗时记录，不写异常或图片字节',async t=>{
 let mode='thumbnail';const bytes=Buffer.from('合成私密图片字节');
 const adapter={version:'synthetic-diagnostic-media',supports:kind=>kind==='image',execute:async context=>{
  if(mode==='thumbnail')throw new StorageFailure('media_thumbnail_only');if(mode==='failure')throw new Error('合成私密异常与文件路径');
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-diagnostic-media',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-resource'}};
 }};
 const f=await fixture(t,adapter),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());const image=f.messages.find(row=>row.kind==='image');
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:'thumbnail',goal:'extract'}),{code:'media_thumbnail_only'});
 mode='success';const result=await f.media.extract(f.contact,image.id,{requestKey:'success',goal:'extract'});assert.equal(result.latestAttempt.state,'completed');
 mode='failure';await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:'failure',goal:'extract'}),{code:'media_execution_failed'});
 await log.flush();const rows=(await readDiagnosticRecords(f.root)).filter(row=>row.module==='media'&&row.caller==='media_extract');
 assert.ok(rows.some(row=>row.event==='diagnostics.error'&&row.reasonCode==='thumbnail_only'));
 assert.ok(rows.some(row=>row.reasonCode==='completed'&&row.durationMs>=0));assert.ok(rows.some(row=>row.reasonCode==='failed'));
 assert.ok(rows.every(row=>row.contactPrefix===f.contact.slice(0,8)&&typeof row.traceId==='string'));
 assert.doesNotMatch(JSON.stringify(rows),/合成私密|thumbnail_only.*路径/);
});
test('媒体分类拒绝异常getter与继承键，保持公共调用的原异常身份',async t=>{
 for(const kind of ['getter','constructor'])await t.test(kind,async t=>{
  const original=new StorageFailure(kind);if(kind==='getter')Object.defineProperty(original,'code',{get(){throw new Error('合成私密getter正文');}});
  const adapter={version:'synthetic-diagnostic-negative',supports:kind=>kind==='image',execute:async()=>{throw original;}};
  const f=await fixture(t,adapter),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());
  await assert.rejects(f.media.extract(f.contact,f.messages.find(row=>row.kind==='image').id,{requestKey:'negative',goal:'extract'}),error=>error===original);
  await log.flush();const rows=(await readDiagnosticRecords(f.root)).filter(row=>row.event==='diagnostics.error'&&row.caller==='media_extract');
  assert.equal(rows.length,1);assert.equal(rows[0].reasonCode,kind==='getter'?'failed':'image_unavailable');assert.doesNotMatch(JSON.stringify(rows),/合成私密|constructor/);
 });
});
