// A4 保护性测试：锁定 SqliteSkillLibrary 批量核验的当前行为，作为回复调用点保持逐个 assertAnchor 的依据。
// 内容：多失败并发窗口下，批量版先按数据库复验失败顺序抛错，不触碰数组更前序 anchor 的目录与"记录问题"副作用；
// 逐个版（调用点现状）在同样场景会先完整核验首序 anchor（含目录读取失败时的 recordProblem）。
// 两者在该窗口的错误优先次序与副作用时点不同，因此 A4 不替换调用点为批量核验（语义在多失败窗口非完全等价）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary,skillAnchor} from '../src/skills/sqlite/library.ts';

async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'notalone-anchor-order-')));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=join(dir,'originals');
 for(const name of ['gentle','steady']){
  await mkdir(join(root,name),{recursive:true});
  await writeFile(join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: 合成表达\n---\n\n先回应感受。\n说明情况。\n保留选择。\n`);
 }
 const storage=await SqliteStorage.open({userData:dir,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});
 t.after(()=>storage.close());await storage.execute('fixture.owner',{ownerId:'owner-a'});
 const library=new SqliteSkillLibrary(storage,'owner-a',root);
 const catalog=await library.refresh();
 assert.equal(catalog.length,2);
 const first=catalog.find(item=>item.directoryName==='gentle'),second=catalog.find(item=>item.directoryName==='steady');
 assert.ok(first&&second);
 return {library,storage,first,second,root};
}

test('双方均有效时批量核验通过，单 anchor 结果与逐个一致',async t=>{
 const {library,first,second}=await fixture(t);
 const [verifiedFirst,verifiedSecond]=await library.assertAnchors([skillAnchor(first),skillAnchor(second)]);
 assert.equal(verifiedFirst.item.id,first.id);
 assert.equal(verifiedSecond.item.id,second.id);
});

test('并发双失败窗口：批量先抛次序 anchor 的数据库失效，不触发首序 anchor 的记录问题',async t=>{
 const {library,storage,first,second,root}=await fixture(t);
 const anchors=[skillAnchor(first),skillAnchor(second)];
 // 次序 anchor 的数据库修订先被并发式显式失效；随后首序 anchor 的目录内容也被改动。
 await storage.execute('skills.invalidate',{ownerId:'owner-a',id:second.id,expectedHead:second.headRevision,verificationState:'pending',reason:'synthetic_drift'});
 await writeFile(join(root,'gentle','SKILL.md'),'---\nname: gentle\ndescription: 并发改动\n---\n\n内容被替换。\n');
 await assert.rejects(library.assertAnchors(anchors),{code:'skill_run_invalidated'});
 // 批量版在首轮数据库复验即抛错：首序 anchor 的目录问题未被读取、未记录，也未被置失效。
 const after=await library.list();
 assert.equal(after.find(item=>item.id===first.id)?.verificationState,'verified');
 assert.equal(after.find(item=>item.id===second.id)?.verificationState,'pending');
 // 单独批量核验首序 anchor 时才走目录路径并记录问题（对应逐个版会先做的事）。
 await assert.rejects(library.assertAnchor(anchors[0]),(error)=>['skill_content_changed','skill_directory_conflict','skill_directory_content_changed'].includes(error.code));
 const settled=await library.list();
 assert.equal(settled.find(item=>item.id===first.id)?.verificationState,'pending');
 assert.equal(settled.find(item=>item.id===first.id)?.verificationReason,'content_changed');
});
