// 旧副本及认证审计由历史专用夹具建立；断言继续验证当前存储的删除与抑制保护。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,report,createChannel,target,restart} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from './fixtures/history/legacy-recertify-service.ts';

const capabilities={normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported',incrementalTail:'supported'};
const rawTables=value=>value.tables.map((table,index)=>({target:table.instance,partition:table.partition,role:'private_message',columns:[{name:'local_id',type:'INTEGER',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['local_id'],autoIncrement:true,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'9',rootPage:String(index+1)}));
function proofFor(context){
 const scope={accountKey:context.report.accountKey,conversationKey:context.report.conversationKey,displayName:'合成联系人',sourceGeneration:context.token.source_generation};
 const current={scope,report:context.report,target:context.target,schema:{sourceGeneration:scope.sourceGeneration,tables:rawTables(context.target),checkedPartitions:context.target.checkedPartitions}};
 const oldGeneration=context.candidates[0].token.source_generation,oldTarget={...context.candidates[0].target,checkedPartitions:context.target.checkedPartitions,tables:context.target.tables.map(table=>({...table,instance:`legacy-live-${table.instance}`}))};
 const legacy={scope:{...scope,sourceGeneration:oldGeneration},report:context.candidates[0].report,target:oldTarget,schema:{sourceGeneration:oldGeneration,tables:rawTables(oldTarget),checkedPartitions:oldTarget.checkedPartitions}};
 return {format:'notalone-legacy-recall-mapping-v1',token:context.token,observedAt:Date.now(),legacy,current,keys:context.candidates.map(candidate=>({from:candidate.key,to:JSON.stringify([scope.sourceGeneration,...JSON.parse(candidate.key).slice(1)]),reason:'source_recalled'}))};
}
async function copies(t,image=false,recallCount=3){
 const cleanup=[],f=await fixture({after:callback=>cleanup.push(callback)},{registryModule:new URL('./fixtures/history/legacy-source-deletion-registry.mjs',import.meta.url).href});
 const normal=(scope,artifact='a'.repeat(64))=>({...report,artifactSha256:artifact,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,capabilities:{...report.capabilities,...capabilities}});
 f.state.pageRecords=[1,2,3,4,5,6].map(id=>record('shard-a',String(id),image&&id===4?{kind:'image',text:null,originalType:'3'}:{}));f.state.inspectFactory=scope=>normal(scope);f.channel.guardSession={loss:new Promise(()=>{})};
 await f.current.history.synchronize(f.contactA);await f.current.history.synchronize(f.contactB);
 await f.current.storage.execute('fixture.legacyRecalls',{ownerId:owner,contactId:f.contactA,generation:'legacy-source'});
 if(recallCount!==3)await f.current.storage.execute('fixture.legacyRecallCount',{ownerId:owner,contactId:f.contactA,generation:'legacy-source',count:recallCount});
 const old=await f.current.storage.execute('fixture.legacyNormal',{ownerId:owner,contactId:f.contactA,generation:'legacy-source',localId:'4'});
 const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});
 const create=()=>{const {channel,state}=createChannel();state.pageRecords=f.state.pageRecords;state.pageFactory=(_scope,cursor,s)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:s.pageRecords,completedPartitions:target.partitions,exhausted:true,resumeCursor:'synthetic-tail-0'});state.inspectFactory=scope=>normal(scope,'b'.repeat(64));channel.target=async()=>({...target,checkedPartitions:target.partitions});channel.guardSession={loss:new Promise(()=>{})};return channel;};
 const service=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,create,f.current.holders,{stopHistory:id=>f.current.history.stop(id),proveLegacyTerminals:async context=>proofFor(context)});
 t.after(async()=>{await service.close();for(const callback of cleanup.reverse())await callback();});
 assert.equal((await service.recertify(f.contactA,{requestKey:randomUUID()})).state,'completed');
 f.state.inspectFactory=scope=>normal(scope,'b'.repeat(64));f.channel.target=async()=>({...target,checkedPartitions:target.partitions});f.channel.guardSession={loss:new Promise(()=>{})};
 await f.current.history.synchronize(f.contactA);
 const fresh=(await f.current.history.readChat(f.contactA)).messages.find(message=>image?message.kind==='image':message.text==='合成正文4');
 return {...f,old,fresh,token,legacyService:service};
}
const key=(generation,localId='4')=>JSON.stringify([generation,'shard-a','table-a',localId]);
for(const direction of ['old','new'])test(`删除${direction}代正常source清除同物理跨代副本及未来重导，其他tuple和联系人保留`,async t=>{
 const f=await copies(t),sourceId=direction==='old'?f.old.sourceId:f.fresh.sourceRecordIds[0];
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactA,sourceId}});
 const ids=await f.current.storage.execute('diag.sourceIds',{operation:plan});assert.equal(ids.length,3,'旧代、原绑定当前代和新认证当前代均属于冻结删除族');
 assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 await f.current.history.synchronize(f.contactA);
 const readable=(await f.current.history.readChat(f.contactA)).messages;assert.ok(!readable.some(message=>message.text==='合成正文4'));
 assert.deepEqual(readable.map(message=>message.text).sort(),['合成正文5','合成正文6']);
 assert.equal((await f.current.history.readChat(f.contactB)).messages.length,6);
 const exclusions=await f.current.storage.execute('fixture.legacyExclusions',{ownerId:owner,conversationId:f.token.conversation_id});
 assert.ok(exclusions.includes(key('source-1'))&&exclusions.includes(key('legacy-source')));
});

