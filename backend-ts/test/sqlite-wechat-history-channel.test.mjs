import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { createWechatHistoryChannel } from '../src/history/sqlite/wechat-channel.ts';
import {SharedWechatClient} from '../src/history/wechat/shared-client.ts';
import {loadNarrowWechatOptions} from '../src/history/wechat/artifacts.ts';
import { NarrowWechatClient } from '../src/history/wechat/native-client.ts';
import { SqliteHistoryClearService } from '../src/history/sqlite/clear.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const owner='00000000-0000-4000-8000-000000000091',account='synthetic-owner',conversation='synthetic-friend',generation='a'.repeat(64);
const statusCapabilityKeys=['programVersion','exactSchema','declaredLocalKey','automaticAllocation','serverIdUniqueConstraint','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory'];
const capabilities=extra=>Object.fromEntries([...statusCapabilityKeys,...Object.keys(extra)].map(key=>[key,extra[key]??'unverified']));
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest:hash(`${account}\0${conversation}`),sourceGeneration:generation,schemaFingerprint:'b'.repeat(64),
 tables:[{target:'c'.repeat(64),partition:'d'.repeat(64),role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:'2'}],checkedPartitions:['d'.repeat(64)]};
async function fixture(t,sharedMode=false,storageOptions={},contactCount=2){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-wechat-channel-'))),artifact=join(root,'artifact');
 await mkdir(join(artifact,'bin'),{recursive:true});await mkdir(join(artifact,'lib'));await mkdir(join(root,'state'));
 const executable=join(artifact,'bin','wx-cli'),manifestPath=join(artifact,'manifest.json'),planFile=join(root,'plan'),logFile=join(root,'requests'),pidFile=join(root,'pid');
 await writeFile(planFile,JSON.stringify({mode:'supported',serverId:'0'}));
 const script=`#!${process.execPath}
 const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
 const schema=${JSON.stringify(schema)},planFile=${JSON.stringify(planFile)},logFile=${JSON.stringify(logFile)};
 let resumed=false,tailSerial=2,targetSerial=0,currentTarget=null,selected='${conversation}',sliceIndex=0,sliceCursor=null;
 const checkpointFile=${JSON.stringify(join(root,'slice-checkpoints'))};
 fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
 if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line),plan=JSON.parse(fs.readFileSync(planFile));fs.appendFileSync(logFile,JSON.stringify(r)+'\\n');let data;
  if(['page','quarantine-page','tail'].includes(r.op)&&r.target!==currentTarget){process.stdout.write(JSON.stringify({ok:false,error:{code:'history_target_unverified'}})+'\\n');return;}
  if(r.op==='resolve'){selected=r.displayName;schema.scopeDigest=crypto.createHash('sha256').update('${account}\\0'+selected).digest('hex');}
  if(r.op==='release-selection'&&plan.mode==='release-blocked')return;
  if(r.op==='release-selection'&&plan.mode==='release-fail'){process.stdout.write(JSON.stringify({ok:false,error:{code:'history_account_changed'}})+'\\n');return;}
  if(r.op==='release-selection'){currentTarget=null;data={released:true};}
  else if(r.op==='resolve')data={accountKey:plan.mode==='wrong-account'?'synthetic-other':'${account}',conversationKey:plan.mode==='wrong-conversation'?'synthetic-other':selected,displayName:'只作展示',sourceGeneration:plan.mode==='wrong-generation'?'f'.repeat(64):'${generation}'};
  else if(r.op==='inspect')data=schema;
  else if(r.op==='support')data={protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:['unverified','quarantine','quarantine-forged'].includes(plan.mode)?'unverified':'supported',reason:['unverified','quarantine','quarantine-forged'].includes(plan.mode)?'history_message_state_unverified':null,accountKey:'${account}',conversationKey:selected,sourceGeneration:'${generation}',programVersion:'synthetic',build:'1',artifactSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),schemaFingerprint:schema.schemaFingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-final',continuity:${sharedMode?"'same-source-instances-normal-use-v1'":"'synthetic-fixed-source'"},...(plan.capabilities?{capabilities:plan.capabilities}:plan.mode.startsWith('quarantine')?{capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','serverIdUniqueConstraint','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory'].map(k=>[k,['programVersion','exactSchema','declaredLocalKey'].includes(k)?'supported':'unverified']))}:{})};
  else if((r.op==='target'||r.op==='quarantine-target'||r.op==='resume-target')){resumed=r.op==='resume-target';currentTarget=${sharedMode?"'synthetic-target-'+(++targetSerial)":"'synthetic-target'"};
   if(plan.mode==='slices'){
    const checkpoints=fs.existsSync(checkpointFile)?JSON.parse(fs.readFileSync(checkpointFile)):{};
    const checkpoint=resumed?checkpoints[r.cursor]:null;
    if(resumed&&(!checkpoint||checkpoint.conversation!==selected||checkpoint.target!==r.target)){process.stdout.write(JSON.stringify({ok:true,data:null})+'\\n');return;}
    sliceIndex=checkpoint?.index||0;sliceCursor=null;currentTarget+='-'+process.pid;
   }
   data={protocol:'private-history-v1',descriptor:currentTarget,partitions:schema.checkedPartitions,tables:[{partition:'d'.repeat(64),instance:'c'.repeat(64)}],sourceGeneration:'${generation}'};}
  else if((r.op==='page'||r.op==='quarantine-page')){
   if(plan.mode==='blocked')return;
   const row={partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:plan.serverId,sender:'contact',kind:'text',text:${sharedMode?"'合成历史正文:'+selected":"'合成历史正文'"},originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,status:'0',stateAssurance:plan.mode==='quarantine'?'unverified':'verified'};
   data={target:r.target,cursorIn:r.cursor||null,cursorOut:null,records:[row,{...row,localId:'2',serverId:'0',kind:'voice',text:plan.mode==='malicious'?'forbidden-body':null,originalType:'34'}],completedPartitions:schema.checkedPartitions,exhausted:true,...(plan.resumeCursor?{resumeCursor:plan.resumeCursor}:{})};
   if(resumed)data.records=plan.resumeRows||[];else data.records.push(...(plan.extraRows||[]));
   if(plan.mode==='slices'){
    if((r.cursor||null)!==sliceCursor){process.stdout.write(JSON.stringify({ok:false,error:{code:'history_cursor_invalid'}})+'\\n');return;}
    const index=++sliceIndex,exhausted=index>=(selected==='${conversation}'?80:1),proof=currentTarget+'.proof-'+index;
    if(r.checkpoint||exhausted){const checkpoints=fs.existsSync(checkpointFile)?JSON.parse(fs.readFileSync(checkpointFile)):{};checkpoints[proof]={conversation:selected,target:currentTarget,index};fs.writeFileSync(checkpointFile,JSON.stringify(checkpoints));}
    sliceCursor=exhausted?null:currentTarget+'.session-'+index;
    data={target:r.target,cursorIn:r.cursor||null,cursorOut:sliceCursor,records:[{...row,localId:String(index),text:'合成片段:'+selected+':'+index}],completedPartitions:exhausted?schema.checkedPartitions:[],exhausted,...(exhausted?{resumeCursor:proof}:r.checkpoint?{checkpointCursor:proof}:{})};
   }
  }else if(r.op==='tail')data={target:r.target,cursorIn:r.cursor,cursorOut:plan.tailCursorOut||'tail-'+tailSerial++,records:plan.tailRows||[],caughtUp:true,...(plan.tailExtra?{unexpectedBody:'forbidden'}:{})};
  else if(r.op==='boundary-snapshot'){
   data={format:'wechat-history-boundary-v1',scopeDigest:schema.scopeDigest,sourceGeneration:schema.sourceGeneration,schemaFingerprint:schema.schemaFingerprint,
    target:{protocol:'private-history-v1',descriptor:'synthetic-target',partitions:schema.checkedPartitions,tables:[{partition:'d'.repeat(64),instance:'c'.repeat(64)}],sourceGeneration:schema.sourceGeneration},
    boundaryToken:'synthetic-boundary-token',members:[{partition:'d'.repeat(64),table:'c'.repeat(64),localId:'1'}],
    partitions:[{partition:'d'.repeat(64),instance:'c'.repeat(64),preSample:'sample-before',postSample:plan.boundaryMismatch?'sample-after':'sample-before',readerCompleted:true,memberCount:1}],
    namespaceContinuity:true,instanceContinuity:true,observedAt:'2026-10-30T00:00:00.000Z',...(plan.boundaryExtra?{messageContent:'forbidden'}:{})};
  }else process.exit(92);
  process.stdout.write(JSON.stringify({ok:true,data})+'\\n');
 });
`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-channel-WCDB');await writeFile(join(artifact,'lib','libWCDB.dylib'),wcdb);
 const manifest={formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',cliSha256:hash(script),wcdbSha256:hash(wcdb),signing:'ad-hoc-development',realWechatVerified:false};
 await writeFile(manifestPath,JSON.stringify(manifest));
 const storage=await SqliteStorage.open({userData:join(root,'state'),intent:'create',role:'test',...storageOptions});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({externalKey:account,identityScheme:'wechat.account.v1',sourceGeneration:generation,assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[conversation,...(sharedMode?Array.from({length:contactCount-1},(_,index)=>index===0?'synthetic-second':`synthetic-friend-${index+2}`):[])].map(externalKey=>({externalKey,displayName:externalKey,kind:'private',identityAssurance:'verified'}))});
 await contacts.initialize();const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})));
 const shared=sharedMode?new SharedWechatClient(()=>loadNarrowWechatOptions(executable)):undefined;
 const channels=[],bindings=(await contacts.directory()).bindings,binding=bindings[0],history=new SqliteHistoryService(storage,contacts,()=>{const channel=createWechatHistoryChannel(executable,undefined,shared);channels.push(channel);return channel;},undefined,undefined,undefined,shared);
 t.after(async()=>{await history.close();await shared?.close();await contacts.close();await storage.close();await rm(root,{recursive:true,force:true});});
 const scope=()=>contacts.eligibility(binding.contact_id).then(token=>({token,accountKey:account,conversationKey:conversation}));
 return {root,artifact,executable,manifestPath,manifest,planFile,logFile,pidFile,storage,contacts,history,binding,bindings,scope,channels,shared,setPlan:plan=>writeFile(planFile,JSON.stringify({mode:'supported',serverId:'0',...plan}))};
}
async function requests(file){try{return (await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
function noProcess(pid){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
async function waitForOperation(file,operation){return new Promise((resolve,reject)=>{
 const check=()=>requests(file).then(rows=>{if(rows.some(row=>row.op===operation)){clearTimeout(timer);watcher.close();resolve();}});
 const watcher=watch(join(file,'..'),check),timer=setTimeout(()=>{watcher.close();reject(new Error('synthetic_operation_missing'));},5000);check();
});}
const waitForPage=file=>waitForOperation(file,'page');

test('正式共享子进程有界让出并在进程重启后接续已接受历史片段',async t=>{
 const f=await fixture(t,true),large=f.bindings.find(row=>row.conversation_locator===conversation),other=f.bindings.find(row=>row.contact_id!==large.contact_id);
 await f.setPlan({mode:'slices',capabilities:capabilities({...Object.fromEntries(statusCapabilityKeys.map(key=>[key,'supported'])),incrementalTail:'supported',durableIncremental:'supported',durableHistory:'supported'})});
 const [first,small]=await Promise.all([f.history.synchronize(large.contact_id),f.history.synchronize(other.contact_id)]);
 assert.equal(first.phase,'running');assert.equal(first.failureCode,null);assert.ok(first.pageCount>0&&first.pageCount<=32);assert.equal(small.phase,'complete');
 const oldPid=Number(await readFile(f.pidFile,'utf8'));await f.history.stop();await f.shared.stop();noProcess(oldPid);
 let latest=first;for(let attempt=0;attempt<10&&latest.phase!=='complete';attempt++)latest=await f.history.synchronize(large.contact_id);
 assert.equal(latest.phase,'complete');assert.equal((await f.history.read(large.contact_id)).coverage.messageCount,80);
 assert.notEqual(Number(await readFile(f.pidFile,'utf8')),oldPid);
 const rows=await requests(f.logFile),pages=rows.filter(row=>row.op==='page'&&row.conversation===conversation);
 assert.equal(pages.length,80);assert.ok(pages.some(row=>row.checkpoint===true));
 assert.equal(rows.filter(row=>row.op==='target'&&row.conversation===conversation).length,1,'重启不能退回完整历史');
 assert.ok(rows.filter(row=>row.op==='resume-target').every(row=>row.cursor.includes('.proof-')),'会话内分页游标不可冒充持久检查点');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正式受控渠道驱动联系人历史服务入库，非文字空正文且serverId补齐保留消息身份',async t=>{
 const f=await fixture(t),contact=f.binding.contact_id;assert.deepEqual((await f.history.read(contact)).messages,[]);
 assert.equal((await f.history.synchronize(contact)).phase,'complete');const before=(await f.history.read(contact)).messages;
 assert.equal(before.length,2);assert.equal(before.find(row=>row.kind==='voice').text,null);const text=before.find(row=>row.kind==='text');assert.equal(text.text,'合成历史正文');
 const source=await f.history.source(contact,text.sourceRecordIds[0]);assert.equal(source.raw.serverId,'0');assert.equal(source.support.serverAliasSemantics,'unverified');
 await f.setPlan({serverId:'9223372036854775807'});assert.equal((await f.history.synchronize(contact)).phase,'complete');
 const after=(await f.history.read(contact)).messages;assert.equal(after.length,2);assert.equal(after.find(row=>row.kind==='text').id,text.id);assert.equal(after.find(row=>row.kind==='text').sourceRecordIds.length,1,'同一来源重复观察不再累计来源记录');
 const rows=await requests(f.logFile);assert.ok(rows.filter(row=>row.op==='resolve').every(row=>row.displayName===conversation));
 assert.deepEqual(rows.slice(0,4).map(row=>row.op),['resolve','inspect','support','target']);
 const pid=Number(await readFile(f.pidFile,'utf8'));assert.equal(f.channels.length,1);assert.doesNotThrow(()=>process.kill(pid,0));
 await f.history.stop(contact);noProcess(pid);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正式历史终页游标交接到同scope增量尾部并原子写入更新与新消息',async t=>{
 const f=await fixture(t),contact=f.binding.contact_id;
 await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'})});
 assert.equal((await f.history.synchronize(contact)).phase,'complete');
 const before=(await f.history.read(contact)).messages.find(message=>message.kind==='text');assert.equal(before.status,'0');
 await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'}),tailRows:[
  {partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:'77',sender:'contact',kind:'text',text:'合成历史正文',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,status:'2',stateAssurance:'verified'},
  {partition:'d'.repeat(64),table:'c'.repeat(64),localId:'3',serverId:'0',sender:'contact',kind:'text',text:'合成增量新消息',originalType:'1',sentAt:'1700000001000',timePrecision:'second',orderScheme:null,orderKey:null,status:'3',stateAssurance:'verified'}]});
 const coverage=await f.history.synchronizeIncremental(contact);assert.equal(coverage.incremental.phase,'ready');assert.equal(coverage.incremental.pagesAccepted,1);
 const after=(await f.history.read(contact)).messages,texts=after.filter(message=>message.kind==='text');
 assert.equal(after.length,3);assert.equal(texts.length,2);assert.equal(texts.find(message=>message.id===before.id).status,'2');assert.ok(texts.some(message=>message.text==='合成增量新消息'));
 const rows=await requests(f.logFile);assert.equal(rows.filter(row=>row.op==='resolve').length,1);assert.equal(rows.filter(row=>row.op==='target').length,1);
 const tail=rows.find(row=>row.op==='tail');assert.ok(tail);assert.equal(tail.consent,'selected-history-v1');assert.equal(tail.account,account);assert.equal(tail.conversation,conversation);assert.equal(tail.target,'synthetic-target');assert.equal(tail.cursor,'tail-1');
 assert.equal(f.channels.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});await f.history.stop(contact);
});

