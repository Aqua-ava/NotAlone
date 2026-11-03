import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary,skillAnchor} from '../src/skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../src/skills/sqlite/provider.ts';

/** 合成 Skill 包夹具；只使用匿名化正文，不接触真实资料。 */
const body=(name,text)=>`---\nname: ${name}\ndescription: 合成${name}回复策略\n---\n\n${text}\n`;
async function fixture(t,specs){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-precall-')));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=join(dir,'originals');
 for(const spec of specs){await mkdir(join(root,spec.name),{recursive:true});await writeFile(join(root,spec.name,'SKILL.md'),body(spec.name,spec.text));}
 const storage=await SqliteStorage.open({userData:dir,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});
 t.after(()=>storage.close());
 await storage.execute('fixture.owner',{ownerId:'owner-a'});
 const library=new SqliteSkillLibrary(storage,'owner-a',root);
 t.after(()=>library.close());
 const items=await library.refresh();
 const byName=new Map(items.map(item=>[item.directoryName,item]));
 return {dir,root,storage,library,items,byName};
}
/** 与正式 SqliteDiscussionSkillProtection 相同的 seam：资格复验、选择事件、实际输入分别记录。 */
function tracked(storage){
 const selections=[],inputs=[];
 const protection={
  selections,inputs,
  async assertCurrent(scope,revision,signal){signal?.throwIfAborted();await storage.execute('fixture.checkScope',{scope,revision});},
  async recordSelection(scope,selected){selections.push({scope,selected});},
  async recordInput(input){await storage.execute('fixture.input',input);inputs.push(structuredClone(input));},
 };
 return protection;
}
async function bindScope(storage,contactId,callId){
 const scope={ownerId:'owner-a',contactId,callId};
 await storage.execute('fixture.scope',scope);
 return {scope,callId};
}
const request=(callId)=>({contactId:'contact-a',callId});

test('多 anchor 预加载返回全部正文、精确修订与目录快照，并逐 anchor 记录选择和实际输入',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'}]);
 const items=await f.library.list();
 const {scope}=await bindScope(f.storage,'contact-a','call-multi');
 const trace=tracked(f.storage);
 const run=await openSqliteSkillRun(f.library,request('call-multi'),trace,{preloadPackageIds:items.map(item=>item.id)});
 t.after(()=>run.close());
 const anchors=items.map(skillAnchor);
 assert.equal(run.preloadOrigin,'auto_preload');
 assert.deepEqual(run.preloadSelection,{origin:'auto_preload',catalogRevision:JSON.stringify(items.map(item=>[item.id,item.headRevision.toString()])),anchors});
 assert.deepEqual(run.catalogRevision,JSON.stringify(items.map(item=>[item.id,item.headRevision.toString()])));
 assert.deepEqual(run.revision.eligible,anchors);
 assert.equal(run.selection,null,'多个预加载 anchor 没有单值兼容投影');
 assert.deepEqual(run.preloadedSkills.map(skill=>[skill.name,skill.anchor.packageId,Number(skill.anchor.revisionNo)]),
  items.map(item=>[item.displayName,item.id,1]));
 for(const [index,anchor] of anchors.entries()){
  assert.equal(anchor.directoryIdentity,items[index].directoryIdentity);
  assert.match(anchor.manifestDigest,/^[a-f0-9]{64}$/);
  assert.match(anchor.contentDigest,/^[a-f0-9]{64}$/);
 }
 assert.match(run.preloadedSkills.find(skill=>skill.name==='gentle').content,/先回应感受/);
 assert.match(run.preloadedSkills.find(skill=>skill.name==='support').content,/再给出可选做法/);
 assert.equal(trace.selections.length,2);
 assert.deepEqual(trace.selections.map(entry=>entry.selected),anchors);
 assert.deepEqual(trace.selections.map(entry=>entry.scope),items.map(()=>scope));
 assert.deepEqual(trace.inputs.map(input=>[input.loaded.packageId,input.relativePath]),items.map(item=>[item.id,'SKILL.md']));
 assert.deepEqual(trace.inputs.map(input=>input.text),run.preloadedSkills.map(skill=>skill.content));
 assert.equal(run.loadedSkills.length,2,'预加载正文同时是已加载正文，供资源读取使用');
 await run.validate();
});

test('显式 selectedPackageId 走多 anchor 入口时仍只预加载指定单包并标记 explicit',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'}]);
 const items=await f.library.list(),gentle=items.find(item=>item.directoryName==='gentle');
 const {scope}=await bindScope(f.storage,'contact-a','call-explicit');
 const trace=tracked(f.storage);
 const run=await openSqliteSkillRun(f.library,request('call-explicit'),trace,{selectedPackageId:gentle.id,preloadPackageIds:items.map(item=>item.id)});
 t.after(()=>run.close());
 assert.equal(run.preloadOrigin,'explicit');
 assert.deepEqual(run.preloadSelection,{origin:'explicit',catalogRevision:JSON.stringify(items.map(item=>[item.id,item.headRevision.toString()])),anchors:[skillAnchor(gentle)]});
 assert.deepEqual(run.selection,skillAnchor(gentle),'显式单包保留单值兼容投影');
 assert.deepEqual(run.preloadedSkills.map(skill=>skill.name),[gentle.displayName]);
 assert.deepEqual(trace.selections.map(entry=>entry.selected),[skillAnchor(gentle)]);
 assert.equal(trace.inputs.length,1);
});

