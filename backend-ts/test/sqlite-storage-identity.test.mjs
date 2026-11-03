import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,rename,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

async function fixture(t,registryModule){
 const userData=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-storage-identity-')));
 const storage=await SqliteStorage.open({userData,intent:'create',role:'test',...(registryModule?{registryModule}:{})});
 t.after(async()=>{await storage.close();await rm(userData,{recursive:true,force:true});});
 return {storage,file:path.join(userData,'managed/sqlite/notalone.sqlite')};
}
test('轻量身份核验不查询全库、不改变运行租约，关闭中立即拒绝可用证明',async t=>{
 const {storage}=await fixture(t),lease=storage.status;
 for(let i=0;i<3;i++)assert.doesNotThrow(()=>storage.verifyIdentity());
 assert.equal(storage.status,lease);assert.equal(storage.timingDiagnostic.recent.length,0);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
 const closing=storage.close();assert.throws(()=>storage.verifyIdentity(),{code:'worker_failed'});await closing;
});
test('运行中同路径文件被替换时，轻量核验拒绝旧服务的可用证明',async t=>{
 const {storage,file}=await fixture(t),old=file+'.original';
 await rename(file,old);await writeFile(file,'只用于合成替换',{mode:0o600});
 try{assert.throws(()=>storage.verifyIdentity(),{code:'storage_identity_changed'});}
 finally{await rm(file);await rename(old,file);}
});
test('Worker异常后轻量核验不沿用旧就绪身份',async t=>{
 const {storage}=await fixture(t,new URL('./fixtures/sqlite/registry.mjs',import.meta.url).href);
 await assert.rejects(storage.execute('facts.crash',{}),{code:'worker_failed'});
 assert.throws(()=>storage.verifyIdentity(),{code:'worker_failed'});
});

test('已有库本人身份复验失败不创建或替换本人，首次准备仍允许明确创建',async t=>{
 const {storage}=await fixture(t),owner='00000000-0000-4000-8000-000000000041',unexpected='00000000-0000-4000-8000-000000000042';
 await assert.rejects(storage.execute('identity.resolveOwner',{expectedOwnerId:owner,proposedOwnerId:unexpected,at:1}),{code:'instance_mismatch'});
 assert.equal(await storage.execute('identity.resolveOwner',{proposedOwnerId:owner,at:2}),owner,'失败复验不能插入 proposedOwnerId');
 await assert.rejects(storage.execute('identity.resolveOwner',{expectedOwnerId:unexpected,proposedOwnerId:unexpected,at:3}),{code:'instance_mismatch'});
 assert.equal(await storage.execute('identity.resolveOwner',{expectedOwnerId:owner,proposedOwnerId:unexpected,at:4}),owner);
 await storage.execute('identity.initialize',{ownerId:unexpected,at:5});
 await assert.rejects(storage.execute('identity.resolveOwner',{expectedOwnerId:owner,proposedOwnerId:owner,at:6}),{code:'instance_mismatch'});
 await assert.rejects(storage.execute('identity.resolveOwner',{proposedOwnerId:owner,at:7}),{code:'owner_ambiguous'});
});
