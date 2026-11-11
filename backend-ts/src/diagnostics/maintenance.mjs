import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Apple open(2)的原子排他flock；本机SDK sys/fcntl.h 的 O_EXLOCK=0x20。
// https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html
const darwinExclusiveLock=0x20;
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
/** 固定空文件永不删除；句柄关闭或进程崩溃时由内核释放，不接管PID租约。 */
export async function withDiagnosticLock(root,guard,work,timeoutMs=2000){
 if(process.platform!=='darwin')throw new Error('diagnostic_lock_unavailable');
 const deadline=performance.now()+timeoutMs;
 for(;;){
  const directory=await guard(),rootStat=await lstat(root);
  if(!rootStat.isDirectory()||rootStat.uid!==process.getuid?.()||(rootStat.mode&0o777)!==0o700)throw new Error('diagnostic_lock_unavailable');
  const file=path.join(directory,'diagnostic-maintenance.lock');let handle;
  try{
   handle=await open(file,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK|darwinExclusiveLock,0o600);
   const stat=await handle.stat(),actual=await lstat(file);
   if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size!==0||!same(stat,actual)||directory!==await guard())throw new Error('diagnostic_lock_unavailable');
   return await work();
  }catch(error){
   if(handle||!['EAGAIN','EWOULDBLOCK'].includes(error?.code)||performance.now()>=deadline)throw new Error('diagnostic_lock_unavailable');
  }finally{await handle?.close();}
  // 非阻塞open失败后异步有界退让，不占住libuv线程等待另一个写者。
  await delay(Math.min(10,Math.max(1,deadline-performance.now())));
 }
}
