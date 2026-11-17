import {modelToolResponse} from './fixtures/model-tool-response.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
const owner='00000000-0000-4000-8000-000000000001';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-candidates-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人',kind:'private',identityAssurance:'verified'}))});
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const snap=await contacts.candidates(true);await contacts.confirm(snap.snapshot_token,['a','b'].map(locator=>({locator,observed_display_name:'合成联系人',expected_selection_generation:'0'})));
 const ids=(await contacts.directory()).contacts.map(c=>c.contact_id),discussions=new SqliteDiscussionService(storage,owner);
 return {root,storage,contacts,ids,discussions,candidates:new SqliteReplyCandidateService(storage,owner)};
}
test('已确认联系人可立即受理候选，历史未开始不阻塞也不授予读取',async t=>{
 const f=await fixture(t),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const result=await f.candidates.begin({contactId,discussionId:discussion.id,requestKey,text:'帮我自然地回应',identity:{kind:'manual',confirmationId}});
 assert.match(result.coverageWarning,/历史覆盖不完整/);
 assert.equal((await f.discussions.view(contactId,discussion.id)).entries.length,1);
 assert.equal((await f.contacts.directory()).read_enabled,false);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正常模型输入产生v1多条消息，编辑追加v2且选择固定版本，历史回看不重新调用',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');
 const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const content=JSON.stringify({candidates:[{parts:['我理解你的意思。','我们晚点再聊。'],basis:[1]}]});
 const f=await realFixture(t,{content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'帮我自然地回应',confirmedContact:true};
 await turns.generate(input);
 const view=(await service.view(contactId,discussion.id))[0],first=view.candidates[0];
 assert.deepEqual(first.parts,['我理解你的意思。','我们晚点再聊。']);assert.equal(first.versionNo,1);assert.equal(first.origin,'model');assert.equal(first.basis[0].verification,'actual_input');
 const scope={contactId,discussionId:discussion.id,candidateId:first.candidateId};
 const edited=await service.edit({...scope,versionNo:1,parts:['我明白啦。','我们明天再聊。']});
 assert.equal(edited.versionNo,2);assert.equal(edited.parentVersionNo,1);assert.equal(edited.basis[0].verification,'inherited_unverified');
 const one=await service.select({...scope,versionNo:1}),two=await service.select({...scope,versionNo:2});assert.equal(one.selectionNo,1);assert.equal(two.selectionNo,2);
 assert.deepEqual((await service.version({...scope,versionNo:1})).parts,first.parts);
 await assert.rejects(service.edit({...scope,versionNo:1,parts:['过期改稿']}),{code:'reply_version_stale'});
 await assert.rejects(service.version({...scope,contactId:f.ids[1],versionNo:1}),{code:'discussion_unavailable'});
 const replay=await turns.generate(input);assert.equal(replay.replayed,true);assert.equal(f.requests.length,1);
 assert.equal((await f.discussions.view(contactId,discussion.id)).entries.filter(e=>e.role==='assistant').length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('显式选稿才携入后续候选；删除完整输入窗口清候选、选择、追踪与非当前副本并保留另一联系人',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const f=await realFixture(t,{content:JSON.stringify({candidates:[{parts:['合成候选正文'],basis:[2]}]})}),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'本轮表达要求',confirmedContact:true});
 const first=(await service.view(contactId,d.id))[0].candidates[0],selection=await service.select({contactId,discussionId:d.id,candidateId:first.candidateId,versionNo:1});
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'继续改得简洁',confirmedContact:true,carriedSelectionId:selection.id});
 assert.match(JSON.stringify(f.requests[1]),/用户明确选择继续的候选/);assert.equal(f.requests.length,2);
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId,sourceId:f.messages[0][0].sourceRecordIds[0]}});
 assert.equal((await service.view(contactId,d.id)).flatMap(r=>r.candidates).length,0);
 const done=await deletion.advance(op);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual(await service.view(contactId,d.id),[]);assert.equal((await f.contacts.directory()).contacts.length,2);
 assert.equal((await f.history.read(f.ids[1])).messages.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('认证HTTP不等待历史即可生成、编辑和选稿，拒绝owner和任意额外能力',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {SqliteReplyCandidateHttp}=await import('../src/reply/sqlite/candidates/http.ts');const {createServer}=await import('node:http');
 const f=await realFixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['合成HTTP候选'],basis:[1]}]})}),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service,turns,authorize:req=>req.headers.authorization==='Bearer synthetic'}),server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${d.id}/reply-candidates`;
 assert.equal((await fetch(url)).status,401);
 const request=async(path='',method='GET',body)=>{const res=await fetch(url+path,{method,headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 assert.equal((await request('','POST',{owner_id:f.owner})).status,400);
 assert.equal((await request('','POST',{request_key:randomUUID(),text:'未确认联系人不能生成',confirmed_contact:false})).status,400);
 for(const selected_package_id of [randomUUID(),null])assert.equal((await request('','POST',{request_key:randomUUID(),text:'合成请求',confirmed_contact:true,selected_package_id})).status,400);
 assert.equal(f.requests.length,0);
 const made=await request('','POST',{request_key:randomUUID(),text:'本次写得自然',confirmed_contact:true});assert.equal(made.status,200);
 const view=await request();assert.match(view.body.requests[0].coverageWarning,/历史覆盖不完整/);const v=view.body.requests[0].candidates[0];
 const edited=await request(`/${v.candidateId}/edit`,'POST',{version_no:1,parts:['手工HTTP版本']});assert.equal(edited.body.versionNo,2);
 assert.equal((await request(`/${v.candidateId}/select`,'POST',{version_no:2})).body.versionNo,2);
 assert.equal((await request(`/${v.candidateId}/versions/1`)).body.parts[0],'合成HTTP候选');
 assert.equal(f.requests.length,1);assert.equal(JSON.stringify(view.body).includes('managed_locator'),false);
});

test('覆盖不完整可直接生成，覆盖事实保留在模型实际输入与候选依据',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['仅基于已有资料的候选'],basis:[2]}]})});
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[],completedPartitions:[],exhausted:true});await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 const d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'只根据现有部分帮我表达',confirmedContact:true};
 await turns.generate(input);const view=(await service.view(f.ids[0],d.id))[0];assert.match(view.coverageWarning,/历史覆盖不完整/);assert.match(view.candidates[0].basis[0].text,/历史覆盖不完整/);assert.match(JSON.stringify(f.requests[0]),/历史覆盖不完整/);
});

test('历史正在后台同步时可生成与继续改写，追平后的原请求重试不重复调用',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['直接使用当前资料的合成候选'],basis:[1]}]})});
 const d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const original=f.channel.page,entered=Promise.withResolvers(),release=Promise.withResolvers();
 f.channel.page=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
 await f.contacts.setReading(true);const sync=f.history.synchronize(f.ids[0]);sync.catch(()=>{});
 try{
  await entered.promise;assert.equal((await f.history.read(f.ids[0])).coverage.phase,'running');
  const input={contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'无需等待历史，先帮我表达',confirmedContact:true};
  await turns.generate(input);assert.equal(f.requests.length,1);
  const first=(await service.view(f.ids[0],d.id))[0];assert.match(first.coverageWarning,/历史覆盖不完整/);
  const selected=await service.select({contactId:f.ids[0],discussionId:d.id,candidateId:first.candidates[0].candidateId,versionNo:1});
  await turns.generate({...input,requestKey:randomUUID(),text:'基于这版继续简短一点',carriedSelectionId:selected.id});
  assert.equal(f.requests.length,2);assert.match(JSON.stringify(f.requests[1]),/用户明确选择继续的候选/);
  release.resolve();await sync;assert.equal((await f.history.read(f.ids[0])).coverage.phase,'complete');
  assert.equal((await turns.generate(input)).replayed,true);assert.equal(f.requests.length,2);
  assert.equal((await service.view(f.ids[0],d.id))[0].coverageWarning,first.coverageWarning);
 }finally{release.resolve();await sync;}
});



test('供应商断线后自动放弃且保留已发送失败，原身份不重发而新身份可明确生成',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{content:JSON.stringify({candidates:[{parts:['断线后重新生成的合成候选'],basis:[1]}]}),onRequest:async(_req,res,_body,count)=>{if(count===1){res.destroy();return true;}}}),d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'断线合成请求',confirmedContact:true};await assert.rejects(turns.generate(input),{code:'discussion_generation_failed'});
 const status=await service.status(f.ids[0],d.id,input.requestKey);
 assert.equal(status.phase,'failed');assert.equal(status.sent,true);assert.equal(status.abandoned,true);assert.equal(status.retryable,true);assert.equal(status.errorCode,'discussion_generation_failed');
 const [failed]=await service.view(f.ids[0],d.id);assert.equal(failed.generationState,'failed');assert.equal(failed.generationSent,true);assert.equal(failed.generationAbandoned,true);assert.deepEqual(failed.candidates,[]);
 assert.equal(f.requests.length,1,'自动放弃不自动另发模型请求');
 await assert.rejects(turns.generate(input),{code:'discussion_request_stale'});assert.equal(f.requests.length,1,'原请求身份不能重发');
 const fresh={...input,requestKey:randomUUID()};await turns.generate(fresh);assert.equal(f.requests.length,2);
 assert.equal((await service.status(f.ids[0],d.id,fresh.requestKey)).phase,'committed');
 const history=await service.view(f.ids[0],d.id);assert.equal(history[0].requestId,failed.requestId);assert.equal(history[0].generationState,'failed');assert.notEqual(history[1].requestId,failed.requestId);assert.deepEqual(history[1].candidates[0].parts,['断线后重新生成的合成候选']);
});

test('模型已返回但输出无效的失败已发送却不是自动放弃，状态和历史均不标记已放弃',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{content:'这不是合法的候选结构'}),d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'输出无效合成请求',confirmedContact:true};await assert.rejects(turns.generate(input));
 const status=await service.status(f.ids[0],d.id,input.requestKey);
 assert.equal(status.phase,'failed');assert.equal(status.sent,true);assert.equal(status.abandoned,false,'已收到响应的失败不是被放弃的未知调用');
 const [failed]=await service.view(f.ids[0],d.id);assert.equal(failed.generationState,'failed');assert.equal(failed.generationSent,true);assert.equal(failed.generationAbandoned,false);
 assert.equal((await service.status(f.ids[0],d.id,randomUUID())).abandoned,false,'未找到的请求不是已放弃');
});

test('真实Skill加载独立于选择记录，资格失效后候选正文、依据和实际Skill快照一起撤下',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {mkdir,writeFile}=await import('node:fs/promises');
 const f=await realFixture(t,{onRequest:(_req,res,_body,n)=>n===1&&modelToolResponse(res,'skill',{name:'gentle'}),content:JSON.stringify({candidates:[{parts:['合成Skill候选'],basis:[1]}]})});await mkdir(join(f.skillRoot,'gentle'));await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成温和表达\n---\n先回应感受，再说明情况。\n');let skill=await f.library.discover('gentle');skill=await f.library.setEnabled(skill.id,skill.headRevision,'enabled');
 const d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'用本次方法回应',confirmedContact:true});let view=(await service.view(f.ids[0],d.id))[0];assert.equal(view.loadedSkills.length,1);assert.match(view.loadedSkills[0].text,/先回应感受/);assert.doesNotMatch(JSON.stringify(f.requests[0]),/先回应感受/);assert.match(JSON.stringify(f.requests[1]),/先回应感受/);
 const trace=await f.discussions.trace(f.ids[0],d.id,view.requestId);assert.equal(trace.events.filter(e=>e.kind==='skill_selection').length,2);assert.equal(trace.events.filter(e=>e.kind==='skill_input').length,1);
 const id=view.candidates[0].candidateId;await f.library.setEnabled(skill.id,skill.headRevision,'disabled');view=(await service.view(f.ids[0],d.id))[0];assert.deepEqual(view.candidates,[]);assert.deepEqual(view.loadedSkills,[]);await assert.rejects(service.edit({contactId:f.ids[0],discussionId:d.id,candidateId:id,versionNo:1,parts:['不能洗回']}));
});

test('Skill分组变化保留已完成候选、编辑与依据，明确继续使用当前分组',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {mkdir,writeFile}=await import('node:fs/promises');
 const f=await realFixture(t,{skillGroups:'manual',onRequest:(_req,res,_body,n)=>n===2&&modelToolResponse(res,'skill',{name:'gentle'}),content:JSON.stringify({candidates:[{parts:['分组变化前的合成候选'],basis:[1]}]})});
 await mkdir(join(f.skillRoot,'gentle'));await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成温和表达\n---\n先回应感受，再说明情况。\n');
 let skill=await f.library.discover('gentle');skill=await f.library.setEnabled(skill.id,skill.headRevision,'enabled');
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),discussionId=d.id,service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId,discussionId,requestKey:randomUUID(),text:'未分组时生成',confirmedContact:true};
 await turns.generate(input);const original=(await service.view(contactId,discussionId))[0],candidate=original.candidates[0],scope={contactId,discussionId,candidateId:candidate.candidateId};
 assert.deepEqual(original.loadedSkills,[]);
 let group=await f.library.createGroup('合成分组',[skill.id]);await f.library.assignContactGroup(contactId,group.id,null);
 assert.equal((await service.view(contactId,discussionId))[0].sourceState,'available','加入分组不撤下旧候选');
 assert.deepEqual((await service.version({...scope,versionNo:1})).parts,['分组变化前的合成候选']);
 assert.equal((await service.inputMaterials({contactId,discussionId,requestId:original.requestId,offset:0})).recorded,true);
 const edited=await service.edit({...scope,versionNo:1,parts:['分组变化后手工编辑的候选']});assert.equal(edited.versionNo,2);
 const selected=await service.select({...scope,versionNo:2});assert.equal(f.requests.length,1,'回看、编辑和选稿不调用模型');
 await turns.generate({...input,requestKey:randomUUID(),text:'按当前分组继续',carriedSelectionId:selected.id});
 const loaded=(await service.view(contactId,discussionId))[1];assert.equal(loaded.loadedSkills.length,1);
 assert.match(JSON.stringify(f.requests[1]),/分组变化后手工编辑的候选/);
 const checkHistory=async()=>{
  const history=await service.view(contactId,discussionId);assert.deepEqual(history.map(r=>r.sourceState),['available','available']);
  assert.deepEqual(history[0].candidates[0].parts,['分组变化后手工编辑的候选']);
  assert.deepEqual(history[1].loadedSkills,loaded.loadedSkills,'分组变化保留实际使用的Skill快照');
  assert.equal((await service.skillInputs({contactId,discussionId,requestId:loaded.requestId,offset:0})).total,1);
 };
 group=await f.library.updateGroup(group.id,group.revision,'合成新名称',[skill.id]);await checkHistory();
 group=await f.library.updateGroup(group.id,group.revision,group.name,[]);await checkHistory();
 const other=await f.library.createGroup('合成另一分组',[]);await f.library.assignContactGroup(contactId,other.id,group.id);await checkHistory();
 await f.library.deleteGroup(group.id,group.revision);await checkHistory();
 await f.library.deleteGroup(other.id,other.revision);await checkHistory();
 await turns.generate({...input,requestKey:randomUUID(),text:'取消分组后继续',carriedSelectionId:selected.id});
 const latest=(await service.view(contactId,discussionId))[2];assert.equal(latest.sourceState,'available');assert.deepEqual(latest.loadedSkills,[]);
 assert.doesNotMatch(JSON.stringify(f.requests[3]),/先回应感受，再说明情况/);assert.equal(f.requests.length,4);
});

test('Skill分组变化仍拒绝在途旧快照，按既有无Skill路径重新生成',{timeout:10000},async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),f=await realFixture(t,{skillGroups:'manual',onRequest:(_req,res,_body,n)=>n===2&&modelToolResponse(res,'skill',{name:'gentle'}),content:JSON.stringify({candidates:[{parts:['分组变化后的迟到候选'],basis:[1]}]}),onRequest:async()=>{entered.resolve();await release.promise;}});
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const group=await f.library.createGroup('合成在途分组',[]),input={contactId,discussionId:d.id,requestKey:randomUUID(),text:'生成期间检查分组',confirmedContact:true};
 const pending=turns.generate(input);
 try{
  await entered.promise;await f.library.assignContactGroup(contactId,group.id,null);release.resolve();await pending;
  const view=(await service.view(contactId,d.id))[0];assert.equal(view.sourceState,'available');assert.deepEqual(view.loadedSkills,[]);
  assert.equal(view.skillWarning,'回复策略暂不可用');assert.equal(f.requests.length,2,'拒绝迟到旧结果后，沿既有降级合同发起独立无Skill调用');
 }finally{release.resolve();await pending.catch(()=>{});}
});

test('来源在模型在途时删除立即撤销资格，迟到响应不产生候选并清理受管文件',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),f=await realFixture(t,{content:JSON.stringify({candidates:[{parts:['迟到的合成候选'],basis:[1]}]}),onRequest:async()=>{entered.resolve();await release.promise;}}),d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const pending=turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'在途来源检查',confirmedContact:true}),rejected=assert.rejects(pending);await entered.promise;
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.ids[0],sourceId:f.messages[0][0].sourceRecordIds[0]}});release.resolve();await rejected;
 assert.equal((await service.view(f.ids[0],d.id)).flatMap(r=>r.candidates).length,0);const done=await deletion.advance(op);assert.equal(done.state,'completed',JSON.stringify(done.checks));assert.deepEqual(await service.view(f.ids[0],d.id),[]);assert.equal(f.requests.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('工作区suggest允许空草稿且关闭关系背景时只冻结本次输入，不因参数重试重复调用',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{registryModule:knowledgeRegistry,synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['合成的可选说法'],basis:[1,2,3]}]})}),contactId=f.ids[0];
 const originalPage=f.channel.page;f.channel.page=async(...args)=>{const page=await originalPage(...args);return {...page,records:[...page.records,{...page.records[0],localId:'2',text:'合成的另一条最近聊天'}]};};
 await f.contacts.setReading(true);await f.history.synchronize(contactId);
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId:contactId,mode:'owner'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const base={contactId,discussionId:d.id,requestKey:randomUUID(),confirmedContact:true};
 await turns.generate({...base,text:'旧讨论里的用户原话',requestKey:randomUUID()});
 const workspace={action:'suggest',draftText:'语气温和一点，不要替我答应',contextText:'补充背景：周五有考试',includeRelationshipContext:false};
 const input={...base,text:workspace.draftText,workspace};await assert.rejects(turns.generate({...base,text:'',workspace:{...workspace,action:'express',draftText:''}}),{code:'reply_input_invalid'});
 await turns.generate(input);const request=JSON.stringify(f.requests[1]);
 assert.match(request,/用户请求帮我想想/);assert.match(request,/尚未确认任何立场/);assert.match(request,/补充背景：周五有考试/);assert.match(request,/不要替我答应/);
 const historyEntries=(await f.discussions.view(contactId,d.id)).entries,workspaceEntry=historyEntries.find(entry=>entry.body.includes('本次补充背景：'));
 assert.ok(workspaceEntry);assert.match(workspaceEntry.body,/工作区动作：帮我想想/);assert.match(workspaceEntry.body,/语气温和一点，不要替我答应/);assert.doesNotMatch(workspaceEntry.body,/本次语气：|本次要求：/);assert.doesNotMatch(workspaceEntry.body,/参数指纹|[a-f0-9]{64}/);
 const recent=(await f.history.read(contactId)).messages.filter(m=>m.kind==='text');assert.doesNotMatch(request,/旧讨论里的用户原话|合成本人已采纳资料/);assert.ok(recent.every(m=>!request.includes(m.text)));
 const result=(await service.view(contactId,d.id))[1];assert.ok(result.candidates[0].basis.some(b=>/本次补充背景/.test(b.text)));
 const first=recent[0],second=recent[1];assert.ok(first&&second);
 const withBackground={...input,requestKey:randomUUID(),workspace:{...workspace,includeRelationshipContext:true}};
 await turns.generate(withBackground);const backgroundRequest=JSON.stringify(f.requests[2]);
 assert.ok(backgroundRequest.includes(first.text));assert.ok(backgroundRequest.includes(second.text),'关系背景开启后最近消息自动全部进入，不再逐条排除');
 assert.doesNotMatch(backgroundRequest,/旧讨论里的用户原话/);assert.match(backgroundRequest,/本次补充背景（独立于想法\/草稿，仅作用本次）/);
 assert.equal((await turns.generate(input)).replayed,true);assert.equal(f.requests.length,3);
 await assert.rejects(turns.generate({...input,text:'语气礼貌一点，不要替我答应',workspace:{...workspace,draftText:'语气礼貌一点，不要替我答应'}}),{code:'discussion_request_conflict'});assert.equal(f.requests.length,3);
 await assert.rejects(turns.generate({...input,workspace:{...workspace,contextText:'不同的本次补充'}}),{code:'discussion_request_conflict'});assert.equal(f.requests.length,3);
});

test('旧候选来源失效后，关闭关系背景的新候选使用全新运行副本且可正常生成',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const registryModule=new URL('./fixtures/sqlite/reply-provenance-registry.mjs',import.meta.url).href;
 const f=await realFixture(t,{registryModule,content:JSON.stringify({candidates:[{parts:['只依据本次输入的合成候选'],basis:[1]}]})}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'旧请求的合成要求',confirmedContact:true});
 await f.storage.execute('provenanceTest.sourceUnavailable',{ownerId:f.owner,contactId,recordId:f.messages[0][0].sourceRecordIds[0]});
 const metadata=await f.storage.execute('discussion.metadata',{ownerId:f.owner,contactId,discussionId:discussion.id});
 assert.equal(metadata.id,discussion.id);assert.ok(metadata.currentRuntimeId);assert.equal('entries' in metadata,false);
 const workspace={action:'suggest',draftText:'只写本次建议',contextText:'本次独立补充',includeRelationshipContext:false};
 await turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:workspace.draftText,workspace,confirmedContact:true});
 assert.equal(f.requests.length,2);
 const request=JSON.stringify(f.requests[1]);assert.match(request,/本次独立补充/);assert.doesNotMatch(request,/旧请求的合成要求/);assert.ok(!request.includes(f.messages[0][0].text));
 const newest=(await service.view(contactId,discussion.id)).at(-1);assert.equal(newest.candidates[0].parts[0],'只依据本次输入的合成候选');
});

test('候选HTTP接受明确的空suggest，要求express草稿与工作区输入一致',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {SqliteReplyCandidateHttp}=await import('../src/reply/sqlite/candidates/http.ts');const {createServer}=await import('node:http');
 const f=await realFixture(t,{content:JSON.stringify({candidates:[{parts:['合成建议'],basis:[1]}]})}),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service,turns,authorize:req=>req.headers.authorization==='Bearer synthetic'}),server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${d.id}/reply-candidates`,request=body=>fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify(body)});
 const workspace={action:'suggest',draftText:'',contextText:'',includeRelationshipContext:false};
 const accepted=await request({request_key:randomUUID(),text:'',confirmed_contact:true,workspace});assert.equal(accepted.status,200);
 const express=await request({request_key:randomUUID(),text:'',confirmed_contact:true,workspace:{...workspace,action:'express'}});assert.equal(express.status,400);
 const mismatch=await request({request_key:randomUUID(),text:'伪造立场',confirmed_contact:true,workspace});assert.equal(mismatch.status,400);assert.equal(f.requests.length,1);
});

