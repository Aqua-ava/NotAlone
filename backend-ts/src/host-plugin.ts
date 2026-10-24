import {SkillHost} from './skill-host.ts';
import {SkillLibraryError,skillLibraryRoute} from './skill-library.ts';
import {resolveSkillsRoot} from './skills-root.ts';
import type {} from '@deepseek-ai/dsh-cmdline';
import type { Context } from '@deepseek-ai/cordis';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HostStorage, HostStorageError } from './host-storage.ts';
import { LegacyBackend, LegacyControlError, legacyRoute, ownership } from './legacy-backend.ts';
import { ContactContext, ContactContextError, contactContextRoute } from './contact-context.ts';
import { ContactHandoff } from './contact-handoff.ts';
import { MemoryService, memoryRoute } from './memory-service.ts';
import { MemoryError } from './memory-errors.ts';
import { PreferenceService, PreferenceError, preferenceRoute } from './preference-service.ts';
import { MemoryManagementHandoff } from './memory-management-handoff.ts';
import { parseMemoryManagementJSON } from './memory-management-json.ts';
import { readWechatHttpBody, WechatHttpBodyError } from './wechat-http-body.ts';
import { parseJson, stringifyJson } from './host-json.ts';
import { createWechatScopeApi, isWechatScopeRoute, wechatScopeBodyLimit, type WechatScopeResponse } from './wechat-scope-api.ts';
import {createForegroundLocationApi,foregroundLocationPath,isForegroundAuthorityMutation} from './foreground-location-api.ts';
import {NativeForegroundProbe} from './foreground-location-probe.ts';
import { createSyncIncrementalApi } from './sync-incremental-api.ts';
import {projectHistoryCoverages,resolveHistoryRuntime} from './history-runtime.ts';
import {startHostModelRuntime} from './host-model-runtime.ts';
import {usageSummary} from './usage-summary.ts';
import {ExtractionTaskStore} from './extraction-task-store.ts';
import {ExtractionProgressApi} from './extraction-progress-http.ts';
import {SourceProcessingTraceStore} from './source-processing-trace.ts';
import {SourceProcessingTraceApi} from './source-processing-trace-http.ts';
import {HistoryImportApi} from './history-import-api.ts';
import {PostgresTaskStatusStore,TaskApi} from './task-api.ts';
import {PythonTaskControlGateway} from './task-control.ts';
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
  const token = randomBytes(32).toString('base64url');
  const contextToken = randomBytes(32).toString('base64url');
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
    // 挂起旧业务仍需由下次宿主核验回收，不能先删掉其归属证据。
    try {
      const legacy = JSON.parse(readFileSync(path.join(config.home,'legacy.pid'),'utf8'));
      try { process.kill(legacy.pid,0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    rmSync(config.home,{recursive:true,force:true});
  };
  process.once('exit',exitCleanup);
  const storage = await HostStorage.open({envFilePath:config.envFilePath,migrationsDirectory:path.join(config.projectDirectory,'backend/database/migrations'),environment:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('PG') || key.startsWith('NOTALONE_') && key!=='NOTALONE_HOST_CONFIG')),HOME:config.businessHome}});
  const compatibility = await storage.compatibility();
  if (compatibility.code !== 'ready') throw new Error('HOST_DATABASE_UNAVAILABLE');
  const ownerStatus=await storage.setupStatus();
  const progressPool=await storage.businessPool();
  const progress=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new ExtractionProgressApi(new ExtractionTaskStore(progressPool),storage.runtimeOwnerId)
    : undefined;
  const traces=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new SourceProcessingTraceApi(new SourceProcessingTraceStore(progressPool),storage.runtimeOwnerId)
    : undefined;
  const taskControl=new PythonTaskControlGateway();
  const imports=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new HistoryImportApi({
      transaction:work=>storage.businessTransaction(work),ownerId:storage.runtimeOwnerId,
      wake:(scope,taskId)=>taskControl.wake(scope,taskId),
    })
    : undefined;
  const tasks=ownerStatus.runtime_owner_configured&&storage.runtimeOwnerId
    ? new TaskApi({ownerId:storage.runtimeOwnerId,store:new PostgresTaskStatusStore(progressPool),control:taskControl})
    : undefined;
  let legacy: LegacyBackend | undefined;
  let handoff: ContactHandoff | undefined;
  let memoryHandoff: MemoryManagementHandoff | undefined;
  let modelRuntime:Awaited<ReturnType<typeof startHostModelRuntime>>;
  const runtimeEnvironment: NodeJS.ProcessEnv = {...process.env,...storage.runtimeEnvironment(),HOME:config.businessHome};
  // 本宿主自身提供唯一认证增量端点；typescript 历史模式不回退到 Python 写者。
  const historyRuntime=resolveHistoryRuntime(runtimeEnvironment,{incrementalRemoteAvailable:true});
  const incremental = await createSyncIncrementalApi({storage,executable:runtimeEnvironment.NOTALONE_WECHAT_CLI ?? '',environment:runtimeEnvironment,
    historyOwner:historyRuntime,
    publish:async(events,signal)=>{
      if(!legacy || state!=='running' || signal.aborted)throw new HostStorageError('runtime_stopping');
      // 已提交消息仅传稳定身份；Python只派发事件与唤醒派生，不读取或重复写入正文。
      const payload=events.map(event=>({owner_id:event.owner_id,contact_id:event.contact_id,message_id:event.message_id,occurred_at:event.occurred_at}));
      await legacy.control('/api/runtime/sync-incremental/events','POST',{events:payload},3000,signal);
    }});
  let incrementalRevokeTail:Promise<void>=Promise.resolve();
  const wechatScope = await createWechatScopeApi({storage,executable:runtimeEnvironment.NOTALONE_WECHAT_CLI ?? '',environment:runtimeEnvironment,
    revokeWithDrain:async (body,signal) => {
      if(!legacy || state!=='running')throw new HostStorageError('runtime_stopping');
      // 下游取消不能证明Python事务结束；等待完整回执，未知运输失败才停止定位。
      const revoke=incrementalRevokeTail.then(async()=>{
      if(signal.aborted || state!=='running')throw new HostStorageError('runtime_stopping');
      const resumeVersion=await incremental.invalidateAndDrain('scope_revoke');
      let result:WechatScopeResponse;
      try {
        result=await legacy!.control('/api/runtime/wechat-scope/revoke','POST',body,10000) as unknown as WechatScopeResponse;
      }
      catch(error){if(error instanceof LegacyControlError)return {status:error.status,body:{error:error.code}};await foreground.suspend();throw error;}
      // 完整回执已证明事务结束；客户端断连只保留增量停读，不使前台永久停收。
      if(signal.aborted || state!=='running')throw new HostStorageError('runtime_stopping');
      incremental.resume(resumeVersion);
      return result;
      });
      incrementalRevokeTail=revoke.then(()=>undefined,()=>undefined);
      return revoke;
    },
    readSyncStatus:async () => {if (!legacy || state !== 'running') throw new HostStorageError('runtime_stopping');return await legacy.control('/api/sync/status','GET') as Record<string,unknown>;}});
  const foreground=await createForegroundLocationApi({storage,executable:runtimeEnvironment.NOTALONE_WECHAT_CLI??'',environment:runtimeEnvironment,
    probe:new NativeForegroundProbe({executable:runtimeEnvironment.NOTALONE_SYNC_PROBE||path.join(config.home,'unconfigured-probe')})});
  const contacts=new ContactContext(storage);
  const memories=new MemoryService(storage);
  const preferences=new PreferenceService(storage);
  const skills=new SkillHost(storage,resolveSkillsRoot(runtimeEnvironment,config.businessHome,config.projectDirectory));
  let closing: Promise<void> | undefined;
  const closeResources = () => closing ??= (async () => {
    state='stopping';modelRuntime?.stopAccepting();
    // 先排空任务控制，再保留增量→范围/资料门禁→模型/Python→数据库顺序。
    const failures:unknown[]=[];
    for(const release of [()=>taskControl.close(),()=>incremental.close(),
      async()=>{
        const closed=await Promise.allSettled([()=>foreground.close(),()=>wechatScope.close(),
          ()=>handoff?.close(),()=>memoryHandoff?.close(),()=>skills.close()].map(release=>Promise.resolve().then(release)));
        const errors=closed.filter(result=>result.status==='rejected').map(result=>result.reason);
        if(errors.length)throw new AggregateError(errors,'范围与资料资源未完整关闭');
      },
      ()=>modelRuntime?modelRuntime.close(async()=>{await legacy?.stop();}):legacy?.stop(),
      ()=>progressPool.end(),
      ()=>storage.close()]){
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
      || privateDiscussion
      || req.url==='/internal/exploration'){
      if(!modelRuntime){respond(401,{error:'unauthorized'});return;}
      if(!await modelRuntime.handle(req,res))respond(404,{error:'not_found'});return;
    }
    if(await skills.privateHttp(req,res))return;
    const supplied=Buffer.from(req.headers.authorization ?? '');
    const expected=Buffer.from(`Bearer ${token}`),internalExpected=Buffer.from(`Bearer ${contextToken}`);
    const internal=supplied.length===internalExpected.length && timingSafeEqual(supplied,internalExpected);
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
    const internalRead=internal && req.headers['x-notalone-owner-id']===storage.runtimeOwnerId?.toLowerCase() && typeof req.headers['x-notalone-owner-id']==='string' && req.method==='GET' && /^\/api\/contacts\/[^/]+\/relationship-overview$/.test(req.url??'');
    if ((!scopePath && !incrementalPath && !internalRead && (supplied.length !== expected.length || !timingSafeEqual(supplied,expected))) || req.headers.origin) {respond(401,{error:'unauthorized'});return;}
    let releaseAuthority:(()=>void)|undefined;
    const proxyLegacy=()=>{
      const release=releaseAuthority;releaseAuthority=undefined;
      const syncStatus=req.method==='GET'&&url.pathname==='/api/sync/status'
        || req.method==='POST'&&/^\/api\/sync\/(?:enable|disable|check|priority|confirm|confirm-pending|backfill\/(?:pause|retry))$/.test(url.pathname);
      legacy!.proxy(req,res,release?{settled:release,uncertain:()=>{void foreground.suspend().finally(release).catch(()=>{});}}:undefined,
        syncStatus?async report=>{
          if(!report||typeof report!=='object'||Array.isArray(report))throw new Error('sync_status_unavailable');
          const check=()=>{if(state!=='running')throw new HostStorageError('runtime_stopping');};
          const decorated=await wechatScope.decorateSyncStatus(report as Record<string,unknown>,check);
          if(historyRuntime==='python')return decorated;
          const current=await incremental.status(check);
          return {...decorated,cli_history_coverages:projectHistoryCoverages(current.history_coverages)};
        }:undefined);
    };
    try {
      if(req.url==='/api/runtime/status' && req.method==='GET'){respond(200,{state,runtime:'dsh',pid:process.pid,legacyPid:legacy?.pid,...(modelRuntime?{reply:{runtime:'typescript',...modelRuntime.replyStatus}}:{}),ownership:{...ownership,skills:skills.status().owner,imports:imports?'typescript':'python',taskApi:tasks?'typescript':'python',...(modelRuntime?{replies:'typescript'}:{}),wechatBodySync:'split',wechatIncremental:'typescript',wechatHistory:historyRuntime,foregroundLocation:'typescript',contactContext:handoff?.status().owner ?? 'python',memory:memoryHandoff?.status().owner ?? 'python',expressionPreferences:memoryHandoff?.status().owner ?? 'python'}});return;}
      if(req.url==='/api/runtime/shutdown' && req.method==='POST'){
        await closeResources();res.once('finish',()=>process.kill(process.pid,'SIGTERM'));respond(200,{state,runtime:'dsh'});return;
      }
      if(state!=='running'){respond(503,{error:'runtime_stopping'});return;}
      if(url.pathname==='/api/imports/preview'||url.pathname==='/api/imports/commit'){
        if(!imports){respond(503,{error:'import_unavailable'});return;}
        if(url.search){respond(400,{error:'import_request_invalid'});return;}
        const body=req.method==='POST'?await readBody(req):undefined;
        const result=await imports.handle(req.method??'',url.pathname,body);
        if(!result){respond(404,{error:'not_found'});return;}
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
      // 用户关闭先取消增量，再等待Python串行控制锁，避免已有切片逐个耗尽预算。
      if(req.method==='POST'&&url.pathname==='/api/sync/disable')await incremental.invalidateAndDrain('disable');
      const authorityChange=isForegroundAuthorityMutation(req.method??'',url.pathname);
      if(authorityChange){releaseAuthority=await foreground.beginAuthorityChange();if(res.destroyed)return;}
      if(req.url==='/api/setup/status' && req.method==='GET'){respond(200,await storage.setupStatus());return;}
      if(req.url==='/api/settings/credentials' && req.method==='GET'){respond(200,storage.credentialStatus());return;}
      if(incrementalPath){
        // Python初始化不在构造器同步等待cycle；握手就绪前不提交无法派发的事件。
        // 只读status必须允许作为初始化握手：TS历史模式下Python首轮状态依赖它，
        // 而legacy赋值要等Python完成启动。cycle和事件仍等待可派发事件的后端。
        if(!legacy&&url.pathname!=='/api/runtime/sync-incremental/status'){respond(503,{error:'runtime_starting'});return;}
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
      if(!legacy || !handoff || !memoryHandoff){respond(503,{error:'runtime_starting'});return;}
      if(url.pathname==='/api/runtime/contact-context/status' && req.method==='GET'){respond(200,handoff.status());return;}
      if(url.pathname.startsWith('/api/runtime/contact-context/')){
        if(url.pathname!=='/api/runtime/contact-context/handoff' || req.method!=='POST'){respond(404,{error:'not_found'});return;}
        const payload=await readBody(req);
        if(Object.keys(payload).length!==1 || !['python','typescript'].includes(payload.target))throw new Error('invalid_request');
        respond(200,await handoff.transfer(payload.target));return;
      }
      if(url.pathname==='/api/runtime/memory-management/status' && req.method==='GET'){respond(200,memoryHandoff.status());return;}
      if(url.pathname.startsWith('/api/runtime/memory-management/')){
        if(url.pathname!=='/api/runtime/memory-management/handoff' || req.method!=='POST'){respond(404,{error:'not_found'});return;}
        const payload=await readBody(req);
        if(Object.keys(payload).length!==1 || !['python','typescript'].includes(payload.target))throw new MemoryError();
        respond(200,await memoryHandoff.transfer(payload.target));return;
      }
      if(memoryRoute(req.method??'',url.pathname) || preferenceRoute(req.method??'',url.pathname)){
        const preference=preferenceRoute(req.method??'',url.pathname);
        const lease=memoryHandoff.enter();
        if(lease.owner==='python'){res.once('close',lease.finish);res.once('finish',lease.finish);proxyLegacy();return;}
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
        if(internal && handoff.status().owner!=='typescript')throw new ContactContextError('contact_context_transferring',503);
        const lease=handoff.enter();
        if(lease.owner==='python'){res.once('close',lease.finish);res.once('finish',lease.finish);proxyLegacy();return;}
        try {
          const body=req.method==='POST'?await readBody(req):undefined;
          const result=await contacts.handle(req.method!,url,body,lease.assertCurrent,internal);
          lease.assertCurrent();respond(200,result);
        } finally {lease.finish();}
        return;
      }
      if(legacyRoute(req.url??'')){proxyLegacy();return;}
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
  // 内部scope端口必须先监听，旧同步初始化才能读取其唯一授权来源。
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address || typeof address==='string')throw new Error('HOST_LISTEN_FAILED');
  try {
    modelRuntime=await startHostModelRuntime({ctx,storage,environment:runtimeEnvironment,
      businessHome:config.businessHome,projectDirectory:config.projectDirectory,infoPath:config.infoPath,envFilePath:config.envFilePath});
    legacy=await LegacyBackend.start(config,{...runtimeEnvironment,
      ...(modelRuntime?.pythonEnvironment(`http://127.0.0.1:${address.port}`)??{}),
      NOTALONE_OWNER_ID:ownerStatus.runtime_owner_configured ? storage.runtimeOwnerId : '',
      NOTALONE_WECHAT_SCOPE_URL:`http://127.0.0.1:${address.port}`,NOTALONE_WECHAT_SCOPE_TOKEN:scopeToken,
      NOTALONE_SYNC_INCREMENTAL_URL:`http://127.0.0.1:${address.port}`,NOTALONE_SYNC_INCREMENTAL_TOKEN:incrementalToken,
      NOTALONE_SYNC_INCREMENTAL_TRANSFERRED:'1'},terminate);
    taskControl.bind(legacy);
    handoff=new ContactHandoff(storage,legacy);
    memoryHandoff=new MemoryManagementHandoff(storage,legacy);
  } catch(error) {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await closeResources();throw error;
  }
  const readyDispose=ctx.appReady!.onReady(()=>{void(async()=>{
    await legacy!.control('/api/runtime/contact-context/configure','POST',{address:`127.0.0.1:${address.port}`,token:contextToken});
    const foregroundStopped=await legacy!.control('/api/runtime/foreground-location/stop','POST',{},5500);
    if(foregroundStopped.state!=='stopped'||foregroundStopped.active_requests!==0)throw new Error('FOREGROUND_DRAIN_FAILED');
    foreground.activate();
    await handoff!.transfer('typescript');
    await memoryHandoff!.transfer('typescript');
    await skills.transfer(legacy!,address.port);
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
