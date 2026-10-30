import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NarrowWechatClient } from '../src/history/wechat/native-client.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const generation='a'.repeat(64), account='synthetic-owner', conversation='synthetic-friend';
const scopeDigest=hash(`${account}\0${conversation}`);
const schema={format:'wechat-message-schema-v1',status:'unverified',scopeDigest,sourceGeneration:generation,schemaFingerprint:'b'.repeat(64),
 tables:[{target:'c'.repeat(64),partition:'d'.repeat(64),role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'9007199254740993',rootPage:'2'}],checkedPartitions:['d'.repeat(64)]};
async function fixture(t,mode='normal') {
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-narrow-native-')));
 await mkdir(join(root,'bin'));await mkdir(join(root,'lib'));
 const executable=join(root,'bin','wx-cli'),pidFile=join(root,'pid'),logFile=join(root,'requests');
 const script=`#!${process.execPath}
 const fs=require('node:fs'); const readline=require('node:readline');const crypto=require('node:crypto');
 fs.writeFileSync(process.env.PID_FILE,String(process.pid));
 if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
 const schema=${JSON.stringify(schema)};let busy=false,supportCount=0;let currentConversation='${conversation}';
 const target={protocol:'private-history-v1',descriptor:'synthetic-target-v1',partitions:['d'.repeat(64)],tables:[{partition:'d'.repeat(64),instance:'c'.repeat(64)}],sourceGeneration:'${generation}'};
 if(process.env.TEST_MODE==='sparse-partitions'){
  schema.checkedPartitions=Array.from({length:8},(_,i)=>(i+1).toString(16).repeat(64));
  schema.tables=[{...schema.tables[0],partition:schema.checkedPartitions[0]},{...schema.tables[0],partition:schema.checkedPartitions[7],target:'f'.repeat(64)}];
  target.partitions=schema.tables.map(table=>table.partition);target.tables=schema.tables.map(table=>({partition:table.partition,instance:table.target}));
 }

 readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);fs.appendFileSync(process.env.LOG_FILE,JSON.stringify(r)+'\\n');
  if(busy){process.stdout.write(JSON.stringify({ok:false,error:{code:'synthetic_parallel'}})+'\\n');return;}busy=true;
  const mode=process.env.TEST_MODE;
  if(mode==='never')return;
  if(mode==='stderr'){process.stderr.write('s'.repeat(65537));return;}
  if(mode==='oversize'){process.stdout.write('x'.repeat(2*1024*1024+1));return;}
  if(mode==='invalid-json'){process.stdout.write('{broken\\n');return;}
  if(mode==='invalid-utf8'){process.stdout.write(Buffer.from([0x7b,0xff,0x7d,0x0a]));return;}
  if(mode==='unknown-code'){process.stdout.write(JSON.stringify({ok:false,error:{code:'sensitive-arbitrary-native-value'}})+'\\n');return;}
  if(mode==='known-code'){process.stdout.write(JSON.stringify({ok:false,error:{code:'history_account_changed'}})+'\\n');return;}
  if(r.op==='resolve')currentConversation=r.displayName==='另一位合成联系人'?'synthetic-other':'${conversation}';
  let data=r.op==='resolve'?{accountKey:'${account}',conversationKey:currentConversation,displayName:'合成目标',sourceGeneration:'${generation}'}:schema;
  if(r.op==='support'){
   supportCount++;data={protocol:'private-history-v1',profileId:'synthetic-profile-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:'${account}',conversationKey:currentConversation,sourceGeneration:'${generation}',programVersion:'4.0.6',build:'29387',artifactSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],serverAliasSemantics:'unverified',identity:'source-table-local-v1',statusSemantics:'synthetic-status-v1',continuity:'synthetic-current-source-v1'};
   if(mode==='unverified-support'||mode==='unsupported-support')data={...data,status:mode==='unverified-support'?'unverified':'unsupported',reason:'synthetic_unverified'};
   if(mode==='partial-capabilities')data={...data,status:'unverified',reason:'history_message_state_unverified',capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','serverIdUniqueConstraint','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory'].map(key=>[key,['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn'].includes(key)?'supported':key==='serverIdUniqueConstraint'?'unsupported':'unverified']))};

   if(mode==='wrong-support-scope')data={...data,conversationKey:'synthetic-other'};
   if(mode==='wrong-support-key')data={...data,declaredPrimaryKey:['unrelated']};
   if(mode==='wrong-support-generation')data={...data,sourceGeneration:'f'.repeat(64)};
   if(mode==='wrong-support-artifact')data={...data,artifactSha256:'f'.repeat(64)};
   if(mode==='schema-change-support'&&supportCount>1)data={...data,schemaFingerprint:'f'.repeat(64)};
  }
  if(r.op==='target'){
   data={...target,descriptor:target.descriptor+':'+currentConversation};
   if(mode==='wrong-target-generation')data={...data,sourceGeneration:'f'.repeat(64)};
   if(mode==='wrong-target-table')data={...data,tables:[{partition:'d'.repeat(64),instance:'f'.repeat(64)}]};
  }
  if(r.op==='observe-metadata'){
   const rawType={text:'1',image:'3',voice:'34',video:'43',file:'49',sticker:'47',other:'1000'}[r.kind];
   const record={partition:schema.tables[0].partition,table:schema.tables[0].target,localId:'9223372036854775807',serverId:'9007199254740993',originalType:rawType,status:'-9223372036854775808',createTime:'1700000000',sender:'contact',statusSemantics:'unverified',normalHistory:false,observationScope:'single-fixed-snapshot'};
   if(mode.startsWith('metadata-raw:')){const raw=mode.slice('metadata-raw:'.length);record.originalType=raw==='null'?null:raw;}
   data={format:'wechat-message-metadata-observation-v1',status:'unverified',scopeDigest:crypto.createHash('sha256').update('${account}'+'\\0'+currentConversation).digest('hex'),sourceGeneration:'${generation}',schemaFingerprint:'b'.repeat(64),kind:r.kind,checkedPartitions:schema.checkedPartitions,record};
   if(mode==='metadata-null')data={...data,record:null};
   if(mode==='metadata-body')data={...data,record:{...record,body:'forbidden-sensitive-body'}};
   if(mode==='metadata-source')data={...data,record:{...record,source:'forbidden-sensitive-XML'}};
   if(mode==='metadata-number')data={...data,record:{...record,localId:9007199254740993}};
   if(mode==='metadata-overflow')data={...data,record:{...record,status:'9223372036854775808'}};
   if(mode==='metadata-time-number')data={...data,record:{...record,createTime:1700000000}};
   if(mode==='metadata-wrong-scope')data={...data,scopeDigest:'f'.repeat(64)};
   if(mode==='metadata-wrong-generation')data={...data,sourceGeneration:'f'.repeat(64)};
   if(mode==='metadata-wrong-schema')data={...data,schemaFingerprint:'f'.repeat(64)};
   if(mode==='metadata-wrong-partitions')data={...data,checkedPartitions:['f'.repeat(64)]};
   if(mode==='metadata-wrong-partition')data={...data,record:{...record,partition:'f'.repeat(64)}};
   if(mode==='metadata-wrong-table')data={...data,record:{...record,table:'f'.repeat(64)}};
   if(mode==='metadata-wrong-kind')data={...data,kind:r.kind==='text'?'image':'text'};
   if(mode==='metadata-promoted')data={...data,record:{...record,normalHistory:true}};
   if(mode==='metadata-promoted-status')data={...data,status:'supported'};
   if(mode==='metadata-exhausted')data={...data,exhausted:true};
   if(mode==='metadata-cancel')return;
  }
  if(r.op==='page'){
   const row={partition:'d'.repeat(64),table:'c'.repeat(64),localId:'9007199254740993',serverId:'0',sender:'contact',kind:'text',text:'合成分页文字',originalType:'1',sentAt:'1000',timePrecision:'second',orderScheme:null,orderKey:null,status:'0',stateAssurance:'verified'};
   data={target:r.target,cursorIn:r.cursor||null,cursorOut:null,records:[row],completedPartitions:['d'.repeat(64)],exhausted:true};
   if(mode==='page-cancel')return;
   if(mode==='page-too-large'){process.stdout.write('x'.repeat(8*1024*1024+1));return;}
   if(mode==='page-large')data={...data,records:Array.from({length:16},(_,i)=>({...row,localId:String(i+1),text:'\\u0000'.repeat(65536)}))};
   if(mode==='wrong-page-target')data={...data,target:'another-target'};
   if(mode==='wrong-page-partition')data={...data,records:[{...row,partition:'f'.repeat(64)}]};
   if(mode==='wrong-page-table')data={...data,records:[{...row,table:'f'.repeat(64)}]};
   if(mode==='overflow-local-id')data={...data,records:[{...row,localId:'18446744073709551616'}]};
   if(mode==='oversigned-local-id')data={...data,records:[{...row,localId:'9223372036854775808'}]};
   if(mode==='unknown-record')data={...data,records:[{...row,localId:null,serverId:null,sender:'unknown',kind:'other',text:null,originalType:'unknown',status:null,sentAt:null,timePrecision:null}]};
   if(mode==='negative-record')data={...data,records:[{...row,localId:'-1',serverId:'-9223372036854775808',originalType:'-1',status:'-9223372036854775808',orderScheme:'synthetic-order',orderKey:'-9'}]};
   if(mode==='numeric-local-id')data={...data,records:[{...row,localId:9007199254740993}]};
   if(mode==='overflow-status')data={...data,records:[{...row,status:'9223372036854775808'}]};
   if(mode==='unverified-with-body')data={...data,records:[{...row,stateAssurance:'unverified'}]};
   if(mode==='missing-state-assurance'){const {stateAssurance,...untrusted}=row;data={...data,records:[untrusted]};}
   if(mode==='wrong-text-kind')data={...data,records:[{...row,kind:'image',text:'不能夹带正文'}]};
   if(mode==='oversized-text')data={...data,records:[{...row,text:'x'.repeat(65537)}]};
  }

  if(mode==='unsafe-integer'&&r.op==='inspect')data={...schema,tables:[{...schema.tables[0],columns:[{...schema.tables[0].columns[0],primaryKey:9007199254740993}]}]};
  if(mode==='unsafe-version'&&r.op==='inspect')data={...schema,tables:[{...schema.tables[0],schemaVersion:9007199254740993}]};
  if(mode==='wrong-scope'&&r.op==='inspect')data={...schema,scopeDigest:'f'.repeat(64)};
  if(mode==='wrong-generation'&&r.op==='inspect')data={...schema,sourceGeneration:'f'.repeat(64)};
  if(mode==='unknown-field')data={...data,raw_private_source:'never-return-this'};
  const finish=()=>{busy=false;process.stdout.write(JSON.stringify({ok:true,data})+'\\n'+(mode==='extra-line'?'{}\\n':''));};
  if(mode==='delayed'||mode==='serial')setTimeout(finish,mode==='delayed'?500:30);else finish();
 });
`;
 await writeFile(executable,script,{mode:0o700});const wcdb=Buffer.from('synthetic-WCDB-artifact');
 await writeFile(join(root,'lib','libWCDB.dylib'),wcdb);
 const manifest={formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',cliSha256:hash(script),wcdbSha256:hash(wcdb),signing:'ad-hoc-development',realWechatVerified:false};
 await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
 const options={executable,expectedCliSha256:manifest.cliSha256,expectedWcdbSha256:manifest.wcdbSha256,environment:{TEST_MODE:mode,PID_FILE:pidFile,LOG_FILE:logFile}};
 const client=new NarrowWechatClient(options);
 t.after(async()=>{await client.close();await rm(root,{recursive:true,force:true});});
 return {client,options,root,pidFile,logFile,manifest};
}
async function waitForPid(file) {
 try{return Number(await readFile(file,'utf8'));}catch{}
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{watcher.close();reject(new Error('synthetic_child_not_started'));},5000);
  const watcher=watch(join(file,'..'),async()=>{try{const pid=Number(await readFile(file,'utf8'));watcher.close();clearTimeout(timer);resolve(pid);}catch{}});
  readFile(file,'utf8').then(pid=>{watcher.close();clearTimeout(timer);resolve(Number(pid));},()=>{});
 });
}
function noProcess(pid){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}

