// 旧副本及认证审计由历史专用夹具建立；断言继续验证当前存储的删除与抑制保护。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,report,createChannel} from './sqlite-clear-support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteHistoryRecertifyService} from './fixtures/history/legacy-recertify-service.ts';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

for(const boundary of ['unknown','paused'])test(`重新认证的新授权不被旧${boundary}轮阻挡，旧输入与回执保持失效`,async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-sqlite/renewed-scope-registry.mjs',import.meta.url).href});
 f.state.pageRecords=Array.from({length:61},(_,i)=>record('shard-a',String(i+1)));await f.current.history.synchronize(f.contactA);
 const storage=f.current.storage,execute=storage.execute.bind(storage),between=Promise.withResolvers(),release=Promise.withResolvers();let claims=0,memory;
 if(boundary==='paused')f.current.storage.execute=async(name,...args)=>{if(name==='memoryExtraction.claim'&&++claims===2){between.resolve();await release.promise;}return execute(name,...args);};
 let fail=boundary==='unknown';const port=modelPort(()=>memory.accounting,async request=>{if(fail)throw Error('合成未知响应');return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};});
 memory=new SqliteMemoryExtraction(f.current.storage,owner,port,f.current.holders,undefined,id=>f.current.history.ensureSourceReady(id));t.after(async()=>{release.resolve();await memory.close();storage.execute=execute;});
 const old=await memory.startHistory(f.contactA,randomUUID());
 if(boundary==='paused'){await between.promise;const view=await memory.read(old.run.runId);await memory.pause(old.run.runId,view.controlVersion,randomUUID());release.resolve();}
 await memory.waitForIdle(old.run.runId);
 const before=await execute('fixture.memoryRawControl',{ownerId:owner,runId:old.run.runId}),token=await f.current.contacts.eligibility(f.contactA);
 await f.current.storage.execute('history.markContinuityLost',{token});
 const inspect=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
 const recertify=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,()=>{const {channel,state}=createChannel();state.pageRecords=[record('shard-a','1')];state.inspectFactory=inspect;channel.guardSession={loss:new Promise(()=>{})};return channel;},f.current.holders,{stopHistory:id=>f.current.history.stop(id)});t.after(()=>recertify.close());
 const renewed=await recertify.recertify(f.contactA,{requestKey:`renew-memory-${boundary}`});assert.equal(renewed.state,'completed');
 f.state.inspectFactory=inspect;f.channel.guardSession={loss:new Promise(()=>{})};await f.current.history.ensureSourceReady(f.contactA);fail=false;
 const view=await memory.readContact(f.contactA);assert.equal(view.run,null,'新授权视图不能回退到已撤销旧授权的进度');
 assert.deepEqual(await memory.dueHistoryContacts(),[f.contactA]);
 const run=await memory.startHistoryBatch(f.contactA,randomUUID());assert.ok(run);assert.equal(run.total,1);await memory.waitForIdle(run.runId);
 assert.equal((await memory.read(run.runId)).succeeded,1);
 assert.deepEqual(await execute('fixture.memoryRawControl',{ownerId:owner,runId:old.run.runId}),before,'旧暂停与未知回执不能被新认证改写或重放');
});
