// 导入不创建目录、连接数据库或启动进程。仅显式 prepare / inspect / close 执行工作。
import {constants} from 'node:fs';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, open, realpath, stat, access, cp, symlink} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {homedir, userInfo} from 'node:os';
import {join, dirname, basename, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const here = dirname(fileURLToPath(import.meta.url));
const marker = 'notalone.final-native.synthetic.v1';
const databasePattern = /^notalone_final_native_[a-f0-9]{32}_test$/;
const runtimeKeys = ['NOTALONE_HOST_RUNTIME', 'NOTALONE_REPLY_RUNTIME', 'NOTALONE_EXTRACTION_RUNTIME', 'NOTALONE_HISTORY_RUNTIME', 'NOTALONE_EXTRACTION_B_RUNTIME', 'NOTALONE_TASK_WORKER_RUNTIME'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hash = value => createHash('sha256').update(value).digest('hex');
const pg = () => createRequire(join(root, 'backend-ts/package.json'))('pg');
const connection = database => ({host: '/tmp', port: 5432, database, user: userInfo().username,
  password: async () => '', application_name: 'notalone_final_synthetic_fixture',
  connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000});
async function clientFor(database) {
  const client = new (pg().Client)(connection(database));
  try {await client.connect(); return client;} catch (error) {await client.end().catch(() => {}); throw error;}
}
async function privateJson(path, value) {await writeFile(path, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});}
async function migrations() {
  const directory = join(root, 'backend/database/migrations');
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort().map(async name =>
    ({name, checksum: hash(await readFile(join(directory, name)))})));
}
async function sourceSnapshot(directory) {
  const target = join(directory, 'project');
  await mkdir(target, {mode: 0o700});
  const entries = ['desktop/package.json', 'desktop/managed-runtime-contract.mjs', 'desktop/managed-runtime-contract.d.mts',
    'desktop/tsconfig.json', 'desktop/wechat-sources.lock.json', 'desktop/src', 'desktop/scripts', 'desktop/assets',
    'backend-ts/package.json', 'backend-ts/src', 'backend-ts/profile', 'backend/database/migrations'];
  const manifest = [];
  for (const entry of entries) {
    await mkdir(dirname(join(target, entry)), {recursive: true, mode: 0o700});
    await cp(join(root, entry), join(target, entry), {recursive: true, dereference: false});
  }
  async function verifyFiles(base, relative = '') {
    for (const item of await readdir(base, {withFileTypes: true})) {
      const path = join(base, item.name), name = join(relative, item.name);
      if (item.isDirectory()) {await chmod(path, 0o700); await verifyFiles(path, name);}
      else if (item.isFile()) {
        await chmod(path, 0o600);
        const sha256 = hash(await readFile(path));
        if (sha256 !== hash(await readFile(join(root, name)))) throw new Error('fixture_source_changed_during_copy');
        manifest.push({path: name, sha256});
      } else throw new Error('fixture_source_symlink_rejected');
    }
  }
  await verifyFiles(target);
  // 26 退役前 dev.mjs 仍无条件监听此兼容根；只建空目录，不复制或执行 Python。
  await mkdir(join(target, 'backend/src/notalone'), {recursive: true, mode: 0o700});
  for (const project of ['desktop', 'backend-ts']) await symlink(join(root, project, 'node_modules'), join(target, project, 'node_modules'));
  await privateJson(join(directory, 'source-snapshot.json'), manifest.sort((a, b) => a.path.localeCompare(b.path)));
  return {projectDirectory: target, sourceFileCount: manifest.length, sourceManifestSha256: hash(JSON.stringify(manifest)),
    emptyCompatibilityDirectories: ['backend/src/notalone']};
}
async function load(sessionPath) {
  const directory = await realpath(dirname(sessionPath));
  const metadata = await stat(directory);
  if (!basename(directory).startsWith('notalone-final-native-') || (metadata.mode & 0o077)
    || metadata.uid !== process.getuid() || basename(sessionPath) !== 'session.json') throw new Error('fixture_ownership_invalid');
  const file = await open(sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let record;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 65536 || (metadata.mode & 0o077) || metadata.uid !== process.getuid()) throw new Error('fixture_record_invalid');
    record = JSON.parse(await file.readFile('utf8'));
  } finally {await file.close();}
  if (record.marker !== marker || !databasePattern.test(record.database) || await realpath(record.directory) !== directory
    || await realpath(record.userData) !== join(directory, 'desktop') || !/^[a-f0-9-]{36}$/.test(record.nonce)) throw new Error('fixture_ownership_invalid');
  if (record.temporaryDirectory !== undefined && (record.temporaryDirectory !== join(record.directory, 'tmp')
    || await realpath(record.temporaryDirectory) !== join(directory, 'tmp'))) throw new Error('fixture_temporary_directory_invalid');
  return record;
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {process.kill(pid, 0); return true;} catch (error) {if (error.code === 'ESRCH') return false; throw error;}
}
async function requireStopped(record) {
  const info = await readFile(join(record.directory, 'backend.info'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const pid = Number(info.split('\n').find(line => line.startsWith('pid='))?.slice(4));
  if (alive(pid)) throw new Error('fixture_backend_still_running');
  // 只判断本夹具路径的引用，不记录或回传系统进程原文，不结束任何进程。
  const lines = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  const ownReference = lines.split('\n').some(line => {
    const item = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!item || Number(item[1]) === process.pid) return false;
    return item[2].includes(`--user-data-dir=${record.userData}`)
      || item[2].includes(`--user-data-dir ${record.userData}`)
      || record.projectDirectory && item[2].includes(record.projectDirectory)
      || item[2].includes(join(record.directory, 'synthetic-cli'));
  });
  if (ownReference) throw new Error('fixture_process_still_running');
}

export async function prepare(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('fixture_node_24_required');
  const npmCandidates = [options.npmCli, join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    join(homedir(), 'miniconda3/envs/NotAlone/lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  let npmCli;
  for (const path of npmCandidates) {try {npmCli = await realpath(path); break;} catch (error) {if (error.code !== 'ENOENT') throw error;}}
  if (!npmCli) throw new Error('fixture_npm_cli_required');
  // 26 前 BackendHost 仍要求此非秘密兼容字段；只核验文件，不执行或假装已退役。
  const selectedPython = options.pythonExecutable ?? join(userInfo().homedir, 'miniconda3/envs/NotAlone/bin/python');
  let pythonExecutable;
  try {
    if (typeof selectedPython !== 'string' || !isAbsolute(selectedPython)) throw new Error();
    pythonExecutable = await realpath(selectedPython);
    if (!/^python(?:\d+(?:\.\d+)*)?$/.test(basename(pythonExecutable)) || !(await stat(pythonExecutable)).isFile()) throw new Error();
    await access(pythonExecutable, constants.X_OK);
  } catch {throw new Error('fixture_python_compatibility_path_invalid');}
  // Darwin 的开发租约 socket 追加固定文件名；不继承可能很长的系统 TMPDIR。
  const directory = await realpath(await mkdtemp('/tmp/notalone-final-native-'));
  await chmod(directory, 0o700);
  const sessionPath = join(directory, 'session.json');
  const record = {marker, nonce: randomUUID(), database: `notalone_final_native_${randomUUID().replaceAll('-', '')}_test`,
    directory, temporaryDirectory: join(directory, 'tmp'), userData: join(directory, 'desktop'), envFile: join(directory, 'runtime.env'),
    compatibility: {pythonExecutable, pathOnly: true},
    createdAt: new Date().toISOString(), ready: false};
  let admin, client, storage, created = false;
  try {
    await privateJson(sessionPath, record);
    for (const name of ['desktop', 'home', 'tmp', 'skills']) await mkdir(join(directory, name), {mode: 0o700});
    Object.assign(record, await sourceSnapshot(directory));
    await privateJson(sessionPath, record);
    const emptyPassfile = join(directory, 'empty.pgpass');
    await writeFile(emptyPassfile, '', {mode: 0o600});
    admin = await clientFor('postgres');
    await admin.query(`CREATE DATABASE "${record.database}" TEMPLATE template0`); created = true;
    await admin.query(`COMMENT ON DATABASE "${record.database}" IS '${marker}:${record.nonce}'`);
    await admin.end(); admin = undefined;
    const environment = {HOME: join(directory, 'home'), PGHOST: '/tmp', PGPORT: '5432', PGUSER: userInfo().username,
      PGSSLMODE: 'disable', PGPASSFILE: emptyPassfile, NOTALONE_SKILLS_DIR: join(directory, 'skills')};
    const databaseUrl = `host=/tmp port=5432 dbname=${record.database} user=${userInfo().username} sslmode=disable`;
    // 复用当前纯 TS 夹具的产品迁移 seam，不沿用旧 109/111 常量，也不调用 Python helper。
    const {prepareDatabaseSchema} = await import('../../../backend-ts/src/schema-prepare.ts');
    const prepared = await prepareDatabaseSchema({databaseUrl, migrationsDirectory: join(root, 'backend/database/migrations'), environment});
    if (prepared.code !== 'ready') throw new Error(`fixture_schema_${prepared.code}`);
    const settings = {...environment, NOTALONE_DATABASE_URL: databaseUrl,
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_WECHAT_CLI: join(directory, 'synthetic-cli'),
      NOTALONE_SYNC_PROBE: join(directory, 'disabled-probe'),
      NOTALONE_FOREGROUND_LAYOUT: join(directory, 'disabled-layout.json'),
      ...Object.fromEntries(runtimeKeys.map(key => [key, 'typescript']))};
    await writeFile(record.envFile, Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''), {mode: 0o600});
    const {HostStorage} = await import('../../../backend-ts/src/host-storage.ts');
    storage = await HostStorage.open({envFilePath: record.envFile, migrationsDirectory: join(root, 'backend/database/migrations'), environment: {}});
    await storage.initializeOwner('合成验收本人');
    client = await clientFor(record.database);
    const {seed} = await import('./seed.mjs');
    record.seeds = await seed(client, storage, directory);
    await storage.close(); storage = undefined;
    await client.end(); client = undefined;
    await privateJson(join(directory, 'control.json'), {account: record.seeds.account,
      contacts: record.seeds.contacts.map(({name, externalId}) => ({name, externalId})), incremental: false});
    await writeFile(join(directory, 'cli-commands.jsonl'), '', {mode: 0o600});
    await writeFile(join(directory, 'synthetic-cli'), `#!${process.execPath}\n${await readFile(join(here, 'synthetic-cli.mjs'), 'utf8')}`, {mode: 0o700});
    await privateJson(join(record.userData, 'backend-launch.json'), {projectDirectory: record.projectDirectory, pythonExecutable,
      envFilePath: record.envFile, backendInfoPath: join(directory, 'backend.info'),
      wechatCliPath: settings.NOTALONE_WECHAT_CLI, syncProbePath: settings.NOTALONE_SYNC_PROBE});
    const launchEnvironment = {PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: environment.HOME, TMPDIR: record.temporaryDirectory, LANG: 'en_US.UTF-8', LC_ALL: 'C', TZ: 'Asia/Taipei',
      ...settings, NOTALONE_ENV_FILE: record.envFile, NOTALONE_MANAGED_USER_DATA: directory};
    // .env 中由 initializeOwner 持久化的 UUID 保留；启动环境不另设身份覆盖。
    const launch = `#!/bin/sh\nset -eu\numask 077\ncd ${quote(join(record.projectDirectory, 'desktop'))}\nexec /usr/bin/env -i ${Object.entries(launchEnvironment).map(([key, value]) => quote(`${key}=${value}`)).join(' ')} ${quote(process.execPath)} ${quote(npmCli)} run dev -- --user-data-dir ${quote(record.userData)}\n`;
    await writeFile(join(directory, 'start-dev.sh'), launch, {mode: 0o700});
    record.ready = true;
    await privateJson(sessionPath, record);
    return {sessionPath, directory, temporaryDirectory: record.temporaryDirectory, userData: record.userData, startScript: join(directory, 'start-dev.sh'),
      projectDirectory: record.projectDirectory, importFiles: record.seeds.contacts.map(({importFile}) => importFile)};
  } catch (error) {
    await storage?.close().catch(() => {}); await client?.end().catch(() => {});
    await admin?.end().catch(() => {});
    let cleanup;
    try {
      if (created) {const cleanupAdmin = await clientFor('postgres');
        try {await cleanupAdmin.query(`DROP DATABASE "${record.database}"`);} finally {await cleanupAdmin.end();}}
      await rm(directory, {recursive: true}); cleanup = true;
    } catch (failure) {
      await writeFile(join(directory, 'prepare-error.private.txt'), String(error.stack) + '\n' + String(failure.stack), {mode: 0o600});
      cleanup = false;
    }
    throw Object.assign(new Error(`fixture_prepare_failed:${error.code ?? error.message}`), {cleanup, sessionPath: cleanup ? undefined : sessionPath});
  }
}

export async function inspect(sessionPath) {
  const record = await load(sessionPath), expected = await migrations();
  const client = await clientFor(record.database); let storage;
  try {
    const actual = (await client.query('SELECT name,checksum FROM notalone_schema_migration ORDER BY name')).rows;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('fixture_migration_manifest_changed');
    const {HostStorage} = await import('../../../backend-ts/src/host-storage.ts');
    storage = await HostStorage.open({envFilePath: record.envFile, migrationsDirectory: join(root, 'backend/database/migrations'), environment: {}});
    const setup = await storage.setupStatus();
    if (!setup.runtime_owner_configured || setup.credentials_configured || storage.runtimeOwnerId !== record.seeds.owner) throw new Error('fixture_setup_invalid');
    const environment = storage.runtimeEnvironment();
    for (const key of runtimeKeys) if (environment[key] !== 'typescript') throw new Error('fixture_runtime_invalid');
    const {MemoryService} = await import('../../../backend-ts/src/memory-service.ts');
    const memory = new MemoryService(storage), [a, b] = record.seeds.contacts;
    const aMemories = (await memory.handle('GET', new URL(`http://localhost/api/contacts/${a.id}/memories`))).memories;
    const bMemories = (await memory.handle('GET', new URL(`http://localhost/api/contacts/${b.id}/memories`))).memories;
    const pending = (await memory.handle('GET', new URL(`http://localhost/api/contacts/${a.id}/memory-candidates`))).candidates;
    const counts = (await client.query(`SELECT (SELECT count(*)::int FROM owner) AS owners,
      (SELECT count(*)::int FROM contact) AS contacts,(SELECT count(*)::int FROM message) AS messages,
      (SELECT count(*)::int FROM source_document) AS sources,(SELECT count(*)::int FROM assistant_session_input) AS discussion_inputs,
      (SELECT count(*)::int FROM outbound_ledger_entry) AS outbound_calls,
      (SELECT enabled FROM front_sync_state LIMIT 1) AS sync_enabled`)).rows[0];
    const valid = aMemories.some(item => item.memory_id === record.seeds.autoMemory && item.adoption_method === 'auto')
      && bMemories.some(item => item.memory_id === record.seeds.manual && item.adoption_method === 'manual')
      && aMemories.every(item => item.memory_id !== record.seeds.manual)
      && bMemories.every(item => item.memory_id !== record.seeds.autoMemory)
      && pending.some(item => item.candidate_id === record.seeds.candidate);
    if (!valid || JSON.stringify(counts) !== JSON.stringify({owners: 1, contacts: 2, messages: 3,
      sources: 3, discussion_inputs: 1, outbound_calls: 0, sync_enabled: false})) throw new Error('fixture_seed_projection_invalid');
    const foreignRefs = (await client.query(`SELECT count(*)::int AS n FROM message_source_ref r
      JOIN source_document s ON s.id=r.source_document_id
      JOIN message m ON m.id=r.message_id
      WHERE r.owner_id<>s.owner_id OR r.contact_id<>s.contact_id
        OR r.owner_id<>m.owner_id OR r.contact_id<>m.contact_id`)).rows[0].n;
    if (foreignRefs !== 0) throw new Error('fixture_source_scope_invalid');
    const importRecord = JSON.parse((await readFile(a.importFile, 'utf8')).trim().split('\n')[0]);
    const {HistoryImportApi} = await import('../../../backend-ts/src/history-import-api.ts');
    const importer = new HistoryImportApi({ownerId: record.seeds.owner, transaction: work => storage.businessTransaction(work)});
    const preview = await importer.handle('POST', '/api/imports/preview', {path: a.importFile, contact_id: a.id});
    if (preview.status !== 200 || preview.body.record_count !== 2 || !preview.body.valid
      || importRecord.id.talker !== a.externalId) throw new Error('fixture_import_invalid');
    const {AssistantDiscussionService} = await import('../../../backend-ts/src/assistant-discussion-service.ts');
    const discussion = new AssistantDiscussionService({transaction: work => storage.businessTransaction(work),
      skillsRoot: join(record.directory, 'skills'), environment: {HOME: join(record.directory, 'home')}});
    const saved = await discussion.readSession({owner_id: record.seeds.owner, contact_id: a.id}, record.seeds.discussion);
    if (saved.inputs.length !== 1) throw new Error('fixture_discussion_invalid');
    const configuration = JSON.parse(await readFile(join(record.userData, 'backend-launch.json'), 'utf8'));
    if (configuration.pythonExecutable !== record.compatibility?.pythonExecutable || !configuration.pythonExecutable
      || configuration.envFilePath !== record.envFile
      || configuration.projectDirectory !== join(record.directory, 'project')) throw new Error('fixture_launch_invalid');
    const sourceFiles = JSON.parse(await readFile(join(record.directory, 'source-snapshot.json'), 'utf8'));
    for (const entry of sourceFiles) {
      if (hash(await readFile(join(record.projectDirectory, entry.path))) !== entry.sha256) throw new Error('fixture_source_snapshot_changed');
    }
    for (const path of record.emptyCompatibilityDirectories ?? []) {
      if (path !== 'backend/src/notalone' || (await readdir(join(record.projectDirectory, path))).length) throw new Error('fixture_compatibility_watch_root_invalid');
    }
    const rawCli = execFileSync(join(record.directory, 'synthetic-cli'),
      ['tail', a.externalId, '--history', '--limit', '100', '--strict-read-only'],
      {encoding: 'utf8', timeout: 5000, env: {HOME: join(record.directory, 'home'), PATH: '/usr/bin:/bin'}});
    const {parseIncrementalTail} = await import('../../../backend-ts/src/sync-incremental-normalize.ts');
    const cliHistory = parseIncrementalTail(rawCli, a.externalId, {history: true});
    if (cliHistory.events.length !== 2 || cliHistory.has_more) throw new Error('fixture_cli_invalid');
    return {syntheticOnly: true, migrationCount: actual.length, migrationManifestSha256: hash(JSON.stringify(actual)),
      counts, config: {allRuntimeTypescript: true, modelKeyEmpty: true, cliSynthetic: true, nativeProbeDisabled: true, isolatedUserData: true, cleanLaunchEnvironment: true, privateSourceSnapshot: true,
        compatibilityPythonPathConfigured: true, compatibilityPythonPathOnly: true, productPythonExecutionValidated: false},
      sourceSnapshot: {files: sourceFiles.length, manifestSha256: record.sourceManifestSha256,
        emptyCompatibilityDirectories: record.emptyCompatibilityDirectories ?? []},
      projections: {manual: bMemories.length, auto: aMemories.length, pending: pending.length, discussionInputs: saved.inputs.length, importPreviewRecords: preview.body.record_count, syntheticCliHistoryRecords: cliHistory.events.length},
      productProcessesStarted: 0, pythonInvocations: 0, guiVerified: false};
  } finally {await storage?.close(); await client.end();}
}

export async function control(sessionPath, incremental) {
  if (typeof incremental !== 'boolean') throw new Error('fixture_control_invalid');
  const record = await load(sessionPath), path = join(record.directory, 'control.json');
  const value = JSON.parse(await readFile(path, 'utf8')); value.incremental = incremental;
  await privateJson(path, value);
}

export async function close(sessionPath) {
  const record = await load(sessionPath);
  await requireStopped(record);
  const admin = await clientFor('postgres');
  try {
    const database = (await admin.query('SELECT oid,shobj_description(oid,\'pg_database\') AS comment FROM pg_database WHERE datname=$1', [record.database])).rows[0];
    if (database) {
      if (database.comment !== `${marker}:${record.nonce}`) throw new Error('fixture_database_ownership_invalid');
      const active = (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [record.database])).rows[0].n;
      if (active) throw new Error('fixture_database_in_use');
      await admin.query(`DROP DATABASE "${record.database}"`);
    }
    const absent = !(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [record.database])).rowCount;
    if (!absent) throw new Error('fixture_database_cleanup_failed');
  } finally {await admin.end();}
  await requireStopped(record);
  await rm(record.directory, {recursive: true});
  return {databaseAbsent: true, directoryAbsent: true, liveOwnedProcesses: 0, forcedTermination: false};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, sessionPath, value] = process.argv.slice(2);
  try {
    const result = command === 'prepare' ? await prepare()
      : command === 'inspect' ? await inspect(sessionPath)
      : command === 'control' ? await control(sessionPath, value === 'on' ? true : value === 'off' ? false : null)
      : command === 'close' ? await close(sessionPath) : (() => {throw new Error('use_prepare_inspect_control_close');})();
    console.log(JSON.stringify(result ?? {updated: true}));
  } catch (error) {
    console.error(JSON.stringify({error: error.code ?? error.message, cleanup: error.cleanup, sessionPath: error.sessionPath})); process.exitCode = 1;
  }
}