test('旧 selectedPackageId 位置参数保持兼容：打开时只记录定向选择，不预读正文',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'}]);
 const items=await f.library.list(),gentle=items.find(item=>item.directoryName==='gentle');
 await bindScope(f.storage,'contact-a','call-legacy');
 const trace=tracked(f.storage);
 const run=await openSqliteSkillRun(f.library,request('call-legacy'),trace,gentle.id);
 t.after(()=>run.close());
 assert.equal(run.preloadOrigin,null);
 assert.deepEqual(run.selection,skillAnchor(gentle));
 assert.deepEqual(trace.selections.map(entry=>entry.selected),[skillAnchor(gentle)]);
 assert.deepEqual(trace.inputs,[]);
});

test('任一 anchor 失效时整轮预加载失败，不保留其他 Skill 的正文或选择',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'}]);
 const items=await f.library.list(),support=items.find(item=>item.directoryName==='support');
 await bindScope(f.storage,'contact-a','call-broken');
 await writeFile(join(f.root,'support','SKILL.md'),body('support','替换后的不可信合成正文。'));
 const trace=tracked(f.storage);
 await assert.rejects(openSqliteSkillRun(f.library,request('call-broken'),trace,{preloadPackageIds:items.map(item=>item.id)}),{code:'skill_content_changed'});
 assert.deepEqual(trace.inputs,[],'任一 anchor 失败时不能留下其他 Skill 正文');
 assert.deepEqual(trace.selections,[],'校验全部通过前不写选择事件');
 const after=await f.library.get(support.id);
 assert.equal(after.verificationState,'pending','既有正文变化拒绝路径保持');
 assert.equal(after.currentRevisionNo,null);
});

test('自动预加载集合只含 enabled+verified+current，停用、来源失效和缺失不进入',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'},{name:'broken',text:'不应进入的正文。'}]);
 let support=f.byName.get('support');
 support=await f.library.setEnabled(support.id,support.headRevision,'disabled');
 let broken=f.byName.get('broken');
 broken=await f.library.requireVerification(broken.id,broken.headRevision);
 await rm(join(f.root,'broken','SKILL.md'));
 await f.library.refresh();
 const items=await f.library.list();
 assert.equal(items.find(item=>item.id===support.id).enabledState,'disabled');
 const brokenAfter=items.find(item=>item.id===broken.id);
 assert.equal(brokenAfter.currentRevisionNo,null);
 const {scope}=await bindScope(f.storage,'contact-a','call-eligible');
 const trace=tracked(f.storage);
 const run=await openSqliteSkillRun(f.library,request('call-eligible'),trace,{});
 t.after(()=>run.close());
 assert.equal(run.preloadOrigin,'auto_preload');
 assert.deepEqual(run.preloadSelection.anchors,[skillAnchor(items.find(item=>item.directoryName==='gentle'))]);
 assert.deepEqual(run.preloadedSkills.map(skill=>skill.name),['gentle']);
 assert.equal(trace.inputs.length,1);
});

test('没有任何 eligible Skill 时返回空预加载运行，仍保留完整目录快照',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'}]);
 const item=f.items[0];
 await f.library.setEnabled(item.id,item.headRevision,'disabled');
 const items=await f.library.list();
 await bindScope(f.storage,'contact-a','call-empty');
 const trace=tracked(f.storage);
 const run=await openSqliteSkillRun(f.library,request('call-empty'),trace,{});
 t.after(()=>run.close());
 assert.equal(run.preloadOrigin,'auto_preload');
 assert.deepEqual(run.preloadSelection,{origin:'auto_preload',catalogRevision:JSON.stringify(items.map(entry=>[entry.id,entry.headRevision.toString()])),anchors:[]});
 assert.deepEqual(run.preloadedSkills,[]);
 assert.deepEqual(run.revision.eligible,[]);
 assert.deepEqual(run.revision.packages.map(entry=>entry.id),[item.id]);
 assert.deepEqual(trace.inputs,[]);
 assert.deepEqual(trace.selections,[]);
});

test('显式单包不可用或预加载集合含不可用包时整体拒绝且不读正文',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'}]);
 const items=await f.library.list(),gentle=items.find(item=>item.directoryName==='gentle'),support=items.find(item=>item.directoryName==='support');
 const disabled=await f.library.setEnabled(support.id,support.headRevision,'disabled');
 await bindScope(f.storage,'contact-a','call-unavailable');
 const trace=tracked(f.storage);
 await assert.rejects(openSqliteSkillRun(f.library,request('call-unavailable'),trace,{selectedPackageId:support.id}),{code:'skill_selection_unavailable'});
 await assert.rejects(openSqliteSkillRun(f.library,request('call-unavailable'),trace,{preloadPackageIds:[gentle.id,disabled.id]}),{code:'skill_preload_unavailable'});
 assert.deepEqual(trace.inputs,[]);
 assert.deepEqual(trace.selections,[]);
});
