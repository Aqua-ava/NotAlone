import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {createScope} from '@deepseek-ai/dsh-scope';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary,skillAnchor} from '../src/skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../src/skills/sqlite/provider.ts';

async function fixture(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-resources-')));
 const root=join(directory,'originals');await mkdir(root);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const storage=await SqliteStorage.open({userData:directory,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});
 t.after(()=>storage.close());await storage.execute('fixture.owner',{ownerId:'owner-a'});
 const library=new SqliteSkillLibrary(storage,'owner-a',root),items=[];
 for(const name of ['gentle','clear']){
  await mkdir(join(root,name,'references'),{recursive:true});
  await writeFile(join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: 用于合成回复场景\n---\n先了解表达方向。\n保留本意。\n参考 references/guide.md。\n`);
  await writeFile(join(root,name,'references/guide.md'),`${name} 的合成辅助说明。`);
  const item=await library.discover(name);items.push(await library.setEnabled(item.id,item.headRevision,'enabled'));
 }
 const ctx=new Context();await ctx.plugin(SkillRegistry);t.after(()=>ctx.fiber.dispose());
 const key={},layer=createScope(ctx,key);t.after(()=>layer.dispose());
 const scope={ownerId:'owner-a',contactId:'contact-a',callId:'resource-call'};await storage.execute('fixture.scope',scope);
 const selections=[],protection={
  assertCurrent:(scope,revision,signal)=>{signal?.throwIfAborted();return storage.execute('fixture.checkScope',{scope,revision});},
  recordSelection:async(scope,selected,signal)=>{signal?.throwIfAborted();selections.push({scope,selected});},
  recordInput:async(input,signal)=>{signal?.throwIfAborted();await storage.execute('fixture.input',input);},
 };
 return {root,storage,library,items,ctx,key,layer,scope,selections,protection};
}

test('自动选择单个 Skill 后公开真实加载名称与版本资源清单，选择和正文分别记录',async t=>{
 const f=await fixture(t),run=await openSqliteSkillRun(f.library,f.scope,f.protection);run.mount(f.layer.ctx);
 assert.equal(run.loaded,null);assert.equal(run.selection,null);
 await f.ctx.skills.get('gentle',{scope:f.key});
 assert.equal(run.loaded.name,'gentle');assert.deepEqual(run.loaded.anchor,skillAnchor(f.items[0]));
 assert.equal(run.loaded.resources.length,1);assert.equal(run.loaded.resources[0].relativePath,'references/guide.md');
 assert.equal(run.loaded.resources[0].mediaType,'text/markdown');assert.match(run.loaded.resources[0].payloadDigest,/^[a-f0-9]{64}$/);
 assert.deepEqual(run.selection,skillAnchor(f.items[0]));assert.deepEqual(f.selections.at(-1).selected,skillAnchor(f.items[0]));
 const inputs=await f.storage.execute('fixture.inputs',f.scope);assert.equal(inputs.length,1);assert.equal(inputs[0].relative_path,'SKILL.md');
 const revision=run.revision;assert.equal(revision.eligible.length,2);revision.eligible.length=0;assert.equal(run.revision.eligible.length,2);
 const loaded=run.loaded;loaded.resources.length=0;assert.equal(run.loaded.resources.length,1);
 assert.equal(await run.readLoadedResource('references/guide.md'),'gentle 的合成辅助说明。');
 run.close();
});

test('自动选择记录失败后关闭本轮，重复读取不能跳过失败记录',async t=>{
 const f=await fixture(t);f.protection.recordSelection=async(_scope,selected)=>{if(selected)throw Object.assign(new Error('selection unavailable'),{code:'fixture_selection_unavailable'});};
 const run=await openSqliteSkillRun(f.library,f.scope,f.protection);run.mount(f.layer.ctx);
 await assert.rejects(f.ctx.skills.get('gentle',{scope:f.key}),{code:'fixture_selection_unavailable'});
 assert.equal(run.loaded,null);
 await assert.rejects(run.validate(),{code:'skill_run_invalidated'});
 assert.deepEqual(await f.storage.execute('fixture.inputs',f.scope),[]);
});

test('辅助读取只接受已加载版本清单，拒绝第二 Skill、未列路径、遍历、脚本和URL',async t=>{
 const f=await fixture(t),run=await openSqliteSkillRun(f.library,f.scope,f.protection);run.mount(f.layer.ctx);
 await assert.rejects(run.readLoadedResource('references/guide.md'),{code:'skill_body_required'});
 await f.ctx.skills.get('gentle',{scope:f.key});
 await assert.rejects(f.ctx.skills.get('clear',{scope:f.key}),{code:'second_skill_load'});
 await assert.rejects(run.readResource(skillAnchor(f.items[1]),'references/guide.md'),{code:'skill_body_required'});
 for(const path of ['references/missing.md','../clear/references/guide.md','/tmp/outside.txt','references/../../SKILL.md','references/tool.sh','https://example.test/guide.md']){
  await assert.rejects(run.readLoadedResource(path),{code:'skill_path_invalid'});
 }
 assert.equal(await run.readLoadedResource('references/guide.md'),'gentle 的合成辅助说明。');
 const rows=await f.storage.execute('fixture.inputs',f.scope);assert.equal(rows.length,2);assert.equal(rows[1].package_id,f.items[0].id);
 run.close();
});

test('资源变更或链接替换使版本失效，旧缓存不得返回文字',async t=>{
 for(const replacement of ['content','symlink'])await t.test(replacement,async t=>{
  const f=await fixture(t),run=await openSqliteSkillRun(f.library,f.scope,f.protection);run.mount(f.layer.ctx);
  await f.ctx.skills.get('gentle',{scope:f.key});
  const path=join(f.root,'gentle/references/guide.md');
  if(replacement==='content')await writeFile(path,'已替换的合成内容。');
  else{await rm(path);await symlink(join(f.root,'clear/references/guide.md'),path);}
  await assert.rejects(run.readLoadedResource('references/guide.md'));
  await assert.rejects(run.validate(),{code:'skill_run_invalidated'});
  const rows=await f.storage.execute('fixture.inputs',f.scope);assert.equal(rows.length,1);
 });
});

test('停用、来源撤销或切换联系人后不能继续辅助读取',async t=>{
 for(const action of ['disable','source','contact'])await t.test(action,async t=>{
  const f=await fixture(t),run=await openSqliteSkillRun(f.library,f.scope,f.protection);run.mount(f.layer.ctx);
  await f.ctx.skills.get('gentle',{scope:f.key});
  if(action==='disable')await f.library.setEnabled(f.items[0].id,f.items[0].headRevision,'disabled');
  else if(action==='source')await f.library.requireVerification(f.items[0].id,f.items[0].headRevision);
  else await f.storage.execute('fixture.revoke',f.scope);
  await assert.rejects(run.readLoadedResource('references/guide.md'));
  if(action==='contact'){
   assert.deepEqual(await f.storage.execute('fixture.inputs',f.scope),[]);
   await assert.rejects(openSqliteSkillRun(f.library,{...f.scope,contactId:'contact-b'},f.protection),{code:'fixture_scope_revoked'});
  }else assert.equal((await f.storage.execute('fixture.inputs',f.scope)).length,1);
 });
});

test('资源读取中取消或来源删除拒绝迟到结果，释放scope不保留旧目录',async t=>{
 for(const action of ['cancel','source','scope'])await t.test(action,async t=>{
  const f=await fixture(t);let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const original=f.protection.recordInput;
  f.protection.recordInput=async(input,signal)=>{
   if(input.relativePath!=='SKILL.md'){entered();await gate;}
   await original(input,signal);
  };
  const controller=new AbortController(),run=await openSqliteSkillRun(f.library,f.scope,f.protection,undefined,controller.signal);run.mount(f.layer.ctx);
  await f.ctx.skills.get('gentle',{scope:f.key});
  const pending=assert.rejects(run.readLoadedResource('references/guide.md'));
  await waiting;
  if(action==='cancel')controller.abort();
  else if(action==='source')await f.storage.execute('fixture.revoke',f.scope);
  else await f.layer.dispose();
  release();await pending;await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.storage.execute('fixture.inputs',f.scope)).length,action==='source'?0:1);
  assert.deepEqual((await f.ctx.skills.snapshot({scope:f.key})).skills,[]);
 });
});

test('provider 保留首次真实失败，关闭产生的失效原因不能覆盖授权错误',async t=>{
 const f=await fixture(t),run=await openSqliteSkillRun(f.library,f.scope,f.protection);run.mount(f.layer.ctx);
 assert.equal(run.failure,null);
 await f.ctx.skills.get('gentle',{scope:f.key});
 await f.storage.execute('fixture.revoke',f.scope);
 let reason;
 await assert.rejects(run.readLoadedResource('references/guide.md'),error=>{reason=error;assert.equal(error.code,'fixture_scope_revoked');return true;});
 assert.equal(run.failure,reason);
 run.close();await assert.rejects(run.validate(),{code:'skill_run_invalidated'});
 assert.equal(run.failure,reason);
});
