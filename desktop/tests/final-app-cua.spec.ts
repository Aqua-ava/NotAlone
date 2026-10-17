// 正式15实际App验收：合成输入由公共preload准备，交互由主Agent通过CUA完成。
// 保存全部自有静态响应的原字节，并先保留自有profile供失败复查与逐名收尾。
// 仅编排现有 fixture、公有 preload、实际 CUA；不加入产品测试 IPC。
import { expect, type ElectronApplication, type Page, type Response } from '@playwright/test';
import { test } from './rewrite-fixture';
import { verifyAppTestLease } from './app-test-gate';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';
import { createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function writeOriginal(filename: string, bytes: Buffer | string) {
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
const evidence = (filename: string, value: unknown) => writeOriginal(filename, JSON.stringify(value, null, 2) + '\n');
type FrozenFile = { path: string; sha256: string; bytes: number };
type FrozenPlan = {
  schemaVersion: 1; directory: string; sourceRoot: string; sourceCommit: string;
  reviewedSyncPermitCommit: string; until: string; packageBundle: string; executable: string;
  sourceFiles: FrozenFile[]; packageFiles: FrozenFile[];
  modelCalls: 1; appLaunches: 1; controlHttpRequests: 10; externalModelRequests: 0; externalMessages: 0;
};
let plan: FrozenPlan;
let runDirectory: string;
const executableRelative = 'Contents/MacOS/NotAlone';
const nativeFiles = ['notalone-sync-probe', 'notalone-header-change-source', 'libNotAloneSyncCore.dylib'];
const gateSources = [
  'desktop/tests/final-app-cua.spec.ts',
  'desktop/tests/app-fixture.ts', 'desktop/tests/rewrite-fixture.ts',
  'desktop/tests/rewrite-backend-fixture.ts', 'desktop/tests/fixtures/rewrite-backend.py',
  'desktop/tests/acceptance-coordinator.mjs', 'desktop/tests/app-test-gate.ts',
  'desktop/src/main/index.ts', 'desktop/src/main/foreground/controller.ts',
  'desktop/src/main/foreground/native-change-source.ts', 'desktop/src/main/sync/controller.ts',
  'backend/src/notalone/server/app.py',
];

async function privateDirectory(directory: string) {
  expect(await realpath(directory)).toBe(directory);
  const stat = await lstat(directory);
  expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
  expect(stat.uid).toBe(process.getuid?.());
  expect(stat.mode & 0o777).toBe(0o700);
}
async function frozenBytes(root: string, file: FrozenFile) {
  if (path.isAbsolute(file.path) || file.path.split('/').some((part) => !part || ['.', '..'].includes(part))) {
    throw new Error('冻结文件路径无效');
  }
  const selected = path.join(root, file.path);
  expect(await realpath(selected)).toBe(selected);
  const stat = await lstat(selected);
  expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
  const bytes = await readFile(selected);
  expect(bytes.length).toBe(file.bytes);
  expect(sha256(bytes)).toBe(file.sha256);
  return bytes;
}

// 本单场先保留自有profile；root封存最小原字节与退场证据后才逐名清理。
test.use({ retainUserData: true });
test.skip(process.env.NOTALONE_FINAL_APP_CUA !== '1', '仅用于正式15有限单场实际App验收');
// 夹具准备也属于同一有限场次，不能等进入test body后才覆盖默认30秒。
test.describe.configure({ timeout: 15 * 60_000 });
test.beforeAll(async () => {
  const filename = process.env.NOTALONE_FINAL_APP_PLAN;
  if (!filename || !path.isAbsolute(filename)) throw new Error('缺少私有冻结计划');
  const stat = await lstat(filename);
  expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
  expect(stat.uid).toBe(process.getuid?.());
  expect(stat.mode & 0o777).toBe(0o600);
  plan = JSON.parse(await readFile(filename, 'utf8')) as FrozenPlan;
  expect(plan.schemaVersion).toBe(1);
  expect(plan).toMatchObject({ modelCalls: 1, appLaunches: 1, controlHttpRequests: 10, externalModelRequests: 0, externalMessages: 0 });
  expect(plan.reviewedSyncPermitCommit).toBe(plan.sourceCommit);
  expect(/^[a-f0-9]{40}$/.test(plan.sourceCommit)).toBe(true);
  await privateDirectory(plan.directory);
  expect(path.dirname(filename)).toBe(plan.directory);
  expect(Date.parse(plan.until) - Date.now()).toBeGreaterThan(60_000);
  expect(Date.parse(plan.until) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  expect(await realpath(plan.sourceRoot)).toBe(plan.sourceRoot);
  const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: plan.sourceRoot })).stdout.trim();
  expect(head).toBe(plan.sourceCommit);
  for (const required of gateSources) expect(plan.sourceFiles.some((file) => file.path === required)).toBe(true);
  for (const file of plan.sourceFiles) {
    const bytes = await frozenBytes(plan.sourceRoot, file);
    const committed = await execute('git', ['show', `${plan.sourceCommit}:${file.path}`],
      { cwd: plan.sourceRoot, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    expect(Buffer.compare(bytes, committed.stdout)).toBe(0);
  }
  expect(plan.executable).toBe(path.join(plan.packageBundle, executableRelative));
  expect(process.env.NOTALONE_TEST_APP_EXECUTABLE).toBe(plan.executable);
  for (const required of [executableRelative, 'Contents/Info.plist', 'Contents/Resources/app.asar',
    'Contents/Resources/notalone-probe/manifest.json',
    ...nativeFiles.map((name) => `Contents/Resources/notalone-probe/${name}`)]) {
    expect(plan.packageFiles.some((file) => file.path === required)).toBe(true);
  }
  for (const file of plan.packageFiles) await frozenBytes(plan.packageBundle, file);
  // 一个计划只消费一次；保留而不覆盖，失败重跑也必须建立新计划和新证据目录。
  runDirectory = path.join(plan.directory, 'actual-run');
  await mkdir(runDirectory, { mode: 0o700 });
  await evidence(path.join(runDirectory, 'frozen-plan.json'), plan);
});

// 保存所有自有静态响应的实际 Buffer，包含图片；不以摘要或DOM代替原始响应。
function captureResources(directory: string) {
  const pending = new Set<Promise<void>>();
  const bodyTimeoutMs = 15_000;
  const records: Array<{ number: number; role: 'manager' | 'helper'; url: string; file: string; status: number;
    startedMetadata: string; finishedMetadata: string; startedAt: string; finishedAt?: string;
    state: 'started' | 'complete' | 'failed' | 'timed_out'; failureStage?: string; metadataError?: string;
    bodyReadComplete: boolean; fileWritten: boolean; sha256?: string; bytes?: number; error?: string }> = [];
  const listeners = new Map<Page, (response: Response) => void>();
  let serial = 0;
  async function settle() { while (pending.size) await Promise.all([...pending]); }
  function assertComplete() {
    expect(records.filter((item) => item.state !== 'complete')).toEqual([]);
  }
  function detach() { for (const [page, listen] of listeners) page.off('response', listen); }
  return {
    attach(page: Page, role: 'manager' | 'helper') {
      if (listeners.has(page)) return;
      const listen = (response: Response) => {
        const url = new URL(response.url());
        if (url.protocol !== 'notalone:' || url.host !== 'app') return;
        const number = ++serial;
        const record: typeof records[number] = { number, role, url: url.href, status: response.status(),
          startedMetadata: `${number}-started.json`, finishedMetadata: `${number}-finished.json`,
          file: `${number}-${path.basename(url.pathname)}.bytes`, startedAt: new Date().toISOString(),
          state: 'started', bodyReadComplete: false, fileWritten: false };
        records.push(record);
        const operation = (async () => {
          let stage = 'started_metadata';
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // body还未开始读取时就留下不可覆盖的原始观察，进程中断也能看到分母。
            await evidence(path.join(directory, record.startedMetadata), { ...record, bodyTimeoutMs });
            stage = 'response_body';
            const body = await Promise.race([response.body(), new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error(`自有静态响应正文未在${bodyTimeoutMs}ms内完成。`));
              }, bodyTimeoutMs);
            })]);
            clearTimeout(timer);
            // race超时后的原body Promise即使迟到，也没有写正文或改记complete的回调。
            record.bodyReadComplete = true; record.bytes = body.length; record.sha256 = sha256(body);
            stage = 'write_body';
            await writeOriginal(path.join(directory, record.file), body);
            record.fileWritten = true; record.state = 'complete';
          } catch (error) {
            record.state = timedOut ? 'timed_out' : 'failed';
            record.failureStage = stage; record.error = String(error);
          } finally {
            clearTimeout(timer); record.finishedAt = new Date().toISOString();
            try { await evidence(path.join(directory, record.finishedMetadata), record); }
            catch (error) {
              record.metadataError = String(error);
              if (record.state === 'complete') { record.state = 'failed'; record.failureStage = 'finished_metadata'; }
            }
          }
        })();
        pending.add(operation);
        void operation.finally(() => pending.delete(operation));
      };
      listeners.set(page, listen); page.on('response', listen);
    },
    async drain() { await settle(); assertComplete(); },
    async verify(pages: Page[]) {
      await settle(); assertComplete();
      for (const page of pages) {
        const expected = await page.evaluate(() => [location.href.split('#')[0],
          ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]')).map((item) => item.src),
          ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map((item) => item.href),
          ...performance.getEntriesByType('resource').map((item) => item.name)]
          .filter((url) => /^notalone:\/\/app\//.test(url)));
        for (const url of expected) expect(records.some((item) => item.url === url && item.state === 'complete'
          && item.status === 200 && (item.bytes ?? 0) > 0)).toBe(true);
      }
      expect(records.some((item) => new URL(item.url).pathname.endsWith('.html'))).toBe(true);
      expect(records.some((item) => new URL(item.url).pathname.endsWith('.js'))).toBe(true);
      expect(records.some((item) => new URL(item.url).pathname.endsWith('.css'))).toBe(true);
      return records;
    },
    detach,
    async close(primaryError: unknown) {
      detach(); await settle();
      await evidence(path.join(directory, 'capture-index.json'), {
        scope: '初始准确URL/load及图片就绪后才附加；捕获明确reload及之后的自有manager/helper页面响应，不代表初始导航或全部App请求',
        bodyTimeoutMs,
        started: records.length, complete: records.filter((item) => item.state === 'complete').length,
        failed: records.filter((item) => item.state === 'failed').length,
        timedOut: records.filter((item) => item.state === 'timed_out').length,
        incomplete: records.filter((item) => item.state !== 'complete').length,
        primaryError: primaryError instanceof Error ? { name: primaryError.name, message: primaryError.message,
          stack: primaryError.stack } : primaryError === undefined ? null : String(primaryError), records,
      });
      // 原错误继续由test抛出；收尾不能用第二次相同断言覆盖它。
      if (primaryError === undefined) assertComplete();
    },
  };
}

