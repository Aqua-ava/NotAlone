/** 正式profile与PG组合夹具；仅外部只读CLI返回合成事件。 */
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {launchDsh} from '../src/launch.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';

export async function waitForReconnectProbe(read,label,timeoutMs=35000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){const value=await read();if(value)return value;await delay(150);}
  throw new Error(`等待失败：${label}`);
}
export async function pathExists(path){
  try{await stat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
export function processAlive(pid){
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
}
export async function createReconnectFixture(t){
  const f=await createStorageFixture();
  let host,connection,closed;
  let launchAttempted=false;
  const requests=[];
  const database=(await f.client.query('SELECT current_database() AS name')).rows[0].name;
  const infoPath=join(f.directory,'backend.info');
  async function request(path,body){
    const method=body?'POST':'GET';requests.push({method,path});
    const response=await fetch(`http://${connection.address}${path}`,{method,headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(6000)});
    return {status:response.status,data:await response.json()};
  }
  async function close(){
    return closed??=(async()=>{
      const failures=[];
      const collect=async action=>{try{await action();}catch(error){failures.push(error);}};
      // 尚未拿到handle不代表启动清理已完成。
      let stopped=!launchAttempted;
      try{
        if(host){
          stopped=host.isRunning()?await host.terminate():await host.waitForExit(12000);
          assert.equal(stopped,true,'仅回收本夹具拥有的宿主');
        }
        // 正常排空断言先记录失败；后续紧急清理不能把该断言变绿。
        const active=(await f.client.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n;
        assert.equal(active,0,'宿主必须先关闭本测试库的所有业务连接');
      }catch(error){failures.push(error);}
      finally{
        if(stopped){
          // 退出已核实后，独立回收本轮资源，即使上面的排空断言失败。
          await collect(()=>f.close());
          await collect(async()=>{
            const admin=new pg.Client({host:'/tmp',database:'postgres'});
            try{await admin.connect();assert.equal((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[database])).rows[0].n,0);}
            finally{await admin.end();}
          });
          await collect(async()=>assert.equal(await pathExists(f.directory),false));
        }else{
          await collect(()=>f.client.end());
          failures.push(new Error('未确认自有宿主完整退出，保留本轮测试库和目录供排查'));
        }
      }
      if(failures.length===1)throw failures[0];
      if(failures.length>1)throw new AggregateError(failures,'宿主退出或本轮资源清理失败');
    })();
  }
  t.after(close);
  const owner=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成重连本人')",[owner]);
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  const control=join(f.directory,'control.json'),log=join(f.directory,'cli.jsonl'),generation=join(f.directory,'generation.json'),executable=join(f.directory,'synthetic-cli');
  await writeFile(control,JSON.stringify({at:0}));await writeFile(log,'');await writeFile(generation,JSON.stringify({n:0}));
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
const gen=()=>JSON.parse(fs.readFileSync(${JSON.stringify(generation)},'utf8')).n;
const log=(kind,extra={})=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({kind,args,pid:process.pid,parent:process.ppid,at:Date.now(),...extra})+'\\n');
const emit=data=>console.log(JSON.stringify({ok:true,data}));log('command');
if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(args[0]==='--version')emit({version:'synthetic-1'});
else if(args[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成重连联系人',chat_type:'private',last_timestamp:1},{username:'outside-b',display_name:'合成范围外',chat_type:'private',last_timestamp:1}]});
else if(args[0]==='resolve-chat')emit({candidates:[{username:args[1],display_name:'合成重连联系人',chat_type:'private'}]});
else if(args[0]==='tail'&&args.includes('--follow')&&args[args.indexOf('--mode')+1]==='sessions'){
 const n=gen()+1;fs.writeFileSync(${JSON.stringify(generation)},JSON.stringify({n}));log('stream_start',{generation:n});
 console.log(JSON.stringify({type:'session',cursor:'global-'+n+'-friend',username:'friend-a'}));
 console.log(JSON.stringify({type:'session',cursor:'global-'+n+'-outside',username:'outside-b'}));
 // 留出一个真实3秒heartbeat读取第一代metadata，再由外部CLI自然异常退出。
 if(n===1)setTimeout(()=>{log('stream_exit',{generation:n,code:7});process.exit(7);},4500);
 else {setTimeout(()=>{log('stream_replay',{generation:n});console.log(JSON.stringify({type:'session',cursor:'global-'+n+'-replay',username:'friend-a'}));},5200);setInterval(()=>{},1000);}
}else if(args[0]==='tail'&&!args.includes('--history')){
 if(args[1]!=='friend-a'){log('scope_violation');process.exit(9);}
 const n=gen(),messages=[{id:2,cursor:'message-2',text:'合成断流前稳定消息'},...(n>=2?[{id:3,cursor:'message-3',text:'合成自动重连后新消息'}]:[])];
 log('body',{generation:n,ids:messages.map(m=>m.id)});
 emit({events:messages.map(m=>({type:'message',cursor:m.cursor,message:{id:{local_id:m.id,talker:args[1]},kind:'text',text:m.text,is_from_me:false,create_time:state.at}})),cursor:messages.at(-1).cursor,freshness:{message_source:'live_message_db'},query:{chat:args[1],has_more:false,history:false}});
}else {log('unexpected_command');process.exit(2);}
`,{mode:0o700});
  const environment={NOTALONE_DATABASE_URL:'host=/tmp dbname='+database,NOTALONE_OWNER_ID:owner,NOTALONE_REPLY_RUNTIME:'typescript',NOTALONE_WECHAT_CLI:executable,NOTALONE_SKILLS_DIR:join(f.directory,'skills'),NOTALONE_MANAGED_USER_DATA:f.directory,NOTALONE_DISABLE_DOTENV:'1',TZ:'UTC'};
  await appendFile(f.envFilePath,Object.entries(environment).filter(([key])=>key.startsWith('NOTALONE_')).map(([key,value])=>key+'='+value).join('\n')+'\n');
  launchAttempted=true;
  host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve(new URL('../../',import.meta.url).pathname),envFilePath:f.envFilePath,infoPath,businessHome:f.directory,pythonExecutable:process.env.NOTALONE_TEST_PYTHON||join(homedir(),'miniconda3/envs/NotAlone/bin/python'),environment},()=>true);
  await waitForReconnectProbe(async()=>{
    if(!host.isRunning())throw new Error('官方DSH宿主早退');
    try{const value=await readFile(infoPath,'utf8');connection=Object.fromEntries(value.trim().split('\n').map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));return true;}
    catch(error){if(error.code!=='ENOENT')throw error;}
  },'官方profile认证握手',20000);
  const profileHome=JSON.parse(await readFile(infoPath+'.dsh-lock','utf8')).home;
  async function commands(){return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
  async function authority(){
    const rows={};
    for(const table of ['owner_channel_identity','wechat_sync_scope','wechat_sync_exclusion','conversation_binding','wechat_observation_baseline','wechat_binding_history_authorization'])rows[table]=(await f.client.query('SELECT to_jsonb(t) AS row FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows.map(r=>r.row);
    return rows;
  }
  return {...f,owner,host,infoPath,profileHome,request,requests,commands,authority,close,
    setMessageTime:at=>writeFile(control,JSON.stringify({at}))};
}
