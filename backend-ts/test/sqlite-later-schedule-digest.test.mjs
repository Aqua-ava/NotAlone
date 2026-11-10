import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const registryModule=new URL('./fixtures/memory-documents/later-schedule-digest-registry.mjs',import.meta.url).href;

async function digestFixture(t,options){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-digest-test-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const ownerId=randomUUID();
 const seed=await storage.execute('fixture.digestSeed',{ownerId,...options});
 return {storage,ownerId,seed};
}

test('scene 正文摘要合并为单条排序查询后，与原 N+1 实现产出逐字节相同的摘要',async t=>{
 const {storage,ownerId,seed}=await digestFixture(t,{scopeKind:'contact',contactId:randomUUID(),documentCount:50,statementsPerDoc:40,outOfOrder:true,unicode:true});
 const verify=await storage.execute('fixture.digestVerify',{ownerId,taskId:seed.taskId,publicationId:seed.publicationId});
 assert.equal(verify.result,true,'运行中的 scene 阶段应按原路径结清');
 assert.equal(verify.sceneState,'succeeded');
 assert.equal(verify.sceneRowDigest,verify.legacyDigest,'调度行记录的摘要必须与原实现逐字节相同');
 assert.equal(verify.cursorDigest,verify.legacyDigest,'游标写入的摘要必须与原实现逐字节相同');
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('无正文文档、self 范围、空串与转义正文边界下摘要仍逐字节相同',async t=>{
 const cases=[
  {scopeKind:'contact',contactId:randomUUID(),documentCount:3,statementsPerDoc:5,emptyDocs:2,unicode:true},
  {scopeKind:'self',documentCount:2,statementsPerDoc:4,unicode:true},
 ];
 for(const options of cases){
  const {storage,ownerId,seed}=await digestFixture(t,options);
  const verify=await storage.execute('fixture.digestVerify',{ownerId,taskId:seed.taskId,publicationId:seed.publicationId});
  assert.equal(verify.result,true,JSON.stringify(options));
  assert.equal(verify.sceneState,'succeeded',JSON.stringify(options));
  assert.equal(verify.cursorDigest,verify.legacyDigest,JSON.stringify(options));
 }
});
