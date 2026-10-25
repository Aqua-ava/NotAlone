import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';

test('纯 TS 官方产品入口无需 Python，公开联系人、讨论、SSE 和退出可用',{timeout:30000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 const otherOwner=randomUUID(),otherContact=randomUUID();await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成另一本人')",[otherOwner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成另一范围')",[otherContact,otherOwner]);
 const app=await f.start({NOTALONE_OWNER_ID:owner});
 assert.equal((await app.request('/api/runtime/status',undefined,'GET','wrong')).status,401);
 const health=(await app.request('/api/runtime/status')).data;
 assert.equal(health.hostRuntime,'typescript');assert.equal(health.legacyPid,undefined);
 const processes=execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{const [,pid,ppid,command]=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);return {pid:+pid,ppid:+ppid,command};});
 const tree=new Set([app.host.pid]);for(let i=0;i<processes.length;i++)for(const item of processes)if(tree.has(item.ppid))tree.add(item.pid);
 assert.equal(processes.filter(item=>tree.has(item.pid)&&/python/i.test(item.command)).length,0);
 assert.deepEqual((await app.request('/api/contacts')).data.contacts.map(item=>item.contact_id),[contact]);
 assert.equal((await app.request(`/api/contacts/${otherContact}/messages`)).status,404);
 assert.equal((await app.request('/api/skills/health')).status,200);
 const layered=await app.request(`/api/contacts/${contact}/layered-memory`);assert.equal(layered.status,200,JSON.stringify(layered));
 assert.equal((await app.request(`/api/contacts/${contact}/layered-memory/enable`,{settings_generation:layered.data.layered_memory.settings_generation,purpose_confirmed:true})).status,503,'未配置模型不伪造可执行任务');
 await app.request(`/api/contacts/${contact}/manual-confirmation`,{});
 const session=await app.request(`/api/contacts/${contact}/assistant-session/default`,{});
 assert.equal(session.status,200);assert.match(session.data.session_id,/^[0-9a-f-]{36}$/);
 const read=await app.request(`/api/contacts/${contact}/assistant-sessions/${session.data.session_id}`);
 assert.equal(read.status,200);assert.deepEqual(read.data.turns,[]);
 const abort=new AbortController();
 const events=await fetch(`http://${app.connection.address}/api/events`,{headers:{Authorization:`Bearer ${app.connection.token}`},signal:abort.signal});
 assert.equal(events.status,200);assert.equal(events.headers.get('x-notalone-event-replay'),'bounded-hints');
 const reader=events.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/: connected/);
 abort.abort();await reader.cancel().catch(()=>{});
 assert.deepEqual(await app.request('/api/reply/generate',{}),{status:503,data:{error:'reply_unavailable'}});
 assert.equal((await app.request('/api/runtime/shutdown',{})).data.state,'stopped');
 assert.equal(await app.host.waitForExit(7000),true);
 const restarted=await f.start({NOTALONE_OWNER_ID:owner});
 assert.equal((await restarted.request(`/api/contacts/${contact}/assistant-session/default`,{})).data.session_id,session.data.session_id);
 assert.equal((await restarted.request('/api/runtime/shutdown',{})).data.state,'stopped');
 assert.equal(await restarted.host.waitForExit(7000),true);
});

test('纯 TS 职责冲突在公开ready前拒绝，修正后同一路径可重试',{timeout:15000},async t=>{
 const f=await pureTsFixture(t);
 for(const environment of [{NOTALONE_REPLY_RUNTIME:'python'},{NOTALONE_EXTRACTION_RUNTIME:'python'},{NOTALONE_HISTORY_RUNTIME:'python'},{NOTALONE_REPLY_REMOTE_TOKEN:'synthetic-foreign-control'}])
  await assert.rejects(f.start(environment),/必须发布认证握手/);
 const app=await f.start();assert.equal((await app.request('/api/setup/status')).status,200);
 await app.request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
});
