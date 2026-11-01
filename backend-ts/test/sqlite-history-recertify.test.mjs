import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,report,createChannel,target,identity,restart} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {createServer} from 'node:http';
import {SqliteHistoryClearHttp} from '../src/history/sqlite/clear-http.ts';

async function setup(t,options={}) {
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/recertify-registry.mjs',import.meta.url).href});f.state.pageRecords=options.oldRecords??[record('shard-a','1')];
 await f.current.history.synchronize(f.contactA);await f.current.history.synchronize(f.contactB);
 const old=await f.current.contacts.eligibility(f.contactA),saved=(await f.current.history.read(f.contactA)).messages[0];
 await f.current.storage.execute('history.markContinuityLost',{token:old});
 const channels=[];let pageHook,channelHook;
 const create=()=>{const {channel,state}=createChannel();state.pageRecords=[record('shard-a','1')];
  state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
  channel.guardSession={loss:new Promise(()=>{})};state.pageHook=async()=>pageHook?.();channelHook?.(channel,state,channels.length);channel.resumeTarget=()=>{throw new Error('认证不能接续旧游标');};channels.push({channel,state});return channel;};
 const service=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,create,f.current.holders,{stopHistory:id=>f.current.history.stop(id)});t.after(()=>service.close());
 return {...f,old,saved,channels,service,setPageHook:hook=>{pageHook=hook;},setChannelHook:hook=>{channelHook=hook;},snapshot:()=>f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA})};
}
test('重新认证保留旧消息但以新绑定隔离，全量完成前围栏不放行，完成后同键新消息不合并旧来源',async t=>{
 const f=await setup(t);let during;const original=await f.snapshot();
 f.setPageHook(async()=>{during=await f.current.history.read(f.contactA);assert.equal(during.messages.length,0);});
 const done=await f.service.recertify(f.contactA,{requestKey:'synthetic-recertify-1'});
 assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.completed,true);assert.equal(done.message_count,1);assert.equal(done.preserved_message_count,1);
 assert.ok(during);const current=await f.current.contacts.eligibility(f.contactA);assert.notEqual(current.binding_id,f.old.binding_id);assert.notEqual(current.grant_id,f.old.grant_id);
 f.state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});f.channel.guardSession={loss:new Promise(()=>{})};await f.current.history.synchronize(f.contactA);
 const after=await f.current.history.read(f.contactA);assert.equal(after.messages.length,1);assert.notEqual(after.messages[0].id,f.saved.id);
 await assert.rejects(f.current.storage.execute('history.source',{ownerId:owner,contactId:f.contactA,recordId:f.saved.sourceRecordIds[0]}),{code:'history_source_not_found'});
 assert.equal(await f.current.storage.execute('history.markContinuityLost',{token:f.old}),false,'旧guard迟到不能污染新绑定');
 const preserved=await f.snapshot();for(const table of ['messages','captures','aliases'])assert.deepEqual(preserved[table].filter(row=>original[table].some(old=>old.id===row.id)),original[table]);
 assert.equal((await f.current.history.read(f.contactB)).messages.length,1);
 assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 const count=f.channels.length;assert.deepEqual(await f.service.recertify(f.contactA,{requestKey:'synthetic-recertify-1'}),done);assert.equal(f.channels.length,count);
});
const quoteCarrier=(localId,failed=false)=>record('shard-a',localId,{kind:'other',text:null,originalType:'244813135921',metadataOnly:true,stateAssurance:'unverified',...(failed?{quoteErrorCode:'history_quote_unavailable'}:{quote:{replyText:'合成的引用回复',referencedText:'仅用于回归的引文',referencedSender:null,referencedSenderRole:'contact',referencedType:'1',referencedServerId:null,proofDigest:'a'.repeat(64)}})});
test('认证跨页保存引用及引用失败结果，pending普通资格不开放，完成后引用仍可展示',async t=>{
 for(const failed of [false,true]){
  const f=await setup(t);let hidden=false;
  f.setChannelHook((channel,state,index)=>{if(index!==1)return;
   state.pageFactory=async(_scope,cursor)=>cursor===null?{target:target.descriptor,cursorIn:null,cursorOut:'quoted-page',records:[record('shard-a','1')],completedPartitions:[],exhausted:false}:{target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[quoteCarrier('2',failed)],completedPartitions:[...target.partitions],exhausted:true};
   const inspect=state.inspectFactory;state.inspectFactory=async(scope,s)=>{if(s.inspectCalls>1){assert.equal((await f.current.history.readChat(f.contactA)).messages.length,0);hidden=true;}return inspect(scope,s);};
  });
  const done=await f.service.recertify(f.contactA,{requestKey:`inline-quote-${failed}`});assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.page_count,2);assert.equal(hidden,true);
  f.state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});f.state.pageRecords=[record('shard-a','1'),quoteCarrier('2',failed)];f.channel.guardSession={loss:new Promise(()=>{})};await f.current.history.synchronize(f.contactA);
  const messages=(await f.current.history.readChat(f.contactA)).messages,carrier=messages.find(m=>m.originalType==='244813135921');assert.ok(carrier);
  if(failed)assert.equal(carrier.quoteErrorCode,'history_quote_unavailable');else assert.equal(carrier.quote.replyText,'合成的引用回复');
 }
});
test('当前完整认证可包含旧物理实例的严格superset，不借普通partitionGrowth或旧cursor',async t=>{
 const f=await setup(t);
 await f.current.storage.execute('fixture.recertifyCheckedManifest',{ownerId:owner,contactId:f.contactA,checked:['shard-a','shard-b','shard-c']});
 // 当前reader两条连接都必须报告同一完整manifest和全部受认证表。
 f.setChannelHook((channel,state)=>{const inspect=state.inspectFactory;state.inspectFactory=scope=>{const r=inspect(scope);return {...r,capabilities:{...r.capabilities,normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported'}};};const current={...target,checkedPartitions:['shard-a','shard-b','shard-c'],partitions:[...target.partitions,'shard-c'],tables:[...target.tables,{partition:'shard-c',instance:'table-c'}]};channel.target=async()=>current;state.pageFactory=async()=>({target:current.descriptor,cursorIn:null,cursorOut:null,records:[record('shard-a','1'),{...record('shard-a','2'),partition:'shard-c',table:'table-c'}],completedPartitions:[...current.partitions],exhausted:true});});
 const done=await f.service.recertify(f.contactA,{requestKey:'fresh-superset'});assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.message_count,2);
 assert.equal(f.channels.reduce((n,x)=>n+x.state.pageCalls,0),1);
});
test('引用认证写cap不能跨操作、改guard或goal、复用旧source，也不能从普通quoteSave注入', {timeout:10000},async t=>{
 const f=await setup(t,{oldRecords:[quoteCarrier('1')]});await f.current.storage.execute('history.markContinuityLost',{token:await f.current.contacts.eligibility(f.contactB)});
 let release;const gate=new Promise(resolve=>{release=resolve;});const entered=new Map(),ready=[f.contactA,f.contactB].map(id=>new Promise(resolve=>entered.set(id,resolve)));
 f.setChannelHook((channel,state)=>{state.pageRecords=[quoteCarrier('1')];let final=false;const inspect=state.inspectFactory;
  state.inspectFactory=async(scope,s)=>{if(s.inspectCalls>1){final=true;entered.get(scope.token.contact_id)();await gate;}return inspect(scope,s);};channel.close=async()=>{if(final)release();};
 });
 const a=f.service.recertify(f.contactA,{requestKey:'quote-operation-a'}),b=f.service.recertify(f.contactB,{requestKey:'quote-operation-b'});await Promise.all(ready);
 const left=await f.snapshot(),right=await f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactB});
 const op=left.operations[0],other=right.operations[0],message=left.messages.find(m=>m.binding_id===op.new_binding_id),record=left.captures.find(r=>r.message_id===message.id);
 const cap={operationId:op.id,guardId:op.guard_id,goalId:op.goal_id},input={token:JSON.parse(op.token_json),recordId:record.id,messageId:message.id,version:'wechat-quote-v2',content:quoteCarrier('1').quote,proofDigest:'a'.repeat(64)};
 assert.equal((await f.current.storage.execute('fixture.recertifyQuoteWrite',{input,cap})).saved,true);
 for(const forged of [{...cap,operationId:other.id,guardId:other.guard_id,goalId:other.goal_id},{...cap,guardId:'forged-guard'},{...cap,goalId:other.goal_id}])
  await assert.rejects(f.current.storage.execute('fixture.recertifyQuoteWrite',{input,cap:forged}),error=>['history_recertify_not_authorized','history_recertify_source_not_available'].includes(error.code));
 await assert.rejects(f.current.storage.execute('fixture.recertifyQuoteWrite',{input:{...input,recordId:f.saved.sourceRecordIds[0],messageId:f.saved.id},cap}),{code:'history_recertify_source_not_available'});
 await assert.rejects(f.current.storage.execute('history.quoteSave',{...input,recertify:cap}),{code:'history_source_not_available'});
 assert.equal((await f.current.history.readChat(f.contactA)).messages.length,0);assert.equal((await f.current.storage.execute('history.readRecent',{ownerId:owner,contactId:f.contactA,limit:50})).messages.length,0);
 await f.service.stop();await Promise.all([a,b]);await assert.rejects(f.current.storage.execute('fixture.recertifyQuoteWrite',{input,cap}),{code:'history_recertify_not_authorized'});
});
const supersetTarget=()=>({...target,checkedPartitions:['shard-a','shard-b','shard-c'],partitions:[...target.partitions,'shard-c'],tables:[...target.tables,{partition:'shard-c',instance:'table-c'}]});
function configureSuperset(f,change=(_target)=>{}) {
 f.setChannelHook((channel,state,index)=>{const inspect=state.inspectFactory;state.inspectFactory=scope=>{const r=inspect(scope);return {...r,capabilities:{...r.capabilities,normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported'}};};
  const current=supersetTarget();change(current,index);channel.target=async()=>current;
  state.pageFactory=async()=>({target:current.descriptor,cursorIn:null,cursorOut:null,records:[record('shard-a','1')],completedPartitions:[...current.partitions],exhausted:true});
 });
}
test('新增表认证仍拒绝旧实例丢失、checked变化、旧manifest缺失及preview后再变',async t=>{
 for(const variant of ['missing-table','different-instance','different-checked','missing-checked','legacy-manifest','second-change']){
  const f=await setup(t);if(variant!=='legacy-manifest')await f.current.storage.execute('fixture.recertifyCheckedManifest',{ownerId:owner,contactId:f.contactA,checked:['shard-a','shard-b','shard-c']});
  configureSuperset(f,(current,index)=>{
   if(variant==='missing-table')current.tables=current.tables.filter(t=>t.instance!=='table-a');
   if(variant==='different-instance')current.tables[0]={...current.tables[0],instance:'replaced-a'};
   if(variant==='different-checked')current.checkedPartitions.push('shard-d');
   if(variant==='missing-checked')delete current.checkedPartitions;
   if(variant==='second-change'&&index===1){current.tables.push({partition:'shard-c',instance:'another-c'});}
  });
  const done=await f.service.recertify(f.contactA,{requestKey:`invalid-superset-${variant}`});assert.equal(done.failure_code,'history_recertify_source_changed',variant);assert.equal(f.channels.reduce((n,c)=>n+c.state.pageCalls,0),0);
 }
});
test('preview与实际连接的checked存在性必须双向一致，旧scope兼容不延伸到本次快照',async t=>{
 for(const added of [true,false]){
  const f=await setup(t);f.setChannelHook((channel,_state,index)=>{channel.target=async()=>({...target,...((index===1)===added?{checkedPartitions:['shard-a','shard-b','shard-c']}: {})});});
  const done=await f.service.recertify(f.contactA,{requestKey:`guard-manifest-presence-${added}`});assert.equal(done.state,'failed',JSON.stringify(done));assert.equal(done.failure_code,'history_recertify_source_changed');assert.equal(done.page_count,0);
 }
});
test('Rotate后来源删除只plan尚未drain时，Guard不能吸收变化的资料代次',async t=>{
 const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage);let planned=false;
 f.current.storage.execute=async(name,input,...rest)=>{const value=await execute(name,input,...rest);if(name==='history.recertifyRotate'&&!planned){planned=true;await f.current.deletion.plan({ownerId:owner,requestKey:'source-delete-after-rotate',scope:{kind:'source',contactId:f.contactA,sourceId:f.saved.sourceRecordIds[0]}});}return value;};
 const done=await f.service.recertify(f.contactA,{requestKey:'rotate-exact-token'});assert.equal(done.state,'failed',JSON.stringify(done));assert.equal(done.failure_code,'history_recertify_stale');assert.equal(done.page_count,0);assert.equal((await f.snapshot()).fences.length,1);
});
test('新增表认证遇source排除、清空B或全局删除围栏保守停读且不改抑制',async t=>{
 for(const kind of ['exclusion','cutoff','globalFence']){
  const f=await setup(t);await f.current.storage.execute('fixture.recertifyCheckedManifest',{ownerId:owner,contactId:f.contactA,checked:['shard-a','shard-b','shard-c']});
  if(kind==='cutoff'){f.state.boundaryMembers=[identity('shard-a','1')];await f.current.clear.clear(f.contactA);}
  else await f.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:f.contactA,mode:kind});
  configureSuperset(f);const done=await f.service.recertify(f.contactA,{requestKey:`superset-suppression-${kind}`});assert.equal(done.failure_code,'history_recertify_suppression_unmapped',JSON.stringify(done));assert.equal(done.page_count,0);
 }
});
test('终态未建立alias但旧原始元数据含有效非零serverId时仍拒绝猜测映射',async t=>{
 const f=await setup(t);await f.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:f.contactA,mode:'rawTerminal'});
 const done=await f.service.recertify(f.contactA,{requestKey:'terminal-raw-server'});assert.equal(done.failure_code,'history_recertify_terminal_alias_unmapped');assert.equal(done.page_count,0);
});
test('未围栏请求保留not_required原因，不创建虚假失败审计',async t=>{
 const f=await setup(t);await assert.rejects(f.service.recertify(f.contactB,{requestKey:'not-required'}),{code:'history_recertify_not_required'});assert.equal((await f.service.status(f.contactB)).state,'none');
});
test('页一已接受但页二失败时暂存消息不进入聊天、最近资料或来源接口',async t=>{
 const f=await setup(t);f.setChannelHook((channel,state,index)=>{if(index!==1)return;state.pageFactory=async(_scope,cursor)=>{
  if(cursor===null)return {target:target.descriptor,cursorIn:null,cursorOut:'next',records:[record('shard-a','2')],completedPartitions:[],exhausted:false};
  const snap=await f.snapshot();assert.equal(snap.messages.length,2);assert.equal((await f.current.history.readChat(f.contactA)).messages.length,0);
  assert.equal((await f.current.storage.execute('history.readRecent',{ownerId:owner,contactId:f.contactA,limit:50})).messages.length,0);
  const staged=snap.captures.find(r=>r.message_id!==f.saved.id);await assert.rejects(f.current.storage.execute('history.source',{ownerId:owner,contactId:f.contactA,recordId:staged.id}),{code:'history_source_not_found'});
  throw new StorageFailure('history_source_changed');
 };});
 const done=await f.service.recertify(f.contactA,{requestKey:'partial-failure'});assert.equal(done.failure_code,'history_source_changed');assert.equal(done.stage,'history');assert.equal(done.completed,false);
 assert.equal((await f.current.history.readChat(f.contactA)).messages.length,0);assert.equal((await f.snapshot()).fences.length,1);
});
test('祖先绑定的终态及仅quarantine的兼容终态均保留，新绑定不恢复旧撤回来源',async t=>{
 for(const mode of ['terminal','quarantine']){
  const f=await setup(t);await f.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:f.contactA,mode});
  const done=await f.service.recertify(f.contactA,{requestKey:`terminal-${mode}`});assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.message_count,0);
  const snap=await f.snapshot();assert.ok(snap.terminals.some(r=>r.binding_id!==f.old.binding_id&&r.reason==='source_recalled'));assert.equal(snap.messages.length,1);
 }
});
test('终态的server别名无法跨绑定证明一对一时停读，不伪装用户删除排除',async t=>{
 const f=await setup(t);await f.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:f.contactA,mode:'terminal',server:true});
 const done=await f.service.recertify(f.contactA,{requestKey:'terminal-server'});assert.equal(done.failure_code,'history_recertify_terminal_alias_unmapped');assert.equal(f.channels.reduce((n,x)=>n+x.state.pageCalls,0),0);
});
test('来源删除与清空B排除保持，认证不挂接history_restore许可',async t=>{
 const excluded=await setup(t);await excluded.current.storage.execute('fixture.recertifyTerminal',{ownerId:owner,contactId:excluded.contactA,mode:'exclusion'});
 const a=await excluded.service.recertify(excluded.contactA,{requestKey:'prior-source-exclusion'});assert.equal(a.state,'completed',JSON.stringify(a));assert.equal(a.message_count,0);
 const f=await setup(t);f.state.boundaryMembers=[identity('shard-a','1')];await f.current.clear.clear(f.contactA);
 const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});
 const b=await f.service.recertify(f.contactA,{requestKey:'prior-cutoff'});assert.equal(b.state,'completed',JSON.stringify(b));assert.equal(b.message_count,0);assert.equal((await f.current.resync.status(f.contactA)).state,'none');
});
test('当前账号、物理表实例或新连接的完整manifest变化均在正文读取前拒绝',async t=>{
 for(const variant of ['account','table','manifest']){
  const f=await setup(t);f.setChannelHook((channel,state,index)=>{
   if(variant==='account')state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:'different-account',conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
   if(variant==='table')channel.target=async()=>({...target,tables:target.tables.map(t=>({...t,instance:t.instance+'-changed'}))});
   if(variant==='manifest')channel.target=async()=>({...target,checkedPartitions:index===0?['shard-a','shard-b']:['shard-a','shard-b','shard-c']});
  });
  const done=await f.service.recertify(f.contactA,{requestKey:`changed-${variant}`});assert.equal(done.state,'failed');assert.equal(done.failure_code,'history_recertify_source_changed');assert.equal(f.channels.reduce((n,x)=>n+x.state.pageCalls,0),0);
 }
});
test('独立HTTP只接受request_key，状态投影没有内部身份与证明，重复请求不重发',async t=>{
 const f=await setup(t),http=new SqliteHistoryClearHttp(f.current.clear,f.current.resync,f.service);
 const server=createServer((req,res)=>{void http.handle(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${f.contactA}/history/recertify`;
 assert.equal((await (await fetch(url)).json()).state,'none');
 assert.equal((await fetch(url,{method:'POST',body:JSON.stringify({request_key:'bad',target:'injected'})})).status,400);
 const response=await fetch(url,{method:'POST',body:JSON.stringify({request_key:'http-recertify'})}),view=await response.json();assert.equal(response.status,202);assert.equal(view.state,'running');assert.equal(Object.keys(view).length,12);assert.doesNotMatch(JSON.stringify(view),/binding_id|token_json|guard_id|合成正文/);
 const completed=await f.service.recertify(f.contactA,{requestKey:'http-recertify'});assert.equal(completed.state,'completed');assert.deepEqual(await (await fetch(url,{method:'POST',body:JSON.stringify({request_key:'http-recertify'})})).json(),completed);assert.equal(f.channels.length,2);
});
test('重新认证关闭读取后失败停读，旧消息保留且不解除围栏，同请求不重新读',async t=>{
 const f=await setup(t);f.setPageHook(()=>f.current.contacts.setReading(false));
 const done=await f.service.recertify(f.contactA,{requestKey:'synthetic-recertify-off'});
 assert.equal(done.completed,false);assert.equal(done.state,'failed');assert.equal(done.preserved_message_count,1);
 const count=f.channels.length;assert.deepEqual(await f.service.recertify(f.contactA,{requestKey:'synthetic-recertify-off'}),done);assert.equal(f.channels.length,count);
 assert.equal((await f.current.history.read(f.contactA)).messages.length,0);
});
test('Prepare遇未完成删除保留deletion_pending原因，不伪造认证操作',async t=>{
 const f=await setup(t);await f.current.deletion.plan({ownerId:owner,requestKey:'deletion-before-recertify',scope:{kind:'source',contactId:f.contactA,sourceId:f.saved.sourceRecordIds[0]}});
 await assert.rejects(f.service.recertify(f.contactA,{requestKey:'blocked-by-deletion'}),{code:'history_recertify_deletion_pending'});assert.equal((await f.service.status(f.contactA)).state,'none');
});
test('阻塞页遇来源/联系人/账号删除，drain等认证末次写入且删除后不重造围栏或审计',async t=>{
 for(const kind of ['source','contact','account']){
  const f=await setup(t);let entered,unblock;const enteredPromise=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{unblock=resolve;});
  f.setChannelHook((channel,state,index)=>{if(index===1){state.pageHook=async()=>{entered();await gate;};channel.close=async()=>{unblock();};}});
  const pending=f.service.recertify(f.contactA,{requestKey:`drain-${kind}`});await enteredPromise;
  const scope=kind==='account'?{kind}:kind==='source'?{kind,contactId:f.contactA,sourceId:f.saved.sourceRecordIds[0]}:{kind,contactId:f.contactA};
  const plan=await f.current.deletion.plan({ownerId:owner,requestKey:`during-recertify-${kind}`,scope});
  const removed=await f.current.deletion.advance(plan);assert.equal(removed.state,'completed',JSON.stringify(removed.checks));
  const stopped=await pending;assert.equal(stopped.completed,false);
  const snapshot=await f.snapshot();assert.equal(snapshot.messages.length,0);
  if(kind!=='source'){assert.equal(snapshot.operations.length,0);assert.equal(snapshot.fences.length,0);}else assert.ok(['failed','interrupted'].includes(snapshot.operations[0].state));
  assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 }
});
test('删除恰逢Prepare前仍有holder保护，资格失效不被not_found覆盖',async t=>{
 const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage);let deleting,triggered=false;
 f.current.storage.execute=async(name,input,...rest)=>{
  if(name==='history.recertifyPrepare'&&!triggered){triggered=true;const plan=await f.current.deletion.plan({ownerId:owner,requestKey:'prepare-race-delete',scope:{kind:'contact',contactId:f.contactA}});deleting=f.current.deletion.advance(plan);}
  return execute(name,input,...rest);
 };
 await assert.rejects(f.service.recertify(f.contactA,{requestKey:'prepare-race'}),error=>error.code!=='history_recertify_not_found');
 assert.equal((await deleting).state,'completed');assert.equal((await f.snapshot()).operations.length,0);assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('运行中同key只读回状态，新key冲突；显式stop中断且不启动新的读取',async t=>{
 const f=await setup(t);let entered,unblock;const enteredPromise=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{unblock=resolve;});
 f.setChannelHook((channel,state,index)=>{if(index===1){state.pageHook=async()=>{entered();await gate;};channel.close=async()=>unblock();}});
 const pending=f.service.recertify(f.contactA,{requestKey:'one-running'});await enteredPromise;
 assert.equal((await f.service.admit(f.contactA,{requestKey:'one-running'})).state,'running');
 await assert.rejects(f.service.recertify(f.contactA,{requestKey:'second-running'}),{code:'history_recertify_already_running'});
 await f.service.stop(f.contactA);assert.equal((await pending).state,'interrupted');assert.equal(f.channels.length,2);
});
test('接受过暂存页后存储中断，重启仅标中断并保持停读，不发布半成品',async t=>{
 const f=await setup(t);let entered,unblock;const enteredPromise=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{unblock=resolve;});
 f.setChannelHook((channel,state,index)=>{if(index!==1)return;channel.close=async()=>unblock();state.pageFactory=async(_scope,cursor)=>{
  if(cursor===null)return {target:target.descriptor,cursorIn:null,cursorOut:'pending-next',records:[record('shard-a','2')],completedPartitions:[],exhausted:false};
  entered();await gate;return {target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[],completedPartitions:[...target.partitions],exhausted:true};
 };});
 const pending=f.service.recertify(f.contactA,{requestKey:'crashed-partial'});pending.catch(()=>{});await enteredPromise;
 await f.current.storage.close();unblock();await assert.rejects(pending,{code:'worker_failed'});await f.service.close();
 const current=await restart(f,t);const status=await current.recertify.status(f.contactA);assert.equal(status.state,'interrupted');assert.equal(status.failure_code,'history_recertify_interrupted');assert.equal(status.page_count,1);
 assert.equal((await current.history.readChat(f.contactA)).messages.length,0);assert.deepEqual(await current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('激活后守卫失证或释放失败且失证回写失败时，关闭共享存储阻断后续消费者',async t=>{
 for(const mode of ['release','loss']){
  const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage);let activated=false,lose;
  f.setChannelHook((channel,_state,index)=>{if(index===1)channel.guardSession={loss:new Promise(resolve=>{lose=resolve;})};});
  f.current.storage.execute=async(name,input,...rest)=>{
   if(name==='history.recertifyActivate'){const value=await execute(name,input,...rest);activated=true;if(mode==='loss')lose();return value;}
   if(activated&&(name==='history.recertifyFail'||mode==='release'&&name==='history.guardRelease'))throw new StorageFailure('storage_busy');
   return execute(name,input,...rest);
  };
  await assert.rejects(f.service.recertify(f.contactA,{requestKey:`persistent-failure-${mode}`}));assert.equal(activated,true);
  await assert.rejects(execute('history.readChat',{ownerId:owner,contactId:f.contactA,limit:20}),{code:'worker_failed'});
  await assert.rejects(execute('history.source',{ownerId:owner,contactId:f.contactA,recordId:f.saved.sourceRecordIds[0]}),{code:'worker_failed'});
 }
});
