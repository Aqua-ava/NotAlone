import pino from 'pino';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedDiagnosticEvent, checkedDiagnosticRecord, diagnosticEvents } from './unified-contract.mjs';

const MiB = 1024 * 1024;
const observedWriters = new WeakMap();
/** 仅供受信任上下文回放；时间不属于公共事件载荷，也不经 IPC／HTTP 暴露。 */
export function writeObservedDiagnostic(log, input, observedAt) {
  try { observedWriters.get(log)?.(input, observedAt); } catch { /* 内部回放失败不进入业务路径。 */ }
}
const namePattern = /^(main|backend)-(\d{4}-\d{2}-\d{2})-(\d+)\.jsonl$/;
const identity = stat => `${stat.dev}:${stat.ino}`;
const safe = (stat, directory, privateMode = true) => stat.uid === process.getuid?.()
  && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
  && (privateMode ? (stat.mode & 0o777) === (directory ? 0o700 : 0o600) : (stat.mode & 0o022) === 0);
function unavailable() { throw new Error('diagnostic_unavailable'); }
async function statIfPresent(file) { try { return await lstat(file); } catch (error) { if (error?.code === 'ENOENT') return; throw error; } }
async function rootDirectory(root, create) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || await realpath(root) !== root || !safe(await lstat(root), true, false)) unavailable();
  const directory = path.join(root, 'logs');
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await statIfPresent(directory);
  if (!stat) return;
  if (!safe(stat, true)) unavailable();
  return { directory, rootIdentity: identity(await lstat(root)), directoryIdentity: identity(stat) };
}
async function inventory(root, create = false, skipUnavailable = false) {
  const location = await rootDirectory(root, create);
  if (!location) return [];
  const rows = [];
  for (const name of await readdir(location.directory)) {
    const match = namePattern.exec(name);
    if (!match) continue;
    const file = path.join(location.directory, name);
    try {
      const stat = await statIfPresent(file);
      if (!stat) continue;
      if (!safe(stat, false)) unavailable();
      rows.push({ name, file, stat, proc: match[1], day: match[2], number: Number(match[3]) });
    } catch (error) { if (!skipUnavailable) throw error; }
  }
  return rows;
}
async function checkedOpen(file, flags, expected) {
  const handle = await open(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat(), actual = await lstat(file);
    if (!safe(stat, false) || identity(stat) !== identity(actual) || expected && identity(expected) !== identity(stat)) unavailable();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readPrivate(file, maxBytes) {
  const stat = await statIfPresent(file);
  if (!stat) return;
  if (!safe(stat, false) || stat.size > maxBytes) unavailable();
  const handle = await checkedOpen(file, constants.O_RDONLY, stat);
  try {
    const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size || (await handle.stat()).size !== stat.size) unavailable();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
// 活跃日志只取开始读取时已存在的完整行；正常追加不使已读取的时间线失效。
async function readLogSnapshot(file, snapshotBytes) {
  const stat = await statIfPresent(file);
  if (!stat) return;
  if (!safe(stat, false) || stat.size > 5 * MiB) unavailable();
  const limit = Math.min(stat.size, snapshotBytes), handle = await checkedOpen(file, constants.O_RDONLY, stat);
  try {
    const buffer = Buffer.alloc(limit); let length = 0;
    while (length < limit) {
      const { bytesRead } = await handle.read(buffer, length, limit - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat(), current = await statIfPresent(file);
    if (!safe(after, false) || after.size < limit || !current || !safe(current, false) || identity(after) !== identity(current)) unavailable();
    const lastNewline = length ? buffer.lastIndexOf(10, length - 1) : -1;
    return buffer.subarray(0, lastNewline + 1).toString('utf8');
  } finally { await handle.close(); }
}
export async function readDiagnosticRecords(root) {
  try {
    const rows = await inventory(root, false, true), result = [];
    // 只枚举统一日志，不读取专用追踪或用户任意指定的文件。
    let budget = 50 * MiB;
    for (const row of rows.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
      if (row.stat.size > 5 * MiB || row.stat.size > budget) continue;
      budget -= row.stat.size;
      try {
        const text = await readLogSnapshot(row.file, row.stat.size);
        for (const line of (text ?? '').split('\n')) {
          if (!line || Buffer.byteLength(line) > 2048) continue;
          try { const checked = checkedDiagnosticRecord(JSON.parse(line)); if (checked) result.push(checked); } catch { /* 损坏记录不导出。 */ }
        }
      } catch { /* 轮转、清除或单份不可读时仍保留其他安全文件的时间线。 */ }
    }
    return result.sort((a, b) => a.time.localeCompare(b.time));
  } catch { return []; }
}

function aggregateLines(lines) {
  const output = [], positions = new Map();
  for (const line of lines) {
    const record = JSON.parse(line);
    if (!record.traceId || record.level !== 'debug' || !['request.finished', 'sql.summary'].includes(record.event)) { output.push(line); continue; }
    const { time: _time, count: _count, durationMs: _duration, ...scope } = record;
    const key = JSON.stringify(scope), position = positions.get(key);
    if (position === undefined) { positions.set(key, output.length); output.push(record); continue; }
    const previous = output[position], combined = { ...previous, count: (previous.count ?? 1) + (record.count ?? 1),
      ...((previous.durationMs !== undefined || record.durationMs !== undefined) ? { durationMs: (previous.durationMs ?? 0) + (record.durationMs ?? 0) } : {}) };
    if (checkedDiagnosticRecord(combined)) output[position] = combined; else output.push(record);
  }
  return output.map(row => typeof row === 'string' ? row : JSON.stringify(row) + '\n');
}

/** 业务调用仅校验并进入有界内存队列；安全打开、清理和批量写入均异步执行。 */
export class UnifiedDiagnosticLog {
  constructor(root, options = {}) {
    this.root = root; this.proc = options.proc ?? 'backend'; this.development = options.development === true;
    this.maxFileBytes = options.maxFileBytes ?? 5 * MiB;
    // 各进程使用一半独立预算，避免并行轮转争抢另一个进程仍在写的文件。
    this.processBudget = Math.floor((options.maxTotalBytes ?? 50 * MiB) / 2);
    this.maxAgeMs = options.maxAgeMs ?? 14 * 86400_000; this.now = options.now ?? Date.now;
    this.queue = []; this.queuedBytes = 0; this.rejected = 0; this.dropped = 0; this.enabled = true; this.failed = false;
    this.debugUntil = 0; this.scheduled = false; this.closed = false;
    this.logger = pino({ base: null, timestamp: false, level: 'debug', formatters: { level: label => ({ level: label }) } }, { write: line => this.enqueue(line) });
    observedWriters.set(this, (input, observedAt) => this.#diagnoseObserved(input, observedAt));
    this.pending = this.initialize().catch(() => { this.failed = true; });
  }
  async initialize() {
    if (!['main', 'backend'].includes(this.proc) || !Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 256 || this.maxFileBytes > 5 * MiB
      || !Number.isSafeInteger(this.processBudget) || this.processBudget < this.maxFileBytes || this.processBudget > 25 * MiB
      || !Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1 || this.maxAgeMs > 14 * 86400_000) unavailable();
    this.location = await rootDirectory(this.root, true);
    await this.refreshSettings(); await this.prune();
    this.lastWriteDay = new Date(this.now()).toISOString().slice(0, 10);
  }
  async guardLocation() {
    const actual = await rootDirectory(this.root, false);
    if (!actual || actual.rootIdentity !== this.location?.rootIdentity || actual.directoryIdentity !== this.location?.directoryIdentity) unavailable();
    return actual.directory;
  }
  async refreshSettings() {
    const text = await readPrivate(path.join(this.root, 'diagnostic-settings.json'), 512);
    if (text === undefined) { this.enabled = true; return; }
    const value = JSON.parse(text);
    if (!value || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') unavailable();
    this.enabled = value.enabled;
  }
  diagnose(input) {
    try { this.#diagnoseObserved(input, this.now()); } catch { this.dropped++; }
  }
  #diagnoseObserved(input, observedAt) {
    try {
      const event = checkedDiagnosticEvent(input);
      if (!event) { this.rejected++; return; }
      if (!Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > 8640000000000000) { this.rejected++; return; }
      if (this.closed) return;
      const level = diagnosticEvents[event.event].level;
      if (level === 'debug' && !this.development && this.debugUntil <= this.now()) return;
      this.logger[level]({ ...event, time: new Date(observedAt).toISOString(), proc: this.proc });
    } catch { this.dropped++; }
  }
  enqueue(line) {
    const bytes = Buffer.byteLength(line);
    if (bytes > 2048 || this.queue.length >= 2048 || this.queuedBytes + bytes > MiB) { this.dropped++; return; }
    this.queue.push(line); this.queuedBytes += bytes;
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; void this.flush(); }); }
  }
  async prune() {
    await this.guardLocation();
    const rows = (await inventory(this.root)).filter(row => row.proc === this.proc).sort((a, b) => a.day.localeCompare(b.day) || a.number - b.number);
    let total = rows.reduce((sum, row) => sum + row.stat.size, 0);
    for (const row of rows) {
      if (row.stat.mtimeMs < this.now() - this.maxAgeMs || Date.parse(row.day) + 86400_000 < this.now() - this.maxAgeMs || total > this.processBudget) {
        await unlink(row.file); total -= row.stat.size;
      }
    }
  }
  async write(lines) {
    const directory = await this.guardLocation(); await this.refreshSettings();
    if (!this.enabled) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.lastWriteDay !== day) { await this.prune(); this.lastWriteDay = day; }
    let rows = (await inventory(this.root)).filter(row => row.proc === this.proc);
    let current = rows.filter(row => row.day === day).sort((a, b) => b.number - a.number)[0];
    let number = current?.number ?? 1, size = current?.stat.size ?? 0, total = rows.reduce((sum, row) => sum + row.stat.size, 0);
    let index = 0;
    while (index < lines.length) {
      if (Buffer.byteLength(lines[index]) > this.maxFileBytes) { this.dropped++; index++; continue; }
      if (size + Buffer.byteLength(lines[index]) > this.maxFileBytes) { number++; size = 0; current = undefined; await this.prune(); rows = (await inventory(this.root)).filter(row => row.proc === this.proc); total = rows.reduce((sum, row) => sum + row.stat.size, 0); }
      let chunk = '', bytes = 0;
      while (index < lines.length && size + bytes + Buffer.byteLength(lines[index]) <= this.maxFileBytes) {
        bytes += Buffer.byteLength(lines[index]); chunk += lines[index++];
      }
      // 每批追加前预留预算，单份与每进程总量都不会先超限再清理。
      while (total + bytes > this.processBudget && rows.length) {
        const oldest = rows.sort((a, b) => a.day.localeCompare(b.day) || a.number - b.number).shift();
        await unlink(oldest.file); total -= oldest.stat.size;
        if (oldest.day === day && oldest.number === number) { current = undefined; size = 0; number++; }
      }
      const file = path.join(directory, `${this.proc}-${day}-${number}.jsonl`);
      const existing = await statIfPresent(file);
      if (existing && (!safe(existing, false) || existing.size !== size)) unavailable();
      const handle = await checkedOpen(file, constants.O_WRONLY | constants.O_APPEND | (existing ? 0 : constants.O_CREAT | constants.O_EXCL), existing);
      try { await this.guardLocation(); await handle.writeFile(chunk); } finally { await handle.close(); }
      size += bytes; total += bytes;
      const row = rows.find(row => row.file === file);
      if (row) row.stat = { ...row.stat, size }; else rows.push({ file, name: path.basename(file), day, number, proc: this.proc, stat: { size } });
    }
  }

  flush() {
    this.pending = this.pending.then(async () => {
      if (this.closed) { this.queue = []; this.queuedBytes = 0; return; }
      if (this.failed) { await this.initialize(); this.failed = false; }
      const lines = this.queue; this.queue = []; this.queuedBytes = 0;
      if (lines.length) await this.write(aggregateLines(lines));
    }).catch(() => { this.failed = true; this.queue = []; this.queuedBytes = 0; });
    return this.pending;
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return false;
    await this.flush();
    try {
      await this.guardLocation(); const file = path.join(this.root, 'diagnostic-settings.json'), stat = await statIfPresent(file);
      if (stat && !safe(stat, false)) unavailable();
      const temporary = path.join(this.root, `.diagnostic-settings-${randomUUID()}.tmp`);
      const handle = await checkedOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try { await handle.writeFile(JSON.stringify({ enabled })); } finally { await handle.close(); }
      try { await this.guardLocation(); await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
      this.enabled = enabled; return true;
    } catch { this.failed = true; return false; }
  }
  setDebugFor(milliseconds = 30 * 60_000) { this.debugUntil = this.now() + Math.min(Math.max(milliseconds, 0), 30 * 60_000); }
  stats() { return { rejected: this.rejected, dropped: this.dropped, available: !this.failed }; }
  async status() { await this.flush(); try { await this.refreshSettings(); const rows = await inventory(this.root); return { enabled: this.enabled, bytes: rows.reduce((sum, row) => sum + row.stat.size, 0), available: !this.failed }; } catch { return { enabled: this.enabled, bytes: 0, available: false }; } }
  async clear(contactPrefix) {
    if (contactPrefix !== undefined && (typeof contactPrefix !== 'string' || !/^[0-9a-f]{8}$/.test(contactPrefix))) return false;
    return this.#clearRecords(contactPrefix === undefined ? undefined : { field: 'contactPrefix', value: contactPrefix });
  }
  /** 单图片删除只擦除含该文件身份的逐图片事件，保留无图片标识的调用汇总。 */
  async eraseModelImage(imageId) {
    if (typeof imageId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(imageId)) return false;
    return this.#clearRecords({ field: 'imageId', value: imageId, event: 'processing.model_image' });
  }
  async #clearRecords(filter) {
    await this.flush();
    try {
      await this.guardLocation();
      for (const row of await inventory(this.root)) {
        if (filter === undefined) { await unlink(row.file).catch(error => { if (error.code !== 'ENOENT') throw error; }); continue; }
        const original = await readPrivate(row.file, 5 * MiB);
        if (original === undefined) continue;
        const kept = [];
        for (const line of original.split('\n')) {
          if (Buffer.byteLength(line) > 2048) continue;
          try { const record = checkedDiagnosticRecord(JSON.parse(line)); if (record && !(record[filter.field] === filter.value && (!filter.event || record.event === filter.event))) kept.push(JSON.stringify(record) + '\n'); } catch { /* 不重写损坏或越界原文。 */ }
        }
        if (!kept.length) { await unlink(row.file); continue; }
        const handle = await checkedOpen(row.file, constants.O_WRONLY, row.stat);
        try { await handle.truncate(0); await handle.writeFile(kept.join('')); } finally { await handle.close(); }
      }
      return true;
    } catch { this.failed = true; return false; /* 用户操作必须知道清除未完成；下轮写入重新核对。 */ }
  }
  eraseContact(contactPrefix) { return this.clear(contactPrefix); }
  async close() { await this.flush(); this.closed = true; }
}
