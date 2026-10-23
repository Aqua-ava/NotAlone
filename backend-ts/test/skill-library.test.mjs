import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { HostStorage } from '../src/host-storage.ts';
import { SkillLibrary } from '../src/skill-library.ts';
import { SkillFiles } from '../src/skill-files.ts';

test('管理入口导入合成包并保留原 owner 和版本身份', async t => {
  const f=await createStorageFixture(); t.after(()=>f.close());
  const storage=await HostStorage.open(f.options); t.after(()=>storage.close());
  await storage.initializeOwner('合成用户');
  const path=join(f.directory,'gentle-reply'); await mkdir(path);
  await writeFile(join(path,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n先回应感受，再说明情况。\n');
  const library=new SkillLibrary(storage,new SkillFiles(join(f.directory,'skills')));
  const imported=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
  assert.equal(imported.version_number,1);
  const result=await library.handle('GET',new URL('http://local/api/skills'));
  assert.equal(result.skills.length,1); assert.equal(result.skills[0].skill_id,imported.skill_id);
  assert.equal(result.skills[0].description,'温和回应');
  const preview=await library.handle('GET',new URL(`http://local/api/skills/${imported.skill_id}/preview`));
  assert.equal(preview.document,'先回应感受，再说明情况。\n');
});

test('管理入口保留停用决定、版本回滚、导出以及删除不复活', async t=>{
  const f=await createStorageFixture();t.after(()=>f.close());
  const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
  const {owner_id:owner}=await storage.initializeOwner('合成用户');
  const path=join(f.directory,'gentle-reply');await mkdir(path);
  const doc=body=>`---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n${body}\n`;
  await writeFile(join(path,'SKILL.md'),doc('先回应感受。'));
  const library=new SkillLibrary(storage,new SkillFiles(join(f.directory,'skills')));
  const imported=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
  const endpoint=action=>new URL(`http://local/api/skills/${imported.skill_id}/${action}`);
  const first=(await library.handle('GET',endpoint('versions'))).versions[0];
  await library.handle('POST',endpoint('disable'));
  await writeFile(join(path,'SKILL.md'),doc('先确认情况，再回应感受。'));
  await library.updatePackage(owner,path);
  assert.equal((await library.handle('GET',new URL('http://local/api/skills'))).skills[0].status,'disabled');
  assert.equal((await library.handle('GET',endpoint('versions'))).versions.length,2);
  await library.handle('POST',endpoint('rollback'),{version_id:first.version_id});
  assert.equal((await library.handle('GET',endpoint('preview'))).document,'先回应感受。\n');
  await library.exportPackage(owner,imported.skill_id,join(f.directory,'exported'));
  await library.handle('POST',endpoint('delete'));
  await assert.rejects(()=>library.handle('POST',endpoint('enable')),e=>e.code==='skill_deleted');
  const list=await library.handle('GET',new URL('http://local/api/skills'));
  assert.equal(list.skills[0].status,'deleted');assert.equal(list.skills[0].current_version_id,null);
});

test('文件清理失败先撤销资格、保留重试队列且不宣称删除成功',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
 await storage.initializeOwner('合成用户');
 const path=join(f.directory,'gentle-reply');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n回应感受。\n');
 class FailingFiles extends SkillFiles {remove(){throw Error('合成磁盘拒绝');}}
 const library=new SkillLibrary(storage,new FailingFiles(join(f.directory,'skills')));
 const entry=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
 const endpoint=new URL(`http://local/api/skills/${entry.skill_id}/delete`);
 await assert.rejects(()=>library.handle('POST',endpoint),e=>e.code==='skill_persistence_failed');
 const state=await library.handle('GET',new URL('http://local/api/skills'));
 assert.equal(state.skills[0].status,'deleted');assert.equal(state.skills[0].current_version_id,null);
 const retry=new SkillLibrary(storage,new SkillFiles(join(f.directory,'skills')));
 assert.equal((await retry.handle('POST',endpoint)).deleted,true);
});

test('目录刷新发现新增编辑、拒绝坏包并保持其他包和停用决定',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
 const {owner_id:owner}=await storage.initializeOwner('合成用户');const root=join(f.directory,'skills');
 const library=new SkillLibrary(storage,new SkillFiles(root));const directory=join(root,owner,'gentle-reply');await mkdir(directory,{recursive:true});
 const doc=body=>`---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n${body}\n`;
 await writeFile(join(directory,'SKILL.md'),doc('第一版。'));
 const list=()=>library.handle('GET',new URL('http://local/api/skills'));
 const first=(await list()).skills[0];await library.handle('POST',new URL(`http://local/api/skills/${first.skill_id}/disable`));
 await writeFile(join(directory,'SKILL.md'),doc('第二版。'));
 const second=(await list()).skills[0];assert.equal(second.skill_id,first.skill_id);assert.equal(second.current_version_number,2);assert.equal(second.status,'disabled');
 assert.equal((await list()).skills[0].current_version_number,2);
 await writeFile(join(directory,'SKILL.md'),'损坏的包');
 await list();
 await writeFile(join(directory,'SKILL.md'),doc('第二版。'));
 assert.equal((await list()).skills[0].current_version_number,2);
 await library.handle('POST',new URL(`http://local/api/skills/${first.skill_id}/delete`));
 await mkdir(directory,{recursive:true});await writeFile(join(directory,'SKILL.md'),doc('第三版。'));
 assert.equal((await list()).skills[0].status,'deleted');
});

