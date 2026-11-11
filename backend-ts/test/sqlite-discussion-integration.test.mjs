import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {mkdtemp,realpath,rm,mkdir,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Llm from '@deepseek-ai/dsh-llm';
import Skills from '@deepseek-ai/dsh-skill';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteSkillLibrary} from '../src/skills/sqlite/library.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteDiscussionRuntime} from '../src/reply/sqlite/runtime.ts';
import {SqliteDiscussionTurns} from '../src/reply/sqlite/turns.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
const owner='00000000-0000-4000-8000-000000000001';
const registryModule=new URL('./fixtures/sqlite/discussion-deletion-registry.mjs',import.meta.url).href;
async function strictDiscussionReader(){
 const {build}=createRequire(new URL('../../desktop/package.json',import.meta.url))('esbuild');
 const output=await build({entryPoints:[new URL('../../desktop/src/main/reply/sqlite-discussion-read.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
 return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)).readSqliteDiscussion;
}
async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-discussion-real-')));let storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人',kind:'private',identityAssurance:'verified'}))});
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);const snap=await contacts.candidates(true);await contacts.confirm(snap.snapshot_token,['a','b'].map(locator=>({locator,observed_display_name:'合成联系人',expected_selection_generation:'0'})));const ids=(await contacts.directory()).contacts.map(c=>c.contact_id);
 const ctx=new Context();await ctx.plugin(Loader);await ctx.plugin(Llm);await ctx.plugin(Skills);
 const requests=[];const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));if(options.onRequest&&await options.onRequest(req,res)===true)return;const content='实际环回返回的合成助手发言'+requests.length;const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:content}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}},{type:'message_stop'}];res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const provider=installModelProvider(ctx,{provider:'synthetic-official',connection:resolveAdapterOptions({baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous'});
 const model={provider:'synthetic-official',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off',physical_limit:1,deadline_ms:5000,warning_ratio:0.8,budgetProfile:{context_window_tokens:8192,safety_margin_tokens:512}};
 const skillRoot=join(root,'user-skills');await mkdir(skillRoot,{mode:0o700});const holders=new ActiveHolders();let runtime;let service;let turns;let library;
 const bind=async()=>{service=new SqliteDiscussionService(storage,owner,options.clock??Date.now);runtime=new SqliteDiscussionRuntime({storage:options.runtimeStorageHook?{status:storage.status,execute:(...args)=>options.runtimeStorageHook(storage,...args)}:storage,ownerId:owner,userData:root,ctx,holders,fault:options.fault});await runtime.initialize();library=new SqliteSkillLibrary(storage,owner,skillRoot);turns=new SqliteDiscussionTurns({storage:options.turnStorageHook?{status:storage.status,execute:(...args)=>options.turnStorageHook(storage,...args)}:storage,discussions:service,runtime,library,model,provider,arbiter:new ModelPermitArbiter(),authorize:async()=>{}});};await bind();
 t.after(async()=>{try{await runtime.close();}catch(error){if(!options.expectedBlocked)throw error;}await provider.dispose();await ctx.fiber.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await storage.close();await rm(root,{recursive:true,force:true});});
 return {root,ids,requests,skillRoot,contacts,holders,get service(){return service;},get storage(){return storage;},get runtime(){return runtime;},get turns(){return turns;},get library(){return library;},async reopen(){await runtime.close();const id=storage.status.databaseId;await storage.close();storage=await SqliteStorage.open({userData:root,intent:'open',expectedDatabaseId:id,role:'test',registryModule});await bind();}};
}
test('真实SQLite请求与官方运行副本保存实际发言，重送不重复模型，重开后同SessionId继续',async t=>{
 const f=await fixture(t);const d=await f.service.newDiscussion(f.ids[0]),key=randomUUID();
 const input={contactId:f.ids[0],discussionId:d.id,requestKey:key,text:'第一条合成讨论要求',confirmedContact:true};
 await f.turns.generate(input);assert.equal(f.requests.length,1);const view=await f.service.view(f.ids[0],d.id);assert.deepEqual(view.entries.map(e=>e.role),['user','assistant']);assert.equal(view.entries[1].body,'实际环回返回的合成助手发言1');
 const copies=await f.storage.execute('runtime.inventory',{ownerId:owner});assert.equal(copies.length,1);assert.equal(copies[0].state,'ready');const sessionId=copies[0].sdkInstanceId;
 const trace=await f.service.trace(f.ids[0],d.id,view.entries[1].origin_request_id);assert.equal(trace.calls[0].state,'succeeded');assert.ok(trace.events.some(e=>e.kind==='model_request'));assert.ok(trace.events.some(e=>e.kind==='assistant_message'));
 const [call]=await f.storage.execute('discussionTest.calls',{ownerId:owner});assert.ok(call.reserved_budget_units>512n);assert.equal(call.actual_budget_units,11n);assert.equal(call.settlement_state,'settled');assert.equal(call.model,'synthetic-model');assert.ok(call.input_cap>0n);assert.equal(call.output_cap,512n);assert.ok(JSON.parse(call.receipt).inputBudget.input_tokens>0);
 assert.equal((await f.turns.generate(input)).replayed,true);assert.equal(f.requests.length,1);
 await assert.rejects(f.service.view(f.ids[1],d.id),{code:'discussion_unavailable'});
 await f.reopen();await f.turns.generate({...input,requestKey:randomUUID(),text:'第二条合成讨论要求'});assert.equal(f.requests.length,2);
 const after=await f.storage.execute('runtime.inventory',{ownerId:owner});assert.equal(after.length,1);assert.equal(after[0].sdkInstanceId,sessionId);assert.equal(after[0].state,'ready');assert.equal((await f.service.view(f.ids[0],d.id)).entries.length,4);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('实际派发后连接中断保留最终测量预留，未知实耗不填零且不重发',async t=>{
 const f=await fixture(t,{onRequest:(_req,res)=>{res.destroy();return true;}}),d=await f.service.newDiscussion(f.ids[0]);
 const input={contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'合成未知回执',confirmedContact:true};
 await assert.rejects(f.turns.generate(input));assert.equal(f.requests.length,1);
 const [call]=await f.storage.execute('discussionTest.calls',{ownerId:owner});assert.equal(call.state,'unknown');assert.equal(call.settlement_state,'unknown');assert.ok(call.reserved_budget_units>512n);assert.equal(call.actual_budget_units,null);assert.ok(JSON.parse(call.receipt).inputBudget.input_tokens>0);
 assert.deepEqual(JSON.parse(call.receipt).failure,{kind:'error',code:'TRANSPORT',dispatch:'authorized_unconfirmed'});
 assert.deepEqual(await f.storage.execute('memoryExtraction.unconfirmed',{owner_id:owner,contact_id:f.ids[0]}),[],'07计费回查不能冒领讨论producer的未知请求');
 await assert.rejects(f.turns.generate(input),{code:'discussion_request_stale'});assert.equal(f.requests.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('实际Skill载入经SQLite保护事务保存原文与修订，选择事实不冒充载入',async t=>{
 const f=await fixture(t);await mkdir(join(f.skillRoot,'gentle'),{mode:0o700});await writeFile(join(f.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成沟通方法\n---\n先回应感受，再说明合成情况。\n',{mode:0o600});
 let skill=await f.library.discover('gentle');skill=await f.library.setEnabled(skill.id,skill.headRevision,'enabled');{const group=await f.library.createGroup('合成分组',[skill.id]);await f.library.assignContactGroup(f.ids[0],group.id,null);}
 const d=await f.service.newDiscussion(f.ids[0]);await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'使用指定的合成方法讨论',confirmedContact:true,selectedPackageId:skill.id});
 const view=await f.service.view(f.ids[0],d.id);const trace=await f.service.trace(f.ids[0],d.id,view.entries[1].origin_request_id);
 assert.equal(trace.events.filter(e=>e.kind==='skill_selection').length,1);const loaded=trace.events.filter(e=>e.kind==='skill_input');assert.equal(loaded.length,1);assert.match(loaded[0].payload,/先回应感受/);assert.equal(JSON.stringify(f.requests[0]).includes('先回应感受'),true);
 assert.equal((await f.storage.execute('runtime.inventory',{ownerId:owner}))[0].state,'ready');await access(join(f.skillRoot,'gentle/SKILL.md'));assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('实际业务在目录身份提交关闭等失败窗口不会把preparing或dirty当ready，也不为重开调用模型',async t=>{
 for(const point of ['beforeDirectory','afterDirectory','beforeIdentity','afterIdentity','afterBusinessCommit','beforeClose','afterClose','beforeReady'])await t.test(point,async t=>{
  let thrown=false;const f=await fixture(t,{fault:async where=>{if(where===point&&!thrown){thrown=true;throw new Error('合成故障');}}});
  const d=await f.service.newDiscussion(f.ids[0]);await assert.rejects(f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'故障窗口合成要求',confirmedContact:true}));
  const copies=await f.storage.execute('runtime.inventory',{ownerId:owner});assert.ok(copies.length>0);assert.ok(copies.every(c=>c.state!=='ready'));const count=f.requests.length;
  await f.reopen();assert.equal(f.requests.length,count);
  for(const copy of await f.storage.execute('runtime.inventory',{ownerId:owner}))await assert.rejects(f.runtime.inspect(f.ids[0],d.id,copy.id,copy.configurationDigest));
  assert.equal(f.requests.length,count);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});

test('mkdir后同定位换为陌生目录时不写marker或接管新身份',async t=>{
 const {rename,readdir}=await import('node:fs/promises');let f,copyPath,unknownPath;
 f=await fixture(t,{expectedBlocked:true,fault:async point=>{if(point==='afterDirectory'){const copy=(await f.storage.execute('runtime.inventory',{ownerId:owner}))[0];copyPath=join(f.root,'managed/runtime-copies',copy.managedLocator);unknownPath=copyPath;await rename(copyPath,join(f.root,'original-owned-copy'));await mkdir(copyPath,{mode:0o700});}}});
 const d=await f.service.newDiscussion(f.ids[0]);await assert.rejects(f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'合成目录身份故障',confirmedContact:true}));
 assert.deepEqual(await readdir(unknownPath),[]);assert.equal(f.requests.length,0);assert.notEqual((await f.storage.execute('runtime.inventory',{ownerId:owner}))[0].state,'ready');
});

async function sourceMessage(f){
 const {SqliteHistoryService}=await import('../src/history/sqlite/service.ts');await f.contacts.setReading(true);
 const target={protocol:'private-history-v1',descriptor:'fixed-synthetic-target',partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'};
 const channel={inspect:async scope=>({protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),target:async()=>target,page:async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[{partition:'shard-a',table:'table-instance-1',localId:'1',serverId:'0',sender:'contact',kind:'text',text:'只作实际上下文而非展示引句的合成来源',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['shard-a'],exhausted:true})};
 const history=new SqliteHistoryService(f.storage,f.contacts,channel);await history.synchronize(f.ids[0]);return (await history.read(f.ids[0])).messages[0];
}
async function deletion(f){const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');return new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));}

test('真实来源删除沿实际输入和同副本后续发言清理全部副本，独立讨论保留且旧请求不复活',async t=>{
 const f=await fixture(t),message=await sourceMessage(f);const independent=await f.service.newDiscussion(f.ids[0]);await f.turns.generate({contactId:f.ids[0],discussionId:independent.id,requestKey:randomUUID(),text:'独立的合成用户讨论',confirmedContact:true});
 const d=await f.service.newDiscussion(f.ids[0]),key=randomUUID();await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:key,text:'结合明确选取的聊天讨论',confirmedContact:true,contextMessageIds:[message.id]});
 await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'接着上述讨论',confirmedContact:true});
 const before=await f.storage.execute('runtime.inventory',{ownerId:owner}),affected=before.filter(c=>c.discussionId===d.id);assert.equal(affected.length,1);assert.equal(f.requests.length,3);
 const service=await deletion(f),op=await service.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.ids[0],sourceId:message.sourceRecordIds[0]}});
 assert.ok((await f.service.view(f.ids[0],d.id)).entries.every(e=>e.body===null));assert.equal((await f.service.view(f.ids[0],independent.id)).entries[0].body,'独立的合成用户讨论');
 const result=await service.advance(op);assert.equal(result.state,'completed',JSON.stringify(result.checks));
 for(const copy of affected)await assert.rejects(access(join(f.root,'managed/runtime-copies',copy.managedLocator)),{code:'ENOENT'});
 assert.equal((await f.service.view(f.ids[0],d.id)).entries.length,0);assert.equal((await f.service.view(f.ids[0],independent.id)).entries.length,2);
 await assert.rejects(f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:key,text:'结合明确选取的聊天讨论',confirmedContact:true}));assert.equal(f.requests.length,3);
 await f.reopen();assert.equal((await f.service.view(f.ids[0],independent.id)).entries.length,2);assert.equal((await f.service.view(f.ids[0],d.id)).entries.length,0);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实账号清理覆盖讨论调用追踪和受管目录，用户Skill原件保留',async t=>{
 const f=await fixture(t);await mkdir(join(f.skillRoot,'gentle'),{mode:0o700});const original='---\nname: gentle\ndescription: 合成方法\n---\n保留用户自己的选择。\n';await writeFile(join(f.skillRoot,'gentle/SKILL.md'),original,{mode:0o600});let skill=await f.library.discover('gentle');skill=await f.library.setEnabled(skill.id,skill.headRevision,'enabled');{const group=await f.library.createGroup('合成分组',[skill.id]);await f.library.assignContactGroup(f.ids[0],group.id,null);}
 const d=await f.service.newDiscussion(f.ids[0]);await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'账号清理的合成讨论',confirmedContact:true,selectedPackageId:skill.id});
 const copies=await f.storage.execute('runtime.inventory',{ownerId:owner});const service=await deletion(f),op=await service.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'account'}});const done=await service.advance(op);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 await assert.rejects(f.service.list(f.ids[0]));for(const c of copies)await assert.rejects(access(join(f.root,'managed/runtime-copies',c.managedLocator)),{code:'ENOENT'});const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(f.skillRoot,'gentle/SKILL.md'),'utf8'),original);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实调用在途时来源fence先撤旧正文，等待Agent排空后清副本且迟到响应不能重建',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();const f=await fixture(t,{onRequest:async()=>{entered.resolve();await release.promise;}}),message=await sourceMessage(f);const d=await f.service.newDiscussion(f.ids[0]);
 const pending=f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'在途来源删除的合成要求',confirmedContact:true,contextMessageIds:[message.id]}).then(()=>({ok:true}),error=>({error}));
 await entered.promise;const service=await deletion(f),op=await service.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.ids[0],sourceId:message.sourceRecordIds[0]}});
 assert.ok((await f.service.view(f.ids[0],d.id)).entries.every(e=>e.body===null));
 const result=await service.advance(op);release.resolve();const late=await pending;
 assert.equal(result.state,'completed',JSON.stringify(result.checks));assert.ok(late.error);assert.equal((await f.service.view(f.ids[0],d.id)).entries.length,0);assert.deepEqual(await f.storage.execute('runtime.inventory',{ownerId:owner}),[]);assert.equal(f.requests.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('关闭等待尚未登记holder的真实SQLite获取阶段，返回后不再创建目录或模型调用',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let gated=false;
 const f=await fixture(t,{runtimeStorageHook:async(storage,name,input,...args)=>{const result=await storage.execute(name,input,...args);if(name==='discussion.metadata'&&!gated){gated=true;entered.resolve();await release.promise;}return result;}});
 const d=await f.service.newDiscussion(f.ids[0]);const pending=f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'关闭获取阶段合成要求',confirmedContact:true}).then(()=>({ok:true}),error=>({error}));
 await entered.promise;let closed=false;const closing=f.runtime.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
 release.resolve();await closing;const result=await pending;assert.ok(result.error);assert.equal(f.requests.length,0);assert.deepEqual(await f.storage.execute('runtime.inventory',{ownerId:owner}),[]);
});