test('统一工作区生成按消息时间使用最新50条，不把旧位置当作新消息',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {SqliteReplyCandidateHttp}=await import('../src/reply/sqlite/candidates/http.ts');const {createServer}=await import('node:http');
 const f=await realFixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['合成建议'],basis:[1]}]})}),contactId=f.ids[0];await f.contacts.setReading(true);
 // 该用例验证50条中文消息与新增工具的完整输入；合成容量独立于正式模型预算，不截断正文。
 f.model.budgetProfile.context_window_tokens=16_384;
 const rows=[...Array.from({length:50},(_,index)=>({localId:String(index+1),text:`合成最近-${index}`,sentAt:String(1800000000000+index*1000)})),{localId:'51',text:'合成旧消息但保存位置较新',sentAt:'1600000000000'}];
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:rows.map(row=>({partition:'shard-a',table:'table-instance-1',localId:row.localId,serverId:'0',sender:'contact',kind:'text',text:row.text,originalType:'1',sentAt:row.sentAt,timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['shard-a'],exhausted:true});
 await f.history.synchronize(contactId);const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service,turns,authorize:req=>req.headers.authorization==='Bearer synthetic'}),server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${d.id}/reply-candidates`,headers={authorization:'Bearer synthetic','content-type':'application/json'};
 const workspace={action:'suggest',draftText:'',contextText:'',includeRelationshipContext:true};
 const accepted=await fetch(url,{method:'POST',headers,body:JSON.stringify({request_key:randomUUID(),text:'',confirmed_contact:true,workspace})}),acceptedBody=await accepted.json();assert.equal(accepted.status,200,JSON.stringify(acceptedBody));
 const request=JSON.stringify(f.requests[0]);assert.ok(request.includes('合成最近-49'));assert.ok(request.includes('合成最近-0'));assert.ok(!request.includes('合成旧消息但保存位置较新'));
});

const knowledgeRegistry=new URL('./fixtures/sqlite-reply-candidates/knowledge-registry.mjs',import.meta.url).href;


test('发布集合错误时不出站，正确精确文档版可消费且资格变更后不能编辑或选用旧稿',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{registryModule:knowledgeRegistry,content:JSON.stringify({candidates:[{parts:['合成文档候选'],basis:[3]}]})}),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId:contactId,mode:'document_wrong_publication'});await assert.rejects(turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'不准使用错误发布集合',confirmedContact:true}),{code:'synthetic_publication_unavailable'});assert.equal(f.requests.length,0);
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId:contactId,mode:'document'});await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'使用真实冻结的发布资料',confirmedContact:true});let view=await service.view(contactId,d.id),candidate=view.flatMap(r=>r.candidates)[0];assert.ok(candidate);assert.match(JSON.stringify(f.requests[0]),/合成已发布场景/);
 await f.storage.execute('synthetic.invalidateReplyKnowledge',{ownerId:f.owner});assert.equal((await service.view(contactId,d.id)).flatMap(r=>r.candidates).length,0);await assert.rejects(service.edit({contactId,discussionId:d.id,candidateId:candidate.candidateId,versionNo:1,parts:['旧版不能恢复']}),{code:'reply_source_unavailable'});assert.equal(f.requests.length,1);
});

test('缺失任意短消息正文的版本不能选用、编辑或携入后续任务',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{registryModule:knowledgeRegistry,content:JSON.stringify({candidates:[{parts:['第一条完整正文','第二条待擦除正文'],basis:[1]}]})}),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'完整正文资格测试',confirmedContact:true});const candidate=(await service.view(contactId,d.id))[0].candidates[0],scope={contactId,discussionId:d.id,candidateId:candidate.candidateId,versionNo:1};const selected=await service.select(scope);
 await f.storage.execute('synthetic.eraseReplyPart',{ownerId:f.owner,candidateId:candidate.candidateId,versionNo:1,partNo:2});await assert.rejects(service.select(scope),{code:'reply_content_unavailable'});await assert.rejects(service.edit({...scope,parts:['不得恢复缺失原文']}),{code:'reply_content_unavailable'});
 await assert.rejects(turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'旧稿继续',confirmedContact:true,carriedSelectionId:selected.id}),{code:'reply_content_unavailable'});assert.equal(f.requests.length,1);
});