test('增量消失记录的未知墓碑隔离旧文字并降低历史覆盖资格',async t=>{
 const f=await fixture(t),contact=f.binding.contact_id;
 await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'})});
 assert.equal((await f.history.synchronize(contact)).phase,'complete');
 const before=(await f.history.read(contact)).messages.find(message=>message.kind==='text');
 assert.ok(before);assert.equal(before.text,'合成历史正文');
 const source=await f.history.source(contact,before.sourceRecordIds[0]);
 assert.equal(source.raw.localId,'9007199254740993');assert.equal(source.raw.stateAssurance,'verified');

 await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'}),tailCursorOut:'tail-2',tailRows:[
  {partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:'0',sender:'unknown',kind:'other',text:null,originalType:'unknown',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,status:null,stateAssurance:'unverified'}]});
 const coverage=await f.history.synchronizeIncremental(contact);
 const after=await f.history.read(contact);
 assert.equal(after.messages.some(message=>message.id===before.id||message.text==='合成历史正文'),false);
 assert.equal(after.messages.length,1);assert.equal(after.messages[0].kind,'voice');
 assert.equal(after.replyEligibility,'history_incomplete');
 assert.equal(coverage.phase,'incomplete');assert.equal(coverage.failureCode,'history_identity_quarantined');
 assert.equal(coverage.messageCount,1);assert.equal(coverage.quarantinedCount,1);
 assert.equal(coverage.incremental.phase,'incomplete');assert.equal(coverage.incremental.failureCode,'history_identity_quarantined');
 await assert.rejects(f.history.source(contact,before.sourceRecordIds[0]),{code:'history_source_not_found'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});await f.history.stop(contact);
});

