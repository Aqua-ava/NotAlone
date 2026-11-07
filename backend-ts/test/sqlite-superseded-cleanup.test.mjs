// 旧副本及认证审计由历史专用夹具建立；断言继续验证当前存储的删除与抑制保护。
import test from 'node:test';
import assert from 'node:assert/strict';
import {open,access} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture,owner,record,report,createChannel} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from './fixtures/history/legacy-recertify-service.ts';
import {SupersededHistoryCleanup} from '../src/history/sqlite/superseded-cleanup.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

const registryModule=new URL('./fixtures/history/superseded-registry.mjs',import.meta.url).href;
const exists=path=>access(path).then(()=>true,()=>false);

/**
 * 合成场景：联系人甲经 3 次修复同步得到 3 个被取代绑定 + 1 个现行绑定，每个绑定 6 条消息
 * （4 条文字 + 2 张图片）。部分旧消息被整理条目、记忆、候选回复、引用或隔离记录引用，
 * 另有旧图片带托管媒体文件。联系人乙作对照。
 */
async function scenario(t,options={}) {
 process.env.SYNTHETIC_SUPERSEDED_BATCH=String(options.batch??1000);
 t.after(()=>{delete process.env.SYNTHETIC_SUPERSEDED_BATCH;});
 const f=await fixture(t,{registryModule});
 const records=[1,2,3,4,5,6].map(n=>record('shard-a',String(n),n>=5?{kind:'image',text:null,originalType:'3'}:{}));
 f.state.pageRecords=records;
 const {storage,contacts,history,holders,deletion}=f.current;
 const media=new ManagedFiles(f.root);
 const create=()=>{const {channel,state}=createChannel();state.pageRecords=records;
  state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
  channel.guardSession={loss:new Promise(()=>{})};return channel;};
 const cleanup=new SupersededHistoryCleanup(storage,owner,deletion,options.cleanup);
 const service=new SqliteHistoryRecertifyService(storage,contacts,create,holders,{stopHistory:id=>history.stop(id),
  ...(options.autoCleanup?{onCompleted:id=>cleanup.schedule(id)}:{})});
 t.after(()=>service.close());
 const snapshot=(contactId=f.contactA)=>storage.execute('fixture.supersededSnapshot',{ownerId:owner,contactId});
 let repairs=0;
 const attachMedia=async messageId=>{
  const contactId=f.contactA;let step='head';
  try{
  // 修复认证后的来源需元数据重验才对派生写者开放（不重读正文）。
  if(repairs>0)await history.ensureSourceReady(contactId);
  await storage.execute('fixture.mediaHead',{ownerId:owner,contactId,messageId});
  step='begin';const begun=await storage.execute('media.begin',{ownerId:owner,contactId,messageId,requestKey:`media-${messageId}`,goal:'extract',token:await contacts.eligibility(contactId),adapterVersion:'synthetic-v1'});
  const attempt={ownerId:owner,contactId,messageId,attemptId:begun.attemptId,leaseToken:begun.leaseToken};
  step='check';await storage.execute('media.check',attempt);
  const reserved=await storage.execute('media.allocate',{...attempt,role:'image_display'});
  media.prepareArea('media');const location=join(f.root,'managed/media',reserved.locator);
  const fd=await open(location,'wx',0o600);const address=media.capture('media',reserved.locator);
  await storage.execute('media.identify',{...attempt,...reserved,address});
  const bytes=Buffer.from(`合成媒体字节-${messageId}`);await fd.writeFile(bytes);await fd.sync();await fd.close();
  await storage.execute('media.validated',{...attempt,fileId:reserved.fileId,byteSize:bytes.length,digest:createHash('sha256').update(bytes).digest('hex'),
   validation:{format:'synthetic',mimeType:'image/x-synthetic',containerValid:true,viewable:true,playable:false}});
  await storage.execute('media.publish',{...attempt,association:{protocol:'media-association-v1',profileId:'synthetic-v1',recordId:begun.recordId,messageId,resourceIdentity:`synthetic-resource-${messageId}`}});
  return {location,fileId:reserved.fileId,bytes:bytes.length};
  }catch(error){error.message+=` [media step ${step}]`;throw error;}
 };
 const currentMessages=async()=>{const s=await snapshot();const current=s.bindings.at(-1).id;return s.messages.filter(m=>m.binding===current);};
 const repair=async()=>{
  const token=await contacts.eligibility(f.contactA);
  await storage.execute('history.markContinuityLost',{token});
  const done=await service.recertify(f.contactA,{requestKey:`synthetic-repair-${++repairs}`});
  assert.equal(done.state,'completed',JSON.stringify(done));
  return done;
 };
 // 初次同步：联系人甲、乙各一个绑定；甲的第一个绑定图片消息带媒体。
 await history.synchronize(f.contactA);await history.synchronize(f.contactB);
 f.state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
 f.channel.guardSession={loss:new Promise(()=>{})};
 const files=[];
 const imageOf=async()=>(await currentMessages()).filter(m=>m.kind==='image')[0];
 files.push(await attachMedia((await imageOf()).id));
 for(let n=0;n<3;n++){await repair();files.push(await attachMedia((await imageOf()).id));}
 const before=await snapshot();
 // before.bindings：3 个已撤销（被取代）+ 1 个现行；messages 按绑定分组。
 const byBinding=before.bindings.map(b=>before.messages.filter(m=>m.binding===b.id));
 const reference=(messageId,kind)=>storage.execute('fixture.supersededReference',{ownerId:owner,contactId:f.contactA,messageId,kind});
 return {...f,storage,contacts,history,service,cleanup,deletion,snapshot,repair,files,media,before,byBinding,reference,records,attachMedia,
  quote:(carrierId,targetId)=>storage.execute('fixture.supersededQuote',{ownerId:owner,contactId:f.contactA,carrierId,targetId}),
  messageIds:list=>list.map(m=>m.id)};
}
/** 在三个旧绑定上布置引用，返回预期保留与可清的消息。 */
async function arrange(s) {
 const [b1,b2,b3,b4]=s.byBinding;
 assert.equal(b1.length,6);assert.equal(b4.length,6);
 await s.reference(b1[0].id,'processing_item');   // 整理条目
 await s.reference(b1[1].id,'memory');            // 记忆（来源记录＋要求消息）
 await s.reference(b1[2].id,'reply');             // 候选回复输入
 await s.quote(b1[2].id,b1[5].id);                // 被保留的载体（候选回复引用）引用 b1[5]：目标须随之保留
 await s.quote(b1[3].id,b1[0].id);                // 未引用的载体引用已保留的 b1[0]：载体可清
 await s.reference(b2[4].id,'memory');            // 带媒体的图片被记忆引用 → 媒体随消息保留
 await s.reference(b2[5].id,'quarantine');        // 隔离记录是撤回终态抑制的证据，保留
 return {
  retained:new Set([b1[0].id,b1[1].id,b1[2].id,b1[5].id,b2[4].id,b2[5].id]),
  cleared:new Set([b1[3].id,b1[4].id,b2[0].id,b2[1].id,b2[2].id,b2[3].id,...b3.map(m=>m.id)]),
  current:new Set(b4.map(m=>m.id)),
 };
}
const ids=snapshot=>new Set(snapshot.messages.map(m=>m.id));

