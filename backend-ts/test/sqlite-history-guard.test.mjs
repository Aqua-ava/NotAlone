import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/memory-sqlite/support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {preflightGeneration} from '../src/history/sqlite/continuity.ts';

function emptyLegacyContinuityTx({tables=['history_continuity_fence','history_continuity_scope'],fenced=true,scope={
 owner_id:'owner',contact_id:'contact',conversation_id:'conversation',source_generation:'source-1',tables_json:''
}}={}){
 const names=new Set(tables),queries=[],runs=[];let hasFence=fenced,currentScope=scope;
 return {
  queries,runs,
  all(sql){assert.match(sql,/sqlite_schema/);return [...names].map(name=>({name}));},
  get(sql){queries.push(sql);
   if(sql.includes('FROM history_continuity_fence'))return hasFence?{present:1}:undefined;
   if(sql.includes('FROM history_continuity_scope'))return currentScope;
   if(sql.includes('FROM history_guard_lease')){assert.ok(names.has('history_guard_lease'),'must not query a guard table absent from this registry');return undefined;}
   if(sql.includes('FROM database_instance'))return {runtime_id:'runtime'};
   const artifact=[...names].find(name=>sql.includes(`FROM ${name} `));
   if(artifact)return undefined;
   throw new Error(`unexpected query: ${sql}`);
  },
  run(sql){runs.push(sql);
   if(sql.startsWith('DELETE FROM history_continuity_fence'))hasFence=false;
   else if(sql.startsWith('DELETE FROM history_continuity_scope'))currentScope=undefined;
   else if(sql.startsWith('DELETE FROM history_guard_lease'))assert.ok(names.has('history_guard_lease'));
   else throw new Error(`unexpected mutation: ${sql}`);
   return {changes:1};
  }
 };
}

function guardedChannelFactory(state){
 return ()=>{
  state.created++;let closed=false;let lost;const loss=new Promise(resolve=>{lost=resolve;});state.lose=()=>lost();
  return {guardSession:{loss},
   inspect:async scope=>({protocol:'private-history-v1',profileId:'synthetic-guarded',adapterVersion:'1',status:'supported',reason:null,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic',continuity:'synthetic-guard'}),
   target:async()=>({protocol:'private-history-v1',descriptor:'synthetic-guarded-target',partitions:['p'],tables:[{partition:'p',instance:'t'}],sourceGeneration:'source-1'}),
   page:async(_scope,target,cursor,signal)=>{await state.onPage?.(signal);return {target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[{partition:'p',table:'t',localId:'1',serverId:'0',sender:'contact',kind:'text',text:'合成守卫消息',originalType:'1',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['p'],exhausted:true};},
   close:async()=>{if(!closed){closed=true;state.closed++;lost();await state.onClose?.();}},
  };
 };
}

test('正文可用性只来自当前授权下的已核验活守卫，状态查询不打开渠道或读取正文',async t=>{
 const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state);let inspections=0,pages=0;
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const channel=create(),inspect=channel.inspect,page=channel.page;
  channel.inspect=async(...args)=>{inspections++;return {...await inspect(...args),capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))};};
  channel.page=async(...args)=>{pages++;return page(...args);};return channel;
 });
 t.after(()=>history.close());const contact=f.saved[0].contact_id;
 assert.equal(await history.bodyAvailable([contact]),false);assert.equal(state.created,0);
 await history.synchronize(contact);const counts=[state.created,inspections,pages];
 assert.equal(await history.bodyAvailable([contact]),true);assert.deepEqual([state.created,inspections,pages],counts);
 assert.equal(await history.bodyAvailable([f.saved[1].contact_id]),false);
 await f.contacts.setReading(false);assert.equal(await history.bodyAvailable([contact]),false);
 await history.stop(contact);assert.equal(await history.bodyAvailable([contact]),false);
});

test('历史已入库但缺少明确正文能力证明时，状态不能声称正文可用',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));
 t.after(()=>history.close());const contact=f.saved[0].contact_id;
 assert.equal((await history.synchronize(contact)).phase,'complete');
 assert.equal(await history.bodyAvailable([contact]),false);
 await history.close();
});

