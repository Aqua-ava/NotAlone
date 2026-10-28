/** 桌面首用的普通业务模块；不依赖 DSH session、profile home 或模型接口。 */
import { constants, lstatSync, readdirSync, realpathSync, openSync, fstatSync, readFileSync, closeSync, type BigIntStats } from 'node:fs';
import { open, readFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { userInfo } from 'node:os';
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';

const EXPECTED_MIGRATION_COUNT = 128;

export class HostStorageError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'HostStorageError'; }
}
/** 以查询抛错来源区分驱动故障；pg 客户端超时不一定是 DatabaseError，不能匹配 message。 */
function trackQueryFailures(client: pg.Client, failures: Set<unknown>): () => void {
  type Callback = (this: unknown, error: unknown, ...values: unknown[]) => unknown;
  type QueryDispatch = pg.Query & { handleError: Callback; _canceledDueToError?: unknown };
  type QueryClient = pg.Client & { queryQueue: pg.Query[]; _pulseQueryQueue: (...args: unknown[]) => unknown };
  const observed = new WeakMap<pg.Query, () => void>();
  const cleanups = new Set<() => void>();
  const captureQuery = (query: QueryDispatch): (() => void) => {
    const existing = observed.get(query);
    if (existing) return existing;
    // 锁定 pg 8.16.3 的分发入口：既不替换 Query/内部回调，也不改动连接或报文协议。
    // handleError 会优先分发已保存的行解析错误，记录它实际交给调用方的原对象。
    const handleError = query.handleError;
    if (typeof handleError !== 'function') throw new HostStorageError('database_unavailable');
    const descriptor = Object.getOwnPropertyDescriptor(query, 'handleError');
    const cleanup = () => {
      cleanups.delete(cleanup);
      if (observed.get(query) === cleanup) observed.delete(query);
      if (query.handleError === tracked) {
        if (descriptor) Object.defineProperty(query, 'handleError', descriptor);
        else Reflect.deleteProperty(query, 'handleError');
      }
      query.removeListener('end', cleanup);
    };
    const tracked: Callback = function(error, ...values) {
      failures.add((this as QueryDispatch)._canceledDueToError || error);
      cleanup();
      return Reflect.apply(handleError, this, [error, ...values]);
    };
    query.handleError = tracked;
    observed.set(query, cleanup);
    cleanups.add(cleanup);
    query.once('end', cleanup);
    return cleanup;
  };
  const current = client as QueryClient, pulse = current._pulseQueryQueue;
  const pulseDescriptor = Object.getOwnPropertyDescriptor(current, '_pulseQueryQueue');
  if (typeof pulse !== 'function') throw new HostStorageError('database_unavailable');
  const trackedPulse = function(this: QueryClient, ...args: unknown[]): unknown {
    // 每次入队和分发都先观察原生 Query；submit/toPostgres 重入前已覆盖，排队超时也不遗漏。
    for (const pending of this.queryQueue) if (pending instanceof pg.Query) captureQuery(pending as QueryDispatch);
    return Reflect.apply(pulse, this, args);
  };
  current._pulseQueryQueue = trackedPulse;
  const query = client.query;
  const queryDescriptor = Object.getOwnPropertyDescriptor(client, 'query');
  const trackedQuery = function(this: pg.Client, ...args: unknown[]): unknown {
    try {
      const result = Reflect.apply(query, this, args);
      if (result instanceof pg.Query) return result;
      if (result && typeof result.then === 'function') {
        return result.then(undefined, (error: unknown) => { failures.add(error); throw error; });
      }
      return result;
    } catch (error) { failures.add(error); throw error; }
  } as pg.Client['query'];
  client.query = trackedQuery;
  return () => {
    for (const cleanup of [...cleanups]) cleanup();
    if (client.query === trackedQuery) {
      if (queryDescriptor) Object.defineProperty(client, 'query', queryDescriptor);
      else Reflect.deleteProperty(client, 'query');
    }
    if (current._pulseQueryQueue === trackedPulse) {
      if (pulseDescriptor) Object.defineProperty(current, '_pulseQueryQueue', pulseDescriptor);
      else Reflect.deleteProperty(current, '_pulseQueryQueue');
    }
  };
}
/** 每次回调只见自己的租约；撤销后委托原生已关闭Client，保留pg各查询重载的返回语义。 */
function businessLease(client: pg.Client): { client: pg.Client; revoke(): void; reusable(): boolean; cleanupListeners(): void } {
  const retired = new pg.Client({ host: '/tmp', database: 'notalone_retired', user: 'notalone_retired',
    password: '', port: 5432, ssl: false, options: ' ', application_name: 'notalone_retired', client_encoding: 'UTF8' });
  void retired.end(); // 不连接数据库，只使用原生pg的关闭后查询分发。
  let active = true, reusable = true;
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const listeners: [string | symbol, (...args: unknown[]) => void][] = [];
  const proxy = new Proxy(retired, {
    get(_target, property) {
      const target = active ? client : retired, value = Reflect.get(target, property, target);
      if (property === 'constructor') return value;
      if (typeof value !== 'function') {
        if (active && value && typeof value === 'object') reusable = false;
        return value;
      }
      if (!methods.has(property)) methods.set(property, (...args) => {
        const target = active ? client : retired;
        // 原生Query、命名配置、监听器及显式Client变更按旧生命周期关闭，避免携带驱动状态。
        if (active && (property !== 'query' || typeof args[0] !== 'string')) reusable = false;
        if (active && ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'].includes(String(property))
          && (typeof args[0] === 'string' || typeof args[0] === 'symbol') && typeof args[1] === 'function') {
          listeners.push([args[0], args[1] as (...args: unknown[]) => void]);
        }
        const result = Reflect.apply(Reflect.get(target, property, target), target, args);
        return result === client ? proxy : result;
      });
      return methods.get(property);
    },
    set(_target, property, value) { reusable = false; return Reflect.set(active ? client : retired, property, value); },
    defineProperty(_target, property, descriptor) { reusable = false; return Reflect.defineProperty(active ? client : retired, property, descriptor); },
    deleteProperty(_target, property) { reusable = false; return Reflect.deleteProperty(active ? client : retired, property); },
  });
  return { client: proxy, revoke() { active = false; }, reusable: () => reusable,
    cleanupListeners() { for (const [event, listener] of listeners) client.removeListener(event, listener); listeners.length = 0; } };
}
interface OwnedBusinessConnection {
  // 锁定pg 8.16.3所带的pg-pool使用同一对owned-client方法；类型包未声明，能力不符时失败关闭。
  client: pg.Client & { ref(): void; unref(): void };
  key: string;
  created: number;
  unavailable: boolean;
  lost: () => void;
  end: () => Promise<void>;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
}
export interface HostStorageOptions {
  envFilePath: string;
  migrationsDirectory: string;
  environment?: NodeJS.ProcessEnv;
}
function parseLine(line: string): [string, string] | undefined {
  const text = line.trim().replace(/^export\s+/, '');
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(text);
  if (!match) return undefined;
  let value = match[2].trim();
  if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
  return [match[1], value];
}
async function readConfiguration(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new HostStorageError('configuration_invalid');
    return await file.readFile('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new HostStorageError('configuration_unavailable');
  } finally { await file?.close(); }
}
const MODEL_CONFIGURATION_KEYS = ['NOTALONE_DEEPSEEK_API_KEY', 'NOTALONE_DEEPSEEK_MODEL', 'NOTALONE_DEEPSEEK_BASE_URL'] as const;
function fileIdentity(path: string, metadata: BigIntStats): string {
  return [path, metadata.dev, metadata.ino, metadata.size, metadata.ctimeNs, metadata.mtimeNs,
    metadata.mode, metadata.uid, metadata.gid].join(':');
}
export class HostStorage {
  private closed = false;
  private configurationPending = false;
  private pending = new Set<Promise<void>>();
  private migrationSummaries = new Map<string, { identity: string; checksum: string }>();
  private idleBusinessConnection?: OwnedBusinessConnection;
  private connectionClosings = new Set<Promise<void>>();
  private assertOpen(): void { if (this.closed) throw new HostStorageError('runtime_stopping'); }
  private readonly options: HostStorageOptions;
  private readonly values: Record<string, string | undefined>;
  private readonly explicitConfiguration: Record<string, string | undefined>;
  private readonly dotenvDisabled: boolean;
  private readonly configurationEnvironmentOverride: boolean;
  private constructor(options: HostStorageOptions, values: Record<string, string | undefined>,
    explicitConfiguration: Record<string, string | undefined>, dotenvDisabled: boolean, configurationEnvironmentOverride: boolean) {
    this.options = options; this.values = values; this.configurationPending = configurationEnvironmentOverride;
    this.explicitConfiguration = explicitConfiguration; this.dotenvDisabled = dotenvDisabled; this.configurationEnvironmentOverride = configurationEnvironmentOverride;
  }
  static async open(options: HostStorageOptions): Promise<HostStorage> {
    const environment = { ...(options.environment ?? process.env) };
    const values = { ...environment }, fileValues: Record<string, string | undefined> = {};
    const dotenvDisabled = environment.NOTALONE_DISABLE_DOTENV === '1';
    if (!dotenvDisabled) {
      for (const line of (await readConfiguration(options.envFilePath)).split(/\r?\n/)) {
        const entry = parseLine(line);
        if (entry && fileValues[entry[0]] === undefined) fileValues[entry[0]] = entry[1];
        if (entry && values[entry[0]] === undefined) values[entry[0]] = entry[1];
      }
    }
    const explicitConfiguration = Object.fromEntries(MODEL_CONFIGURATION_KEYS.map(key => [key, environment[key]]));
    const overridden = MODEL_CONFIGURATION_KEYS.some(key => environment[key] !== undefined
      && fileValues[key] !== undefined && environment[key] !== fileValues[key]);
    return new HostStorage(options, values, explicitConfiguration, dotenvDisabled, overridden);
  }
  private assertModelConfigurationWritable(changes: Record<string, string>): void {
    this.assertOpen();
    // 显式环境优先于文件；拒绝无法由本次保存兑现的更改，不回显覆盖值。
    if (this.dotenvDisabled || Object.entries(changes).some(([key, value]) =>
      this.explicitConfiguration[key] !== undefined && this.explicitConfiguration[key] !== value)) {
      throw new HostStorageError('configuration_environment_override');
    }
  }
  get databaseUrl(): string { return this.values.NOTALONE_DATABASE_URL?.trim() ?? ''; }
  get runtimeOwnerId(): string | undefined { return this.values.NOTALONE_OWNER_ID?.trim() || undefined; }
  credentialStatus(): { provider: string; configured: boolean } {
    return { provider: 'deepseek', configured: Boolean(this.values.NOTALONE_DEEPSEEK_API_KEY?.trim()) };
  }
  /** 只供同一后台装配旧业务使用，禁止传给界面、日志或 DSH 会话。 */
  runtimeEnvironment(): NodeJS.ProcessEnv { return { ...this.values, NOTALONE_ENV_FILE: this.options.envFilePath }; }
  async compatibility(): Promise<{ code: string }> {
    try { return { code: await this.withClient(false, client => this.inspect(client)) }; }
    catch (error) { return { code: error instanceof HostStorageError ? error.code : 'database_unavailable' }; }
  }
  async setupStatus(): Promise<Record<string, boolean>> {
    return this.withClient(false, async client => {
      await this.requireReady(client);
      const owners = await client.query('SELECT count(*)::int AS count FROM public.owner');
      const ownerCount = owners.rows[0].count;
      const runtime = this.runtimeOwnerId;
      const exists = runtime && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runtime)
        ? (await client.query('SELECT EXISTS(SELECT 1 FROM public.owner WHERE id=$1::uuid) AS present', [runtime])).rows[0].present : false;
      return { initialized: ownerCount > 0, owner_configured: ownerCount > 0, recoverable_owner: ownerCount === 1 && !runtime,
        credentials_configured: this.credentialStatus().configured, runtime_owner_configured: Boolean(exists),
        runtime_configuration_pending: this.configurationPending,
        runtime_configuration_environment_override: this.configurationEnvironmentOverride,
        official_deepseek_defaults: (this.values.NOTALONE_DEEPSEEK_MODEL ?? 'deepseek-flash') === 'deepseek-flash'
          && ['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes((this.values.NOTALONE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')) };
    });
  }
  async initializeOwner(displayName: string): Promise<{ owner_id: string; created: true }> {
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 4096) throw new HostStorageError('setup_request_invalid');
    return this.withClient(true, async client => {
      await this.requireReady(client);
      await client.query('LOCK TABLE public.owner IN SHARE ROW EXCLUSIVE MODE');
      if ((await client.query('SELECT EXISTS(SELECT 1 FROM public.owner) AS present')).rows[0].present) throw new HostStorageError('owner_already_configured');
      const owner = randomUUID();
      await client.query('INSERT INTO public.owner(id, display_name) VALUES($1::uuid,$2)', [owner, displayName.trim()]);
      // 先写受控身份再提交；提交失败时该 ID 不匹配任何 owner，后续仍失败关闭，绝不猜选。
      await this.persist({ NOTALONE_OWNER_ID: owner });
      return { owner_id: owner, created: true };
    });
  }
  async recoverOwner(): Promise<{ owner_id: string; created: false }> {
    return this.withClient(true, async client => {
      await this.requireReady(client);
      await client.query('LOCK TABLE public.owner IN SHARE ROW EXCLUSIVE MODE');
      const owners = (await client.query('SELECT id FROM public.owner LIMIT 2')).rows;
      if (owners.length !== 1) throw new HostStorageError('owner_recovery_ambiguous');
      if (this.runtimeOwnerId && this.runtimeOwnerId !== owners[0].id) throw new HostStorageError('owner_recovery_conflict');
      await this.persist({ NOTALONE_OWNER_ID: owners[0].id });
      return { owner_id: owners[0].id, created: false };
    });
  }
  async writeCredentials(apiKey: string): Promise<{ provider: string; configured: true; restart_required: true }> {
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new HostStorageError('setup_request_invalid');
    this.assertModelConfigurationWritable({ NOTALONE_DEEPSEEK_API_KEY: apiKey.trim() });
    await this.withClient(true, async client => {
      await this.requireReady(client);
      await this.persist({ NOTALONE_DEEPSEEK_API_KEY: apiKey.trim() });
    });
    return { provider: 'deepseek', configured: true, restart_required: true };
  }
  async useOfficialDeepseek(apiKey: string): Promise<{ provider: string; configured: true; official_deepseek_defaults: true; restart_required: true }> {
    if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(apiKey)) throw new HostStorageError('setup_request_invalid');
    this.assertModelConfigurationWritable({ NOTALONE_DEEPSEEK_API_KEY: apiKey, NOTALONE_DEEPSEEK_MODEL: 'deepseek-flash', NOTALONE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com' });
    await this.withClient(true, async client => {
      await this.requireReady(client);
      await this.persist({ NOTALONE_DEEPSEEK_API_KEY: apiKey, NOTALONE_DEEPSEEK_MODEL: 'deepseek-flash', NOTALONE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com' });
    });
    return { provider: 'deepseek', configured: true, official_deepseek_defaults: true, restart_required: true };
  }
  /** 已认证业务复用原连接；事务收尾仍受宿主关闭屏障约束。 */
  async businessTransaction<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
    return this.withClient(true, async client => { await this.requireReady(client); return operation(client); }, true);
  }
  /** 固定快照的业务读取；由数据库拒绝写入，沿用结构核验及关闭屏障。 */
  async businessReadTransaction<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
    return this.withClient(false, async client => { await this.requireReady(client); return operation(client); }, true);
  }
  /** 供共享任务存储复用同一受控连接配置；调用方负责关闭。 */
  async businessPool(): Promise<pg.Pool> {
    this.assertOpen();
    if (!this.databaseUrl) throw new HostStorageError('database_unconfigured');
    const configuration = await connectionOptions(this.databaseUrl, this.values);
    return new pg.Pool(configuration.options);
  }
  private endBusinessConnection(connection: OwnedBusinessConnection): Promise<void> {
    if (this.idleBusinessConnection === connection) this.idleBusinessConnection = undefined;
    clearTimeout(connection.timer);
    connection.client.removeListener('error', connection.lost);
    connection.client.removeListener('end', connection.lost);
    if (!connection.closing) {
      // 空闲socket已unref；关闭屏障必须重新持有它，等待PG真正断开后才能完成。
      connection.client.ref();
      const closing = Promise.resolve().then(connection.end).catch(() => {}).finally(() => this.connectionClosings.delete(closing));
      connection.closing = closing;
      this.connectionClosings.add(closing);
    }
    return connection.closing;
  }
  private async acquireBusinessConnection(configuration: DatabaseConnection): Promise<OwnedBusinessConnection> {
    // 每次调用受控provider；不以函数或文件路径代替当前认证值，也不让pg回退全局PGPASSWORD。
    const provider = configuration.options.password;
    const password = typeof provider === 'function' ? await provider() : provider ?? '';
    const bound = { ...configuration, options: { ...configuration.options, password: async () => password } };
    const key = createHash('sha256').update(JSON.stringify({ options: { ...configuration.options, password },
      url: this.databaseUrl, password: this.values.PGPASSWORD, passfile: this.values.PGPASSFILE, home: this.values.HOME })).digest('hex');
    const idle = this.idleBusinessConnection;
    if (idle) {
      this.idleBusinessConnection = undefined;
      clearTimeout(idle.timer);
      if (idle.key === key && !idle.unavailable && performance.now() - idle.created < 5000) { idle.client.ref(); return idle; }
      await this.endBusinessConnection(idle);
    }
    const client = await connectConfigured(bound) as OwnedBusinessConnection['client'];
    if (typeof client.ref !== 'function' || typeof client.unref !== 'function') {
      await client.end().catch(() => {}); throw new HostStorageError('database_unavailable');
    }
    const connection: OwnedBusinessConnection = { client, key, created: performance.now(), unavailable: false,
      lost: () => {}, end: client.end.bind(client) };
    connection.lost = () => {
      connection.unavailable = true;
      if (this.idleBusinessConnection === connection) void this.endBusinessConnection(connection);
    };
    client.on('error', connection.lost);
    client.once('end', connection.lost);
    return connection;
  }
  private async releaseBusinessConnection(connection: OwnedBusinessConnection, reusable: boolean): Promise<void> {
    if (reusable && !this.closed && !connection.unavailable && !this.idleBusinessConnection && performance.now() - connection.created < 5000) {
      try {
        await connection.client.query('DISCARD ALL');
        if (!this.closed && !connection.unavailable && !this.idleBusinessConnection) {
          this.idleBusinessConnection = connection;
          connection.client.unref();
          connection.timer = setTimeout(() => { void this.endBusinessConnection(connection); }, Math.min(1000, 5000 - (performance.now() - connection.created)));
          connection.timer.unref();
          return;
        }
      } catch { connection.unavailable = true; }
    }
    await this.endBusinessConnection(connection);
  }
  private async withClient<T>(write: boolean, operation: (client: pg.Client) => Promise<T>, business = false): Promise<T> {
    this.assertOpen();
    if (!this.databaseUrl) throw new HostStorageError('database_unconfigured');
    let client: pg.Client | undefined;
    let connection: OwnedBusinessConnection | undefined, lease: ReturnType<typeof businessLease> | undefined;
    let stopObserving: (() => void) | undefined, committed = false;
    let businessFailure = false;
    const queryFailures = new Set<unknown>();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    this.pending.add(pending);
    try {
      const configuration = await connectionOptions(this.databaseUrl, this.values);
      // 仅复用本机Unix socket；TCP、TLS、hostaddr及降级仍逐次经过原连接流程。
      if (business && String(configuration.options.host).startsWith('/') && !configuration.options.ssl) {
        connection = await this.acquireBusinessConnection(configuration);
        client = connection.client;
        lease = businessLease(client);
      } else client = await connectConfigured(configuration);
      if (business) stopObserving = trackQueryFailures(client, queryFailures);
      this.assertOpen();
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL search_path = pg_catalog, public");
      await client.query("SET LOCAL statement_timeout = '3000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      if (write && !business && !(await client.query('SELECT pg_try_advisory_xact_lock(1852798049,1) AS locked')).rows[0].locked) throw new HostStorageError('migration_busy');
      let result: T;
      try { result = await operation(lease?.client ?? client); }
      catch (error) { businessFailure = business; throw error; }
      finally { lease?.revoke(); }
      this.assertOpen();
      // PostgreSQL 会将已中止事务的 COMMIT 转成 ROLLBACK，不能向调用方报告提交成功。
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw new HostStorageError('database_unavailable');
      committed = true;
      return result;
    } catch (error) {
      const rolledBack = await client?.query('ROLLBACK').then(() => true, () => false);
      if (error instanceof HostStorageError) throw error;
      // 仅把已回滚的业务回调异常交还上层；SQL 和连接／事务故障仍不暴露驱动细节。
      // 公开 HTTP 继续按各自领域类型筛选错误，未知异常不能直接成为响应正文。
      if (businessFailure && rolledBack && !queryFailures.has(error) && !(error instanceof pg.DatabaseError)) throw error;
      throw new HostStorageError('database_unavailable');
    } finally {
      lease?.revoke();
      stopObserving?.();
      try {
        if (connection) await this.releaseBusinessConnection(connection, committed && !queryFailures.size && Boolean(lease?.reusable()));
        else await client?.end().catch(() => {});
      } finally { lease?.cleanupListeners(); this.pending.delete(pending); finish(); }
    }
  }
  private async requireReady(client: pg.Client): Promise<void> {
    const code = await this.inspect(client);
    if (code !== 'ready') throw new HostStorageError(code);
  }
  /** 只复用当前真实文件身份仍相同的内容摘要；目录、每个路径和高精度时间逐次重验。 */
  private migrationFiles(): { name: string; checksum: string }[] {
    const directory = realpathSync(this.options.migrationsDirectory);
    const directoryIdentity = fileIdentity(directory, lstatSync(directory, { bigint: true }));
    const names = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    if (names.length !== EXPECTED_MIGRATION_COUNT || names.some((name, i) => !new RegExp(`^${String(i + 1).padStart(3, '0')}_[a-z0-9_]+\\.sql$`).test(name))) throw new HostStorageError('migration_files_invalid');
    const next = new Map<string, { identity: string; checksum: string }>();
    const migrations = names.map(name => {
      const path = join(directory, name), metadata = lstatSync(path, { bigint: true });
      if (!metadata.isFile()) throw new HostStorageError('migration_files_invalid');
      const identity = fileIdentity(path, metadata), previous = this.migrationSummaries.get(name);
      let checksum = previous?.identity === identity ? previous.checksum : undefined;
      if (!checksum) {
        const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (fileIdentity(path, fstatSync(file, { bigint: true })) !== identity) throw new HostStorageError('migration_files_invalid');
          checksum = createHash('sha256').update(readFileSync(file)).digest('hex');
          if (fileIdentity(path, fstatSync(file, { bigint: true })) !== identity) throw new HostStorageError('migration_files_invalid');
          if (fileIdentity(path, lstatSync(path, { bigint: true })) !== identity) throw new HostStorageError('migration_files_invalid');
        } finally { closeSync(file); }
      }
      next.set(name, { identity, checksum });
      return { name, checksum };
    });
    // 防止本轮读取期间目录被替换；不依赖 watcher 或可恢复的 mtime。
    if (realpathSync(this.options.migrationsDirectory) !== directory || fileIdentity(directory, lstatSync(directory, { bigint: true })) !== directoryIdentity) throw new HostStorageError('migration_files_invalid');
    this.migrationSummaries = next;
    return migrations;
  }
  private async inspect(client: pg.Client): Promise<string> {
    // 仍取当前真实catalog；只传回原判定实际使用的字段，必需表的非零可见列条件不变。
    const metadataPending = client.query(`WITH catalog_rows AS (
        SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS kind
        FROM unnest($1::text[],$2::text[]) AS required(relname,attname)
        JOIN pg_catalog.pg_class c ON c.relname=required.relname
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=required.attname AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND EXISTS(
          SELECT 1 FROM pg_catalog.pg_attribute visible WHERE visible.attrelid=c.oid AND visible.attnum>0 AND NOT visible.attisdropped)
      ), checked_tables AS (
        SELECT c.oid,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND c.relname IN ('model_call_receipt','model_call_learning_claim','background_task_step')
      ) SELECT
        COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM catalog_rows r),'[]'::jsonb) AS catalog,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('table',t.relname,'attname',a.attname,'attnotnull',a.attnotnull))
          FROM checked_tables t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
          WHERE t.relname IN ('model_call_receipt','model_call_learning_claim') AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) AS columns,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('table',t.relname,'contype',c.contype,
          'convalidated',c.convalidated,'condeferrable',c.condeferrable,'condeferred',c.condeferred,
          'definition',pg_catalog.pg_get_constraintdef(c.oid),'indisvalid',i.indisvalid,'indisready',i.indisready))
          FROM checked_tables t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid
          LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid),'[]'::jsonb) AS constraints`,
      [CATALOG_SELECTORS.map(item => item.table), CATALOG_SELECTORS.map(item => item.column)]);
    let migrations: { name: string; checksum: string }[];
    try { migrations = this.migrationFiles(); }
    catch { this.migrationSummaries.clear(); await metadataPending.catch(() => {}); return 'migration_files_invalid'; }
    const snapshot = (await metadataPending).rows[0] as SchemaInspection;
    const tables = new Map<string, Map<string,string>>();
    for (const row of snapshot.catalog) {
      if (!tables.has(row.relname)) tables.set(row.relname, new Map());
      if (row.attname !== null) tables.get(row.relname)!.set(row.attname, row.kind);
    }
    const ledger = tables.get('notalone_schema_migration');
    if (!ledger) {
      const existing = await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')) AS present");
      return existing.rows[0].present ? 'baseline_missing' : 'migration_pending';
    }
    if (ledger.get('name') !== 'text' || ledger.get('checksum') !== 'text') return 'schema_incomplete';
    let offset = 0;
    const baselineObject = await client.query("SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='notalone_schema_baseline'");
    if (baselineObject.rowCount) {
      const baseline = tables.get('notalone_schema_baseline');
      const required = {format_version:'integer',through_version:'integer',manifest:'jsonb',backup_sha256:'text',restore_verified_at:'timestamp with time zone'};
      if (baselineObject.rows[0].relkind !== 'r' || Object.entries(required).some(([key,kind]) => baseline?.get(key) !== kind)) return 'baseline_invalid';
      const rows = (await client.query('SELECT format_version,through_version,manifest,backup_sha256,restore_verified_at FROM public.notalone_schema_baseline')).rows;
      if (rows.length !== 1 || rows[0].format_version !== 1 || rows[0].through_version !== 35 || !rows[0].backup_sha256 || !rows[0].restore_verified_at) return 'baseline_invalid';
      if (migrations.slice(0,35).some((item,i) => item.checksum !== BASELINE_CHECKSUMS[i])) return 'migration_history_mismatch';
      const manifest = rows[0].manifest;
      if (!Array.isArray(manifest) || manifest.length !== 35 || manifest.some((item,i) => !item || item.name !== migrations[i].name || item.checksum !== migrations[i].checksum || Object.keys(item).length !== 2)) return 'baseline_invalid';
      offset = 35;
    }
    const completed = (await client.query('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name')).rows;
    if (completed.length + offset > EXPECTED_MIGRATION_COUNT || completed.some((item,i) => item.name !== migrations[i+offset].name || item.checksum !== migrations[i+offset].checksum)) return 'migration_history_mismatch';
    if (completed.length + offset !== EXPECTED_MIGRATION_COUNT) return 'migration_pending';
    if (REQUIRED_TABLES.some(table => !tables.has(table)) || Object.entries(REQUIRED_COLUMNS).some(([table,columns]) => Object.entries(columns).some(([column,kind]) => tables.get(table)?.get(column) !== kind))) return 'schema_incomplete';
    if (!receiptSchemaReady(snapshot) || !learningClaimSchemaReady(snapshot)) return 'schema_incomplete';
    return 'ready';
  }
  private async persist(values: Record<string, string>): Promise<void> {
    const path = this.options.envFilePath;
    let temporary: string | undefined;
    try {
      await mkdir(dirname(path), {recursive:true, mode:0o700});
      const existing = await readConfiguration(path);
      const lines = existing.split(/\r?\n/).filter(line => { const entry = parseLine(line); return !entry || !(entry[0] in values); });
      while (lines.at(-1) === '') lines.pop();
      const output = [...lines, ...Object.entries(values).map(([key,value]) => `${key}=${value.startsWith('"') || value.startsWith("'") ? `"${value}"` : value}`), ''].join('\n');
      temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      const file = await open(temporary, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(output); await file.sync(); } finally { await file.close(); }
      this.assertOpen();
      await rename(temporary, path);
      // 模型装配持有启动时快照；磁盘保存与当前进程采用配置是两个事实。
      if (MODEL_CONFIGURATION_KEYS.some(key => key in values)) this.configurationPending = true;
      Object.assign(this.values, values);
    } catch (error) { if (error instanceof HostStorageError) throw error; throw new HostStorageError('configuration_write_failed'); }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }

  async close(): Promise<void> {
    this.closed = true; this.migrationSummaries.clear();
    if (this.idleBusinessConnection) await this.endBusinessConnection(this.idleBusinessConnection);
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.connectionClosings]);
  }
}