test('旧preparing仅恢复清理身份，关闭不能覆盖新ready副本的current指针',async t=>{
 const f=await fixture(t);const d=await f.service.newDiscussion(f.ids[0]),key=randomUUID();
 const confirmationId=await f.contacts.manualConfirm(f.ids[0],key);const a=(await f.service.begin(f.ids[0],key,'崩溃前的合成要求',{kind:'manual',confirmationId})).attempt;
 const copyId=randomUUID(),sdkInstanceId=randomUUID(),configurationDigest='a'.repeat(64);const copy=await f.storage.execute('runtime.prepare',{...a,copyId,sdkInstanceId,locator:copyId,configurationDigest});
 const dir=join(f.root,'managed/runtime-copies',copyId);await mkdir(dir,{mode:0o700});await writeFile(join(dir,'.notalone-copy'),JSON.stringify({format:1,databaseId:f.storage.status.databaseId,copyId,sessionId:sdkInstanceId,contactId:f.ids[0],discussionId:d.id,writeGeneration:String(copy.writeGeneration)}),{mode:0o600});
 await f.reopen();await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'重开后的新合成要求',confirmedContact:true});const fresh=(await f.service.view(f.ids[0],d.id)).discussion.currentRuntimeId;assert.notEqual(fresh,copyId);
 await f.runtime.close();assert.equal((await f.service.view(f.ids[0],d.id)).discussion.currentRuntimeId,fresh);assert.equal((await f.storage.execute('runtime.inventory',{ownerId:owner})).find(c=>c.id===copyId).state,'blocked');assert.equal(f.requests.length,1);
});