test('Finalize 登记清理请求：与修复完成同事务，清理本身不在完成事务内执行',async t=>{
 const s=await scenario(t);
 const snap=await s.snapshot();
 assert.equal(snap.marker,1,'修复完成时登记了联系人清理请求');
 assert.equal(snap.messages.length,24,'登记请求时没有删除任何消息');
 assert.equal(snap.bindings.filter(b=>b.state==='revoked').length,3);
 const preview=await s.storage.execute('history.supersededPreview',{ownerId:owner,contactId:s.contactA});
 assert.equal(preview.gate,null);assert.equal(preview.counts.bindings,3);assert.equal(preview.counts.clearableMessages,18);
 assert.equal(snap.fences,0,'登记请求不写用户删除围栏');
});

test('只清被取代绑定下没有派生引用的消息，引用方与现行副本不变，不写任何用户删除抑制',async t=>{
 const s=await scenario(t);const expected=await arrange(s);
 const before=await s.snapshot();
 const result=await s.cleanup.run(s.contactA);
 assert.equal(result.blocked,false,JSON.stringify(result));assert.equal(result.batches,1);
 const after=await s.snapshot();
 const remaining=ids(after);
 for(const id of expected.retained)assert.ok(remaining.has(id),`被引用的消息 ${id} 必须保留`);
 for(const id of expected.cleared)assert.equal(remaining.has(id),false,`未引用的消息 ${id} 应被清理`);
 for(const id of expected.current)assert.ok(remaining.has(id));
 assert.equal(after.messages.length,expected.retained.size+expected.current.size);
 // 引用方一行不少，且仍指向存在的来源。
 for(const table of ['processing_item','memory_required_message','memory_citation','reply_context_item','reply_candidate_input_source','history_message_quarantine'])
  assert.equal(after.counts[table],before.counts[table],`${table} 不应变化`);
 assert.equal(after.counts.history_quote,1,'被保留载体的引用保留；未引用载体的引用随其清理');
 assert.equal(after.counts.history_quote_attempt,before.counts.history_quote_attempt);
 // 附属资料随消息一并清理：别名、来源记录、抓取页。
 assert.ok(after.counts.message_alias<before.counts.message_alias);assert.ok(after.counts.capture_record<before.counts.capture_record);
 // 非用户删除：不推进资料代次、不留围栏／排除／清空边界、终态抑制和读取资格不变。
 assert.deepEqual(after.contact,before.contact);assert.equal(after.fences,before.fences);assert.equal(after.exclusions,before.exclusions);
 assert.equal(after.cutoffs,before.cutoffs);assert.equal(after.terminals,before.terminals);assert.equal(after.grants,before.grants);
 assert.equal(after.marker,0,'无剩余可清对象后撤销请求标记');
 assert.deepEqual(after.operations.map(op=>[op.scope,op.state]),[['superseded_history','completed']]);
 // 现行副本的读取不受影响，联系人乙不受影响。
 assert.equal((await s.history.read(s.contactA)).messages.length,6);
 assert.equal((await s.snapshot(s.contactB)).messages.length,6);
 assert.deepEqual(await s.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('媒体托管文件随未引用消息擦除，被引用消息的媒体与现行媒体保留',async t=>{
 const s=await scenario(t);await arrange(s);
 const [f1,f2,f3,f4]=s.files;
 for(const file of s.files)assert.equal(await exists(file.location),true);
 const before=await s.snapshot();assert.equal(before.counts.media_file,4);
 const result=await s.cleanup.run(s.contactA);assert.equal(result.blocked,false,JSON.stringify(result));
 assert.equal(await exists(f1.location),false,'旧绑定一的图片未被引用，文件擦除');
 assert.equal(await exists(f2.location),true,'旧绑定二的图片被记忆引用，文件保留');
 assert.equal(await exists(f3.location),false,'旧绑定三的图片未被引用，文件擦除');
 assert.equal(await exists(f4.location),true,'现行副本媒体保留');
 const after=await s.snapshot();
 assert.equal(after.counts.media_file,2);assert.equal(after.counts.message_media,2);
 assert.deepEqual(await s.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('幂等：再次运行不改变任何内容，不产生新操作',async t=>{
 const s=await scenario(t);await arrange(s);
 await s.cleanup.run(s.contactA);
 const once=await s.snapshot();
 const again=await s.cleanup.run(s.contactA);
 assert.equal(again.batches,0);assert.equal(again.blocked,false);
 const twice=await s.snapshot();
 assert.deepEqual({...twice,operations:undefined},{...once,operations:undefined});
 assert.equal(twice.operations.length,1);
});

test('有界分批：每个操作只处理固定上界内的消息，逐批结案直到清完',async t=>{
 const s=await scenario(t,{batch:4});const expected=await arrange(s);
 const result=await s.cleanup.run(s.contactA);
 assert.equal(result.blocked,false,JSON.stringify(result));
 const after=await s.snapshot();
 // 12 条可清消息、每批 4 条 → 3 个已结案操作。
 assert.equal(expected.cleared.size,12);
 assert.equal(result.batches,3);
 assert.deepEqual(after.operations.map(op=>op.state),['completed','completed','completed']);
 for(const id of expected.cleared)assert.equal(ids(after).has(id),false);
 for(const id of expected.retained)assert.ok(ids(after).has(id));
});

test('中断续跑：计划后进程退出，重启按原操作续清，随后继续剩余批次',async t=>{
 const s=await scenario(t,{batch:5});const expected=await arrange(s);
 // 已计划但尚未推进：模拟计划提交后立即退出。
 const planned=await s.deletion.plan({ownerId:owner,requestKey:'crashed-after-plan',scope:{kind:'superseded_history',contactId:s.contactA}});
 assert.equal(planned.state,'fenced');
 assert.ok(planned.targets.length>0);
 const pending=await s.storage.execute('history.supersededPending',{ownerId:owner});
 assert.deepEqual(pending.operations.map(op=>op.operationId),[planned.operationId]);
 assert.deepEqual(pending.contacts,[s.contactA]);
 // 重启后的新实例：只凭账本与标记续跑。
 const restarted=new SupersededHistoryCleanup(s.storage,owner,s.deletion);
 const results=await restarted.resume();
 assert.ok(results.length>=1);
 const mine=results.find(r=>r.contactId===s.contactA);
 assert.ok(mine&&!mine.blocked,JSON.stringify(results));
 const after=await s.snapshot();
 for(const id of expected.cleared)assert.equal(ids(after).has(id),false);
 for(const id of expected.retained)assert.ok(ids(after).has(id));
 assert.ok(after.operations.every(op=>op.state==='completed'&&op.scope==='superseded_history'));
 assert.equal(after.operations.filter(op=>op.id===planned.operationId).length,1,'沿原操作结案，没有重复计划同一批');
});

test('清理中途某个目标失败：操作保持未结案，重启后沿原操作完成',async t=>{
 const s=await scenario(t,{batch:1000});const expected=await arrange(s);
 let calls=0;
 const flaky={plan:input=>s.deletion.plan(input),advance:async input=>{if(++calls===1)throw new StorageFailure('synthetic_crash');return s.deletion.advance(input);}};
 const first=new SupersededHistoryCleanup(s.storage,owner,flaky);
 const failed=await first.run(s.contactA);
 assert.equal(failed.blocked,true);assert.equal(failed.reason,'synthetic_crash');
 const mid=await s.snapshot();assert.ok(mid.operations.some(op=>op.state!=='completed'));
 assert.equal(mid.marker,1,'未清完时保留请求标记');
 const second=new SupersededHistoryCleanup(s.storage,owner,s.deletion);
 const resumed=await second.run(s.contactA);
 assert.equal(resumed.blocked,false,JSON.stringify(resumed));
 const after=await s.snapshot();
 for(const id of expected.cleared)assert.equal(ids(after).has(id),false);
 assert.ok(after.operations.every(op=>op.state==='completed'));
 assert.equal(after.marker,0);
});

test('来源连续性围栏挡住清理，保留请求标记且不改变任何用户抑制',async t=>{
 const s=await scenario(t);await arrange(s);
 const before=await s.snapshot();
 // 现行副本未获证（围栏）：不清理，不允许计划。
 await s.storage.execute('history.markContinuityLost',{token:await s.contacts.eligibility(s.contactA)});
 const preview=await s.storage.execute('history.supersededPreview',{ownerId:owner,contactId:s.contactA});
 assert.equal(preview.gate,'continuity_fence');assert.equal(preview.work,false);
 await assert.rejects(s.deletion.plan({ownerId:owner,requestKey:'fenced-attempt',scope:{kind:'superseded_history',contactId:s.contactA}}),{code:'superseded_cleanup_continuity_fence'});
 const blocked=await s.cleanup.run(s.contactA);
 assert.equal(blocked.batches,0);assert.equal(blocked.reason,'continuity_fence');
 const after=await s.snapshot();
 assert.equal(after.messages.length,before.messages.length);
 assert.equal(after.marker,1,'被挡住时保留请求，待修复通过后再清');
 assert.equal(after.operations.length,0,'被拒绝的计划不留账本记录');
});

test('进行中的其他删除挡住清理，该删除结案后继续',async t=>{
 const s=await scenario(t);const expected=await arrange(s);
 const current=s.byBinding[3].find(m=>m.kind==='image');
 const pendingDelete=await s.deletion.plan({ownerId:owner,requestKey:'media-clear-current',scope:{kind:'media_result_clear',contactId:s.contactA,messageId:current.id}});
 let preview=await s.storage.execute('history.supersededPreview',{ownerId:owner,contactId:s.contactA});
 assert.equal(preview.gate,'deletion_pending');
 const blocked=await s.cleanup.run(s.contactA);assert.equal(blocked.batches,0);assert.equal(blocked.reason,'deletion_pending');
 assert.equal((await s.snapshot()).messages.length,24);
 await s.deletion.advance(pendingDelete);
 preview=await s.storage.execute('history.supersededPreview',{ownerId:owner,contactId:s.contactA});
 assert.equal(preview.gate,null);
 const done=await s.cleanup.run(s.contactA);assert.equal(done.blocked,false,JSON.stringify(done));
 const after=await s.snapshot();
 for(const id of expected.cleared)assert.equal(ids(after).has(id),false);
});

test('联系人删除计划覆盖被取代副本的清理标记，不留可识别残余',async t=>{
 const s=await scenario(t);
 await s.reference(s.byBinding[0][0].id,'processing_item');
 const op=await s.deletion.plan({ownerId:owner,requestKey:'delete-contact-a',scope:{kind:'contact',contactId:s.contactA}});
 const done=await s.deletion.advance(op);
 assert.equal(done.state,'completed',JSON.stringify([done.checks,await s.storage.execute('fixture.deletionFailures',{operationId:op.operationId})]));
 const after=await s.snapshot();
 assert.equal(after.messages.length,0);
 assert.equal(after.marker,0,'联系人删除一并清除登记的清理请求');
});

test('清理后仍可再次修复同步，并再次清理刚被取代的副本',async t=>{
 const s=await scenario(t);await arrange(s);
 await s.cleanup.run(s.contactA);
 const mid=await s.snapshot();
 assert.equal(mid.messages.length,12);
 await s.repair();
 const afterRepair=await s.snapshot();
 assert.equal(afterRepair.bindings.length,5);
 // 新副本比旧副本少一条：被隔离为“已撤回”的第 6 条由终态抑制延续，没有因为清理而丢失或被重新读入。
 assert.equal(afterRepair.messages.length,mid.messages.length+5,'修复仍读入新副本，没有被排除项阻止');
 assert.equal(afterRepair.terminals>mid.terminals,true,'旧绑定的撤回证据已随修复延续为新绑定的终态抑制');
 const second=await s.cleanup.run(s.contactA);
 assert.equal(second.blocked,false,JSON.stringify(second));
 const final=await s.snapshot();
 // 上一次的现行副本（6 条）现在被取代且无引用，全部清理；保留 6 条旧引用方 + 新现行 5 条。
 assert.equal(final.messages.length,11);
 assert.equal((await s.history.read(s.contactA)).messages.length,5);
 assert.deepEqual(await s.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('修复完成时自动触发：onCompleted 排队清理，等待后旧副本已清',async t=>{
 const s=await scenario(t,{autoCleanup:true});
 // scenario 已经历 3 次自动清理的触发；等待排队的清理跑完。
 await s.cleanup.run(s.contactA);
 const snap=await s.snapshot();
 assert.equal(snap.messages.length,6,'未被引用的旧副本在每次修复通过后自动清理，只剩现行副本');
 assert.equal(snap.marker,0);
 assert.deepEqual(snap.bindings.map(b=>b.state),['revoked','revoked','revoked','verified']);
});

test('联系人范围隔离：清理甲不触碰乙的任何消息、别名、记录',async t=>{
 const s=await scenario(t);await arrange(s);
 const beforeB=await s.snapshot(s.contactB);
 await s.cleanup.run(s.contactA);
 assert.deepEqual((await s.snapshot(s.contactB)).messages,beforeB.messages);
});

test('计划之后新出现的引用使消息保留：逐条复验，不误删被引用的消息',async t=>{
 const s=await scenario(t);await arrange(s);
 const plan=await s.deletion.plan({ownerId:owner,requestKey:'late-reference',scope:{kind:'superseded_history',contactId:s.contactA}});
 const victim=s.byBinding[2][0];
 assert.ok(plan.targets.some(item=>item.target?.key?.id===victim.id),'计划时它是可清的');
 await s.reference(victim.id,'processing_item');
 const done=await s.deletion.advance(plan);
 assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=await s.snapshot();
 assert.ok(ids(after).has(victim.id),'计划后被引用的消息保留');
 for(const message of s.byBinding[2].slice(1))assert.equal(ids(after).has(message.id),false);
 assert.deepEqual(await s.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('迁移 45 重建删除账本：既有操作、目标、校验与墓碑原样保留，新范围可用',async t=>{
 const {SqliteStorage}=await import('../src/storage/sqlite/client.ts');
 const {DatabaseSync}=await import('node:sqlite');
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');
 const {ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');
 const legacy=new URL('./fixtures/history/superseded-upgrade-registry.mjs?mode=legacy',import.meta.url).href;
 const f=await fixture(t,{registryModule:legacy});
 assert.equal(f.current.storage.status.schemaVersion,44);
 const path=join(f.root,'managed/sqlite/notalone.sqlite'),databaseId=f.current.storage.status.databaseId;
 await f.current.history.close();await f.current.storage.close();
 // 旧库的账本里放入各类行（直接写 44 版结构，等价于旧版本已运行过的删除）。
 const seed=new DatabaseSync(path);seed.exec('PRAGMA foreign_keys=ON');
 for(const [id,kind,state] of [['op-contact','contact','completed'],['op-media','media_result_clear','blocked']]){
  const media=kind==='media_result_clear';
  seed.prepare(`INSERT INTO deletion_operation VALUES(?,?,?,?,?,?,NULL,NULL,?,3,?,1,'[]',NULL,NULL,?,?)`)
   .run(id,owner,`legacy.delete.${kind}`,`key-${id}`,kind,'11111111-1111-4111-8111-111111111111',media?'message-1':null,state,Date.now(),state==='completed'?Date.now():null);
  seed.prepare(`INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,plan_revision,state,expected_identity,target_payload) VALUES(?,1,'row','history',?, 'message',NULL,1,'cleared',NULL,NULL)`).run(id,`target-${id}`);
  seed.prepare(`INSERT INTO deletion_check VALUES(?,1,'write_fence',?, 'passed',?, 'deletion-v1','identity_generation_current')`).run(id,'authority',Date.now());
  seed.prepare(`INSERT INTO request_tombstone VALUES(?,?,?, 'revoked',3,?,?)`).run(owner,'legacy:media.extract',`request-${id}`,id,Date.now());
 }
 seed.close();
 const ledger=()=>{const db=new DatabaseSync(path,{readOnly:true});try{const count=table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  return {operations:db.prepare('SELECT * FROM deletion_operation ORDER BY operation_id').all().map(r=>({...r})),targets:count('deletion_target'),checks:count('deletion_check'),tombstones:count('request_tombstone')};}finally{db.close();}};
 const before=ledger();assert.equal(before.operations.length,2);assert.equal(before.targets,2);assert.equal(before.checks,2);assert.equal(before.tombstones,2);
 const upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});
 t.after(()=>upgraded.close());
 assert.equal(upgraded.status.schemaVersion,45);
 assert.deepEqual(ledger(),before,'重建不丢任何账本行');
 assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 // 新范围可进入账本（CHECK 已扩展）：未满足清理条件时由授权层拒绝，而不是被表约束挡住。
 const service=new DeletionService(upgraded,new ActiveHolders(),new ManagedFiles(f.root));
 await assert.rejects(service.plan({ownerId:owner,requestKey:'no-superseded-yet',scope:{kind:'superseded_history',contactId:f.contactA}}),{code:'superseded_cleanup_no_certified_current'});
});