test('缺少正文必需能力时，已认证单次读取不能开启自动正文同步状态',async t=>{
 for(const missing of ['statusColumn','automaticAllocation','incrementalTail','restartContinuity','recoveryMapping'])await t.test(missing,async t=>{
  const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state);
  const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
   const channel=create(),inspect=channel.inspect;
   channel.inspect=async(...args)=>({...await inspect(...args),capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,key===missing?'unverified':'supported']))});
   return channel;
  });
  t.after(()=>history.close());const contact=f.saved[0].contact_id;
  await history.synchronize(contact);assert.equal(await history.bodyAvailable([contact]),false);await history.close();
 });
});

test('应用跨批次持有同一守卫，停读后释放并禁止自动续读',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const source=(await history.read(contact)).messages[0].sourceRecordIds[0];await history.synchronize(contact);
 assert.equal(state.created,1);assert.equal(state.closed,0);
 await history.stop(contact);assert.equal(state.closed,1);
 await assert.rejects(history.source(contact,source),{code:'history_source_not_found'});
 await assert.rejects(history.synchronize(contact),{code:'history_source_continuity_unverified'});
});

test('页预算用尽后在同一活守卫和目标内从已提交游标续读',async t=>{
 const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state),cursors=[];let targets=0;
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const channel=create(),target=channel.target;
  channel.target=async(...args)=>{targets++;return target(...args);};
  channel.page=async(scope,target,cursor)=>{
   const index=cursors.length;cursors.push(cursor);assert.equal(cursor,index===0?null:`page-${index}`);
   const final=index===1000;
   return {target:target.descriptor,cursorIn:cursor,cursorOut:final?null:`page-${index+1}`,
    records:index===0||final?[{partition:'p',table:'t',localId:final?'2':'1',serverId:'0',sender:'contact',kind:'text',text:`合成续读消息${index}`,originalType:'1',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'}]:[],
    completedPartitions:final?['p']:[],exhausted:final};
  };
  return channel;
 });
 t.after(()=>history.close().catch(()=>{}));const contact=f.saved[0].contact_id;
 const paused=await history.synchronize(contact);assert.equal(paused.phase,'incomplete');assert.equal(paused.failureCode,'history_page_budget_exhausted');assert.equal(paused.pageCount,1000);
 assert.equal(cursors.length,1000);assert.equal(state.created,1);assert.equal(state.closed,0);
 const complete=await history.synchronize(contact);assert.equal(complete.phase,'complete');assert.equal(complete.pageCount,1001);
 assert.equal(cursors.length,1001);assert.equal(cursors[1000],'page-1000');assert.equal(targets,1);assert.equal(state.created,1);assert.equal(state.closed,0);
 assert.equal((await history.read(contact)).messages.length,2);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});await history.close();
});

test('停读等待在途守卫真正关闭，迟到页不能保存',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),closeEntered=Promise.withResolvers(),release=Promise.withResolvers(),page=Promise.withResolvers();
 const state={created:0,closed:0,onPage:async()=>{entered.resolve();await page.promise;},onClose:async()=>{closeEntered.resolve();await release.promise;page.resolve();}};
 const history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id,reading=history.synchronize(contact).then(()=>null,error=>error);await entered.promise;
 let stopped=false;const stopping=history.stop(contact).then(()=>{stopped=true;});await closeEntered.promise;assert.equal(stopped,false);
 release.resolve();await stopping;assert.ok(await reading);assert.equal((await history.read(contact)).messages.length,0);assert.equal(state.closed,1);
});

test('无守卫的其他渠道不能借用同进程的活守卫读取正文',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);let pages=0;f.channel.page=async()=>{pages++;throw new Error('不得读取');};
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(pages,0);await history.close();
});