test('增量上一页可经原生复验后重放，改变的缓存响应拒绝且旧游标不跨页恢复',async t=>{
 const f=await fixture(t),channel=createWechatHistoryChannel(f.executable),scope=await f.scope();
 await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'}),tailCursorOut:'tail-2'});
 await channel.inspect(scope);const target=await channel.target(scope);await channel.page(scope,target,null);
 const first=await channel.tail(scope,target,'tail-1');assert.deepEqual(await channel.tail(scope,target,'tail-1'),first);
 assert.equal((await requests(f.logFile)).filter(request=>request.op==='tail').length,2);
 await assert.rejects(channel.tail(scope,target,'never-issued'),{code:'history_cursor_invalid'});
 assert.equal((await requests(f.logFile)).filter(request=>request.op==='tail').length,2);
 await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'}),tailCursorOut:'tail-changed'});
 await assert.rejects(channel.tail(scope,target,'tail-1'),{code:'history_protocol_invalid'});
 await channel.close();noProcess(Number(await readFile(f.pidFile,'utf8')));
});

test('增量能力未认证时正式渠道不发送tail RPC',async t=>{
 const f=await fixture(t),channel=createWechatHistoryChannel(f.executable),scope=await f.scope();await f.setPlan({capabilities:capabilities({incrementalTail:'unverified'})});
 await channel.inspect(scope);const target=await channel.target(scope);
 await assert.rejects(channel.tail(scope,target,'synthetic-tail-cursor'),{code:'history_tail_unsupported'});
 assert.equal((await requests(f.logFile)).some(request=>request.op==='tail'),false);await channel.close();noProcess(Number(await readFile(f.pidFile,'utf8')));
});