test('回看助手讨论不恢复运行副本，配置变化后仍可读取有效发言',async t=>{
 const {SqliteDiscussionHttp}=await import('../src/reply/sqlite/http.ts');const f=await fixture(t);const d=await f.service.newDiscussion(f.ids[0]);await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'恢复可用状态合成要求',confirmedContact:true});
 const http=new SqliteDiscussionHttp(f.service,()=>true,f.turns);const server=createServer((req,res)=>http.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}/api/contacts/${f.ids[0]}/assistant-sessions/${d.id}`;
 const read=await strictDiscussionReader(),first=read(await (await fetch(url)).json(),d.id,1);
 assert.equal(first.runtimeRecovery,'unchecked');assert.equal(first.discussionEntries[1].text,'实际环回返回的合成助手发言1');
 await mkdir(join(f.skillRoot,'changed'),{mode:0o700});await writeFile(join(f.skillRoot,'changed/SKILL.md'),'---\nname: changed\ndescription: 合成新方法\n---\n只用于资格改变的合成方法。\n',{mode:0o600});await f.library.discover('changed');
 const changed=read(await (await fetch(url)).json(),d.id,1);assert.equal(changed.runtimeRecovery,'unchecked');assert.equal(changed.discussionEntries[1].text,'实际环回返回的合成助手发言1');assert.equal(f.requests.length,1);
});

test('来源连续性失效后HTTP撤下助手正文，严格读取仍可展示当前讨论',async t=>{
 const {SqliteDiscussionHttp}=await import('../src/reply/sqlite/http.ts');const f=await fixture(t),message=await sourceMessage(f),d=await f.service.newDiscussion(f.ids[0]);
 await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'引用已授权来源的合成要求',confirmedContact:true,contextMessageIds:[message.id]});
 await f.storage.execute('history.markContinuityLost',{token:await f.contacts.eligibility(f.ids[0])});
 const http=new SqliteDiscussionHttp(f.service,()=>true,f.turns),server=createServer((req,res)=>http.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/${f.ids[0]}/assistant-sessions/${d.id}`);assert.equal(response.status,200);
 const read=await strictDiscussionReader(),saved=read(await response.json(),d.id,1),entry=saved.discussionEntries[1];
 assert.equal(entry.role,'assistant');assert.equal(entry.contentState,'cleared');assert.equal(entry.text,null);assert.equal(entry.callId,null);assert.equal(f.requests.length,1);
});