test('固定制品与argv，resolve后只按自身scope检查结构，两个并发请求串行',async t=>{
 const {client,logFile}=await fixture(t,'serial');
 assert.equal(client.request,undefined);assert.equal(client.run,undefined);assert.equal(client.options,undefined);
 const [resolved,inspection]=await Promise.all([client.resolveSelected('合成目标'),client.inspectSelected()]);
 assert.equal(resolved.accountKey,account);assert.deepEqual(inspection,schema);
 const rows=(await readFile(logFile,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows,[{op:'resolve',displayName:'合成目标',consent:'selected-metadata-v1'},{op:'inspect',account,conversation,consent:'selected-schema-v1'}]);
 await assert.rejects(client.inspectSelected({account:'another-owner'}),{code:'history_request_invalid'});
 assert.equal((await readFile(logFile,'utf8')).trim().split('\n').length,2);
 resolved.accountKey='external-injected';await client.inspectSelected();
 const last=JSON.parse((await readFile(logFile,'utf8')).trim().split('\n').at(-1));assert.equal(last.account,account);
});
test('inspect未resolve时不启动子进程，非法名称与scope参数不进入协议',async t=>{
 const {client,pidFile,options}=await fixture(t);
 for(const extra of [{sql:'SELECT *'},{environment:{BAD:null}},{environment:{'BAD=KEY':'value'}}])assert.throws(()=>new NarrowWechatClient({...options,...extra}),{code:'history_request_invalid'});
 await assert.rejects(client.inspectSelected(),{code:'history_scope_unverified'});
 for(const name of ['',null,'a\nother','甲'.repeat(86)])await assert.rejects(client.resolveSelected(name),{code:'history_request_invalid'});
 await assert.rejects(readFile(pidFile),{code:'ENOENT'});
});
test('CLI/WCDB哈希与manifest固定身份不匹配时均不启动',async t=>{
 for(const field of ['cli','wcdb','commit','tree','patch','kind','architecture','symlink']){
  const f=await fixture(t);const options={...f.options};
  if(field==='cli')options.expectedCliSha256='0'.repeat(64);
  else if(field==='wcdb')await writeFile(join(f.root,'lib','libWCDB.dylib'),'changed');
  else if(field==='symlink'){options.executable=join(f.root,'bin','link');await symlink(f.options.executable,options.executable);}
  else{const key={commit:'sourceCommit',tree:'sourceTree',patch:'readonlyPatchSha256',kind:'kind',architecture:'architecture'}[field];await writeFile(join(f.root,'manifest.json'),JSON.stringify({...f.manifest,[key]:'wrong'}));}
  const client=new NarrowWechatClient(options);t.after(()=>client.close());
  await assert.rejects(client.resolveSelected('合成目标'),{code:'history_artifact_unverified'});
  await assert.rejects(readFile(f.pidFile),{code:'ENOENT'});
 }
});
test('未知字段、非法JSON/UTF8、额外响应与超限输出全部失败且退出，无原始内容错误',async t=>{
 for(const mode of ['unknown-field','invalid-json','invalid-utf8','extra-line','oversize','stderr','unknown-code']){
  const f=await fixture(t,mode);
  const pending=f.client.resolveSelected('合成目标');
  const code=mode==='oversize'?'history_response_too_large':mode==='stderr'?'history_stderr_limit':'history_protocol_invalid';
  const rejection=assert.rejects(pending,error=>error.code===code&&error.message===code);
  const pid=await waitForPid(f.pidFile);await rejection;
  noProcess(pid);
 }
});
test('仅保留明确白名单渠道错误，账号/来源范围与schema整数精度严格校验',async t=>{
 for(const mode of ['known-code','unsafe-integer','unsafe-version','wrong-scope','wrong-generation']){
  const f=await fixture(t,mode);const code=mode==='known-code'?'history_account_changed':'history_protocol_invalid';
  if(mode==='known-code')await assert.rejects(f.client.resolveSelected('合成目标'),{code});
  else {await f.client.resolveSelected('合成目标');await assert.rejects(f.client.inspectSelected(),{code});}
  noProcess(await waitForPid(f.pidFile));
 }
});
test('Abort和close都会等待子进程退出，迟到响应不能恢复旧scope',async t=>{
 const f=await fixture(t,'delayed');const controller=new AbortController();
 const pending=f.client.resolveSelected('合成目标',controller.signal);const pid=await waitForPid(f.pidFile);controller.abort();
 await assert.rejects(pending,{code:'history_native_cancelled'});noProcess(pid);
 await assert.rejects(f.client.inspectSelected());
 const g=await fixture(t,'never');const current=g.client.resolveSelected('合成目标');const other=g.client.inspectSelected();
 const gpid=await waitForPid(g.pidFile);await g.client.close();
 await assert.rejects(current,{code:'history_native_closed'});await assert.rejects(other,{code:'history_native_closed'});noProcess(gpid);
 await g.client.close();
});
test('预取消不启动进程，活动请求10秒截止后退出',async t=>{
 const f=await fixture(t,'never');const controller=new AbortController();controller.abort();
 await assert.rejects(f.client.resolveSelected('合成目标',controller.signal),{code:'history_native_cancelled'});
 await assert.rejects(readFile(f.pidFile),{code:'ENOENT'});
 const g=await fixture(t,'never');const start=Date.now();const pending=g.client.resolveSelected('合成目标');const pid=await waitForPid(g.pidFile);
 await assert.rejects(pending,{code:'history_native_timeout'});assert.ok(Date.now()-start>=9900);noProcess(pid);
});

test('排队请求取消立即停止整个scope，活动请求和取消请求均等退出后拒绝',async t=>{
 const f=await fixture(t,'never');const controller=new AbortController();
 const active=f.client.resolveSelected('合成目标');const queued=f.client.inspectSelected(controller.signal);
 const activeRejected=assert.rejects(active,{code:'history_native_cancelled'}),queuedRejected=assert.rejects(queued,{code:'history_native_cancelled'});
 const pid=await waitForPid(f.pidFile);controller.abort();
 await Promise.all([activeRejected,queuedRejected]);noProcess(pid);
});

test('typed support/target/page只使用已选scope，支持复验保留同一目标与精确身份',async t=>{
 const f=await fixture(t);await f.client.resolveSelected('合成目标');await assert.rejects(f.client.targetSelected(),{code:'history_support_unverified'});await f.client.inspectSelected();
 const report=await f.client.supportSelected();assert.equal(report.status,'supported');assert.equal(report.serverAliasSemantics,'unverified');
 const target=await f.client.targetSelected();await f.client.supportSelected();
 const page=await f.client.pageSelected(target,null);assert.equal(page.records[0].localId,'9007199254740993');assert.equal(page.records[0].serverId,'0');assert.equal(page.records[0].status,'0');
 const rows=(await readFile(f.logFile,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.slice(-4).map(r=>[r.op,r.consent]),[['support','selected-schema-v1'],['target','selected-history-v1'],['support','selected-schema-v1'],['page','selected-history-v1']]);
 assert.equal(rows.at(-1).target,target.descriptor);assert.equal(rows.at(-1).cursor,'');
});
test('未验证或不支持时不发target/page，旧目标和篡改目标不能换联系人',async t=>{
 for(const mode of ['unverified-support','unsupported-support']){
  const f=await fixture(t,mode);await f.client.resolveSelected('合成目标');await f.client.supportSelected();
  const code=mode==='unverified-support'?'history_support_unverified':'history_support_unsupported';
  await assert.rejects(f.client.targetSelected(),{code});
  assert.deepEqual((await readFile(f.logFile,'utf8')).trim().split('\n').map(JSON.parse).map(r=>r.op),['resolve','support']);
 }
 const f=await fixture(t);await f.client.resolveSelected('合成目标');await f.client.supportSelected();const target=await f.client.targetSelected();
 await assert.rejects(f.client.pageSelected({...target,descriptor:'another-target'},null),{code:'history_target_unverified'});
 const snapshot=structuredClone(target);target.tables[0].instance='f'.repeat(64);
 await assert.rejects(f.client.pageSelected(target,null),{code:'history_target_unverified'});
 await f.client.pageSelected(snapshot,null);
 await f.client.resolveSelected('另一位合成联系人');await f.client.supportSelected();
 await assert.rejects(f.client.pageSelected(snapshot,null),{code:'history_target_unverified'});
});
test('typed支持/目标的错scope、制品、代次和schema变化均拒绝且退出',async t=>{
 for(const mode of ['wrong-support-scope','wrong-support-key','wrong-support-generation','wrong-support-artifact','schema-change-support','wrong-target-generation','wrong-target-table']){
  const f=await fixture(t,mode);await f.client.resolveSelected('合成目标');await f.client.inspectSelected();
  if(mode.startsWith('wrong-support'))await assert.rejects(f.client.supportSelected(),{code:'history_protocol_invalid'});
  else{await f.client.supportSelected();
   if(mode==='schema-change-support')await assert.rejects(f.client.supportSelected(),{code:'history_support_changed'});
   else await assert.rejects(f.client.targetSelected(),{code:'history_protocol_invalid'});
  }
  noProcess(await waitForPid(f.pidFile));
 }
});
test('typed页拒绝错target/分片/表实例、失真身份、状态溢出与非文字夹带正文',async t=>{
 for(const mode of ['wrong-page-target','wrong-page-partition','wrong-page-table','overflow-local-id','oversigned-local-id','numeric-local-id','overflow-status','unverified-with-body','missing-state-assurance','wrong-text-kind','oversized-text']){
  const f=await fixture(t,mode);await f.client.resolveSelected('合成目标');await f.client.supportSelected();const target=await f.client.targetSelected();
  await assert.rejects(f.client.pageSelected(target,null),{code:'history_protocol_invalid'});noProcess(await waitForPid(f.pidFile));
 }
});
test('分页有独立8MiB预算，16条最坏控制字符转义仍可完整读取',async t=>{
 const f=await fixture(t,'page-large');await f.client.resolveSelected('合成目标');await f.client.supportSelected();const target=await f.client.targetSelected();
 const page=await f.client.pageSelected(target,null);assert.equal(page.records.length,16);assert.equal(Buffer.byteLength(page.records[0].text),65536);
 const g=await fixture(t,'page-too-large');await g.client.resolveSelected('合成目标');await g.client.supportSelected();const other=await g.client.targetSelected();
 await assert.rejects(g.client.pageSelected(other,null),{code:'history_response_too_large'});noProcess(await waitForPid(g.pidFile));
});
test('取消真实子进程的活动page后等待退出，不接受迟到页',async t=>{
 const f=await fixture(t,'page-cancel');await f.client.resolveSelected('合成目标');await f.client.supportSelected();const target=await f.client.targetSelected();
 const controller=new AbortController();const pending=f.client.pageSelected(target,null,controller.signal);
 const rejection=assert.rejects(pending,{code:'history_native_cancelled'});
 await waitForRequest(f.logFile,'page');controller.abort();await rejection;noProcess(await waitForPid(f.pidFile));
});
async function waitForRequest(file,op){
 const seen=async()=>{try{return (await readFile(file,'utf8')).trim().split('\n').some(line=>JSON.parse(line).op===op);}catch{return false;}};
 if(await seen())return;
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{watcher.close();reject(new Error('synthetic_request_not_started'));},5000);
  const check=async()=>{if(await seen()){clearTimeout(timer);watcher.close();resolve();}};
  const watcher=watch(join(file,'..'),check);void check();
 });
}

