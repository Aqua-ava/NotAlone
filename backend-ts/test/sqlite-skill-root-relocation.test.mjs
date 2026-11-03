import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const ownerId='owner-a';
const digest=value=>createHash('sha256').update(value).digest('hex');

async function fixture(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-relocation-')));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const storage=await SqliteStorage.open({userData:directory,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});
 t.after(()=>storage.close());await storage.execute('fixture.owner',{ownerId});
 return storage;
}

async function seed(storage,name,mode,index){
 const id=`package-${name}`,directoryIdentity=JSON.stringify([`/old/skill-packages/${name}`,'1',String(100+index)]);
 let item=await storage.execute('skills.associate',{ownerId,id,directoryName:name,directoryIdentity});
 if(mode!=='unknown'){
  item=await storage.execute('skills.observe',{ownerId,id,expectedHead:item.headRevision,directoryName:name,directoryIdentity,
   displayName:`合成 ${name}`,description:'隔离测试包',manifestDigest:digest(`${name}:manifest`),contentDigest:digest(`${name}:content`),verifiedAt:123n});
  item=await storage.execute('skills.setEnabled',{ownerId,id,expectedHead:item.headRevision,enabledState:'enabled'});
  if(mode==='disabled')item=await storage.execute('skills.setEnabled',{ownerId,id,expectedHead:item.headRevision,enabledState:'disabled'});
  if(mode==='revoked')item=await storage.execute('skills.invalidate',{ownerId,id,expectedHead:item.headRevision,verificationState:'pending',reason:'source_qualification_changed'});
 }
 return item;
}

function planFor(items){
 return items.map((item,index)=>{
  const revision=item.revisions.find(row=>row.revisionNo===item.currentRevisionNo)??item.revisions.at(-1);
  return {id:item.id,directoryName:item.directoryName,expectedHead:item.headRevision,expectedDirectoryIdentity:item.directoryIdentity,
   directoryIdentity:JSON.stringify([`/repo/reply-skills/romance/${item.directoryName}`,'1',String(900+index)]),
   manifestDigest:revision?.manifestDigest??digest(`${item.directoryName}:unverified-manifest`),
   contentDigest:revision?.contentDigest??digest(`${item.directoryName}:unverified-content`)};
 });
}

function anchorFor(item){
 const revision=item.revisions.find(row=>row.revisionNo===item.currentRevisionNo);
 assert.ok(revision);
 return {packageId:item.id,revisionNo:revision.revisionNo,headRevision:item.headRevision,directoryIdentity:item.directoryIdentity,
  manifestDigest:revision.manifestDigest,contentDigest:revision.contentDigest};
}

test('原子重定位保留多包状态与修订，仅更新目录身份并使旧锚失效',async t=>{
 const storage=await fixture(t);
 await seed(storage,'a-enabled','enabled',1);await seed(storage,'b-disabled','disabled',2);await seed(storage,'c-unknown','unknown',3);
 const before=await storage.execute('skills.list',{ownerId}),plan=planFor(before),oldAnchor=anchorFor(before.find(item=>item.directoryName==='a-enabled'));
 const relocated=await storage.execute('skills.relocateRoot',{ownerId,packages:plan});
 assert.equal(relocated.length,before.length);
 for(const old of before){
  const next=relocated.find(item=>item.id===old.id),target=plan.find(item=>item.id===old.id);
  assert.deepEqual(next,{...old,directoryIdentity:target.directoryIdentity,headRevision:old.headRevision+1n});
 }
 await assert.rejects(storage.execute('skills.assertRevision',{ownerId,anchor:oldAnchor}),{code:'skill_run_invalidated'});
 await assert.rejects(storage.execute('skills.assertRun',{ownerId,revision:{packages:before.map(item=>({id:item.id,headRevision:item.headRevision})),eligible:[oldAnchor]}}),{code:'skill_run_invalidated'});
 const newAnchor=anchorFor(relocated.find(item=>item.directoryName==='a-enabled'));
 assert.equal(await storage.execute('skills.assertRevision',{ownerId,anchor:newAnchor}),true);
 assert.equal(await storage.execute('skills.assertRun',{ownerId,revision:{packages:relocated.map(item=>({id:item.id,headRevision:item.headRevision})),eligible:[newAnchor]}}),true);
});

test('CAS、包集合变化或当前版本摘要不匹配时整批回滚',async t=>{
 const storage=await fixture(t);
 await seed(storage,'a','enabled',1);await seed(storage,'b','disabled',2);
 const before=await storage.execute('skills.list',{ownerId}),plan=planFor(before);
 await assert.rejects(storage.execute('skills.relocateRoot',{ownerId,packages:plan.slice(0,1)}),{code:'skill_root_relocation_conflict'});
 assert.deepEqual(await storage.execute('skills.list',{ownerId}),before);
 const stale=plan.map((item,index)=>index===1?{...item,expectedHead:item.expectedHead+1n}:item);
 await assert.rejects(storage.execute('skills.relocateRoot',{ownerId,packages:stale}),{code:'skill_revision_conflict'});
 assert.deepEqual(await storage.execute('skills.list',{ownerId}),before);
 const changed=plan.map((item,index)=>index===1?{...item,contentDigest:'0'.repeat(64)}:item);
 await assert.rejects(storage.execute('skills.relocateRoot',{ownerId,packages:changed}),{code:'skill_content_changed'});
 assert.deepEqual(await storage.execute('skills.list',{ownerId}),before);
});

test('来源撤销随根重定位保留且不能由新目录摘要自动解除',async t=>{
 const storage=await fixture(t),item=await seed(storage,'revoked','revoked',1),plan=planFor([item]);
 assert.equal(item.verificationReason,'source_qualification_changed');assert.equal(item.currentRevisionNo,null);
 const [relocated]=await storage.execute('skills.relocateRoot',{ownerId,packages:plan});
 assert.deepEqual(relocated,{...item,directoryIdentity:plan[0].directoryIdentity,headRevision:item.headRevision+1n});
 const previous=item.revisions.at(-1);
 await assert.rejects(storage.execute('skills.observe',{ownerId,id:item.id,expectedHead:relocated.headRevision,directoryName:item.directoryName,
  directoryIdentity:relocated.directoryIdentity,displayName:item.displayName,description:item.description,
  manifestDigest:previous.manifestDigest,contentDigest:previous.contentDigest,verifiedAt:456n}),{code:'skill_source_verification_required'});
 assert.deepEqual(await storage.execute('skills.get',{ownerId,id:item.id}),relocated);
});

for(const mode of ['revoked','conflict'])for(const field of ['manifestDigest','contentDigest'])test(`重定位事务拒绝${mode==='revoked'?'来源撤销':'目录冲突'}包的错误${field}，不跳过最新历史摘要`,async t=>{
 const storage=await fixture(t);let item=await seed(storage,'guarded',mode==='revoked'?'revoked':'enabled',1);
 if(mode==='conflict')item=await storage.execute('skills.invalidate',{ownerId,id:item.id,expectedHead:item.headRevision,verificationState:'conflict',reason:'directory_identity_changed'});
 const plan=planFor([item]);plan[0][field]='0'.repeat(64);
 await assert.rejects(storage.execute('skills.relocateRoot',{ownerId,packages:plan}),{code:'skill_content_changed'});
 assert.deepEqual(await storage.execute('skills.get',{ownerId,id:item.id}),item);
});
