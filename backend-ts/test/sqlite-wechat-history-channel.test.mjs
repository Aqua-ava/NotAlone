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

const hash=value=>createHash('sha256').update(value).digest('hex');
const owner='00000000-0000-4000-8000-000000000091',account='synthetic-owner',conversation='synthetic-friend',generation='a'.repeat(64);
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest:hash(`${account}\0${conversation}`),sourceGeneration:generation,schemaFingerprint:'b'.repeat(64),
 tables:[{target:'c'.repeat(64),partition:'d'.repeat(64),role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:'2'}],checkedPartitions:['d'.repeat(64)]};
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-wechat-channel-'))),artifact=join(root,'artifact');
 await mkdir(join(artifact,'bin'),{recursive:true});await mkdir(join(artifact,'lib'));await mkdir(join(root,'state'));
 const executable=join(artifact,'bin','wx-cli'),manifestPath=join(artifact,'manifest.json'),planFile=join(root,'plan'),logFile=join(root,'requests'),pidFile=join(root,'pid');
 await writeFile(planFile,JSON.stringify({mode:'supported',serverId:'0'}));
 const script=`#!${process.execPath}
 const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
 const schema=${JSON.stringify(schema)},planFile=${JSON.stringify(planFile)},logFile=${JSON.stringify(logFile)};
 fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
 if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line),plan=JSON.parse(fs.readFileSync(planFile));fs.appendFileSync(logFile,JSON.stringify(r)+'\\n');let data;
  if(r.op==='resolve')data={accountKey:plan.mode==='wrong-account'?'synthetic-other':'${account}',conversationKey:plan.mode==='wrong-conversation'?'synthetic-other':'${conversation}',displayName:'只作展示',sourceGeneration:plan.mode==='wrong-generation'?'f'.repeat(64):'${generation}'};
  else if(r.op==='inspect')data=schema;
  else if(r.op==='support')data={protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:plan.mode==='unverified'?'unverified':'supported',reason:plan.mode==='unverified'?'history_message_state_unverified':null,accountKey:'${account}',conversationKey:'${conversation}',sourceGeneration:'${generation}',programVersion:'synthetic',build:'1',artifactSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),schemaFingerprint:schema.schemaFingerprint,declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-final',continuity:'synthetic-fixed-source'};
  else if(r.op==='target')data={protocol:'private-history-v1',descriptor:'synthetic-target',partitions:schema.checkedPartitions,tables:[{partition:'d'.repeat(64),instance:'c'.repeat(64)}],sourceGeneration:'${generation}'};
  else if(r.op==='page'){
   if(plan.mode==='blocked')return;
   const row={partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:plan.serverId,sender:'contact',kind:'text',text:'合成历史正文',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,status:'0',stateAssurance:'verified'};
   data={target:r.target,cursorIn:r.cursor||null,cursorOut:null,records:[row,{...row,localId:'2',serverId:'0',kind:'voice',text:plan.mode==='malicious'?'forbidden-body':null,originalType:'34'}],completedPartitions:schema.checkedPartitions,exhausted:true};
  }else process.exit(92);
  process.stdout.write(JSON.stringify({ok:true,data})+'\\n');
 });
`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-channel-WCDB');await writeFile(join(artifact,'lib','libWCDB.dylib'),wcdb);
 const manifest={formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',cliSha256:hash(script),wcdbSha256:hash(wcdb),signing:'ad-hoc-development',realWechatVerified:false};
 await writeFile(manifestPath,JSON.stringify(manifest));
 const storage=await SqliteStorage.open({userData:join(root,'state'),intent:'create',role:'test'});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({externalKey:account,identityScheme:'wechat.account.v1',sourceGeneration:generation,assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[{externalKey:conversation,displayName:'展示名不是身份',kind:'private',identityAssurance:'verified'}]});
 await contacts.initialize();const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})));
 const binding=(await contacts.directory()).bindings[0],history=new SqliteHistoryService(storage,contacts,()=>createWechatHistoryChannel(executable));
 t.after(async()=>{await history.close();await contacts.close();await storage.close();await rm(root,{recursive:true,force:true});});
 const scope=()=>contacts.eligibility(binding.contact_id).then(token=>({token,accountKey:account,conversationKey:conversation}));
 return {root,artifact,executable,manifestPath,manifest,planFile,logFile,pidFile,storage,contacts,history,binding,scope,setPlan:plan=>writeFile(planFile,JSON.stringify({mode:'supported',serverId:'0',...plan}))};
}
async function requests(file){try{return (await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
function noProcess(pid){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
async function waitForPage(file){return new Promise((resolve,reject)=>{
 const check=()=>requests(file).then(rows=>{if(rows.some(row=>row.op==='page')){clearTimeout(timer);watcher.close();resolve();}});
 const watcher=watch(join(file,'..'),check),timer=setTimeout(()=>{watcher.close();reject(new Error('synthetic_page_missing'));},5000);check();
});}

test('正式受控渠道驱动联系人历史服务入库，非文字空正文且serverId补齐保留消息身份',async t=>{
 const f=await fixture(t),contact=f.binding.contact_id;assert.deepEqual((await f.history.read(contact)).messages,[]);
 assert.equal((await f.history.synchronize(contact)).phase,'complete');const before=(await f.history.read(contact)).messages;
 assert.equal(before.length,2);assert.equal(before.find(row=>row.kind==='voice').text,null);const text=before.find(row=>row.kind==='text');assert.equal(text.text,'合成历史正文');
 const source=await f.history.source(contact,text.sourceRecordIds[0]);assert.equal(source.raw.serverId,'0');assert.equal(source.support.serverAliasSemantics,'unverified');
 await f.setPlan({serverId:'9223372036854775807'});assert.equal((await f.history.synchronize(contact)).phase,'complete');
 const after=(await f.history.read(contact)).messages;assert.equal(after.length,2);assert.equal(after.find(row=>row.kind==='text').id,text.id);assert.equal(after.find(row=>row.kind==='text').sourceRecordIds.length,2);
 const rows=await requests(f.logFile);assert.ok(rows.filter(row=>row.op==='resolve').every(row=>row.displayName===conversation));
 assert.deepEqual(rows.slice(0,4).map(row=>row.op),['resolve','inspect','support','target']);
 noProcess(Number(await readFile(f.pidFile,'utf8')));assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
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
  const channel=createWechatHistoryChannel(executable);await assert.rejects(channel.inspect(await f.scope()),error=>error.code==='history_artifact_unverified'&&error.message===error.code);await channel.close();
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
