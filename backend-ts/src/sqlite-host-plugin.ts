import type { Context } from '@deepseek-ai/cordis';
import { exitOnStdinEnd } from '@deepseek-ai/dsh-cmdline';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { SqliteStorage } from './storage/sqlite/client.ts';
import type { SqliteLaunchConfiguration } from './launch.ts';
import { SqliteContactService } from './contacts/sqlite/service.ts';
import { SqliteContactHttp } from './contacts/sqlite/http.ts';
import { createWechatContactMetadata } from './contacts/sqlite/wechat-metadata.ts';
import {readSqliteCapabilities} from './sqlite-capabilities.ts';
import {SqliteSkillLibrary} from './skills/sqlite/library.ts';
import {SqliteSkillHttp} from './skills/sqlite/http.ts';
import { DeletionService } from './storage/sqlite/deletion/service.ts';
import { ActiveHolders } from './storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from './storage/sqlite/deletion/managed-files.ts';
import { SqliteDeletionHttp, deletionQueryAllowed } from './storage/sqlite/deletion/http.ts';
import { installedDeletionScopes } from './storage/sqlite/deletion/registration.ts';

export const name = 'notalone-sqlite-host';
export const inject = ['appReady', 'appExit','skills'];

export function authorizeSqliteRequest(req: IncomingMessage, token: string): boolean {
  const authCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
  const expected = Buffer.from(`Bearer ${token}`);
  return req.headers.origin === undefined && authCount === 1 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** 显式开发能力分支；领域事实及资格仍由联系人服务与受控动作负责。 */
export async function apply(ctx: Context) {
  const config = JSON.parse(await readFile(process.env.NOTALONE_HOST_CONFIG!, 'utf8'));
  const sqlite = config.sqlite as SqliteLaunchConfiguration | undefined;
  const capabilities=sqlite&&typeof sqlite.userData==='string'?readSqliteCapabilities(sqlite.capabilities,sqlite.skillPackageRoot,sqlite.userData):undefined;
  if (process.ppid !== config.parentPid || !sqlite || sqlite.role !== 'test'
    || !path.isAbsolute(sqlite.userData) || !/^[A-Za-z0-9_-]{1,128}$/.test(sqlite.expectedDatabaseId)
    || !capabilities
    || sqlite.wechatCliPath !== undefined && !path.isAbsolute(sqlite.wechatCliPath)
    || config.infoPath !== path.join(sqlite.userData, 'managed/sqlite-backend.info')) throw new Error('SQLITE_HOST_CONFIGURATION_INVALID');
  const token = randomBytes(32).toString('base64url');
  let state: 'running' | 'stopping' | 'stopped' = 'running';
  let storage: SqliteStorage | undefined;
  let opening: Promise<SqliteStorage> | undefined;
  let service: SqliteContactService | undefined;
  let server: Server | undefined;
  let published = false;
  let readyDispose = () => {};
  let publication: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let serverClosing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const stopResources = () => stopping ??= (async () => {
    state = 'stopping'; readyDispose();
    await publication?.catch(() => {});
    if (opening) { try { storage ??= await opening; } catch {} }
    try { await service?.close(); }
    finally { await storage?.close(); }
    if (published) await rm(config.infoPath, { force: true });
    state = 'stopped';
  })();
  const closeServer = () => serverClosing ??= (async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  })();
  const close = () => closing ??= (async () => {
    try { await stopResources(); }
    finally { await closeServer(); process.stdin.pause(); }
  })();
  ctx.effect(() => close, 'notalone-sqlite-resources');
  // 官方 EOF 绑定在 appReady 之后请求有界退出，不掩盖启动失败。
  exitOnStdinEnd(ctx, 'notalone-sqlite-parent');
  process.stdin.resume();
  const exitCleanup = () => { if (process.ppid !== config.parentPid) rmSync(config.home, { recursive: true, force: true }); };
  process.once('exit', exitCleanup);
  ctx.effect(() => () => { if (process.ppid === config.parentPid) process.removeListener('exit', exitCleanup); }, 'notalone-sqlite-exit');
  try {
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    opening = SqliteStorage.open({ userData: sqlite.userData, intent: 'open', expectedDatabaseId: sqlite.expectedDatabaseId, role: sqlite.role });
    storage = await opening;
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    const ownerId = await storage.execute<string>('identity.resolveOwner', { proposedOwnerId: randomUUID(), at: Date.now() });
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    service = new SqliteContactService(storage, ownerId, createWechatContactMetadata(sqlite.wechatCliPath));
    await service.initialize();
    if (state !== 'running') throw new Error('SQLITE_HOST_STOPPING');
    const contacts = new SqliteContactHttp(service);
    const skills=capabilities.skillPackageRoot?new SqliteSkillHttp(new SqliteSkillLibrary(storage,ownerId,capabilities.skillPackageRoot),req=>authorizeSqliteRequest(req,token)):undefined;
    const deletionHolders = new ActiveHolders();
    const deletions = new SqliteDeletionHttp(new DeletionService(storage, deletionHolders, new ManagedFiles(sqlite.userData)), ownerId);
    const ownership = { contacts: 'typescript', wechat: 'typescript',
      deletion: 'typescript', skills: skills?'typescript':'unavailable', skillLearning: 'unavailable', imports: 'unavailable',
      taskApi: 'unavailable', taskManagement: 'unavailable', tasks: 'unavailable', crossDomainDeletion: 'typescript',
      wechatBodySync: 'unavailable', wechatIncremental: 'unavailable', wechatHistory: 'unavailable',
      foregroundLocation: 'unavailable', contactContext: 'unavailable', memory: 'unavailable',
      expressionPreferences: 'unavailable', replies: 'unavailable' };
    server = createServer(async (req, res) => {
      const respond = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (!authorizeSqliteRequest(req, token)) { respond(401, { error: 'unauthorized' }); return; }
      let url: URL;
      try { url = new URL(req.url ?? '', 'http://localhost'); }
      catch { respond(400, { error: 'invalid_request' }); return; }
      if (req.url !== url.pathname && (req.url !== url.pathname + url.search || !deletionQueryAllowed(req.method, url))) { respond(400, { error: 'invalid_request' }); return; }
      try {
        if (req.method === 'GET' && url.pathname === '/api/runtime/status') {
          respond(200, { state, runtime: 'dsh', hostRuntime: 'typescript', pid: process.pid, storage: 'sqlite', capabilities: capabilities.capabilities, deletion_scopes: installedDeletionScopes, ownership }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/runtime/shutdown') {
          await stopResources();
          res.once('finish', () => ctx.appExit!(0)); respond(200, { state, runtime: 'dsh' }); return;
        }
        if (state !== 'running') { respond(503, { error: 'runtime_stopping' }); return; }
        if (!await deletions.handle(req,res)&&!await skills?.handle(req,res)&&!await contacts.handle(req, res)) respond(url.pathname.startsWith('/api/') ? 503 : 404, { error: 'sqlite_capability_unavailable' });
      } catch { if (!res.headersSent) respond(503, { error: 'sqlite_contact_operation_failed' }); else res.destroy(); }
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
        } finally { await rm(pending, { force: true }); }
      })();
      void publication.catch(() => ctx.appExit!(1));
    });
  } catch {
    await close();
    throw new Error('SQLITE_HOST_START_FAILED');
  }
}
