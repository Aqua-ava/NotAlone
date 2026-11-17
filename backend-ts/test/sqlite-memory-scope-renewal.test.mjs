import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record} from './sqlite-clear-support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

for(const boundary of ['unknown','paused'])test(`重新确认的授权不被旧${boundary}轮阻挡，旧输入与回执保持失效`,async t=>{
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
 await f.current.contacts.revoke(f.contactA,token.binding_id,token.selection_generation);
 const candidates=await f.current.contacts.candidates(true),selection=candidates.sessions.find(row=>row.known_contact_id===f.contactA);
 await f.current.contacts.confirm(candidates.snapshot_token,[{locator:selection.username,observed_display_name:selection.display_name,expected_selection_generation:selection.selection_generation,contact_id:f.contactA}]);
 f.state.pageRecords=[record('shard-a','62')];await f.current.history.synchronize(f.contactA);fail=false;
 const view=await memory.readContact(f.contactA);assert.equal(view.run,null,'新授权视图不能回退到已撤销旧授权的进度');
 assert.equal((await memory.scanSchedule(Date.now(),[f.contactA])).contacts.some(row=>row.historyDue),true);
 const run=await memory.startHistoryBatch(f.contactA,randomUUID());assert.ok(run);assert.equal(run.total,1);await memory.waitForIdle(run.runId);
 assert.equal((await memory.read(run.runId)).succeeded,1);
 assert.deepEqual(await execute('fixture.memoryRawControl',{ownerId:owner,runId:old.run.runId}),before,'旧暂停与未知回执不能被新认证改写或重放');
});
