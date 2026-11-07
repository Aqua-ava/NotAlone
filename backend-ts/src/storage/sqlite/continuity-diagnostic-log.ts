import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { StorageFailure } from './contracts.ts';

interface DiagnosticEvent { entry: string; contactPrefix: string; branch: string; errorCode?: string }
interface DiagnosticRecord extends DiagnosticEvent { time: string }
interface TestBudgets { maxBytes?: number; maxAgeMs?: number }
type Identity = { dev: number; ino: number };
const defaultBytes = 1024 * 1024, defaultAgeMs = 7 * 86400_000;
const entries = new Set(['history.readPreflight', 'history.preflightGeneration', 'history.preflightContinuity',
  'history.guardAcquire', 'history.prepareNormalUseGuard', 'history.prepareRecoveredGuard', 'history.guardRelease', 'history.markContinuityLost',
  'history.emptyTargetProbeVerify', 'history.recertifyFail', 'history.recertifyNoteFailure']);
const branches = new Set(['G01', 'G02', 'G03', 'G04', 'T01', 'T02', 'T03', 'N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07', 'A01', 'A02', 'R01', 'R02', 'L01', 'C01']);
const lostCodes = new Set(['history_account_changed', 'history_source_changed', 'history_source_unverified', 'history_external_scope_changed',
  'history_scope_changed', 'history_schema_changed', 'history_shards_changed', 'history_cursor_scope_changed',
  'history_support_changed', 'history_target_unverified', 'history_quote_source_changed']);
const fail = (): never => { throw new StorageFailure('history_continuity_diagnostic_unavailable'); };
const same = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const prefixValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}$/.test(value);

function checkedEvent(value: unknown, stored = false): DiagnosticEvent {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return fail();
  const fields = Object.getOwnPropertyDescriptors(value), allowed = ['entry', 'contactPrefix', 'branch', 'errorCode', ...(stored ? ['time'] : [])];
  if (Object.keys(fields).some(key => !allowed.includes(key) || !('value' in fields[key]))) return fail();
  const entry = fields.entry?.value, contactPrefix = fields.contactPrefix?.value, branch = fields.branch?.value, errorCode = fields.errorCode?.value;
  if (!entries.has(entry) || !prefixValid(contactPrefix) || !branches.has(branch)
    || errorCode !== undefined && !lostCodes.has(errorCode)) return fail();
  return { entry, contactPrefix, branch, ...(errorCode === undefined ? {} : { errorCode }) };
}

/** 仅存来源失证的固定诊断字段；所有文件操作有界，异常不携带路径、正文或原始错误。 */
export class ContinuityDiagnosticLog {
  private readonly userData: string;
  private readonly directory: string;
  private readonly locations: string[];
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private rootIdentity?: Identity;
  private directoryIdentity?: Identity;