test('未正常关闭即重开数据库时，覆盖立即不完整且来源不能作为依据',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close().catch(()=>{}));
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const source=(await history.read(contact)).messages[0].sourceRecordIds[0];
 const databaseId=f.storage.status.databaseId;await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 const read=await reopened.execute('history.read',{ownerId:f.contacts.ownerId,contactId:contact,limit:100});assert.equal(read.replyEligibility,'history_incomplete');
 await assert.rejects(reopened.execute('history.source',{ownerId:f.contacts.ownerId,contactId:contact,recordId:source}),{code:'history_source_not_found'});
 const contacts={ownerId:f.contacts.ownerId,
  eligibility:contactId=>reopened.execute('identity.eligibility',{ownerId:f.contacts.ownerId,contactId}),
  validate:token=>reopened.execute('identity.validate',{ownerId:f.contacts.ownerId,token})};
 let channels=0,pages=0;
 const resumed=new SqliteHistoryService(reopened,contacts,()=>{channels++;const channel=guardedChannelFactory({created:0,closed:0})();channel.page=async()=>{pages++;throw new Error('不得读取');};return channel;});
 t.after(()=>resumed.close());
 await assert.rejects(resumed.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(channels,0);assert.equal(pages,0);
});

test('删除来源会排空空闲守卫，并使该来源不能自动续读',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const source=(await history.read(contact)).messages[0].sourceRecordIds[0];
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,history.holders,new ManagedFiles(f.root));const op=await deletion.plan({ownerId:f.contacts.ownerId,requestKey:'synthetic-guarded-source-delete',scope:{kind:'source',contactId:contact,sourceId:source}});
 assert.equal((await deletion.advance(op)).state,'completed');assert.equal(state.closed,1);
 await assert.rejects(history.synchronize(contact),{code:'history_source_continuity_unverified'});assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('守卫失效后，跨联系人资料依赖的旧回复也失效',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/quarantine-registry.mjs',import.meta.url).href}),state={created:0,closed:0};
 const history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());const [a,b]=f.saved;
 await history.synchronize(a.contact_id);const message=(await history.read(a.contact_id)).messages[0];
 const {SqliteDiscussionService}=await import('../src/reply/sqlite/service.ts'),{randomUUID}=await import('node:crypto');
 const discussion=new SqliteDiscussionService(f.storage,f.contacts.ownerId),d=await discussion.newDiscussion(b.contact_id),key='synthetic-guard-dependency';
 const confirmationId=await f.contacts.manualConfirm(b.contact_id,key),attempt=(await discussion.begin(b.contact_id,key,'合成手写内容',{kind:'manual',confirmationId},d.id)).attempt,contextId=randomUUID();
 await f.storage.execute('discussion.freezeContext',{...attempt,contextId,skillRun:{packages:[],eligible:[]},items:[],at:Date.now()});
 await f.storage.execute('fixture.seedCrossContactInput',{ownerId:f.contacts.ownerId,contextId,sourceContactId:a.contact_id,messageId:message.id,recordId:message.sourceRecordIds[0]});
 assert.ok(!(await f.storage.execute('fixture.quarantineImpact',{ownerId:f.contacts.ownerId})).requests.includes(attempt.requestId));
 await history.stop(a.contact_id);
 assert.ok((await f.storage.execute('fixture.quarantineImpact',{ownerId:f.contacts.ownerId})).requests.includes(attempt.requestId));
 await assert.rejects(discussion.trace(b.contact_id,d.id,attempt.requestId),{code:'discussion_unavailable'});
 assert.equal((await discussion.view(b.contact_id,d.id)).entries[0].body,'合成手写内容');
});

test('后台守卫意外退出后持久停读，不能凭新渠道自动恢复',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);state.lose();
 await assert.rejects(history.synchronize(contact),{code:'history_source_continuity_unverified'});
 assert.equal(state.created,1);
});

