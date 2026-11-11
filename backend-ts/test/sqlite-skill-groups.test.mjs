import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary} from '../src/skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../src/skills/sqlite/provider.ts';
import {SqliteSkillHttp} from '../src/skills/sqlite/http.ts';
import {createServer} from 'node:http';
import {once} from 'node:events';

const owner='owner-a';
async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-groups-')));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=join(dir,'originals');
 for(const name of ['gentle','direct']){
  await mkdir(join(root,name),{recursive:true});
  await writeFile(join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: 合成场景 ${name}\n---\n\n合成策略 ${name}。\n`);
 }
 const storage=await SqliteStorage.open({userData:dir,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});
 t.after(()=>storage.close());await storage.execute('fixture.owner',{ownerId:owner});
 for(const contactId of ['lover','colleague','stranger'])await storage.execute('fixture.contact',{ownerId:owner,contactId});
 const library=new SqliteSkillLibrary(storage,owner,root),skills=await library.refresh();
 const byName=Object.fromEntries(skills.map(s=>[s.directoryName,s]));
 return {dir,root,storage,library,gentle:byName.gentle,direct:byName.direct};
}
function protection(storage){
 return {async assertCurrent(scope,revision,signal){signal?.throwIfAborted();if(revision)await storage.execute('skills.assertRun',{ownerId:scope.ownerId,revision});},
  async recordSelection(){},async recordInput(input){await storage.execute('skills.assertRun',{ownerId:input.scope.ownerId,revision:input.runRevision});}};
}
const names=run=>run.revision.eligible.map(a=>a.packageId).sort();

test('分组创建、重命名、改绑定按修订推进，重名与非法名称被拒绝',async t=>{
 const {library,gentle,direct}=await fixture(t);
 const group=await library.createGroup('恋人',[gentle.id]);
 assert.equal(group.name,'恋人');assert.equal(group.revision,1n);assert.deepEqual(group.packageIds,[gentle.id]);
 await assert.rejects(library.createGroup('恋人',[]),{code:'skill_group_name_conflict'});
 for(const bad of ['',' 同事','同事 ','x'.repeat(31),'a\nb'])await assert.rejects(library.createGroup(bad,[]),{code:'skill_group_name_invalid'});
 await assert.rejects(library.createGroup('同事',['00000000-0000-0000-0000-000000000000']),{code:'skill_missing'});
 const same=await library.updateGroup(group.id,1n,'恋人',[gentle.id]);
 assert.equal(same.revision,1n,'没有实际变化不推进修订');
 const renamed=await library.updateGroup(group.id,1n,'亲密关系',[gentle.id,direct.id]);
 assert.equal(renamed.revision,2n);assert.deepEqual(renamed.packageIds,[gentle.id,direct.id].sort());
 await assert.rejects(library.updateGroup(group.id,1n,'亲密关系',[]),{code:'skill_group_revision_conflict'});
 assert.deepEqual((await library.listGroups()).map(g=>g.name),['亲密关系']);
});

test('联系人最多归入一个分组，分配带预期值校验并要求联系人仍有效',async t=>{
 const {library,storage,gentle}=await fixture(t);
 const a=await library.createGroup('恋人',[gentle.id]),b=await library.createGroup('同事',[]);
 await library.assignContactGroup('lover',a.id,null);
 await assert.rejects(library.assignContactGroup('lover',b.id,null),{code:'skill_group_assignment_conflict'});
 await library.assignContactGroup('lover',b.id,a.id);
 const groups=await library.listGroups();
 assert.deepEqual(groups.find(g=>g.id===a.id).contactIds,[]);assert.deepEqual(groups.find(g=>g.id===b.id).contactIds,['lover']);
 await assert.rejects(library.assignContactGroup('ghost',a.id,null),{code:'skill_contact_unavailable'});
 await storage.execute('fixture.contactState',{ownerId:owner,contactId:'colleague',state:'deleting'});
 await assert.rejects(library.assignContactGroup('colleague',a.id,null),{code:'skill_contact_unavailable'});
 await assert.rejects(library.assignContactGroup('stranger','00000000-0000-0000-0000-000000000000',null),{code:'skill_group_missing'});
 await library.assignContactGroup('lover',null,b.id);
 assert.deepEqual((await library.groupScope('lover')).packageIds,[]);
});

test('未分组联系人不使用任何 Skill，不同分组只看到各自绑定的 Skill',async t=>{
 const {library,storage,gentle,direct}=await fixture(t);
 const lovers=await library.createGroup('恋人',[gentle.id]),work=await library.createGroup('同事',[direct.id]);
 await library.assignContactGroup('lover',lovers.id,null);await library.assignContactGroup('colleague',work.id,null);
 const trace=protection(storage);
 const open=contactId=>openSqliteSkillRun(library,{contactId,callId:`call-${contactId}`},trace);
 const lover=await open('lover'),colleague=await open('colleague'),stranger=await open('stranger');
 t.after(()=>{lover.close();colleague.close();stranger.close();});
 assert.deepEqual(names(lover),[gentle.id]);assert.deepEqual(names(colleague),[direct.id]);
 assert.deepEqual(names(stranger),[],'未分组默认不使用 Skill');
 assert.deepEqual(stranger.revision.group,{contactId:'stranger',groupId:null,revision:0n});
 assert.equal(lover.revision.group.groupId,lovers.id);
 await assert.rejects(openSqliteSkillRun(library,{contactId:'lover',callId:'x'},trace,direct.id),{code:'skill_selection_unavailable'});
 await assert.rejects(openSqliteSkillRun(library,{contactId:'stranger',callId:'y'},trace,{preloadPackageIds:[gentle.id]}),{code:'skill_preload_unavailable'});
 const preload=await openSqliteSkillRun(library,{contactId:'colleague',callId:'z'},trace,{});
 t.after(()=>preload.close());assert.deepEqual(preload.preloadSelection.anchors.map(a=>a.packageId),[direct.id]);
});

test('分配、绑定或分组被改动后，已冻结的运行资格立即失效',async t=>{
 const {library,storage,gentle,direct}=await fixture(t);
 const group=await library.createGroup('恋人',[gentle.id]);await library.assignContactGroup('lover',group.id,null);
 const trace=protection(storage),open=callId=>openSqliteSkillRun(library,{contactId:'lover',callId},trace);
 let run=await open('c1');await run.validate();
 await library.updateGroup(group.id,1n,'恋人',[gentle.id,direct.id]);
 await assert.rejects(run.validate(),{code:'skill_run_invalidated'});
 run=await open('c2');await run.validate();
 await library.assignContactGroup('lover',null,group.id);
 await assert.rejects(run.validate(),{code:'skill_run_invalidated'});
 await library.assignContactGroup('lover',group.id,null);
 run=await open('c3');await run.validate();
 await library.deleteGroup(group.id,2n);
 await assert.rejects(run.validate(),{code:'skill_run_invalidated'});
 assert.deepEqual((await library.groupScope('lover')).packageIds,[],'删除分组后联系人回到未分组');
 // 未分组时冻结的运行在联系人被分配后同样失效。
 run=await open('c4');await run.validate();
 const next=await library.createGroup('新分组',[gentle.id]);await library.assignContactGroup('lover',next.id,null);
 await assert.rejects(run.validate(),{code:'skill_run_invalidated'});
});

test('运行修订必须带分组范围，缺失或越出分组绑定的可用 Skill 被拒绝',async t=>{
 const {library,storage,gentle,direct}=await fixture(t);
 const group=await library.createGroup('恋人',[gentle.id]);await library.assignContactGroup('lover',group.id,null);
 const run=await openSqliteSkillRun(library,{contactId:'lover',callId:'c'},protection(storage));t.after(()=>run.close());
 const revision=run.revision;
 assert.equal(await storage.execute('skills.assertRun',{ownerId:owner,revision}),true);
 const {group:_,...withoutGroup}=revision;
 await assert.rejects(storage.execute('skills.assertRun',{ownerId:owner,revision:withoutGroup}),{code:'skill_run_invalidated'});
 assert.equal(await storage.execute('skills.assertRun',{ownerId:owner,revision:{...withoutGroup,eligible:[]}}),true,'无可用 Skill 的修订不需要分组');
 const other=await library.get(direct.id);
 const widened={...revision,eligible:[...revision.eligible,{packageId:other.id,revisionNo:other.currentRevisionNo,headRevision:other.headRevision,directoryIdentity:other.directoryIdentity,
  manifestDigest:other.revisions[0].manifestDigest,contentDigest:other.revisions[0].contentDigest}]};
 await assert.rejects(storage.execute('skills.assertRun',{ownerId:owner,revision:widened}),{code:'skill_run_invalidated'});
 await assert.rejects(storage.execute('skills.assertRun',{ownerId:owner,revision:{...revision,group:{...revision.group,contactId:'colleague'}}}),{code:'skill_run_invalidated'});
});

test('包停用只影响运行资格，分组绑定保留',async t=>{
 const {library,storage,gentle,direct}=await fixture(t);
 const lovers=await library.createGroup('恋人',[gentle.id,direct.id]);await library.assignContactGroup('lover',lovers.id,null);
 await library.setEnabled(direct.id,direct.headRevision,'disabled');
 const run=await openSqliteSkillRun(library,{contactId:'lover',callId:'c'},protection(storage));t.after(()=>run.close());
 assert.deepEqual(names(run),[gentle.id],'停用的包不会因分组而启用');
 assert.deepEqual((await library.listGroups())[0].packageIds,[gentle.id,direct.id].sort());
});

test('联系人范围删除只清该联系人的分配，账号删除清分组及绑定',async t=>{
 const {library,storage,gentle}=await fixture(t);
 const group=await library.createGroup('恋人',[gentle.id]);
 await library.assignContactGroup('lover',group.id,null);await library.assignContactGroup('colleague',group.id,null);
 const contact={ownerId:owner,operationId:'op-1',scope:{kind:'contact',contactId:'lover'}};
 assert.equal((await storage.execute('fixture.skillVerify',contact)).database_rows.result,'blocked');
 const targets=await storage.execute('fixture.skillTargets',contact);
 assert.deepEqual(targets.map(x=>x.rowKind),['contact_skill_group']);
 await storage.execute('fixture.skillClear',{operation:contact,target:targets[0]});
 await storage.execute('fixture.skillClear',{operation:contact,target:targets[0]});
 assert.equal((await storage.execute('fixture.skillVerify',contact)).database_rows.result,'passed');
 assert.equal((await library.groupScope('lover')).groupId,null);assert.equal((await library.groupScope('colleague')).groupId,group.id);
 await assert.rejects(storage.execute('fixture.skillClear',{operation:{...contact,scope:{kind:'contact',contactId:'colleague'}},target:targets[0]}),{code:'skill_deletion_target_invalid'});
 await storage.execute('fixture.deleteContact',{ownerId:owner,contactId:'colleague'});
 assert.equal((await library.listGroups())[0].contactIds.length,0,'联系人被删除时分配随之清除');
 await library.assignContactGroup('stranger',group.id,null);

 const account={ownerId:owner,operationId:'op-2',scope:{kind:'account'}};
 await storage.execute('fixture.ownerState',{ownerId:owner,state:'deleting'});
 await storage.execute('fixture.skillFence',account);
 const accountTargets=await storage.execute('fixture.skillTargets',account);
 assert.ok(accountTargets.some(x=>x.rowKind==='skill_group'));
 assert.equal((await storage.execute('fixture.skillVerify',account)).database_rows.result,'blocked');
 for(const target of accountTargets)await storage.execute('fixture.skillClear',{operation:account,target});
 const verified=await storage.execute('fixture.skillVerify',account);
 assert.equal(verified.database_rows.result,'passed');
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('分组 HTTP：认证、确认、预期修订校验与联系人分配，错误码区分请求非法与冲突',async t=>{
 const {library,gentle}=await fixture(t);
 const http=new SqliteSkillHttp(library,req=>req.headers.authorization==='Bearer synthetic-only'&&!req.headers.origin);
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res))res.writeHead(404).end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections?.();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,body,headers={authorization:'Bearer synthetic-only'},method)=>{
  const res=await fetch(base+path,{method:method??(body?'POST':'GET'),headers:{...headers,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:res.status,body:await res.json().catch(()=>null)};
 };
 assert.equal((await call('/api/skills/groups',null,{})).status,401);
 assert.deepEqual((await call('/api/skills/groups')).body,{storage:'sqlite',groups:[]});
 assert.equal((await call('/api/skills/groups',{name:'恋人',package_ids:[gentle.id],confirmed:false})).status,400);
 assert.equal((await call('/api/skills/groups',{name:'恋人',package_ids:[gentle.id],confirmed:true,owner_id:'other'})).status,400);
 assert.equal((await call('/api/skills/groups',{name:' 恋人',package_ids:[],confirmed:true})).status,400);
 const created=(await call('/api/skills/groups',{name:'恋人',package_ids:[gentle.id],confirmed:true})).body.group;
 assert.deepEqual(created,{group_id:created.group_id,name:'恋人',revision:'1',package_ids:[gentle.id],contact_ids:[]});
 assert.equal((await call('/api/skills/groups',{name:'恋人',package_ids:[],confirmed:true})).status,409);
 const updated=(await call(`/api/skills/groups/${created.group_id}/update`,{expected_revision:'1',name:'恋人',package_ids:[],confirmed:true})).body.group;
 assert.equal(updated.revision,'2');assert.deepEqual(updated.package_ids,[]);
 assert.equal((await call(`/api/skills/groups/${created.group_id}/update`,{expected_revision:'1',name:'恋人',package_ids:[gentle.id],confirmed:true})).status,409);
 const assigned=await call('/api/skills/contacts/lover/group',{group_id:created.group_id,expected_group_id:null,confirmed:true});
 assert.deepEqual(assigned.body,{contact_id:'lover',group_id:created.group_id});
 assert.equal((await call('/api/skills/contacts/lover/group',{group_id:null,expected_group_id:null,confirmed:true})).status,409);
 assert.deepEqual((await call('/api/skills/groups')).body.groups[0].contact_ids,['lover']);
 assert.equal((await call('/api/skills/contacts/ghost/group',{group_id:created.group_id,expected_group_id:null,confirmed:true})).status,409);
 assert.equal((await call(`/api/skills/groups/${created.group_id}/delete`,{expected_revision:'1',confirmed:true})).status,409);
 assert.deepEqual((await call(`/api/skills/groups/${created.group_id}/delete`,{expected_revision:'2',confirmed:true})).body,{deleted:true,group_id:created.group_id});
 assert.deepEqual((await call('/api/skills/groups')).body.groups,[]);
 assert.equal((await call('/api/skills/groups',null,undefined,'DELETE')).status,405);
});
