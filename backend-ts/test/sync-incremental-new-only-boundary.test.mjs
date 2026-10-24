import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {HostStorage} from '../src/host-storage.ts';
import {BindingService} from '../src/binding-service.ts';
import {SyncScopeService} from '../src/sync-scope.ts';
import {WechatSessions} from '../src/wechat-sessions.ts';
import {SyncIncrementalCli} from '../src/sync-incremental-cli.ts';
import {SyncIncrementalStore} from '../src/sync-incremental-store.ts';
import {SyncIncrementalRecovery} from '../src/sync-incremental-recovery.ts';
import {SyncIncrementalEngine} from '../src/sync-incremental-engine.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';

async function fixture(t,{baseline,timeZone='Asia/Taipei',invalidPosition=false,preciseBaseline=false}) {
  const previousZone=process.env.TZ;
  process.env.TZ=timeZone;
  t.after(()=>{if(previousZone===undefined)delete process.env.TZ;else process.env.TZ=previousZone;});
  const f=await createStorageFixture();
  let storage,engine,bindingService,scope;
  t.after(async()=>{await engine?.close();await bindingService?.close();scope?.close();await storage?.close();await f.close();});
  storage=await HostStorage.open(f.options);
  const {owner_id:owner}=await storage.initializeOwner('合成边界用户');
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-boundary-account','合成账号')",[owner]);
  const accountScope='synthetic-boundary-account',locator='synthetic-boundary-friend';
  let binding;
  if(preciseBaseline){
    // 既有 Python 建联事务保留 PG 微秒；不改测试库 baseline 来凑边界。
    const program=[
      'import json,sys',
      'from datetime import datetime',
      'from uuid import UUID',
      'from notalone.persistence.conversation_repository import PostgresConversationBindingRepository,CliBindingCreation',
      "name=sys.argv[1];assert name.startswith('notalone_ts_host_') and name.endswith('_test')",
      "repository=PostgresConversationBindingRepository('host=/tmp dbname='+name)",
      "binding,=repository.create_cli_bindings_batch(owner_id=UUID(sys.argv[2]),channel='wechat',account_scope=sys.argv[3],items=[CliBindingCreation(sys.argv[4],'合成边界联系人')],baseline_at=datetime.fromisoformat(sys.argv[5]))",
      "print(json.dumps({'binding_id':str(binding.binding_id),'contact_id':str(binding.scope.contact_id),'conversation_locator':binding.conversation_locator}))",
    ].join('\n');
    binding=JSON.parse(execFileSync(process.env.NOTALONE_TEST_PYTHON||join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',program,f.client.database,owner,accountScope,locator,baseline],{
      encoding:'utf8',timeout:15000,env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_MANAGED_USER_DATA:f.directory,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},
    }));
  }else{
    bindingService=new BindingService({
      storage,ownerId:owner,channel:'wechat',accountScope,clock:()=>new Date(baseline),
      sessions:async()=>[{username:locator,display_name:'合成边界联系人',chat_type:'private'}],
    });
    [binding]=await bindingService.confirm([{locator}]);
  }
  scope=new SyncScopeService({storage,ownerId:owner,accountScope});
  await scope.setMode({mode:'selected',confirmed:true});
  const store=new SyncIncrementalStore({storage,ownerId:owner,accountScope});
  await store.setEnabled(true);
  const epoch=Math.floor(Date.parse(baseline)/1000);
  const dataPath=join(f.directory,'synthetic-boundary.json'),log=join(f.directory,'commands.jsonl');
  await writeFile(log,'');
  await writeFile(dataPath,JSON.stringify({locator,messages:[
    {id:1,at:epoch-1,text:'合成前一秒'},
    {id:2,at:epoch,text:'合成边界所在秒'},
    {id:3,at:epoch+1,text:'合成下一秒'},
  ]}));
  const executable=join(f.directory,'synthetic-boundary-cli');
  const program=[
    '#!'+process.execPath,
    "import fs from 'node:fs';",
    'const args=process.argv.slice(2);',
    'const data=JSON.parse(fs.readFileSync('+JSON.stringify(dataPath)+",'utf8'));",
    'fs.appendFileSync('+JSON.stringify(log)+",JSON.stringify(args)+'\\n');",
    'const emit=data=>console.log(JSON.stringify({ok:true,data}));',
    "if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-boundary-account'}}});",
    "else if(args[0]==='resolve-chat')emit({candidates:[{username:data.locator,display_name:'合成边界联系人',chat_type:'private'}]});",
    "else if(args[0]==='--version')emit({version:'synthetic-boundary-1'});",
    "else if(args[0]==='tail'&&args.includes('--mode'))setInterval(()=>{},1000);",
    "else if(args[0]==='tail'){",
    " const cursor=args.includes('--cursor')?args[args.indexOf('--cursor')+1]:null;",
    " const since=args.includes('--since-time')?Date.parse(args[args.indexOf('--since-time')+1])/1000:null;",
    " const selected=data.messages.filter(row=>cursor?row.id>Number(cursor.split('-').at(-1)):since!==null&&row.at>=since);",
    " const events=selected.map(row=>({type:'message',cursor:'boundary-'+row.id,message:{id:{local_id:row.id,talker:data.locator},kind:'text',text:row.text,is_from_me:false,create_time:row.at}}));",
    " emit({events,cursor:events.at(-1)?.cursor??cursor,freshness:{message_source:'live_message_db'},query:{chat:data.locator,has_more:false}});",
    '}else process.exit(2);',
  ].join('\n');
  await writeFile(executable,program,{mode:0o700});
  const cli=new SyncIncrementalCli({executable}),sessions=new WechatSessions({executable});
  // 非法时间不能写进PG；仅在存储端口返回处注入坏值，验证读取前失败关闭。
  const engineStore=invalidPosition?new Proxy(store,{get(target,key){
    if(key==='readPosition')return async(...args)=>({...await target.readPosition(...args),query_since_at:'not-a-date'});
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}):store;
  const recovery=new SyncIncrementalRecovery({store,storage,ownerId:owner});
  engine=new SyncIncrementalEngine({store:engineStore,recovery,scope,cli,sessions,ownerId:owner,accountScope,publish:async()=>{}});
  return {...f,owner,binding,store,engine,async commands(){
    return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  },async messages(){
    return (await f.client.query('SELECT wm.external_local_id,wm.source_create_time FROM public.message m JOIN public.wechat_message_metadata wm ON wm.message_id=m.id AND wm.owner_id=m.owner_id AND wm.contact_id=m.contact_id WHERE m.owner_id=$1 ORDER BY wm.external_local_id',[owner])).rows;
  }};
}

