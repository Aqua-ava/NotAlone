import {SkillHost} from './skills/skill-host.ts';
import {SkillLibraryError,skillLibraryRoute} from './skills/skill-library.ts';
import {skillLearningRoute} from './skills/skill-learning-http.ts';
import {resolveSkillsRoot} from './skills/skills-root.ts';
import type {} from '@deepseek-ai/dsh-cmdline';
import type { Context } from '@deepseek-ai/cordis';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { HostStorage, HostStorageError } from './platform/database/host-storage.ts';
import { ContactContext, ContactContextError, contactContextRoute } from './contacts/contact-context.ts';
import { ContactHandoff } from './contacts/contact-handoff.ts';
import { MemoryService, memoryRoute } from './memory/records/service.ts';
import { MemoryError } from './memory/records/errors.ts';
import { PreferenceService, PreferenceError, preferenceRoute } from './preferences/preference-service.ts';
import { MemoryManagementHandoff } from './memory/records/handoff.ts';
import { parseMemoryManagementJSON } from './memory/records/json.ts';
import { readWechatHttpBody, WechatHttpBodyError } from './sync/wechat-http-body.ts';
import { parseJson, stringifyJson } from './host/host-json.ts';
import { createWechatScopeApi, isWechatScopeRoute, wechatScopeBodyLimit } from './sync/wechat-scope-api.ts';
import {createForegroundLocationApi,foregroundLocationPath,isForegroundAuthorityMutation} from './foreground/foreground-location-api.ts';
import {NativeForegroundProbe} from './foreground/foreground-location-probe.ts';
import { createSyncIncrementalApi } from './sync/sync-incremental-api.ts';
import {resolveHistoryRuntime} from './imports/history-runtime.ts';
import {startHostModelRuntime} from './host/host-model-runtime.ts';
import {usageSummary} from './diagnostics/usage-summary.ts';
import {ExtractionTaskStore} from './memory/extraction/tasks/store.ts';
import {ExtractionProgressApi} from './memory/extraction/tasks/progress-http.ts';
import {SourceProcessingTraceStore} from './diagnostics/source-processing-trace.ts';
import {SourceProcessingTraceApi} from './diagnostics/source-processing-trace-http.ts';
import {HistoryImportApi} from './imports/history-import-api.ts';
import {PostgresTaskStatusStore,TaskApi} from './tasks/task-api.ts';
import {BusinessTaskApi,PostgresBusinessTaskManager} from './tasks/background-task-management.ts';
import {CrossDomainDeletionService,crossDomainDeletionRoute,serveCrossDomainDeletion} from './deletion/cross-domain-deletion.ts';
import {pureTsRuntimeEnvironment} from './host/pure-ts-runtime.ts';
import {PureTsEvents} from './host/pure-ts-events.ts';
import {PureTsSync} from './host/pure-ts-sync.ts';
import {PureTsTaskEvents} from './host/pure-ts-task-events.ts';
import {PureTsFollowSmoke} from './host/pure-ts-follow-smoke.ts';
import {PureTsMaintenance} from './host/pure-ts-maintenance.ts';
import {acquireManagedDatabaseLease} from './platform/database/managed-database-lifetime.ts';
import {createLayeredMemoryManagement} from './memory/records/documents/service.ts';
import {
 UnavailableTaskControl,
 type TaskControlPort,type TaskScope,
} from './tasks/task-control.ts';
export const name = 'notalone-host';
export const inject = ['appReady','llm','agents','sessions','tools','systemPrompt','skills'];

