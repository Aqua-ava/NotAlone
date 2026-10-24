/** 后端生命周期回归：带数据的launcher父丢失，不等同Electron崩溃或停机追赶。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {captureProcessIdentity,processIdentityState} from '../src/process-identity.ts';

const projectDirectory=resolve(new URL('../../',import.meta.url).pathname);
const helperPath=new URL('./sync-incremental-parent-loss-helper.mjs',import.meta.url).pathname;

async function exists(path){
  try{await stat(path);return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}
async function until(check,label,timeout=20000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await check();if(value)return value;await delay(100);}
  throw new Error(`有界等待失败：${label}`);
}
const readJSON=async path=>JSON.parse(await readFile(path,'utf8'));
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
const bodyQueries=commands=>commands.filter(command=>command.args[0]==='tail'&&!command.args.includes('--follow')&&!command.args.includes('--mode'));

async function snapshot(client){
  const result={};
  for(const table of ['conversation_binding','wechat_observation_baseline','wechat_observation_cursor',
    'wechat_sync_scope','wechat_sync_exclusion','wechat_binding_history_authorization','front_sync_state',
    'message','message_source_ref','wechat_message_metadata','local_wechat_observation',
    'source_processing_record','memory_extraction_receipt']){
    result[table]=(await client.query(`SELECT row_to_json(t) value FROM public.${table} t`)).rows
      .map(row=>row.value).sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return result;
}

async function syntheticCli(directory){
  const control=join(directory,'control.json'),log=join(directory,'commands.jsonl');
  const executable=join(directory,'synthetic-cli');
  await writeFile(control,JSON.stringify({incremental:false}));await writeFile(log,'');
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,parent:process.ppid,pid:process.pid})+'\\n');
const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(args[0]==='--version')emit({version:'synthetic-1'});
else if(args[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成联系人',chat_type:'private',last_timestamp:1}]});
else if(args[0]==='resolve-chat')emit({candidates:[{username:args[1],display_name:'合成联系人',chat_type:'private'}]});
else if(args.includes('--follow')||args.includes('--mode'))setInterval(()=>{},1000);
else if(args[0]==='tail'&&!args.includes('--history')){
  const cursor=args.includes('--cursor')?args[args.indexOf('--cursor')+1]:null;
  // 重启后仍交付同一个稳定身份，不创建停机期间新消息。
  const messages=state.incremental?[{id:2,cursor:'incremental-2',text:'合成父丢失前已同步消息'}]:[];
  emit({events:messages.map(message=>({type:'message',cursor:message.cursor,message:{id:{local_id:message.id,talker:args[1]},kind:'text',text:message.text,is_from_me:false,create_time:state.at}})),cursor:messages.at(-1)?.cursor??cursor,freshness:{message_source:'live_message_db'},query:{chat:args[1],has_more:false,history:false}});
}else process.exit(2);`,{mode:0o700});
  return {control,executable,commands:async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)};
}

async function lifecycle(t,fixture,configuration,cli){
  const configurationPath=join(fixture.directory,'parent-loss-launch.json');
  await writeFile(configurationPath,JSON.stringify(configuration),{mode:0o600});
  const helpers=[],identities=[],profiles=[];
  let currentConnection,currentDsh,currentLegacy,normalCompletion=false,fixtureClosed=false;
  const database=(await fixture.client.query('SELECT current_database() name')).rows[0].name;
  const identity=createHash('sha256').update(JSON.stringify([configuration.infoPath,configuration.envFilePath])).digest('hex').slice(0,24);
  const modelSocket=join('/tmp',`na-model-${process.getuid()}-${identity}`,'p.sock');
  const modelJournal=join(fixture.directory,'model-permits',identity,'state.json');
  async function request(path,body){
    const response=await fetch(`http://${currentConnection.address}${path}`,{
      method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${currentConnection.token}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000),
    });
    return {status:response.status,data:await response.json()};
  }
  async function start(){
    const helper=spawn(process.execPath,[helperPath,configurationPath],{
      cwd:projectDirectory,env:{PATH:process.env.PATH,USER:process.env.USER,LOGNAME:process.env.LOGNAME,HOME:fixture.directory,TMPDIR:configuration.environment.TMPDIR},
      stdio:['ignore','ignore','ignore','ipc'],
    });
    helpers.push(helper);
    const parent=await captureProcessIdentity(helper.pid,process.pid,process.execPath);identities.push(parent);
    const launched=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('父宿主启动超时')),15000);
      helper.on('message',message=>{
        if(message.type==='launched'){clearTimeout(timer);resolve(message);}
        else if(message.type==='failed'){clearTimeout(timer);reject(new Error('父宿主启动失败'));}
      });
      helper.once('exit',()=>{clearTimeout(timer);reject(new Error('父宿主在启动回执前退出'));});
    });
    const lock=await readJSON(configuration.infoPath+'.dsh-lock');profiles.push(lock.home);
    // spawn回执可能先于exec完成；只在身份稳定后取得本轮进程所有权。
    const dsh=await until(async()=>{try{return await captureProcessIdentity(launched.pid,helper.pid,process.execPath);}catch{return false;}},'DSH进程身份稳定',5000);
    identities.push(dsh);currentDsh=dsh;
    await until(async()=>{
      if(await processIdentityState(dsh)!=='same')throw new Error('DSH在握手前退出');
      try{
        const text=await readFile(configuration.infoPath,'utf8');
        currentConnection=Object.fromEntries(text.trim().split('\n').map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));
        return true;
      }catch(error){if(error.code==='ENOENT')return false;throw error;}
    },'官方profile认证握手');
    const legacy=(await readJSON(join(lock.home,'legacy.pid'))).identity;identities.push(legacy);currentLegacy=legacy;
    const runtime=await request('/api/runtime/status');assert.equal(runtime.status,200);
    assert.equal(runtime.data.pid,dsh.pid);assert.equal(runtime.data.legacyPid,legacy.pid);
    assert.equal(runtime.data.ownership.wechatIncremental,'typescript');assert.equal(runtime.data.ownership.wechatHistory,'python');
    assert.equal(runtime.data.ownership.replies,'typescript');
    assert.deepEqual(runtime.data.reply,{runtime:'typescript',state:'unconfigured',reason:'reply_model_unconfigured'});
    assert.deepEqual(await readJSON(join(lock.home,'profiles/notalone/package.json')),{private:true,dsh:{profile:{bundles:[]}}});
    return {helper,parent,dsh,legacy,lock};
  }
  t.after(async()=>{
    let emergency=false;
    try{
      // 仅失败收尾可停止已核身份的自有进程；不能把它计入自然恢复证据。
      if(!normalCompletion){
        emergency=true;
        if(currentConnection&&currentDsh&&await processIdentityState(currentDsh)==='same'){
          try{await request('/api/runtime/shutdown',{});await until(async()=>await processIdentityState(currentDsh)==='gone'&&await processIdentityState(currentLegacy)==='gone','失败收尾的公开关闭',12000);}catch{}
        }
        for(const owned of [...identities].reverse()){
          if(await processIdentityState(owned)!=='same')continue;
          process.kill(owned.pid,'SIGTERM');
          try{await until(async()=>await processIdentityState(owned)==='gone','自有进程退出',5000);}
          catch{if(await processIdentityState(owned)==='same')process.kill(owned.pid,'SIGKILL');}
        }
      }
      for(const helper of helpers)if(helper.connected)helper.disconnect();
      for(const owned of identities)assert.equal(await processIdentityState(owned),'gone');
      assert.ok((await cli.commands()).every(command=>!alive(command.pid)));
      // 只剩fixture自己的PG连接，才沿既有fixture释放数据库。
      await until(async()=>(await fixture.client.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()')).rows[0].n===1,'自有运行时PG连接退出',5000);
      await fixture.close();fixtureClosed=true;
      const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
      try{assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);assert.equal((await admin.query('SELECT 1')).rowCount,1);}
      finally{await admin.end();}
      t.diagnostic(JSON.stringify({cleanup:{emergency,owned_processes_gone:identities.length,fixture_removed:!await exists(fixture.directory),database_absent:true,shared_pg_preserved:true}}));
    }finally{
      if(!fixtureClosed)t.diagnostic('失败现场未通过所有权/连接检查，未强制清库。');
    }
  });
  return {start,request,modelSocket,modelJournal,async complete(){
    assert.equal((await request('/api/runtime/shutdown',{})).status,200);
    await until(async()=>await processIdentityState(currentDsh)==='gone'&&await processIdentityState(currentLegacy)==='gone','正常关闭DSH与Legacy');
    await until(async()=>!await exists(configuration.infoPath+'.dsh-lock'),'父宿主自然回收锁');
    await until(async()=>{for(const owned of identities)if(await processIdentityState(owned)!=='gone')return false;return true;},'两轮自有进程全部退出');
    assert.ok((await cli.commands()).every(command=>!alive(command.pid)));
    assert.equal(await exists(configuration.infoPath),false);assert.equal(await exists(modelSocket),false);
    for(const home of profiles)assert.equal(await exists(home),false);
    const journal=await readJSON(modelJournal);assert.equal(journal.host,null);assert.deepEqual(journal.active,[]);assert.deepEqual(journal.unknown,[]);
    normalCompletion=true;
  }};
}

test('官方profile：带数据的launcher父丢失停读，同库自动恢复且稳定消息不重复',{timeout:90000},async t=>{
  const fixture=await createStorageFixture();let lifecycleOwnsFixture=false;
  t.after(async()=>{if(!lifecycleOwnsFixture)await fixture.close();});
  const owner=randomUUID();
  await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成父丢失本人')",[owner]);
  await fixture.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  const cli=await syntheticCli(fixture.directory),runtimeTmp=join(fixture.directory,'tmp');await mkdir(runtimeTmp,{mode:0o700});
  await appendFile(fixture.envFilePath,`NOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_WECHAT_CLI=${cli.executable}\nNOTALONE_DISABLE_DOTENV=1\n`);
  const configuration={nodeExecutable:process.execPath,projectDirectory,envFilePath:fixture.envFilePath,
    infoPath:join(fixture.directory,'backend.info'),businessHome:fixture.directory,
    pythonExecutable:process.env.NOTALONE_TEST_PYTHON||join(homedir(),'miniconda3/envs/NotAlone/bin/python'),
    environment:{NOTALONE_DATABASE_URL:`host=/tmp dbname=${(await fixture.client.query('SELECT current_database() name')).rows[0].name}`,
      NOTALONE_OWNER_ID:owner,NOTALONE_REPLY_RUNTIME:'typescript',NOTALONE_WECHAT_CLI:cli.executable,
      NOTALONE_SKILLS_DIR:join(fixture.directory,'skills'),NOTALONE_MANAGED_USER_DATA:fixture.directory,NOTALONE_DISABLE_DOTENV:'1',TMPDIR:runtimeTmp}};
  const host=await lifecycle(t,fixture,configuration,cli);lifecycleOwnsFixture=true;
  const first=await host.start();
  await until(async()=>(await host.request('/api/sync/status')).status===200,'首次同步宿主就绪');
  assert.equal((await host.request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}],history_authorized:false})).status,200);
  const binding=(await host.request('/api/sync/cli-bindings')).data.bindings[0];assert.ok(binding);
  const baseline=(await fixture.client.query('SELECT baseline_at FROM public.wechat_observation_baseline WHERE binding_id=$1',[binding.binding_id])).rows[0].baseline_at;
  assert.equal((await host.request('/api/sync/enable',{})).status,200);
  await writeFile(cli.control,JSON.stringify({incremental:true,at:Math.max(Math.ceil(Date.now()/1000),Math.ceil(baseline.getTime()/1000))}));
  assert.equal((await host.request('/api/sync/check',{})).status,200);
  await until(async()=>(await fixture.client.query("SELECT count(*)::int n FROM public.source_processing_record WHERE outcome='message_created'")).rows[0].n===1,'一条新消息及创建回执');
  const before=await snapshot(fixture.client),message=before.message[0];
  assert.equal(before.message.length,1);assert.equal(message.text_content,'合成父丢失前已同步消息');
  assert.equal(before.memory_extraction_receipt.length,1);assert.equal(before.memory_extraction_receipt[0].task_id,null);
  assert.equal(before.wechat_binding_history_authorization.length,0);assert.equal(before.front_sync_state[0].enabled,true);
  const journalBefore=await readJSON(host.modelJournal);assert.equal(journalBefore.host.pid,first.dsh.pid);
  assert.deepEqual(journalBefore.active,[]);assert.deepEqual(journalBefore.unknown,[]);
  assert.equal(await processIdentityState(first.parent),'same');
  const parentExited=new Promise(resolve=>first.helper.once('exit',resolve));process.kill(first.parent.pid,'SIGKILL');await parentExited;assert.equal(first.helper.signalCode,'SIGKILL');
  // 只观察：原DSH/Legacy/CLI须自行停读，不能先帮它们终止或清journal。
  await until(async()=>await processIdentityState(first.dsh)==='gone'&&await processIdentityState(first.legacy)==='gone','父丢失自然结束DSH与Legacy');
  await until(async()=>(await cli.commands()).every(command=>!alive(command.pid)),'父丢失自然结束CLI',10000);
  assert.equal(await exists(configuration.infoPath),false);assert.equal(await exists(first.lock.home),false);assert.equal(await exists(host.modelSocket),false);
  assert.deepEqual(await readJSON(configuration.infoPath+'.dsh-lock'),first.lock);
  const journalStopped=await readJSON(host.modelJournal);assert.equal(journalStopped.host,null);assert.deepEqual(journalStopped.active,[]);assert.deepEqual(journalStopped.unknown,[]);
  const stoppedCommands=(await cli.commands()).length;
  await fixture.client.query('SELECT pg_sleep(0.25)');assert.equal((await cli.commands()).length,stoppedCommands);
  const priorRecords=new Set(before.source_processing_record.map(record=>record.record_id));
  const second=await host.start();assert.notEqual(second.lock.nonce,first.lock.nonce);assert.notEqual(second.dsh.pid,first.dsh.pid);
  // 相同配置、库和稳定ModelHost路径；只GET状态，不重新授权/enable/check/retry。
  await until(async()=>{
    if((await host.request('/api/sync/status')).status!==200)return false;
    return bodyQueries((await cli.commands()).slice(stoppedCommands)).some(command=>command.parent===second.dsh.pid&&command.args.includes('--cursor')&&command.args[command.args.indexOf('--cursor')+1]==='incremental-2');
  },'原授权与cursor自动恢复',30000);
  const after=await until(async()=>{
    const saved=await snapshot(fixture.client);
    return saved.source_processing_record.some(record=>!priorRecords.has(record.record_id)&&record.outcome==='message_reused')?saved:false;
  },'重交付保存reused回执');
  assert.equal(after.message.length,1);assert.deepEqual(after.message[0],message);
  for(const table of ['conversation_binding','wechat_observation_baseline','wechat_sync_scope','wechat_sync_exclusion','wechat_binding_history_authorization','wechat_message_metadata','memory_extraction_receipt'])assert.deepEqual(after[table],before[table]);
  assert.equal(after.front_sync_state[0].enabled,true);
  assert.equal(after.wechat_observation_cursor.length,1);
  for(const key of ['owner_id','contact_id','binding_id','conversation_locator','last_local_id','last_cursor'])assert.equal(after.wechat_observation_cursor[0][key],before.wechat_observation_cursor[0][key]);
  for(const source of before.message_source_ref)assert.deepEqual(after.message_source_ref.find(row=>row.id===source.id),source);
  for(const record of before.source_processing_record)assert.deepEqual(after.source_processing_record.find(row=>row.record_id===record.record_id),record);
  const originalSources=new Set(before.message_source_ref.map(source=>source.id));
  for(const source of after.message_source_ref){
    assert.equal(source.owner_id,owner);assert.equal(source.contact_id,binding.contact_id);assert.equal(source.message_id,message.id);
    assert.ok(after.local_wechat_observation.some(observation=>observation.id===source.observation_id&&observation.binding_id===binding.binding_id));
    if(!originalSources.has(source.id))assert.ok(after.source_processing_record.some(record=>record.outcome==='message_reused'&&record.message_id===message.id&&record.source_ref_id===source.id&&record.payload.persistence.source_ref_id===source.id&&record.payload.model_read_status==='not_claimed'));
  }
  const journalAfter=await readJSON(host.modelJournal);assert.equal(journalAfter.host.pid,second.dsh.pid);assert.deepEqual(journalAfter.active,[]);assert.deepEqual(journalAfter.unknown,[]);
  for(const table of ['background_task','background_task_step','model_call_receipt','model_call_learning_claim','outbound_ledger_entry','reply_request','reply_attempt'])assert.equal((await fixture.client.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n,0);
  const commands=await cli.commands();assert.ok(!commands.some(command=>command.args.includes('--history')));
  assert.ok(bodyQueries(commands).every(command=>command.args[1]==='friend-a'));
  t.diagnostic(JSON.stringify({messages:1,source_refs:after.message_source_ref.length,extraction_receipts:1,automatic_resume:true,history_queries:0,model_tasks:0}));
  await host.complete();
});