test('真实PG毫秒baseline不读取同秒更早消息，后续沿原cursor而非重建起点',async t=>{
  const baseline='2026-10-24T01:00:00.750Z';
  const f=await fixture(t,{baseline});
  await f.engine.cycle({maxBindings:1});
  const tail=(await f.commands()).find(args=>args[0]==='tail'&&!args.includes('--mode'));
  assert.ok(tail,'必须真正执行合成CLI正文查询');
  assert.equal(tail[tail.indexOf('--since-time')+1],'2026-10-24T09:00:01');
  assert.ok(Date.parse(tail[tail.indexOf('--since-time')+1])>=Date.parse(baseline));
  assert.deepEqual((await f.messages()).map(row=>row.external_local_id),['3']);
  assert.ok((await f.messages()).every(row=>Number(row.source_create_time)*1000>=Date.parse(baseline)));
  const baselineRow=(await f.client.query('SELECT baseline_at FROM public.wechat_observation_baseline WHERE binding_id=$1',[f.binding.binding_id])).rows[0];
  assert.equal(baselineRow.baseline_at.toISOString(),baseline,'不得修改已存baseline来掩盖读边界');
  assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization')).rows[0].n,0);
  f.engine.requestCheck();
  await f.engine.cycle({maxBindings:1});
  const latest=(await f.commands()).filter(args=>args[0]==='tail'&&!args.includes('--mode')).at(-1);
  assert.equal(latest[latest.indexOf('--cursor')+1],'boundary-3');
  assert.equal(latest.includes('--since-time'),false);
});