const BASELINE_CHECKSUMS = [
  "266aa314034ddc6a90835431c6ceaf6a129db8dab413e5ef03ee0e1211981ced",
  "ab15a9bd53a1cc9f882f926d146dd23c9f6295e16c12e3821ad56fbc67e80ad3",
  "667a77caf86520798f1ee7c3f33060e7b516c98206c7c707edc39bf73bfcab84",
  "f8627956db97c23588840b8320f1ad236d4e9d4e10309cd934f6f0beff65ca0e",
  "78477ac6f7698339a21e6ba988c56b497c9712d91046f8a05447e8d635f39877",
  "ffc713db0b396047c6ba7784b834797e9d76010f4710aa01335d71ba62d1bc80",
  "d499b548fef5447bbf879cc835a83af1dd002fb2fc2f4762d3788d00923b30f2",
  "899794e2f597c03abd6c6ae886e6f4fc6cf27779cfbaaf9b78a09392a5be01f9",
  "9f06a927cd91bf08bc6bc869fcbe10c994699c2f15e0bee37a55607ac88af134",
  "d2cc7a2f4e28869dde82ec9af8e6a99b20dae0eeac79b6c82660c4b4504e443a",
  "b6625e31e7e0c8dde5c1ccc2ee2cd0542bc0c160d7149b4f2538ba047b7e3c2b",
  "a89b89ff270ad3760930ac022621915eeddc3cc591203b1734ed9a1bd9bf65a6",
  "4efaa08c7827ec1ab732695c2d2e27579e47557c153e79dd62641b496c6dc262",
  "b432b44299e62f7f654e0ae4f81359477b95e3e6914390934a0090e80aad16ba",
  "bd80538f71568d4a1136509159be5ec4715d45311fc6268212bd5ff1b29daecb",
  "149848b261c3dc142341916e1055517d505386cc3eee29683a72004054886e9e",
  "7066bcf16638124d08dc1bf8748768a1df7fb5eb69f4e7c46646b4fcb830ee9e",
  "fc3107c0dc9d790bb0a27d3302ee9aa705e862928488ea91395bf5055496d363",
  "0020c3817520bc06bc20dd1e1d5f0ec7c2fa1e6d7859f16fd1abcc41360f7249",
  "acfbfbbcc323e1d1e45cc12a05b63bc95a914abda0f84b6d6f9bc87d068ab8bb",
  "31ed56a17f363d29a9f4f29ed107930567dc99fab52e31b40cc9dcef25abc37e",
  "a4457c7bc998b817fef8a0d44c296490a15df007562343477bf495306507edb0",
  "1c12e16e68952080078ec0f6fc31c4a07c743fe1f5ed157d1ab5ce61101015a8",
  "1299bfb6ab64fd6b78eefecb908e6c526f634a8dabc95fbcb63cf207a10233ac",
  "4b3e3cd06f8944bb48696075e9d0b0cb39a0bf5adc4c38efed4fc463731490c4",
  "23d6fdbf1ac8b153c3e5911c2c1743e36606b4b4dc02fe11a7d6c43ce2858934",
  "50067e0280bd005722f4486374880d38d6922d8087b5f0eb39861cd103a5ef4e",
  "3eb47e59ade749f730459146b94dd52e93f23f07b8c76f41a524a0c15cbb7c88",
  "dbf920f0d4dd4ac551c4593c9bdaac1fb8e0c5891695be63312c756d4b853db0",
  "918ab49b1ccf9ca8a2fec23f3dddad297726dfda94ec78ae46e463ad4f149bb9",
  "187addae01a9c5c8bd0d4a5294f07e76a07d535b63d2d407e7911d9960d37184",
  "c8c7073308c66135abadf59d899055eadb44c0e82b12e19a4871d4b1f99f5964",
  "dced994989341ccba424bddc68889415d6810e4c86be7ed68b46a16b885ee672",
  "a78d5bde2c9bc07c8681acf6d6f6512b40895b2fdedc3b3ed87f54dbea40381b",
  "866aac5fc8e0bbfb3ad61315b3fef290587f760289ed1af95bc4a9867238b974",
  "8a4c92028b633d98d27510a881d832839c4d1003a308878407dff95542cffdda",
  "1f4db1f82b184fc0b652654a938bb46fd39d0c4095d4bfcaa9baca1ab0d687ef",
  "8ebe960bfeff864dbbecf26240ab3cbd19dd51b77d0920b795aeffe1406f6506",
];
const REQUIRED_TABLES = [
  "assistant_runtime_session",
  "assistant_runtime_deletion_target",
  "background_task",
  "background_task_step",
  "channel_identity",
  "cli_backfill_state",
  "confirmed_memory",
  "contact",
  "contact_memory_index",
  "contact_memory_state",
  "conversation_binding",
  "cross_domain_deletion_operation",
  "front_sync_state",
  "import_confirmation",
  "local_wechat_observation",
  "manual_contact_confirmation",
  "memory_candidate",
  "memory_extraction_watermark",
  "message",
  "message_source_ref",
  "model_call_learning_claim",
  "model_call_receipt",
  "outbound_ledger_entry",
  "owner",
  "owner_channel_identity",
  "owner_memory",
  "reply_attempt",
  "reply_candidate",
  "reply_candidate_citation",
  "reply_context_evidence",
  "reply_request",
  "reply_skill",
  "reply_skill_version",
  "skill_library",
  "source_document",
  "wechat_auto_read_suppression",
  "wechat_binding_history_authorization",
  "wechat_message_metadata",
  "wechat_observation_baseline",
  "wechat_observation_cursor"
];
const REQUIRED_COLUMNS: Record<string, Record<string,string>> = {
  "assistant_runtime_deletion_target": {"operation_id":"uuid","owner_id":"uuid","contact_id":"uuid","session_id":"uuid","cleaned":"boolean","directory_identity":"jsonb"},
  "model_call_learning_claim": {
      "attempt_id": "uuid",
      "owner_id": "uuid",
      "contact_id": "uuid",
      "request_id": "uuid",
      "task_id": "uuid",
      "step_id": "uuid",
      "worker_id": "uuid",
      "step_name": "text",
      "lease_generation": "bigint"
  },
  "model_call_receipt": {
      "attempt_id": "uuid",
      "owner_id": "uuid",
      "contact_id": "uuid",
      "scope_kind": "text",
      "request_id": "uuid",
      "permit_id": "uuid",
      "ledger_entry_id": "uuid",
      "provider": "text",
      "model_name": "text",
      "called_at": "timestamp with time zone",
      "input_budget": "jsonb",
      "latency_ms": "integer",
      "dispatch": "text",
      "outcome": "text",
      "input_tokens": "integer",
      "output_tokens": "integer",
      "cache_read_tokens": "integer",
      "cache_write_tokens": "integer",
      "cost_status": "text",
      "cost_amount": "numeric",
      "currency": "text",
      "pricing_version": "text",
      "created_at": "timestamp with time zone",
      "updated_at": "timestamp with time zone"
  },
  "wechat_auto_read_suppression": {
    "owner_id": "uuid",
    "contact_id": "uuid",
    "external_local_id": "bigint",
    "identity_create_time": "bigint",
    "deleted_at": "timestamp with time zone"
  },
  "wechat_binding_history_authorization": {
    "owner_id": "uuid",
    "contact_id": "uuid",
    "binding_id": "uuid",
    "version": "integer",
    "authorized_at": "timestamp with time zone"
  },
  "owner": {
    "id": "uuid",
    "display_name": "text",
    "created_at": "timestamp with time zone"
  },
  "contact": {
    "id": "uuid",
    "owner_id": "uuid",
    "display_name": "text"
  },
  "manual_contact_confirmation": {
    "id": "uuid",
    "owner_id": "uuid",
    "contact_id": "uuid",
    "confirmed_at": "timestamp with time zone"
  },
  "message": {
    "id": "uuid",
    "owner_id": "uuid",
    "contact_id": "uuid",
    "text_content": "text"
  },
  "source_document": {
    "id": "uuid",
    "owner_id": "uuid",
    "contact_id": "uuid",
    "status": "text"
  },
  "conversation_binding": {
    "id": "uuid",
    "owner_id": "uuid",
    "contact_id": "uuid",
    "status": "text"
  },
  "background_task": {
    "id": "uuid",
    "owner_id": "uuid",
    "task_type": "text",
    "status": "text"
  },
  "background_task_step": {
    "task_id": "uuid",
    "status": "text",
    "worker_id": "uuid"
  },
  "confirmed_memory": {
    "id": "uuid",
    "owner_id": "uuid",
    "contact_id": "uuid"
  },
  "owner_memory": {
    "id": "uuid",
    "owner_id": "uuid"
  }
};

