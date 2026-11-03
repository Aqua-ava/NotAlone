import {resolveBackgroundProcessingMode,resolveImageProcessingMode} from './host/sqlite-model-config.ts';
import {SqliteHistoryRecertifyService} from './history/sqlite/recertify.ts';
import {loadHostLegacyProofProvider} from './history/sqlite/legacy-terminal-maintenance.ts';
import {SqliteMemoryManagement} from './memory/sqlite/management/service.ts';
import {SqliteMemoryManagementHttp,memoryManagementQueryAllowed} from './memory/sqlite/management/http.ts';
import {createSqliteModelRuntime} from './host/sqlite-model-runtime.ts';
import {SqliteModelSetup} from './host/sqlite-model-setup.ts';
import {createSqliteMemoryRuntime} from './memory/sqlite/runtime.ts';
import {SqliteMemoryDocumentsHttp,memoryDocumentsQueryAllowed} from './memory/sqlite/documents/http.ts';
import {createSqliteDiscussionHost} from './reply/sqlite/host-runtime.ts';
import {createAssistantReadChannel} from './reply/sqlite/read-channel.ts';
import { SqliteMediaService } from './media/sqlite/service.ts';
import { SqliteMediaHttp } from './media/sqlite/http.ts';
import {SqliteImageSyncCoordinator} from './media/sqlite/image-sync.ts';
import {OriginalImageMediaAdapter} from './media/visual/original-image.ts';
import {createWechatImageResourcePort} from './media/visual/wechat.ts';
import {loadSharedNarrowWechatOptions,supportsWechatImageKeyChannel,supportsWechatOriginalImages} from './history/wechat/artifacts.ts';
import {enrichImageToolOptions} from './media/visual/image-tools.ts';
import {SharedWechatClient} from './history/wechat/shared-client.ts';
import { StorageFailure,type StorageReader } from './storage/sqlite/contracts.ts';
import type { Context } from '@deepseek-ai/cordis';
import { exitOnStdinEnd } from '@deepseek-ai/dsh-cmdline';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { SqliteStorage } from './storage/sqlite/client.ts';
import type { LaunchConfiguration, SqliteLaunchConfiguration } from './launch.ts';
import { createWechatContactMetadata } from './contacts/sqlite/wechat-metadata.ts';
import { ContactMetadataLifetime } from './storage/sqlite/deletion/contact-metadata.ts';
import {readSqliteCapabilities} from './sqlite-capabilities.ts';
import {SqliteSkillLibrary} from './skills/sqlite/library.ts';
import {SqliteSkillHttp} from './skills/sqlite/http.ts';
import { DeletionService } from './storage/sqlite/deletion/service.ts';
import { ActiveHolders } from './storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from './storage/sqlite/deletion/managed-files.ts';
import { SqliteDeletionHttp, deletionQueryAllowed } from './storage/sqlite/deletion/http.ts';
import { SqliteHistoryService } from './history/sqlite/service.ts';
import { SqliteHistoryHttp, historyQueryAllowed, projectHistorySyncStatus } from './history/sqlite/http.ts';
import { SqliteHistoryClearService } from './history/sqlite/clear.ts';
import { SqliteHistoryResyncService } from './history/sqlite/resync.ts';
import { SqliteHistoryClearHttp, clearQueryAllowed } from './history/sqlite/clear-http.ts';
import { createWechatHistoryChannel } from './history/sqlite/wechat-channel.ts';
import {SqliteQuoteSyncCoordinator} from './history/sqlite/quote-sync.ts';
import {supportsWechatQuotes} from './history/wechat/artifacts.ts';
import { FirstHistoryCoordinator } from './history/sqlite/coordinator.ts';
import { IncrementalHistoryCoordinator } from './history/sqlite/incremental-coordinator.ts';
import { installedDeletionScopes } from './storage/sqlite/deletion/registration.ts';
import {SqliteForeground} from './foreground/sqlite-foreground.ts';
import {readStatusCoverages} from './history/sqlite/status-coverage.ts';
import {readWechatHttpBody} from './sync/wechat-http-body.ts';
import {PureTsEvents} from './host/pure-ts-events.ts';
import {WechatHistoryCheckpointCache} from './history/wechat/checkpoint-cache.ts';
import { clearStartupDiagnostic, finishStartupDiagnostic, startupFailureCause, writeStartupDiagnostic } from './startup-diagnostics.ts';