test('Python微秒baseline在PG原值上比较，实际正文argv不得提前',async t=>{
  const baseline='2026-10-24T01:00:00.000001Z';
  const f=await fixture(t,{baseline,timeZone:'UTC',preciseBaseline:true});
  const position=await f.store.readPosition(f.binding);
  assert.equal(position.query_since_at,'2026-10-24T01:00:01.000Z');
  assert.equal(position.cursor,null);
  const repeated=await f.store.readPosition(f.binding);
  assert.equal(repeated.position_token,position.position_token,'计算查询下界不能推进position token');
  assert.equal(repeated.cursor,null,'计算查询下界不能创建cursor');
  await f.engine.cycle({maxBindings:1});
  const tail=(await f.commands()).find(args=>args[0]==='tail'&&!args.includes('--mode'));
  assert.ok(tail,'必须真正执行合成CLI正文查询');
  const since=tail[tail.indexOf('--since-time')+1];
  const row=(await f.client.query("SELECT baseline_at=$2::timestamptz AS unchanged,($3::timestamp AT TIME ZONE 'UTC')>=baseline_at AS not_earlier FROM public.wechat_observation_baseline WHERE binding_id=$1",[f.binding.binding_id,baseline,since])).rows[0];
  assert.equal(row.unchanged,true,'生产建联保存的微秒baseline必须保持不变');
  assert.equal(row.not_earlier,true,'实际CLI参数必须不早于PG微秒原值');
  assert.equal(since,'2026-10-24T01:00:01');
  assert.deepEqual((await f.messages()).map(message=>message.external_local_id),['3']);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization')).rows[0].n,0);
});

for(const example of [
  {name:'整秒UTC保持原起点',baseline:'2026-10-24T01:00:00.000Z',timeZone:'UTC',expected:'2026-10-24T01:00:00',ids:['2','3']},
  {name:'台湾时区跨年向上取整',baseline:'2026-12-31T15:59:59.999Z',timeZone:'Asia/Taipei',expected:'2027-01-01T00:00:00',ids:['3']},
  {name:'负偏移时区使用同一时间上界',baseline:'2026-07-01T12:00:00.001Z',timeZone:'America/New_York',expected:'2026-07-01T08:00:01',ids:['3']},
])test('真实PG增量边界：'+example.name,async t=>{
  const f=await fixture(t,example);
  await f.engine.cycle({maxBindings:1});
  const tail=(await f.commands()).find(args=>args[0]==='tail'&&!args.includes('--mode'));
  assert.ok(tail);
  const since=tail[tail.indexOf('--since-time')+1];
  assert.equal(since,example.expected);
  assert.ok(Date.parse(since)>=Date.parse(example.baseline));
  assert.deepEqual((await f.messages()).map(row=>row.external_local_id),example.ids);
  assert.equal(tail.includes('--history'),false);
  assert.equal(tail[tail.indexOf('--include-media-paths')+1],'false');
  assert.equal(tail.includes('--strict-read-only'),true);
});

test('非法查询下界在CLI正文查询前拒绝，不写入任何消息',async t=>{
  const f=await fixture(t,{baseline:'2026-10-24T01:00:00.750Z',invalidPosition:true});
  const status=await f.engine.cycle({maxBindings:1});
  assert.equal(status.failure_code,'cli_sync_failed');
  assert.equal((await f.commands()).some(args=>args[0]==='tail'&&!args.includes('--mode')),false);
  assert.deepEqual(await f.messages(),[]);
});

test('夏令时回拨后的重名本地时间不能退回授权前，无法表达则拒绝读取',async t=>{
  const f=await fixture(t,{baseline:'2026-11-01T06:30:00.750Z',timeZone:'America/New_York'});
  const status=await f.engine.cycle({maxBindings:1});
  assert.equal(status.failure_code,'cli_sync_failed');
  assert.equal((await f.commands()).some(args=>args[0]==='tail'&&!args.includes('--mode')),false);
  assert.deepEqual(await f.messages(),[]);
});
