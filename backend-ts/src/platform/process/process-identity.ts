/** 只读核验进程实例，避免把已复用的 PID 当作本轮后台发送信号。 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export interface ProcessIdentity { pid: number; parentPid: number; startedAt: string; executable: string }
async function inspect(pid: number): Promise<(ProcessIdentity & { zombie: boolean }) | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('process_identity_invalid');
  try {
    const { stdout } = await execute('/bin/ps', ['-ww','-p',String(pid),'-o','pid=,ppid=,lstart=,stat=,comm='], {
      encoding:'utf8',timeout:2000,maxBuffer:8192,env:{LC_ALL:'C',PATH:'/usr/bin:/bin'},
    });
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/.exec(stdout);
    if (!match || Number(match[1]) !== pid) throw new Error('process_identity_unknown');
    // macOS 僵尸的 comm 为 <defunct>；先核对完整行与 PID，再保留存活进程的绝对路径门禁。
    const zombie = match[4].includes('Z');
    if (!zombie && !match[5].startsWith('/')) throw new Error('process_identity_unknown');
    return {pid,parentPid:Number(match[2]),startedAt:match[3].replace(/\s+/g,' '),executable:match[5],zombie};
  } catch (error) {
    try { process.kill(pid,0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') return undefined; }
    throw new Error('process_identity_unknown');
  }
}
export async function captureProcessIdentity(pid: number, parentPid: number, executable: string): Promise<ProcessIdentity> {
  const identity = await inspect(pid);
  if (!identity || identity.zombie || identity.parentPid !== parentPid || await realpath(identity.executable) !== await realpath(executable)) throw new Error('process_identity_unknown');
  return {pid:identity.pid,parentPid:identity.parentPid,startedAt:identity.startedAt,executable:identity.executable};
}
export async function processIdentityState(identity: ProcessIdentity): Promise<'same'|'gone'|'unknown'> {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !Number.isSafeInteger(identity.parentPid)
    || typeof identity.startedAt !== 'string' || !identity.startedAt || typeof identity.executable !== 'string' || !identity.executable.startsWith('/')) return 'unknown';
  try {
    const current = await inspect(identity.pid);
    if (!current || current.zombie) return 'gone';
    // 父进程退出后允许被系统收养；启动时间及可执行文件仍须是同一实例。
    return current.startedAt === identity.startedAt && current.executable === identity.executable ? 'same' : 'gone';
  } catch { return 'unknown'; }
}