test('守卫意外退出时立即中断在途读取，不等待失证写入',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),pageGate=Promise.withResolvers(),releaseGate=Promise.withResolvers();
 let pageSignal;const state={created:0,closed:0,onPage:async signal=>{pageSignal=signal;entered.resolve();await pageGate.promise;}};
 const proxy={status:f.storage.status,execute:async(name,input,...rest)=>{if(name==='history.guardRelease')await releaseGate.promise;return f.storage.execute(name,input,...rest);},close:()=>f.storage.close()};
 const history=new SqliteHistoryService(proxy,f.contacts,guardedChannelFactory(state));t.after(async()=>{pageGate.resolve();releaseGate.resolve();await history.close().catch(()=>{});});
 const contact=f.saved[0].contact_id,reading=history.synchronize(contact).then(()=>null,error=>error);await entered.promise;
 state.lose();await Promise.resolve();
 try{assert.equal(pageSignal.aborted,true);}finally{pageGate.resolve();releaseGate.resolve();}
 assert.ok(await reading);assert.equal((await history.read(contact)).messages.length,0);
});

test('尚未读取时守卫已经退出，不能进入正文分页',async t=>{
 const f=await fixture(t),state={created:0,closed:0};let pages=0;
 const create=guardedChannelFactory(state),history=new SqliteHistoryService(f.storage,f.contacts,()=>{const channel=create();channel.guardSession={loss:Promise.resolve()};channel.page=async()=>{pages++;throw new Error('不得读取');};return channel;});
 t.after(()=>history.close().catch(()=>{}));const contact=f.saved[0].contact_id;
 await assert.rejects(history.synchronize(contact));assert.equal(pages,0);assert.equal((await history.coverage(contact)).phase,'incomplete');
});

test('无法持久记录失证时关闭存储，重开后不能冒充守卫仍在线',async t=>{
 const f=await fixture(t),state={created:0,closed:0};
 const proxy={status:f.storage.status,execute:(name,input,...rest)=>name==='history.guardRelease'?Promise.reject(new StorageFailure('storage_busy')):f.storage.execute(name,input,...rest),close:()=>f.storage.close()};
 const history=new SqliteHistoryService(proxy,f.contacts,guardedChannelFactory(state));t.after(()=>history.close().catch(()=>{}));
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const databaseId=f.storage.status.databaseId;
 await assert.rejects(history.stop(contact),{code:'storage_busy'});assert.equal(state.closed,1);
 await assert.rejects(f.storage.execute('history.read',{ownerId:f.contacts.ownerId,contactId:contact}),{code:'worker_failed'});
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 assert.equal((await reopened.execute('history.read',{ownerId:f.contacts.ownerId,contactId:contact,limit:100})).replyEligibility,'history_incomplete');
});

test('无守卫租约的预目标失败空范围只清除围栏与空范围元数据',async()=>{
 const artifacts=['read_goal','sync_capture','capture_record','message','message_alias','history_message_quarantine',
  'history_deletion_fence','history_source_exclusion','history_cutoff','history_cutoff_member','history_restore'];
 const tx=emptyLegacyContinuityTx({tables:['history_continuity_fence','history_continuity_scope','history_guard_lease','database_instance',...artifacts]});
 assert.equal(preflightGeneration(tx,{owner_id:'owner',contact_id:'contact',conversation_id:'conversation',source_generation:'source-1'}),true);
 assert.deepEqual(tx.runs.map(sql=>sql.split(' WHERE ')[0]),[
  'DELETE FROM history_guard_lease','DELETE FROM history_continuity_fence','DELETE FROM history_continuity_scope'
 ]);
 assert.match(tx.runs[0],/state='lost'/,'仅允许删除失效租约；本模型中没有租约行');
 assert.equal(tx.queries.some(sql=>sql.includes('FROM history_guard_lease')),true,'只检查租约表，不要求必须存在租约');
 assert.equal(preflightGeneration(tx,{owner_id:'owner',contact_id:'contact',conversation_id:'conversation',source_generation:'source-1'}),true);
 assert.equal(tx.runs.length,3,'重试预检不重复清理或写入目标、历史数据');
});