async function prepareCapturedReload(page: Page, role: 'manager' | 'helper', capture: ReturnType<typeof captureResources>) {
  async function ready() {
    await page.waitForURL(`notalone://app/index.html#${role}`, { waitUntil: 'load', timeout: 15_000 });
    // React可能在load之后才挂载logo；这里只判定初始导航已结束，不把DOM当响应原字节。
    await expect.poll(() => page.evaluate(() => document.readyState === 'complete' && document.images.length > 0
      && [...document.images].every((image) => image.complete && image.naturalWidth > 0)), { timeout: 15_000 }).toBe(true);
  }
  await ready();
  capture.attach(page, role);
  await capture.drain();
  await page.reload({ waitUntil: 'load', timeout: 15_000 });
  await ready();
  await capture.drain();
}

function captureControlHttp(infoPath: string, directory: string) {
  const records: Array<Record<string, unknown>> = [];
  return {
    async request(endpoint: string, body?: object) {
      if (!endpoint.startsWith('/api/') || /[\r\n]/.test(endpoint) || records.length >= plan.controlHttpRequests) {
        throw new Error('本场公开校验请求超出冻结范围');
      }
      const number = records.length + 1;
      const sent = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
      const record: Record<string, unknown> = { number, endpoint, method: body ? 'POST' : 'GET', dispatched: false, complete: false };
      records.push(record);
      try {
        await writeOriginal(path.join(directory, `${number}-request.bytes`), sent);
        record.requestBytes = sent.length; record.requestSha256 = sha256(sent);
        const info = await readFile(infoPath, 'utf8');
        const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
        const token = /^token=([^\n]+)$/m.exec(info)?.[1];
        if (!address || !token) throw new Error('本轮受控握手未就绪');
        record.dispatched = true;
        const response = await fetch(`http://${address}${endpoint}`, { method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body ? sent.toString('utf8') : undefined, signal: AbortSignal.timeout(15_000) });
        record.status = response.status;
        const raw = Buffer.from(await response.arrayBuffer());
        if (raw.length > 4 * 1024 * 1024) throw new Error('本场公开响应超出大小范围');
        await writeOriginal(path.join(directory, `${number}-response.bytes`), raw);
        record.responseBytes = raw.length; record.responseSha256 = sha256(raw); record.complete = true;
        const data: unknown = JSON.parse(raw.toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本场公开响应对象无效');
        return { status: response.status, data: data as Record<string, unknown> };
      } catch (error) { record.error = String(error); throw error; }
    },
    async close() {
      await evidence(path.join(directory, 'index.json'), { cap: plan.controlHttpRequests,
        scope: '仅本测试主动发出的公开校验请求；不代表App后台全部HTTP请求',
        started: records.length, dispatched: records.filter((item) => item.dispatched).length,
        complete: records.filter((item) => item.complete).length,
        incomplete: records.filter((item) => !item.complete).length, records });
    },
    count: () => records.length,
  };
}

async function ownIdentity(app: ElectronApplication, child: ChildProcess, userData: string) {
  const actual = await app.evaluate(({ app }) => ({ pid: process.pid, executable: process.execPath,
    userData: app.getPath('userData'), appPath: app.getAppPath(), isPackaged: app.isPackaged,
    resources: process.resourcesPath, metrics: app.getAppMetrics() }));
  expect(actual.pid).toBe(child.pid);
  expect(await realpath(actual.executable)).toBe(await realpath(plan.executable));
  expect(await realpath(actual.userData)).toBe(await realpath(userData));
  expect(actual.isPackaged).toBe(true);
  expect(actual.appPath).toBe(path.join(plan.packageBundle, 'Contents/Resources/app.asar'));
  expect(child.spawnargs).toContain(`--user-data-dir=${userData}`);
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  return { ...actual, childSpawnfile: child.spawnfile, childSpawnargs: child.spawnargs };
}

async function ownProcesses(roots: number[]) {
  // 只在内存中筛选本轮根的后代；不保存或操作同bundleID的未知实例。
  const text = (await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='])).stdout;
  const rows = text.trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), executable: match[4] } : null;
  }).filter((row): row is NonNullable<typeof row> => row !== null);
  const owned = new Set(roots);
  let before = -1;
  while (before !== owned.size) { before = owned.size; for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid); }
  const selected = rows.filter((row) => owned.has(row.pid));
  expect(selected.some((row) => nativeFiles.some((name) => row.executable.endsWith(`/${name}`)))).toBe(false);
  return selected;
}

