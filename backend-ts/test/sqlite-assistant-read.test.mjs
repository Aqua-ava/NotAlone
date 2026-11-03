import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {createSqliteDiscussionHost} from '../src/reply/sqlite/host-runtime.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {SqliteDeletionHttp} from '../src/storage/sqlite/deletion/http.ts';
import {createAssistantReadChannel} from '../src/reply/sqlite/read-channel.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyCandidateHttp} from '../src/reply/sqlite/candidates/http.ts';

async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-assistant-read-'))),storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/assistant-read-registry.mjs',import.meta.url).href});
 let host,reader,server;
 t.after(async()=>{server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));await host?.close();await reader?.close();await storage.close();await rm(root,{recursive:true,force:true});});
 const ownerId=await storage.execute('identity.resolveOwner',{proposedOwnerId:randomUUID(),at:Date.now()});
 const contacts=new SqliteContactService(storage,ownerId,{account:async()=>({externalKey:'synthetic-read-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人'+externalKey,kind:'private',identityAssurance:'verified'}))});
 await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})));
 const ids=(await contacts.directory()).contacts.map(c=>c.contact_id),holders=new ActiveHolders();
 const readStorage=options.beforeRead||options.afterRead||options.closeReader?{openReader:async actions=>{const actual=await storage.openReader(actions);return {execute:async(name,input)=>{await options.beforeRead?.(name,input);const value=await actual.execute(name,input);await options.afterRead?.(name,input,value);return value;},close:()=>options.closeReader?options.closeReader(actual):actual.close()};}}:storage;
 reader=await createAssistantReadChannel({storage:readStorage,ownerId,holders});
 host=await createSqliteDiscussionHost({ctx:{},storage,ownerId,userData:root,holders,reader,authorizeRequest:()=>true});
 const deletionService=new DeletionService(storage,holders,new ManagedFiles(root),{reader}),deletions=new SqliteDeletionHttp(deletionService,ownerId);
 server=createServer(async(req,res)=>{if(!await deletions.handle(req,res)&&!await host.http.handle(req,res)){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');
 const api=async route=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`);return {status:response.status,data:await response.json()};};
 return {root,storage,ownerId,contacts,ids,holders,reader,host,deletionService,api};
}
async function bounded(work){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('助手读取不应等待后台写者队列')),750);})]);}finally{clearTimeout(timer);}}

test('后台队列占用时助手删除状态、目录、正文和候选回看仍可从附属读者完成',async t=>{
 const f=await fixture(t),contactId=f.ids[0],discussion=await f.host.service.newDiscussion(contactId),key=randomUUID(),confirmationId=await f.contacts.manualConfirm(contactId,key);
 await f.host.service.begin(contactId,key,'合成助手独立读取',{kind:'manual',confirmationId},discussion.id);
 const barrier=new SharedArrayBuffer(8);let backgroundSettled=false;
 const background=f.storage.execute('assistantTest.holdWriter',{barrier}).finally(()=>{backgroundSettled=true;});
 await Atomics.waitAsync(new Int32Array(barrier),0,0,5000).value;assert.equal(Atomics.load(new Int32Array(barrier),0),1);
 const loading=(async()=>{
  const deletion=await f.api(`/api/deletions?contact_id=${contactId}&scope_kind=discussion`);assert.equal(deletion.status,200);assert.deepEqual(deletion.data.operations,[]);
  const catalog=await f.api(`/api/contacts/${contactId}/assistant-sessions`);assert.equal(catalog.status,200);assert.equal(catalog.data.current_session_id,discussion.id);
  const view=await f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}`);assert.equal(view.status,200);assert.equal(view.data.entries[0].text,'合成助手独立读取');
  const candidates=await f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}/reply-candidates`);assert.equal(candidates.status,200);assert.deepEqual(candidates.data.requests,[]);
  const status=await f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}/reply-candidates/status?request_key=${randomUUID()}`);assert.equal(status.status,200);assert.equal(status.data.phase,'not_found');
 })();
 const began=performance.now();
 try{await bounded(loading);assert.equal(backgroundSettled,false);t.diagnostic(JSON.stringify({assistantMs:Math.round((performance.now()-began)*100)/100,backgroundStillPending:true}));}finally{Atomics.store(new Int32Array(barrier),1,1);Atomics.notify(new Int32Array(barrier),1);await background;await loading;}
});

