import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,report,createChannel,target,restart} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';
import {mkdtemp,mkdir,writeFile,chmod,rm,realpath,readFile,symlink,lstat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {createNativeLegacyProofProvider} from '../src/history/sqlite/legacy-terminal-native-proof.ts';
import {legacyProofDigest} from '../src/history/sqlite/legacy-terminal-proof.ts';
import {loadLocalLegacyProofProvider,loadHostLegacyProofProvider} from '../src/history/sqlite/legacy-terminal-maintenance.ts';
import {SqliteHistoryClearHttp} from '../src/history/sqlite/clear-http.ts';
const capabilities={normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported',incrementalTail:'supported'};
const tables=target=>target.tables.map((t,index)=>({target:t.instance,partition:t.partition,role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'9',rootPage:String(index+1)}));
function proofFor(input){
 const {token,report:currentReport,target:currentTarget,candidates}=input,scope={accountKey:currentReport.accountKey,conversationKey:currentReport.conversationKey,displayName:'合成甲',sourceGeneration:token.source_generation};
 const current={scope,schema:{sourceGeneration:scope.sourceGeneration,tables:tables(currentTarget),checkedPartitions:[...currentTarget.checkedPartitions]},report:currentReport,target:currentTarget};
 const oldGeneration=candidates[0].token.source_generation,oldTarget={...candidates[0].target,checkedPartitions:[...currentTarget.checkedPartitions],tables:currentTarget.tables.map(t=>({...t,instance:`legacy-live-${t.instance}`}))};
 const legacy={scope:{...scope,sourceGeneration:oldGeneration},schema:{sourceGeneration:oldGeneration,tables:tables(oldTarget),checkedPartitions:[...oldTarget.checkedPartitions]},report:candidates[0].report,target:oldTarget};
 return{format:'notalone-legacy-recall-mapping-v1',token,observedAt:Date.now(),legacy,current,keys:candidates.map(c=>({from:c.key,to:JSON.stringify([token.source_generation,...JSON.parse(c.key).slice(1)]),reason:'source_recalled'}))};
}

async function setup(t,proofProvider,options={}){
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/legacy-terminal-registry.mjs',import.meta.url).href});
 f.state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,capabilities:{...report.capabilities,...capabilities}});f.channel.guardSession={loss:new Promise(()=>{})};
 f.state.pageRecords=[1,2,3,4].map(id=>record('shard-a',String(id)));await f.current.history.synchronize(f.contactA);
 await f.current.storage.execute('fixture.legacyRecalls',{ownerId:owner,contactId:f.contactA,generation:'legacy-source',...(options.recallLocals?{locals:options.recallLocals}:{}),...(options.recallScheme?{scheme:options.recallScheme}:{}),...(options.supportStatus?{supportStatus:options.supportStatus}:{}),...(options.currentSystem?{currentSystem:true}:{})});
 const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});
 const channels=[];
 const create=()=>{const {channel,state}=createChannel(),index=channels.length;state.pageRecords=[1,2,3,4].map(id=>record('shard-a',String(id)));state.pageFactory=(_scope,cursor,s)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:s.pageRecords,completedPartitions:[...target.partitions],exhausted:true,resumeCursor:'synthetic-tail-0'});state.inspectFactory=scope=>({...report,artifactSha256:'b'.repeat(64),continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,capabilities:{...report.capabilities,...capabilities}});channel.target=async()=>({...target,checkedPartitions:[...target.partitions],...(options.changeActualTarget&&index===1?{tables:target.tables.map(t=>({...t,instance:`changed-${t.instance}`}))}: {})});channel.guardSession={loss:new Promise(()=>{})};channels.push(state);return channel;};
 const service=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,create,f.current.holders,{stopHistory:id=>f.current.history.stop(id),proveLegacyTerminals:proofProvider});t.after(()=>service.close());
 return{...f,service,channels,token,create};
}