test('某代没有capture时也冻结其已证明物理key排除，不能在后续同步复活',async t=>{
 const f=await copies(t),fresh=(await f.current.history.readChat(f.contactA)).messages.find(message=>message.text==='合成正文6');
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactA,sourceId:fresh.sourceRecordIds[0]}});
 assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 const exclusions=await f.current.storage.execute('fixture.legacyExclusions',{ownerId:owner,conversationId:f.token.conversation_id});
 assert.ok(exclusions.includes(key('legacy-source','6')),'即使旧代没有capture，已完成证明允许的旧代相同物理key也须排除');
});

test('跨代删除计划冻结后种子先擦除，重试仍清理所有既定副本',async t=>{
 const f=await copies(t),plan=await f.current.deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactA,sourceId:f.old.sourceId}});
 const frozen=await f.current.storage.execute('diag.sourceIds',{operation:plan});assert.equal(frozen.length,3);
 const claim=await f.current.storage.execute('deletion.claim',{ownerId:owner,operationId:plan.operationId});
 const seed=claim.targets.find(row=>row.target?.domain==='history'&&row.target.rowKind==='capture_record'&&row.target.key.id===f.old.sourceId);
 await f.current.storage.execute('deletion.clearTarget',{ownerId:owner,operationId:plan.operationId,token:claim.token,planRevision:claim.planRevision,targetNo:seed.targetNo});
 assert.deepEqual(await f.current.storage.execute('diag.sourceIds',{operation:plan}),frozen);
 await f.legacyService.close();await restart(f,t);
 assert.deepEqual(await f.current.storage.execute('diag.sourceIds',{operation:plan}),frozen);
 assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 assert.ok(!(await f.current.history.readChat(f.contactA)).messages.some(message=>message.text==='合成正文4'));
});

for(const count of [1,4])test(`跨代删除闭包不依赖固定数量，${count}条精确撤回证明均保护正常来源`,async t=>{
 const f=await copies(t,false,count),plan=await f.current.deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactA,sourceId:f.old.sourceId}});
 assert.equal((await f.current.storage.execute('diag.sourceIds',{operation:plan})).length,3);
 assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 assert.ok(!(await f.current.history.readChat(f.contactA)).messages.some(message=>message.text==='合成正文4'));
});

for(const variant of ['missing','digest','incomplete'])test(`缺少completed可信审计${variant}时不扩展generation`,async t=>{
 const f=await copies(t);await f.current.storage.execute('fixture.legacyAuditChange',{ownerId:owner,contactId:f.contactA,variant});
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactA,sourceId:f.old.sourceId}});
 assert.equal((await f.current.storage.execute('diag.sourceIds',{operation:plan})).length,1);
});

test('删除旧代source同时清除新认证媒体提取派生，不能只删除旧捕获',async t=>{
 const f=await copies(t,true),messageId=f.fresh.id;
 await f.current.storage.execute('diag.mediaHead',{ownerId:owner,contactId:f.contactA,messageId});
 await f.current.storage.execute('media.begin',{ownerId:owner,contactId:f.contactA,messageId,requestKey:randomUUID(),goal:'extract',token:await f.current.contacts.eligibility(f.contactA),adapterVersion:'synthetic'});
 assert.equal((await f.current.storage.execute('diag.dependencies',{ownerId:owner})).media_extraction_attempt,1);
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactA,sourceId:f.old.sourceId}});
 assert.ok(plan.targets.some(row=>row.target?.domain==='media'));
 assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 const after=await f.current.storage.execute('diag.dependencies',{ownerId:owner});assert.equal(after.media_extraction_attempt,0);assert.equal(after.message_media,0);
});
