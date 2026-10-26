import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HostStorage} from '../src/platform/database/host-storage.ts';
import {SyncScopeService} from '../src/sync/sync-scope.ts';
import {grantBindingHistory} from '../src/sync/sync-scope-history.ts';
import {createSyncIncrementalApi} from '../src/sync/sync-incremental-api.ts';
import {SyncIncrementalStore} from '../src/sync/sync-incremental-store.ts';
import {requireReplyScope} from '../src/reply/generation/reply-scope.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';

const prefix='/api/runtime/sync-incremental/';
const account='synthetic-account';

async function fixture(t,{authorize=true,enabled=true,sessions=['custom-synthetic-a']}={}){
  const files=await createStorageFixture();
  const storage=await HostStorage.open(files.options);
  const apis=[];
  t.after(async()=>{
    for(const api of apis.reverse())await api.close();
    await storage.close();
    await files.close();
  });
  const {owner_id:ownerId}=await storage.initializeOwner('合成用户');
  await files.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat',$2,'合成账号')",[ownerId,account]);
  const scope=new SyncScopeService({storage,ownerId,accountScope:account,clock:()=>new Date('2026-10-25T00:00:00Z')});
  t.after(()=>scope.close());
  await scope.setMode({mode:'all_private',confirmed:true});
  await files.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,$2,CASE WHEN $2 THEN now() END)',[ownerId,enabled]);
  await scope.enroll(sessions.map((username,index)=>({username,display_name:`合成联系人${index+1}`,chat_type:'private'})));
  await scope.setMode({mode:'selected',confirmed:true});
  const bindings=(await files.client.query(`SELECT id AS binding_id,contact_id,conversation_locator
    FROM conversation_binding WHERE owner_id=$1 ORDER BY conversation_locator`,[ownerId])).rows;
  if(authorize)await grantBindingHistory(files.client,{ownerId,accountScope:account},bindings.map(row=>row.binding_id),new Date('2026-10-25T00:00:00Z'));

  const controlPath=join(files.directory,'history-control.json');
  const logPath=join(files.directory,'history-commands.jsonl');
  const startedPath=join(files.directory,'history-tail-started');
  const executable=join(files.directory,'synthetic-history-cli');
  await writeFile(logPath,'');
  await writeFile(controlPath,JSON.stringify({messagesByLocator:{},incremental:[]}));
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);
const control=JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)},'utf8'));
fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify(args)+'\\n');
const emit=data=>console.log(JSON.stringify({ok:true,data}));
const arg=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
const fail=(message,code='tool_error')=>{console.log(JSON.stringify({ok:false,error:{code,message,warnings:[],details:{}}}));process.exit(2);};
if(args[0]==='--version')emit({version:'synthetic-history-1'});
else if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:${JSON.stringify(account)}}}});
else if(args[0]==='resolve-chat'){
  const username=args[1],type=control.notPrivate?.[username]?'official_account':'private';
  emit({candidates:[{username,display_name:'合成联系人',chat_type:type}]});
}else if(args[0]==='sessions')emit({sessions:[]});
else if(args[0]==='sql')emit({freshness:{message_source:'live_selected_db_read_only'},query:{has_more:false,returned:1},rows:[{deleted_count:1,session_count:0,empty_session_count:0}]});
else if(args[0]==='tail'&&args.includes('--mode'))setInterval(()=>{},1000);
else if(args[0]==='tail'){
  const locator=args[1],history=args.includes('--history'),mode=control.historyMode?.[locator]??null;
  if(history&&mode==='hang'){fs.writeFileSync(${JSON.stringify(startedPath)},'1');setInterval(()=>{},1000);}
  if(history&&mode==='deleted')fail('table missing_message not found in 1 message shards');
  if(history&&mode==='empty')emit({events:[],cursor:null,freshness:{message_source:'live_message_db'},query:{chat:locator,has_more:false,history:true}});
  else{
    const source=history?(control.messagesByLocator?.[locator]??[]):(control.incremental??[]);
    const cursor=arg('--cursor'),start=cursor?source.findIndex(item=>item.cursor===cursor)+1:0;
    const remaining=start>0?source.slice(start):source;
    const limit=Number(arg('--limit')??remaining.length??0),selected=remaining.slice(0,limit);
    const events=selected.map(item=>({type:'message',cursor:item.cursor,message:{id:{local_id:item.id,talker:locator},kind:item.kind??'text',text:item.body??'',is_from_me:item.fromMe??false,create_time:item.time??1792803601}}));
    emit({events,cursor:selected.at(-1)?.cursor??cursor,freshness:{message_source:'live_message_db'},query:{chat:locator,has_more:remaining.length>selected.length,...(history?{history:true}:{})}});
  }
}else process.exit(2);`,{mode:0o700});

  let current;
  async function start({pageLimit=1}={}){
    const events=[];
    const api=await createSyncIncrementalApi({storage,executable,environment:{},historyOwner:'typescript',historyPageLimit:pageLimit,
      publish:async batch=>{events.push(...batch);}});
    apis.push(api);
    current={api,events};
    return current;
  }
  async function call(command,extra={},signal){
    return current.api.execute('POST',prefix+command,{owner_id:ownerId,channel:'wechat',account_scope:account,...extra},()=>{},signal??new AbortController().signal);
  }
  await start();
  return {files,storage,ownerId,scope,bindings,controlPath,logPath,startedPath,start,call,
    get api(){return current.api},get events(){return current.events},
    async control(value){await writeFile(controlPath,JSON.stringify(value));},
    async commands(){return (await readFile(logPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));},
  };
}

const state=async(f,binding=f.bindings[0])=>(await f.files.client.query(
  'SELECT * FROM cli_history_sync_state WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3',
  [f.ownerId,binding.contact_id,binding.binding_id])).rows[0];
const count=async(f,table)=>(await f.files.client.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;

test('完整历史按不透明游标分页、重启续读并与增量稳定身份去重',{timeout:90000},async t=>{
  const f=await fixture(t);
  const locator=f.bindings[0].conversation_locator;
  await f.control({messagesByLocator:{[locator]:[
    {id:101,cursor:'history-page-1',body:'合成历史一',time:100},
    {id:42,cursor:'history-page-2',body:'合成历史二',time:200},
  ]},incremental:[
    {id:7,cursor:'incremental-page-1',body:'合成增量',time:300},
    {id:42,cursor:'incremental-page-2',body:'合成历史二',time:200},
  ]});
  const first=await f.call('cycle',{max_bindings:1});
  assert.equal(first.status,200);
  assert.equal(first.body.history_coverages[0].phase,'syncing');
  assert.equal((await state(f)).last_cursor,'history-page-1');
  assert.equal(await count(f,'message'),1);
  assert.equal(f.events.length,0);
  assert.equal((await f.api.status()).history_coverages[0].phase,'syncing');

  const watermark=(await state(f)).watermark_at.toISOString();
  await f.api.close();
  await f.start({pageLimit:1});
  const second=await f.call('cycle',{max_bindings:1});
  assert.equal(second.status,200);
  assert.equal(second.body.history_coverages[0].phase,'complete');
  assert.equal(second.body.history_coverages[0].message_count,2);
  assert.equal(second.body.history_coverages[0].page_count,2);
  assert.equal((await state(f)).watermark_at.toISOString(),watermark);
  assert.equal((await state(f)).last_cursor,'history-page-2');
  assert.equal(await count(f,'message'),2);
  assert.equal(await count(f,'memory_extraction_receipt'),2);

  const incremental=await f.call('cycle',{max_bindings:1});
  assert.equal(incremental.status,200);
  assert.equal(await count(f,'message'),3);
  assert.equal(await count(f,'message_source_ref'),4);
  assert.deepEqual(f.events.map(event=>event.message_id).length,1);
  const rows=(await f.files.client.query('SELECT text_content FROM message ORDER BY text_content')).rows;
  assert.deepEqual(rows.map(row=>row.text_content),['合成历史一','合成历史二','合成增量']);
  const commands=await f.commands();
  assert.ok(commands.some(args=>args[0]==='tail'&&args.includes('--history')&&args.includes('--limit')));
  assert.ok(commands.every(args=>args[0]!=='tail'||args.includes('--strict-read-only')));
});

test('旧授权无逐绑定历史快照时不建任务、不读历史但仍可增量',{timeout:90000},async t=>{
  const f=await fixture(t,{authorize:false});
  const locator=f.bindings[0].conversation_locator;
  await f.control({messagesByLocator:{[locator]:[{id:1,cursor:'old-history',body:'不应读取'}]},
    incremental:[{id:2,cursor:'new-only',body:'授权后增量',time:200}]});
  const result=await f.call('cycle',{max_bindings:1});
  assert.equal(result.status,200);
  assert.equal(result.body.history_coverages[0].phase,'not_started');
  assert.equal(await count(f,'cli_history_sync_state'),0);
  assert.equal(await count(f,'message'),1);
  assert.equal((await f.files.client.query('SELECT text_content FROM message')).rows[0].text_content,'授权后增量');
  assert.ok(!(await f.commands()).some(args=>args[0]==='tail'&&args.includes('--history')));
});

test('空历史形成不完整门禁，关闭停读后重开从原水位恢复并自动重试',{timeout:90000},async t=>{
  const f=await fixture(t);
  const binding=f.bindings[0],locator=binding.conversation_locator;
  assert.equal((await f.call('disable')).status,200);
  assert.equal(await count(f,'cli_history_sync_state'),0);
  assert.equal((await f.call('status')).body.history_coverages[0].phase,'not_started');
  await f.control({historyMode:{[locator]:'empty'},messagesByLocator:{}});
  const failed=await f.call('enable');
  assert.equal(failed.status,200);
  assert.deepEqual(failed.body.history_coverages[0],{
    binding_id:binding.binding_id,contact_id:binding.contact_id,phase:'incomplete',failure_code:'history_empty',
    message_count:0,non_text_count:0,page_count:0,last_local_id:null,last_cursor:null,
    watermark_at:failed.body.history_coverages[0].watermark_at,
    started_at:failed.body.history_coverages[0].started_at,completed_at:null,
    updated_at:failed.body.history_coverages[0].updated_at,
  });
  const replyScope={owner_id:f.ownerId,contact_id:binding.contact_id,conversation_binding_id:binding.binding_id,confirmation:'desktop'};
  const blocked=()=>requireReplyScope(f.files.client,replyScope,{contact_id:binding.contact_id,allow_incomplete_history:false});
  await assert.rejects(blocked,{reason:'history_incomplete_confirmation_required'});
  await requireReplyScope(f.files.client,replyScope,{contact_id:binding.contact_id,allow_incomplete_history:true});

  const before=(await f.commands()).length;
  assert.equal((await f.call('disable')).status,200);
  assert.equal((await f.call('cycle')).status,200);
  assert.equal((await f.commands()).length,before);
  assert.equal((await state(f)).phase,'incomplete');
  assert.equal((await state(f)).message_count,0);
  await f.control({messagesByLocator:{[locator]:[{id:5,cursor:'recovered-history',body:'重开后历史',time:500}]}});
  assert.equal((await f.call('enable')).status,200);
  assert.equal((await state(f)).phase,'complete');
  assert.equal((await state(f)).message_count,1);
  assert.equal((await state(f)).failure_code,null);
  const completed=(await f.call('status')).body.history_coverages[0];
  assert.equal(completed.phase,'complete');
  await requireReplyScope(f.files.client,replyScope,{contact_id:binding.contact_id,allow_incomplete_history:false});
});

test('当前联系人优先但其他历史绑定不被饥饿，联系人写入与事件相互隔离',{timeout:90000},async t=>{
  const f=await fixture(t,{sessions:['custom-synthetic-a','custom-synthetic-b']});
  assert.equal(f.bindings.length,2);
  const [a,b]=f.bindings;
  await f.control({messagesByLocator:{
    [a.conversation_locator]:[{id:11,cursor:'a-1',body:'甲一',time:10},{id:12,cursor:'a-2',body:'甲二',time:20}],
    [b.conversation_locator]:[{id:11,cursor:'b-1',body:'乙一',time:10},{id:12,cursor:'b-2',body:'乙二',time:20}],
  }});
  for(let turn=0;turn<4;turn++)assert.equal((await f.call('cycle',{max_bindings:1,priority_contact_id:a.contact_id,priority_requested_at:turn})).status,200);
  const historyReads=(await f.commands()).filter(args=>args[0]==='tail'&&args.includes('--history')).map(args=>args[1]);
  assert.deepEqual(historyReads.slice(0,4),[a.conversation_locator,b.conversation_locator,a.conversation_locator,b.conversation_locator]);
  assert.equal((await state(f,a)).phase,'complete');
  assert.equal((await state(f,b)).phase,'complete');
  const rows=(await f.files.client.query('SELECT contact_id,text_content FROM message ORDER BY contact_id,text_content')).rows;
  assert.equal(rows.length,4);
  assert.deepEqual(new Set(rows.map(row=>row.contact_id)),new Set([a.contact_id,b.contact_id]));
  assert.equal(f.events.length,0);
});

test('既有更靠前的增量游标不回退，非文字只计覆盖不伪造正文',{timeout:90000},async t=>{
  const f=await fixture(t,{authorize:false});
  const binding=f.bindings[0],locator=binding.conversation_locator;
  await f.control({incremental:[{id:900,cursor:'ahead-900',body:'授权后增量',time:900}]});
  assert.equal((await f.call('cycle',{max_bindings:1})).status,200);
  assert.equal((await f.files.client.query('SELECT last_local_id,last_cursor FROM wechat_observation_cursor')).rows[0].last_cursor,'ahead-900');
  await f.files.client.query('DELETE FROM wechat_observation_cursor');

  await grantBindingHistory(f.files.client,{ownerId:f.ownerId,accountScope:account},[binding.binding_id],new Date('2026-10-25T01:00:00Z'));
  await f.control({messagesByLocator:{[locator]:[
    {id:1,cursor:'history-text',body:'历史文字',time:1},
    {id:2,cursor:'history-image',kind:'image',time:2},
  ]},incremental:[]});
  await f.api.close();
  await f.start({pageLimit:10});
  const result=await f.call('cycle',{max_bindings:1});
  assert.equal(result.status,200);
  const coverage=result.body.history_coverages[0];
  assert.equal(coverage.phase,'complete');
  assert.equal(coverage.message_count,1);
  assert.equal(coverage.non_text_count,1);
  assert.equal(coverage.page_count,1);
  assert.equal(await count(f,'wechat_observation_cursor'),0);
  const historySource=(await f.files.client.query("SELECT event_count,non_text_count,record_count,is_reliable FROM local_wechat_observation WHERE mode='cli_history'")).rows[0];
  assert.deepEqual(historySource,{event_count:2,non_text_count:1,record_count:1,is_reliable:false});
  assert.deepEqual((await f.files.client.query('SELECT text_content FROM message ORDER BY occurred_at')).rows.map(row=>row.text_content),
    ['历史文字','授权后增量']);
  assert.equal((await f.call('cycle',{max_bindings:1})).status,200);
  const store=new SyncIncrementalStore({storage:f.storage,ownerId:f.ownerId,accountScope:account});
  assert.deepEqual((await store.readPosition(binding)).cursor,{last_local_id:'900',last_cursor:'ahead-900'});
});

test('历史页派生回执写入失败时来源、消息、游标与检查点整体回滚并可重读',{timeout:90000},async t=>{
  const f=await fixture(t);
  const binding=f.bindings[0],locator=binding.conversation_locator;
  await f.control({messagesByLocator:{[locator]:[{id:31,cursor:'atomic-page',body:'原子页',time:31}]}});
  await f.files.client.query(`CREATE FUNCTION public.synthetic_fail_processing() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic processing failure'; END $$`);
  await f.files.client.query(`CREATE TRIGGER synthetic_fail_processing BEFORE INSERT ON public.source_processing_record
    FOR EACH ROW EXECUTE FUNCTION public.synthetic_fail_processing()`);
  const failed=await f.call('cycle',{max_bindings:1});
  assert.equal(failed.status,200);
  const stateAfterFailure=await state(f);
  assert.equal(stateAfterFailure.phase,'syncing');
  assert.equal(stateAfterFailure.last_cursor,null);
  assert.equal(stateAfterFailure.message_count,0);
  assert.equal(await count(f,'message'),0);
  assert.equal(await count(f,'local_wechat_observation'),0);
  assert.equal(await count(f,'wechat_observation_cursor'),0);

  await f.files.client.query('DROP TRIGGER synthetic_fail_processing ON public.source_processing_record');
  await f.files.client.query('DROP FUNCTION public.synthetic_fail_processing()');
  await f.api.close();
  await f.start({pageLimit:1});
  const recovered=await f.call('cycle',{max_bindings:1});
  assert.equal(recovered.status,200);
  assert.equal((await state(f)).phase,'complete');
  assert.equal((await state(f)).last_cursor,'atomic-page');
  assert.equal(await count(f,'message'),1);
  assert.equal(await count(f,'local_wechat_observation'),1);
});