test('正式渠道边界接口验证支持并返回完整候选与计算后的manifest',async t=>{
 const f=await fixture(t),channel=createWechatHistoryChannel(f.executable),scope=await f.scope();
 await f.setPlan({capabilities:capabilities({'private-history-boundary-v1':'supported'})});
 const report=await channel.inspect(scope);assert.equal(report.capabilities['private-history-boundary-v1'],'supported');
 const candidate=await channel.boundarySnapshot(scope);assert.equal(candidate.protocol,'private-history-boundary-v1');assert.equal(candidate.support.capabilities['private-history-boundary-v1'],'supported');
 assert.deepEqual(candidate.members,[{partition:'d'.repeat(64),table:'c'.repeat(64),localId:'1'}]);assert.equal(candidate.partitions[0].readerCompleted,true);
 assert.match(candidate.manifestSha256,/^[a-f0-9]{64}$/);assert.equal(candidate.boundaryToken,'synthetic-boundary-token');
 const row=(await requests(f.logFile)).find(request=>request.op==='boundary-snapshot');assert.ok(row);assert.equal(row.consent,'selected-history-boundary-v1');assert.equal(row.account,account);assert.equal(row.conversation,conversation);assert.equal('target' in row,false);
 await channel.close();noProcess(Number(await readFile(f.pidFile,'utf8')));
});

test('边界能力未认证时正式清空保持boundary_pending且零boundary RPC',async t=>{
 const f=await fixture(t),contact=f.binding.contact_id;await f.setPlan({capabilities:capabilities({'private-history-boundary-v1':'unverified'})});
 const deletion=new DeletionService(f.storage,f.history.holders,new ManagedFiles(join(f.root,'state')));
 const clear=new SqliteHistoryClearService(f.storage,f.contacts,()=>createWechatHistoryChannel(f.executable),deletion,f.history.holders);
 const status=await clear.clear(contact);assert.equal(status.phase,'boundary_pending');assert.equal(status.completed,false);assert.ok(status.boundary);
 assert.equal((await requests(f.logFile)).some(request=>request.op==='boundary-snapshot'),false);await f.history.close();
});

test('合成边界能力经正式渠道进入清空服务并持久化后完成SQLite清理',async t=>{
 const f=await fixture(t),contact=f.binding.contact_id;
 await f.setPlan({capabilities:capabilities({'private-history-boundary-v1':'supported'})});
 const deletion=new DeletionService(f.storage,f.history.holders,new ManagedFiles(join(f.root,'state')));
 const clear=new SqliteHistoryClearService(f.storage,f.contacts,()=>createWechatHistoryChannel(f.executable),deletion,f.history.holders);
 const status=await clear.clear(contact);assert.equal(status.phase,'completed');assert.equal(status.completed,true);
 assert.equal(status.boundary.state,'verified');assert.equal(status.boundary.memberCount,1);assert.match(status.boundary.manifestSha256,/^[a-f0-9]{64}$/);
 const boundary=(await requests(f.logFile)).find(request=>request.op==='boundary-snapshot');assert.ok(boundary);assert.equal(boundary.consent,'selected-history-boundary-v1');
 const stored=await f.storage.execute('history.cutoffStatus',{ownerId:owner,operationId:status.operationId});assert.equal(stored.state,'verified');assert.equal(stored.memberCount,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});await f.history.close();
});

