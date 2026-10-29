import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { createWechatContactMetadata } from '../src/contacts/sqlite/wechat-metadata.ts';
import { launchDsh } from '../src/launch.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const account='synthetic-startup-owner',conversation='friend-a',generation='a'.repeat(64);
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest:hash(`${account}\0${conversation}`),sourceGeneration:generation,schemaFingerprint:'b'.repeat(64),
 tables:[{target:'c'.repeat(64),partition:'d'.repeat(64),role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:'2'}],checkedPartitions:['d'.repeat(64)]};

// 单个有界就绪探测同时用于appReady握手和后台覆盖；不调用任何手动同步端点。
async function ready(probe,accept,message){
 const deadline=Date.now()+15000;
 do{const value=await probe();if(accept(value))return value;await delay(25);}while(Date.now()<deadline);
 throw new Error(message);
}
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-history-startup-'))),artifact=join(root,'synthetic-artifact'),userData=join(root,'storage');
 await mkdir(join(artifact,'bin'),{recursive:true});await mkdir(join(artifact,'lib'));await mkdir(userData);
 const executable=join(artifact,'bin','wx-cli'),planFile=join(root,'synthetic-plan'),logFile=join(root,'synthetic-requests'),wcdbFile=join(artifact,'lib','libWCDB.dylib');
 await writeFile(planFile,JSON.stringify({history:'supported'}));
 // 所有认证档、账号、会话和正文均为自建合成值；固定版本仅用于走正式解析与接线。
 const script=`#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),schema=${JSON.stringify(schema)};
const cli=hash(fs.readFileSync(__filename)),wcdb=hash(fs.readFileSync(${JSON.stringify(wcdbFile)}));
const account=()=>({format:'wechat-account-metadata-v1',status:'verified',reason:null,accountKey:'${account}',identityScheme:'wechat.account.v1',sourceGeneration:'${generation}',supportProfile:'wechat-4.0.6-29387-account-session-metadata-v1',programVersion:'4.0.6',build:'29387',artifactSha256:cli,wcdbSha256:wcdb,configuredAccount:'verified',continuity:'held-contact-session-instances',normalHistory:false});
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),plan=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}));fs.appendFileSync(${JSON.stringify(logFile)},JSON.stringify({pid:process.pid,...r})+'\\n');let data;
 if(r.op==='metadata-account')data=account();
 else if(r.op==='metadata-sessions')data={format:'wechat-private-session-metadata-v1',account:account(),sessions:[{username:'friend-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},{username:'friend-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}]};
 else if(r.op==='resolve')data={accountKey:'${account}',conversationKey:'${conversation}',displayName:'合成甲',sourceGeneration:'${generation}'};
 else if(r.op==='inspect')data=schema;
 else if(r.op==='support')data={protocol:'private-history-v1',profileId:'synthetic-startup-history-v1',adapterVersion:'1',status:plan.history,reason:plan.history==='supported'?null:'history_message_state_unverified',accountKey:'${account}',conversationKey:'${conversation}',sourceGeneration:'${generation}',programVersion:'4.0.6',build:'29387',artifactSha256:cli,schemaFingerprint:schema.schemaFingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-final-status',continuity:'synthetic-fixed-source'};
 else if(r.op==='target')data={protocol:'private-history-v1',descriptor:'synthetic-startup-target',partitions:schema.checkedPartitions,tables:[{partition:'d'.repeat(64),instance:'c'.repeat(64)}],sourceGeneration:'${generation}'};
 else if(r.op==='page')data={target:r.target,cursorIn:r.cursor||null,cursorOut:null,records:[{partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:'0',sender:'contact',kind:'text',text:'仅合成的启动首次历史',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,status:'0'}],completedPartitions:schema.checkedPartitions,exhausted:true};
 if(data===undefined){process.stdout.write(JSON.stringify({ok:false,error:{code:'history_operation_unsupported'}})+'\\n');return;}
 process.stdout.write(JSON.stringify({ok:true,data})+'\\n');
});`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-startup-WCDB');await writeFile(wcdbFile,wcdb);
 await writeFile(join(artifact,'manifest.json'),JSON.stringify({formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',signing:'ad-hoc-development',realWechatVerified:false,cliSha256:hash(script),wcdbSha256:hash(wcdb)}));
 const storage=await SqliteStorage.open({userData,intent:'create',role:'test'}),databaseId=storage.status.databaseId;await storage.close();
 const hosts=[],routes=[];
 t.after(async()=>{for(const host of hosts.reverse())await host.terminate();await rm(root,{recursive:true,force:true});});
 return {root,userData,executable,databaseId,logFile,hosts,routes,setSupport:status=>writeFile(planFile,JSON.stringify({history:status}))};
}
async function requests(f){try{return (await readFile(f.logFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function start(f){
 const infoPath=join(f.userData,'managed/sqlite-backend.info');
 const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:join(f.root,'unused.env'),infoPath,businessHome:f.root,environment:{},sqlite:{userData:f.userData,expectedDatabaseId:f.databaseId,role:'test',capabilities:['contacts','history'],wechatCliPath:f.executable}},()=>true);f.hosts.push(host);
 const info=await ready(async()=>{try{return Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));}catch(error){if(error.code==='ENOENT')return null;throw error;}},value=>value?.address&&value?.token,'synthetic_host_appReady_timeout');
 const request=async(route,method='GET',body,headers={})=>{
  f.routes.push(route);const response=await fetch(`http://${info.address}`+route,{method,signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};
 };
 const runtime=await request('/api/runtime/status');assert.deepEqual(runtime.body.capabilities,['contacts','history']);
 return {host,request,shutdown:async()=>{assert.equal((await request('/api/runtime/shutdown','POST',{})).body.state,'stopped');assert.equal(await host.waitForExit(15000),true);}};
}
async function authorize(h){
 const setup=await h.request('/api/setup/status'),detected=await h.request('/api/setup/wechat/detect','POST',{});assert.equal(detected.status,200);assert.equal(detected.body.state,'ready');
 const connected=await h.request('/api/setup/wechat/confirm','POST',{candidate_token:detected.body.candidate_token,confirmed:true,mode:'selected',history_authorized:true});assert.equal(connected.status,200);
 const candidates=await h.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'});assert.equal(candidates.status,200);
 const row=candidates.body.sessions.find(row=>row.username===conversation);
 const confirmed=await h.request('/api/sync/cli-bindings/confirm','POST',{snapshot_token:candidates.body.snapshot_token,selections:[{locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation}],history_authorized:true});assert.equal(confirmed.status,200);
 const selected=await h.request('/api/sync/cli-bindings');assert.equal(selected.body.bindings.length,1);
 return {ownerId:setup.body.owner_id,contactId:selected.body.bindings[0].contact_id};
}
async function coverage(h,contactId,predicate){return ready(async()=>{const response=await h.request('/api/sync/status');assert.equal(response.status,200);return response.body;},status=>predicate(status.cli_history_coverages.find(row=>row.contact_id===contactId)),'synthetic_first_history_timeout');}
function noCliOrphans(rows){for(const pid of new Set(rows.map(row=>row.pid)))assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}

test('正式launchDsh/profile通过HTTP授权自动首次capture，无手动sync且body仍不可用',{timeout:45000},async t=>{
 const f=await fixture(t),h=await start(f),selected=await authorize(h);
 assert.equal((await h.request(`/api/contacts/${selected.contactId}/messages`)).body.messages.length,0);assert.equal((await requests(f)).some(row=>row.op==='target'||row.op==='page'),false);
 assert.equal((await h.request('/api/sync/enable','POST',{})).status,200);
 const status=await coverage(h,selected.contactId,row=>row?.phase==='complete');assert.equal(status.body_available,false);assert.equal(status.cli_backfill_total_message_count,1);
 const messages=await h.request(`/api/contacts/${selected.contactId}/messages`);assert.equal(messages.body.messages.length,1);assert.equal(messages.body.messages[0].text,'仅合成的启动首次历史');assert.equal(messages.body.messages[0].source_record_ids.length,1);
 const persisted=await h.request(`/api/contacts/${selected.contactId}/history`);assert.equal(persisted.body.phase,'complete');assert.equal(persisted.body.pageCount,1);assert.ok(persisted.body.goalId);
 const rows=await requests(f);assert.ok(rows.some(row=>row.op==='metadata-account'));assert.ok(rows.some(row=>row.op==='metadata-sessions'));assert.ok(rows.filter(row=>row.op==='resolve').every(row=>row.displayName===conversation));assert.deepEqual(rows.filter(row=>['target','page'].includes(row.op)).map(row=>row.op),['target','page']);assert.ok(f.routes.every(route=>!route.endsWith('/history/sync')));
 await h.shutdown();noCliOrphans(await requests(f));
});

test('正式appReady按持久开关首次派发，未知支持保持缺口且零target/page',{timeout:60000},async t=>{
 for(const support of ['supported','unverified'])await t.test(support,async t=>{
  const f=await fixture(t),initial=await start(f),selected=await authorize(initial);
  const before=await initial.request(`/api/contacts/${selected.contactId}/history`);assert.equal(before.body.phase,'not_started');assert.equal(before.body.goalId,null);assert.equal((await initial.request('/api/sync/status')).body.sync_enabled,false);assert.equal((await initial.request(`/api/contacts/${selected.contactId}/messages`)).body.messages.length,0);
  await initial.shutdown();assert.equal((await requests(f)).some(row=>row.op==='target'||row.op==='page'),false);
  // 只安排重启条件：正式联系人服务持久开启读取，不写goal、capture或message。
  const storage=await SqliteStorage.open({userData:f.userData,intent:'open',expectedDatabaseId:f.databaseId,role:'test'}),contacts=new SqliteContactService(storage,selected.ownerId,createWechatContactMetadata(f.executable));
  try{await contacts.setReading(true);const empty=await storage.execute('history.coverage',{ownerId:selected.ownerId,contactId:selected.contactId});assert.equal(empty.phase,'not_started');assert.equal(empty.goalId,null);assert.equal(empty.messageCount,0);}finally{await contacts.close();await storage.close();}
  await f.setSupport(support);const offset=(await requests(f)).length,reopened=await start(f);
  const status=await coverage(reopened,selected.contactId,row=>support==='supported'?row?.phase==='complete':row?.phase==='not_started'&&row.failure_code==='history_support_unverified');assert.equal(status.body_available,false);
  const messages=await reopened.request(`/api/contacts/${selected.contactId}/messages`),newRows=(await requests(f)).slice(offset);
  if(support==='supported'){assert.equal(messages.body.messages.length,1);assert.equal(messages.body.messages[0].text,'仅合成的启动首次历史');assert.deepEqual(newRows.filter(row=>['target','page'].includes(row.op)).map(row=>row.op),['target','page']);}
  else{assert.deepEqual(messages.body.messages,[]);assert.equal(status.cli_backfill_phase,'incomplete');assert.equal(newRows.some(row=>row.op==='target'||row.op==='page'),false);assert.equal((await reopened.request(`/api/contacts/${selected.contactId}/history`)).body.goalId,null);}
  assert.ok(newRows.some(row=>row.op==='resolve'));assert.ok(newRows.some(row=>row.op==='support'));assert.ok(f.routes.every(route=>!route.endsWith('/history/sync')));await reopened.shutdown();noCliOrphans(await requests(f));
 });
});
