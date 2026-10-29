import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NarrowWechatClient } from '../src/history/wechat/native-client.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const account='synthetic-owner',conversation='synthetic-friend',generation='a'.repeat(64),scopeDigest=hash(`${account}\0${conversation}`);
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest,sourceGeneration:generation,schemaFingerprint:'b'.repeat(64),
 tables:[{target:'c'.repeat(64),partition:'d'.repeat(64),role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:'2'}],checkedPartitions:['d'.repeat(64)]};
schema.tables.push({...schema.tables[0],partition:'9'.repeat(64),target:'f'.repeat(64)});schema.checkedPartitions.push('9'.repeat(64));
const record=(localId='9007199254740993')=>({partition:'d'.repeat(64),table:'c'.repeat(64),localId,serverId:'9223372036854775807',originalType:'4294967297',status:'-9223372036854775808',createTime:'1700000000',sender:'owner',statusSemantics:'unverified',normalHistory:false,observationScope:'single-fixed-snapshot'});
const report=(action,records=[],changes={})=>({format:'wechat-test-metadata-observation-v1',status:'unverified',scopeDigest,sourceGeneration:generation,schemaFingerprint:schema.schemaFingerprint,action,checkedPartitions:schema.checkedPartitions,lockedCount:records.length,records,...changes});
async function fixture(t,replies) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-lifecycle-native-')));
 await mkdir(join(root,'bin'));await mkdir(join(root,'lib'));
 const executable=join(root,'bin','wx-cli'),logFile=join(root,'requests'),pidFile=join(root,'pid');
 const script=`#!${process.execPath}
 const fs=require('node:fs');const readline=require('node:readline');
 const schema=${JSON.stringify(schema)},replies=${JSON.stringify(replies)};let offset=0;
 fs.writeFileSync(process.env.PID_FILE,String(process.pid));
 if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);fs.appendFileSync(process.env.LOG_FILE,JSON.stringify(r)+'\\n');let data;
  if(r.op==='resolve')data={accountKey:'${account}',conversationKey:'${conversation}',displayName:r.displayName,sourceGeneration:'${generation}'};
  else if(r.op==='inspect')data=schema;
  else if(r.op==='observe-test-metadata'){
   if(r.account!=='${account}'||r.conversation!=='${conversation}'||r.consent!=='selected-test-lifecycle-metadata-v1')process.exit(92);
   data=replies[offset++];if(data===null)return;
  }else process.exit(93);
  process.stdout.write(JSON.stringify(data?.syntheticError?{ok:false,error:{code:data.syntheticError}}:{ok:true,data})+'\\n');
 });
`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-lifecycle-WCDB');await writeFile(join(root,'lib','libWCDB.dylib'),wcdb);
 const manifest={formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',cliSha256:hash(script),wcdbSha256:hash(wcdb),signing:'ad-hoc-development',realWechatVerified:false};
 await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
 const client=new NarrowWechatClient({executable,expectedCliSha256:manifest.cliSha256,expectedWcdbSha256:manifest.wcdbSha256,environment:{PID_FILE:pidFile,LOG_FILE:logFile}});
 t.after(async()=>{await client.close();await rm(root,{recursive:true,force:true});});
 return {client,logFile,pidFile};
}
async function select(client) {await client.resolveSelected('合成固定联系人');await client.inspectSelected();}
function noProcess(pid){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
async function requests(file){return (await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);}
async function waitForRequest(file,action){
 return new Promise((resolve,reject)=>{
  const done=()=>requests(file).then(rows=>{if(rows.some(row=>row.op==='observe-test-metadata'&&row.kind===action)){clearTimeout(timer);watcher.close();resolve();}},()=>{});
  const watcher=watch(join(file,'..'),done);const timer=setTimeout(()=>{watcher.close();reject(new Error('synthetic_request_missing'));},5000);done();
 });
}

test('生命周期元数据仅固定已选scope的两条身份，旧记录可变化且不增加正常历史资格',async t=>{
 const a=record(),b=record('9223372036854775807');
 const f=await fixture(t,[report('arm'),report('next',[a]),report('next',[a,b]),report('current',[a,{...b,originalType:'10000',status:'-1',sender:'unknown'}]),report('current',[a,null]),report('current',[a,b])]);
 const selected=await f.client.resolveSelected('合成固定联系人');selected.conversationKey='attempted-injection';
 const inspected=await f.client.inspectSelected();inspected.tables[0].target='f'.repeat(64);
 assert.equal((await f.client.observeTestMetadataSelected('arm')).lockedCount,0);
 const first=await f.client.observeTestMetadataSelected('next');assert.equal(first.records[0].localId,'9007199254740993');first.records[0].localId='77';
 assert.equal((await f.client.observeTestMetadataSelected('next')).lockedCount,2);
 const changed=await f.client.observeTestMetadataSelected('current');assert.equal(changed.records[1].originalType,'10000');assert.equal(changed.status,'unverified');
 assert.deepEqual((await f.client.observeTestMetadataSelected('current')).records,[a,null]);
 assert.equal((await f.client.observeTestMetadataSelected('current')).records[1].localId,b.localId);
 await assert.rejects(f.client.targetSelected(),{code:'history_support_unverified'});await assert.rejects(f.client.pageSelected({},null),{code:'history_support_unverified'});
 const rows=(await requests(f.logFile)).slice(2);assert.equal(rows.length,6);
 assert.ok(rows.every(row=>row.op==='observe-test-metadata'&&row.account===account&&row.conversation===conversation&&row.consent==='selected-test-lifecycle-metadata-v1'));
});

test('未resolve或inspect不观察，arm仅一次且未arm不能next/current，非法动作零RPC',async t=>{
 const f=await fixture(t,[report('arm'),report('current')]);
 await assert.rejects(f.client.observeTestMetadataSelected('arm'),{code:'history_scope_unverified'});await assert.rejects(readFile(f.pidFile),{code:'ENOENT'});
 await assert.rejects(f.client.observeTestMetadataSelected('reset'),{code:'history_request_invalid'});
 await f.client.resolveSelected('合成固定联系人');await assert.rejects(f.client.observeTestMetadataSelected('arm'),{code:'history_scope_unverified'});
 await f.client.inspectSelected();
 for(const action of ['next','current'])await assert.rejects(f.client.observeTestMetadataSelected(action),{code:'history_snapshot_closed'});
 const [first,second]=await Promise.allSettled([f.client.observeTestMetadataSelected('arm'),f.client.observeTestMetadataSelected('arm')]);
 assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected');assert.equal(second.reason.code,'history_request_invalid');
 await f.client.resolveSelected('合成固定联系人');await f.client.inspectSelected();
 await assert.rejects(f.client.observeTestMetadataSelected('arm'),{code:'history_request_invalid'});
 assert.equal((await f.client.observeTestMetadataSelected('current')).lockedCount,0);
 assert.deepEqual((await requests(f.logFile)).filter(row=>row.op==='observe-test-metadata').map(row=>row.kind),['arm','current']);
});

test('恶意生命周期shape、正文、整数、scope/schema及分片表配对均拒绝并排空子进程',async t=>{
 const a=record();
 const invalid=[
  report('arm',[],{body:'forbidden-body'}),report('arm',[],{text:'forbidden-text'}),report('arm',[],{status:'supported'}),
  report('arm',[],{action:'current'}),report('arm',[],{lockedCount:0.5}),report('arm',[],{lockedCount:'0'}),report('arm',[],{lockedCount:3}),report('arm',[],{lockedCount:1}),
  report('next',[{...a,text:'forbidden-text'}]),report('next',[{...a,source:'forbidden-source'}]),
  report('next',[{...a,localId:9007199254740993}]),report('next',[{...a,localId:'9223372036854775808'}]),
  report('next',[{...a,partition:'9'.repeat(64)}]),report('next',[{...a,table:'f'.repeat(64)}]),
  report('next',[a],{scopeDigest:'0'.repeat(64)}),report('next',[a],{sourceGeneration:'0'.repeat(64)}),
  report('next',[a],{schemaFingerprint:'0'.repeat(64)}),report('next',[a],{checkedPartitions:['d'.repeat(64)]}),
 ];
 for(const response of invalid){
  const f=await fixture(t,response.action==='arm'?[response]:[report('arm'),response]);await select(f.client);
  if(response.action!=='arm')await f.client.observeTestMetadataSelected('arm');
  await assert.rejects(f.client.observeTestMetadataSelected(response.action==='arm'?'arm':'next'),error=>['history_protocol_invalid','history_source_changed','history_schema_changed'].includes(error.code)&&error.message===error.code);
  noProcess(Number(await readFile(f.pidFile,'utf8')));
 }
});

test('计数不能退或跳两条，新锁必须唯一owner文字身份，current只复查原身份',async t=>{
 const a=record(),b=record('9223372036854775807');
 const cases=[
  [report('arm',[a]),[],'arm'],
  [report('next',[a,b]),[],'next'],[report('next',[null]),[],'next'],
  [report('next',[{...a,localId:null}]),[],'next'],[report('next',[{...a,sender:'contact'}]),[],'next'],
  [report('next',[{...a,originalType:'3'}]),[],'next'],[report('next',[{...a,originalType:null}]),[],'next'],
  [report('next'),[report('next',[a])],'next'],[report('current',[a,b]),[report('next',[a])],'current'],
  [report('next',[a,a]),[report('next',[a])],'next'],[report('current',[b]),[report('next',[a])],'current'],
  [report('current',[b]),[report('next',[a]),report('current',[null])],'current'],
  [report('current',[{...a,partition:'9'.repeat(64),table:'f'.repeat(64)}]),[report('next',[a])],'current'],
 ];
 for(const [response,prefix,action] of cases){
  const replies=action==='arm'?[response]:[report('arm'),...prefix,response];const f=await fixture(t,replies);await select(f.client);
  if(action!=='arm'){await f.client.observeTestMetadataSelected('arm');for(const prior of prefix)await f.client.observeTestMetadataSelected(prior.action);}
  await assert.rejects(f.client.observeTestMetadataSelected(action),{code:'history_identity_ambiguous'});
  noProcess(Number(await readFile(f.pidFile,'utf8')));
 }
});

test('取消生命周期观察等待真实子进程退出，不保留迟到记录',async t=>{
 const f=await fixture(t,[report('arm'),null]);await select(f.client);await f.client.observeTestMetadataSelected('arm');
 const controller=new AbortController(),pending=f.client.observeTestMetadataSelected('next',controller.signal);
 const rejected=assert.rejects(pending,{code:'history_native_cancelled'});await waitForRequest(f.logFile,'next');controller.abort();await rejected;
 noProcess(Number(await readFile(f.pidFile,'utf8')));
 await assert.rejects(f.client.observeTestMetadataSelected('current'),{code:'history_native_cancelled'});
});

test('受控观察固定原因码可区分门禁且拒绝后排空',async t=>{
 for(const code of ['history_test_sender_unverified','history_test_sender_ambiguous','history_test_new_rows_ambiguous','history_test_type_unverified','history_test_key_unverified']){
  const f=await fixture(t,[{syntheticError:code}]);await select(f.client);
  await assert.rejects(f.client.observeTestMetadataSelected('arm'),{code});
  noProcess(Number(await readFile(f.pidFile,'utf8')));
  await assert.rejects(f.client.observeTestMetadataSelected('current'),{code});
 }
});
