/** 只保存进程身份、许可身份与结算未知标记，不保存正文或供应商凭据。 */
import { createServer, connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, readFile, unlink, lstat, open } from 'node:fs/promises';
import { constants, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { captureProcessIdentity, processIdentityState, type ProcessIdentity } from '../process/process-identity.ts';
import type { ModelPermitRecord } from './model-permits.ts';
interface JournalState {
  version: 1; host: ProcessIdentity | null;
  active: ModelPermitRecord[];
  unknown: (ModelPermitRecord & { settlement: 'unknown' })[];
}
function validIdentity(value:ProcessIdentity):boolean {
  return Boolean(value&&Number.isSafeInteger(value.pid)&&value.pid>0&&Number.isSafeInteger(value.parentPid)&&value.parentPid>=0
    &&typeof value.startedAt==='string'&&/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value.startedAt)
    &&typeof value.executable==='string'&&value.executable.startsWith('/')&&!/[\0\r\n]/.test(value.executable));
}
function validateJournal(value:unknown):JournalState {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('model_permit_journal_invalid');
  const state=value as JournalState;
  if(state.version!==1||!Array.isArray(state.active)||!Array.isArray(state.unknown)
    ||state.host!==null&&!validIdentity(state.host))throw new Error('model_permit_journal_invalid');
  for(const item of [...state.active,...state.unknown]){
    if(!item||typeof item.id!=='string'||!['foreground','background'].includes(item.kind)||!validIdentity(item.worker))throw new Error('model_permit_journal_invalid');
  }
  for(const item of state.unknown)if(item.settlement!=='unknown')throw new Error('model_permit_journal_invalid');
  return state;
}
/** 仅在正常DSH启动寿命互斥内调用；不创建、改写journal或申请模型许可。 */
export async function assertModelPermitJournalSettled(path:string):Promise<void> {
  let directory;
  try{directory=await lstat(dirname(path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(!directory.isDirectory()||(directory.mode&0o077)!==0||process.getuid&&directory.uid!==process.getuid())throw new Error('model_permit_directory_not_private');
  let file;
  try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  try{
    const before=await file.stat({bigint:true}),maximum=1048576;
    if(!before.isFile()||(before.mode&0o077n)!==0n||process.getuid&&before.uid!==BigInt(process.getuid())
      ||before.size>BigInt(maximum))throw new Error('model_permit_journal_not_private');
    const buffer=Buffer.alloc(maximum+1);let length=0;
    while(length<buffer.length){const read=await file.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
    const after=await file.stat({bigint:true});
    if(length>maximum||BigInt(length)!==before.size||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)throw new Error('model_permit_journal_changed');
    const state=validateJournal(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length))));
    if(state.host&&await processIdentityState(state.host)!=='gone')throw new Error('model_permit_previous_host_alive_or_unknown');
    if(state.active.length||state.unknown.length)throw new Error('model_permit_fallback_unsettled');
  }finally{await file.close();}
}
function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, {force:true}); }
}
async function removeStaleSocket(path: string) {
  let entry;
  try { entry = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!entry.isSocket()) throw new Error('model_permit_socket_path_occupied');
  const stale = await new Promise<boolean>(resolve => {
    const socket = connect(path);
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(['ECONNREFUSED','ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')));
  });
  if (!stale) throw new Error('model_permit_socket_path_occupied');
  try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function openModelPermitJournal(socketPath: string, statePath?: string) {
  const canonical = join(await realpath(dirname(socketPath)), basename(socketPath));
  const path = statePath ? join(await realpath(dirname(statePath)), basename(statePath)) : `${canonical}.generation`;
  // 与03的短时互斥原理一致；碰撞只会拒绝启动，不接管其他监听者。
  const port = 32768 + createHash('sha256').update(path).digest().readUInt16BE(0) % 16384;
  const lock = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    lock.once('error', reject);
    lock.listen({host:'127.0.0.1',port,exclusive:true}, resolve);
  });
  const release = () => !lock.listening ? Promise.resolve() : new Promise<void>((resolve,reject) => lock.close(error => error ? reject(error) : resolve()));
  const host = await captureProcessIdentity(process.pid, process.ppid, process.execPath).catch(async error => {await release();throw error;});
  let state: JournalState = {version:1,host,active:[],unknown:[]};
  try {
    let previous: JournalState | undefined;
    try { previous = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous !== undefined) {
      previous=validateJournal(previous);
      if (previous.host && await processIdentityState(previous.host) !== 'gone') throw new Error('model_permit_previous_host_alive_or_unknown');
      for (const item of previous.active) {
        if (await processIdentityState(item.worker) !== 'gone') throw new Error('model_permit_previous_worker_alive_or_unknown');
      }
      state.unknown = [...previous.unknown, ...previous.active.map(item => ({...item,settlement:'unknown' as const}))];
      // 只在已取得内核互斥并证明原执行者不再存在后移除旧socket。
      await removeStaleSocket(canonical);
    }
    atomicWrite(path,state);
  } catch (error) { await release(); throw error; }
  let released = false;
  return {
    host,
    unknown: () => structuredClone(state.unknown),
    record(active: ModelPermitRecord[]) { state = {...state,active}; atomicWrite(path,state); },
    async release() {
      if (released) return;
      // 活跃执行者存在时保留原身份；新实例须确认其死亡，不能只看socket已关闭。
      if (!state.active.length) { state = {...state,host:null}; atomicWrite(path,state); }
      await release();
      released = true;
    },
  };
}