async function waitForOriginalExit(child: ChildProcess, timeoutMs = 30_000) {
  // ready-for-menu-quit 后唯一的等待：原始 ChildProcess；不再调用app、isAlive、coordinator.waitFor。
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const exited = () => { clearTimeout(timer); child.off('exit', exited); resolve(); };
    const timer = setTimeout(() => { child.off('exit', exited); reject(new Error('实际公开菜单退出未确认')); }, timeoutMs);
    child.once('exit', exited);
  });
}

test('正式15 单包单实例：实际CUA确认、主动候选、编辑保存选择、管理与正常菜单退出',
  async ({ runningApp: { app, appProcess, userData }, rewriteBackend }) => {
    test.setTimeout(15 * 60_000);
    const directory = runDirectory;
    const resources = path.join(directory, 'response-bytes'); await mkdir(resources, { mode: 0o700 });
    const capture = captureResources(resources);
    const controlDirectory = path.join(directory, 'control-http'); await mkdir(controlDirectory, { mode: 0o700 });
    const control = captureControlHttp(rewriteBackend.infoPath, controlDirectory);
    const coordinatorDirectory = path.join(directory, 'coordinator'); await mkdir(coordinatorDirectory, { mode: 0o700 });
    const coordinator = await createAcceptanceCoordinator({ directory: coordinatorDirectory, pid: appProcess.pid!,
      checkLease: verifyAppTestLease,
      isAlive: () => appProcess.exitCode === null && appProcess.signalCode === null });
    let coordinatorClosed = false;
    let primaryError: unknown;
    try {
      const identity = await ownIdentity(app, appProcess, userData);
      const processRoots = [appProcess.pid!, rewriteBackend.child.pid!];
      const databaseName = /(?:^|\s)dbname=(notalone_core_flow_[0-9a-f]{32}_test)(?:\s|$)/.exec(rewriteBackend.data.database_url)?.[1];
      expect(databaseName).toBeTruthy();
      await evidence(path.join(directory, 'owned.json'), { runId: coordinator.runId, identity, databaseName,
        fixturePid: rewriteBackend.child.pid, fixtureDirectory: rewriteBackend.directory });
      // 原生三文件与manifest的原始字节在私有目录保留；不执行这些文件。
      for (const file of plan.packageFiles) {
        const bytes = await frozenBytes(plan.packageBundle, file);
        if (file.path.includes('/notalone-probe/')) await writeOriginal(path.join(directory, path.basename(file.path) + '.bytes'), bytes);
      }
      const manager = await app.firstWindow();
      // 首窗可能在返回Playwright handle前已加载；此次明确准备reload发生在CUA前。
      await prepareCapturedReload(manager, 'manager', capture);
      await manager.evaluate(() => window.notalone.contacts.refreshContacts());
      await expect.poll(() => manager.evaluate(() => window.notalone.contacts.getState()).then((state) => state.directoryPhase)).toBe('ready');
      const contactId = rewriteBackend.data.contact_ids[0];
      const marker = `正式15合成草稿 ${coordinator.runId}`;
      const purpose = `正式15合成目的 ${coordinator.runId}：说明我会稍后回复，不作额外承诺。`;
      const edited = `正式15人工修改 ${coordinator.runId}：我会稍后回复。`;
      const candidate = `正式15脚本候选 ${coordinator.runId}：我会晚一点回复你。`;
      await manager.evaluate(async ({ contactId, marker }) => {
        const before = await window.notalone.contacts.getState();
        const selected = await window.notalone.contacts.selectContact({ contactId, scopeRevision: before.scopeRevision });
        await window.notalone.contacts.setDraft({ contactId, scopeRevision: selected.scopeRevision, text: marker });
      }, { contactId, marker });
      const opened = app.waitForEvent('window');
      await manager.evaluate(() => window.notalone.openHelper());
      const helper = await opened;
      await prepareCapturedReload(helper, 'helper', capture);
      const gate = async () => {
        const status = await control.request('/api/sync/status');
        const observe = await control.request('/api/sync/foreground/observe', {});
        expect(status).toEqual({ status: 503, data: { error: 'sync_unavailable' } });
        expect(observe).toEqual({ status: 503, data: { error: 'sync_unavailable' } });
        const sync = await manager.evaluate(() => window.notalone.syncControl.getState());
        expect(sync.phase).toBe('unavailable'); expect(sync.report).toBeNull();
        return { status, observe, sync, ownProcesses: await ownProcesses(processRoots) };
      };
      const initial = await helper.evaluate(async () => ({ contacts: await window.notalone.contacts.getState(),
        foreground: await window.notalone.foreground.getState(), replies: await window.notalone.replies.getState() }));
      expect(initial.contacts.draft).toBe(marker);
      expect(initial.foreground.confirmation).toBe('required');
      const beforeLedger = await control.request('/api/ledger/summary');
      expect(beforeLedger.status).toBe(200); expect(beforeLedger.data.total_calls).toBe(0);
      const modelPlan = { count: 1, text: candidate, basis: '仅依据本轮明确主动目的组织表达，不作额外承诺。' };
      await evidence(path.join(directory, 'model-plan.json'), { runId: coordinator.runId, modelPlan, calls: 1, externalHTTP: 0 });
      await rewriteBackend.plan(modelPlan);
      await evidence(path.join(directory, 'preparation.json'), { runId: coordinator.runId, marker, purpose, edited, candidate,
        contactId, initial, beforeLedger, gate: await gate(), preparationReloads: ['manager', 'helper'],
        preparationOnly: ['refreshContacts', 'selectContact', 'setDraft', 'openHelper'],
        resourceIndex: await capture.verify([manager, helper]) });
      await evidence(path.join(directory, 'ready-for-cua.json'), { runId: coordinator.runId, pid: appProcess.pid,
        executable: plan.executable, userData, coordinatorDirectory, marker, purpose, edited,
        inputMode: 'initiate_conversation',
        instructions: '主Agent核对准确可执行路径/PID/可视marker后，实际CUA确认联系人、点主动聊聊、在主动目的框填写purpose原文、仅生成一次、编辑并保存本组、选择当前版本、进入管理并返回；只在完成后写inspect.trigger；现在不要退出。' });
      await coordinator.waitFor('inspect');
      // 由主Agent写入真实CUA操作回执；回执本身不替代下方公开状态/HTTP断言。
      const cua = JSON.parse(await readFile(path.join(coordinatorDirectory, 'cua-actions.json'), 'utf8')) as {
        runId: string; pid: number; actions: Array<{ action: string; toolReference: string; observed: string }> };
      expect(cua.runId).toBe(coordinator.runId); expect(cua.pid).toBe(appProcess.pid);
      for (const action of ['confirm-contact', 'select-initiate-mode', 'enter-purpose', 'generate-once', 'edit', 'save-group', 'select-version', 'open-manager', 'return-helper']) {
        expect(cua.actions.some((item) => item.action === action && item.toolReference && item.observed)).toBe(true);
      }
      const final = await helper.evaluate(async () => ({ contacts: await window.notalone.contacts.getState(),
        foreground: await window.notalone.foreground.getState(), replies: await window.notalone.replies.getState() }));
      expect(final.contacts.selectedContactId).toBe(contactId);
      // 本场没有同步观察接线。生成前必须实际手动确认；之后的503轮询可安全撤回资格，
      // 已完成候选仍留在原联系人范围供编辑/保存，不将确认持续有效作为本场验收结论。
      expect(['manual-confirmed', 'required']).toContain(final.foreground.confirmation);
      if (final.foreground.confirmation === 'manual-confirmed') {
        expect(final.foreground.confirmedContactId).toBe(contactId);
        expect(final.replies.generationBlock).toBeNull();
      } else {
        expect(final.foreground.confirmedContactId).toBeNull();
        expect(final.replies.generationBlock).toBe('foreground-confirmation-required');
      }
      expect(final.replies.phase).toBe('ready');
      expect(final.replies.savedSession?.phase).toBe('ready');
      const selection = final.replies.explicitCandidateSelection?.selection;
      expect(final.replies.explicitCandidateSelection?.phase).toBe('ready'); expect(selection).toBeTruthy();
      if (!selection) throw new Error('本轮显式选择尚未确认');
      expect(final.replies.contactId).toBe(contactId);
      expect(final.replies.scopeRevision).toBe(final.contacts.scopeRevision);
      const view = final.replies.candidateVersions?.items.find((item) => item.candidateId === selection?.candidateId);
      const savedVersion = view?.history?.versions.find((item) => item.versionId === selection?.versionId);
      expect(savedVersion?.versionNumber).toBe(1); expect(savedVersion?.text).toBe(edited);
      if (!savedVersion || savedVersion.messages.length !== 1) throw new Error('本轮已保存消息身份不可用');
      const sessionId = final.replies.savedSession!.sessionId!;
      expect(selection.sessionId).toBe(sessionId);
      expect(view?.history?.sessionId).toBe(sessionId);
      expect(view?.history?.candidateId).toBe(selection.candidateId);
      expect(view?.displayVersionId).toBe(selection.versionId);
      expect(final.replies.result?.input.mode).toBe('initiate_conversation');
      if (final.replies.result?.input.mode !== 'initiate_conversation') throw new Error('本轮主动目的快照不可用');
      expect(final.replies.result.input.purpose).toBe(purpose);
      const saved = await control.request(`/api/contacts/${contactId}/assistant-sessions/${sessionId}`);
      expect(saved.status).toBe(200);
      const candidateEndpoint = `/api/contacts/${contactId}/assistant-sessions/${sessionId}/candidates/${selection.candidateId}/versions`;
      // 本单场只有一次生成和一次保存：严格两版、每页一版，不能用HTTP200代替正文/身份核验。
      // through固定在当前已保存修改版，避免分页之间出现另一版本造成漂移。
      const versionPages = [];
      for (const pageNumber of [0, 1]) {
        const response = await control.request(`${candidateEndpoint}?page=${pageNumber}&through=${encodeURIComponent(selection.versionId)}`);
        expect(response.status).toBe(200);
        expect(response.data).toMatchObject({ session_id: sessionId, candidate_id: selection.candidateId,
          default_display_version_id: selection.versionId, page_number: pageNumber,
          version_count: 2, next_page: pageNumber === 0 ? 1 : null });
        expect(Object.hasOwn(response.data, 'selected_version_id')).toBe(false);
        const versions = response.data.versions;
        if (!Array.isArray(versions) || versions.length !== 1) throw new Error('本轮版本分页不完整');
        expect(versions[0]).toMatchObject({ version_id: pageNumber === 0 ? selection.candidateId : selection.versionId,
          version_number: pageNumber, parent_version_id: pageNumber === 0 ? null : selection.candidateId,
          text: pageNumber === 0 ? candidate : edited,
          messages: [{ message_id: savedVersion.messages[0].messageId, text: pageNumber === 0 ? candidate : edited }] });
        versionPages.push(response);
      }
      const persistedSelection = await control.request(`/api/contacts/${contactId}/assistant-sessions/${sessionId}/selections`);
      expect(persistedSelection.status).toBe(200);
      expect(persistedSelection.data).toEqual({ selection: {
        selection_id: selection.selectionId, selection_number: selection.selectionNumber,
        session_id: sessionId, candidate_id: selection.candidateId, version_id: selection.versionId,
      } });
      const observations = await rewriteBackend.command('observations');
      expect((observations.payloads as unknown[]).length).toBe(1);
      const payload = (observations.payloads as Array<Record<string, unknown>>)[0];
      expect(payload).toMatchObject({ input_mode: 'initiate_conversation', confirmed_purpose: purpose });
      expect(payload).not.toHaveProperty('current_text');
      expect(payload).not.toHaveProperty('target_message_id');
      expect((observations.outbound_calls as unknown[]).length).toBe(1);
      const ledger = await control.request('/api/ledger/summary');
      expect(ledger.status).toBe(200); expect(ledger.data.total_calls).toBe(1);
      expect(ledger.data.outcome_counts).toEqual({ succeeded: 1 });
      await evidence(path.join(directory, 'inspect.json'), { runId: coordinator.runId, final, saved,
        versionPages, persistedSelection, observations, ledger, gate: await gate(), identity: await ownIdentity(app, appProcess, userData),
        cua, resourceIndex: await capture.verify([manager, helper]),
        externalModelHTTP: 0, externalMessages: 0, qualification: '脚本模型与所选无SyncControl接线；不证明真实模型语义或微信能力' });
      expect(control.count()).toBe(plan.controlHttpRequests);
      capture.detach();
      // 不可逆停止alive-loop，随后才发布可执行公开菜单退出的就绪状态。
      await coordinator.close(); coordinatorClosed = true;
      await evidence(path.join(directory, 'ready-for-menu-quit.json'), { runId: coordinator.runId,
        pid: appProcess.pid, executable: plan.executable, userData, coordinatorClosed: true,
        instructions: '主Agent只对本轮精确实例通过实际CUA点NotAlone → 退出 NotAlone；不得以app.close/kill代签。' });
      await waitForOriginalExit(appProcess);
      expect(appProcess.exitCode).toBe(0); expect(appProcess.signalCode).toBeNull();
      await evidence(path.join(directory, 'normal-menu-exit.json'), { pid: appProcess.pid,
        exitCode: appProcess.exitCode, signalCode: appProcess.signalCode,
        coordinatorClosedBeforeReady: true, fixtureAndLeaseCleanup: '等待现有fixture/runner finally确认；此文件不是完整收尾通过回执' });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      capture.detach();
      try {
        if (!coordinatorClosed) await coordinator.close().catch(() => {});
        // 此finally仍在fixture的use中，选中的retainUserData保留现场；这里只封存最小合成配置。
        try {
          const profile: unknown[] = [];
          for (const filename of ['backend-launch.json', 'foreground-layout-profile.json']) {
            const input = path.join(userData, filename);
            const stat = await lstat(input).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined; throw error;
            });
            if (!stat) { profile.push({ filename, absent: true }); continue; }
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('自有profile证据身份不符，保留现场');
            const bytes = await readFile(input);
            await writeOriginal(path.join(directory, `owned-profile-${filename}.bytes`), bytes);
            profile.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
          }
          await evidence(path.join(directory, 'profile-before-coordinator-cleanup.json'), { userData, profile,
            rootNames: await readdir(userData), fixtureRetainsUserData: true, recordedBeforeCoordinatorCleanup: true });
        } finally { await control.close(); }
      } finally { await capture.close(primaryError); }
    }
  });