const CATALOG_SELECTORS = Object.entries({
  ...Object.fromEntries(REQUIRED_TABLES.map(table => [table, [] as string[]])),
  ...Object.fromEntries(Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => [table, Object.keys(columns)])),
  notalone_schema_migration: ['name', 'checksum'],
  notalone_schema_baseline: ['format_version', 'through_version', 'manifest', 'backup_sha256', 'restore_verified_at'],
}).flatMap(([table, columns]) => (columns.length ? columns : [null]).map(column => ({ table, column })));

interface DatabaseConnection { options: pg.ClientConfig; allowPlaintextFallback: boolean; upgradeToTls?: () => Promise<boolean | ConnectionOptions> }
const PG_PARAMETERS: Record<string,string> = {
  host:'PGHOST',hostaddr:'PGHOSTADDR',port:'PGPORT',dbname:'PGDATABASE',user:'PGUSER',password:'PGPASSWORD',
  passfile:'PGPASSFILE',sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',
  connect_timeout:'PGCONNECT_TIMEOUT',application_name:'PGAPPNAME',options:'PGOPTIONS',client_encoding:'PGCLIENTENCODING',
};
function invalidConnection(): never { throw new HostStorageError('database_configuration_invalid'); }
export function connectionFields(value: string): Record<string,string> {
  const fields: Record<string,string> = {};
  if (/^postgres(?:ql)?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      if (url.hash) invalidConnection();
      const parts = {host:decodeURIComponent(url.hostname.replace(/^\[|\]$/g,'')),port:url.port,
        user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),dbname:decodeURIComponent(url.pathname.slice(1))};
      for (const [key,part] of Object.entries(parts)) if (part) fields[key] = part;
      for (const [key,part] of url.searchParams) fields[key] = part;
    } catch { invalidConnection(); }
  } else {
    let rest = value.trim();
    while (rest) {
      const match = /^([a-z_]+)\s*=\s*('(?:[^'\\]|\\.)*'|(?:[^\s\\]|\\.)*)(?:\s+|$)/.exec(rest);
      if (!match) invalidConnection();
      const raw = match[2];
      fields[match[1]] = (raw.startsWith("'") ? raw.slice(1,-1) : raw).replace(/\\(.)/g,'$1');
      rest = rest.slice(match[0].length).trimStart();
    }
  }
  if (Object.keys(fields).some(key => !(key in PG_PARAMETERS))) invalidConnection();
  return fields;
}
async function optionalTlsFile(explicit: string | undefined, fallback: string | undefined): Promise<string | undefined> {
  const file = explicit || fallback;
  if (!file) return undefined;
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (!explicit && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; invalidConnection(); }
}
/** 按官方pgpass格式读取业务路径；不调用依赖内读取全局环境和输出路径警告的入口。 */
async function passwordFromFile(fields: Record<string,string>, environment: Record<string,string|undefined>, user: string, database: string, port: string): Promise<string | undefined> {
  const filePath = fields.passfile || (environment.HOME ? join(environment.HOME,'.pgpass') : undefined);
  if (!filePath) return undefined;
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await file.stat();
    // libpq在权限过宽时忽略整个文件，而不是忽略单行或回退另一个密码文件。
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) return undefined;
    const host = fields.host ? fields.host === '/tmp' ? 'localhost' : fields.host : fields.hostaddr || 'localhost';
    for (const line of (await file.readFile('utf8')).split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const values = [''];
      for (let index=0;index<line.length;index++) {
        const character = line[index];
        if (character === '\\' && [':','\\'].includes(line[index+1])) values[values.length-1] += line[++index];
        else if (character === ':' && values.length < 5) values.push('');
        else values[values.length-1] += character;
      }
      if (values.length !== 5) continue;
      if ([host,port,database,user].every((value,index)=>values[index] === '*' || values[index] === value)) return values[4];
    }
    return undefined;
  } catch { return undefined; }
  finally { await file?.close(); }
}
/** 与libpq一样先取连接串，再取受控PG环境；不把缺省值交给pg读取DSH全局环境。 */
export async function connectionOptions(value: string, environment: Record<string, string | undefined>): Promise<DatabaseConnection> {
  const explicit = connectionFields(value);
  if (['PGSERVICE','PGSERVICEFILE','PGTARGETSESSIONATTRS','PGLOADBALANCEHOSTS','PGSSLPASSWORD',
    'PGSSLCRL','PGSSLCRLDIR','PGSSLNEGOTIATION','PGCHANNELBINDING','PGGSSENCMODE','PGREPLICATION'].some(key => environment[key])) invalidConnection();
  const fields = Object.fromEntries(Object.entries(PG_PARAMETERS).map(([key,env]) => [key,explicit[key] || environment[env] || '']));
  const host = fields.host || '/tmp';
  const hostaddr = fields.hostaddr;
  if (host.includes(',') || fields.port.includes(',') || hostaddr && !isIP(hostaddr)) invalidConnection();
  const endpoint = hostaddr || host;
  const port = fields.port || '5432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) invalidConnection();
  if (fields.connect_timeout && !/^\d+$/.test(fields.connect_timeout)) invalidConnection();
  const user = fields.user || userInfo().username;
  const database = fields.dbname || user;
  const sslmode = fields.sslmode || 'prefer';
  if (!['disable','allow','prefer','require','verify-ca','verify-full'].includes(sslmode)) invalidConnection();
  const socket = endpoint.startsWith('/');
  const tlsOptions = async (): Promise<boolean | ConnectionOptions> => {
    if (socket || sslmode === 'disable') return false;
    let ssl: ConnectionOptions;
    const home = environment.HOME;
    const ca = await optionalTlsFile(fields.sslrootcert, home && join(home,'.postgresql/root.crt'));
    const cert = await optionalTlsFile(fields.sslcert, home && join(home,'.postgresql/postgresql.crt'));
    const key = cert ? await optionalTlsFile(fields.sslkey, home && join(home,'.postgresql/postgresql.key')) : undefined;
    if (cert && !key || ['verify-ca','verify-full'].includes(sslmode) && !ca) invalidConnection();
    ssl = {rejectUnauthorized:Boolean(ca), ...(ca ? {ca} : {}), ...(cert ? {cert,key} : {})};
    if (ca && sslmode !== 'verify-full') ssl.checkServerIdentity = () => undefined;
    if (hostaddr && fields.host && !host.startsWith('/')) ssl.servername = host;
    if (hostaddr && !fields.host && sslmode === 'verify-full') invalidConnection();
    return ssl;
  };
  const ssl = sslmode === 'allow' ? false : await tlsOptions();
  return {options:{host:endpoint,port:Number(port),user,database,
    // 密码函数阻止驱动重新读取全局PGPASSWORD或临时HOME的.pgpass。
    password:async () => fields.password || await passwordFromFile(fields,environment,user,database,port) || '', ssl, connectionTimeoutMillis:3000,
    application_name:fields.application_name || 'notalone_ts_host',options:fields.options || ' ',
    client_encoding:fields.client_encoding || 'UTF8'},allowPlaintextFallback:!socket && sslmode==='prefer',upgradeToTls:!socket && sslmode==='allow' ? tlsOptions : undefined};
}
export async function connectConfigured(configuration: DatabaseConnection): Promise<pg.Client> {
  const connect = async (options: pg.ClientConfig): Promise<pg.Client> => {
    const client = new pg.Client(options);client.on('error',()=>{});
    try {await client.connect();return client;}
    catch(error){await client.end().catch(()=>{});throw error;}
  };
  try {return await connect(configuration.options);}
  catch(error) {
    // allow只在初次连接失败后升级TLS；连接尚未就绪，因此不会重放业务SQL。
    if(configuration.upgradeToTls) return connect({...configuration.options,ssl:await configuration.upgradeToTls()});
    // 仅支持官方驱动明确收到PG的N响应；认证、证书及网络失败绝不降级。
    if(configuration.allowPlaintextFallback && error instanceof Error && error.message==='The server does not support SSL connections') {
      return connect({...configuration.options,ssl:false});
    }
    throw error;
  }
}