test('助手只读通道固定所有者并拒绝写入、维护和前台专用动作',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.reader.execute('deletion.list',{ownerId:randomUUID()}),{code:'assistant_read_scope_invalid'});
 for(const name of ['discussion.new','storage.close','identity.foregroundSnapshot'])await assert.rejects(f.reader.execute(name,{ownerId:f.ownerId,contactId:f.ids[0]}),{code:'readonly_action_forbidden'});
 assert.deepEqual(await f.reader.execute('discussion.list',{ownerId:f.ownerId,contactId:f.ids[0]}),{currentDiscussionId:null,discussions:[]});
});

test('讨论删除排空在途只读通道，已提交但迟到的正文不得回到HTTP',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false;
 const f=await fixture(t,{afterRead:async name=>{if(name==='discussion.view'&&!held){held=true;entered.resolve();await release.promise;}}}),contactId=f.ids[0],discussion=await f.host.service.newDiscussion(contactId),key=randomUUID(),confirmationId=await f.contacts.manualConfirm(contactId,key);
 await f.host.service.begin(contactId,key,'删除前的合成正文',{kind:'manual',confirmationId},discussion.id);
 const loading=f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}`);await entered.promise;
 try{
  const operation=await f.deletionService.plan({ownerId:f.ownerId,requestKey:randomUUID(),scope:{kind:'discussion',contactId,discussionId:discussion.id}}),done=await bounded(f.deletionService.advance(operation));assert.equal(done.state,'completed');
  release.resolve();const late=await loading;assert.notEqual(late.status,200);assert.equal(JSON.stringify(late.data).includes('删除前的合成正文'),false);
  assert.equal((await f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}`)).status,404);
 }finally{release.resolve();await loading;}
});

test('助手reader关闭失败后删除保持阻塞，重试必须确认实际关闭后才能完成',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false,closeAttempts=0;
 const f=await fixture(t,{afterRead:async name=>{if(name==='discussion.view'&&!held){held=true;entered.resolve();await release.promise;}},closeReader:async actual=>{if(++closeAttempts===1)throw new Error('合成首次关闭失败');await actual.close();}}),contactId=f.ids[0],discussion=await f.host.service.newDiscussion(contactId),key=randomUUID(),confirmationId=await f.contacts.manualConfirm(contactId,key);
 await f.host.service.begin(contactId,key,'删除关闭重试的合成正文',{kind:'manual',confirmationId},discussion.id);
 const loading=f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}`);await entered.promise;
 try{
  const operation=await f.deletionService.plan({ownerId:f.ownerId,requestKey:randomUUID(),scope:{kind:'discussion',contactId,discussionId:discussion.id}}),first=await f.deletionService.advance(operation),keys=operation.targets.flatMap(t=>t.target?.holderKeys??[]);
  assert.equal(first.state,'blocked');assert.equal(closeAttempts,1);assert.equal(f.holders.verify(operation,keys),false);
  const late=await loading;assert.notEqual(late.status,200);assert.equal(JSON.stringify(late.data).includes('删除关闭重试的合成正文'),false);
  const retry=await f.deletionService.advance(operation);assert.equal(closeAttempts,2);assert.equal(retry.state,'completed');assert.equal(f.holders.verify(operation,keys),true);
 }finally{release.resolve();await loading;}
});

test('会话不存在保留reader，联系人或所有者失效则关闭旧reader且不改变公开404',async t=>{
 for(const kind of ['contact','account'])await t.test(kind,async t=>{
  let closed=0;
  const f=await fixture(t,{closeReader:async actual=>{await actual.close();closed++;}}),contactId=f.ids[0];
  assert.equal((await f.api(`/api/contacts/${contactId}/assistant-sessions/${randomUUID()}`)).status,404);assert.equal(closed,0);
  await f.deletionService.plan({ownerId:f.ownerId,requestKey:randomUUID(),scope:kind==='account'?{kind}:{kind,contactId}});
  const unavailable=await f.api(`/api/contacts/${contactId}/assistant-sessions`);assert.equal(unavailable.status,404);assert.deepEqual(unavailable.data,{error:'not_found'});assert.equal(closed,1);
 });
});

test('失效reader尚未确认关闭时通道关闭必须继续报错，重试不得丢失退休连接',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false,closeAttempts=0;
 const f=await fixture(t,{afterRead:async name=>{if(name==='discussion.view'&&!held){held=true;entered.resolve();await release.promise;}},closeReader:async actual=>{if(++closeAttempts<=2)throw new Error('合成退休连接关闭失败');await actual.close();}}),contactId=f.ids[0],discussion=await f.host.service.newDiscussion(contactId),key=randomUUID(),confirmationId=await f.contacts.manualConfirm(contactId,key);
 await f.host.service.begin(contactId,key,'退休连接关闭确认的合成正文',{kind:'manual',confirmationId},discussion.id);
 const loading=f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}`);await entered.promise;
 try{
  await f.storage.execute('identity.setReading',{ownerId:f.ownerId,enabled:true});release.resolve();
  const late=await loading;assert.notEqual(late.status,200);assert.equal(JSON.stringify(late.data).includes('退休连接关闭确认的合成正文'),false);assert.equal(closeAttempts,1);
  await assert.rejects(f.reader.close(),/合成退休连接关闭失败/);assert.equal(closeAttempts,2);
  await f.reader.close();assert.equal(closeAttempts,3);
 }finally{release.resolve();await loading;}
});

