/** 受管目录边界与自身运行产物识别：只把固定位置的 SQLite 宿主握手与启动锁标为 confirmed；未识别的受管条目保持 unknown 并阻断启动。 */
import { constants } from 'node:fs';
import { lstatSync, openSync, closeSync, readSync, readdirSync } from 'node:fs';
import { sha256 } from '../../platform/sha256.ts';
import path from 'node:path';
import type { LegacyTarget, LegacyTargetKind, Ownership, WriterCheckRecord } from './contracts.ts';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identifiers = /^[a-zA-Z0-9_-]{1,128}$/;
export class LegacyTargetError extends Error {
  readonly code = 'cutover_legacy_target_unclassified';
  readonly detail: string;
  constructor(detail: string) { super(detail); this.name = 'LegacyTargetError'; this.detail = detail; }
}

function item(location: string) {
  try { return lstatSync(location, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function privateStat(location: string, kind: 'file' | 'directory') {
  const entry = item(location);
  if (!entry) return undefined;
  if (entry.isSymbolicLink() || (kind === 'file' ? !entry.isFile() : !entry.isDirectory())
    || entry.uid !== BigInt(process.getuid!()) || (entry.mode & 0o077n) !== 0n || (kind === 'file' && entry.nlink !== 1n)) return 'unsafe' as const;
  return entry;
}
/** 只读取证明归属所需的最小字节；调用方不得记录返回内容。 */
function privateText(location: string, limit: number): string | undefined {
  const entry = privateStat(location, 'file');
  if (!entry) return undefined;
  if (entry === 'unsafe' || entry.size > BigInt(limit)) throw new LegacyTargetError('private_file_state');
  const fd = openSync(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > limit) throw new LegacyTargetError('private_file_state');
    return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
export function targetId(kind: LegacyTargetKind, locator: string): string {
  return sha256(`${kind}:${locator}`).slice(0, 32);
}
function target(kind: LegacyTargetKind, locator: string, ownership: Ownership, evidence: string): LegacyTarget {
  return { id: targetId(kind, locator), kind, locator, ownership, evidence, state: 'pending', attempts: 0 };
}
/** 只识别固定私有维护意图的归属；真实性与授权仍由宿主读取器及认证事务核验。 */
function ownedHistoryMaintenance(userData:string):boolean {
 try{
  const directory=path.join(userData,'managed/maintenance'),entry=privateStat(directory,'directory');
  if(!entry||entry==='unsafe'||(entry.mode&0o777n)!==0o700n)return false;
  const names=readdirSync(directory);if(!names.length)return true;
  if(names.length!==1||names[0]!=='legacy-terminal-proof.json')return false;
  const location=path.join(directory,names[0]),file=privateStat(location,'file');
  if(!file||file==='unsafe'||(file.mode&0o777n)!==0o600n)return false;
  const row=JSON.parse(privateText(location,262144)??'');
  if(!row||Array.isArray(row)||Object.keys(row).sort().join(',')!==['format','databaseId','ownerId','contactId','legacyExecutable','currentExecutable','proof','proofDigest'].sort().join(',')
   ||row.format!=='notalone-legacy-terminal-maintenance-v1'||typeof row.databaseId!=='string'||!identifiers.test(row.databaseId)
   ||typeof row.ownerId!=='string'||!UUID.test(row.ownerId)||typeof row.contactId!=='string'||!UUID.test(row.contactId)
   ||typeof row.legacyExecutable!=='string'||!path.isAbsolute(row.legacyExecutable)||typeof row.currentExecutable!=='string'||!path.isAbsolute(row.currentExecutable)
   ||typeof row.proofDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.proofDigest))return false;
  const proof=row.proof;
  if(!proof||proof.format!=='notalone-legacy-recall-mapping-v1'||proof.token?.owner_id!==row.ownerId||proof.token?.contact_id!==row.contactId
   ||!Number.isSafeInteger(proof.observedAt)||proof.observedAt<0||!Array.isArray(proof.keys)||!proof.keys.length||proof.keys.length>1024
   ||[proof.legacy,proof.current].some(reader=>!reader||['scope','schema','report','target'].some(key=>!reader[key]||typeof reader[key]!=='object'||Array.isArray(reader[key]))))return false;
  for(const mapping of proof.keys){
   if(!mapping||mapping.reason!=='source_recalled'||typeof mapping.from!=='string'||typeof mapping.to!=='string')return false;
   const from=JSON.parse(mapping.from),to=JSON.parse(mapping.to);
   if(!Array.isArray(from)||from.length!==4||from.some(value=>typeof value!=='string'||!value)||!Array.isArray(to)||to.length!==4||to.some(value=>typeof value!=='string'||!value)
    ||JSON.stringify(from)!==mapping.from||JSON.stringify(to)!==mapping.to||from[0]===to[0]||JSON.stringify(from.slice(1))!==JSON.stringify(to.slice(1))
    ||!/^(0|[1-9][0-9]{0,19})$/.test(from[3])||BigInt(from[3])>18446744073709551615n)return false;
  }
  const canonical=JSON.stringify(proof,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value);
  return sha256(canonical)===row.proofDigest;
 }catch{return false;}
}
/** 当前存储目录只接受已知 SQLite 与通用维护产物；未知对象保留现场，不解析或代为清除。 */
export function unrecognizedManagedTargets(userData: string): LegacyTarget[] {
  const directory = path.join(userData, 'managed');
  const entry = privateStat(directory, 'directory');
  if (!entry) return [];
  if (entry === 'unsafe') return [target('legacy_unrecognized_managed', 'managed', 'unknown', 'unsafe_directory_state')];
  const names = readdirSync(directory).sort();
  if (names.length > 1024) return [target('legacy_unrecognized_managed', 'managed', 'unknown', 'unexpected_entry_count')];
  // updates、import-pending.json、backend.info* 是已退役写入器与更新备份留下的名称：只容忍其存在，不解析、不清理、不授予删除权限。
  const supported = new Set(['sqlite', 'media', 'runtime-copies', 'cache', 'updates', 'import-pending.json', 'backend.info', 'backend.info.dsh-lock',
    'sqlite-backend.info', 'sqlite-backend.info.dsh-lock',
    // 启动失败时由后台写入的固定诊断记录（见 startup-diagnostics.ts）；不认识它会让一次失败的启动永久阻断之后的启动。
    'backend.info.startup-diagnostic.json', 'sqlite-backend.info.startup-diagnostic.json']);
  if(names.includes('maintenance')&&ownedHistoryMaintenance(userData))supported.add('maintenance');
  return names.filter(name => !supported.has(name)).map(name =>
    target('legacy_unrecognized_managed', `managed/${name}`, 'unknown', 'unsupported_managed_entry'));
}
/** 本应用自身 SQLite 宿主的握手与启动锁；只有这两个固定位置属于可清理的运行产物。 */
const RUNTIME_ARTIFACTS: ReadonlyArray<readonly [string, LegacyTargetKind, string]> = [
  ['managed/sqlite-backend.info', 'runtime_handshake', 'writer_handshake'],
  ['managed/sqlite-backend.info.dsh-lock', 'runtime_launch_lock', 'launcher_lock'],
];

/** 发现自身运行产物；不读取正文，不跟随符号链接，不删除任何对象。 */
export function discoverRuntimeTargets(userData: string): LegacyTarget[] {
  const result: LegacyTarget[] = [];
  for (const [locator, kind, evidence] of RUNTIME_ARTIFACTS) {
    const entry = privateStat(path.join(userData, locator), 'file');
    if (!entry) continue;
    result.push(entry === 'unsafe' ? target(kind, locator, 'unknown', 'unsafe_file_state') : target(kind, locator, 'confirmed', evidence));
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function handshakePid(userData: string, locator: string): number | undefined {
  try {
    const text = privateText(path.join(userData, locator), 4096);
    if (text === undefined) return undefined;
    const match = /^pid=([1-9][0-9]{0,9})$/m.exec(text);
    if (!match) throw new LegacyTargetError('handshake_shape');
    return Number(match[1]);
  } catch { return undefined; }
}
function lockPids(userData: string, locator: string): { parentPid?: number; childPid?: number } | undefined {
  try {
    const text = privateText(path.join(userData, locator), 4096);
    if (text === undefined) return undefined;
    const value = JSON.parse(text) as Record<string, unknown>;
    const pid = (raw: unknown) => typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
    const parentPid = pid(value.parentPid), childPid = pid(value.childPid);
    if (parentPid === undefined && childPid === undefined) throw new LegacyTargetError('lock_shape');
    return { parentPid, childPid };
  } catch { return undefined; }
}
/** 只读取并判断自身运行产物对应的进程是否仍存活；绝不终止未知进程。 */
export function checkRuntimeWriters(userData: string): WriterCheckRecord[] {
  const records: WriterCheckRecord[] = [];
  const lock = 'managed/sqlite-backend.info.dsh-lock';
  if (item(path.join(userData, lock)) !== undefined) {
    const pids = lockPids(userData, lock);
    const state = pids === undefined ? 'unknown' : (pids.parentPid !== undefined && pidAlive(pids.parentPid)) || (pids.childPid !== undefined && pidAlive(pids.childPid)) ? 'running' : 'stopped';
    records.push({ name: 'runtime_launch_lock', locator: lock, state });
  }
  const handshake = 'managed/sqlite-backend.info';
  if (item(path.join(userData, handshake)) !== undefined) {
    const pid = handshakePid(userData, handshake);
    records.push({ name: 'new_host_handshake', locator: handshake, state: pid === undefined ? 'unknown' : pidAlive(pid) ? 'running' : 'stopped' });
  }
  return records;
}

/** 供启动编排复用的路径核验：userData 必须是私有真实目录。 */
export function assertPrivateUserData(userData: string): void {
  if (!path.isAbsolute(userData)) throw new LegacyTargetError('user_data_not_absolute');
  const entry = item(userData);
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== BigInt(process.getuid!()) || (entry.mode & 0o022n) !== 0n) throw new LegacyTargetError('user_data_not_private');
}