export const name = 'notalone-sqlite-host';
export const inject = ['appReady', 'appExit','skills','llm'];

export function authorizeSqliteRequest(req: IncomingMessage, token: string): boolean {
  const authCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
  const expected = Buffer.from(`Bearer ${token}`);
  return req.headers.origin === undefined && authCount === 1 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

interface SqliteHostResource { close(): Promise<void> }
/** 同时通知各领域停读并等待真实排空；业务所有者未释放时保留共享资源，允许原操作续清。 */
export async function closeSqliteHostResources(resources: {
  firstHistory?: SqliteHostResource; incremental?: SqliteHostResource; imageSync?: SqliteHostResource; quoteSync?:SqliteHostResource; discussions?: SqliteHostResource; memory?: SqliteHostResource; media?: SqliteHostResource; history?: SqliteHostResource;
  historyRecertify?: SqliteHostResource; historyClear?: SqliteHostResource; historyResync?: SqliteHostResource; foreground?: SqliteHostResource; assistantReads?:SqliteHostResource; library?:SqliteHostResource; contacts?: SqliteHostResource; wechat?:SqliteHostResource; models?: SqliteHostResource; storage?: SqliteHostResource;
}): Promise<void> {
  const failures: unknown[] = [];
  // 不串行等待领域关闭：前一个读者可能正等待后一个领域释放共享CLI租约。
  const closed = await Promise.allSettled([resources.firstHistory, resources.incremental, resources.imageSync, resources.quoteSync, resources.historyRecertify, resources.historyClear, resources.historyResync, resources.foreground, resources.assistantReads, resources.discussions, resources.memory, resources.media, resources.history, resources.contacts, resources.library]
    .map(async resource => resource?.close()));
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, 'SQLITE_HOST_RESOURCE_CLOSE_FAILED');
  try { await resources.wechat?.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'SQLITE_HOST_RESOURCE_CLOSE_FAILED');
  try { await resources.models?.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'SQLITE_HOST_RESOURCE_CLOSE_FAILED');
  try { await resources.storage?.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'SQLITE_HOST_RESOURCE_CLOSE_FAILED');
}

/** 显式开发能力分支；领域事实及资格仍由联系人服务与受控动作负责。 */
export async function apply(ctx: Context) {
  const config = JSON.parse(await readFile(process.env.NOTALONE_HOST_CONFIG!, 'utf8'));
  await writeStartupDiagnostic(config.infoPath, 'configuration');
  try { await applySqliteHost(ctx, config); }
  catch (error) {
    const cause = startupFailureCause(error);
    await finishStartupDiagnostic(config.infoPath, cause);
    throw new Error('SQLITE_HOST_START_FAILED', {cause: new Error(cause)});
  }
}

