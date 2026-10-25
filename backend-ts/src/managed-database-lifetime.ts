/** Darwin open(2) 的 flock 兼容锁；与旧后台使用同一私有寿命文件。 */
import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
export class ManagedLifetimeError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;this.name='ManagedLifetimeError';}}
export async function openManagedLifetimeFile(path:string,lock?:'shared'|'exclusive',create=false):Promise<FileHandle>{
 if(process.platform!=='darwin')throw new ManagedLifetimeError('managed_lifetime_unsupported');
 if(!isAbsolute(path)||/[\0\r\n]/.test(path))throw new ManagedLifetimeError('managed_lifetime_invalid');
 // Apple open(2)；Darwin SDK sys/fcntl.h。其他平台不得套用这些数值。
 const flags=constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK|(create?constants.O_CREAT|constants.O_EXCL:0)|(lock==='shared'?0x10:lock==='exclusive'?0x20:0);
 let file:FileHandle|undefined;
 try{
  file=await open(path,flags,0o600);const metadata=await file.stat();
  if(!metadata.isFile()||(metadata.mode&0o077)!==0||process.getuid&&metadata.uid!==process.getuid())throw new ManagedLifetimeError('managed_lifetime_invalid');
  return file;
 }catch(error){await file?.close();if(error instanceof ManagedLifetimeError)throw error;throw new ManagedLifetimeError(['EWOULDBLOCK','EAGAIN'].includes((error as NodeJS.ErrnoException).code??'')?'managed_lifetime_busy':'managed_lifetime_invalid');}
}
export async function acquireManagedDatabaseLease(path:string):Promise<()=>Promise<void>>{
 const file=await openManagedLifetimeFile(path,'shared');let closing:Promise<void>|undefined;
 return ()=>closing??=file.close();
}
