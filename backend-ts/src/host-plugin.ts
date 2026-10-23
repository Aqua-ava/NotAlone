import type {} from '@deepseek-ai/dsh-cmdline';
import type { Context } from '@deepseek-ai/cordis';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HostStorage, HostStorageError } from './host-storage.ts';
import { LegacyBackend, legacyRoute, ownership } from './legacy-backend.ts';
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
  const legacy=await LegacyBackend.start(config,{...process.env,...storage.runtimeEnvironment(),HOME:config.businessHome,
    NOTALONE_OWNER_ID:ownerStatus.runtime_owner_configured ? storage.runtimeOwnerId : ''},terminate);
  const server=createServer(async(req,res)=>{
    const respond=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const supplied=Buffer.from(req.headers.authorization ?? '');
    const expected=Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected) || req.headers.origin) {respond(401,{error:'unauthorized'});return;}
    try {
      if(req.url==='/api/runtime/status' && req.method==='GET'){respond(200,{state,runtime:'dsh',pid:process.pid,legacyPid:legacy.pid,ownership});return;}
      if(req.url==='/api/runtime/shutdown' && req.method==='POST'){
        state='stopping';await Promise.all([storage.close(),legacy.stop()]);state='stopped';res.once('finish',()=>process.kill(process.pid,'SIGTERM'));respond(200,{state,runtime:'dsh'});return;
      }
      if(state!=='running'){respond(503,{error:'runtime_stopping'});return;}
      if(req.url==='/api/setup/status' && req.method==='GET'){respond(200,await storage.setupStatus());return;}
      if(req.url==='/api/settings/credentials' && req.method==='GET'){respond(200,storage.credentialStatus());return;}
      if(legacyRoute(req.url??'')){legacy.proxy(req,res);return;}
      if(req.method!=='POST'){respond(404,{error:'not_found'});return;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)throw new Error('invalid_request');}
      const payload=JSON.parse(body);
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
    }catch(error){const code=error instanceof HostStorageError?error.code:'invalid_request';respond(['owner_already_configured','owner_recovery_ambiguous','owner_recovery_conflict'].includes(code)?409:400,{error:code});}
  });
  const readyDispose=ctx.appReady!.onReady(()=>{
    server.listen(0,'127.0.0.1',()=>{void(async()=>{
      const address=server.address();if(!address || typeof address==='string')throw new Error();
      const pendingInfo = `${config.infoPath}.${randomBytes(16).toString('hex')}.pending`;
      try {
        await writeFile(pendingInfo,`address=127.0.0.1:${address.port}\ntoken=${token}\npid=${process.pid}\n`,{mode:0o600,flag:'wx'});
        // 完整写入后再独占发布，避免桌面读到半份握手，也不覆盖其他后台。
        await link(pendingInfo, config.infoPath);
        published=true;
      } finally { await rm(pendingInfo,{force:true}); }
    })().catch(terminate);});
  });
  ctx.effect(()=>async()=>{
    state='stopping';readyDispose();process.stdin.removeListener('end',terminate);process.stdin.pause();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await Promise.all([storage.close(),legacy.stop()]);if(published)await rm(config.infoPath,{force:true});
    state='stopped';
  });
}