/** 110窄表的PG16约束契约；来自冻结迁移，防止同列同类型但删除/未知用量约束缺失。 */
interface SchemaInspection {
  catalog: pg.QueryResult['rows'];
  columns: pg.QueryResult['rows'];
  constraints: pg.QueryResult['rows'];
}
function receiptSchemaReady(snapshot: SchemaInspection): boolean {
  return constrainedModelTableReady(snapshot,'model_call_receipt',RECEIPT_CONSTRAINTS,RECEIPT_NOT_NULL);
}
/** 只核对110/111模型元数据表及112调用用途约束；不扩展为通用schema迁移器。 */
function constrainedModelTableReady(snapshot: SchemaInspection,
    table:'model_call_receipt'|'model_call_learning_claim'|'background_task_step',
    expected:readonly string[],notNull?:ReadonlySet<string>):boolean {
  if(notNull){
    const columns=snapshot.columns.filter(row=>row.table===table);
    if(columns.some(row=>row.attnotnull!==notNull.has(row.attname)))return false;
  }
  const constraints=snapshot.constraints.filter(row=>row.table===table);
  const selected=table==='background_task_step'?constraints.filter(row=>expected.includes(`${row.contype}:${row.definition}`)):constraints;
  if(selected.some(row=>!row.convalidated||row.condeferrable||row.condeferred||
    (['p','u'].includes(row.contype)&&(!row.indisvalid||!row.indisready))))return false;
  const actual=selected.map(row=>`${row.contype}:${row.definition}`).sort();
  return actual.length===expected.length&&actual.every((item,index)=>item===expected[index]);
}
function learningClaimSchemaReady(snapshot: SchemaInspection):boolean {
  return constrainedModelTableReady(snapshot,'model_call_learning_claim',LEARNING_CLAIM_CONSTRAINTS,
    new Set(['attempt_id','owner_id','contact_id','request_id','task_id','step_id','step_name','worker_id','lease_generation']))
    && constrainedModelTableReady(snapshot,'background_task_step',['u:UNIQUE (id, task_id)']);
}
const LEARNING_CLAIM_CONSTRAINTS=[
  "c:CHECK ((lease_generation > 0))",
  "c:CHECK ((step_name = 'propose_skill'::text))",
  "f:FOREIGN KEY (attempt_id, owner_id, contact_id, request_id) REFERENCES model_call_receipt(attempt_id, owner_id, contact_id, request_id) ON DELETE CASCADE",
  "f:FOREIGN KEY (step_id, task_id) REFERENCES background_task_step(id, task_id) ON DELETE CASCADE",
  "f:FOREIGN KEY (task_id, owner_id, contact_id) REFERENCES background_task(id, owner_id, contact_id) ON DELETE CASCADE",
  "p:PRIMARY KEY (attempt_id)",
  "u:UNIQUE (step_id, lease_generation)"
];

