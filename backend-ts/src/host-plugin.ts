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
import { readWechatHttpBody, WechatHttpBodyError } from './wechat-http-body.ts';
import { parseJson, stringifyJson } from './host-json.ts';
import { createWechatScopeApi, isWechatScopeRoute, wechatScopeBodyLimit, type WechatScopeResponse } from './wechat-scope-api.ts';
export const name = 'notalone-host';
export const inject = ['appReady','llm','agents','sessions','tools'];

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
  let legacy: LegacyBackend | undefined;
  let handoff: ContactHandoff | undefined;
  const runtimeEnvironment: NodeJS.ProcessEnv = {...process.env,...storage.runtimeEnvironment(),HOME:config.businessHome};
  const wechatScope = await createWechatScopeApi({storage,executable:runtimeEnvironment.NOTALONE_WECHAT_CLI ?? '',environment:runtimeEnvironment,
    revokeWithDrain:async (body,signal) => {
      if(!legacy || state!=='running')throw new HostStorageError('runtime_stopping');
      try {return await legacy.control('/api/runtime/wechat-scope/revoke','POST',body,10000,signal) as unknown as WechatScopeResponse;}
      catch(error){if(error instanceof LegacyControlError)return {status:error.status,body:{error:error.code}};throw error;}
    },
    readSyncStatus:async () => {if (!legacy || state !== 'running') throw new HostStorageError('runtime_stopping');return await legacy.control('/api/sync/status','GET') as Record<string,unknown>;}});
  const contacts=new ContactContext(storage);
  let closing: Promise<void> | undefined;
  const closeResources = () => closing ??= (async () => {
    state='stopping';
    // 停收和取消先于排空；旧同步线程收到scope拒绝后退出，再关闭共享数据库。
    await Promise.all([wechatScope.close(),handoff?.close()]);
    await legacy?.stop();await storage.close();state='stopped';
  })();
  const server=createServer(async(req,res)=>{
    const respond=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(stringifyJson(value));};
    let url: URL;
    try {url=new URL(req.url??'','http://localhost');}catch {respond(400,{error:'invalid_request'});return;}
    const supplied=Buffer.from(req.headers.authorization ?? '');
    const expected=Buffer.from(`Bearer ${token}`),internalExpected=Buffer.from(`Bearer ${contextToken}`);
    const internal=supplied.length===internalExpected.length && timingSafeEqual(supplied,internalExpected);
    const scopeExpected=Buffer.from(`Bearer ${scopeToken}`);
    const scopeInternal=supplied.length===scopeExpected.length && timingSafeEqual(supplied,scopeExpected);
    const scopePath=url.pathname.startsWith('/api/runtime/wechat-scope/');
    if (scopePath && (!scopeInternal || req.headers.origin)) {respond(401,{error:'unauthorized'});return;}
    const internalRead=internal && req.headers['x-notalone-owner-id']===storage.runtimeOwnerId?.toLowerCase() && typeof req.headers['x-notalone-owner-id']==='string' && req.method==='GET' && /^\/api\/contacts\/[^/]+\/relationship-overview$/.test(req.url??'');
    if ((!scopePath && !internalRead && (supplied.length !== expected.length || !timingSafeEqual(supplied,expected))) || req.headers.origin) {respond(401,{error:'unauthorized'});return;}
    try {
      if(req.url==='/api/runtime/status' && req.method==='GET'){respond(200,{state,runtime:'dsh',pid:process.pid,legacyPid:legacy?.pid,ownership:{...ownership,contactContext:handoff?.status().owner ?? 'python'}});return;}
      if(req.url==='/api/runtime/shutdown' && req.method==='POST'){
        await closeResources();res.once('finish',()=>process.kill(process.pid,'SIGTERM'));respond(200,{state,runtime:'dsh'});return;
      }
      if(state!=='running'){respond(503,{error:'runtime_stopping'});return;}
      if(req.url==='/api/setup/status' && req.method==='GET'){respond(200,await storage.setupStatus());return;}
      if(req.url==='/api/settings/credentials' && req.method==='GET'){respond(200,storage.credentialStatus());return;}
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
      if(!legacy || !handoff){respond(503,{error:'runtime_starting'});return;}
      if(url.pathname==='/api/runtime/contact-context/status' && req.method==='GET'){respond(200,handoff.status());return;}
      if(url.pathname.startsWith('/api/runtime/contact-context/')){
        if(url.pathname!=='/api/runtime/contact-context/handoff' || req.method!=='POST'){respond(404,{error:'not_found'});return;}
        const payload=await readBody(req);
        if(Object.keys(payload).length!==1 || !['python','typescript'].includes(payload.target))throw new Error('invalid_request');
        respond(200,await handoff.transfer(payload.target));return;
      }
      if(contactContextRoute(req.method??'',url.pathname)){
        if(internal && handoff.status().owner!=='typescript')throw new ContactContextError('contact_context_transferring',503);
        const lease=handoff.enter();
        if(lease.owner==='python'){res.once('close',lease.finish);res.once('finish',lease.finish);legacy.proxy(req,res);return;}
        try {
          const body=req.method==='POST'?await readBody(req):undefined;
          const result=await contacts.handle(req.method!,url,body,lease.assertCurrent,internal);
          lease.assertCurrent();respond(200,result);
        } finally {lease.finish();}
        return;
      }
      if(legacyRoute(req.url??'')){legacy.proxy(req,res);return;}
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
    }catch(error){if(error instanceof WechatHttpBodyError){res.setHeader('Connection','close');respond(error.status,{error:error.code});return;}const code=error instanceof HostStorageError?error.code:'invalid_request';respond(error instanceof ContactContextError?error.status:['owner_already_configured','owner_recovery_ambiguous','owner_recovery_conflict'].includes(code)?409:400,{error:code});}
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
    legacy=await LegacyBackend.start(config,{...runtimeEnvironment,
      NOTALONE_OWNER_ID:ownerStatus.runtime_owner_configured ? storage.runtimeOwnerId : '',
      NOTALONE_WECHAT_SCOPE_URL:`http://127.0.0.1:${address.port}`,NOTALONE_WECHAT_SCOPE_TOKEN:scopeToken},terminate);
    handoff=new ContactHandoff(storage,legacy);
  } catch(error) {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await closeResources();throw error;
  }
  const readyDispose=ctx.appReady!.onReady(()=>{void(async()=>{
    await legacy!.control('/api/runtime/contact-context/configure','POST',{address:`127.0.0.1:${address.port}`,token:contextToken});
    await handoff!.transfer('typescript');
    const pendingInfo = `${config.infoPath}.${randomBytes(16).toString('hex')}.pending`;
    try {
      await writeFile(pendingInfo,`address=127.0.0.1:${address.port}\ntoken=${token}\npid=${process.pid}\n`,{mode:0o600,flag:'wx'});
      await link(pendingInfo, config.infoPath);published=true;
    } finally {await rm(pendingInfo,{force:true});}
  })().catch(terminate);});
  ctx.effect(()=>async()=>{
    state='stopping';readyDispose();process.stdin.removeListener('end',terminate);process.stdin.pause();
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