async function applySqliteHost(ctx: Context, config: LaunchConfiguration & {home: string; parentPid: number}) {
  const sqlite = config.sqlite as SqliteLaunchConfiguration | undefined;
  const capabilities=sqlite&&typeof sqlite.userData==='string'?readSqliteCapabilities(sqlite.capabilities,sqlite.skillPackageRoot,sqlite.userData):undefined;
  if (process.ppid !== config.parentPid || !sqlite || sqlite.role !== 'test'
    || !path.isAbsolute(sqlite.userData) || !/^[A-Za-z0-9_-]{1,128}$/.test(sqlite.expectedDatabaseId)
    || !capabilities
    || sqlite.wechatCliPath !== undefined && !path.isAbsolute(sqlite.wechatCliPath)
    || config.infoPath !== path.join(sqlite.userData, 'managed/sqlite-backend.info')) throw new Error('SQLITE_HOST_CONFIGURATION_INVALID');
  const modelSetup=await SqliteModelSetup.open(config.envFilePath,process.env);
  const modelEnvironment=modelSetup.runtimeEnvironment();
  const backgroundProcessing=resolveBackgroundProcessingMode(modelEnvironment),automaticBackground=backgroundProcessing==='automatic';
  const imageProcessing=resolveImageProcessingMode(modelEnvironment),automaticImages=imageProcessing==='automatic';
  const token = randomBytes(32).toString('base64url');
  let state: 'running' | 'stopping' | 'stopped' = 'running';
  let storage: SqliteStorage | undefined;
  let opening: Promise<SqliteStorage> | undefined;
  let events: PureTsEvents | undefined;
  let contacts: ContactMetadataLifetime | undefined;
  let wechat:SharedWechatClient|undefined;
  let history: SqliteHistoryService | undefined;
  let checkpointCache:WechatHistoryCheckpointCache|undefined;
  let foreground: SqliteForeground | undefined;
  let firstHistory: FirstHistoryCoordinator | undefined;
  let incremental: IncrementalHistoryCoordinator | undefined;
  let historyClear: SqliteHistoryClearService | undefined;
  let historyResync: SqliteHistoryResyncService | undefined;
  let historyRecertify:SqliteHistoryRecertifyService|undefined;
  let media: SqliteMediaService | undefined;
  let imageSync:SqliteImageSyncCoordinator|undefined;
  let quoteSync:SqliteQuoteSyncCoordinator|undefined;
  let models: Awaited<ReturnType<typeof createSqliteModelRuntime>> | undefined;
  let memory: Awaited<ReturnType<typeof createSqliteMemoryRuntime>> | undefined;
  let discussions: Awaited<ReturnType<typeof createSqliteDiscussionHost>> | undefined;
  let assistantReads:StorageReader|undefined;
  let library:SqliteSkillLibrary|undefined;
  const requests=new Set<Promise<void>>();
  let server: Server | undefined;
  let published = false;
  let readyDispose = () => {};
  let publication: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let serverClosing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const stopResources = () => stopping ??= (async () => {
    state = 'stopping'; readyDispose(); models?.stopAccepting(); events?.close();
    await publication?.catch(() => {});
    if (opening) { try { storage ??= await opening; } catch {} }
    await closeSqliteHostResources({firstHistory,incremental,imageSync,quoteSync,historyRecertify,historyClear,historyResync,foreground,assistantReads,discussions,memory,media,history,contacts,library,wechat,models,storage:storage?{close:async()=>{await Promise.allSettled([...requests]);await storage!.close();}}:undefined});
    if (published) await rm(config.infoPath, { force: true });
    state = 'stopped';
  })().catch(error=>{stopping=undefined;throw error;});
  const closeServer = () => serverClosing ??= (async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  })();
  const close = () => closing ??= (async () => {
    await stopResources();
    await closeServer(); process.stdin.pause();
  })().catch(error=>{closing=undefined;throw error;});
  ctx.effect(() => close, 'notalone-sqlite-resources');
  // 官方 EOF 绑定在 appReady 之后请求有界退出，不掩盖启动失败。
  exitOnStdinEnd(ctx, 'notalone-sqlite-parent');
  process.stdin.resume();
  const exitCleanup = () => { if (process.ppid !== config.parentPid) rmSync(config.home, { recursive: true, force: true }); };
  process.once('exit', exitCleanup);
  ctx.effect(() => () => { if (process.ppid === config.parentPid) process.removeListener('exit', exitCleanup); }, 'notalone-sqlite-exit');
  try {
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    await writeStartupDiagnostic(config.infoPath, 'storage');
    opening = SqliteStorage.open({ userData: sqlite.userData, intent: 'open', expectedDatabaseId: sqlite.expectedDatabaseId, role: sqlite.role });
    storage = await opening;
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    const ownerId = await storage.execute<string>('identity.resolveOwner', { proposedOwnerId: randomUUID(), at: Date.now() });
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    await writeStartupDiagnostic(config.infoPath, 'modules');
    events = new PureTsEvents(ownerId);
    const deletionHolders = new ActiveHolders();
    if(sqlite.wechatCliPath)wechat=new SharedWechatClient(async()=>{
      const options=await loadSharedNarrowWechatOptions(sqlite.wechatCliPath!);
      return await supportsWechatImageKeyChannel(sqlite.wechatCliPath)?enrichImageToolOptions(options):options;
    });
    contacts = new ContactMetadataLifetime(storage, ownerId, deletionHolders, () => createWechatContactMetadata(sqlite.wechatCliPath,wechat));
    await contacts.initialize();
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    const createHistoryChannel=()=>createWechatHistoryChannel(sqlite.wechatCliPath,scope=>checkpointCache?.track(scope)??Promise.resolve(),wechat);
    const syncDirectory={directory:contacts.syncDirectory.bind(contacts)};
    if(capabilities.capabilities.some(capability=>capability==='history')){
      checkpointCache=new WechatHistoryCheckpointCache(storage,ownerId,deletionHolders,sqlite.wechatCliPath,contactId=>history?.stop(contactId)??Promise.resolve());
      await checkpointCache.initialize();
      history=new SqliteHistoryService(storage,contacts,createHistoryChannel,deletionHolders,
        (contactId,messageId,kind)=>{events?.publish(`message.${kind}`,contactId,{message_id:messageId});if(automaticBackground)memory?.wake(contactId);},contactId=>{if(automaticImages)imageSync?.wake(contactId);if(automaticBackground)quoteSync?.wake(contactId);},wechat);
      firstHistory=new FirstHistoryCoordinator(syncDirectory,history);
      history.setFirstHistoryWake(contactId=>{if(automaticBackground)firstHistory?.wakeContact(contactId);});
      incremental=new IncrementalHistoryCoordinator(syncDirectory,history,{firstHistoryManagedExternally:true});
      // 开启/重选只唤醒合法读取；关闭/取消/退出由 readStop 停止后续查询并等待在途释放。
      contacts.setReadStart(()=>{if(automaticImages)imageSync?.wake();if(automaticBackground){firstHistory!.wake();incremental!.wake();quoteSync?.wake();memory?.wake();}});
    }
    if(history&&process.env.NOTALONE_SYNC_PROBE&&path.isAbsolute(process.env.NOTALONE_SYNC_PROBE)) foreground=SqliteForeground.create(ownerId,process.env.NOTALONE_SYNC_PROBE,sqlite.wechatCliPath??'',()=>contacts!.foregroundSnapshot(),proof=>contacts!.confirmForeground(proof));
    const historyHttp=history?new SqliteHistoryHttp(history):undefined;
    let historyStatusInFlight:Promise<Record<string,unknown>>|undefined;
    const readHistoryStatus=async()=>{
      const directory=await contacts!.syncDirectory();
      const coverage=await readStatusCoverages(directory.bindings,contactId=>history!.coverage(contactId),contactIds=>history!.coverages(contactIds));
      return projectHistorySyncStatus(await contacts!.syncStatus(),coverage,firstHistory?.getState(),incremental?.getState(),
        await history!.bodyAvailable(coverage.map(row=>row.contactId)));
    };
    // 多个界面同时刷新只共享在途读取；完成后下次查询仍重新核验，不保留状态缓存。
    const historyStatus=()=>historyStatusInFlight??=(readHistoryStatus().finally(()=>{historyStatusInFlight=undefined;}));
    library=capabilities.skillPackageRoot?new SqliteSkillLibrary(storage,ownerId,capabilities.skillPackageRoot):undefined;
    const skills=library?new SqliteSkillHttp(library,req=>authorizeSqliteRequest(req,token)):undefined;
    assistantReads=capabilities.capabilities.includes('discussions')?await createAssistantReadChannel({storage,ownerId,holders:deletionHolders}):undefined;
    const deletionService = new DeletionService(storage, deletionHolders, new ManagedFiles(sqlite.userData),{reader:assistantReads});
    if(history){historyClear=new SqliteHistoryClearService(storage,contacts,createHistoryChannel,deletionService,deletionHolders);
      historyResync=new SqliteHistoryResyncService(storage,contacts,createHistoryChannel,deletionHolders);}
    if(history){
      const proveLegacyTerminals=sqlite.wechatCliPath?await loadHostLegacyProofProvider({userData:sqlite.userData,databaseId:sqlite.expectedDatabaseId,currentExecutable:sqlite.wechatCliPath}):undefined;
      historyRecertify=new SqliteHistoryRecertifyService(storage,contacts,createHistoryChannel,deletionHolders,{stopHistory:id=>history!.stop(id),onCompleted:id=>{if(automaticBackground)firstHistory?.wakeContact(id);},proveLegacyTerminals});
    }
    const historyClearHttp=historyClear&&historyResync?new SqliteHistoryClearHttp(historyClear,historyResync,historyRecertify):undefined;
    // 图片同步装配来源可验证的图片入口；其他媒体沿已认证能力开放。
    const originalImages=history&&await supportsWechatOriginalImages(sqlite.wechatCliPath);
    media = new SqliteMediaService({storage,contacts,history:{source:(contactId,recordId)=>{
      if(!history)throw new StorageFailure('media_source_unavailable');return history.source(contactId,recordId);
    }},...(history?{ensureSourceReady:(contactId:string,signal?:AbortSignal)=>history!.prepareSource(contactId,signal)}:{}),userData:sqlite.userData,holders:deletionHolders,deletion:deletionService,changed:(contactId,messageId)=>{events?.publish('message.updated',contactId,{message_id:messageId});if(automaticBackground)memory?.wake(contactId);},adapters:originalImages?[new OriginalImageMediaAdapter(createWechatImageResourcePort(sqlite.wechatCliPath,wechat))]:[]});
    await media.initialize();
    if(originalImages)imageSync=new SqliteImageSyncCoordinator(storage,syncDirectory,media);
    if(history&&await supportsWechatQuotes(sqlite.wechatCliPath))quoteSync=new SqliteQuoteSyncCoordinator(syncDirectory,history);
    contacts.setReadStop(async contactId=>{await Promise.all([historyRecertify?.stop(contactId),imageSync?.stop(contactId),quoteSync?.stop(contactId),firstHistory?firstHistory.stop(contactId):history?.stop(contactId),incremental?.stop(contactId),media!.stop(contactId,contactId?'all':'wechat')]);if(contactId)await checkpointCache?.forget(contactId);else await wechat?.stop();});
    const mediaHttp = new SqliteMediaHttp(media);
    const discussionsEnabled=capabilities.capabilities.includes('discussions'),memoryEnabled=capabilities.capabilities.includes('memory');
    if(discussionsEnabled||memoryEnabled)models=await createSqliteModelRuntime({ctx,environment:modelEnvironment,userData:sqlite.userData,businessHome:config.businessHome,infoPath:config.infoPath,envFilePath:config.envFilePath,
      accounting:{reserve:async(receipt,claim)=>{if(!memory)throw new StorageFailure('sqlite_model_producer_unavailable');await memory.service.accounting.reserve(receipt,claim);},
        recordReserved:async receipt=>{if(!memory)throw new StorageFailure('sqlite_model_producer_unavailable');await memory.service.accounting.recordReserved(receipt);},
        unconfirmedRequests:async scope=>{if(scope.owner_id!==ownerId)throw new StorageFailure('sqlite_model_owner_invalid');return [...new Set([...(memory?await memory.service.accounting.unconfirmedRequests!(scope):[]),...await storage!.execute<string[]>('discussion.unconfirmed',scope)])];}}});
    const memoryManagement=new SqliteMemoryManagement(storage,ownerId);
    const memoryManagementHttp=memoryEnabled?new SqliteMemoryManagementHttp(memoryManagement,req=>authorizeSqliteRequest(req,token),()=>{if(automaticBackground)memory?.wake();}):undefined;
    // 即使入口未开启，也恢复并持有旧副本的清理所有者，避免资料删除遗漏持久副本。
    memory=await createSqliteMemoryRuntime({ctx,storage,ownerId,userData:sqlite.userData,businessHome:config.businessHome,infoPath:config.infoPath,envFilePath:config.envFilePath,environment:modelEnvironment,contentResources:{readImage:input=>media!.readMemoryImage(input)},
      ...(models?.shared?{sharedModel:models.shared}:{}),holders:deletionHolders,authorize:req=>authorizeSqliteRequest(req,token),adjudicationEnabled:memoryEnabled,...(history?{ensureSourceReady:(contactId:string)=>history!.prepareSource(contactId)}:{})});
    // 共享模型宿主的记账回调已可找到唯一 memory 实例，再受理自动调度。
    if(memoryEnabled&&automaticBackground)memory.startScheduling();
    const memoryDocumentsHttp=memoryEnabled&&memory.documents?new SqliteMemoryDocumentsHttp(memory.documents,req=>authorizeSqliteRequest(req,token)):undefined;
    discussions=await createSqliteDiscussionHost({ctx,storage,ownerId,userData:sqlite.userData,holders:deletionHolders,reader:assistantReads,library,authorizeRequest:req=>authorizeSqliteRequest(req,token),
      ...(models?.shared?{model:{configuration:models.shared.configuration.model,provider:models.shared.provider,arbiter:models.shared.arbiter}}:{})});
    const deletions = new SqliteDeletionHttp(deletionService, ownerId);
    const ownership = { contacts: 'typescript', wechat: 'typescript',
      deletion: 'typescript', media: 'typescript', mediaExtraction: originalImages?'typescript':'unavailable', skills: skills?'typescript':'unavailable', skillLearning: 'unavailable', imports: 'unavailable',
      taskApi: 'unavailable', taskManagement: 'unavailable', tasks: 'unavailable', crossDomainDeletion: 'typescript',
      wechatBodySync: history?'typescript':'unavailable', wechatIncremental: history?'typescript':'unavailable', wechatHistory: history?'typescript':'unavailable',
      foregroundLocation: foreground?'typescript':'unavailable', contactContext: 'unavailable', memory: memoryEnabled?'typescript':'unavailable', memoryManagement:memoryEnabled?'typescript':'unavailable', discussions:discussionsEnabled?'typescript':'unavailable',
      expressionPreferences: 'unavailable', replies: 'unavailable' };
    const handleRequest=async (req:IncomingMessage,res:ServerResponse):Promise<void> => {
      const respond = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (!authorizeSqliteRequest(req, token)) { respond(401, { error: 'unauthorized' }); return; }
      let url: URL;
      try { url = new URL(req.url ?? '', 'http://localhost'); }
      catch { respond(400, { error: 'invalid_request' }); return; }
      if (req.url !== url.pathname && (req.url !== url.pathname + url.search || !(deletionQueryAllowed(req.method, url)||history&&historyQueryAllowed(req.method,url)||memoryManagementHttp&&memoryManagementQueryAllowed(req.method,url)||memoryDocumentsHttp&&memoryDocumentsQueryAllowed(req.method,url)||historyClearHttp&&clearQueryAllowed(req.method,url)))) { respond(400, { error: 'invalid_request' }); return; }
      const changesMemoryScope=req.method==='DELETE'||req.method==='POST'&&(/^\/api\/deletions\//.test(url.pathname)||/^\/api\/contacts\/[a-f0-9-]{36}\/history\/(clear|resync)$/.test(url.pathname)||/^\/api\/sync\/(enable|disable|cli-bindings\/(confirm|revoke))$/.test(url.pathname));
      if(changesMemoryScope)res.once('finish',()=>{if(automaticBackground&&res.statusCode>=200&&res.statusCode<300)memory?.wake();});
      let releaseForeground:(()=>void)|undefined;
      try {
        const changesAuthority=req.method==='DELETE'||req.method==='POST'&&(/^\/api\/contacts\/[a-f0-9-]{36}\/history\/recertify(?:\/cancel)?$/.test(url.pathname)||/^\/api\/sync\/(enable|disable|cli-bindings\/(confirm|revoke))$/.test(url.pathname)||/^\/api\/setup\/wechat\//.test(url.pathname));
        if(changesAuthority&&foreground)releaseForeground=await foreground.beginChange();
        if (req.method === 'GET' && url.pathname === '/api/runtime/status') {
          respond(200, { state, background_processing:backgroundProcessing, image_processing:imageProcessing, image_sync:imageSync?.status()??null, runtime: 'dsh', hostRuntime: 'typescript', pid: process.pid, storage: 'sqlite', storageDiagnostic: storage?.failureDiagnostic ?? null, storageTiming:storage?.timingDiagnostic??null, capabilities: capabilities.capabilities, deletion_scopes: installedDeletionScopes, ownership }); return;
        }
        if (url.pathname === '/api/events') {
          if (req.method!=='GET') { respond(405,{error:'method_not_allowed'});return; }
          if (!req.headers.accept?.split(',').some(value=>value.trim().split(';')[0].toLowerCase()==='text/event-stream')) { respond(406,{error:'event_stream_required'});return; }
          events?.open(req,res);return;
        }
        if (req.method === 'POST' && url.pathname === '/api/runtime/shutdown') {
          await stopResources();
          res.once('finish', () => ctx.appExit!(0)); respond(200, { state, runtime: 'dsh' }); return;
        }
        if (state !== 'running') { respond(503, { error: 'runtime_stopping' }); return; }
        if(req.method==='GET'&&url.pathname==='/api/setup/status'){
          respond(200,{...modelSetup.status(),owner_id:ownerId,storage:'sqlite',capabilities:capabilities.capabilities});return;
        }
        if(req.method==='POST'&&(url.pathname==='/api/setup/credentials'||url.pathname==='/api/setup/official-deepseek'||url.pathname==='/api/setup/deepseek-configuration')){
          try {
            const body=await readWechatHttpBody(req,16384,10000);
            const payload=JSON.parse(body.toString('utf8')),official=url.pathname==='/api/setup/official-deepseek',custom=url.pathname==='/api/setup/deepseek-configuration';
            if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.api_key!=='string'||
              (custom?(typeof payload.base_url!=='string'||Object.keys(payload).length!==2||Object.keys(payload).some(key=>!['base_url','api_key'].includes(key))):official?(payload.confirm_official_defaults!==true||Object.keys(payload).some(key=>!['api_key','confirm_official_defaults'].includes(key))):
                (payload.provider!=='deepseek'||Object.keys(payload).some(key=>!['provider','api_key'].includes(key)))))throw new StorageFailure('setup_request_invalid');
            if(custom)await modelSetup.saveConfiguration(payload.base_url,payload.api_key);else await modelSetup.save(payload.api_key,official);
            respond(200,{provider:'deepseek',configured:true,restart_required:true,...(official?{official_deepseek_defaults:true}:{})});
          }catch(error){respond(400,{error:error instanceof StorageFailure?error.code:'setup_request_invalid'});}return;
        }
        if(foreground&&url.pathname==='/api/sync/foreground/permission-restored'){
          if(req.method!=='POST'){respond(405,{error:'method_not_allowed'});return;}
          let body:unknown;try{body=JSON.parse((await readWechatHttpBody(req,1024,3500)).toString('utf8')||'{}');}catch{respond(400,{error:'foreground_observation_invalid'});return;}
          if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length){respond(400,{error:'foreground_observation_invalid'});return;}
          await foreground.screenPermissionRestored();respond(200,{ok:true});return;
        }
        if(foreground&&url.pathname==='/api/sync/foreground/confirm'){
          if(req.method!=='POST'){respond(405,{error:'method_not_allowed'});return;}
          let body:unknown;try{body=JSON.parse((await readWechatHttpBody(req,1024,3500)).toString('utf8'));}catch{respond(400,{error:'foreground_confirmation_invalid'});return;}
          const fields=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:null;
          const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
          if(!fields||Object.keys(fields).length!==2||!Object.keys(fields).every(k=>k==='contact_id'||k==='observation_id')
            ||typeof fields.contact_id!=='string'||!uuid.test(fields.contact_id)||typeof fields.observation_id!=='string'||!uuid.test(fields.observation_id)){
            respond(400,{error:'foreground_confirmation_invalid'});return;
          }
          const abort=new AbortController(),onAbort=()=>abort.abort();req.once('aborted',onAbort);
          try{respond(200,await foreground.confirm(fields.contact_id,fields.observation_id,abort.signal));}
          catch(error){const code=(error as {code?:string}).code;respond(409,{error:code==='foreground_binding_required'?code:'foreground_confirmation_stale'});}
          finally{req.removeListener('aborted',onAbort);}return;
        }
        if(foreground&&url.pathname==='/api/sync/foreground/observe'){
          if(req.method!=='POST'){respond(405,{error:'method_not_allowed'});return;}
          let body:unknown;try{body=JSON.parse((await readWechatHttpBody(req,1024,3500)).toString('utf8')||'{}');}catch{respond(400,{error:'foreground_observation_invalid'});return;}
          if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length){respond(400,{error:'foreground_observation_invalid'});return;}
          const abort=new AbortController(),onAbort=()=>abort.abort();req.once('aborted',onAbort);
          try{const result=await foreground.observe(abort.signal);const {recognized_name,recognition_confidence,...rest}=result;respond(200,{...rest,...(recognized_name===null?{}:{recognized_name,recognition_confidence})});}
          catch(error){
            const code=(error as {code?:string}).code;
            // 只外露固定恢复原因；账号未验证和观察超时不能被折叠成传输故障。
            const safe=code==='foreground_observation_busy'||code==='foreground_scope_unavailable'||code==='observation_timeout'?code:'foreground_observation_unavailable';
            respond(safe==='foreground_observation_busy'?409:safe==='observation_timeout'?504:503,{error:safe});
          }
          finally{req.removeListener('aborted',onAbort);}return;
        }
        if(history&&req.method==='GET'&&url.pathname==='/api/sync/status'){
          respond(200,await historyStatus());return;
        }
        if(url.pathname==='/api/ledger/summary'){
          if(req.method!=='GET'){respond(405,{error:'method_not_allowed'});return;}
          if(url.search){respond(400,{error:'ledger_summary_query_invalid'});return;}
          respond(200,await storage!.execute('modelUsage.summary',{ownerId}));return;
        }
        if (!await deletions.handle(req,res)&&!await memoryManagementHttp?.handle(req,res)&&!await memoryDocumentsHttp?.handle(req,res)&&!await mediaHttp.handle(req,res)&&!await historyHttp?.handle(req,res)&&!await historyClearHttp?.handle(req,res)&&!await skills?.handle(req,res)&&!(discussionsEnabled&&await discussions!.http.handle(req,res))&&!(memoryEnabled&&await memory!.http.handle(req,res))&&!await contacts!.handle(req, res)) respond(url.pathname.startsWith('/api/') ? 503 : 404, { error: 'sqlite_capability_unavailable' });
      } catch { if (!res.headersSent) respond(503, { error: 'sqlite_contact_operation_failed' }); else res.destroy(); }
      finally {releaseForeground?.();}
    };
    await writeStartupDiagnostic(config.infoPath, 'handshake');
    server=createServer((req,res)=>{
      const pending=handleRequest(req,res),lifecycle=req.url==='/api/runtime/status'||req.url==='/api/runtime/shutdown';
      if(!lifecycle){requests.add(pending);const release=()=>requests.delete(pending);pending.then(release,release);}
      void pending.catch(()=>{if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'sqlite_operation_unavailable'}));}else res.destroy();});
    });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => { server!.removeListener('error', reject); resolve(); }); });
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SQLITE_HOST_LISTEN_FAILED');
    readyDispose = ctx.appReady!.onReady(() => {
      if (state !== 'running') return;
      publication = (async () => {
        const pending = `${config.infoPath}.${randomUUID()}.pending`;
        try {
          await writeFile(pending, `address=127.0.0.1:${address.port}\ntoken=${token}\npid=${process.pid}\n`, { mode: 0o600, flag: 'wx' });
          await link(pending, config.infoPath); published = true;
          await clearStartupDiagnostic(config.infoPath);
        } finally { await rm(pending, { force: true }); }
      })();
      void publication.then(()=>{if(state!=='running')return;if(automaticImages)imageSync?.wake();if(automaticBackground){firstHistory?.wake();incremental?.wake();incremental?.start();quoteSync?.wake();}}).catch(async error => {await finishStartupDiagnostic(config.infoPath, startupFailureCause(error));ctx.appExit!(1);});
    });
  } catch (error) {
    await finishStartupDiagnostic(config.infoPath, startupFailureCause(error));
    await close();
    throw error;
  }
}
