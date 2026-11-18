import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {skillAnchor} from '../src/skills/sqlite/library.ts';
import {TestSkillLibrary} from './fixtures/sqlite-skills/test-library.mjs';

async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-portability-')));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=join(dir,'skills');await mkdir(join(root,'gentle','references'),{recursive:true});
 const bytes='---\nname: gentle\ndescription: 合成迁移场景\n---\n\n先回应感受，再说明情况。\n';
 await writeFile(join(root,'gentle','SKILL.md'),bytes);
 await writeFile(join(root,'gentle','references','cases.md'),'合成案例：表达理解，保留选择。\n');
 const storage=await SqliteStorage.open({userData:dir,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});
 t.after(()=>storage.close());await storage.execute('fixture.owner',{ownerId:'owner-a'});
 const library=new TestSkillLibrary(storage,'owner-a',root);
 const [item]=await library.refresh();return {dir,root,bytes,storage,library,item};
}

// 直接改写目录身份以保留一份过期设备编号，模拟旧库重开；不修改真实磁盘或生产资料。
async function oldDevice(storage,item){
 const identity=JSON.parse(item.directoryIdentity);identity[1]='0';
 await storage.execute('fixture.setDirectoryIdentity',{ownerId:'owner-a',id:item.id,directoryIdentity:JSON.stringify(identity)});
 return storage.execute('skills.get',{ownerId:'owner-a',id:item.id});
}

test('设备编号变化及旧库已记录的目录冲突经完整核验自动恢复，旧运行锚保持失效',async t=>{
 const {library,storage,item}=await fixture(t);const old=await oldDevice(storage,item),oldAnchor=skillAnchor(old);
 await assert.rejects(library.assertAnchor(oldAnchor),{code:'skill_directory_conflict'});
 const conflict=await library.get(item.id);assert.equal(conflict.verificationState,'conflict');
 const [restored]=await library.inspect();
 assert.equal(restored.verificationState,'verified');assert.equal(restored.verificationReason,null);
 assert.equal(restored.id,item.id);assert.equal(restored.enabledState,'enabled');assert.equal(restored.enabledOrigin,'default');
 assert.equal(restored.directoryIdentity,item.directoryIdentity);assert.equal(restored.currentRevisionNo,2n);
 assert.equal(restored.revisions[0].availability,'unavailable');assert.ok(restored.headRevision>conflict.headRevision);
 await assert.rejects(storage.execute('skills.assertRevision',{ownerId:'owner-a',anchor:oldAnchor}),{code:'skill_run_invalidated'});
 await library.assertAnchor(skillAnchor(restored));assert.deepEqual(await library.inspect(),[restored]);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('设备编号刚变化时直接刷新即可恢复，不必先经历一次不可用',async t=>{
 const {library,storage,item}=await fixture(t);const old=await oldDevice(storage,item);
 const [next]=await library.refresh();assert.equal(next.verificationState,'verified');
 assert.equal(next.id,item.id);assert.equal(next.currentRevisionNo,2n);assert.equal(next.headRevision,old.headRevision+1n);
});

async function moveRoot(f){
 const target=join(f.dir,'moved-skills');await cp(f.root,target,{recursive:true});await rm(f.root,{recursive:true});
 return {target,library:new TestSkillLibrary(f.storage,'owner-a',target)};
}

test('迁移到新路径和新目录且旧目录已不存在，沿用原场景与启停决定',async t=>{
 const f=await fixture(t),oldAnchor=skillAnchor(f.item),{library}=await moveRoot(f);
 const [next]=await library.inspect();assert.equal(next.id,f.item.id);assert.equal(next.verificationState,'verified');
 assert.equal(next.enabledOrigin,'default');assert.equal(next.currentRevisionNo,2n);
 assert.notEqual(next.directoryIdentity,f.item.directoryIdentity);await library.assertAnchor(skillAnchor(next));
 await assert.rejects(f.storage.execute('skills.assertRun',{ownerId:'owner-a',revision:{packages:[{id:f.item.id,headRevision:f.item.headRevision}],eligible:[oldAnchor]}}),{code:'skill_run_invalidated'});
 assert.deepEqual(await library.inspect(),[next]);
});

test('迁移不读取停用场景正文、不自动开启，显式重新启用才核验并恢复',async t=>{
 const f=await fixture(t);await f.library.setEnabled(f.item.id,f.item.headRevision,'disabled');
 const {library,target}=await moveRoot(f);await writeFile(join(target,'gentle','SKILL.md'),'不合法的合成文档');
 let [next]=await library.inspect();assert.equal(next.enabledState,'disabled');assert.equal(next.enabledOrigin,'user_action');
 assert.equal(next.verificationState,'conflict');assert.equal(next.revisions.length,1);
 await assert.rejects(library.setEnabled(next.id,next.headRevision,'enabled'),{code:'skill_package_invalid'});
 await writeFile(join(target,'gentle','SKILL.md'),f.bytes);next=await library.get(next.id);
 next=await library.setEnabled(next.id,next.headRevision,'enabled');assert.equal(next.verificationState,'verified');
 assert.equal(next.enabledState,'enabled');assert.equal(next.enabledOrigin,'user_action');
});

test('来源资格撤销不能因迁移或字节相同而恢复',async t=>{
 const f=await fixture(t);await f.library.requireVerification(f.item.id,f.item.headRevision);
 const {library,target}=await moveRoot(f);await writeFile(join(target,'gentle','SKILL.md'),'不得自动读取这份不合法合成文档');
 const [next]=await library.inspect();assert.equal(next.verificationReason,'source_qualification_changed');
 assert.equal(next.currentRevisionNo,null);assert.equal(next.revisions.length,1);
 await assert.rejects(library.setEnabled(next.id,next.headRevision,'enabled'),{code:'skill_source_verification_required'});
});

test('迁移时正文或辅助资源与最新核验内容不符，保留不可用而不接受同名目录',async t=>{
 const f=await fixture(t),{library,target}=await moveRoot(f);
 await writeFile(join(target,'gentle','references','cases.md'),'被替换的合成辅助资料。');
 const [next]=await library.inspect();assert.equal(next.verificationState,'conflict');
 assert.equal(next.verificationReason,'directory_content_changed');assert.equal(next.currentRevisionNo,null);
 assert.equal(next.directoryIdentity,f.item.directoryIdentity);assert.equal(next.revisions.length,1);
});

test('旧库已记录目录冲突后发现内容不同，刷新更新为可解释的内容不一致原因',async t=>{
 const f=await fixture(t),old=await oldDevice(f.storage,f.item);
 await assert.rejects(f.library.assertAnchor(skillAnchor(old)),{code:'skill_directory_conflict'});
 await writeFile(join(f.root,'gentle','references','cases.md'),'被替换的合成资源。');
 const [next]=await f.library.inspect();assert.equal(next.verificationReason,'directory_content_changed');
 assert.equal(next.currentRevisionNo,null);assert.deepEqual(await f.library.inspect(),[next]);
});

test('未核验过的同名目录没有历史基线，迁移后不能认领为可用场景',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'unverified'));
 await writeFile(join(f.root,'unverified','SKILL.md'),f.bytes.replace('name: gentle','name: unverified'));
 const unknown=await f.library.discover('unverified'),{library}=await moveRoot(f);
 const items=await library.inspect(),next=items.find(item=>item.id===unknown.id);
 assert.equal(next.enabledState,'unknown');assert.equal(next.verificationState,'conflict');
 assert.equal(next.currentRevisionNo,null);assert.deepEqual(next.revisions,[]);
});

