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

test('显式单包打开时只冻结定向选择，正文由生成前的官方 registry 载入',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'}]);
 const items=await f.library.list(),gentle=items.find(item=>item.directoryName==='gentle');
 await bindScope(f.storage,'contact-a','call-legacy');
 const trace=tracked(f.storage);
 const run=await openSqliteSkillRun(f.library,request('call-legacy'),trace,gentle.id);
 t.after(()=>run.close());
 assert.deepEqual(run.selection,skillAnchor(gentle));
 assert.deepEqual(trace.selections.map(entry=>entry.selected),[skillAnchor(gentle)]);
 assert.deepEqual(trace.inputs,[]);
});

test('显式单包不可用时拒绝，不写选择或正文',async t=>{
 const f=await fixture(t,[{name:'gentle',text:'先回应感受。'},{name:'support',text:'再给出可选做法。'}]);
 const support=f.items.find(item=>item.directoryName==='support');
 await f.library.setEnabled(support.id,support.headRevision,'disabled');
 await bindScope(f.storage,'contact-a','call-unavailable');
 const trace=tracked(f.storage);
 await assert.rejects(openSqliteSkillRun(f.library,request('call-unavailable'),trace,support.id),{code:'skill_selection_unavailable'});
 assert.deepEqual(trace.inputs,[]);
 assert.deepEqual(trace.selections,[]);
});