test('SQL int64负值与未知元数据精确保留供正常化隔离，不补造消息身份',async t=>{
 for(const mode of ['negative-record','unknown-record']){
  const f=await fixture(t,mode);await f.client.resolveSelected('合成目标');await f.client.supportSelected();const target=await f.client.targetSelected();
  const {records:[record]}=await f.client.pageSelected(target,null);
  if(mode==='negative-record'){assert.equal(record.serverId,'-9223372036854775808');assert.equal(record.status,'-9223372036854775808');assert.equal(record.localId,'-1');}
  else {assert.equal(record.localId,null);assert.equal(record.originalType,'unknown');assert.equal(record.kind,'other');assert.equal(record.text,null);}
 }
});

test('完整检查8分片但目标只在2分片有表时，数据目标保留2分片并可接受',async t=>{
 const f=await fixture(t,'sparse-partitions');await f.client.resolveSelected('合成目标');
 const inspection=await f.client.inspectSelected();assert.equal(inspection.checkedPartitions.length,8);assert.equal(inspection.tables.length,2);
 await f.client.supportSelected();const target=await f.client.targetSelected();
 assert.equal(target.partitions.length,2);assert.equal(target.tables.length,2);
 assert.deepEqual(target.partitions,inspection.tables.map(table=>table.partition));
});

