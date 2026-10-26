import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import {join} from 'node:path';
import {HostStorage} from '../src/platform/database/host-storage.ts';
import {SyncScopeService} from '../src/sync/sync-scope.ts';
import {WechatSessions} from '../src/sync/wechat-sessions.ts';
import {SyncIncrementalCli} from '../src/sync/sync-incremental-cli.ts';
import {SyncIncrementalStore} from '../src/sync/sync-incremental-store.ts';
import {SyncIncrementalRecovery} from '../src/sync/sync-incremental-recovery.ts';
import {SyncIncrementalEngine} from '../src/sync/sync-incremental-engine.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';

async function fixture(t,{publish}={}){
  const f=await createStorageFixture();t.after(()=>f.close());
  const storage=await HostStorage.open(f.options);t.after(()=>storage.close());
  const {owner_id:ownerId}=await storage.initializeOwner('合成用户');
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[ownerId]);
  const scope=new SyncScopeService({storage,ownerId,accountScope:'synthetic-account',clock:()=>new Date('2026-10-24T01:00:00Z')});
  await scope.setMode({mode:'all_private',confirmed:true});
  await f.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,now())',[ownerId]);
  await scope.enroll([{username:'friend-a',display_name:'合成联系人',chat_type:'private'}]);
  // 关闭自动发现，其他CLI可见私聊仍不可读。
  await scope.setMode({mode:'selected',confirmed:true});
  const control=join(f.directory,'control.json'),log=join(f.directory,'commands.jsonl'),started=join(f.directory,'tail-started');
  await writeFile(log,'');
  await writeFile(control,JSON.stringify({messages:[{id:12,cursor:'opaque-12',body:'合成新消息'}]}));
  const executable=join(f.directory,'synthetic-cli');
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),control=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args[0]==='--version')emit({version:'synthetic-1'});
else if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(args[0]==='sessions'&&control.discoveryHangs)setInterval(()=>{},1000);
else if(args[0]==='sessions'&&control.discoveryFails)process.exit(2);
else if(args[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成联系人',chat_type:'private',last_timestamp:1},{username:'unconfirmed',display_name:'未授权',chat_type:'private',last_timestamp:1}]});
else if(args[0]==='resolve-chat')emit({candidates:[{username:args[1],display_name:'合成联系人',chat_type:'private'}]});
else if(args.includes('--mode')){if(control.streamFails)process.exit(2);else setInterval(()=>{},1000);}
else if(args[0]==='tail'){
 fs.writeFileSync(${JSON.stringify(started)},'1');
 if(control.hang)setInterval(()=>{},1000);
 else {const messages=control.messages??[];const cursor=args.includes('--cursor')?args[args.indexOf('--cursor')+1]:null;
 const index=messages.findIndex(m=>m.cursor===cursor);const remaining=index>=0?messages.slice(index+1):messages;
 const selected=control.onePage?remaining.slice(0,1):remaining;
 const events=selected.map(m=>({type:'message',cursor:m.cursor,message:{id:{local_id:m.id,talker:args[1]},kind:'text',text:m.body,is_from_me:false,create_time:1792803601}}));
 emit({events,cursor:selected.at(-1)?.cursor??cursor,freshness:{message_source:'live_message_db'},query:{chat:args[1],has_more:remaining.length>selected.length}});
 }
}else process.exit(2);`,{mode:0o700});
  const store=new SyncIncrementalStore({storage,ownerId,accountScope:'synthetic-account'});
  const recovery=new SyncIncrementalRecovery({store,storage,ownerId});
  let now=new Date('2026-10-24T01:00:00Z');const events=[];
  const cli=new SyncIncrementalCli({executable});const sessions=new WechatSessions({executable});
  const engine=new SyncIncrementalEngine({store,recovery,scope,cli,sessions,ownerId,accountScope:'synthetic-account',clock:()=>now,publish:publish??(async batch=>{events.push(...batch);})});
  t.after(()=>engine.close());
  return {...f,store,scope,engine,ownerId,events,control,log,started,setTime(value){now=new Date(value);},async controls(value){await writeFile(control,JSON.stringify(value));},async commands(){return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}};
}

test('无模型和前台输入仍同步授权增量，重复周期与重开不重复消息/事件',async t=>{
  const f=await fixture(t);
  await f.engine.cycle();
  assert.equal(f.events.length,1);
  await f.engine.cycle();
  assert.equal(f.events.length,1);
  await f.engine.setEnabled(false);
  const before=(await f.commands()).length;
  await f.engine.cycle();assert.equal((await f.commands()).length,before);
  await f.engine.setEnabled(true);assert.equal(f.events.length,1);
  const rows=(await f.client.query('SELECT text_content FROM message WHERE owner_id=$1',[f.ownerId])).rows;
  assert.deepEqual(rows,[{text_content:'合成新消息'}]);
  assert.ok(!(await f.commands()).some(args=>args[0]==='tail'&&args[1]==='unconfirmed'));
  assert.ok(!(await f.commands()).some(args=>args[0]==='sessions'),'selected周期及重新开启不得读取其他会话摘要');
});

test('后续页local ID下降仍按不透明cursor推进，断流后有界对账继续',async t=>{
  const f=await fixture(t);
  await f.controls({streamFails:true,onePage:true,messages:[{id:12,cursor:'page-a',body:'合成第一页'},{id:9,cursor:'page-b',body:'合成第二页'}]});
  await f.engine.cycle({maxBindings:1});assert.equal(f.events.length,1);
  await f.engine.cycle({maxBindings:1});assert.equal(f.events.length,2);
  await f.engine.cycle({maxBindings:1});assert.equal(f.events.length,2);
  const row=(await f.client.query('SELECT last_local_id,last_cursor FROM wechat_observation_cursor WHERE owner_id=$1',[f.ownerId])).rows[0];
  assert.equal(row.last_local_id,'9');assert.equal(row.last_cursor,'page-b');
  assert.equal(f.engine.status().backfill_phase,'complete');
});

test('关闭总开关取消正在读取的CLI，排空后不能迟到保存',async t=>{
  const f=await fixture(t);await f.controls({hang:true});
  let watcher,timer;
  const started=new Promise((resolve,reject)=>{
    watcher=watch(f.directory,(_event,name)=>{if(String(name)==='tail-started'){clearTimeout(timer);watcher.close();resolve();}});
    timer=setTimeout(()=>{watcher.close();reject(new Error('合成tail未启动'));},10000);
  });
  t.after(()=>{clearTimeout(timer);watcher.close();});
  const cycle=f.engine.cycle();await started;
  await f.engine.setEnabled(false);await cycle;
  assert.equal(await f.store.readEnabled(),false);assert.equal(f.events.length,0);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM message WHERE owner_id=$1',[f.ownerId])).rows[0].n,0);
});

test('明确全部范围发现新私聊，撤销后下一页不读且不会重新纳入',async t=>{
  const f=await fixture(t);
  await f.scope.setMode({mode:'all_private',confirmed:true});
  await f.controls({onePage:true,messages:[{id:1,cursor:'a',body:'合成一'},{id:2,cursor:'b',body:'合成二'}]});
  await f.engine.cycle({maxBindings:1});
  const bindings=await f.store.listBindings();assert.equal(bindings.length,2);
  const read=(await f.commands()).find(args=>args[0]==='tail'&&!args.includes('--mode'))[1];
  const bound=bindings.find(b=>b.conversation_locator===read);
  await f.engine.invalidateAndDrain('revoke');
  await f.client.query("UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE id=$1",[bound.binding_id]);
  f.engine.resume();const before=(await f.commands()).filter(args=>args[0]==='tail'&&args[1]===read).length;
  await f.engine.cycle();
  assert.equal((await f.commands()).filter(args=>args[0]==='tail'&&args[1]===read).length,before);
  assert.equal((await f.store.listBindings()).length,1);
});

test('逐绑定完整历史尚未释放时不启动该联系人的增量正文读取',async t=>{
  const f=await fixture(t);
  await f.scope.decideHistory({decision:'accepted',confirmed:true});
  await f.engine.cycle();
  assert.equal(f.events.length,0);
  assert.ok(!(await f.commands()).some(args=>args[0]==='tail'&&!args.includes('--mode')));
});

test('事件流没有变化仍按低频安全对账发现我方消息',async t=>{
  const f=await fixture(t);await f.engine.cycle();assert.equal(f.events.length,1);
  await f.controls({messages:[{id:12,cursor:'opaque-12',body:'合成新消息'},{id:13,cursor:'opaque-13',body:'合成后续'}]});
  f.setTime('2026-10-24T01:00:14Z');await f.engine.cycle();assert.equal(f.events.length,1);
  f.setTime('2026-10-24T01:00:16Z');await f.engine.cycle();assert.equal(f.events.length,2);
});

test('并发重复开启和关闭按请求顺序收敛，最终关闭不偷偷读取',async t=>{
  const f=await fixture(t);await f.engine.setEnabled(false);
  const before=(await f.commands()).filter(args=>args[0]==='tail').length;
  const controls=await Promise.allSettled([f.engine.setEnabled(true),f.engine.setEnabled(false)]);
  assert.equal(controls[1].status,'fulfilled');
  assert.equal(await f.store.readEnabled(),false);
  assert.equal((await f.commands()).filter(args=>args[0]==='tail').length,before);
});

test('stop排空在途enable，旧开启结果不得恢复已停止的读取',async t=>{
  const f=await fixture(t);await f.engine.setEnabled(false);
  const enabling=f.engine.setEnabled(true);
  const rejected=assert.rejects(enabling,{code:'runtime_stopping'});
  await f.engine.invalidateAndDrain('handoff');await rejected;
  const before=(await f.commands()).length;
  await f.engine.cycle();assert.equal((await f.commands()).length,before);
  assert.equal(f.events.length,0);
});


test('全部私聊发现暂时失败不阻断已确认绑定的增量，并按独立预算重试',async t=>{
  const f=await fixture(t);await f.scope.setMode({mode:'all_private',confirmed:true});
  await f.controls({discoveryFails:true,messages:[{id:12,cursor:'opaque-12',body:'合成新消息'}]});
  await f.engine.cycle({maxBindings:1});assert.equal(f.events.length,1);
  assert.equal(f.engine.status().sync_scope_failure_code,'sync_scope_discovery_failed');
  const before=(await f.commands()).filter(a=>a[0]==='sessions').length;
  await f.engine.cycle({maxBindings:1});
  assert.equal((await f.commands()).filter(a=>a[0]==='sessions').length,before);
  assert.equal((await f.store.listBindings()).length,1);
});


test('发现CLI挂起在独立一秒预算取消，已有绑定仍在同一切片落库',async t=>{
 const f=await fixture(t);await f.scope.setMode({mode:'all_private',confirmed:true});
 await f.controls({discoveryHangs:true,messages:[{id:12,cursor:'opaque-12',body:'合成新消息'}]});
 const started=performance.now();await f.engine.cycle({maxBindings:1});
 assert.equal(f.events.length,1);assert.ok(performance.now()-started<3000);
 assert.equal(f.engine.status().sync_scope_failure_code,'sync_scope_discovery_failed');
});


test('已提交事件投递挂起仅消耗本轮剩余预算，消息与持久补偿回执保留',async t=>{
 const f=await fixture(t,{publish:async(_batch,signal)=>new Promise((resolve,reject)=>{
   if(signal.aborted)return reject(signal.reason);
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 })});
 const started=performance.now();await f.engine.cycle({maxBindings:1});
 assert.ok(performance.now()-started<3600);
 assert.equal(f.engine.status().failure_code,'message_event_delivery_failed');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM message')).rows[0].n,1);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM memory_extraction_receipt')).rows[0].n,1);
});
