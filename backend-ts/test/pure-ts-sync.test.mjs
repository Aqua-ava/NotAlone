import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {HostStorage} from '../src/host-storage.ts';
import {createSyncIncrementalApi} from '../src/sync-incremental-api.ts';
import {PureTsSync} from '../src/pure-ts-sync.ts';
import {PureTsEvents} from '../src/pure-ts-events.ts';
import {createWechatScopeApi} from '../src/wechat-scope-api.ts';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
test('纯 TS 公开同步在授权范围写入，发布原协议事件，关闭与撤销后停读',{timeout:30000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-account','friend-a')",[binding,owner,contact]);
 await f.client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,false)',[owner]);
 const executable=join(f.directory,'synthetic-cli'),log=join(f.directory,'commands.jsonl');await writeFile(log,'');
 await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(a[0]==='--version')emit({version:'synthetic-1'});
else if(a[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(a[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成联系人',chat_type:'private'}]});
else if(a[0]==='resolve-chat')emit({candidates:[{username:a[1],display_name:'合成联系人',chat_type:'private'}]});
else if(a.includes('--mode'))setInterval(()=>{},1000);
else if(a[0]==='tail'){const events=a.includes('--cursor')?[]:[{type:'message',cursor:'opaque-11',message:{id:{local_id:11,talker:a[1]},kind:'text',text:'合成消息',is_from_me:false,create_time:Math.floor(Date.now()/1000)}}];emit({events,cursor:events.length?'opaque-11':null,freshness:{message_source:'live_message_db'},query:{chat:a[1],has_more:false}});}
else process.exit(2);`,{mode:0o700});
 const app=await f.start({NOTALONE_OWNER_ID:owner,NOTALONE_WECHAT_CLI:executable});
 const initial=await app.request('/api/sync/status');assert.equal(initial.status,200);assert.equal(initial.data.sync_enabled,false);
 const diagnostic=await app.request('/api/sync/follow-smoke/status');assert.equal(diagnostic.status,200);assert.equal(diagnostic.data.contacts[0].message_count,0);
 assert.deepEqual(await app.request('/api/sync/follow-smoke/start',{}),{status:409,data:{error:'follow_smoke_rejected',reason:'sync_disabled'}});
 assert.equal(await readFile(log,'utf8'),'');
 const cancel=new AbortController();
 const stream=await fetch(`http://${app.connection.address}/api/events`,{headers:{Authorization:`Bearer ${app.connection.token}`},signal:cancel.signal});
 const reader=stream.body.getReader();await reader.read();
 assert.equal((await app.request('/api/sync/enable',{})).status,200);
 const messages=await app.request(`/api/contacts/${contact}/messages`);assert.equal(messages.status,200);assert.equal(messages.data.messages.length,1);
 let text='';for(let i=0;i<8&&!text.includes('message.created');i++){text+=new TextDecoder().decode((await reader.read()).value);}
 assert.match(text,/event: message.created/);assert.match(text,/"type":"message.created"/);assert.equal(text.includes('合成消息'),false);
 assert.equal((await app.request('/api/sync/disable',{})).data.sync_enabled,false);
 const stopped=await readFile(log,'utf8');await app.request('/api/sync/check',{});assert.equal(await readFile(log,'utf8'),stopped);
 assert.equal((await app.request('/api/sync/cli-bindings/revoke',{contact_id:contact,binding_id:binding})).status,200);
 assert.deepEqual((await app.request('/api/sync/cli-bindings')).data.bindings,[]);
 cancel.abort();await reader.cancel().catch(()=>{});
 assert.equal((await app.request('/api/runtime/shutdown',{})).data.state,'stopped');assert.equal(await app.host.waitForExit(7000),true);
});

test('大范围历史状态不阻断初始清除后的最新优先联系人登记',{timeout:20000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
 await f.client.query(`INSERT INTO contact(id,owner_id,display_name)
  SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'合成联系人'||n FROM generate_series(1,291) n`,[owner]);
 await f.client.query(`INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator)
  SELECT owner_id,id,'wechat','synthetic-account','synthetic-'||id FROM contact WHERE owner_id=$1`,[owner]);
 await f.client.query(`INSERT INTO cli_history_sync_state(owner_id,contact_id,binding_id,phase,watermark_at,started_at,failure_code)
  SELECT owner_id,contact_id,id,CASE WHEN right(contact_id::text,12)::bigint<=5 THEN 'incomplete' ELSE 'complete' END,
   now(),now(),CASE WHEN right(contact_id::text,12)::bigint<=5 THEN 'local_history_missing' ELSE NULL END
  FROM conversation_binding WHERE owner_id=$1`,[owner]);
 await f.client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,false)',[owner]);
 const storage=await HostStorage.open({envFilePath:join(f.directory,'unused.env'),migrationsDirectory:resolve('../backend/database/migrations'),
  environment:{NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:`host=/tmp dbname=${f.client.database}`,NOTALONE_OWNER_ID:owner}});
 const incremental=await createSyncIncrementalApi({storage,executable:join(f.directory,'must-not-run'),historyOwner:'typescript',publish:async()=>{assert.fail('优先提示不得派发正文任务');}});
 const events=new PureTsEvents(owner),publicSync=await PureTsSync.create(storage,incremental,events);
 const authority=await createWechatScopeApi({storage,executable:join(f.directory,'must-not-run'),readSyncStatus:()=>publicSync.status()});
 f.cleanup(async()=>{await authority.close();await publicSync.close();await incremental.close();events.close();await storage.close();});
 assert.equal((await authority.handle('POST','/api/sync/scope',{mode:'all_private',confirmed:true})).status,200);
 const scope={owner_id:owner,channel:'wechat',account_scope:'synthetic-account'};
 const cycle=()=>incremental.execute('POST','/api/runtime/sync-incremental/cycle',scope);
 // 总开关关闭时填充真实历史投影，不启动引擎计时器或任何 CLI。
 assert.equal((await cycle()).status,200);
 const initial=await publicSync.status();
 assert.equal(initial.cli_history_coverages.length,291);
 assert.equal(initial.cli_history_coverages.filter(row=>row.phase==='incomplete').length,5);
 assert.ok(Buffer.byteLength(JSON.stringify(initial))>16384);
 await f.client.query('UPDATE front_sync_state SET enabled=true WHERE owner_id=$1',[owner]);
 const {build}=createRequire(import.meta.url)('../../desktop/node_modules/esbuild');
 const built=await build({stdin:{contents:`
  export { BackendHost } from './src/main/backend/host';
  export { installContactSessionBridge } from './src/main/contacts/bridge';
  export { SyncControlController } from './src/main/sync/controller';
  export { SyncPriorityController } from './src/main/sync/priority';
 `,resolveDir:resolve('../desktop')},bundle:true,platform:'node',format:'cjs',write:false});
 const bundle=join(f.directory,'desktop-ports.cjs');await writeFile(bundle,built.outputFiles[0].contents,{mode:0o600});
 const ports=createRequire(import.meta.url)(bundle),requests=[],receipts=[];let statusWireBytes=0,arrivedClear,releaseClear,clearHeld=false;
 const enteredClear=new Promise(resolve=>{arrivedClear=resolve;}),heldClear=new Promise(resolve=>{releaseClear=resolve;});
 const server=createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(req.headers.authorization!=='Bearer synthetic_priority_token')return send(401,{error:'unauthorized'});
  if(req.url==='/api/runtime/status')return send(200,{state:'running',runtime:'dsh',hostRuntime:'typescript',
   ownership:Object.fromEntries(['contacts','deletion','wechat','skills','skillLearning','imports','taskApi','taskManagement','tasks','crossDomainDeletion','wechatBodySync','wechatIncremental','wechatHistory','foregroundLocation','contactContext','memory','expressionPreferences'].map(key=>[key,'typescript']))});
  if(req.url==='/api/runtime/shutdown')return send(200,{state:'stopped',runtime:'dsh'});
  if(req.url==='/api/setup/status')return send(200,{runtime_owner_configured:true});
  if(req.url==='/api/contacts')return send(200,{contacts:(await f.client.query('SELECT id AS contact_id,display_name FROM contact WHERE owner_id=$1 ORDER BY id',[owner])).rows.map(row=>({...row,data_status:{message_count:0,source_count:0}}))});
  let text='';for await(const chunk of req)text+=chunk;
  const body=text?JSON.parse(text):undefined;
  if(new URL(req.url,'http://localhost').pathname==='/api/sync/priority')requests.push(body.contact_id);
  try{const result=await publicSync.handle(req.method,new URL(req.url,'http://localhost'),body,new AbortController().signal);
   const value=result?.status===200?await authority.decorateSyncStatus(result.body):result?.body??{error:'not_found'};
   const bytes=Buffer.byteLength(JSON.stringify(value));
   if(new URL(req.url,'http://localhost').pathname==='/api/sync/priority')receipts.push({contactId:body.contact_id,status:result.status,bytes,body:value});
   if(req.url==='/api/sync/status')statusWireBytes=bytes;
   if(body?.contact_id===null&&!clearHeld){clearHeld=true;arrivedClear();await heldClear;}
   send(result?.status??404,value);
  }catch{send(503,{error:'sync_status_unavailable'});}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const info=join(f.directory,'backend.info');
 await writeFile(info,`address=127.0.0.1:${server.address().port}\ntoken=synthetic_priority_token\npid=${process.pid}\n`,{mode:0o600});
 await writeFile(join(f.directory,'backend-launch.json'),JSON.stringify({backendInfoPath:info}),{mode:0o600});
 const backend=new ports.BackendHost(f.directory);
 const contacts=ports.installContactSessionBridge({handle(){},publish(){}},backend);
 const sync=new ports.SyncControlController(backend,contacts);let priority;
 f.cleanup(async()=>{releaseClear();await priority?.dispose();sync.dispose();await backend.stop();server.closeAllConnections();await new Promise(r=>server.close(r));});
 await backend.connect();await contacts.refreshContacts();await sync.refresh();
 await new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>{unsubscribe();reject(new Error('合成同步状态未就绪'));},2000);
  const check=()=>{if(sync.getState().phase!=='ready')return;clearTimeout(deadline);unsubscribe();resolve();};
  const unsubscribe=sync.onStateChanged(check);check();
 });
 const previous='10000000-0000-4000-8000-000000000001',selected='10000000-0000-4000-8000-000000000002';
 assert.equal(contacts.selectContact({contactId:previous,scopeRevision:contacts.getState().scopeRevision}).selectedContactId,previous);
 assert.equal(sync.getState().report?.enabled,true,JSON.stringify({phase:sync.getState().phase,errorCode:sync.getState().errorCode}));
 assert.equal(sync.getState().report.syncScope,'all_private');
 const generation=backend.getConnectionGeneration();
 await assert.rejects(backend.requestJson({method:'POST',path:'/api/sync/priority',body:{contact_id:previous},maxResponseBytes:16384}),
  error=>error.kind==='response'&&error.code==='response_too_large');
 assert.equal(backend.getConnectionGeneration(),generation);
 assert.equal(receipts.at(-1).status,200,'客户端大响应失败前，生产公开接口已接纳操作');
 assert.ok(receipts.at(-1).bytes>16384);
 requests.length=0;
 priority=new ports.SyncPriorityController(backend,contacts,sync);
 await new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>reject(new Error('初始 clear 未到达合成接口')),2000);
  enteredClear.then(()=>{clearTimeout(deadline);resolve();});
 });
 contacts.selectContact({contactId:selected,scopeRevision:contacts.getState().scopeRevision});
 assert.deepEqual(requests,[null],'clear 回执在途时不能并发提交选择');
 releaseClear();
 // 有界刷新是生产重试触发源；初始 clear 必须确认后才能登记当前选择。
 for(let attempt=0;attempt<3&&!requests.includes(selected);attempt++){
  await backend.requestJson({method:'GET',path:'/api/sync/status'});await sync.refresh();
 }
 await f.client.query('UPDATE front_sync_state SET enabled=false WHERE owner_id=$1',[owner]);
 assert.equal((await cycle()).status,200);
 const final=await publicSync.status();
 t.diagnostic(JSON.stringify({historyCoverages:291,statusWireBytes,priorityRequests:requests,selectedRegistered:requests.includes(selected),
  legacyClientFailure:'response_too_large',generationUnchanged:backend.getConnectionGeneration()===generation,
  serverAcceptedClear:receipts.some(row=>row.contactId===null&&row.status===200),ackBytes:receipts.at(-1).bytes}));
 assert.ok(requests.includes(selected),'大范围状态不能让初始 clear 的 ACK 失败并永远只重试 null');
 assert.deepEqual(requests,[null,selected]);
 for(const receipt of receipts.slice(1)){
  assert.equal(receipt.status,200);assert.equal(receipt.body.accepted,true);assert.equal(receipt.body.contact_id,receipt.contactId);
  assert.ok(receipt.bytes<16384);assert.equal('sync_enabled' in receipt.body,false);assert.equal('cli_history_coverages' in receipt.body,false);
 }
 assert.ok(statusWireBytes>16384);
 assert.equal((await publicSync.status()).cli_priority_last_success_at,null,'登记回执不证明实际读取成功');
 assert.equal(final.cli_priority_contact_id,null,'尚未读取的优先状态保持 unknown，不从登记推算读取结果');
 assert.equal(final.sync_enabled,false);assert.deepEqual(final.cli_history_coverages,initial.cli_history_coverages);
 assert.equal((await f.client.query('SELECT count(*)::int AS count FROM message')).rows[0].count,0);
});