test('迁移不能用更早历史内容回退最新已核验版本',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'gentle','SKILL.md'),f.bytes+'最新合成方法。\n');
 const [updated]=await f.library.inspect();assert.equal(updated.currentRevisionNo,2n);
 const {library,target}=await moveRoot(f);await writeFile(join(target,'gentle','SKILL.md'),f.bytes);
 const [next]=await library.inspect();assert.equal(next.verificationState,'conflict');assert.equal(next.currentRevisionNo,null);
 assert.equal(next.revisions.length,2);assert.equal(next.verificationReason,'directory_content_changed');
});

for(const action of ['停用','来源撤销','账号删除'])test(`定位恢复提交前并发${action}不会被覆盖`,async t=>{
 const f=await fixture(t);await oldDevice(f.storage,f.item);
 const execute=f.storage.execute.bind(f.storage);let interrupted=false;
 f.storage.execute=async(name,input,...rest)=>{
  if(name==='skills.rebindDirectory'&&!interrupted){
   interrupted=true;const current=await execute('skills.get',{ownerId:'owner-a',id:f.item.id});
   if(action==='停用')await execute('skills.setEnabled',{ownerId:'owner-a',id:current.id,expectedHead:current.headRevision,enabledState:'disabled'});
   else if(action==='来源撤销')await execute('skills.invalidate',{ownerId:'owner-a',id:current.id,expectedHead:current.headRevision,verificationState:'pending',reason:'source_qualification_changed'});
   else await execute('fixture.ownerState',{ownerId:'owner-a',state:'deleted'});
  }
  return execute(name,input,...rest);
 };
 if(action==='账号删除')await assert.rejects(f.library.inspect(),{code:'skill_owner_unavailable'});
 else {
  const [next]=await f.library.inspect();assert.ok(interrupted);assert.equal(next.revisions.length,1);
  if(action==='停用')assert.equal(next.enabledState,'disabled');
  else {assert.equal(next.verificationReason,'source_qualification_changed');assert.equal(next.currentRevisionNo,null);}
 }
});
