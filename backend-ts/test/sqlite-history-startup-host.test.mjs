import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { createWechatContactMetadata } from '../src/contacts/sqlite/wechat-metadata.ts';
import { launchDsh } from '../src/launch.ts';
import { waitForHostReady } from './host-readiness-support.mjs';
import {png} from './visual-media-support.mjs';
import {DatabaseSync} from 'node:sqlite';

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
async function fixture(t,{images=false,recovery=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-history-startup-'))),artifact=join(root,'synthetic-artifact'),userData=join(root,'storage');
 await mkdir(join(artifact,'bin'),{recursive:true});await mkdir(join(artifact,'lib'));await mkdir(userData);
 const executable=join(artifact,'bin','wx-cli'),planFile=join(root,'synthetic-plan'),logFile=join(root,'synthetic-requests'),wcdbFile=join(artifact,'lib','libWCDB.dylib');
 await writeFile(planFile,JSON.stringify({history:'supported'}));
 // 所有认证档、账号、会话和正文均为自建合成值；固定版本仅用于走正式解析与接线。
 const script=`#!${process.execPath}
 // notalone-raw-source-safety:wechat-raw-source-readonly-v2
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),schema=${JSON.stringify(schema)};
const cli=hash(fs.readFileSync(__filename)),wcdb=hash(fs.readFileSync(${JSON.stringify(wcdbFile)}));
let selectedConversation='${conversation}';const imageBytes=Buffer.from('${png.toString('base64')}','base64'),imageDigest=hash(imageBytes);
const account=()=>({format:'wechat-account-metadata-v1',status:'verified',reason:null,accountKey:'${account}',identityScheme:'wechat.account.v1',sourceGeneration:'${generation}',supportProfile:'wechat-4.0.6-29387-account-session-metadata-v1',programVersion:'4.0.6',build:'29387',artifactSha256:cli,wcdbSha256:wcdb,configuredAccount:'verified',continuity:'held-contact-session-instances',normalHistory:false});
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),plan=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}));fs.appendFileSync(${JSON.stringify(logFile)},JSON.stringify({pid:process.pid,...r})+'\\n');let data;
 if(r.op==='metadata-account')data=account();
 else if(r.op==='metadata-sessions')data={format:'wechat-private-session-metadata-v1',account:account(),sessions:[{username:'friend-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},{username:'friend-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}]};
 else if(r.op==='release-selection')data={released:true};
 else if(r.op==='resolve'){selectedConversation=r.displayName;schema.scopeDigest=hash('${account}'+String.fromCharCode(0)+selectedConversation);data={accountKey:'${account}',conversationKey:selectedConversation,displayName:'合成甲',sourceGeneration:'${generation}'};}
 else if(r.op==='inspect')data=schema;
 else if(r.op==='support')data={protocol:'private-history-v1',profileId:'synthetic-startup-history-v1',adapterVersion:'1',status:plan.history,reason:plan.history==='supported'?null:'history_message_state_unverified',accountKey:'${account}',conversationKey:selectedConversation,sourceGeneration:'${generation}',programVersion:'4.0.6',build:'29387',artifactSha256:cli,schemaFingerprint:schema.schemaFingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-final-status',continuity:'${images||recovery?'same-source-instances-normal-use-v1':'synthetic-fixed-source'}'${recovery?",capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','serverIdUniqueConstraint','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail','recoverFromLocalIds'].map(key=>[key,'supported']))":''}};
 else if(r.op==='recover-target')data={target:{protocol:'private-history-v1',descriptor:'synthetic-startup-target',partitions:schema.checkedPartitions,tables:[{partition:'d'.repeat(64),instance:'c'.repeat(64)}],sourceGeneration:'${generation}'},cursor:'synthetic-recovery',anchors:[{partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:'0',sender:'contact',kind:'text',text:'仅合成的启动首次历史',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified',status:'0'}]};
 else if(r.op==='tail')data={target:r.target,cursorIn:r.cursor,cursorOut:r.cursor,records:[],caughtUp:true};
 else if(r.op==='target')data={protocol:'private-history-v1',descriptor:'synthetic-startup-target',partitions:schema.checkedPartitions,tables:[{partition:'d'.repeat(64),instance:'c'.repeat(64)}],sourceGeneration:'${generation}'};
 else if(r.op==='page')data={target:r.target,cursorIn:r.cursor||null,cursorOut:null,records:r.cursor==='synthetic-recovery'?[]:[{partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:'0',sender:'contact',kind:'${images?'image':'text'}',text:${images?'null':"'仅合成的启动首次历史'"},originalType:'${images?'3':'1'}',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified',status:'0'}],completedPartitions:schema.checkedPartitions,exhausted:true};
 else if(r.op==='image-open'){
 const qualityProof={kind:'wechat-message-image-content-v2',resourceInfoId:'10',matchingResourceIds:['20'],resourceSize:imageBytes.length,verifiedBytes:imageBytes.length,verifiedSha256:imageDigest,sourceSha256:imageDigest,conversion:'none',contentWidth:1,contentHeight:1,sourceVariant:'main',matchingResources:[{resourceId:'20',resourceTypeRaw:262145}],originalProof:null};
 data={protocol:'wechat-original-image-v1',resourceToken:'synthetic-startup-image',sourceGeneration:'${generation}',resourceSourceGeneration:'${generation}',target:r.target,partition:r.partition,table:r.table,localId:r.localId,serverId:r.serverId,sentAt:r.sentAt,resourceTable:'wechat-message-resource-v1',resourceId:'20',resourceTypeRaw:262145,variantCode:4,complete:true,quality:'unknown',qualityProof,expectedBytes:imageBytes.length,expectedSha256:imageDigest,mimeType:'image/png',envelope:'plain',sourceEnvelope:'plain'};
 }
 else if(r.op==='image-read'){const chunk=imageBytes.subarray(r.offset,Math.min(imageBytes.length,r.offset+65536));data={resourceToken:r.resourceToken,sourceGeneration:'${generation}',offset:r.offset,bytesRead:chunk.length,totalBytes:imageBytes.length,chunkBase64:chunk.toString('base64'),eof:r.offset+chunk.length===imageBytes.length,verifiedSha256:imageDigest};}
 else if(r.op==='image-close')data={closed:true};
 if(data===undefined){process.stdout.write(JSON.stringify({ok:false,error:{code:'history_operation_unsupported'}})+'\\n');return;}
 process.stdout.write(JSON.stringify({ok:true,data})+'\\n');
});`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-startup-WCDB');await writeFile(wcdbFile,wcdb);
 await writeFile(join(artifact,'manifest.json'),JSON.stringify({formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',historyPatchSha256:'a0fc0989b3d65e5d0b094789df36e8753c3ac675bd1a93fa83534b24e71bf440',rawSourceSafety:'wechat-raw-source-readonly-v2',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',signing:'ad-hoc-development',realWechatVerified:false,sharedProcessProtocol:'wechat-shared-process-v1',...(images?{originalImageProtocol:'wechat-original-image-v1',originalImageQualityProof:'wechat-message-image-content-v2'}:{}),cliSha256:hash(script),wcdbSha256:hash(wcdb)}));
 const storage=await SqliteStorage.open({userData,intent:'create',role:'test'}),databaseId=storage.status.databaseId;await storage.close();
 const hosts=[],routes=[];
 t.after(async()=>{for(const host of hosts.reverse())await host.terminate();await rm(root,{recursive:true,force:true});});
 return {root,userData,executable,databaseId,logFile,hosts,routes,setSupport:status=>writeFile(planFile,JSON.stringify({history:status}))};
}
async function requests(f){try{return (await readFile(f.logFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function start(f,options={}){
 const infoPath=join(f.userData,'managed/sqlite-backend.info');
 if(options.manual)await writeFile(join(f.root,'unused.env'),'NOTALONE_BACKGROUND_PROCESSING=manual\nNOTALONE_DEEPSEEK_API_KEY=\n',{mode:0o600});
 let nodeExecutable=process.execPath;
 if(options.manual){const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";nodeExecutable=join(f.root,'synthetic-node');await writeFile(nodeExecutable,`#!/bin/sh\nexec ${quote(process.execPath)} \"$@\" 2>> ${quote(join(f.root,'manual.stderr'))}\n`,{mode:0o700});}
 const host=await launchDsh({nodeExecutable,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:join(f.root,'unused.env'),infoPath,businessHome:f.root,environment:options.imageProcessing?{NOTALONE_IMAGE_PROCESSING:options.imageProcessing}:{},sqlite:{userData:f.userData,expectedDatabaseId:f.databaseId,role:'test',capabilities:options.memory?['contacts','history','memory']:['contacts','history'],wechatCliPath:f.executable}},()=>true);f.hosts.push(host);
 const info=await waitForHostReady(host,infoPath).catch(async error=>{if(options.manual)throw new Error(error.message+'; '+await readFile(join(f.root,'manual.stderr'),'utf8'));throw error;});
 const request=async(route,method='GET',body,headers={})=>{
  f.routes.push(route);const response=await fetch(`http://${info.address}`+route,{method,signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};
 };
 const runtime=await request('/api/runtime/status');assert.deepEqual(runtime.body.capabilities,options.memory?['contacts','history','memory']:['contacts','history']);
 return {host,request,shutdown:async()=>{assert.equal((await request('/api/runtime/shutdown','POST',{})).body.state,'stopped');assert.equal(await host.waitForExit(15000),true);}};
}
async function authorize(h,all=false){
 const setup=await h.request('/api/setup/status'),detected=await h.request('/api/setup/wechat/detect','POST',{});assert.equal(detected.status,200);assert.equal(detected.body.state,'ready');
 const connected=await h.request('/api/setup/wechat/confirm','POST',{candidate_token:detected.body.candidate_token,confirmed:true,mode:'selected',history_authorized:true});assert.equal(connected.status,200);
 const candidates=await h.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'});assert.equal(candidates.status,200);
 const row=candidates.body.sessions.find(row=>row.username===conversation);
 const confirmed=await h.request('/api/sync/cli-bindings/confirm','POST',{snapshot_token:candidates.body.snapshot_token,selections:(all?candidates.body.sessions:[row]).map(item=>({locator:item.username,observed_display_name:item.display_name,expected_selection_generation:item.selection_generation})),history_authorized:true});assert.equal(confirmed.status,200);
 const selected=await h.request('/api/sync/cli-bindings');assert.equal(selected.body.bindings.length,all?2:1);
 return {ownerId:setup.body.owner_id,contactId:selected.body.bindings[0].contact_id,bindings:selected.body.bindings};
}
async function coverage(h,contactId,predicate){return ready(async()=>{const response=await h.request('/api/sync/status');assert.equal(response.status,200);return response.body;},status=>predicate(status.cli_history_coverages.find(row=>row.contact_id===contactId)),'synthetic_first_history_timeout');}
function noCliOrphans(rows){for(const pid of new Set(rows.map(row=>row.pid)))assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}

test('正式launchDsh/profile通过HTTP授权自动首次capture，无手动sync且body仍不可用',{timeout:45000},async t=>{
 const f=await fixture(t),h=await start(f),selected=await authorize(h);
 assert.equal((await h.request(`/api/contacts/${selected.contactId}/history-messages`)).body.messages.length,0);assert.equal((await requests(f)).some(row=>row.op==='target'||row.op==='page'),false);
 assert.equal((await h.request('/api/sync/enable','POST',{})).status,200);
 const status=await coverage(h,selected.contactId,row=>row?.phase==='complete');assert.equal(status.body_available,false);assert.equal(status.cli_backfill_total_message_count,1);
 const messages=await h.request(`/api/contacts/${selected.contactId}/history-messages`);assert.equal(messages.body.messages.length,1);assert.equal(messages.body.messages[0].text,'仅合成的启动首次历史');assert.equal(messages.body.messages[0].source_record_ids.length,1);
 const persisted=await h.request(`/api/contacts/${selected.contactId}/history`);assert.equal(persisted.body.phase,'complete');assert.equal(persisted.body.pageCount,1);assert.ok(persisted.body.goalId);
 const rows=await requests(f);assert.equal(new Set(rows.map(row=>row.pid)).size,1);assert.ok(rows.some(row=>row.op==='metadata-account'));assert.ok(rows.some(row=>row.op==='metadata-sessions'));assert.ok(rows.filter(row=>row.op==='resolve').every(row=>row.displayName===conversation));assert.deepEqual(rows.filter(row=>['target','page'].includes(row.op)).map(row=>row.op),['target','page']);assert.ok(f.routes.every(route=>!route.endsWith('/history/sync')));
 await h.shutdown();noCliOrphans(await requests(f));
});

test('正式appReady按持久开关首次派发，未知支持保持缺口且零target/page',{timeout:60000},async t=>{
 for(const support of ['supported','unverified'])await t.test(support,async t=>{
  const f=await fixture(t),initial=await start(f),selected=await authorize(initial);
  const before=await initial.request(`/api/contacts/${selected.contactId}/history`);assert.equal(before.body.phase,'not_started');assert.equal(before.body.goalId,null);assert.equal((await initial.request('/api/sync/status')).body.sync_enabled,false);assert.equal((await initial.request(`/api/contacts/${selected.contactId}/history-messages`)).body.messages.length,0);
  await initial.shutdown();assert.equal((await requests(f)).some(row=>row.op==='target'||row.op==='page'),false);
  // 只安排重启条件：正式联系人服务持久开启读取，不写goal、capture或message。
  const storage=await SqliteStorage.open({userData:f.userData,intent:'open',expectedDatabaseId:f.databaseId,role:'test'}),contacts=new SqliteContactService(storage,selected.ownerId,createWechatContactMetadata(f.executable));
  try{await contacts.setReading(true);const empty=await storage.execute('history.coverage',{ownerId:selected.ownerId,contactId:selected.contactId});assert.equal(empty.phase,'not_started');assert.equal(empty.goalId,null);assert.equal(empty.messageCount,0);}finally{await contacts.close();await storage.close();}
  await f.setSupport(support);const offset=(await requests(f)).length,reopened=await start(f);
  const status=await coverage(reopened,selected.contactId,row=>support==='supported'?row?.phase==='complete':row?.phase==='not_started'&&row.failure_code==='history_message_state_unverified');assert.equal(status.body_available,false);
  const messages=await reopened.request(`/api/contacts/${selected.contactId}/history-messages`),newRows=(await requests(f)).slice(offset);
  if(support==='supported'){assert.equal(messages.body.messages.length,1);assert.equal(messages.body.messages[0].text,'仅合成的启动首次历史');assert.deepEqual(newRows.filter(row=>['target','page'].includes(row.op)).map(row=>row.op),['target','page']);}
  else{assert.deepEqual(messages.body.messages,[]);assert.equal(status.cli_backfill_phase,'incomplete');assert.equal(newRows.some(row=>row.op==='target'||row.op==='page'),false);assert.equal((await reopened.request(`/api/contacts/${selected.contactId}/history`)).body.goalId,null);}
  assert.ok(newRows.some(row=>row.op==='resolve'));assert.ok(newRows.some(row=>row.op==='support'));assert.ok(f.routes.every(route=>!route.endsWith('/history/sync')));await reopened.shutdown();noCliOrphans(await requests(f));
 });
});


test('manual正式profile不自动派发历史或记忆，重启后仍只执行具名单联系人请求',{timeout:45000},async t=>{
 const f=await fixture(t),h=await start(f,{manual:true,memory:true}),selected=await authorize(h);
 assert.equal((await h.request('/api/runtime/status')).body.background_processing,'manual');
 assert.equal((await h.request('/api/sync/enable','POST',{})).status,200);
 assert.equal((await h.request(`/api/contacts/${selected.contactId}/history`)).body.phase,'not_started');
 assert.equal((await h.request('/api/memory-processing/runs/current')).body,null);
 assert.equal((await requests(f)).some(row=>row.op==='target'||row.op==='page'),false,'开启读取不唤醒后台控制器');
 const synced=await h.request(`/api/contacts/${selected.contactId}/history/sync`,'POST',{});assert.equal(synced.status,200);
 assert.equal((await h.request(`/api/contacts/${selected.contactId}/history-messages`)).body.messages.length,1);
 assert.equal((await h.request('/api/memory-processing/runs/current')).body,null,'手动同步成功也不自动提取');
 // manual只控制宿主自动派发；显式处理仍须先通过产品默认关闭的记忆总开关。
 assert.deepEqual((await h.request('/api/memory-processing/automatic')).body,{enabled:false});
 const disabled=await h.request(`/api/memory-processing/contacts/${selected.contactId}/history`,'POST',{request_key:randomUUID()});assert.equal(disabled.status,409);assert.equal(disabled.body.error,'memory_auto_processing_disabled');
 assert.deepEqual((await h.request('/api/memory-processing/automatic','POST',{enabled:true})).body,{enabled:true});
 assert.equal((await h.request('/api/memory-processing/runs/current')).body,null,'开启记忆总开关仍不自动派发manual宿主');
 const started=await h.request(`/api/memory-processing/contacts/${selected.contactId}/history`,'POST',{request_key:randomUUID()});assert.equal(started.status,200,JSON.stringify(started.body));
 assert.ok(started.body.run.inputs.every(input=>input.contactId===selected.contactId));
 const blocked=await ready(async()=>h.request(`/api/memory-processing/runs/${started.body.run.runId}`),value=>value.body.status==='blocked'||value.body.status==='paused','synthetic_manual_memory_unconfigured');
 const continued=await h.request(`/api/memory-processing/runs/${started.body.run.runId}/continue`,'POST',{action_version:blocked.body.controlVersion,operation_id:randomUUID()});assert.equal(continued.status,200);assert.ok(continued.body.inputs.every(input=>input.contactId===selected.contactId));
 await ready(async()=>h.request(`/api/memory-processing/runs/${started.body.run.runId}`),value=>value.body.status==='blocked'||value.body.status==='paused','synthetic_manual_continue_unconfigured');
 await h.shutdown();const offset=(await requests(f)).length,reopened=await start(f,{manual:true,memory:true});
 assert.equal((await reopened.request('/api/runtime/status')).body.background_processing,'manual');
 assert.equal((await requests(f)).slice(offset).some(row=>row.op==='target'||row.op==='page'),false,'重启不恢复后台历史');
 const old=(await reopened.request(`/api/memory-processing/runs/${started.body.run.runId}`)).body;
 assert.ok(old.inputs.every(input=>input.contactId===selected.contactId));assert.equal(old.calls.prepared+old.calls.sending+old.calls.succeeded+old.calls.unknown,0,'模型未配置时零外部调用');
 await reopened.shutdown();noCliOrphans(await requests(f));
});


test('正式profile可只自动处理全部已授权联系人图片，已保存的不重读且不启动历史页或记忆',{timeout:45000},async t=>{
 const f=await fixture(t,{images:true}),initial=await start(f,{imageProcessing:'manual'}),selected=await authorize(initial,true);
 assert.equal((await initial.request('/api/sync/enable','POST',{})).status,200);
 const messages=[];
 for(const binding of selected.bindings){
  await coverage(initial,binding.contact_id,row=>row?.phase==='complete');
  const rows=(await initial.request(`/api/contacts/${binding.contact_id}/history-messages`)).body.messages;assert.equal(rows.length,1);assert.equal(rows[0].message_type,'image');
  messages.push({contactId:binding.contact_id,messageId:rows[0].message_id});
 }
 const old=messages[0],seed=await initial.request(`/api/contacts/${old.contactId}/messages/${old.messageId}/media`,'POST',{request_key:randomUUID(),goal:'extract'});
 assert.equal(seed.status,200,seed.body.error);assert.equal(seed.body.files.length,1);
 await initial.shutdown();const before=(await requests(f)).length;
 const restarted=await start(f,{manual:true,memory:true,imageProcessing:'automatic'});
 const runtime=(await restarted.request('/api/runtime/status')).body;assert.equal(runtime.background_processing,'manual');assert.equal(runtime.image_processing,'automatic');assert.equal(runtime.ownership.mediaExtraction,'typescript');assert.deepEqual(Object.keys(runtime.image_sync).sort(),['checked','failed','last_failure_code','processing']);
 for(const item of messages){
  const saved=await ready(async()=>(await restarted.request(`/api/contacts/${item.contactId}/history-messages?limit=20`)).body.messages?.find(row=>row.message_id===item.messageId),row=>row?.image_media?.state==='available','synthetic_automatic_image_timeout').catch(async error=>{throw new Error(error.message+' '+JSON.stringify((await restarted.request(`/api/contacts/${item.contactId}/messages/${item.messageId}/media`)).body)+' '+JSON.stringify((await restarted.request('/api/runtime/status')).body.image_sync));});
  assert.equal(saved.image_media.state,'available');
 }
 // 图片发布先于extract的释放、清理和最终回读；available不代表协调器已结算计数。
 const progress=await ready(async()=>(await restarted.request('/api/runtime/status')).body.image_sync,row=>row?.processing===false,'synthetic_automatic_image_drain_timeout');
 const rows=(await requests(f)).slice(before);assert.equal(rows.filter(row=>row.op==='image-open').length,1);assert.equal(rows.some(row=>row.op==='page'),false);
 assert.equal(progress.checked,1);assert.equal(progress.failed,0);assert.equal(progress.last_failure_code,null);
 assert.equal((await restarted.request('/api/ledger/summary')).body.total_calls,0);
 await restarted.shutdown();noCliOrphans(await requests(f));
});


test('正式宿主原地恢复完成不擅自清理未登记的旧副本',{timeout:45000},async t=>{
 const f=await fixture(t,{recovery:true}),initial=await start(f,{manual:true}),selected=await authorize(initial);
 await initial.request('/api/sync/enable','POST',{});
 assert.equal((await initial.request(`/api/contacts/${selected.contactId}/history/sync`,'POST',{})).status,200);
 await initial.shutdown();
 // 仅构造历史已存在的旧绑定和无引用消息。
 const file=join(f.userData,'managed/sqlite/notalone.sqlite'),db=new DatabaseSync(file);
 const binding=db.prepare("SELECT * FROM conversation_binding WHERE contact_id=? AND state='verified'").get(selected.contactId),message=db.prepare('SELECT * FROM message WHERE contact_id=?').get(selected.contactId),oldBinding=randomUUID(),oldMessage=randomUUID();
 const insert=(table,row)=>db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 insert('conversation_binding',{...binding,id:oldBinding,state:'revoked'});
 insert('message',{...message,id:oldMessage,binding_id:oldBinding,display_no:message.display_no+1});
 db.prepare("UPDATE source_proof SET state='needs_confirmation',reason='history_source_continuity_unverified' WHERE contact_id=?").run(selected.contactId);
 db.close();
 const restored=await start(f,{manual:true});
 const completed=await restored.request(`/api/contacts/${selected.contactId}/history/sync`,'POST',{});
 assert.equal(completed.status,200,JSON.stringify(completed.body));
 // 正式关闭等待宿主已派发工作排空，然后离线核对旧副本与删除账本。
 await restored.shutdown();
 const after=new DatabaseSync(file,{readOnly:true});
 try{
  assert.equal(after.prepare('SELECT count(*) n FROM message WHERE id=?').get(oldMessage).n,1,'恢复没有删除旧副本');
  assert.equal(after.prepare("SELECT count(*) n FROM deletion_operation WHERE scope_kind='superseded_history'").get().n,0,'恢复没有发起存量清理');
  assert.equal(after.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='history_superseded_cleanup'").get().n,0);
  assert.equal(after.prepare('SELECT count(*) n FROM conversation_binding WHERE contact_id=?').get(selected.contactId).n,2);
 }finally{after.close();}
 noCliOrphans(await requests(f));
});
