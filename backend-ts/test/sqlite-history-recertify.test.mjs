import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,report,target,restart} from './sqlite-clear-support.mjs';
import {recertifySetup as setup,gate} from './fixtures/history/recertify-reader.mjs';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {SqliteHistoryClearHttp} from '../src/history/sqlite/clear-http.ts';

test('原地恢复保留绑定授权和旧消息，只续读水位之后的新消息并幂等重放',{timeout:10000},async t=>{
 const f=await setup(t),before=await f.snapshot();f.state.pageRecords.push(record('shard-a','2'));
 const done=await f.service.recertify(f.contactA,{requestKey:'in-place'});assert.equal(done.state,'completed',JSON.stringify(done));
 const current=await f.current.contacts.eligibility(f.contactA),after=await f.snapshot();
 assert.equal(current.binding_id,f.old.binding_id);assert.equal(current.grant_id,f.old.grant_id);assert.deepEqual(after.bindings,before.bindings);assert.deepEqual(after.grants,before.grants);
 assert.deepEqual(f.state.readIds,['2']);assert.ok(after.messages.some(m=>m.id===f.saved.id));assert.equal(after.messages.length,2);assert.equal(after.fences.length,0);
 assert.equal(after.operations[0].new_binding_id,null);assert.equal((await f.current.history.readChat(f.contactB)).messages.length,1);
 const count=f.channels.length;assert.deepEqual(await f.service.recertify(f.contactA,{requestKey:'in-place'}),done);assert.equal(f.channels.length,count);assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
const quoteCarrier=(localId,failed=false)=>record('shard-a',localId,{kind:'other',text:null,originalType:'244813135921',metadataOnly:true,stateAssurance:'unverified',...(failed?{quoteErrorCode:'history_quote_unavailable'}:{quote:{replyText:'合成的引用回复',referencedText:'仅用于回归的引文',referencedSender:null,referencedSenderRole:'contact',referencedType:'1',referencedServerId:null,proofDigest:'a'.repeat(64)}})});
test('原地续读使用普通引用路径保存新引用及单条引用失败',{timeout:10000},async t=>{
 for(const failed of [false,true]){const f=await setup(t);f.state.pageRecords.push(quoteCarrier('2',failed));const done=await f.service.recertify(f.contactA,{requestKey:`quote-${failed}`});assert.equal(done.state,'completed',JSON.stringify(done));
 const carrier=(await f.current.history.readChat(f.contactA)).messages.find(m=>m.originalType==='244813135921');assert.ok(carrier);if(failed)assert.equal(carrier.quoteErrorCode,'history_quote_unavailable');else assert.equal(carrier.quote.replyText,'合成的引用回复');}
});
test('已检查文件集合内增加会话表沿增长证明接纳，不改变旧表水位或绑定',{timeout:10000},async t=>{
 const f=await setup(t),before=await f.snapshot();f.state.targetOverride.tables=[...target.tables,{partition:'shard-b',instance:'table-added'}];f.state.reportOverride.schemaFingerprint='c'.repeat(64);f.state.pageRecords.push({...record('shard-b','1'),table:'table-added'});
 const done=await f.service.recertify(f.contactA,{requestKey:'allowed-table-growth'});assert.equal(done.state,'completed',JSON.stringify(done));const after=await f.snapshot();assert.equal(after.fences.length,0);assert.equal(after.bindings.length,1);assert.equal(after.messages.length,2);assert.ok(after.messages.some(row=>row.id===f.saved.id));assert.deepEqual(after.bindings,before.bindings);assert.deepEqual(f.state.readIds,['1']);assert.equal(f.state.positions.find(position=>position.partition==='shard-a').maxLocalId,'1');
});
test('锚点核验前来源账号会话代次表实例或checked集合变化仍围栏且不读新正文',{timeout:10000},async t=>{
 for(const variant of ['account','conversation','generation','table','checked','missing-table']){const f=await setup(t);
 if(variant==='account')f.state.reportOverride.accountKey='different-account';if(variant==='conversation')f.state.reportOverride.conversationKey='different-conversation';if(variant==='generation')f.state.reportOverride.sourceGeneration='different-generation';
 if(variant==='table')f.state.targetOverride.tables=[{partition:'shard-a',instance:'replaced'}];if(variant==='checked')f.state.targetOverride.checkedPartitions=['different-file'];if(variant==='missing-table')f.state.targetOverride.tables=[];
 const done=await f.service.recertify(f.contactA,{requestKey:`changed-${variant}`});assert.equal(done.state,'failed',JSON.stringify(done));assert.equal(f.state.readIds.length,0);const after=await f.snapshot();assert.equal(after.fences.length,1);assert.equal(after.bindings.length,1);assert.equal(after.messages.length,1);}
});
test('恢复计划到原子接纳之间发生来源删除，旧删除代次不能被重新接纳',{timeout:10000},async t=>{
 const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage);let planned=false;
 f.current.storage.execute=async(name,input,...rest)=>{if(name==='history.prepareRecoveredGuard'&&!planned){planned=true;await f.current.deletion.plan({ownerId:owner,requestKey:'delete-before-recovery-accept',scope:{kind:'source',contactId:f.contactA,sourceId:f.saved.sourceRecordIds[0]}});}return execute(name,input,...rest);};
 const done=await f.service.recertify(f.contactA,{requestKey:'delete-race'});assert.equal(done.state,'failed',JSON.stringify(done));assert.equal(planned,true);assert.equal(f.state.readIds.length,0);assert.equal((await f.snapshot()).fences.length,1);
});
test('联系人全局删除围栏仍阻断原地恢复，不以元数据核验替代清空保护',{timeout:10000},async t=>{
 const f=await setup(t);await f.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:f.contactA,mode:'globalFence'});const done=await f.service.recertify(f.contactA,{requestKey:'global-fence'});assert.equal(done.state,'failed',JSON.stringify(done));assert.deepEqual(f.state.readIds,[]);assert.equal((await f.snapshot()).fences.length,1);assert.equal((await f.snapshot()).messages.length,1);
});
test('未围栏联系人保持not_required，不建立虚假恢复操作',{timeout:10000},async t=>{
 const f=await setup(t);await assert.rejects(f.service.recertify(f.contactB,{requestKey:'not-required'}),{code:'history_recertify_not_required'});assert.equal((await f.service.status(f.contactB)).state,'none');
});
test('读取暂时失败保留既有消息与围栏，不建立跨绑定半成品',{timeout:10000},async t=>{
 const f=await setup(t);f.state.pageHook=()=>{throw new StorageFailure('history_source_changed');};const done=await f.service.recertify(f.contactA,{requestKey:'body-failure'});assert.equal(done.state,'failed',JSON.stringify(done));const after=await f.snapshot();assert.equal(after.messages.length,1);assert.equal(after.bindings.length,1);assert.equal(after.fences.length,1);
});
test('同一绑定的撤回终态和quarantine不因元数据恢复而解除',{timeout:10000},async t=>{
 for(const mode of ['terminal','quarantine']){const f=await setup(t);await f.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:f.contactA,mode});const before=await f.snapshot();const done=await f.service.recertify(f.contactA,{requestKey:`terminal-${mode}`});assert.equal(done.state,'completed',JSON.stringify(done));const after=await f.snapshot();assert.deepEqual(after.terminals,before.terminals);assert.deepEqual(after.quarantines,before.quarantines);assert.equal(after.messages.length,1);assert.deepEqual(f.state.readIds,[]);if(mode==='quarantine')assert.equal((await f.current.history.readChat(f.contactA)).messages.length,0);}
});
test('来源排除及清空边界不被原地恢复或新增localId绕过，不挂接重新同步许可',{timeout:10000},async t=>{
 const excluded=await setup(t);await excluded.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:excluded.contactA,mode:'exclusion'});assert.equal((await excluded.service.recertify(excluded.contactA,{requestKey:'source-exclusion'})).state,'completed');assert.deepEqual(excluded.state.readIds,[]);assert.equal((await excluded.snapshot()).messages.length,1);
 const f=await setup(t);f.state.boundaryMembers=[{partition:'shard-a',localId:'1'}];await f.current.clear.clear(f.contactA);const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});f.state.pageRecords.push(record('shard-a','2'));
 const done=await f.service.recertify(f.contactA,{requestKey:'cutoff'});assert.equal(done.state,'completed',JSON.stringify(done));assert.equal((await f.current.history.readChat(f.contactA)).messages.length,1);assert.equal((await f.current.resync.status(f.contactA)).state,'none');
});
test('独立HTTP固定request_key且投影无内部证明，同请求重放不再读取',{timeout:10000},async t=>{
 const f=await setup(t),http=new SqliteHistoryClearHttp(f.current.clear,f.current.resync,f.service),server=createServer((req,res)=>{void http.handle(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${f.contactA}/history/recertify`;assert.equal((await fetch(url,{method:'POST',body:JSON.stringify({request_key:'bad',target:'injected'})})).status,400);
 const accepted=await fetch(url,{method:'POST',body:JSON.stringify({request_key:'http-in-place'})});assert.equal(accepted.status,202);assert.doesNotMatch(JSON.stringify(await accepted.json()),/binding_id|token_json|guard_id|合成正文/);
 const done=await f.service.recertify(f.contactA,{requestKey:'http-in-place'});assert.equal(done.state,'completed');const count=f.channels.length;assert.deepEqual(await (await fetch(url,{method:'POST',body:JSON.stringify({request_key:'http-in-place'})})).json(),done);assert.equal(f.channels.length,count);
});
test('恢复中关闭读取后失败停读且同请求不重新读取',{timeout:10000},async t=>{
 const f=await setup(t);f.state.pageHook=()=>f.current.contacts.setReading(false);const done=await f.service.recertify(f.contactA,{requestKey:'reading-off'});assert.equal(done.state,'failed',JSON.stringify(done));const count=f.channels.length;assert.deepEqual(await f.service.recertify(f.contactA,{requestKey:'reading-off'}),done);assert.equal(f.channels.length,count);assert.equal((await f.snapshot()).fences.length,1);
});
test('元数据核对期间撤销当前授权，不恢复旧授权或接受后续正文',{timeout:10000},async t=>{
 const f=await setup(t);f.state.recoverHook=async()=>{await f.current.contacts.revoke(f.contactA,f.old.binding_id,f.old.selection_generation);};
 const done=await f.service.recertify(f.contactA,{requestKey:'revoke-during-recovery'});assert.equal(done.state,'failed',JSON.stringify(done));assert.deepEqual(f.state.readIds,[]);await assert.rejects(f.current.contacts.eligibility(f.contactA));const after=await f.snapshot();assert.equal(after.bindings.length,1);assert.equal(after.grants.length,1);assert.notEqual(after.grants[0].revoked_at,null);assert.equal(after.messages.length,1);
});
test('接纳前未完成删除保留deletion_pending，不伪造恢复操作',{timeout:10000},async t=>{
 const f=await setup(t);await f.current.deletion.plan({ownerId:owner,requestKey:'pending-delete',scope:{kind:'source',contactId:f.contactA,sourceId:f.saved.sourceRecordIds[0]}});await assert.rejects(f.service.recertify(f.contactA,{requestKey:'blocked'}),{code:'history_recertify_deletion_pending'});assert.equal((await f.service.status(f.contactA)).state,'none');
});
test('删除恰逢Prepare前仍排空holder，资格失效不被not_found覆盖',{timeout:10000},async t=>{
 const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage);let deleting,triggered=false;f.current.storage.execute=async(name,input,...rest)=>{if(name==='history.recertifyPrepare'&&!triggered){triggered=true;const plan=await f.current.deletion.plan({ownerId:owner,requestKey:'prepare-delete',scope:{kind:'contact',contactId:f.contactA}});deleting=f.current.deletion.advance(plan);}return execute(name,input,...rest);};await assert.rejects(f.service.recertify(f.contactA,{requestKey:'prepare-race'}),error=>error.code!=='history_recertify_not_found');assert.equal((await deleting).state,'completed');assert.equal((await f.snapshot()).operations.length,0);assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('原地续读阻塞时来源联系人账号删除仍排空holder，不重造围栏或认证审计',{timeout:15000},async t=>{
 for(const kind of ['source','contact','account']){const f=await setup(t),entered=gate(),hold=gate();f.state.pageHook=async()=>{entered.resolve();await hold.promise;};f.state.closeHook=async entry=>{if(f.channels.includes(entry.channel))hold.resolve();};
 const pending=f.service.recertify(f.contactA,{requestKey:`drain-${kind}`});await entered.promise;
 const scope=kind==='account'?{kind}:kind==='source'?{kind,contactId:f.contactA,sourceId:f.saved.sourceRecordIds[0]}:{kind,contactId:f.contactA};
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:`delete-during-resume-${kind}`,scope});const removed=await f.current.deletion.advance(plan);assert.equal(removed.state,'completed',JSON.stringify(removed.checks));assert.equal((await pending).completed,false);
 const snapshot=await f.snapshot();assert.equal(snapshot.messages.length,0);if(kind!=='source'){assert.equal(snapshot.operations.length,0);assert.equal(snapshot.fences.length,0);}else assert.ok(['failed','interrupted'].includes(snapshot.operations[0].state));assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 }
});

test('原地续读接受一页后硬中断，重启从已接纳水位继续且不复制消息',{timeout:15000},async t=>{
 const f=await setup(t),entered=gate(),hold=gate();let pageNo=0;f.state.closeHook=async entry=>{if(f.channels.includes(entry.channel))hold.resolve();};f.state.pageRecords.push(record('shard-a','2'),record('shard-a','3'));
 f.state.pageFactory=async({used,cursor})=>{if(++pageNo===1)return {target:used.descriptor,cursorIn:cursor,cursorOut:'reader-signed-next-page',records:[record('shard-a','2')],completedPartitions:[],exhausted:false};entered.resolve();await hold.promise;return {target:used.descriptor,cursorIn:cursor,cursorOut:null,records:[record('shard-a','3')],completedPartitions:[...used.partitions],exhausted:true};};
 const pending=f.service.recertify(f.contactA,{requestKey:'crashed-in-place'});pending.catch(()=>{});await entered.promise;assert.equal((await f.snapshot()).messages.length,2);await f.current.storage.close();hold.resolve();await assert.rejects(pending,{code:'worker_failed'});await f.service.close();
 f.state.pageFactory=null;f.channel=f.reader.create();await restart(f,t);assert.equal((await f.current.recertify.status(f.contactA,'crashed-in-place')).state,'interrupted');f.state.readIds=[];
 await f.current.history.synchronize(f.contactA);const after=await f.snapshot();assert.equal(after.fences.length,0);assert.equal(after.bindings.length,1);assert.equal(after.messages.length,3);assert.deepEqual(f.state.readIds,['3']);assert.equal((await f.current.contacts.eligibility(f.contactA)).binding_id,f.old.binding_id);assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('来源认证完成清洁关闭后，仅重验元数据即可供记忆使用，不重读历史或创建目标',{timeout:10000},async t=>{
 const f=await setup(t);const done=await f.service.recertify(f.contactA,{requestKey:'memory-source-ready'});assert.equal(done.state,'completed');
 const before=await f.snapshot(),token=await f.current.contacts.eligibility(f.contactA);
 const source=before.captures.find(r=>before.messages.some(m=>m.id===r.message_id&&m.binding_id===token.binding_id));
 const ref={owner_id:owner,contact_id:f.contactA,record_id:source.id,message_id:source.message_id};
 await assert.rejects(f.current.storage.execute('fixture.recertifyAssertSource',ref),{code:'history_source_not_available'});
 f.state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
 f.channel.guardSession={loss:new Promise(()=>{})};const pageCalls=f.state.pageCalls;
 const execute=f.current.storage.execute.bind(f.current.storage),actions=[];f.current.storage.execute=async(name,...args)=>{actions.push(name);return execute(name,...args);};
 f.channel.page=async()=>{throw new Error('来源就绪不能读取正文页');};f.channel.tail=async()=>{throw new Error('来源就绪不能读取增量正文');};
 await f.current.history.ensureSourceReady(f.contactA);
 assert.equal(await f.current.storage.execute('fixture.recertifyAssertSource',ref),true);
 assert.equal(f.state.pageCalls,pageCalls);assert.equal(actions.some(name=>['history.begin','history.beginIncremental','history.acceptPage','history.acceptTail'].includes(name)),false);const after=await f.snapshot();assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.captures,before.captures);assert.deepEqual(after.operations,before.operations);
 assert.equal(after.leases[0].state,'active');
});

test('派生来源元数据就绪拒绝真实来源变化及严格档lost租约，不读取正文',{timeout:10000},async t=>{
 for(const changed of ['table','account','strict']){
  const f=await setup(t);assert.equal((await f.service.recertify(f.contactA,{requestKey:`source-ready-${changed}`})).state,'completed');
  f.state.inspectFactory=scope=>({...report,continuity:changed==='strict'?'synthetic-generation-1':'same-source-instances-normal-use-v1',accountKey:changed==='account'?'different-account':scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
  f.channel.guardSession={loss:new Promise(()=>{})};f.channel.page=async()=>{throw new Error('拒绝前不得读取正文');};
  if(changed==='table')f.channel.target=async()=>({...target,tables:target.tables.map(t=>({...t,instance:t.instance+'-changed'}))});
  if(changed==='fence')await f.current.storage.execute('history.markContinuityLost',{token:await f.current.contacts.eligibility(f.contactA)});
  await assert.rejects(f.current.history.ensureSourceReady(f.contactA),error=>['history_source_continuity_unverified','history_external_scope_changed'].includes(error.code),changed);
  assert.notEqual((await f.snapshot()).leases[0].state,'active',changed);
 }
});
test('派生来源元数据就绪与同联系人同步互斥，明确返回忙且不轮询',{timeout:10000},async t=>{
 const f=await setup(t);assert.equal((await f.service.recertify(f.contactA,{requestKey:'source-ready-busy'})).state,'completed');
 let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 f.state.inspectFactory=async scope=>{enter();await gate;return {...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation};};
 f.channel.guardSession={loss:new Promise(()=>{})};
 const pending=f.current.history.ensureSourceReady(f.contactA);await entered;
 await assert.rejects(f.current.history.ensureSourceReady(f.contactA),{code:'history_already_running'});release();await pending;
});

test('来源认证正常关闭后，历史记忆启动经元数据续证建轮且不重读聊天',{timeout:10000},async t=>{
 const f=await setup(t);assert.equal((await f.service.recertify(f.contactA,{requestKey:'memory-start-after-recertify'})).state,'completed');
 f.state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});f.channel.guardSession={loss:new Promise(()=>{})};
 f.channel.page=async()=>{throw new Error('记忆启动不能重读微信正文');};f.channel.tail=async()=>{throw new Error('记忆启动不能读取增量正文');};
 const port={prepare:async()=>{throw new StorageFailure('model_not_configured');},invoke:async()=>{throw new Error('禁止真实模型调用');}};
 const memory=new SqliteMemoryExtraction(f.current.storage,owner,port,f.current.holders,undefined,id=>f.current.history.ensureSourceReady(id));t.after(()=>memory.close());
 const started=await memory.startHistory(f.contactA,randomUUID());assert.equal(started.contactId,f.contactA);assert.equal(started.run.total,1);await memory.waitForIdle();
 assert.equal((await f.snapshot()).leases[0].state,'active');
});

test('来源元数据重验期间撤销读取或关闭服务，不能恢复活来源',{timeout:10000},async t=>{
 for(const mode of ['reading-off','closed']){
  const f=await setup(t);assert.equal((await f.service.recertify(f.contactA,{requestKey:`source-ready-${mode}`})).state,'completed');
  f.state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});f.channel.guardSession={loss:new Promise(()=>{})};
  const targetOf=f.channel.target;let release,entered;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.channel.target=async scope=>{entered();await gate;return targetOf(scope);};f.channel.close=async()=>{release();};
  const pending=f.current.history.ensureSourceReady(f.contactA);await ready;
  if(mode==='reading-off'){await f.current.contacts.setReading(false);release();await assert.rejects(pending);}
  else{const closed=f.current.history.close();await assert.rejects(pending,{code:'history_interrupted'});await closed;}
  assert.notEqual((await f.snapshot()).leases[0].state,'active',mode);
 }
});

test('严格档已有活守卫时来源目标变化仍阻断派生处理',{timeout:10000},async t=>{
 const f=await fixture(t);f.state.pageRecords=[record('shard-a','1')];f.channel.guardSession={loss:new Promise(()=>{})};await f.current.history.synchronize(f.contactA);
 f.channel.target=async()=>({...target,tables:target.tables.map(t=>({...t,instance:t.instance+'-changed'}))});
 await assert.rejects(f.current.history.ensureSourceReady(f.contactA),{code:'history_source_continuity_unverified'});
});