test('业务读取抛出会话不可用时仍区分并关闭刚失效的所有者reader',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false,closed=0;
 const f=await fixture(t,{beforeRead:async name=>{if(name==='discussion.view'&&!held){held=true;entered.resolve();await release.promise;}},closeReader:async actual=>{await actual.close();closed++;}}),contactId=f.ids[0],discussion=await f.host.service.newDiscussion(contactId);
 const loading=f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}`);await entered.promise;
 try{
  await f.deletionService.plan({ownerId:f.ownerId,requestKey:randomUUID(),scope:{kind:'account'}});release.resolve();
  const unavailable=await loading;assert.equal(unavailable.status,404);assert.deepEqual(unavailable.data,{error:'not_found'});assert.equal(closed,1);
 }finally{release.resolve();await loading;}
});

test('范围快照已失效而无法登记持有者时仍关闭旧reader',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false,closed=0;
 const f=await fixture(t,{afterRead:async name=>{if(name==='discussion.readBoundary'&&!held){held=true;entered.resolve();await release.promise;}},closeReader:async actual=>{await actual.close();closed++;}}),contactId=f.ids[0];
 const loading=f.api(`/api/contacts/${contactId}/assistant-sessions`);await entered.promise;
 try{
  await f.deletionService.plan({ownerId:f.ownerId,requestKey:randomUUID(),scope:{kind:'account'}});release.resolve();
  const unavailable=await loading;assert.equal(unavailable.status,409);assert.deepEqual(unavailable.data,{error:'deletion_holder_fenced'});assert.equal(closed,1);
 }finally{release.resolve();await loading;}
});

test('关闭助手先撤销迟到正文并排空独立reader，不关闭主存储和前台reader',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false;
 const f=await fixture(t,{afterRead:async name=>{if(name==='discussion.view'&&!held){held=true;entered.resolve();await release.promise;}}}),contactId=f.ids[0],discussion=await f.host.service.newDiscussion(contactId),key=randomUUID(),confirmationId=await f.contacts.manualConfirm(contactId,key);
 await f.host.service.begin(contactId,key,'关闭前的合成正文',{kind:'manual',confirmationId},discussion.id);
 const foreground=await f.storage.openReader(['identity.foregroundSnapshot']);t.after(()=>foreground.close());
 const loading=f.api(`/api/contacts/${contactId}/assistant-sessions/${discussion.id}`);await entered.promise;
 try{
  await bounded(f.host.close());const late=await loading;assert.notEqual(late.status,200);assert.equal(JSON.stringify(late.data).includes('关闭前的合成正文'),false);
  await assert.rejects(f.reader.execute('discussion.list',{ownerId:f.ownerId,contactId}),{code:'readonly_closed'});
  assert.equal((await foreground.execute('identity.foregroundSnapshot',{ownerId:f.ownerId})).enabled,false);
  await assert.rejects(foreground.execute('discussion.view',{ownerId:f.ownerId,contactId,discussionId:discussion.id}),{code:'readonly_action_forbidden'});
  assert.equal((await f.contacts.directory()).contacts.length,2);
 }finally{release.resolve();await loading;}
});

test('来源删除撤销在途候选版本读取，助手reader重开后仍不复活旧版本',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs'),{SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{content:JSON.stringify({candidates:[{parts:['只用于来源删除读隔离的合成候选'],basis:[1]}]})}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false;
 const channel=await createAssistantReadChannel({storage:{openReader:async actions=>{const actual=await f.storage.openReader(actions);return {execute:async(name,input)=>{const value=await actual.execute(name,input);if(name==='reply.version'&&!held){held=true;entered.resolve();await release.promise;}return value;},close:()=>actual.close()};}},ownerId:f.owner,holders:f.holders});t.after(()=>channel.close());
 const service=new SqliteReplyCandidateService(f.storage,f.owner,channel),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'生成引用实际合成来源的候选',confirmedContact:true});
 const candidate=(await service.view(contactId,discussion.id))[0].candidates[0],http=new SqliteReplyCandidateHttp({storage:f.storage,service,turns,authorize:()=>true}),server=createServer((req,res)=>http.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const route=`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussion.id}/reply-candidates/${candidate.candidateId}/versions/1`,loading=fetch(route);await entered.promise;
 try{
  const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId,sourceId:f.messages[0][0].sourceRecordIds[0]}}),done=await bounded(deletion.advance(op));assert.equal(done.state,'completed');
  const late=await loading;assert.notEqual(late.status,200);assert.equal((await late.text()).includes('只用于来源删除读隔离的合成候选'),false);
  release.resolve();assert.notEqual((await fetch(route)).status,200);
  assert.equal((await channel.execute('discussion.list',{ownerId:f.owner,contactId:f.ids[1]})).currentDiscussionId,null);
 }finally{release.resolve();await loading;}
});

test('来源连续性变化废弃旧最近聊天快照，重新读取保留权威覆盖状态',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs'),f=await realFixture(t),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false,opened=0,closed=0;
 const channel=await createAssistantReadChannel({storage:{openReader:async actions=>{opened++;const actual=await f.storage.openReader(actions);return {execute:async(name,input)=>{const value=await actual.execute(name,input);if(name==='history.readRecent'&&!held){held=true;entered.resolve(value);await release.promise;}return value;},close:async()=>{await actual.close();closed++;}};}},ownerId:f.owner,holders:f.holders});t.after(()=>channel.close());
 const service=new SqliteReplyCandidateService(f.storage,f.owner,channel),http=new SqliteReplyCandidateHttp({storage:f.storage,service,authorize:()=>true}),server=createServer((req,res)=>http.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussion.id}/reply-candidates`,loading=fetch(url),captured=await entered.promise,original=f.messages[0][0].text;assert.equal(typeof original,'string');assert.equal(captured.messages[0].text,original);
 try{
  await f.storage.execute('history.markContinuityLost',{token:await f.contacts.eligibility(contactId)});release.resolve();
  const late=await loading;assert.notEqual(late.status,200);assert.equal((await late.text()).includes(original),false);assert.equal(closed,1);
  const fresh=await fetch(url);assert.equal(fresh.status,200);const current=await fresh.json();assert.equal(current.coverage.phase,'incomplete');assert.equal(current.coverage.failureCode,'history_source_continuity_unverified');assert.equal(opened,2);
 }finally{release.resolve();await loading;}
});
