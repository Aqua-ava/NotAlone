import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createForegroundFixture} from './foreground-location-fixture.mjs';

test('授权撤销等待事务时客户端断连，排空后恢复且不能返回旧身份',async t=>{
 const f=await createForegroundFixture(t);
 assert.equal((await f.app.request('/api/sync/foreground/observe',{})).data.contact_id,f.contact);
 await f.client.query('BEGIN');
 await f.client.query('SELECT id FROM conversation_binding WHERE id=$1 FOR UPDATE',[f.binding]);
 try {
 const cancelled=new AbortController();
 const pending=fetch(`http://${f.app.connection.address}/api/sync/cli-bindings/revoke`,{method:'POST',headers:{Authorization:`Bearer ${f.app.connection.token}`,'Content-Type':'application/json'},body:JSON.stringify({contact_id:f.contact,binding_id:f.binding}),signal:cancelled.signal}).catch(()=>null);
 // 有界观察本合成库的锁等待，保证断连发生在授权业务已开始之后。
 const deadline=Date.now()+5000;let blocked=false;
 while(Date.now()<deadline){await f.client.query('SELECT pg_stat_clear_snapshot()');const rows=await f.client.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()");if(rows.rowCount){blocked=true;break;}}
 assert.equal(blocked,true);cancelled.abort();await pending;
 await f.app.request('/api/runtime/status');
 const observed=await f.app.request('/api/sync/foreground/observe',{});
 assert.equal(observed.status,409);assert.equal(observed.data.error,'runtime_stopped');
 await f.client.query('COMMIT');
 let current;const drainDeadline=Date.now()+10000;
 while(Date.now()<drainDeadline){current=await f.app.request('/api/sync/foreground/observe',{});if(current.status!==409)break;}
 assert.equal(current.status,200);assert.equal(current.data.contact_id,null);
 const bindings=(await f.app.request('/api/sync/cli-bindings')).data;
 assert.equal(bindings.bindings.some(row=>row.binding_id===f.binding),false);
 assert.equal(bindings.revoked_bindings.some(row=>row.binding_id===f.binding),true);
 assert.equal((await f.client.query('SELECT status FROM conversation_binding WHERE id=$1',[f.binding])).rows[0].status,'revoked');
 const checked=await f.app.request('/api/sync/check',{});
 assert.equal(checked.status,200);assert.equal(checked.data.cli_sync_phase,'waiting_bindings');
 assert.equal(checked.data.cli_bound_count,0);
 assert.equal((await f.app.request('/api/sync/cli-bindings/revoke',{contact_id:f.contact,binding_id:f.binding})).status,200);
 }finally{await f.client.query('ROLLBACK');}
});


test('官方profile真实HTTP仅TS定位：原UUID、歧义/改名/低分、关闭与内部移交隔离',async t=>{
 const f=await createForegroundFixture(t);
 const status=await f.app.request('/api/runtime/status');
 assert.equal(status.data.runtime,'dsh');assert.equal(status.data.ownership.foregroundLocation,'typescript');
 assert.equal((await f.app.request('/api/runtime/foreground-location/stop',{})).status,404);
 assert.equal((await f.app.request('/api/sync/foreground/observe',{contact_id:f.contact})).status,400);
 assert.equal((await f.app.request('/api/sync/cli-bindings/revoke',{contact_id:'invalid',binding_id:'invalid'})).status,400);
 const confirmed=await f.app.request('/api/sync/foreground/observe',{});
 assert.equal(confirmed.status,200);assert.equal(confirmed.data.contact_id,f.contact);assert.equal(confirmed.data.binding_id,f.binding);
 await f.setSessions([{username:'fixture-a',display_name:'合成甲友',chat_type:'private'},{username:'unbound',display_name:'合成甲友',chat_type:'private'}]);
 assert.equal((await f.app.request('/api/sync/foreground/observe',{})).data.phase,'manual-required');
 await f.setSessions([{username:'fixture-a',display_name:'合成新名',chat_type:'private'}]);await f.setProbe({name:'合成新名',confidence:0.99});
 assert.equal((await f.app.request('/api/sync/foreground/observe',{})).data.reason,'unmatched_requires_selection');
 await f.setSessions([{username:'fixture-a',display_name:'合成甲友',chat_type:'private'}]);await f.setProbe({name:'合成甲友',confidence:0.1});
 assert.equal((await f.app.request('/api/sync/foreground/observe',{})).data.reason,'quality_unverified');
 await f.setProbe({name:'合成甲友',confidence:0.99});
 assert.equal((await f.app.request('/api/sync/disable',{})).status,200);
 assert.equal((await f.app.request('/api/sync/foreground/observe',{})).data.reason,'sync_disabled');
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM message')).rows[0].n,0);
});

test('正式桌面控制器经官方宿主HTTP消费身份与歧义门，不自动生成回复',async t=>{
 const f=await createForegroundFixture(t);
 assert.equal((await f.app.request('/api/runtime/status')).data.ownership.foregroundLocation,'typescript');
 const {createRequire}=await import('node:module');const require=createRequire(new URL('../../desktop/package.json',import.meta.url));
 const {build}=require('esbuild');const desktop=resolve(new URL('../../desktop',import.meta.url).pathname);
 const compiled=await build({stdin:{contents:["export {ForegroundController} from './src/main/foreground/controller';","export {ContactSession} from './src/main/contacts/session';","export {readContactDirectory} from './src/main/contacts/directory';","export {JsonClient} from './src/main/backend/json-client';","export {readConnection} from './src/main/backend/connection';"].join('\n'),resolveDir:desktop},bundle:true,platform:'node',format:'esm',write:false,banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(join(desktop,'package.json'))});`}});
 const modulePath=join(f.directory,'desktop-foreground.mjs');await writeFile(modulePath,compiled.outputFiles[0].text);const ports=await import(modulePath);
 const client=new ports.JsonClient(await ports.readConnection(join(f.directory,'backend.info')));
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},async requestJson(request){return {...await client.perform(request),generation:1};}};
 const contacts=new ports.ContactSession(()=>ports.readContactDirectory(backend));contacts.setConnection(1);await contacts.refreshContacts();
 const foreground=new ports.ForegroundController(backend,contacts);t.after(()=>foreground.dispose());
 await foreground.observeBeforeShow();assert.equal(foreground.getState().confirmedContactId,f.contact);assert.equal(foreground.getGenerationBlock(),null);
 await f.setSessions([{username:'fixture-a',display_name:'合成甲友',chat_type:'private'},{username:'other',display_name:'合成甲友',chat_type:'private'}]);
 await foreground.observeBeforeShow();assert.equal(foreground.getState().reason,'ambiguous_requires_selection');assert.notEqual(foreground.getGenerationBlock(),null);
 await f.setSessions([{username:'fixture-a',display_name:'合成甲友',chat_type:'private'}]);await foreground.observeBeforeShow();
 assert.equal(foreground.getState().reason,'confirmed_active_binding');assert.equal(foreground.getState().confirmedContactId,f.contact);assert.equal(foreground.getGenerationBlock(),null);
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_request')).rows[0].n,0);
});