test('可选13项能力三值完整保留，部分结构通过不能升级整体unverified',async t=>{
 const f=await fixture(t,'partial-capabilities');await f.client.resolveSelected('合成目标');
 const report=await f.client.supportSelected();assert.equal(Object.keys(report.capabilities).length,13);
 assert.equal(report.capabilities.exactSchema,'supported');assert.equal(report.capabilities.serverIdUniqueConstraint,'unsupported');assert.equal(report.capabilities.sourceLifecycle,'unverified');
 assert.equal(report.status,'unverified');await assert.rejects(f.client.targetSelected(),{code:'history_support_unverified'});
 assert.deepEqual((await readFile(f.logFile,'utf8')).trim().split('\n').map(JSON.parse).map(r=>r.op),['resolve','support']);
});

test('metadata观察仅需已resolve并inspect的同scope，不增加正常历史资格',async t=>{
 const f=await fixture(t,'unverified-support');await assert.rejects(f.client.observeMetadataSelected('text'),{code:'history_scope_unverified'});
 await assert.rejects(readFile(f.pidFile),{code:'ENOENT'});
 await f.client.resolveSelected('合成目标');await assert.rejects(f.client.observeMetadataSelected('text'),{code:'history_scope_unverified'});
 const inspected=await f.client.inspectSelected();inspected.schemaFingerprint='f'.repeat(64);
 assert.equal((await f.client.supportSelected()).status,'unverified');
 await assert.rejects(f.client.observeMetadataSelected('sql'),{code:'history_request_invalid'});
 for(const kind of ['text','image','voice','video','file','sticker','other']){
  const observed=await f.client.observeMetadataSelected(kind);
  assert.equal(observed.kind,kind);assert.equal(observed.status,'unverified');assert.equal(observed.record.localId,'9223372036854775807');
  assert.equal(observed.record.serverId,'9007199254740993');assert.equal(observed.record.status,'-9223372036854775808');
  assert.equal(observed.record.createTime,'1700000000');assert.equal(observed.record.normalHistory,false);assert.equal(observed.record.statusSemantics,'unverified');
 }
 await assert.rejects(f.client.targetSelected(),{code:'history_support_unverified'});
 await assert.rejects(f.client.pageSelected({},null),{code:'history_support_unverified'});
 const requests=(await readFile(f.logFile,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(requests.slice(3).map(request=>request.op),Array(7).fill('observe-metadata'));
 assert.ok(requests.slice(3).every(request=>request.account===account&&request.conversation===conversation&&request.consent==='selected-message-metadata-v1'));
 await f.client.resolveSelected('另一位合成联系人');await assert.rejects(f.client.observeMetadataSelected('text'),{code:'history_scope_unverified'});
});
test('metadata无匹配记录保留null，不报告exhausted或complete',async t=>{
 const f=await fixture(t,'metadata-null');await f.client.resolveSelected('合成目标');await f.client.inspectSelected();
 const observed=await f.client.observeMetadataSelected('voice');assert.equal(observed.record,null);assert.equal('exhausted' in observed,false);assert.equal('completedPartitions' in observed,false);
 await assert.rejects(f.client.targetSelected(),{code:'history_support_unverified'});
});
test('metadata原始类型必须按低32位匹配请求类型，不能借kind标签伪装',async t=>{
 for(const [kind,raw] of [['text','3'],['image','1'],['voice','43'],['video','49'],['file','47'],['sticker','34'],['other','1'],['other','4294967297'],['text',null],['image',null]]){
  const f=await fixture(t,`metadata-raw:${raw}`);await f.client.resolveSelected('合成目标');await f.client.inspectSelected();
  await assert.rejects(f.client.observeMetadataSelected(kind),error=>error.code==='history_protocol_invalid'&&error.message==='history_protocol_invalid');
  noProcess(await waitForPid(f.pidFile));
 }
});
test('metadata原始类型保留精确上32位、视频62和未知负数，不提升历史资格',async t=>{
 for(const [kind,raw] of [['text','4294967297'],['video','62'],['video','4294967358'],['other','-1'],['other','-9223372036854775808'],['other',null]]){
  const f=await fixture(t,`metadata-raw:${raw}`);await f.client.resolveSelected('合成目标');await f.client.inspectSelected();
  const observed=await f.client.observeMetadataSelected(kind);assert.equal(observed.record.originalType,raw);assert.equal(observed.kind,kind);
  assert.equal(observed.status,'unverified');assert.equal(observed.record.normalHistory,false);
  await assert.rejects(f.client.targetSelected(),{code:'history_support_unverified'});
 }
});
test('metadata拒绝正文/XML字段、错误scope/schema/表、整数失真和资格升级，均退出进程',async t=>{
 for(const mode of ['metadata-body','metadata-source','metadata-number','metadata-overflow','metadata-time-number','metadata-wrong-scope','metadata-wrong-generation','metadata-wrong-schema','metadata-wrong-partitions','metadata-wrong-partition','metadata-wrong-table','metadata-wrong-kind','metadata-promoted','metadata-promoted-status','metadata-exhausted']){
  const f=await fixture(t,mode);await f.client.resolveSelected('合成目标');await f.client.inspectSelected();
  await assert.rejects(f.client.observeMetadataSelected('text'),error=>error.code==='history_protocol_invalid'&&error.message==='history_protocol_invalid');
  noProcess(await waitForPid(f.pidFile));
 }
});
test('取消metadata观察会等真实子进程退出，不接收迟到观察',async t=>{
 const f=await fixture(t,'metadata-cancel');await f.client.resolveSelected('合成目标');await f.client.inspectSelected();
 const controller=new AbortController();const pending=f.client.observeMetadataSelected('image',controller.signal);
 const rejected=assert.rejects(pending,{code:'history_native_cancelled'});await waitForRequest(f.logFile,'observe-metadata');controller.abort();await rejected;noProcess(await waitForPid(f.pidFile));
});