test('跨owner不可查看或修改且取消事务不发布新版本',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
 const {owner_id:owner}=await storage.initializeOwner('合成用户');const library=new SkillLibrary(storage,new SkillFiles(join(f.directory,'skills')));
 const path=join(f.directory,'gentle-reply');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n回应感受。\n');
 let checks=0;
 await assert.rejects(()=>library.importPackage(owner,path,()=>{if(++checks>=2)throw Error('合成取消');}));
 assert.equal((await library.list(owner)).length,0);
 const entry=await library.importPackage(owner,path);
 const other='00000000-0000-4000-8000-000000000099';await f.client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)',[other,'另一合成用户']);
 await assert.rejects(()=>library.preview(other,entry.skill_id),e=>e.code==='skill_not_found');
 await assert.rejects(()=>library.setStatus(other,entry.skill_id,'disabled'),e=>e.code==='skill_not_found');
 assert.equal((await library.list(owner))[0].enabled,true);
});

test('配置托管资料时缺备份清理依赖拒绝删除并保留可用版本',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open({...f.options,environment:{NOTALONE_MANAGED_USER_DATA:f.directory}});t.after(()=>storage.close());
 await storage.initializeOwner('合成用户');const path=join(f.directory,'gentle-reply');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n回应感受。\n');
 const library=new SkillLibrary(storage,new SkillFiles(join(f.directory,'skills')));const entry=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
 await assert.rejects(()=>library.handle('POST',new URL(`http://local/api/skills/${entry.skill_id}/delete`)),e=>e.code==='update_backup_cleanup_required');
 assert.equal((await library.handle('GET',new URL(`http://local/api/skills/${entry.skill_id}/preview`))).document,'回应感受。\n');
});

test('过期工作副本任务不覆盖当前版本且文件健康状态可重试恢复',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());const {owner_id:owner}=await storage.initializeOwner('合成用户');
 const root=join(f.directory,'skills'),path=join(f.directory,'gentle-reply');await mkdir(path);
 const doc=body=>`---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n${body}\n`;
 await writeFile(join(path,'SKILL.md'),doc('第一版。'));const library=new SkillLibrary(storage,new SkillFiles(root));const entry=await library.importPackage(owner,path);
 const original=(await library.versions(owner,entry.skill_id))[0];await writeFile(join(path,'SKILL.md'),doc('第二版。'));await library.updatePackage(owner,path);
 await f.client.query('INSERT INTO public.reply_skill_working_copy(skill_id,version_id) VALUES($1,$2)',[entry.skill_id,original.version_id]);
 await library.reconcileFiles(owner);
 assert.equal((await library.list(owner))[0].current_version_number,2);
 assert.equal((await library.fileHealth(owner)).pending_working_copies,0);
 class FailingWorkingFiles extends SkillFiles {writeWorking(){throw Error('合成磁盘写入失败');}}
 const failure=new SkillLibrary(storage,new FailingWorkingFiles(root));await writeFile(join(path,'SKILL.md'),doc('第三版。'));await failure.updatePackage(owner,path);
 assert.equal((await failure.fileHealth(owner)).state,'degraded');
 assert.equal((await failure.fileHealth(owner)).failures[0].code,'file_unavailable');
 await library.reconcileFiles(owner);assert.equal((await library.fileHealth(owner)).state,'ok');
 assert.equal((await library.preview(owner,entry.skill_id)).document,'第三版。\n');
});

test('历史版本时间保留原数据库微秒且预览不发现新增工作包',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());const {owner_id:owner}=await storage.initializeOwner('合成用户');
 const root=join(f.directory,'skills'),path=join(f.directory,'gentle-reply');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n回应感受。\n');
 const library=new SkillLibrary(storage,new SkillFiles(root)),entry=await library.importPackage(owner,path);
 await f.client.query("UPDATE public.reply_skill_version SET created_at='2026-01-02T03:04:05.123456+00:00' WHERE skill_id=$1",[entry.skill_id]);
 assert.equal((await library.versions(owner,entry.skill_id))[0].created_at,'2026-01-02T03:04:05.123456+00:00');
 const extra=join(root,owner,'second-reply');await mkdir(extra);await writeFile(join(extra,'SKILL.md'),'---\nname: second-reply\ndescription: "另一个回应"\n---\n\n说明情况。\n');
 await library.preview(owner,entry.skill_id);assert.equal((await library.versions(owner,entry.skill_id)).length,1);
 await rm(extra,{recursive:true});assert.equal((await library.list(owner)).length,1);
 assert.equal((await library.fileHealth(owner)).state,'ok');
});