  // 构造不访问文件；宿主启动时显式 prune，诊断不可用不阻止业务启动。
  constructor(userData: string, options: TestBudgets = {}) {
    if (typeof userData !== 'string' || !path.isAbsolute(userData) || path.normalize(userData) !== userData
      || Object.keys(options).some(key => !['maxBytes', 'maxAgeMs'].includes(key))) fail();
    this.userData = userData;
    this.directory = path.join(userData, 'logs');
    this.locations = Array.from({ length: 4 }, (_, i) => path.join(this.directory, 'history-continuity.jsonl' + (i ? `.${i}` : '')));
    this.maxBytes = options.maxBytes ?? defaultBytes;
    this.maxAgeMs = options.maxAgeMs ?? defaultAgeMs;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 128 || this.maxBytes > defaultBytes
      || !Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1 || this.maxAgeMs > defaultAgeMs) fail();
  }

  private guarded(work: () => void): void { try { work(); } catch { fail(); } }
  private checkStat(stat: Stats, directory: boolean, privateMode = true): void {
    if (stat.uid !== process.getuid?.() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      || (privateMode ? (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) : (stat.mode & 0o022) !== 0)) fail();
  }
  private fileStat(location: string, allowOversize = false): Stats | undefined {
    let stat: Stats;
    try { stat = lstatSync(location); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    this.checkStat(stat, false);
    if (!allowOversize && stat.size > this.maxBytes) fail();
    return stat;
  }
  private ready(create: boolean, allowOversize = false): boolean {
    if (realpathSync(this.userData) !== this.userData) fail();
    const root = lstatSync(this.userData);
    this.checkStat(root, true, false);
    if (this.rootIdentity && !same(root, this.rootIdentity)) fail();
    if (create) {
      try { mkdirSync(this.directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    let directory: Stats;
    try { directory = lstatSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    this.checkStat(directory, true);
    if (this.directoryIdentity && !same(directory, this.directoryIdentity)) fail();
    this.rootIdentity = root;
    this.directoryIdentity = directory;
    // 先核对全部四个固定路径，再执行任何删除或轮转；不枚举其他应用日志。
    for (const location of this.locations) this.fileStat(location, allowOversize);
    return true;
  }
  private opened<T>(location: string, flags: number, work: (fd: number, stat: Stats) => T): T {
    const expected = this.fileStat(location), fd = openSync(location, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      this.checkStat(stat, false);
      if (stat.size > this.maxBytes || expected && !same(expected, stat) || !same(lstatSync(location), stat)) return fail();
      return work(fd, stat);
    } finally { closeSync(fd); }
  }
  private read(location: string): string {
    return this.opened(location, constants.O_RDONLY, (fd, stat) => {
      // 即使核验后文件被扩大，也最多读取已核验大小加一个字节。
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0, count: number;
      while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += count;
      if (length > stat.size || fstatSync(fd).size !== stat.size) return fail();
      return bytes.subarray(0, length).toString('utf8');
    });
  }
  private records(text: string): DiagnosticRecord[] {
    const result: DiagnosticRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const raw = JSON.parse(line), event = checkedEvent(raw, true), time = raw.time;
        if (typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)
          || new Date(time).toISOString() !== time) continue;
        result.push({ time, ...event });
      } catch { /* 损坏或含额外字段的旧记录直接丢弃，不把原文带入新日志。 */ }
    }
    return result;
  }
  private rewrite(location: string, records: DiagnosticRecord[]): void {
    if (!records.length) { unlinkSync(location); return; }
    const bytes = Buffer.from(records.map(record => JSON.stringify(record) + '\n').join(''));
    if (bytes.length > this.maxBytes) fail();
    this.opened(location, constants.O_WRONLY, fd => {
      ftruncateSync(fd, 0);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    });
  }

  append(input: DiagnosticEvent): void {
    this.guarded(() => {
      const event = checkedEvent(input), bytes = Buffer.from(JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
      if (bytes.length > this.maxBytes) fail();
      this.prune();
      this.ready(true);
      const current = this.locations[0];
      if ((this.fileStat(current)?.size ?? 0) + bytes.length > this.maxBytes) {
        const last = this.locations[3];
        if (this.fileStat(last)) unlinkSync(last);
        for (let i = 2; i >= 0; i--) if (this.fileStat(this.locations[i])) renameSync(this.locations[i], this.locations[i + 1]);
      }
      const flags = this.fileStat(current) ? constants.O_WRONLY | constants.O_APPEND : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
      this.opened(current, flags, (fd, stat) => {
        if (stat.size + bytes.length > this.maxBytes) fail();
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      });
    });
  }
  erase(contactPrefix?: string): void {
    this.guarded(() => {
      if (contactPrefix !== undefined && !prefixValid(contactPrefix)) fail();
      if (!this.ready(false, contactPrefix === undefined)) return;
      for (const location of this.locations) {
        if (!this.fileStat(location, contactPrefix === undefined)) continue;
        if (contactPrefix === undefined) unlinkSync(location);
        else this.rewrite(location, this.records(this.read(location)).filter(record => record.contactPrefix !== contactPrefix));
      }
    });
  }
  prune(): void {
    this.guarded(() => {
      if (!this.ready(false)) return;
      const cutoff = Date.now() - this.maxAgeMs;
      for (const location of this.locations) {
        const stat = this.fileStat(location);
        if (!stat) continue;
        if (stat.mtimeMs < cutoff) { unlinkSync(location); continue; }
        const text = this.read(location), kept = this.records(text).filter(record => Date.parse(record.time) >= cutoff);
        if (kept.map(record => JSON.stringify(record) + '\n').join('') !== text) this.rewrite(location, kept);
      }
    });
  }
}