test('正式渠道拒绝带额外字段的边界结果及超限tail，且坏页不入库',async t=>{
 {
  const f=await fixture(t),channel=createWechatHistoryChannel(f.executable),scope=await f.scope();
  await f.setPlan({capabilities:capabilities({'private-history-boundary-v1':'supported'}),boundaryExtra:true});await channel.inspect(scope);
  await assert.rejects(channel.boundarySnapshot(scope),{code:'history_protocol_invalid'});await channel.close();noProcess(Number(await readFile(f.pidFile,'utf8')));
 }
 {
  const f=await fixture(t),contact=f.binding.contact_id;
  await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'})});await f.history.synchronize(contact);
  const excessive=Array.from({length:17},(_,index)=>({partition:'d'.repeat(64),table:'c'.repeat(64),localId:String(index+10),serverId:'0',sender:'contact',kind:'text',text:'超限合成记录',originalType:'1',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,status:'3',stateAssurance:'verified'}));
  await f.setPlan({resumeCursor:'tail-1',capabilities:capabilities({incrementalTail:'supported'}),tailRows:excessive});
  await assert.rejects(f.history.synchronizeIncremental(contact),{code:'history_protocol_invalid'});assert.equal((await f.history.read(contact)).messages.length,2);
  const rows=await requests(f.logFile);assert.equal(rows.filter(request=>request.op==='tail').length,1);assert.equal(f.channels.length,1);noProcess(Number(await readFile(f.pidFile,'utf8')));
  await assert.rejects(f.history.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(f.channels.length,1);
 }
});

test('合成原生进程意外退出后，持久停读且不启动新进程',async t=>{
 const f=await fixture(t),contact=f.binding.contact_id;await f.history.synchronize(contact);
 const pid=Number(await readFile(f.pidFile,'utf8'));process.kill(pid,'SIGKILL');await f.channels[0].guardSession.loss;
 await assert.rejects(f.history.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(f.channels.length,1);noProcess(pid);
});

test('无显式制品保持unverified，manifest缺失/链接/过大或制品身份不符均不启动进程',async t=>{
 const absent=createWechatHistoryChannel();assert.equal((await absent.inspect({})).status,'unverified');await assert.rejects(absent.target({}),{code:'history_support_unverified'});await absent.close();
 for(const mode of ['missing','symlink','oversize','bad-hash','bad-source','executable-link','relative']){
  const f=await fixture(t);let executable=f.executable;
  if(mode==='missing')await rm(f.manifestPath);
  if(mode==='symlink'){const copy=join(f.root,'manifest-copy');await writeFile(copy,JSON.stringify(f.manifest));await rm(f.manifestPath);await symlink(copy,f.manifestPath);}
  if(mode==='oversize')await writeFile(f.manifestPath,' '.repeat(65537));
  if(mode==='bad-hash')await writeFile(f.manifestPath,JSON.stringify({...f.manifest,cliSha256:'0'.repeat(64)}));
  if(mode==='bad-source')await writeFile(f.manifestPath,JSON.stringify({...f.manifest,sourceCommit:'0'.repeat(40)}));
  if(mode==='executable-link'){executable=join(f.artifact,'bin','linked-cli');await symlink(f.executable,executable);}
  if(mode==='relative')executable='relative-cli';
  const expectedCode=mode==='missing'?'history_artifact_manifest_missing':'history_artifact_unverified';
  const channel=createWechatHistoryChannel(executable);await assert.rejects(channel.inspect(await f.scope()),error=>error.code===expectedCode&&error.message===error.code);await channel.close();
  await assert.rejects(readFile(f.pidFile),{code:'ENOENT'});
 }
});

test('账号/会话/来源逐项不符只resolve即关闭，实例不能复用其他联系人或资格token',async t=>{
 for(const [mode,code] of [['wrong-account','history_account_changed'],['wrong-conversation','history_scope_changed'],['wrong-generation','history_source_changed']]){
  const f=await fixture(t);await f.setPlan({mode});const channel=createWechatHistoryChannel(f.executable);
  await assert.rejects(channel.inspect(await f.scope()),{code});assert.deepEqual((await requests(f.logFile)).map(row=>row.op),['resolve']);
  noProcess(Number(await readFile(f.pidFile,'utf8')));await channel.close();
 }
 for(const key of ['contact_id','binding_id','grant_id','read_epoch','selection_generation','data_generation','verification_id','scope_revision','barrier_generation','identity_generation','source_generation','owner_id','account_id','conversation_id']){
  const f=await fixture(t),channel=createWechatHistoryChannel(f.executable),scope=await f.scope();await channel.inspect(scope);
  await assert.rejects(channel.inspect({...scope,token:{...scope.token,[key]:`${scope.token[key]}-changed`}}),{code:'history_scope_changed'});
  assert.deepEqual((await requests(f.logFile)).map(row=>row.op),['resolve','inspect','support']);noProcess(Number(await readFile(f.pidFile,'utf8')));await channel.close();
 }
});

test('未认证真实支持报告可诊断但不发target/page，恶意非文字正文拒绝入库',async t=>{
 const f=await fixture(t);await f.setPlan({mode:'unverified'});
 const channel=createWechatHistoryChannel(f.executable),scope=await f.scope(),report=await channel.inspect(scope);
 assert.equal(report.status,'unverified');assert.equal(report.reason,'history_message_state_unverified');
 await assert.rejects(channel.target(scope),{code:'history_support_unverified'});await assert.rejects(channel.page(scope,{},null),{code:'history_support_unverified'});await channel.close();
 assert.deepEqual((await requests(f.logFile)).map(row=>row.op),['resolve','inspect','support']);
 await f.setPlan({mode:'malicious'});await assert.rejects(f.history.synchronize(f.binding.contact_id),{code:'history_protocol_invalid'});
 assert.deepEqual((await f.history.read(f.binding.contact_id)).messages,[]);assert.equal((await f.history.coverage(f.binding.contact_id)).phase,'incomplete');noProcess(Number(await readFile(f.pidFile,'utf8')));
});

test('关闭或取消等待真实子进程退出，持久旧游标不伪装为当前snapshot',async t=>{
 for(const mode of ['close','abort']){
  const f=await fixture(t);await f.setPlan({mode:'blocked'});const channel=createWechatHistoryChannel(f.executable),scope=await f.scope();await channel.inspect(scope);const target=await channel.target(scope),controller=new AbortController();
  const pending=channel.page(scope,target,null,controller.signal),rejected=assert.rejects(pending,error=>['history_native_closed','history_native_cancelled'].includes(error.code));await waitForPage(f.logFile);
  if(mode==='close')await channel.close();else controller.abort();await rejected;noProcess(Number(await readFile(f.pidFile,'utf8')));await channel.close();
 }
 const f=await fixture(t),scope=await f.scope(),first=createWechatHistoryChannel(f.executable);await first.inspect(scope);const target=await first.target(scope);await first.close();
 const reopened=createWechatHistoryChannel(f.executable);await reopened.inspect(scope);await assert.rejects(reopened.page(scope,target,'old-process-cursor'),{code:'history_cursor_invalid'});await reopened.close();
 assert.equal((await requests(f.logFile)).filter(row=>row.op==='page').length,0);
});


test('隔离客户端保留未核验文字，普通历史仍拒绝且伪造认证记录被拒绝',async t=>{
 for(const mode of ['quarantine','quarantine-forged']){
  const f=await fixture(t);await f.setPlan({mode});
  const client=new NarrowWechatClient({executable:f.executable,expectedCliSha256:f.manifest.cliSha256,expectedWcdbSha256:f.manifest.wcdbSha256});t.after(()=>client.close());
  await client.resolveSelected(conversation);await client.inspectSelected();await client.supportSelected();
  await assert.rejects(client.targetSelected(),{code:'history_support_unverified'});
  const target=await client.quarantineTargetSelected();
  if(mode==='quarantine-forged'){await assert.rejects(client.quarantinePageSelected(target,null),{code:'history_protocol_invalid'});continue;}
  const result=await client.quarantinePageSelected(target,null);assert.equal(result.kind,'quarantine');
  assert.equal(result.page.records[0].text,'合成历史正文');assert.equal(result.page.records[0].stateAssurance,'unverified');assert.equal(result.page.records[1].text,null);
  await assert.rejects(client.targetSelected(),{code:'history_support_unverified'});
  await client.close();
  assert.equal((await f.history.read(f.binding.contact_id)).messages.length,0);
 }
});


test('共享历史进程串行同步两位联系人，切回重验且正文与来源保持隔离',async t=>{
 const f=await fixture(t,true),[a,b]=f.bindings;
 await f.history.synchronize(a.contact_id);const pid=Number(await readFile(f.pidFile,'utf8'));
 await f.history.synchronize(b.contact_id);await f.history.synchronize(a.contact_id);
 assert.equal(Number(await readFile(f.pidFile,'utf8')),pid);
 for(const binding of [a,b]){
  const read=await f.history.read(binding.contact_id);
  assert.equal(read.messages.length,2);
  assert.equal(read.messages.find(row=>row.kind==='text').text,'合成历史正文:'+binding.conversation_locator);
 }
 const rows=await requests(f.logFile);
 assert.deepEqual(rows.filter(row=>row.op==='resolve').map(row=>row.displayName),[a.conversation_locator,b.conversation_locator,a.conversation_locator]);
 assert.equal(rows.filter(row=>row.op==='release-selection').length,2);
 assert.equal((await f.history.coverage(a.contact_id)).phase,'complete');
 assert.equal((await f.history.coverage(b.contact_id)).phase,'complete');
 await f.history.stop();await f.shared.stop();noProcess(pid);
});

for(const contactCount of [8,32])test(`${contactCount}位联系人共享原生读取器并通过普通定时轮转持续保存后续消息，不停在被替换快照`, {timeout:30000}, async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const cleanup=[],f=await fixture({after:callback=>cleanup.push(callback)},true,{},contactCount);
 const calls={coverage:0,directory:0,syncDirectory:0},started=performance.now();
 for(const [target,method,label]of [[f.history,'coverage','coverage'],[f.contacts,'directory','directory'],[f.contacts,'syncDirectory','syncDirectory']]){const original=target[method].bind(target);target[method]=(...args)=>{calls[label]++;return original(...args);};}
 const directory={directory:()=>f.contacts.syncDirectory()};
 let first=new FirstHistoryCoordinator(directory,f.history);const initial=first,incremental=new IncrementalHistoryCoordinator(directory,f.history,{intervalMs:30_000,firstHistoryManagedExternally:true});
 f.history.setFirstHistoryWake(contactId=>first.wakeContact(contactId));
 t.after(async()=>{await incremental.close();await first.close();if(first!==initial)await initial.close();for(const callback of cleanup.reverse())await callback();});
 const caps=Object.fromEntries([...statusCapabilityKeys,'incrementalTail','durableIncremental'].map(key=>[key,'supported']));
 await f.setPlan({capabilities:caps,resumeCursor:'synthetic-resume'});
 first.wake();await first.waitForIdle();
 // 模拟启动时已经有complete持久覆盖；新协调器仍须按定点唤醒公平轮转。
 first=new FirstHistoryCoordinator(directory,f.history);first.wake();await first.waitForIdle();incremental.start();
 for(let round=1;round<=2;round++){
  const text=`合成轮转新消息${round}`;
  const resumeRows=[{partition:'d'.repeat(64),table:'c'.repeat(64),localId:String(10+round),serverId:'0',sender:'contact',kind:'text',text,originalType:'1',sentAt:String(1700000000000+round*1000),timePrecision:'second',orderScheme:null,orderKey:null,status:'0',stateAssurance:'verified'}];
  await f.setPlan({capabilities:caps,resumeCursor:'synthetic-resume',resumeRows,tailRows:resumeRows});
  t.mock.timers.tick(30_000);await incremental.waitForIdle();await first.waitForIdle();
  for(const binding of f.bindings){
   const result=await f.history.read(binding.contact_id);
   assert.equal(result.coverage.phase,'complete','切回联系人建立新目标后必须自动接续首次读取');
   assert.ok(result.messages.some(message=>message.text===text),'每一位已加入联系人都必须保存本轮消息');
   assert.equal(result.messages.filter(message=>message.text===text).length,1,'同一来源轮转不得重复入库');
  }
 }
 assert.equal((await requests(f.logFile)).filter(row=>row.op==='resolve').length>=contactCount*2,true,'多个正常tick实际轮转全部联系人');
 t.diagnostic(JSON.stringify({contacts:contactCount,elapsedMs:performance.now()-started,...calls}));
 assert.equal(calls.directory,0,'协调器不得为了授权目录反复统计聊天正文');
 assert.ok(calls.coverage<=contactCount*12,'定点唤醒不应随联系人数量平方放大覆盖查询');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('32位联系人真实重开SQLite后首次与增量同时启动，严格新目标下连续两轮保存并去重', {timeout:30000}, async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const cleanup=[],f=await fixture({after:callback=>cleanup.push(callback)},true,{},32);
 const caps=Object.fromEntries([...statusCapabilityKeys,'incrementalTail','durableIncremental'].map(key=>[key,'supported']));
 await f.setPlan({capabilities:caps,resumeCursor:'synthetic-resume'});
 const initial=new FirstHistoryCoordinator({directory:()=>f.contacts.syncDirectory()},f.history);
 let storage,contacts,shared,history,first,incremental;
 t.after(async()=>{await incremental?.close();await first?.close();await history?.close();await shared?.close();await contacts?.close();await storage?.close();await initial.close();for(const callback of cleanup.reverse())await callback();});
 initial.wake();await initial.waitForIdle();await initial.close();await f.history.close();await f.shared.close();await f.contacts.close();await f.storage.close();
 storage=await SqliteStorage.open({userData:join(f.root,'state'),intent:'open',expectedDatabaseId:f.storage.status.databaseId,role:'test'});
 contacts=new SqliteContactService(storage,owner,{account:async()=>{throw Error('不应重新确认账号');},sessions:async()=>{throw Error('不应扩大已选范围');}});
 await contacts.initialize();shared=new SharedWechatClient(()=>loadNarrowWechatOptions(f.executable));
 history=new SqliteHistoryService(storage,contacts,()=>createWechatHistoryChannel(f.executable,undefined,shared),undefined,undefined,undefined,shared);
 const directory={directory:()=>contacts.syncDirectory()};first=new FirstHistoryCoordinator(directory,history);incremental=new IncrementalHistoryCoordinator(directory,history,{intervalMs:30_000,firstHistoryManagedExternally:true});
 history.setFirstHistoryWake(contactId=>first.wakeContact(contactId));
 first.wake();incremental.wake();incremental.start();
 await Promise.all([first.waitForIdle(),incremental.waitForIdle()]);await first.waitForIdle();
 for(const binding of f.bindings)assert.equal((await history.coverage(binding.contact_id)).phase,'complete','冷启动后每位联系人都须完成当前运行时历史接续');
 const records=[];
 for(let round=1;round<=2;round++){
  const text=`合成冷启动新消息${round}`;
  records.push({partition:'d'.repeat(64),table:'c'.repeat(64),localId:String(30+round),serverId:'0',sender:'contact',kind:'text',text,originalType:'1',sentAt:String(1700000000000+round*1000),timePrecision:'second',orderScheme:null,orderKey:null,status:'0',stateAssurance:'verified'});
  await f.setPlan({capabilities:caps,resumeCursor:'synthetic-resume',resumeRows:records,tailRows:records,extraRows:records});
  t.mock.timers.tick(30_000);await incremental.waitForIdle();await first.waitForIdle();
  for(const binding of f.bindings){
   const result=await history.read(binding.contact_id);assert.equal(result.coverage.phase,'complete');
   for(const row of records)assert.equal(result.messages.filter(message=>message.text===row.text).length,1,'每位联系人的所有后续消息必须保存一次');
   assert.ok(result.messages.filter(message=>message.text?.startsWith('合成历史正文:')).every(message=>message.text==='合成历史正文:'+binding.conversation_locator),'基础正文不跨联系人');
  }
 }
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('共享独立通道重复关闭不能清除后来联系人的选择',async t=>{
 const f=await fixture(t,true),token=await f.contacts.eligibility(f.bindings[0].contact_id);
 const scope={token,accountKey:account,conversationKey:f.bindings[0].conversation_locator};
 const first=createWechatHistoryChannel(f.executable,undefined,f.shared);
 await first.inspect(scope);await first.close();
 const second=createWechatHistoryChannel(f.executable,undefined,f.shared);
 const other=f.bindings[1],otherScope={token:await f.contacts.eligibility(other.contact_id),accountKey:account,conversationKey:other.conversation_locator};
 await second.inspect(otherScope);await first.close();
 const target=await second.target(otherScope);assert.equal(target.sourceGeneration,generation);
 await second.close();
});


test('关闭已park联系人不影响当前联系人，原生停止使所有轻量证明失效',async t=>{
 const f=await fixture(t,true),[a,b]=f.bindings;
 await f.setPlan({capabilities:Object.fromEntries([...statusCapabilityKeys,'incrementalTail'].map(key=>[key,'supported']))});
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 assert.equal(await f.history.bodyAvailable([a.contact_id]),true);assert.equal(await f.history.bodyAvailable([b.contact_id]),true);
 const pid=Number(await readFile(f.pidFile,'utf8')),before=(await requests(f.logFile)).filter(row=>row.op==='release-selection').length;
 await f.history.stop(a.contact_id);
 assert.equal((await requests(f.logFile)).filter(row=>row.op==='release-selection').length,before);
 await f.history.synchronize(b.contact_id);assert.equal(Number(await readFile(f.pidFile,'utf8')),pid);
 await f.history.synchronize(a.contact_id);
 await f.shared.stop();
 assert.equal(await f.history.bodyAvailable([a.contact_id,b.contact_id]),false);
 for(const binding of [a,b])assert.equal((await f.history.coverage(binding.contact_id)).failureCode,'history_source_continuity_unverified');
 await f.history.synchronize(a.contact_id);assert.equal((await f.history.coverage(a.contact_id)).phase,'complete');
});


test('共享历史排队时撤销读取不触碰正文，取消单联系人无需等待另一租约',async t=>{
 const f=await fixture(t,true),[a,b]=f.bindings;
 const blocker=await f.shared.acquire({});
 const pending=f.history.synchronize(a.contact_id);
 let idle=false;const idleWait=f.history.waitForReadIdle(a.contact_id).then(()=>{idle=true;});
 await Promise.resolve();assert.equal(idle,false);
 await f.history.stop(a.contact_id);await idleWait;assert.equal(idle,true);
 await assert.rejects(pending,{code:'history_native_cancelled'});
 assert.deepEqual(await requests(f.logFile),[]);
 await blocker.release();await f.history.synchronize(b.contact_id);
 const blocker2=await f.shared.acquire({}),queued=f.history.synchronize(a.contact_id);
 await f.contacts.setReading(false);await blocker2.release();
 await assert.rejects(queued);
 assert.equal((await requests(f.logFile)).filter(row=>row.op==='resolve'&&row.displayName===a.conversation_locator).length,0);
});

test('共享独立通道释放协议失败仍解锁，后续读者不会永久等待',async t=>{
 const f=await fixture(t,true),binding=f.bindings[0],scope={token:await f.contacts.eligibility(binding.contact_id),accountKey:account,conversationKey:binding.conversation_locator};
 const channel=createWechatHistoryChannel(f.executable,undefined,f.shared);await channel.inspect(scope);
 await f.setPlan({mode:'release-fail'});await assert.rejects(channel.close(),{code:'history_account_changed'});
 await f.setPlan({});await f.history.synchronize(binding.contact_id);
 assert.equal((await f.history.read(binding.contact_id)).messages.length,2);
});

for(const method of ['park','close'])test(`共享通道${method}失败确认原进程停止后，宿主重试只续清原资源`,async t=>{
 const {closeSqliteHostResources}=await import('../src/sqlite-host-plugin.ts');
 const f=await fixture(t,true),binding=f.bindings[0],scope={token:await f.contacts.eligibility(binding.contact_id),accountKey:account,conversationKey:binding.conversation_locator};
 const channel=createWechatHistoryChannel(f.executable,undefined,f.shared);await channel.inspect(scope);
 const pid=Number(await readFile(f.pidFile,'utf8')),released=[];
 const resources={history:{close:()=>channel[method]()},wechat:f.shared,
  models:{close:async()=>{released.push('models');}},storage:{close:async()=>{released.push('storage');}}};
 await f.setPlan({mode:'release-fail'});
 await assert.rejects(closeSqliteHostResources(resources),error=>error instanceof AggregateError&&error.errors.some(item=>item.code==='history_account_changed'));
 noProcess(pid);assert.deepEqual(released,[],'关闭未确认时不先释放共享模型与存储');
 await assert.rejects(channel.inspect(scope),{code:'history_native_closed'});
 const before=await requests(f.logFile);
 await f.setPlan({});await closeSqliteHostResources(resources);
 assert.deepEqual(released,['models','storage']);
 assert.deepEqual(await requests(f.logFile),before,'仅完成原停读与租约收尾，不重开或重新选择联系人');
 assert.equal(Number(await readFile(f.pidFile,'utf8')),pid);noProcess(pid);
 await assert.rejects(channel.inspect(scope),{code:'history_native_closed'});
});

test('共享通道未收到释放回执且原进程仍存活时，宿主不能确认收尾',async t=>{
 const {closeSqliteHostResources}=await import('../src/sqlite-host-plugin.ts');
 const f=await fixture(t,true),binding=f.bindings[0],scope={token:await f.contacts.eligibility(binding.contact_id),accountKey:account,conversationKey:binding.conversation_locator};
 const channel=createWechatHistoryChannel(f.executable,undefined,f.shared);await channel.inspect(scope);
 const pid=Number(await readFile(f.pidFile,'utf8')),released=[];
 const resources={history:channel,wechat:f.shared,storage:{close:async()=>{released.push('storage');}}};
 await f.setPlan({mode:'release-blocked'});
 let settled=false;
 const closing=closeSqliteHostResources(resources).finally(()=>{settled=true;});
 const rejected=assert.rejects(closing,error=>error instanceof AggregateError);
 try{
  await waitForOperation(f.logFile,'release-selection');
  assert.doesNotThrow(()=>process.kill(pid,0));
  assert.equal(settled,false);assert.deepEqual(released,[]);
  await assert.rejects(channel.inspect(scope),{code:'history_native_closed'});
 }finally{process.kill(pid,'SIGKILL');await rejected;}
 noProcess(pid);assert.deepEqual(released,[],'失联结果本身不能当作成功回执');
 await closeSqliteHostResources(resources);assert.deepEqual(released,['storage']);
});


test('共享切回与记忆来源重验保留持久增量恢复，不把元数据target当旧游标',async t=>{
 const f=await fixture(t,true),[a,b]=f.bindings;
 const caps=Object.fromEntries([...statusCapabilityKeys,'incrementalTail','durableIncremental'].map(key=>[key,'supported']));
 await f.setPlan({capabilities:caps,resumeCursor:'synthetic-resume'});
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 await f.history.ensureSourceReady(a.contact_id);
 assert.equal((await f.history.coverage(a.contact_id)).phase,'complete');
 await f.history.synchronizeIncremental(a.contact_id);
 await f.history.synchronize(a.contact_id);
 const result=await f.history.synchronizeIncremental(a.contact_id);
 assert.equal(result.incremental.phase,'ready');
 const rows=await requests(f.logFile),resume=rows.filter(row=>row.op==='resume-target');
 assert.equal(resume.length,1);assert.equal(resume[0].conversation,a.conversation_locator);
 assert.equal(rows.filter(row=>row.op==='tail').length,1);
 assert.equal((await f.history.read(a.contact_id)).messages.length,2);
});


test('反复切换仅保留当前联系人轻量证明订阅，关闭后无遗留订阅',async t=>{
 const f=await fixture(t,true),lease=await f.shared.acquire({}),native=lease.client;
 let subscriptions=0;const subscribe=native.onStopped.bind(native);
 native.onStopped=listener=>{subscriptions++;const off=subscribe(listener);let live=true;return ()=>{if(live){live=false;subscriptions--;}off();};};
 await lease.release();
 for(let index=0;index<30;index++){
  await f.history.ensureSourceReady(f.bindings[index%2].contact_id);
  assert.ok(subscriptions<=2,'来源证明按联系人保留，不随切换次数增长');
 }
 await f.history.close();assert.equal(subscriptions,0);
});

test('共享parked联系人重新查证期间原来源保持可用，实际原生失证仍撤销证明',async t=>{
 const f=await fixture(t,true,{registryModule:new URL('./fixtures/history-parked-registry.mjs',import.meta.url).href}),[a,b]=f.bindings;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const execute=f.storage.execute.bind(f.storage);let checked=0;
 f.storage.execute=async(action,input)=>{
  if(action==='history.prepareNormalUseGuard'&&input.token.contact_id===a.contact_id){
   checked=await execute('fixture.currentSourceValid',{ownerId:owner,contactId:a.contact_id});
  }
  return execute(action,input);
 };
 try{await f.history.synchronize(a.contact_id);assert.equal(checked,2,'重新inspect和target后、提交新证明前，旧来源不能临时失效');}
 finally{f.storage.execute=execute;}
 assert.equal(await execute('fixture.currentSourceValid',{ownerId:owner,contactId:a.contact_id}),2);
 await f.shared.stop();
 await assert.rejects(execute('fixture.currentSourceValid',{ownerId:owner,contactId:a.contact_id}),{code:'history_source_not_available'});
 assert.equal((await f.history.coverage(a.contact_id)).failureCode,'history_source_continuity_unverified');
});

for(const mode of ['wrong-account','wrong-generation'])test(`parked联系人重新查证发现${mode}时旧来源立即失效且不读取正文`,async t=>{
 const f=await fixture(t,true,{registryModule:new URL('./fixtures/history-parked-registry.mjs',import.meta.url).href}),[a,b]=f.bindings;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const before=(await requests(f.logFile)).filter(row=>row.op==='page').length;
 await f.setPlan({mode});await assert.rejects(f.history.synchronize(a.contact_id));
 assert.equal((await requests(f.logFile)).filter(row=>row.op==='page').length,before);
 await assert.rejects(f.storage.execute('fixture.currentSourceValid',{ownerId:owner,contactId:a.contact_id}),{code:'history_source_not_available'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