test('十二小时分段或显式换段后，同原URL及请求键重送仍回原请求而不重发模型',async t=>{
 let now=1000;const f=await fixture(t,{clock:()=>now});const d=await f.service.newDiscussion(f.ids[0]);now+=43_200_001;
 const input={contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'跨十二小时的合成请求',confirmedContact:true};const first=await f.turns.generate(input);assert.equal(first.segmented,true);assert.notEqual(first.discussionId,d.id);
 const repeated=await f.turns.generate(input);assert.equal(repeated.replayed,true);assert.equal(repeated.discussionId,first.discussionId);assert.equal(f.requests.length,1);
 await f.service.newDiscussion(f.ids[0]);assert.equal((await f.turns.generate(input)).discussionId,first.discussionId);assert.equal(f.requests.length,1);
});

test('真实source清理包含尚无runtime_context的准备副本及目录，解除真实attempt外键后完成',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();const f=await fixture(t,{fault:async point=>{if(point==='beforeIdentity'){entered.resolve();await release.promise;}}}),message=await sourceMessage(f);const d=await f.service.newDiscussion(f.ids[0]);
 const pending=f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'准备阶段带来源的合成要求',confirmedContact:true,contextMessageIds:[message.id]}).then(()=>({ok:true}),error=>({error}));
 await entered.promise;const copies=await f.storage.execute('runtime.inventory',{ownerId:owner});assert.equal(copies[0].state,'preparing');const service=await deletion(f),op=await service.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.ids[0],sourceId:message.sourceRecordIds[0]}});
 const advancing=service.advance(op);release.resolve();const done=await advancing;assert.ok((await pending).error);assert.equal(done.state,'completed',JSON.stringify(done.checks));await assert.rejects(access(join(f.root,'managed/runtime-copies',copies[0].managedLocator)),{code:'ENOENT'});assert.deepEqual(await f.storage.execute('runtime.inventory',{ownerId:owner}),[]);assert.equal(f.requests.length,0);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('存储重开后旧业务attempt租约不可再冻结输入或创建副本',async t=>{
 const f=await fixture(t),d=await f.service.newDiscussion(f.ids[0]),key=randomUUID();const confirmationId=await f.contacts.manualConfirm(f.ids[0],key);const a=(await f.service.begin(f.ids[0],key,'旧实例合成要求',{kind:'manual',confirmationId})).attempt;await f.reopen();
 await assert.rejects(f.storage.execute('discussion.freezeContext',{...a,contextId:randomUUID(),skillRun:{packages:[],eligible:[]},items:[],at:Date.now()}),{code:'discussion_request_stale'});const id=randomUUID();await assert.rejects(f.storage.execute('runtime.prepare',{...a,copyId:id,sdkInstanceId:randomUUID(),locator:id,configurationDigest:'a'.repeat(64)}),{code:'discussion_request_stale'});assert.equal(f.requests.length,0);
});


