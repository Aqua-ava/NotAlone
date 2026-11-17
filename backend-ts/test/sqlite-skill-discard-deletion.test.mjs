import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

function selectSkill(res){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'skill',input:{name:'gentle'}}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

test('正式删除接管Skill技术清理的冻结文件清单，部分擦除不阻止删除或恢复旧会话',{timeout:30000},async t=>{
 for(const kind of ['source','contact','account'])await t.test(kind,async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let erased=0;
  const f=await fixture(t,{runtimeFault:async point=>{
   if(point==='afterDiscardFile'&&++erased===2){entered.resolve();await release.promise;}
  },onRequest:async(_req,res)=>{await unlink(join(f.skillRoot,'gentle/SKILL.md'));selectSkill(res);return true;}});
  t.after(()=>release.resolve());
  await mkdir(join(f.skillRoot,'gentle'));
  await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 删除交错合成策略\n---\n先回应合成感受。\n');
  let skill=await f.library.discover('gentle');skill=await f.library.setEnabled(skill.id,skill.headRevision,'enabled');
  const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
  const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId);
  const pending=turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'合成删除交错请求',confirmedContact:true});
  const rejected=assert.rejects(pending);
  await entered.promise;
  const [copy]=await f.storage.execute('runtime.inventory',{ownerId:f.owner});
  assert.equal(copy.state,'blocked');assert.ok(copy.cleanupOperationId.startsWith('skill-discard:'));assert.equal(copy.manifestComplete,true);assert.equal(copy.committedRequestId,null);
  const pendingFiles=await f.storage.execute('runtime.discardManifest',{ownerId:f.owner,contactId,discussionId:d.id,copyId:copy.id});
  const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));
  const scope=kind==='account'?{kind}:kind==='contact'?{kind,contactId}:{kind,contactId,sourceId:f.messages[0][0].sourceRecordIds[0]};
  let op;
  try{op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope});}finally{release.resolve();}
  const adopted=op.targets.flatMap(item=>item.target?.kind==='file'&&item.target.domain==='discussion'?[item.target.address]:[]);
  const sorted=items=>items.toSorted((a,b)=>a.locator.localeCompare(b.locator));
  assert.deepEqual(sorted(adopted),sorted(pendingFiles.map(file=>file.address)),'接管复用冻结身份，已登记cleared的文件不重新成为目标');
  await rejected;
  assert.equal(erased,2,'接管后技术清理停止，剩余文件交给正式删除');
  const done=await deletion.advance(op);
  assert.equal(done.state,'completed',JSON.stringify(done.checks));
  assert.deepEqual(await f.storage.execute('runtime.inventory',{ownerId:f.owner}),[]);
  assert.deepEqual(await readdir(join(f.root,'managed/runtime-copies')),[]);
  await assert.rejects(f.storage.execute('runtime.inspect',{ownerId:f.owner,contactId,discussionId:d.id,copyId:copy.id}),{code:'discussion_runtime_unavailable'});
  if(kind==='source')assert.deepEqual(await service.view(contactId,d.id),[]);
  else await assert.rejects(service.view(contactId,d.id));
  assert.equal(f.requests.length,1,'接管后的技术清理不能续发无Skill模型请求');
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});