test('较旧精简注册表缺少可选状态表时，空范围恢复仅查已存在表',async()=>{
 const tx=emptyLegacyContinuityTx();
 assert.equal(preflightGeneration(tx,{owner_id:'owner',contact_id:'contact',conversation_id:'conversation',source_generation:'source-1'}),true);
 assert.deepEqual(tx.runs.map(sql=>sql.split(' WHERE ')[0]),[
  'DELETE FROM history_continuity_fence','DELETE FROM history_continuity_scope'
 ]);
 assert.ok(tx.queries.every(sql=>!/(history_guard_lease|read_goal|sync_capture|capture_record|message_alias|message_quarantine|deletion_fence|source_exclusion|history_cutoff|history_restore)/.test(sql)),
  '缺失于 schema 的表不应被直接查询');
});

test('空历史首次尝试的守卫断开后可安全重建连续性，旧守卫仍失效',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-guard-1'}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),true);
 assert.equal(await f.storage.execute('history.guardRelease',{token,guardId:'synthetic-guard-1'}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),false);
 assert.equal((await f.service.coverage(contact)).phase,'incomplete','释放守卫先持久化围栏');
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true,'无历史和边界时，预检重建空的连续性基线');
 assert.equal((await f.service.coverage(contact)).phase,'not_started','只清除了围栏元数据，没有制造历史覆盖');
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-guard-2'}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),false,'旧守卫凭证不能恢复');
 assert.equal((await f.service.coverage(contact)).messageCount,0);
});

test('同范围活守卫的竞争申请失败但不毒化当前守卫',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-live-guard'}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-competing-guard'}),false);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-live-guard'}),true);
});

test('已观察目标即使无消息也不允许自动重建连续性基线',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.preflightContinuity',{token,target:f.target}),true);
 await f.storage.execute('history.markContinuityLost',{token});
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),false,'目标分片清单已经成为读取基线的一部分');
 assert.equal((await f.service.coverage(contact)).messageCount,0);
});

test('仅有未完成目标且没有捕获正文时仍保留连续性围栏',async t=>{
 const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state),contact=f.saved[0].contact_id;
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const channel=create();channel.page=async()=>{throw new StorageFailure('history_native_unavailable');};return channel;
 });t.after(()=>history.close());
 await assert.rejects(history.synchronize(contact),{code:'history_native_unavailable'});
 const coverage=await history.coverage(contact);assert.equal(coverage.phase,'incomplete');assert.equal(coverage.messageCount,0);
 const token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),false,'读目标自身也是受保护的续读资料');
 assert.equal((await history.coverage(contact)).failureCode,'history_source_continuity_unverified');
});

test('实际数据库重开后的运行代次不同，未续证的旧守卫不能续读',async t=>{
 const f=await fixture(t),token=await f.contacts.eligibility(f.saved[0].contact_id);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-guard-1'}),true);
 const databaseId=f.storage.status.databaseId;await f.service.close();await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 assert.equal(await reopened.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),false);
 assert.equal(await reopened.execute('history.preflightGeneration',{token}),false);
 assert.equal(await reopened.execute('history.guardAcquire',{token,guardId:'synthetic-guard-2'}),false);
});

test('历史已有消息而没有守卫基线时，不允许把新守卫冒充旧来源',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;await f.service.synchronize(contact);
 const token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-new-guard'}),false);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),false);
});

test('明确重读尚未接入守卫时在读取正文前停下',async t=>{
 const f=await fixture(t),state={created:0,closed:0};let pages=0;
 const {SqliteHistoryResyncService}=await import('../src/history/sqlite/resync.ts'),create=guardedChannelFactory(state);
 const resync=new SqliteHistoryResyncService(f.storage,f.contacts,()=>{const channel=create();channel.page=async()=>{pages++;throw new Error('不得读取');};return channel;});t.after(()=>resync.close());
 await assert.rejects(resync.resync(f.saved[0].contact_id,{requestKey:'synthetic-guarded-resync'}),{code:'history_source_continuity_unverified'});
 assert.equal(pages,0);assert.equal(state.closed,1);
});

test('联系人删除包含守卫持久记录并保持外键完整',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-delete-guard'}),true);
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const op=await deletion.plan({ownerId:token.owner_id,requestKey:'synthetic-guard-delete',scope:{kind:'contact',contactId:contact}});
 assert.equal((await deletion.advance(op)).state,'completed');assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