test('已删稳定身份不会由历史重读复活，覆盖只计实际接纳文字',{timeout:90000},async t=>{
  const f=await fixture(t);
  const binding=f.bindings[0],locator=binding.conversation_locator;
  await f.files.client.query(`INSERT INTO wechat_auto_read_suppression
    (owner_id,contact_id,external_local_id,identity_create_time) VALUES($1,$2,41,41)`,
    [f.ownerId,binding.contact_id]);
  await f.control({messagesByLocator:{[locator]:[
    {id:41,cursor:'suppressed-page',body:'不应复活的合成历史',time:41},
    {id:42,cursor:'kept-page',body:'可保存的合成历史',time:42},
  ]}});
  await f.call('cycle',{max_bindings:1});
  const result=await f.call('cycle',{max_bindings:1});
  assert.equal(result.status,200);
  assert.equal((await state(f)).phase,'complete');
  assert.equal((await state(f)).message_count,1);
  assert.deepEqual((await f.files.client.query('SELECT text_content FROM message')).rows,
    [{text_content:'可保存的合成历史'}]);
  const processing=JSON.stringify((await f.files.client.query('SELECT payload FROM source_processing_record')).rows);
  assert.ok(!processing.includes('不应复活的合成历史'));
});

test('侧删本机历史只标记对应联系人，其他会话继续；增量读取期间关闭不提交迟到页',{timeout:90000},async t=>{
  const f=await fixture(t,{sessions:['custom-synthetic-a','custom-synthetic-b']});
  const [a,b]=f.bindings;
  await f.control({historyMode:{[a.conversation_locator]:'deleted'},messagesByLocator:{
    [b.conversation_locator]:[{id:21,cursor:'b-page',body:'乙历史',time:10}],
  }});
  const first=await f.call('cycle',{max_bindings:1,priority_contact_id:a.contact_id,priority_requested_at:1});
  assert.equal(first.body.history_coverages.find(row=>row.contact_id===a.contact_id).phase,'incomplete');
  assert.equal(first.body.history_coverages.find(row=>row.contact_id===a.contact_id).failure_code,'local_history_deleted');
  const second=await f.call('cycle',{max_bindings:1});
  assert.equal(second.status,200);
  assert.equal((await state(f,b)).phase,'complete');
  assert.equal(await count(f,'message'),1);
  const completedAt=(await state(f,b)).completed_at.toISOString();
  await f.control({notPrivate:{[b.conversation_locator]:true},messagesByLocator:{}});
  await f.call('check');
  await f.call('cycle',{max_bindings:1,priority_contact_id:b.contact_id,priority_requested_at:2});
  const scopeIncomplete=await state(f,b);
  assert.equal(scopeIncomplete.phase,'incomplete');
  assert.equal(scopeIncomplete.failure_code,'cli_scope_unverified');
  assert.equal(scopeIncomplete.completed_at.toISOString(),completedAt);
  await f.control({messagesByLocator:{}});
  await f.call('check');
  await f.call('priority',{priority_contact_id:a.contact_id,priority_requested_at:3});
  const restored=await f.call('cycle',{max_bindings:1,priority_contact_id:b.contact_id,priority_requested_at:3});
  assert.equal(restored.body.history_coverages.find(row=>row.contact_id===b.contact_id).phase,'complete');
  assert.equal((await state(f,b)).completed_at.toISOString(),completedAt);

  // 新开一个未完成绑定，挂起历史读取后关闭。
  await f.files.client.query("UPDATE cli_history_sync_state SET phase='syncing',last_local_id=NULL,last_cursor=NULL,completed_at=NULL WHERE binding_id=$1",[b.binding_id]);
  await f.control({historyMode:{[b.conversation_locator]:'hang'}});
  await f.call('check');
  await f.call('priority',{priority_contact_id:a.contact_id,priority_requested_at:4});
  await f.call('cycle',{max_bindings:1,priority_contact_id:a.contact_id,priority_requested_at:4});
  const running=f.call('cycle',{max_bindings:1,priority_contact_id:b.contact_id,priority_requested_at:2});
  const deadline=Date.now()+5000;
  while(!(await readFile(f.startedPath,'utf8').catch(()=>null))){
    if(Date.now()>deadline)throw new Error('合成历史读取未启动');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const before=(await state(f,b));
  assert.equal((await f.call('disable')).status,200);
  assert.equal((await running).status,200);
  const afterState=await state(f,b);
  assert.equal(afterState.phase,'syncing');
  assert.equal(afterState.last_cursor,before.last_cursor);
  assert.equal(afterState.message_count,before.message_count);
});