test('精确旧新读取器证明仅恢复新认证并保留三条撤回抑制',async t=>{
 let invoked=0;const f=await setup(t,async input=>{invoked++;return proofFor(input);});
 const before=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA});
 const done=await f.service.recertify(f.contactA,{requestKey:'synthetic-verified-legacy-map'});
 assert.equal(done.state,'completed',`同一物理来源的精确旧新代次证明应能完成认证，实际为 ${done.failure_code}`);
 assert.equal(invoked,1);assert.equal(done.message_count,1,'三条已撤回的物理行不能因认证换代重新进入消息');
 const snapshot=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA});
 const mapped=snapshot.terminals.filter(x=>x.binding_id!==f.token.binding_id);assert.equal(mapped.length,3);assert.ok(mapped.every(x=>JSON.parse(x.external_key)[0]==='source-1'));
 assert.equal(snapshot.messages.filter(x=>x.binding_id===f.token.binding_id).length,4,'旧资料完整保留');
 for(const table of ['messages','captures','aliases'])assert.deepEqual(snapshot[table].filter(row=>before[table].some(old=>old.id===row.id)),before[table]);
 const oldRecord=before.captures.find(r=>r.state==='normalized');await assert.rejects(f.current.storage.execute('history.source',{ownerId:owner,contactId:f.contactA,recordId:oldRecord.id}),{code:'history_source_not_found'});
 const audit=JSON.parse(snapshot.operations.at(-1).old_fence_json).legacy_terminal_mapping;assert.equal(audit.proof.keys.length,3);assert.equal(audit.candidates.length,3);assert.equal(audit.digest,legacyProofDigest({proof:audit.proof,candidates:audit.candidates}));
});

for(const variant of ['target','grant','extra-key','expired','account','structure','noncanonical-key','artifact','deletion'])test(`精确证明拒绝${variant}变化`,async t=>{
 let f;f=await setup(t,async input=>{const p=proofFor(input);
  if(variant==='target')p.current.target={...p.current.target,tables:p.current.target.tables.map(x=>({...x,instance:'changed-table'}))};
  if(variant==='grant')p.token={...p.token,grant_id:'different-grant'};
  if(variant==='extra-key')p.keys.push({...p.keys[0]});
  if(variant==='expired')p.observedAt-=120001;
  if(variant==='account')p.legacy.scope.accountKey='different-account';
  if(variant==='structure')p.legacy.schema.tables[0].rootPage='99';
  if(variant==='noncanonical-key')p.keys[0].to=' '+p.keys[0].to;
  if(variant==='artifact')p.legacy.report={...p.legacy.report,artifactSha256:'c'.repeat(64)};
  if(variant==='deletion')await f.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:f.contactA,mode:'globalFence'});
  return p;});
 const done=await f.service.recertify(f.contactA,{requestKey:`synthetic-invalid-${variant}`});assert.equal(done.state,'failed');assert.equal(done.failure_code,'history_recertify_legacy_proof_invalid');assert.equal(done.page_count,0);
 const saved=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(saved.fences.length,1);assert.equal(saved.terminals.length,0);
});

test('证明后实际认证目标变化仍拒绝，旧资料和围栏保留',async t=>{
 const f=await setup(t,async input=>proofFor(input),{changeActualTarget:true});const done=await f.service.recertify(f.contactA,{requestKey:'synthetic-actual-target-changed'});
 assert.equal(done.state,'failed');assert.equal(done.failure_code,'history_recertify_source_changed');assert.equal(done.page_count,0);const saved=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(saved.fences.length,1);assert.equal(saved.messages.length,4);
});

test('没有精确证明时旧代次撤回仍拒绝认证',async t=>{
 const f=await setup(t);const done=await f.service.recertify(f.contactA,{requestKey:'synthetic-no-legacy-proof'});
 assert.equal(done.state,'failed');assert.equal(done.failure_code,'history_recertify_suppression_unmapped');assert.equal(done.page_count,0);
});

test('旧target可用独立inspect完整清单，新认证target缺清单仍拒绝',async t=>{
 for(const reader of ['legacy','current']){
  const f=await setup(t,async input=>{const p=proofFor(input);delete p[reader].target.checkedPartitions;return p;});
  const done=await f.service.recertify(f.contactA,{requestKey:`synthetic-missing-${reader}-manifest`});
  assert.equal(done.state,reader==='legacy'?'completed':'failed');if(reader==='legacy')assert.equal(done.message_count,1);else assert.equal(done.page_count,0);
 }
});

