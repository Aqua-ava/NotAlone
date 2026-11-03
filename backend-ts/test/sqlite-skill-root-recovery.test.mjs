import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,cp,rm,access,link,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {runDefaultDatabaseStartup} from '../src/platform/cutover/startup.ts';
import {loadStartupConfiguration,loadManifest} from '../src/platform/cutover/control.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary,skillAnchor} from '../src/skills/sqlite/library.ts';
import {prepareSkillRootRelocation,skillRootRelocationJournal} from '../src/skills/sqlite/root-relocation.ts';

async function fixture(t) {
  const base=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-root-recovery-')));
  const userData=join(base,'app'),oldRoot=join(userData,'skill-packages'),newRoot=join(base,'repository');
  let storage;
  t.after(async()=>{await storage?.close();await rm(base,{recursive:true,force:true});});
  await mkdir(userData,{mode:0o700});
  for(const name of ['gentle','revoked']){
    await mkdir(join(oldRoot,name),{recursive:true});
    await writeFile(join(oldRoot,name,'SKILL.md'),`---\nname: ${name}\ndescription: 用于合成表达\n---\n先回应感受。\n说明情况。\n保留选择。\n`);
  }
  await cp(oldRoot,newRoot,{recursive:true});
  const ready=await runDefaultDatabaseStartup({userData,allowSyntheticAuthorization:true,capabilities:['contacts','skills'],skillPackageRoot:oldRoot});
  assert.equal(ready.phase,'ready',JSON.stringify({ready,checks:loadManifest(userData)?.checks?.filter(check=>check.state==='failed')}));
  storage=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:ready.databaseId});
  const library=new SqliteSkillLibrary(storage,ready.ownerId,oldRoot);
  for(const item of await library.refresh())await library.setEnabled(item.id,item.headRevision,'enabled');
  const revoked=(await library.list()).find(i=>i.directoryName==='revoked');
  await library.requireVerification(revoked.id,revoked.headRevision);
  const before=await library.list();await storage.close();storage=undefined;
  const open=async()=>{
    await storage?.close();
    storage=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:ready.databaseId});
    return storage;
  };
  return {userData,oldRoot,newRoot,open,ownerId:ready.ownerId,before};
}
const fieldsWithoutLocation=item=>{const {directoryIdentity,headRevision,...rest}=item;return rest;};

test('旧根已消失的迁移仍核对最新登记摘要，保留停用和来源撤销',async t=>{
  const f=await fixture(t),storage=await f.open(),gentle=f.before.find(i=>i.directoryName==='gentle');
  await storage.execute('skills.setEnabled',{ownerId:f.ownerId,id:gentle.id,expectedHead:gentle.headRevision,enabledState:'disabled'});
  const before=await storage.execute('skills.list',{ownerId:f.ownerId});await storage.close();
  await rm(f.oldRoot,{recursive:true});
  await prepareSkillRootRelocation(f.userData,f.newRoot);
  const ready=await runDefaultDatabaseStartup({userData:f.userData});
  assert.equal(ready.phase,'ready');assert.equal(ready.configuration.skillPackageRoot,f.newRoot);
  const after=await (await f.open()).execute('skills.list',{ownerId:f.ownerId});
  assert.deepEqual(after.map(fieldsWithoutLocation),before.map(fieldsWithoutLocation));
  for(const old of before)assert.equal(after.find(i=>i.id===old.id).headRevision,old.headRevision+1n);
});

test('旧根物理目录重建后仍核对最新内容，不把迁移当作新的Skill安装',async t=>{
  const f=await fixture(t),backup=f.oldRoot+'-backup';
  await rename(f.oldRoot,backup);await cp(backup,f.oldRoot,{recursive:true});
  await prepareSkillRootRelocation(f.userData,f.newRoot);
  assert.equal((await runDefaultDatabaseStartup({userData:f.userData})).phase,'ready');
  const after=await (await f.open()).execute('skills.list',{ownerId:f.ownerId});
  assert.deepEqual(after.map(fieldsWithoutLocation),f.before.map(fieldsWithoutLocation));
});

test('迁移意图发布后旧根消失，重启仍能完成已登记内容的迁移',async t=>{
  const f=await fixture(t);await prepareSkillRootRelocation(f.userData,f.newRoot);
  await rm(f.oldRoot,{recursive:true});
  assert.equal((await runDefaultDatabaseStartup({userData:f.userData})).phase,'ready');
  assert.equal(loadStartupConfiguration(f.userData).skillPackageRoot,f.newRoot);
  await assert.rejects(access(skillRootRelocationJournal(f.userData)),{code:'ENOENT'});
});

