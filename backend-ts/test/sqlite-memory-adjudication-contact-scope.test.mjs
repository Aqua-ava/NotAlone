import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

test('单联系人裁决只导入和处理该联系人；默认整轮发布仍包含其他联系人和本人',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/adjudication-registry.mjs',import.meta.url).href});
 const [contactId,otherContactId]=f.saved.map(binding=>binding.contact_id),management=new SqliteMemoryManagement(f.storage,owner);
 const contactScope={scopeKind:'contact',contactId},otherScope={scopeKind:'contact',contactId:otherContactId},selfScope={scopeKind:'self',contactId:null};
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
  records:[record('1',{text:scope.token.contact_id===contactId?'我长期喜欢合成绿茶。':'我长期喜欢合成红茶。'}),
   record('2',{sender:'owner',text:scope.token.contact_id===contactId?'我长期喜欢合成园艺。':'我长期喜欢合成慢跑。'})],
  completedPartitions:['shard-a'],exhausted:true});
 for(const id of [contactId,otherContactId])await f.service.synchronize(id);
 await f.contacts.setReading(false);
 const normal=supplier();let extraction;
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,normal.respond));t.after(()=>extraction.close());
 await management.decide({requestKey:'synthetic-contact-existing-memory',action:'manual',scope:contactScope,body:'联系人长期喜欢合成书法。'});
 const run=await extraction.start('synthetic-contact-scoped-adjudication');await extraction.waitForIdle(run.runId);
 assert.equal((await extraction.read(run.runId)).candidates.length,4,'同一真实提取轮同时含两位联系人及本人产物');
 const calls=[],respond=adjudicationSupplier();
 const port=modelPort(()=>extraction.accounting,async(request,input)=>{calls.push({scope:input.scope,purpose:request.purpose});return respond(request,input);});
 const adjudication=new SqliteMemoryAdjudication(f.storage,owner,port,new ActiveHolders());t.after(()=>adjudication.close());await adjudication.initialize();

 const scoped=await adjudication.publishRun(run.runId,contactId);
 assert.equal(scoped.candidateIds.length,1);
 const selected=await management.read(contactScope);
 assert.equal(selected.candidates.length,0);assert.equal(selected.memories.length,2);
 assert.deepEqual(await management.read(otherScope).then(view=>[view.candidates.length,view.memories.length]),[0,0]);
 assert.deepEqual(await management.read(selfScope).then(view=>[view.candidates.length,view.memories.length]),[0,0]);
 assert.deepEqual(calls.map(call=>[call.scope.contact_id,call.purpose]),[[contactId,'adjudication'],[contactId,'relation_verification']]);

 await adjudication.publishRun(run.runId,contactId);
 assert.equal(calls.length,2,'重复单联系人发布复用已提交的裁决结果');
 const all=await adjudication.publishRun(run.runId);
 assert.equal(all.candidateIds.length,4);
 assert.equal((await management.read(otherScope)).memories.length,1);
 assert.equal((await management.read(selfScope)).memories.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同轮裁决进行中只复用相同联系人范围，其他联系人或整轮请求明确拒绝',{timeout:10000},async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期喜欢合成绿茶。'],{publish:true});
 const runId=await f.extract(['我长期喜欢合成园艺。']);
 let announce,release;
 const entered=new Promise(resolve=>announce=resolve),waiting=new Promise(resolve=>release=resolve),normal=adjudicationSupplier();
 let firstCall=true;
 f.setRespond(async(request,input)=>{if(firstCall){firstCall=false;announce();await waiting;}return normal(request,input);});
 const first=f.adjudication.publishRun(runId,f.contactId);
 await entered;
 try{
  const repeated=f.adjudication.publishRun(runId,f.contactId);
  const other=assert.rejects(f.adjudication.publishRun(runId,f.saved[1].contact_id),{code:'memory_adjudication_run_busy'});
  const unscoped=assert.rejects(f.adjudication.publishRun(runId),{code:'memory_adjudication_run_busy'});
  release();await Promise.all([first,repeated,other,unscoped]);
 }finally{release();}
 assert.equal((await f.read()).memories.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