test('HTTP不能提供证明、读取器或映射字段',async t=>{
 const f=await setup(t),http=new SqliteHistoryClearHttp({}, {},f.service),server=createServer((req,res)=>{void http.handle(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/${f.contactA}/history/recertify`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_key:'synthetic-forged-proof',legacy_terminal_mapping:{from:'old',to:'new'}})});
 assert.equal(response.status,400);assert.equal((await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA})).operations.length,0);
});

test('固定本机意图拒绝其他实例、公开权限、作用域或目标变更',async t=>{
 let context;const f=await setup(t,async input=>{context=structuredClone(input);return proofFor(input);});await f.service.recertify(f.contactA,{requestKey:'synthetic-build-intent'});
 const userData=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-legacy-intent-')));t.after(()=>rm(userData,{recursive:true,force:true}));await mkdir(path.join(userData,'managed/maintenance'),{recursive:true,mode:0o700});
 const proof=proofFor(context),intent={format:'notalone-legacy-terminal-maintenance-v1',databaseId:'synthetic-db',ownerId:context.token.owner_id,contactId:context.token.contact_id,legacyExecutable:'/synthetic/old',currentExecutable:'/synthetic/current',proof,proofDigest:legacyProofDigest(proof)},file=path.join(userData,'managed/maintenance/legacy-terminal-proof.json');
 await writeFile(file,JSON.stringify(intent),{mode:0o600});const options={userData,databaseId:intent.databaseId,currentExecutable:intent.currentExecutable},load=()=>loadLocalLegacyProofProvider(options);
 const provider=await load();assert.equal(typeof provider,'function');await assert.rejects(readFile(file),{code:'ENOENT'});
 await writeFile(file,JSON.stringify(intent),{mode:0o600});await assert.rejects(loadLocalLegacyProofProvider({...options,databaseId:'another'}));assert.equal(JSON.parse(await readFile(file,'utf8')).databaseId,intent.databaseId);
 await chmod(file,0o644);await assert.rejects(load());await chmod(file,0o600);await chmod(path.dirname(file),0o755);await assert.rejects(load());await chmod(path.dirname(file),0o700);
 await assert.rejects(provider({...context,token:{...context.token,contact_id:'other'}}),{code:'history_recertify_legacy_intent_invalid'});
 for(const field of ['grant_id','read_epoch','data_generation','barrier_generation'])await assert.rejects(provider({...context,token:{...context.token,[field]:`${context.token[field]}:changed`}}),{code:'history_recertify_legacy_intent_invalid'});
 await assert.rejects(provider({...context,target:{...context.target,checkedPartitions:[...context.target.checkedPartitions,'changed']}}),{code:'history_recertify_legacy_intent_invalid'});
 await assert.rejects(provider({...context,report:{...context.report,schemaFingerprint:'changed'}}),{code:'history_recertify_legacy_intent_invalid'});
 assert.equal(JSON.parse(await readFile(file,'utf8')).proofDigest,intent.proofDigest,'内存provider不能删除后来替换的文件');
 const claims=await Promise.allSettled([load(),load()]);assert.equal(claims.filter(x=>x.status==='fulfilled'&&typeof x.value==='function').length,1);assert.deepEqual(await readdir(path.dirname(file)),[]);
 await symlink('/synthetic/no-such-file',file);await assert.rejects(load());assert.equal((await lstat(file)).isSymbolicLink(),true,'无效symlink保留');
});

test('完成认证后普通历史、增量及重开均继续抑制三条撤回',async t=>{
 const f=await setup(t,async input=>proofFor(input));assert.equal((await f.service.recertify(f.contactA,{requestKey:'synthetic-maintenance-resume'})).state,'completed');
 f.state.inspectFactory=scope=>({...report,artifactSha256:'b'.repeat(64),continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,capabilities:{...report.capabilities,...capabilities}});
 f.state.pageFactory=(_scope,cursor,s)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:s.pageRecords,completedPartitions:[...target.partitions],exhausted:true,resumeCursor:'synthetic-tail-0'});
 f.channel.target=async()=>({...target,checkedPartitions:[...target.partitions]});f.channel.guardSession={loss:new Promise(()=>{})};
 await f.current.history.synchronize(f.contactA);assert.equal((await f.current.history.read(f.contactA)).messages.length,1);
 f.channel.tail=async(_scope,fixed,cursor)=>({target:fixed.descriptor,cursorIn:cursor,cursorOut:'synthetic-tail-1',caughtUp:true,records:[1,2,3,4,5].map(id=>record('shard-a',String(id)))});
 await f.current.history.synchronizeIncremental(f.contactA);assert.equal((await f.current.history.read(f.contactA)).messages.length,2);
 f.state.pageRecords=[1,2,3,4,5].map(id=>record('shard-a',String(id)));await restart(f,t);f.channel.guardSession={loss:new Promise(()=>{})};await f.current.history.synchronize(f.contactA);
 const visible=(await f.current.history.read(f.contactA)).messages;assert.equal(visible.length,2);assert.deepEqual(visible.map(m=>m.text).sort(),['合成正文4','合成正文5']);
 const saved=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(saved.terminals.length,3);assert.equal(saved.captures.filter(r=>r.reason_code==='source_recalled'&&JSON.parse(r.observed_key)[0]==='legacy-source').length,3);
});


test('无效维护意图只拒绝旧代次认证，普通启动、其他联系人同步与认证保持可用',async t=>{
 const userData=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-legacy-host-')));t.after(()=>rm(userData,{recursive:true,force:true}));await mkdir(path.join(userData,'managed/maintenance'),{recursive:true,mode:0o700});
 const options={userData,databaseId:'synthetic-db',currentExecutable:'/synthetic/current'};
 assert.equal(await loadHostLegacyProofProvider(options),undefined,'无维护文件时普通装配无需额外依赖');
 await writeFile(path.join(userData,'managed/maintenance/legacy-terminal-proof.json'),'{malformed',{mode:0o600});
 await assert.rejects(loadLocalLegacyProofProvider(options));const provider=await loadHostLegacyProofProvider(options);assert.equal(typeof provider,'function');
 const f=await setup(t,provider);await f.current.history.synchronize(f.contactB);assert.equal((await f.current.history.read(f.contactB)).messages.length,4);
 const otherToken=await f.current.contacts.eligibility(f.contactB);await f.current.storage.execute('history.markContinuityLost',{token:otherToken});
 assert.equal((await f.service.recertify(f.contactB,{requestKey:'synthetic-other-not-legacy'})).state,'completed');
 const blocked=await f.service.recertify(f.contactA,{requestKey:'synthetic-invalid-maintenance'});assert.equal(blocked.state,'failed');assert.equal(blocked.failure_code,'history_recertify_legacy_intent_invalid');assert.equal(blocked.page_count,0);
 assert.equal((await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA})).fences.length,1);
});


test('维护意图位于独立目录，未消费或无效文件不阻塞全局删除压缩',async t=>{
 const f=await fixture(t);const directory=path.join(f.root,'managed/maintenance');await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path.join(directory,'legacy-terminal-proof.json'),'{malformed',{mode:0o600});
 const compact=await f.current.storage.execute('deletion.compact',{});assert.equal(compact.storageState.unexpectedFiles,0);assert.equal(await readFile(path.join(directory,'legacy-terminal-proof.json'),'utf8'),'{malformed');
});

async function waitForFile(file){
 return await new Promise((resolve,reject)=>{let finished=false;const done=()=>readFile(file,'utf8').then(value=>{if(!finished){finished=true;clearTimeout(timer);watcher.close();resolve(value);}},()=>{});const watcher=watch(path.dirname(file),done),timer=setTimeout(()=>{if(!finished){finished=true;watcher.close();reject(Error('合成元数据进程未启动'));}},5000);done();});
}
test('停止认证会取消独立真实窄客户端元数据请求并等待子进程退出',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-legacy-cancel-')));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'bin'));await mkdir(path.join(root,'lib'));
 const executable=path.join(root,'bin/wechat-cli'),pidFile=path.join(root,'pid'),requestsFile=path.join(root,'requests');
 const script=`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(${JSON.stringify(requestsFile)},line+'\\n');});\n`;
 const hash=value=>createHash('sha256').update(value).digest('hex'),wcdb=Buffer.from('synthetic-only-WCDB');await writeFile(executable,script,{mode:0o700});await writeFile(path.join(root,'lib/libWCDB.dylib'),wcdb);
 await writeFile(path.join(root,'manifest.json'),JSON.stringify({formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',cliSha256:hash(script),wcdbSha256:hash(wcdb),signing:'ad-hoc-development',realWechatVerified:false}));
 const f=await setup(t,createNativeLegacyProofProvider({legacyExecutable:executable,currentExecutable:'/synthetic/must-not-start'}));
 const pending=f.service.recertify(f.contactA,{requestKey:'synthetic-native-cancel'});const pid=Number(await waitForFile(pidFile));await waitForFile(requestsFile);await f.service.stop(f.contactA);const stopped=await pending;
 assert.equal(stopped.state,'interrupted');assert.equal(stopped.page_count,0);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 const requests=(await readFile(requestsFile,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(requests.map(x=>x.op),['resolve']);
 assert.equal((await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA})).fences.length,1);
});


async function futureRecertify(t,f,options={}){
 const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});
 const create=()=>{const channel=f.create();if(options.changeTarget){const original=channel.target;channel.target=async scope=>({...await original(scope),checkedPartitions:[...target.partitions,'changed-partition']});}if(options.changeContract){const original=channel.inspect;channel.inspect=async scope=>({...await original(scope),statusSemantics:'changed-contract'});}return channel;};
 const service=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,create,f.current.holders,{stopHistory:id=>f.current.history.stop(id)});t.after(()=>service.close());
 return await service.recertify(f.contactA,{requestKey:options.key??'synthetic-future-no-sidecar'});
}
test('已发布证明在sidecar消耗后允许普通再次认证且三条撤回仍不入库',async t=>{
 const f=await setup(t,async input=>proofFor(input));assert.equal((await f.service.recertify(f.contactA,{requestKey:'synthetic-publish-legacy'})).state,'completed');
 const again=await futureRecertify(t,f);assert.equal(again.state,'completed',again.failure_code);assert.equal(again.message_count,1);
 const snapshot=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(snapshot.terminals.filter(x=>x.binding_id===snapshot.operations.at(-1).new_binding_id).length,3);assert.equal(snapshot.captures.filter(x=>x.reason_code==='source_recalled'&&JSON.parse(x.observed_key)[0]==='legacy-source').length,3);
});
for(const variant of ['target','contract'])test(`再次认证遇当前${variant}改变不复用旧物理抑制证明`,async t=>{
 const f=await setup(t,async input=>proofFor(input));assert.equal((await f.service.recertify(f.contactA,{requestKey:'synthetic-publish-before-change'})).state,'completed');
 const again=await futureRecertify(t,f,{changeTarget:variant==='target',changeContract:variant==='contract',key:`synthetic-future-${variant}`});assert.equal(again.state,'failed');assert.equal(again.page_count,0);
});
test('后来删除当前物理来源保留旧代次排除，再次认证不补回已删消息',async t=>{
 const f=await setup(t,async input=>proofFor(input));const first=await f.service.recertify(f.contactA,{requestKey:'synthetic-publish-before-delete'});assert.equal(first.state,'completed');
 const before=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA}),newBinding=before.operations.at(-1).new_binding_id,source=before.captures.find(r=>r.state==='normalized'&&before.messages.some(m=>m.id===r.message_id&&m.binding_id===newBinding));
 const op=await f.current.deletion.plan({ownerId:owner,requestKey:'synthetic-physical-source-deletion',scope:{kind:'source',contactId:f.contactA,sourceId:source.id}});assert.equal((await f.current.deletion.advance(op)).state,'completed');
 const again=await futureRecertify(t,f,{key:'synthetic-future-after-delete'});assert.equal(again.state,'completed',again.failure_code);assert.equal(again.message_count,0);
});


for(const count of [1,2,4])test(`合法旧新证明支持${count}条精确撤回候选而无用户数量硬编码`,async t=>{
 const f=await setup(t,async input=>proofFor(input),{recallLocals:Array.from({length:count},(_,i)=>String(i+1))});const done=await f.service.recertify(f.contactA,{requestKey:`synthetic-count-${count}`});assert.equal(done.state,'completed',done.failure_code);assert.equal(done.message_count,4-count);
});
for(const variant of ['same-table','other-table'])test(`已发布证明不扩大未知旧撤回${variant}`,async t=>{
 const f=await setup(t,async input=>proofFor(input));assert.equal((await f.service.recertify(f.contactA,{requestKey:'synthetic-publish-before-unknown'})).state,'completed');
 await f.current.storage.execute('fixture.legacyRecalls',{ownerId:owner,contactId:f.contactA,generation:'legacy-source',locals:['99'],append:true,...(variant==='other-table'?{table:'unproved-table'}:{})});
 const again=await futureRecertify(t,f,{key:`synthetic-future-unknown-${variant}`});assert.equal(again.state,'failed');assert.equal(again.failure_code,'history_recertify_suppression_unmapped');assert.equal(again.page_count,0);
});

test('同一装有已消费维护provider的服务再次认证只消费completed证明而不重调provider',async t=>{
 let calls=0;const f=await setup(t,async input=>{if(++calls>1)throw Error('一次维护意图不得重用');return proofFor(input);});
 assert.equal((await f.service.recertify(f.contactA,{requestKey:'synthetic-same-service-first'})).state,'completed');
 await f.current.storage.execute('history.markContinuityLost',{token:await f.current.contacts.eligibility(f.contactA)});
 const again=await f.service.recertify(f.contactA,{requestKey:'synthetic-same-service-again'});assert.equal(again.state,'completed',again.failure_code);assert.equal(calls,1);assert.equal(again.message_count,1);
});


test('非物理键scheme的旧撤回不进入维护候选且认证在正文前拒绝',async t=>{
 let calls=0;const f=await setup(t,async input=>{calls++;return proofFor(input);},{recallScheme:'unverified-legacy-key-v0'});const done=await f.service.recertify(f.contactA,{requestKey:'synthetic-untrusted-candidate-scheme'});assert.equal(done.state,'failed');assert.equal(done.failure_code,'history_recertify_suppression_unmapped');assert.equal(done.page_count,0);assert.equal(calls,0);
});
test('旧来源当时未supported不能借当前旧读取器supported状态补作证明',async t=>{
 const f=await setup(t,async input=>{const proof=proofFor(input);proof.legacy.report={...proof.legacy.report,status:'supported'};return proof;},{supportStatus:'unsupported'});const done=await f.service.recertify(f.contactA,{requestKey:'synthetic-untrusted-historical-support'});assert.equal(done.state,'failed');assert.equal(done.failure_code,'history_recertify_legacy_proof_invalid');assert.equal(done.page_count,0);
});
test('已存当前代系统替换优先保留，旧代撤回并存且未来无intent认证仍不复活',async t=>{
 const f=await setup(t,async input=>proofFor(input),{currentSystem:true});const first=await f.service.recertify(f.contactA,{requestKey:'synthetic-prior-system-terminal'});assert.equal(first.state,'completed');assert.equal(first.message_count,1);
 const again=await futureRecertify(t,f,{key:'synthetic-prior-system-future'});assert.equal(again.state,'completed',again.failure_code);assert.equal(again.message_count,1);const snap=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA}),binding=snap.operations.at(-1).new_binding_id;assert.equal(snap.terminals.filter(x=>x.binding_id===binding&&x.reason==='source_system_replaced').length,3);assert.equal(snap.captures.filter(x=>x.reason_code==='source_recalled'&&JSON.parse(x.observed_key)[0]==='legacy-source').length,3);
 await f.current.storage.execute('fixture.legacyRecalls',{ownerId:owner,contactId:f.contactA,generation:'legacy-source',locals:['1'],reason:'source_system_replaced',append:true});const unknown=await futureRecertify(t,f,{key:'synthetic-unknown-old-system-reason'});assert.equal(unknown.state,'failed');assert.equal(unknown.failure_code,'history_recertify_suppression_unmapped');assert.equal(unknown.page_count,0);
});
