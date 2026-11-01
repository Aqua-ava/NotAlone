import test from 'node:test';
import assert from 'node:assert/strict';
import {watch} from 'node:fs';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {launchDsh} from '../src/launch.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {documentProfileSupplier} from './fixtures/memory-documents/profile-supplier.mjs';

function changed(directory,probe,accept,{timeoutMs=12000,label='正式自动记忆轮'}={}){
 return new Promise((resolveValue,reject)=>{
  let ended=false,running=false,dirty=false;
  const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);watcher.close();error?reject(error):resolveValue(value);};
  const load=async()=>{if(ended)return;if(running){dirty=true;return;}running=true;try{const value=await probe();if(accept(value))finish(null,value);}catch(error){if(error.code!=='ENOENT')finish(error);}finally{running=false;if(dirty&&!ended){dirty=false;void load();}}};
  const watcher=watch(directory,()=>{void load();}),timer=setTimeout(()=>finish(new Error(`${label}未就绪`)),timeoutMs);void load();
 });
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

test('正式宿主按增量静默阈值自动建单联系人轮，排队文档并在同库重启后不重发',{timeout:45000},async t=>{
 const cleanups=[];let host,provider,reopened,info,runId,api;
 const f=await fixture({after:cleanup=>cleanups.push(cleanup)}),root=f.root,contactId=f.saved[0].contact_id;
 const infoPath=join(root,'managed/sqlite-backend.info'),envFilePath=join(root,'synthetic.env'),auditPath=join(root,'synthetic-network.jsonl'),stderrPath=join(root,'synthetic-host.stderr'),wrapper=join(root,'synthetic-node');
 const databaseId=f.storage.status.databaseId;
 f.channel.page=async(_scope,target)=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在台南。'})],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),acceptedAt=Date.now()-10*60_000-5_000;
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),
  page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:[record('2',{text:'我平时喜欢周末徒步。'})]},
  at:acceptedAt,runtimeToken:f.storage.status.runtimeId});
 await f.contacts.setReading(false);
 const messages=(await f.service.read(contactId)).messages;assert.equal(messages.length,2);
 const history=messages.find(message=>message.text==='我长期住在台南。'),incremental=messages.find(message=>message.text==='我平时喜欢周末徒步。');
 assert.ok(history&&incremental);assert.notEqual(history.id,incremental.id);
 await f.service.close();await f.contacts.close();await f.storage.close();
 t.after(async()=>{
  if(host?.isRunning()){if(info&&api)await api('/api/runtime/shutdown',{method:'POST',timeoutMs:2000}).catch(()=>{});if(!await host.waitForExit(5000))assert.equal(await host.terminate(),true,'只终止本轮合成宿主');}
  assert.ok(!host?.isRunning());await reopened?.close();
  if(provider){provider.closeAllConnections();await new Promise(done=>provider.close(done));}
  await f.service.close();await f.contacts.close();for(const cleanup of cleanups.reverse())await cleanup();await assert.rejects(access(root),error=>error.code==='ENOENT');
 });
 await writeFile(envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n',{mode:0o600,flag:'wx'});
 await writeFile(auditPath,'',{mode:0o600,flag:'wx'});await writeFile(stderrPath,'',{mode:0o600,flag:'wx'});
 const guard=new URL('./fixtures/sqlite-memory-profile-network-guard.mjs',import.meta.url).pathname;
 await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(guard)} "$@" 2>> ${quote(stderrPath)}\n`,{mode:0o700,flag:'wx'});
 const supplier=documentProfileSupplier();provider=createServer(supplier.handler);provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const supplierOrigin=`http://127.0.0.1:${provider.address().port}`;
 api=async(route,{body,method=body===undefined?'GET':'POST',timeoutMs=3000}={})=>{
  const response=await fetch(`http://${info.address}${route}`,{method,headers:{Authorization:`Bearer ${info.token}`,...(body===undefined?{}:{'content-type':'application/json'})},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeoutMs)});return {status:response.status,data:await response.json()};
 };
 const boot=async()=>{
  host=await launchDsh({nodeExecutable:wrapper,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath,infoPath,businessHome:root,
   environment:{NOTALONE_SYNTHETIC_PROVIDER_URL:supplierOrigin,NOTALONE_SYNTHETIC_NETWORK_AUDIT:auditPath},
   sqlite:{userData:root,expectedDatabaseId:databaseId,role:'test',capabilities:['contacts','history','memory']}},()=>true);
  info=await changed(dirname(infoPath),async()=>Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const n=line.indexOf('=');return [line.slice(0,n),line.slice(n+1)];})),value=>Boolean(value.address&&value.token),{timeoutMs:10000});
  assert.equal((await api('/api/runtime/status')).data.runtime,'dsh');assert.equal((await api('/api/sync/status')).data.sync_enabled,false);
 };
 await boot();
 const wal=join(root,'managed/sqlite/notalone.sqlite-wal');
 let completed;
 try{completed=await changed(wal,async()=>api('/api/memory-processing/runs/current'),value=>value.status===200&&value.data?.total===1&&value.data.succeeded===1&&value.data.status==='waiting'&&value.data.statusReason==='later_stages_scheduled',{timeoutMs:20000,label:'自动增量提取与文档排队'});}
 catch(error){throw new Error(`${error.message}; ${JSON.stringify({run:(await api('/api/memory-processing/runs/current')).data,schedule:(await api('/api/memory-processing/schedule')).data,errors:supplier.errors,extraction:supplier.windows.length,verification:supplier.verifications.length,stderr:(await readFile(stderrPath,'utf8')).slice(-1600)})}`);}
 assert.equal(completed.status,200);const run=completed.data;runId=run.runId;
 assert.deepEqual(run.inputs.filter(input=>input.role==='target').map(input=>input.messageId),[incremental.id]);
 assert.ok(!run.inputs.some(input=>input.messageId===history.id),'尚未显式初始化的历史不当成成功上下文或新目标');
 assert.ok(run.inputs.every(input=>input.contactId===contactId));assert.equal(run.stage,'document_scene');assert.equal(run.laterStages,'pending');assert.ok(run.nextDueAt>Date.now());
 const trace=await api(`/api/memory-processing/tasks/${run.tasks.find(task=>task.scopeKind==='contact').taskId}/events`);
 assert.equal(trace.status,200);assert.ok(trace.data.events.every(event=>event.sources.every(source=>source.contactId===contactId)));
 const memories=await api(`/api/memory-management?scope_kind=contact&contact_id=${contactId}`);
 assert.equal(memories.status,200);assert.ok(memories.data.memories.some(memory=>memory.current?.adoptionMode==='auto'&&memory.current?.body==='联系人平时喜欢周末徒步。'));
 assert.equal(supplier.errors.length,0,JSON.stringify(supplier.errors));assert.equal(supplier.windows.length,1);assert.equal(supplier.verifications.length,1);assert.equal(supplier.adjudications.length,0);assert.equal(supplier.documents.length,0);
 const calls= supplier.windows.length+supplier.verifications.length+supplier.adjudications.length+supplier.documents.length;assert.equal(calls,2);
 const redirects=(await readFile(auditPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.equal(redirects.length,calls);assert.ok(redirects.every(item=>item.kind==='redirect'&&item.syntheticAuthentication));
 assert.equal((await api('/api/runtime/shutdown',{method:'POST'})).data.state,'stopped');assert.equal(await host.waitForExit(5000),true);assert.equal(host.isRunning(),false);
 reopened=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});await reopened.close();reopened=undefined;
 const beforeRestart=calls;await boot();
 const current=await api('/api/memory-processing/runs/current');assert.equal(current.status,200);assert.equal(current.data.runId,runId);assert.equal(current.data.total,1);
 const schedule=await api('/api/memory-processing/schedule');assert.equal(schedule.status,200);assert.equal(schedule.data.pending,0);assert.equal(schedule.data.later.pending,1);assert.equal(schedule.data.later.stage,'document_scene');
 assert.equal(supplier.windows.length+supplier.verifications.length+supplier.adjudications.length+supplier.documents.length,beforeRestart,'重启同一数据库不重做已分配目标');
 await api('/api/runtime/shutdown',{method:'POST'});assert.equal(await host.waitForExit(5000),true);assert.ok(!host.isRunning());
});