test('宿主关闭排空尚未进入副本管理器的整轮受理，不先关闭SQLite',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const f=await fixture(t,{turnStorageHook:async(storage,name,input)=>{if(name==='identity.manualConfirm'){entered.resolve();await release.promise;}return storage.execute(name,input);}});
 const discussion=await f.service.newDiscussion(f.ids[0]);
 const turn=f.turns.generate({contactId:f.ids[0],discussionId:discussion.id,requestKey:randomUUID(),text:'关闭前仍在受理的合成讨论',confirmedContact:true});
 const rejected=assert.rejects(turn);await entered.promise;
 let closed=false;const closing=f.turns.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
 release.resolve();await closing;await rejected;assert.equal(f.requests.length,0);
 await assert.rejects(f.turns.generate({contactId:f.ids[0],discussionId:discussion.id,requestKey:randomUUID(),text:'关闭后拒绝新请求',confirmedContact:true}),{code:'discussion_runtime_closed'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('讨论宿主关闭等待普通HTTP权威读取，不向已关闭存储补读',async t=>{
 const {createSqliteDiscussionHost}=await import('../src/reply/sqlite/host-runtime.ts');const f=await fixture(t);const discussion=await f.service.newDiscussion(f.ids[0]);
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const storage={status:f.storage.status,execute:async(name,input)=>{if(name==='discussion.view'){entered.resolve();await release.promise;}return f.storage.execute(name,input);}};
 const host=await createSqliteDiscussionHost({storage,ownerId:owner,userData:f.root,ctx:{},holders:f.holders,authorizeRequest:()=>true});
 const server=createServer((req,res)=>host.http.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=fetch('http://127.0.0.1:'+server.address().port+'/api/contacts/'+f.ids[0]+'/assistant-sessions/'+discussion.id);await entered.promise;
 let closed=false;const closing=host.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));const before=closed;
 release.resolve();const response=await request;assert.equal(response.status,200);await response.json();await closing;assert.equal(before,false);
});

test('旧记录里带设备号的运行副本在停读时也能关闭：manifest 与已保存地址按忽略设备号的规则比较',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const f=await fixture(t);const d=await f.service.newDiscussion(f.ids[0]);
 await f.turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'生成一个运行副本',confirmedContact:true});
 assert.equal((await f.storage.execute('runtime.inventory',{ownerId:owner})).length,1);
 // 复现旧版本落盘的现场：已保存的副本根地址与文件清单都带有 dev（设备号随重启会变，所以只作为历史字段存在）。
 const withDevice=text=>{const value=JSON.parse(text);const add=id=>({dev:'16777234',...id});return JSON.stringify({...value,ancestors:value.ancestors.map(add),identity:add(value.identity)});};
 const database=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));
 try{
  for(const table of ['runtime_copy','runtime_file'])for(const row of database.prepare(`SELECT rowid,address_json FROM ${table} WHERE address_json IS NOT NULL`).all())
   database.prepare(`UPDATE ${table} SET address_json=? WHERE rowid=?`).run(withDevice(String(row.address_json)),row.rowid);
 }finally{database.close();}
 await f.reopen();
 // 重开后副本由 initialize 重新绑定；停读时官方 close 之后重新捕获并写入清单，不能因旧记录带设备号而每次被拒。
 await f.runtime.close();
 const [copy]=await f.storage.execute('runtime.inventory',{ownerId:owner});
 assert.equal(copy.state,'ready');assert.equal(copy.manifestComplete,true);
 // 同一副本之后仍可被讨论删除按完整清单清理：删除侧核对清单时同样忽略旧设备号。
 const service=await deletion(f),op=await service.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'discussion',contactId:f.ids[0],discussionId:d.id}});
 const done=await service.advance(op);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual((await f.storage.execute('runtime.inventory',{ownerId:owner})).filter(c=>c.state!=='deleted'),[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
