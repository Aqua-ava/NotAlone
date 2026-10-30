import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFixture} from './fixtures/memory-documents/support.mjs';
import {record} from './fixtures/memory-sqlite/support.mjs';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {randomUUID} from 'node:crypto';

test('文档冲突后用户新启动一轮复用已成功提取并完成发布',async t=>{
 let changed=false;
 const f=await documentFixture(t,{beforeCall:async({contactId})=>{
  if(!changed){changed=true;await f.management.decide({requestKey:'retry-concurrent-change',action:'manual',scope:{scopeKind:'contact',contactId},body:'人工确认的合成资料。'});}
 }});
 const first=await f.extraction.start('retry-first-run');await f.extraction.waitForIdle(first.runId);
 const firstRun=await f.extraction.read(first.runId),firstTask=firstRun.tasks.find(task=>task.contactId===f.contactId);
 assert.equal((await f.documents.readTask(firstTask.taskId)).outcome,'incomplete');
 assert.equal(firstRun.succeeded,1);const calls=f.extractionCalls;
 const second=await f.extraction.start('retry-user-next-run');await f.extraction.waitForIdle(second.runId);
 const completed=await f.extraction.read(second.runId),task=completed.tasks.find(item=>item.contactId===f.contactId);
 assert.ok(task,'明确的新轮必须包含后续阶段仍未完成的原目标');
 assert.equal(completed.total,1);assert.equal(completed.succeeded,1);assert.equal(completed.state,'completed');
 assert.equal(f.extractionCalls,calls,'已成功的提取与核验不能重复出站');
 assert.equal((await f.documents.readTask(task.taskId)).outcome,'completed');
 assert.equal((await f.documents.readTask(firstTask.taskId)).outcome,'incomplete','不能改写原冲突事实');
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).documents.length,2);
 const docCalls=f.calls.length,third=await f.extraction.start('retry-after-completion');await f.extraction.waitForIdle(third.runId);
 assert.equal((await f.extraction.read(third.runId)).total,0);assert.equal(f.calls.length,docCalls,'成功目标不能重复处理');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 const sourceId=(await f.service.read(f.contactId)).messages[0].sourceRecordIds[0];
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId}});
 assert.equal((await deletion.advance(plan)).state,'completed');
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).publication,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('新文字与待整理旧目标同轮时只提取新文字',async t=>{
 let changed=false;
 const f=await documentFixture(t,{beforeCall:async({contactId})=>{
  if(!changed){changed=true;await f.management.decide({requestKey:'retry-mixed-change',action:'manual',scope:{scopeKind:'contact',contactId},body:'人工确认的合成资料。'});}
 }});
 const first=await f.extraction.start('retry-mixed-first');await f.extraction.waitForIdle(first.runId);const calls=f.extractionCalls;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'}),record('2',{text:'我长期喜欢合成绘画。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const next=await f.extraction.start('retry-mixed-next');await f.extraction.waitForIdle(next.runId);
 const run=await f.extraction.read(next.runId);assert.equal(run.total,2);assert.equal(run.succeeded,2);assert.equal(run.state,'completed');
 assert.equal(f.extractionCalls,calls+2,'只对新文字执行一次提取和一次核验');
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).documents.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('撤选后手动新轮不能复用旧提取资格',async t=>{
 let changed=false;
 const f=await documentFixture(t,{beforeCall:async({contactId})=>{
  if(!changed){changed=true;await f.management.decide({requestKey:'retry-revoked-change',action:'manual',scope:{scopeKind:'contact',contactId},body:'人工确认的合成资料。'});}
 }});
 const first=await f.extraction.start('retry-revoked-first');await f.extraction.waitForIdle(first.runId);
 const binding=(await f.contacts.directory()).bindings.find(item=>item.contact_id===f.contactId&&item.status==='active');
 await f.contacts.revoke(f.contactId,binding.binding_id,binding.selection_generation);const calls=f.calls.length;
 const next=await f.extraction.start('retry-revoked-next');await f.extraction.waitForIdle(next.runId);
 assert.equal((await f.extraction.read(next.runId)).total,0);assert.equal(f.calls.length,calls);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