test('旧根消失时不能将更早历史版本当作迁移内容',async t=>{
  const f=await fixture(t),storage=await f.open(),library=new SqliteSkillLibrary(storage,f.ownerId,f.oldRoot);
  const gentle=f.before.find(i=>i.directoryName==='gentle');
  await writeFile(join(f.oldRoot,'gentle/SKILL.md'),(await readFile(join(f.oldRoot,'gentle/SKILL.md'),'utf8'))+'\n新的合成方法。\n');
  await library.verify(gentle.id,gentle.headRevision);
  const before=await library.list();await storage.close();
  await rm(f.oldRoot,{recursive:true});
  await assert.rejects(prepareSkillRootRelocation(f.userData,f.newRoot),/skill_root_content_changed/);
  assert.deepEqual(await (await f.open()).execute('skills.list',{ownerId:f.ownerId}),before);
  await assert.rejects(access(skillRootRelocationJournal(f.userData)),{code:'ENOENT'});
});

for(const alreadyApplied of [false,true])test(`迁移${alreadyApplied?'数据库已提交':'尚未提交'}时目标物理目录重建，重启可完成并安全加载`,async t=>{
  const f=await fixture(t),plan=await prepareSkillRootRelocation(f.userData,f.newRoot);
  if(alreadyApplied){
    const storage=await f.open();
    await storage.execute('skills.relocateRoot',{ownerId:f.ownerId,packages:plan.packages.map(p=>({...p,expectedHead:BigInt(p.expectedHead)}))});
    await storage.close();
  }
  await rename(f.newRoot,f.newRoot+'-backup');await cp(f.newRoot+'-backup',f.newRoot,{recursive:true});
  await rm(f.oldRoot,{recursive:true});
  const reopened=await runDefaultDatabaseStartup({userData:f.userData});
  assert.equal(reopened.phase,'ready',JSON.stringify(reopened));
  const library=new SqliteSkillLibrary(await f.open(),f.ownerId,f.newRoot),after=await library.inspect();
  const gentle=after.find(i=>i.directoryName==='gentle');
  assert.equal((await library.assertAnchor(skillAnchor(gentle))).pkg.name,'gentle');
  const revoked=after.find(i=>i.directoryName==='revoked');
  assert.equal(revoked.verificationReason,'source_qualification_changed');
  await assert.rejects(library.verify(revoked.id,revoked.headRevision),{code:'skill_source_verification_required'});
  await assert.rejects(access(skillRootRelocationJournal(f.userData)),{code:'ENOENT'});
  const stable=await library.inspect();assert.deepEqual(stable,after);
});

test('旧根消失且没有历史核验摘要的包不能仅凭同名目标迁移',async t=>{
  const f=await fixture(t),storage=await f.open();
  for(const root of [f.oldRoot,f.newRoot]){
    await mkdir(join(root,'unknown'));
    await writeFile(join(root,'unknown/SKILL.md'),'---\nname: unknown\ndescription: 合成未核验包\n---\n未核验的合成内容。\n');
  }
  const library=new SqliteSkillLibrary(storage,f.ownerId,f.oldRoot);
  await library.discover('unknown');const before=await library.list();await storage.close();
  await rm(f.oldRoot,{recursive:true});
  await assert.rejects(prepareSkillRootRelocation(f.userData,f.newRoot),/skill_root_revision_missing/);
  assert.deepEqual(await (await f.open()).execute('skills.list',{ownerId:f.ownerId}),before);
  await assert.rejects(access(skillRootRelocationJournal(f.userData)),{code:'ENOENT'});
});

test('来源撤销的包迁移也必须匹配最新登记摘要，不能仅凭两处文件相同通过',async t=>{
  const f=await fixture(t);
  for(const root of [f.oldRoot,f.newRoot]){
    const file=join(root,'revoked/SKILL.md');
    await writeFile(file,(await readFile(file,'utf8'))+'\n未经登记的合成修改。\n');
  }
  await assert.rejects(prepareSkillRootRelocation(f.userData,f.newRoot),/skill_root_content_changed/);
  assert.deepEqual(await (await f.open()).execute('skills.list',{ownerId:f.ownerId}),f.before);
  await assert.rejects(access(skillRootRelocationJournal(f.userData)),{code:'ENOENT'});
});

