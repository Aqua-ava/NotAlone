// 已授权单会话的独立开发验收；私有范围只存临时目录，页面由Computer Use操作。
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir,open,rm,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const project=process.env.NOTALONE_ACCEPTANCE_PROJECT_DIRECTORY;
const scopeFile=process.env.NOTALONE_REAL_SCOPE_FILE;
if(!project||!scopeFile)throw Error('缺少隔离源码或本轮私有范围文件');
const root=resolve(project),desktop=join(root,'desktop');
const {developmentProcesses,requireDevelopmentOnly}=await import(pathToFileURL(join(desktop,'scripts/development-policy.mjs')));
const previous=await developmentProcesses(desktop);requireDevelopmentOnly(previous);
if(previous.development.length)throw Error('已有开发实例，保留现场');
const permitted=JSON.parse(await readFile(scopeFile,'utf8'));
if(!permitted.account||!permitted.locator||!permitted.display_name||!permitted.cli||!permitted.probe)throw Error('本轮范围不完整');
const {createStorageFixture}=await import(pathToFileURL(join(root,'backend-ts/test/host-storage-fixture.mjs')));
const {HostStorage}=await import(pathToFileURL(join(root,'backend-ts/src/host-storage.ts')));
const {BindingService}=await import(pathToFileURL(join(root,'backend-ts/src/binding-service.ts')));
const {SyncScopeService}=await import(pathToFileURL(join(root,'backend-ts/src/sync-scope.ts')));
const {WechatSessions}=await import(pathToFileURL(join(root,'backend-ts/src/wechat-sessions.ts')));
const f=await createStorageFixture();
const metadataEnvironment={PATH:'/usr/bin:/bin',HOME:homedir(),LANG:'en_US.UTF-8',LC_ALL:'C',TMPDIR:process.env.TMPDIR||'/tmp'};
const sessions=new WechatSessions({executable:permitted.cli,environment:metadataEnvironment});
const metadataPath='/tmp/notalone-dsh-real-acceptance-session.json';
let storage,bindingService,scope,runner,runnerExited=false,runnerStopped=Promise.resolve(),metadataOwned=false,sawApp=false,trackingFailed=false;
const ownedGroups=new Set();
const userData=join(f.directory,'desktop'),infoPath=join(f.directory,'backend.info');
async function processState(){
  const state=await developmentProcesses(desktop,userData);
  for(const pid of [...state.development,...state.orphaned]){ownedGroups.add(pid);sawApp=true;}
  return state;
}
async function stoppedProof(){
  if(trackingFailed||runner&&!sawApp)return false;
  const state=await processState();
  if(state.development.length||state.orphaned.length)return false;
  for(const pid of ownedGroups){
    try{process.kill(-pid,0);return false;}
    catch(error){if(error.code!=='ESRCH')return false;}
  }
  // launchDsh只有排空原生/CLI并确认Python退出后才移除本轮握手与生命周期锁。
  for(const file of [infoPath,`${infoPath}.dsh-lock`]){
    try{await lstat(file);return false;}catch(error){if(error.code!=='ENOENT')return false;}
  }
  return true;
}
function stopRunner(){
  if(runner&&!runnerExited){try{process.kill(-runner.pid,'SIGINT');}catch(error){if(error.code!=='ESRCH')throw error;}}
}
async function trackBeforeStop(){
  try{await processState();}catch{trackingFailed=true;}
}
try{
  const reservation=await open(metadataPath,'wx',0o600);metadataOwned=true;
  try{await reservation.writeFile(JSON.stringify({phase:'preparing',project:root,directory:f.directory,database:f.client.database}));}
  finally{await reservation.close();}
  storage=await HostStorage.open(f.options);
  const {owner_id:owner}=await storage.initializeOwner('本机临时验收');
  await f.client.query("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat',$2,'本机临时账号')",[owner,permitted.account]);
  await f.client.query('INSERT INTO public.front_sync_state(owner_id,enabled) VALUES($1,false)',[owner]);
  bindingService=new BindingService({storage,ownerId:owner,channel:'wechat',accountScope:permitted.account,
    sessions:async options=>sessions.sessions({...options,expected_account:permitted.account})});
  const [binding]=await bindingService.confirm([{locator:permitted.locator,observed_display_name:permitted.display_name}],undefined,()=>{},false);
  scope=new SyncScopeService({storage,ownerId:owner,accountScope:permitted.account});
  await scope.setMode({mode:'selected',confirmed:true});
  const baseline=(await f.client.query('SELECT baseline_at::text AS baseline_at FROM public.wechat_observation_baseline WHERE binding_id=$1',[binding.binding_id])).rows[0].baseline_at;
  const history=(await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization')).rows[0].n;
  if(history!==0||(await f.client.query('SELECT count(*)::int n FROM public.message')).rows[0].n!==0)throw Error('新消息验收初态不满足');
  await mkdir(userData,{recursive:true});
  const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
  await writeFile(join(userData,'backend-launch.json'),JSON.stringify({pythonExecutable:python,projectDirectory:root,envFilePath:f.envFilePath,backendInfoPath:infoPath,wechatCliPath:permitted.cli,syncProbePath:permitted.probe}),{mode:0o600});
  const environment=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','USER','LOGNAME'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]));
  environment.PATH=dirname(process.execPath)+':'+dirname(python)+':'+(environment.PATH||'/usr/bin:/bin');
  const log=await open(join(f.directory,'dev.log'),'a',0o600);
  runner=spawn(process.execPath,[join(dirname(dirname(python)),'lib/node_modules/npm/bin/npm-cli.js'),'run','dev','--','--user-data-dir',userData],{cwd:desktop,env:environment,detached:true,stdio:['ignore',log.fd,log.fd]});
  if(runner.pid)ownedGroups.add(runner.pid);
  runnerStopped=new Promise(resolve=>{
    runner.once('error',()=>{runnerExited=true;console.log(JSON.stringify({event:'development_start_failed'}));resolve();});
    runner.once('exit',code=>{runnerExited=true;console.log(JSON.stringify({event:'development_exited',code}));resolve();});
  });
  await log.close();
  await writeFile(metadataPath,JSON.stringify({project:root,directory:f.directory,userData,infoPath,database:f.client.database,owner,contact:binding.contact_id,binding:binding.binding_id,baseline,runner:runner.pid,scopeFile}),{mode:0o600});
  // 一次有界就绪等待，同时登记实际Electron的独立进程组；未登记不宣称可清理。
  const deadline=Date.now()+20000;
  while(!runnerExited&&!sawApp&&Date.now()<deadline){
    try{await processState();}catch{trackingFailed=true;throw Error('无法核验开发进程，保留现场');}
    if(!sawApp)await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!sawApp)throw Error('未登记实际开发App，保留现场');
  console.log(JSON.stringify({event:'development_started',selected_bindings:1,history_authorizations:0,enabled:false,model_credentials_inherited:false}));
  for await(const line of createInterface({input:process.stdin})){
    if(line==='status')console.log(JSON.stringify(await processState()));
    else if(line==='proof'){
      const counts=(await f.client.query(`SELECT (SELECT count(*)::int FROM public.contact) contacts,(SELECT count(*)::int FROM public.conversation_binding WHERE status='active') active_bindings,(SELECT count(*)::int FROM public.wechat_binding_history_authorization) history_authorizations,(SELECT count(*)::int FROM public.message) messages,(SELECT count(*)::int FROM public.reply_request) reply_requests,(SELECT count(*)::int FROM public.outbound_ledger_entry) outbound_calls`)).rows[0];
      console.log(JSON.stringify({event:'isolated_counts',...counts}));
    }else if(line==='stop'){await trackBeforeStop();stopRunner();}
    else if(line==='cleanup'){
      if(!runnerExited||!await stoppedProof()){console.log('自有运行资源未确认停止，保留现场');continue;}
      break;
    }
  }
}finally{
  await trackBeforeStop();
  stopRunner();
  if(runner&&!runnerExited){
    let timer;
    try{await Promise.race([runnerStopped,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('开发实例退出超时，保留现场')),10000);})]);}
    finally{clearTimeout(timer);}
  }
  await bindingService?.close();scope?.close();await sessions.close();await storage?.close();
  if(!await stoppedProof())throw Error('停止证据不足，保留本轮数据库、目录与元数据');
  await f.close();if(metadataOwned)await rm(metadataPath,{force:true});
  console.log(JSON.stringify({event:'isolated_resources_cleaned'}));process.stdin.pause();
}
