import { execFile, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isolatedAppEnvironment } from './isolated-environment';

// 只接受本轮私有目录中的落盘身份；库名正则不能单独证明归属。
export async function readDatabaseOwnership(directory: string, family: 'core' | 'contact' | 'binding', childPid?: number,
  markerFilename = 'database-ownership.json'): Promise<string> {
  return readOwnership(directory, family, childPid, markerFilename, 'created');
}

// planned 仅用于保留失败证据；不能替代上面的 created 清理授权。
export async function readPlannedDatabaseOwnership(directory: string): Promise<string> {
  return readOwnership(directory, 'contact', undefined, 'database-ownership.json', 'planned');
}

async function readOwnership(directory: string, family: 'core' | 'contact' | 'binding', childPid: number | undefined,
  markerFilename: string, phase: 'planned' | 'created'): Promise<string> {
  if (path.basename(markerFilename) !== markerFilename) throw new Error('本轮归属文件名不得越出夹具目录。');
  const parent = await lstat(directory);
  const marker = path.join(directory, markerFilename);
  const file = await lstat(marker);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0
    || !file.isFile() || file.uid !== parent.uid || (file.mode & 0o777) !== 0o600 || file.size > 4096) {
    throw new Error('本轮数据库归属文件不可核验。');
  }
  const record = JSON.parse(await readFile(marker, 'utf8'));
  const pattern = family === 'core' ? /^notalone_core_flow_[0-9a-f]{32}_test$/
    : family === 'binding' ? /^notalone_binding_[0-9a-f]{32}_test$/ : /^notalone_contact_session_[0-9a-f]{32}_test$/;
  const pid = family === 'core' ? record.child_pid : record.pid;
  if (typeof record.database_name !== 'string' || record.database_name.length > 63 || !pattern.test(record.database_name)
    || !Number.isInteger(pid) || pid <= 0 || (childPid !== undefined && pid !== childPid)
    || (family !== 'core' && (record.version !== 1 || record.phase !== phase))) throw new Error('本轮数据库身份不匹配。');
  return record.database_name;
}

// 原字节只保存在端侧私有证据目录；达到上限时拒绝通过且保留已收集的前缀。
export class FixtureProcessEvidence {
  private readonly chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  private readonly sizes = { stdout: 0, stderr: 0 };
  private overflow = false;
  private closed = false;
  constructor(readonly child: ChildProcess) {
    for (const stream of ['stdout', 'stderr'] as const) child[stream]?.on('data', (value: Buffer) => {
      const bytes = Buffer.from(value);
      const remaining = 4 * 1024 * 1024 - this.sizes[stream];
      if (bytes.length > remaining) this.overflow = true;
      if (remaining > 0) this.chunks[stream].push(bytes.subarray(0, remaining));
      this.sizes[stream] += bytes.length;
    });
    child.once('close', () => { this.closed = true; });
  }
  async archive(directory: string, label: string): Promise<string> {
    for (let count = 0; !this.closed && count < 100; count++) await new Promise((resolve) => setTimeout(resolve, 50));
    const evidence = await archiveFixtureEvidence(directory, label, {
      'original.stdout': Buffer.concat(this.chunks.stdout), 'original.stderr': Buffer.concat(this.chunks.stderr),
    }, { childPid: this.child.pid ?? null, exitCode: this.child.exitCode, signal: this.child.signalCode,
      stdioComplete: this.closed && !this.overflow, streamBytes: this.sizes });
    if (!this.closed || this.overflow) throw new Error(`本轮夹具原始输出不完整，证据已保留：${evidence}`);
    return evidence;
  }
}

export async function archiveFixtureEvidence(directory: string, label: string,
  originals: Record<string, Buffer>, status: Record<string, unknown>): Promise<string> {
  const evidence = await mkdtemp(path.join(tmpdir(), 'notalone-fixture-evidence-'));
  const files: string[] = [];
  const save = async (name: string, bytes: Buffer) => {
    const file = await open(path.join(evidence, name), 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    files.push(name);
  };
  for (const [name, bytes] of Object.entries(originals)) await save(name, bytes);
  for (const name of await readdir(directory)) {
    if (!/^(?:database-ownership\.json|migration-(?:initial|repeat)\.(?:stdout|stderr)|cleanup-unconfirmed\.json)$/.test(name)) continue;
    const source = path.join(directory, name), metadata = await lstat(source);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error('本轮待封存归属证据不可核验。');
    }
    await save(name, await readFile(source));
  }
  await save('index.json', Buffer.from(JSON.stringify({ label, ...status, files })));
  const parent = await open(evidence, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  process.stdout.write(`fixture_evidence: ${JSON.stringify({ label, evidence })}\n`);
  return evidence;
}

export async function confirmDatabaseAbsent(python: string, environment: NodeJS.ProcessEnv, databaseName: string): Promise<void> {
  const checked = await promisify(execFile)(python, ['-c',
    'import sys, psycopg\nwith psycopg.connect("host=/tmp dbname=postgres", connect_timeout=3) as c:\n if c.execute("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)", (sys.argv[1],)).fetchone()[0]: raise RuntimeError("本轮精确库仍存在")\n print("absent")',
    databaseName], { env: environment, timeout: 10_000 });
  if (checked.stdout.trim() !== 'absent') throw new Error('本轮数据库不存在的结果未确认。');
}

// 两个 Core 入口共用安全收尾；具体 stop 命令与准备回执仍由各夹具负责。
export async function cleanupCoreFixture(fixture: {
  directory: string; pythonExecutable: string; child: ChildProcess; cleanup(): Promise<void>;
}, options: {
  label: string; matchesPreparedDatabase(name: string): boolean;
  cleanupConfirmed?: () => void; markerFilename?: string;
  evidence?: FixtureProcessEvidence; preserveDirectory?: boolean;
}): Promise<void> {
  const { directory, pythonExecutable, child } = fixture;
  try {
    await fixture.cleanup();
    const databaseName = await readDatabaseOwnership(directory, 'core', child.pid, options.markerFilename);
    if (!options.matchesPreparedDatabase(databaseName)) throw new Error('本轮准备回执与清理库名不匹配。');
    await confirmDatabaseAbsent(pythonExecutable, isolatedAppEnvironment(directory), databaseName);
    await options.evidence?.archive(directory, options.label);
    if (!options.preserveDirectory) await rm(directory, { recursive: true, force: true });
    options.cleanupConfirmed?.();
  } catch (cause) {
    const databaseName = await readDatabaseOwnership(directory, 'core', child.pid, options.markerFilename).catch(() => null);
    await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({
      childPid: child.pid ?? null, exitCode: child.exitCode, signal: child.signalCode, databaseName,
    }), { mode: 0o600 });
    await options.evidence?.archive(directory, options.label).catch(() => undefined);
    throw new Error(`本轮${options.label}夹具收尾未确认，保留归属记录：${directory}`, { cause });
  }
}