/** 产品入口；身份和配置来自业务模块，不采用02的合成范围与模型。 */
export async function apply(ctx: Context) {
  try { await start(ctx); }
  catch { process.exitCode=1; process.stdin.pause(); throw new Error('HOST_START_FAILED'); }
}
async function start(ctx: Context) {
  const config = JSON.parse(await readFile(process.env.NOTALONE_HOST_CONFIG!, 'utf8'));
  if (process.ppid !== config.parentPid) throw new Error('HOST_PARENT_LOST');
  const releaseDatabaseLease=process.env.NOTALONE_MANAGED_LIFETIME_LOCK
    ?await acquireManagedDatabaseLease(process.env.NOTALONE_MANAGED_LIFETIME_LOCK):undefined;
  // 启动失败也只释放本次打开的共享锁；数据库监督器仍按同一文件核验独占退出。
  process.once('exit',()=>{void releaseDatabaseLease?.();});
  const token = randomBytes(32).toString('base64url');
  const scopeToken = randomBytes(32).toString('base64url');
  const incrementalToken = randomBytes(32).toString('base64url');
  let state: 'running'|'stopping'|'stopped' = 'running';
  let published = false;
  const terminate = () => { state='stopping';process.kill(process.pid,'SIGTERM'); };
  process.stdin.resume();
  process.stdin.once('end',terminate);
  // 父宿主被强杀无法执行finally；仅清理其为本次进程创建的专属临时目录。
  const exitCleanup = () => {
    if (process.ppid === config.parentPid) return;
    rmSync(config.home,{recursive:true,force:true});
  };
  process.once('exit',exitCleanup);
  const storage = await HostStorage.open({envFilePath:config.envFilePath,migrationsDirectory:path.join(config.projectDirectory,'backend-ts/database/migrations'),environment:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('PG') || key.startsWith('NOTALONE_') && key!=='NOTALONE_HOST_CONFIG')),HOME:config.businessHome}});
  const compatibility = await storage.compatibility();
  if (compatibility.code !== 'ready') throw new Error('HOST_DATABASE_UNAVAILABLE');
  const ownerStatus=await storage.setupStatus();
  const progressPool=await storage.businessPool();
  const runtimeEnvironment=pureTsRuntimeEnvironment({...process.env,...storage.runtimeEnvironment(),HOME:config.businessHome});
  const hostEvents=new PureTsEvents(storage.runtimeOwnerId);
  const taskEvents=new PureTsTaskEvents(progressPool,storage.runtimeOwnerId,hostEvents);
  const observationTasks=new ExtractionTaskStore(progressPool);
  let activeTaskControl:TaskControlPort=new UnavailableTaskControl('worker_unavailable');
  const taskControl:TaskControlPort={
    run:(scope:TaskScope,taskId:string)=>activeTaskControl.run(scope,taskId),
    retry:(scope:TaskScope,taskId:string)=>activeTaskControl.retry(scope,taskId),
    wake:(scope:TaskScope,taskId:string)=>activeTaskControl.wake(scope,taskId),
    stop:(scope:TaskScope,taskId:string)=>activeTaskControl.stop?.(scope,taskId)??Promise.resolve(false),
  };
  const closeTaskControl=()=>{
    const close=(activeTaskControl as TaskControlPort&{close?:()=>Promise<void>}).close;
    return close?close.call(activeTaskControl):Promise.resolve();
  };
  const progress=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new ExtractionProgressApi(new ExtractionTaskStore(progressPool),storage.runtimeOwnerId,{
      // progress先于模型运行时装配；这里必须在请求时转发到启动后绑定的唯一TaskControl。
      wake:(scope,taskId)=>taskControl.wake(scope,taskId).then(()=>undefined),
    })
    : undefined;
  const traceStore=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new SourceProcessingTraceStore(progressPool)
    : undefined;
  const traces=traceStore&&storage.runtimeOwnerId
    ? new SourceProcessingTraceApi(traceStore,storage.runtimeOwnerId)
    : undefined;
  const imports=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new HistoryImportApi({
      transaction:work=>storage.businessTransaction(work),ownerId:storage.runtimeOwnerId,
      wake:(scope,taskId)=>taskControl.wake(scope,taskId),
    })
    : undefined;
  const tasks=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new TaskApi({ownerId:storage.runtimeOwnerId,store:new PostgresTaskStatusStore(progressPool),control:taskControl})
    : undefined;
  const taskManager=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new PostgresBusinessTaskManager(progressPool) : undefined;
  const businessTasks=taskManager&&storage.runtimeOwnerId
    ? new BusinessTaskApi({ownerId:storage.runtimeOwnerId,manager:taskManager,
      onStopped:async request=>{
        const contactId=request.contactId!==undefined?request.contactId
          :(await progressPool.query<{contact_id:string|null}>(`SELECT contact_id
            FROM public.background_task WHERE id=$1 AND owner_id=$2`,
          [request.taskId,storage.runtimeOwnerId])).rows[0]?.contact_id;
        if(contactId===undefined)return;
        await taskControl.stop?.({ownerId:storage.runtimeOwnerId!,contactId},request.taskId).catch(()=>false);
      }})
    : undefined;
  let handoff: ContactHandoff | undefined;
  let memoryHandoff: MemoryManagementHandoff | undefined;
  let modelRuntime:Awaited<ReturnType<typeof startHostModelRuntime>>|undefined;
  let pureSync:PureTsSync|undefined;
  // 本宿主提供唯一认证增量端点与历史执行者。
  const historyRuntime=resolveHistoryRuntime(runtimeEnvironment,{incrementalRemoteAvailable:true});
  const incremental = await createSyncIncrementalApi({storage,executable:runtimeEnvironment.NOTALONE_WECHAT_CLI ?? '',environment:runtimeEnvironment,
    historyOwner:historyRuntime,
    publish:async(events,signal)=>{
        if(state!=='running'||signal.aborted)throw new HostStorageError('runtime_stopping');
        for(const event of events)hostEvents.publish('message.created',event.contact_id,{message_id:event.message_id},event.occurred_at);
        const contacts=new Set(events.map(event=>event.contact_id));
        for(const contact of contacts){
          const scope={ownerId:storage.runtimeOwnerId!,contactId:contact};
          const taskId=await observationTasks.enqueueObservation(scope,events.filter(event=>event.contact_id===contact).map(event=>event.message_id));
          if(taskId)await taskControl.wake(scope,taskId).catch(()=>{});
        }
        await taskEvents?.refresh();
    }});
  let incrementalRevokeTail:Promise<void>=Promise.resolve();
  const wechatScope = await createWechatScopeApi({storage,executable:runtimeEnvironment.NOTALONE_WECHAT_CLI ?? '',environment:runtimeEnvironment,
    revokeWithDrain:async (body,signal) => {
        if(state!=='running'||!pureSync?.accountScope)throw new HostStorageError('runtime_stopping');
        const revoked=incrementalRevokeTail.then(async()=>{
          if(signal.aborted||state!=='running')throw new HostStorageError('runtime_stopping');
          const version=await incremental.invalidateAndDrain('scope_revoke');
          // 已开始的撤销属于用户授权决定，不随HTTP断连回滚；仍由宿主停机与范围服务关闭取消。
          const result=await wechatScope.handle('POST','/api/runtime/wechat-scope/revoke',{
            owner_id:storage.runtimeOwnerId,channel:'wechat',account_scope:pureSync!.accountScope,...body,
          },()=>{if(state!=='running')throw new HostStorageError('runtime_stopping');});
          if(state==='running')incremental.resume(version);
          return result;
        });incrementalRevokeTail=revoked.then(()=>undefined,()=>undefined);return revoked;
    },
    readSyncStatus:async () => {
      if(pureSync&&state==='running')return pureSync.status();
      throw new HostStorageError('runtime_stopping');
    }});
  pureSync=await PureTsSync.create(storage,incremental,hostEvents);
  const followSmoke=pureSync?new PureTsFollowSmoke(storage,pureSync):undefined;
  const foreground=await createForegroundLocationApi({storage,executable:runtimeEnvironment.NOTALONE_WECHAT_CLI??'',environment:runtimeEnvironment,
    probe:new NativeForegroundProbe({executable:runtimeEnvironment.NOTALONE_SYNC_PROBE||path.join(config.home,'unconfigured-probe')})});
  const contacts=new ContactContext(storage);
  const memories=new MemoryService(storage);
  const preferences=new PreferenceService(storage);
  const deletionSkillsRoot=resolveSkillsRoot(runtimeEnvironment,config.businessHome,config.projectDirectory);
  const skills=new SkillHost(storage,deletionSkillsRoot);
  let layeredManagement:ReturnType<typeof createLayeredMemoryManagement>|undefined;
  let maintenance:PureTsMaintenance|undefined;
  const deletions=storage.runtimeOwnerId
    ?new CrossDomainDeletionService({storage,skillsRoot:deletionSkillsRoot})
    :undefined;
  let closing: Promise<void> | undefined;
  const closeResources = () => closing ??= (async () => {
    state='stopping';modelRuntime?.stopAccepting();
    hostEvents.close();
    followSmoke?.close();
    // 先排空任务控制，再保留增量→范围/资料门禁→模型→数据库顺序。
    const failures:unknown[]=[];
    for(const release of [()=>maintenance?.close(),()=>pureSync?.close(),()=>taskEvents?.close(),closeTaskControl,()=>incremental.close(),
      async()=>{
        const closed=await Promise.allSettled([()=>foreground.close(),()=>wechatScope.close(),
          ()=>handoff?.close(),()=>memoryHandoff?.close(),()=>skills.close()].map(release=>Promise.resolve().then(release)));
        const errors=closed.filter(result=>result.status==='rejected').map(result=>result.reason);
        if(errors.length)throw new AggregateError(errors,'范围与资料资源未完整关闭');
      },
      ()=>modelRuntime?.close(),
      ()=>progressPool.end(),
      ()=>storage.close(),()=>releaseDatabaseLease?.()]){
      try{await release();}catch(error){failures.push(error);}
    }
    state='stopped';
    if(failures.length)throw new AggregateError(failures,'宿主资源未完整关闭');
  })();
  const server=createServer(async(req,res)=>{
    const respond=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(stringifyJson(value));};
    let url: URL;
    try {url=new URL(req.url??'','http://localhost');}catch {respond(400,{error:'invalid_request'});return;}
    // 私有候选、讨论、探索与提取入口先自行认证；公开token及其他内部token不能进入。
    const privateDiscussion=/^\/internal\/discussion(?:[/?]|$)/.test(req.url??'');
    if((req.url??'').startsWith('/internal/reply')
      || (req.url??'').startsWith('/internal/extraction')
      || (req.url??'').startsWith('/internal/layered-memory')
      || privateDiscussion
      || req.url==='/internal/exploration'){
      if(!modelRuntime){respond(401,{error:'unauthorized'});return;}
      if(!await modelRuntime.handle(req,res))respond(404,{error:'not_found'});return;
    }
    if(req.headers.origin!==undefined||req.rawHeaders.filter((key,index)=>index%2===0&&key.toLowerCase()==='authorization').length!==1){respond(401,{error:'unauthorized'});return;}
    const supplied=Buffer.from(req.headers.authorization ?? '');
    const expected=Buffer.from(`Bearer ${token}`);
    const scopeExpected=Buffer.from(`Bearer ${scopeToken}`);
    const scopeInternal=supplied.length===scopeExpected.length && timingSafeEqual(supplied,scopeExpected);
    const scopePath=url.pathname.startsWith('/api/runtime/wechat-scope/');
    const incrementalExpected=Buffer.from(`Bearer ${incrementalToken}`);
    const incrementalInternal=supplied.length===incrementalExpected.length && timingSafeEqual(supplied,incrementalExpected);
    const incrementalPath=url.pathname==='/api/runtime/sync-incremental' || url.pathname.startsWith('/api/runtime/sync-incremental/');
    if(incrementalPath && (!incrementalInternal || req.headers.origin!==undefined)){respond(401,{error:'unauthorized'});return;}
    // 认证先于规范化拒绝；公开token即使携带点段也不能触达内部处理器。
    if(incrementalPath && (req.url!==url.pathname || !/^\/api\/runtime\/sync-incremental\/[a-z]+(?:-[a-z]+)*$/.test(req.url))){respond(400,{error:'invalid_request'});return;}
    if (scopePath && (!scopeInternal || req.headers.origin)) {respond(401,{error:'unauthorized'});return;}
    if ((!scopePath && !incrementalPath && (supplied.length !== expected.length || !timingSafeEqual(supplied,expected))) || req.headers.origin) {respond(401,{error:'unauthorized'});return;}
    let releaseAuthority:(()=>void)|undefined;
    try {
      if(req.url==='/api/runtime/status' && req.method==='GET'){
        respond(200,{state,runtime:'dsh',hostRuntime:'typescript',pid:process.pid,
          ...(modelRuntime?{reply:{runtime:'typescript',...modelRuntime.replyStatus},taskWorker:modelRuntime.extractionWorkerStatus}:{}),
          ownership:{setup:'typescript',credentials:'typescript',ledger:'typescript',schemaUpdates:'typescript-migration-command',
            contacts:'typescript',deletion:deletions?'typescript':'unavailable',wechat:'typescript',wechatScope:'typescript',
            skills:skills.status().owner,skillLearning:modelRuntime?'typescript':'unavailable',
            imports:imports?'typescript':'unavailable',taskApi:tasks?'typescript':'unavailable',
            taskManagement:businessTasks?'typescript':'unavailable',tasks:'typescript',
            crossDomainDeletion:deletions?'typescript':'unavailable',replies:modelRuntime?'typescript':'unavailable',
            wechatBodySync:'typescript',wechatIncremental:'typescript',wechatHistory:historyRuntime,foregroundLocation:'typescript',
            contactContext:handoff?.status().owner??'unavailable',memory:memoryHandoff?.status().owner??'unavailable',
            expressionPreferences:memoryHandoff?.status().owner??'unavailable'}});return;
      }
      if(req.url==='/api/runtime/shutdown' && req.method==='POST'){
        await closeResources();res.once('finish',()=>process.kill(process.pid,'SIGTERM'));respond(200,{state,runtime:'dsh'});return;
      }
      if(state!=='running'){respond(503,{error:'runtime_stopping'});return;}
      // 兼容旧DSH已移交范围后的稳定拒绝；当前绑定确认使用cli-bindings/confirm。
      if(['/api/sync/confirm','/api/sync/confirm-pending'].includes(url.pathname)){respond(503,{error:'wechat_scope_owned_by_typescript'});return;}
      if(req.method==='POST'&&url.pathname==='/api/sync/disable')await incremental.invalidateAndDrain('disable');
      if(isForegroundAuthorityMutation(req.method??'',url.pathname)){
        releaseAuthority=await foreground.beginAuthorityChange();if(res.destroyed)return;
      }
      if(req.headers['x-notalone-manual-contact']!==undefined){
        const contact=req.headers['x-notalone-manual-contact'];
        const parts=url.pathname.split('/');
        if(typeof contact!=='string'||!/^\/[a-z]/.test(url.pathname)||!/^\/api\/contacts\/[^/]+\/assistant-session(?:s)?(?:\/|$)/.test(url.pathname)||contact!==parts[3]){respond(400,{error:'manual_scope_invalid'});return;}
      }
      if(followSmoke&&url.pathname.startsWith('/api/sync/follow-smoke/')){
        const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
        try{
          const result=await followSmoke.handle(req.method??'',url,req.method==='POST'?await readBody(req):undefined,controller.signal);
          if(result&&!res.destroyed)respond(result.status,result.body);return;
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
      }
      if(pureSync&&(url.pathname==='/api/sync/status'||/^\/api\/sync\/(?:enable|disable|check|priority|backfill\/(?:pause|retry))$/.test(url.pathname))){
        const cancelled=new AbortController(),abort=()=>cancelled.abort();req.once('aborted',abort);res.once('close',abort);
        try{
          const result=await pureSync.handle(req.method??'',url,req.method==='POST'?await readBody(req):undefined,cancelled.signal);
          if(result){
            let value=result.body;
            if(result.status===200&&pureSync.accountScope)value=await wechatScope.decorateSyncStatus(value as Record<string,unknown>);
            if(!res.destroyed)respond(result.status,value);return;
          }
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
      }
      if(crossDomainDeletionRoute(req.method??'',url.pathname)){
        await serveCrossDomainDeletion(req,res,deletions);
        if(res.statusCode<400){
          if(/^\/api\/contacts\/[^/]+$/.test(url.pathname))hostEvents.forgetContact(url.pathname.split('/')[3]);
          if(/^\/api\/(?:owner|owners)(?:\/|$)/.test(url.pathname))hostEvents.clear();
          await taskEvents?.refresh().catch(()=>{});
        }
        return;
      }
      if(modelRuntime?.qualityApi?.matches(req.method??'',url)){
        const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
        try{
          const body=req.method==='POST'?parseJson(new TextDecoder('utf-8',{fatal:true}).decode(await readWechatHttpBody(req,1024*1024))):undefined;
          const result=await modelRuntime.qualityApi.handle(req.method??'',url,body,controller.signal);
          if(result&&!res.destroyed)respond(result.status,result.body);return;
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
      }
      const layeredMemoryPath=url.pathname.startsWith('/api/memories/owner/layered-memory')
        || /^\/api\/contacts\/[^/]+\/layered-memory(?:\/|$)/.test(url.pathname);
      if(layeredManagement?.matches(req.method??'',url)){
        const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
        try{
          let body:unknown;
          if(req.method==='POST')body=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(await readWechatHttpBody(req,64*1024)));
          const result=await layeredManagement.handle(req.method??'',url,body,controller.signal);
          if(result&&!res.destroyed)respond(result.status,result.body);return;
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
      }
      if(layeredMemoryPath&&modelRuntime){
        const layered=await modelRuntime.handleLayeredMemory(req,res,url);
        if(layered.handled)return;
      }
      if(url.pathname==='/api/imports/preview'||url.pathname==='/api/imports/commit'){
        if(!imports){respond(503,{error:'import_unavailable'});return;}
        if(url.search){respond(400,{error:'import_request_invalid'});return;}
        const body=req.method==='POST'?await readBody(req):undefined;
        const result=await imports.handle(req.method??'',url.pathname,body);
        if(!result){respond(404,{error:'not_found'});return;}
        respond(result.status,result.body);return;
      }
      if(url.pathname==='/api/tasks'||url.pathname==='/api/tasks/stop'||url.pathname==='/api/tasks/recover'){
        if(!businessTasks){respond(503,{error:'task_unavailable'});return;}
        if(req.method==='POST'&&url.search){respond(400,{error:'task_request_invalid'});return;}
        const body=req.method==='POST'?await readBody(req):undefined;
        const result=await businessTasks.handle(req.method??'',url.pathname,url.searchParams,body);
        if(!result){respond(404,{error:'not_found'});return;}
        if(req.method==='POST')await taskEvents?.refresh();
        respond(result.status,result.body);return;
      }
      if(url.pathname==='/api/tasks/status'||url.pathname==='/api/tasks/run'||url.pathname==='/api/tasks/retry'){
        if(!tasks){respond(503,{error:'task_unavailable'});return;}
        if(req.method==='POST'&&url.search){respond(400,{error:'import_request_invalid'});return;}
        const body=req.method==='POST'?await readBody(req):undefined;
        const result=await tasks.handle(req.method??'',url.pathname,url.searchParams,body);
        if(!result){respond(404,{error:'not_found'});return;}
        respond(result.status,result.body);return;
      }
      const progressPath=/^\/api\/contacts\/[^/]+\/memory-processing(?:\/resume)?$|^\/api\/owner\/memory-processing(?:\/resume)?$/.test(url.pathname);
      if(progress&&progressPath){
        let body:Record<string,any>|undefined;
        if(req.method==='POST'&&url.pathname.endsWith('/resume')){
          try{body=await readBody(req);}catch{body=undefined;}
        }
        const result=await progress.handle(req.method??'',url.pathname,body);
        if(result){
          if(url.search){respond(400,{error:'memory_processing_request_invalid'});return;}
          respond(result.status,result.body);return;
        }
        if(req.method==='POST'&&url.pathname.includes('/memory-processing')){
          respond(400,{error:'memory_processing_request_invalid'});return;
        }
      }
      const tracePath=/^\/api\/contacts\/[^/]+\/(?:memory-traces|source-processing-traces)(?:\/|$)/.test(url.pathname);
      if(tracePath){
        if(!traces){respond(503,{error:'source_processing_trace_unavailable'});return;}
        if(req.method!=='GET'&&req.method!=='DELETE'){respond(405,{error:'method_not_allowed'});return;}
        const result=await traces.handle(req.method,url);
        if(!result){respond(404,{error:'not_found'});return;}
        respond(result.status,result.body);return;
      }
      if(url.pathname==='/api/ledger/summary'){
        if(req.method!=='GET'){respond(405,{error:'method_not_allowed'});return;}
        if(req.url!==url.pathname){respond(400,{error:'invalid_request'});return;}
        try{respond(200,await usageSummary(storage));}
        catch{respond(503,{error:'ledger_summary_unavailable'});}return;
      }
      if(url.pathname.startsWith('/api/runtime/foreground-location/')){respond(404,{error:'not_found'});return;}
      if(url.pathname===foregroundLocationPath){
        const cancelled=new AbortController();const abort=()=>cancelled.abort();req.once('aborted',abort);res.once('close',abort);
        try{const body=req.method==='POST'?await readWechatHttpBody(req,1024):Buffer.alloc(0);const result=await foreground.handle(req.method??'',body,cancelled.signal);if(!res.destroyed)respond(result.status,result.body);}
        finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}return;
      }
      if(req.url==='/api/setup/status' && req.method==='GET'){respond(200,await storage.setupStatus());return;}
      if(req.url==='/api/settings/credentials' && req.method==='GET'){respond(200,storage.credentialStatus());return;}
      if(incrementalPath){
        const cancelled=new AbortController();
        const abort=()=>cancelled.abort();req.once('aborted',abort);res.once('close',abort);
        try {
          const body=req.method==='POST'?await readWechatHttpBody(req,16*1024):Buffer.alloc(0);
          const result=await incremental.handle(req.method??'',url.pathname,body,()=>{if(state!=='running')throw new HostStorageError('runtime_stopping');},cancelled.signal);
          if(!res.destroyed)respond(result.status,result.body);
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
        return;
      }
      if(isWechatScopeRoute(url.pathname)){
        const cancelled=new AbortController();
        const abort=()=>cancelled.abort();req.once('aborted',abort);res.once('close',abort);
        try {
          const body=req.method==='POST'?await readWechatHttpBody(req,wechatScopeBodyLimit(url.pathname)):Buffer.alloc(0);
          const result=await wechatScope.handle(req.method??'',url.pathname,body,()=>{if(state!=='running')throw new HostStorageError('runtime_stopping');},cancelled.signal);
          if(!res.destroyed)respond(result.status,result.body);
        } finally {req.removeListener('aborted',abort);res.removeListener('close',abort);}
        return;
      }
      if(scopePath){respond(404,{error:'not_found'});return;}
      if(!handoff || !memoryHandoff){respond(503,{error:'runtime_starting'});return;}
      if(url.pathname==='/api/events'&&req.method==='GET'){hostEvents.open(req,res);return;}
      if(modelRuntime&&await modelRuntime.handlePublic(req,res,url))return;
      if(skillLearningRoute(req.method??'',url.pathname)){
        if(!modelRuntime){respond(503,{error:'skill_learning_unavailable'});return;}
        if(!['GET','POST'].includes(req.method??'')||url.search){respond(400,{error:'skill_learning_request_invalid'});return;}
        const cancelled=new AbortController(),abort=()=>cancelled.abort();
        req.once('aborted',abort);res.once('close',abort);
        try{
          let body:unknown;
          if(req.method==='POST'){
            const bytes=await readWechatHttpBody(req,256*1024);
            try{body=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
            catch{if(!res.destroyed)respond(400,{error:'skill_learning_request_invalid'});return;}
          }
          const result=await modelRuntime.handleSkillLearning(req.method!,url,body,cancelled.signal);
          if(!res.destroyed)respond(result.status,result.body);
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
        return;
      }
      if(url.pathname==='/api/runtime/contact-context/status' && req.method==='GET'){respond(200,handoff.status());return;}
      if(url.pathname.startsWith('/api/runtime/contact-context/')){respond(404,{error:'not_found'});return;}
      if(url.pathname==='/api/runtime/memory-management/status' && req.method==='GET'){respond(200,memoryHandoff.status());return;}
      if(url.pathname.startsWith('/api/runtime/memory-management/')){respond(404,{error:'not_found'});return;}
      if(memoryRoute(req.method??'',url.pathname) || preferenceRoute(req.method??'',url.pathname)){
        const preference=preferenceRoute(req.method??'',url.pathname);
        const lease=memoryHandoff.enter();
        let cancelled=false;
        const abort=()=>{cancelled=true;};req.once('aborted',abort);res.once('close',abort);
        const assertCurrent=()=>{
          try {lease.assertCurrent();if(state!=='running'||cancelled)throw new MemoryError('runtime_stopping',503);}
          catch(error){if(preference)throw new PreferenceError('unavailable',503);throw error;}
        };
        try {
          // 与原HTTP相同1MiB边界；无损JSON保留偏好的bigint修订与操作摘要。
          const bytes=await readWechatHttpBody(req,1024*1024);
          let body:unknown;
          const item=url.pathname.replace(/\/$/,'').split('/').length===4;
          const needsJson=preference ? (req.method==='POST'&&!item || ['PATCH','DELETE'].includes(req.method??'')&&item)
            : req.method==='POST'&&!/\/(delete|discard)$/.test(url.pathname);
          if(needsJson){
            try {
              const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
              body=!preference&&url.pathname.endsWith('/confirm')&&!text.trim()?{}:parseMemoryManagementJSON(text,preference||/\/(apply-update|revert-auto-update)$/.test(url.pathname));
              if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();
            }catch{if(preference)throw new PreferenceError('invalid',400);throw new MemoryError();}
          }
          assertCurrent();
          const result=preference?await preferences.handle(req.method!,url,body,assertCurrent):await memories.handle(req.method!,url,body,assertCurrent);
          assertCurrent();if(!res.destroyed)respond(200,result);
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);lease.finish();}
        return;
      }
      if(skillLibraryRoute(req.method??'',url.pathname)){
        const lease=skills.enter();const cancelled=new AbortController();const abort=()=>cancelled.abort();req.once('aborted',abort);res.once('close',abort);
        try{
          const assertCurrent=()=>{lease.assertCurrent();if(cancelled.signal.aborted)throw new SkillLibraryError('skill_unavailable',503);};
          const body=req.method==='POST'?await readBody(req):undefined;
          const result=await skills.library.handle(req.method??'',url,body,assertCurrent);assertCurrent();respond(200,result);
        }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);lease.finish();}return;
      }
      if(contactContextRoute(req.method??'',url.pathname)){
        const lease=handoff.enter();
        try {
          const body=req.method==='POST'?await readBody(req):undefined;
          const result=await contacts.handle(req.method!,url,body,lease.assertCurrent,false);
          lease.assertCurrent();respond(200,result);
        } finally {lease.finish();}
        return;
      }
      if(req.method!=='POST'){respond(404,{error:'not_found'});return;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)throw new Error('invalid_request');}
      const parsed=parseJson(body);
      const payload=parsed as Record<string, any>;
      if(!payload || Array.isArray(payload) || typeof payload!=='object')throw new Error('invalid_request');
      if(req.url==='/api/setup/recover-owner'){
        if(Object.keys(payload).length!==1 || payload.confirm_existing_owner!==true)throw new Error('invalid_request');
        respond(200,await storage.recoverOwner());return;
      }
      if(req.url==='/api/setup/initialize'){
        if(Object.keys(payload).some(k=>!['display_name','create_only'].includes(k)) || payload.create_only!==true || typeof payload.display_name!=='string')throw new Error('invalid_request');
        respond(200,await storage.initializeOwner(payload.display_name));return;
      }
      if(req.url==='/api/setup/credentials'){
        if(Object.keys(payload).some(k=>!['provider','api_key'].includes(k)) || payload.provider!=='deepseek' || typeof payload.api_key!=='string')throw new Error('invalid_request');
        respond(200,await storage.writeCredentials(payload.api_key));return;
      }
      if(req.url==='/api/setup/official-deepseek'){
        if(Object.keys(payload).some(k=>!['api_key','confirm_official_defaults'].includes(k)) || payload.confirm_official_defaults!==true || typeof payload.api_key!=='string')throw new Error('invalid_request');
        respond(200,await storage.useOfficialDeepseek(payload.api_key));return;
      }
      respond(404,{error:'not_found'});
    }catch(error){if(error instanceof WechatHttpBodyError){res.setHeader('Connection','close');respond(error.status,{error:error.code});return;}const code=error instanceof HostStorageError?error.code:'invalid_request';respond(error instanceof ContactContextError || error instanceof MemoryError || error instanceof PreferenceError || error instanceof SkillLibraryError?error.status:['owner_already_configured','owner_recovery_ambiguous','owner_recovery_conflict'].includes(code)?409:400,{error:code,...(error instanceof SkillLibraryError&&error.reason?{reason:error.reason}:{})});}
    finally{releaseAuthority?.();}
  });
  // Node解析器会先拒绝非法长度和半关闭的残缺请求；保留原HTTP稳定错误码。
  server.on('clientError',(error,socket)=>{
    if(!socket.writable)return;
    const code=(error as NodeJS.ErrnoException).code;
    const reason=code==='HPE_INVALID_CONTENT_LENGTH'||code==='HPE_UNEXPECTED_CONTENT_LENGTH'?'request_length_invalid':code==='HPE_INVALID_EOF_STATE'?'request_body_incomplete':'invalid_request';
    const body=JSON.stringify({error:reason});
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  // 先监听认证业务端口，所有服务就绪后再发布握手。
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address || typeof address==='string')throw new Error('HOST_LISTEN_FAILED');
  try {
    if(deletions)await deletions.recover();
    modelRuntime=await startHostModelRuntime({ctx,storage,environment:runtimeEnvironment,
      businessHome:config.businessHome,projectDirectory:config.projectDirectory,infoPath:config.infoPath,envFilePath:config.envFilePath,
      ...(traceStore?{sourceTraces:traceStore}:{}),skillLibrary:skills.library,
      requireDiscussionDependencies:skills.requireDiscussionDependencies});
    const control=modelRuntime.extractionControl;
    if(!control)throw new Error('EXTRACTION_WORKER_UNAVAILABLE');
    activeTaskControl=control;
    if(storage.runtimeOwnerId)layeredManagement=createLayeredMemoryManagement({
      ownerId:storage.runtimeOwnerId,transaction:work=>storage.businessTransaction(work),
      ...(modelRuntime?.qualityApi?{
        contract:`scenario-v3:verified_items:document-tools-v1:profile-tools-v1:typescript-management-v1:${modelRuntime.qualityApi.store.contractId}`,
        budget:modelRuntime.qualityApi.store.contract.budget,
        qualityInput:(client,scope,versions)=>modelRuntime!.qualityApi!.store.insertInputInTransaction(client,scope,versions),
      }:{}),
      modelWorkAvailable:()=>modelRuntime?.replyStatus.state==='ready',
      wake:(scope,taskId)=>taskControl.wake({ownerId:scope.owner_id,contactId:scope.contact_id},taskId),
      cancel:(scope,taskId)=>taskControl.stop?.({ownerId:scope.owner_id,contactId:scope.contact_id},taskId),
    });
    if(layeredManagement&&modelRuntime?.replyStatus.state==='ready')maintenance=new PureTsMaintenance(progressPool,signal=>layeredManagement!.runMaintenance(signal));
    handoff=new ContactHandoff(storage);
    memoryHandoff=new MemoryManagementHandoff(storage);
  } catch(error) {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await closeResources();throw error;
  }
  const readyDispose=ctx.appReady!.onReady(()=>{void(async()=>{
    foreground.activate();
    await handoff!.activate();
    await memoryHandoff!.activate();
    await skills.activateStandalone();
    await pureSync?.start();
    await maintenance?.start();
    taskEvents?.start();
    const pendingInfo = `${config.infoPath}.${randomBytes(16).toString('hex')}.pending`;
    try {
      await writeFile(pendingInfo,`address=127.0.0.1:${address.port}\ntoken=${token}\npid=${process.pid}\n`,{mode:0o600,flag:'wx'});
      await link(pendingInfo, config.infoPath);published=true;
    } finally {await rm(pendingInfo,{force:true});}
  })().catch(terminate);});
  ctx.effect(()=>async()=>{
    state='stopping';modelRuntime?.stopAccepting();readyDispose();process.stdin.removeListener('end',terminate);process.stdin.pause();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await closeResources();if(published)await rm(config.infoPath,{force:true});
  });
}

async function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, any>> {
  let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)throw new Error('invalid_request');}
  const parsed=parseJson(body);
  const payload=parsed as Record<string, any>;
  if(!payload || Array.isArray(payload) || typeof payload!=='object')throw new Error('invalid_request');
  return payload;
}