const RECEIPT_NOT_NULL = new Set(['attempt_id','owner_id','scope_kind','request_id','permit_id',
  'provider','model_name','called_at','dispatch','outcome','cost_status','created_at','updated_at']);
const RECEIPT_CONSTRAINTS = [
  "c:CHECK ((((cost_status = 'unknown'::text) AND (cost_amount IS NULL) AND (currency IS NULL) AND (pricing_version IS NULL)) OR ((cost_status = ANY (ARRAY['estimated'::text, 'known'::text])) AND (cost_amount IS NOT NULL) AND (currency IS NOT NULL) AND (pricing_version IS NOT NULL) AND (length(btrim(currency)) > 0) AND (length(btrim(pricing_version)) > 0))))",
  "c:CHECK ((((scope_kind = 'contact'::text) AND (contact_id IS NOT NULL)) OR ((scope_kind = 'owner_memory'::text) AND (contact_id IS NULL) AND (ledger_entry_id IS NULL))))",
  "c:CHECK (((COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)) <= input_tokens))",
  "c:CHECK (((input_budget IS NULL) OR (((jsonb_typeof(input_budget) = 'object'::text) AND (input_budget ?& ARRAY['measurement_id'::text, 'measurement_kind'::text, 'input_tokens'::text, 'max_output_tokens'::text, 'context_window_tokens'::text, 'safety_margin_tokens'::text, 'request_sha256'::text, 'serialized_bytes'::text]) AND ((input_budget - ARRAY['measurement_id'::text, 'measurement_kind'::text, 'input_tokens'::text, 'max_output_tokens'::text, 'context_window_tokens'::text, 'safety_margin_tokens'::text, 'request_sha256'::text, 'serialized_bytes'::text]) = '{}'::jsonb) AND (jsonb_typeof((input_budget -> 'measurement_id'::text)) = 'string'::text) AND ((input_budget ->> 'measurement_id'::text) ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'::text) AND ((input_budget ->> 'measurement_kind'::text) = 'approximate'::text) AND ((input_budget ->> 'request_sha256'::text) ~ '^[a-f0-9]{64}$'::text) AND (jsonb_typeof((input_budget -> 'input_tokens'::text)) = 'number'::text) AND ((input_budget ->> 'input_tokens'::text) ~ '^[1-9][0-9]*$'::text) AND (jsonb_typeof((input_budget -> 'max_output_tokens'::text)) = 'number'::text) AND ((input_budget ->> 'max_output_tokens'::text) ~ '^[1-9][0-9]*$'::text) AND (jsonb_typeof((input_budget -> 'context_window_tokens'::text)) = 'number'::text) AND ((input_budget ->> 'context_window_tokens'::text) ~ '^[1-9][0-9]*$'::text) AND (jsonb_typeof((input_budget -> 'safety_margin_tokens'::text)) = 'number'::text) AND ((input_budget ->> 'safety_margin_tokens'::text) ~ '^[1-9][0-9]*$'::text) AND (jsonb_typeof((input_budget -> 'serialized_bytes'::text)) = 'number'::text) AND ((input_budget ->> 'serialized_bytes'::text) ~ '^[1-9][0-9]*$'::text)) IS TRUE)))",
  "c:CHECK (((input_tokens IS NOT NULL) OR ((cache_read_tokens IS NULL) AND (cache_write_tokens IS NULL))))",
  "c:CHECK (((input_tokens IS NULL) = (output_tokens IS NULL)))",
  "c:CHECK (((outcome <> 'succeeded'::text) OR (dispatch = ANY (ARRAY['response_observed'::text, 'http_accepted'::text]))))",
  "c:CHECK ((cache_read_tokens >= 0))",
  "c:CHECK ((cache_write_tokens >= 0))",
  "c:CHECK ((cost_amount >= (0)::numeric))",
  "c:CHECK ((cost_status = ANY (ARRAY['unknown'::text, 'estimated'::text, 'known'::text])))",
  "c:CHECK ((dispatch = ANY (ARRAY['authorized_unconfirmed'::text, 'response_observed'::text, 'http_accepted'::text, 'not_sent'::text])))",
  "c:CHECK ((input_tokens >= 0))",
  "c:CHECK ((latency_ms >= 0))",
  "c:CHECK ((length(btrim(model_name)) > 0))",
  "c:CHECK ((length(btrim(provider)) > 0))",
  "c:CHECK ((outcome = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'unknown'::text])))",
  "c:CHECK ((output_tokens >= 0))",
  "c:CHECK ((scope_kind = ANY (ARRAY['contact'::text, 'owner_memory'::text])))",
  "f:FOREIGN KEY (ledger_entry_id) REFERENCES outbound_ledger_entry(id) ON DELETE CASCADE",
  "f:FOREIGN KEY (owner_id) REFERENCES owner(id) ON DELETE CASCADE",
  "f:FOREIGN KEY (owner_id, contact_id) REFERENCES contact(owner_id, id) ON DELETE CASCADE",
  "p:PRIMARY KEY (attempt_id)",
  "u:UNIQUE (attempt_id, owner_id, contact_id, request_id)",
  "u:UNIQUE (ledger_entry_id)"
];
