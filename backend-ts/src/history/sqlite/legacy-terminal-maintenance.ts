import {constants} from 'node:fs';
import {open,realpath,lstat,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {legacyProofDigest,legacyTargetDigest,type LegacyProofContext,type LegacyTerminalProof} from './legacy-terminal-proof.ts';
import {createNativeLegacyProofProvider} from './legacy-terminal-native-proof.ts';

const fail=():never=>{throw new StorageFailure('history_recertify_legacy_intent_invalid');};
export interface LegacyMaintenanceIntent {format:'notalone-legacy-terminal-maintenance-v1';databaseId:string;ownerId:string;contactId:string;
 legacyExecutable:string;currentExecutable:string;proof:LegacyTerminalProof;proofDigest:string}
const sameToken=(a:unknown,b:unknown)=>legacyProofDigest(a)===legacyProofDigest(b);

/** 固定本机维护意图文件；不会从HTTP接收文件位置、读取器或映射。实际证据每次重新获取。 */
export async function loadLocalLegacyProofProvider(options:{userData:string;databaseId:string;currentExecutable:string}){
 const directory=path.join(options.userData,'managed/maintenance'),file=path.join(directory,'legacy-terminal-proof.json');let handle,found=false;
 let directoryHandle;
 try{
  directoryHandle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const directoryStat=await directoryHandle.stat();
  if(!directoryStat.isDirectory()||(directoryStat.mode&0o777)!==0o700||directoryStat.uid!==process.getuid?.()||await realpath(directory)!==directory)fail();
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  found=true;const stat=await handle.stat();
  if(!stat.isFile()||stat.size>262144||(stat.mode&0o777)!==0o600||stat.uid!==process.getuid?.()||stat.nlink!==1||await realpath(file)!==file)fail();
  const bytes=await handle.readFile(),after=await handle.stat();if(stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)fail();
  const intent=JSON.parse(bytes.toString('utf8')) as LegacyMaintenanceIntent;
  if(intent.format!=='notalone-legacy-terminal-maintenance-v1'||intent.databaseId!==options.databaseId||intent.currentExecutable!==options.currentExecutable
   ||intent.ownerId!==intent.proof?.token.owner_id||intent.contactId!==intent.proof?.token.contact_id||intent.proofDigest!==legacyProofDigest(intent.proof)
   ||typeof intent.legacyExecutable!=='string'||!path.isAbsolute(intent.legacyExecutable)||!Array.isArray(intent.proof.keys)||intent.proof.keys.length<1||intent.proof.keys.length>1024)fail();
  // 原子认领后只删除刚读取的同一文件；并发读取者或替换件不能借此被误消费。
  const currentDirectory=await lstat(directory),current=await lstat(file);
  if(currentDirectory.dev!==directoryStat.dev||currentDirectory.ino!==directoryStat.ino||current.dev!==stat.dev||current.ino!==stat.ino||current.isSymbolicLink())fail();
  const claimed=path.join(directory,`.legacy-terminal-proof-${randomUUID()}`);await rename(file,claimed);
  const claim=await lstat(claimed);
  if(!claim.isFile()||claim.dev!==stat.dev||claim.ino!==stat.ino||claim.uid!==stat.uid||(claim.mode&0o777)!==0o600||claim.nlink!==1||claim.size!==stat.size||claim.mtimeMs!==stat.mtimeMs)fail();
  await unlink(claimed);
  const native=createNativeLegacyProofProvider({legacyExecutable:intent.legacyExecutable,currentExecutable:options.currentExecutable});
  return async(context:LegacyProofContext,signal?:AbortSignal):Promise<LegacyTerminalProof>=>{
   if(!sameToken(context.token,intent.proof.token)||context.token.owner_id!==intent.ownerId||context.token.contact_id!==intent.contactId
    ||legacyProofDigest(context.report)!==legacyProofDigest(intent.proof.current.report)
    ||legacyTargetDigest(context.target)!==legacyTargetDigest(intent.proof.current.target)
    ||context.candidates.some(c=>c.report.artifactSha256!==intent.proof.legacy.report.artifactSha256)
    ||legacyProofDigest(context.candidates.map(c=>c.key).sort())!==legacyProofDigest(intent.proof.keys.map(k=>k.from).sort()))fail();
   // 文件只是一次作用域意图；不把磁盘上的旧元数据当作本次活来源证明。
   signal?.throwIfAborted();const proof=await native(context,signal);
   if(proof.legacy.scope.sourceGeneration!==intent.proof.legacy.scope.sourceGeneration
    ||proof.current.scope.sourceGeneration!==intent.proof.current.scope.sourceGeneration)fail();
   return proof;
  };
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&!found)return undefined;throw error;}
 finally{await handle?.close();await directoryHandle?.close();}
}

/** 无效维护意图只阻断遇到旧代次终态的认证；普通后台同步和启动保持可用。 */
export async function loadHostLegacyProofProvider(options:Parameters<typeof loadLocalLegacyProofProvider>[0]){
 try{return await loadLocalLegacyProofProvider(options);}
 catch{return async(_context:LegacyProofContext):Promise<LegacyTerminalProof>=>fail();}
}