test('持久化迁移意图后重启，先切换目录身份再发布新配置，保留版本及来源撤销',async t=>{
  const f=await fixture(t),oldAnchor=skillAnchor(f.before.find(i=>i.directoryName==='gentle'));
  await prepareSkillRootRelocation(f.userData,f.newRoot);
  assert.equal(loadStartupConfiguration(f.userData).skillPackageRoot,f.oldRoot);
  const reopened=await runDefaultDatabaseStartup({userData:f.userData});
  assert.equal(reopened.phase,'ready');assert.equal(reopened.configuration.skillPackageRoot,f.newRoot);
  const next=new SqliteSkillLibrary(await f.open(),f.ownerId,f.newRoot),after=await next.inspect();
  assert.deepEqual(after.map(fieldsWithoutLocation),f.before.map(fieldsWithoutLocation));
  for(const item of after){
    const old=f.before.find(i=>i.id===item.id);
    assert.equal(item.headRevision,old.headRevision+1n);assert.notEqual(item.directoryIdentity,old.directoryIdentity);
  }
  await assert.rejects(next.assertAnchor(oldAnchor),{code:'skill_run_invalidated'});
  const current=after.find(i=>i.directoryName==='gentle');assert.equal((await next.assertAnchor(skillAnchor(current))).pkg.name,'gentle');
  const revoked=after.find(i=>i.directoryName==='revoked');
  await assert.rejects(next.verify(revoked.id,revoked.headRevision),{code:'skill_source_verification_required'});
  await assert.rejects(access(skillRootRelocationJournal(f.userData)),{code:'ENOENT'});
  assert.equal(await readFile(join(f.oldRoot,'gentle/SKILL.md'),'utf8'),await readFile(join(f.newRoot,'gentle/SKILL.md'),'utf8'));
});

test('数据库已提交而配置尚未切换的重启，不重复迁移或递增head',async t=>{
  const f=await fixture(t),plan=await prepareSkillRootRelocation(f.userData,f.newRoot);
  const storage=await f.open();
  const applied=await storage.execute('skills.relocateRoot',{ownerId:f.ownerId,packages:plan.packages.map(p=>({...p,expectedHead:BigInt(p.expectedHead)}))});
  await storage.close();
  assert.equal(loadStartupConfiguration(f.userData).skillPackageRoot,f.oldRoot);
  assert.equal((await runDefaultDatabaseStartup({userData:f.userData})).phase,'ready');
  assert.equal(loadStartupConfiguration(f.userData).skillPackageRoot,f.newRoot);
  const checked=await f.open();assert.deepEqual(await checked.execute('skills.list',{ownerId:f.ownerId}),applied);await checked.close();
  assert.equal(await prepareSkillRootRelocation(f.userData,f.newRoot),undefined);
  assert.equal((await runDefaultDatabaseStartup({userData:f.userData})).phase,'ready');
  assert.deepEqual(await (await f.open()).execute('skills.list',{ownerId:f.ownerId}),applied);
});

test('意图持久化后目标字节变化则阻断普通启动，修复后可在同一完成态重试',async t=>{
  const f=await fixture(t);await prepareSkillRootRelocation(f.userData,f.newRoot);
  const target=join(f.newRoot,'gentle/SKILL.md'),original=await readFile(target);
  await writeFile(target,Buffer.concat([original,Buffer.from('\n合成变更。\n')]));
  const blocked=await runDefaultDatabaseStartup({userData:f.userData});
  assert.equal(blocked.phase,'maintenance');assert.equal(blocked.detail,'skill_root_relocation_pending');
  assert.equal(loadManifest(f.userData).phase,'completed');
  assert.equal(loadStartupConfiguration(f.userData).skillPackageRoot,f.oldRoot);
  const checked=await f.open();assert.deepEqual(await checked.execute('skills.list',{ownerId:f.ownerId}),f.before);await checked.close();
  await writeFile(target,original);
  assert.equal((await runDefaultDatabaseStartup({userData:f.userData})).phase,'ready');
  assert.equal(loadStartupConfiguration(f.userData).skillPackageRoot,f.newRoot);
});

test('DSH已占用启动锁但尚未发布握手时，拒绝开始迁移',async t=>{
  const f=await fixture(t),lock=join(f.userData,'managed/sqlite-backend.info.dsh-lock');
  await writeFile(lock,'{}');
  await assert.rejects(prepareSkillRootRelocation(f.userData,f.newRoot),/skill_root_relocation_busy/);
  await assert.rejects(access(skillRootRelocationJournal(f.userData)),{code:'ENOENT'});
});

test('journal发布后遗留临时硬链接时，正常启动可完成清理和恢复',async t=>{
  const f=await fixture(t);await prepareSkillRootRelocation(f.userData,f.newRoot);
  const journal=skillRootRelocationJournal(f.userData),temporary=join(dirname(journal),'.skill-root-relocation.11111111-1111-4111-8111-111111111111.tmp');
  await link(journal,temporary);
  assert.equal((await runDefaultDatabaseStartup({userData:f.userData})).phase,'ready');
  assert.equal(loadStartupConfiguration(f.userData).skillPackageRoot,f.newRoot);
  await assert.rejects(access(temporary),{code:'ENOENT'});
});
