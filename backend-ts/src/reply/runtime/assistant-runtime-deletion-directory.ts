/** 只用于删除：正文清理之前持久化的目录身份允许同op安全续跑，不扩大恢复权限。 */
import {constants,type BigIntStats} from 'node:fs';
import {lstat,open,readdir,realpath,rm,rmdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {ReplyError} from '../generation/reply-contract.ts';

export interface RuntimeDeletionTarget {operation_id:string;owner_id:string;contact_id:string;session_id:string}
interface DirectoryIdentity extends RuntimeDeletionTarget {version:1;dev:string;ino:string;birthtime_ns:string;uid:string}
const fail=():never=>{throw new ReplyError('reply_context_unavailable',409);};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keys=['version','operation_id','owner_id','contact_id','session_id','dev','ino','birthtime_ns','uid'].sort();
function identity(target:RuntimeDeletionTarget,status:BigIntStats):DirectoryIdentity{return {operation_id:target.operation_id,owner_id:target.owner_id,contact_id:target.contact_id,session_id:target.session_id,version:1,dev:String(status.dev),ino:String(status.ino),birthtime_ns:String(status.birthtimeNs),uid:String(status.uid)};}
function same(left:DirectoryIdentity,right:DirectoryIdentity):boolean{return keys.every(key=>left[key as keyof DirectoryIdentity]===right[key as keyof DirectoryIdentity]);}
export function requireRuntimeDeletionIdentity(target:RuntimeDeletionTarget,value:unknown):DirectoryIdentity {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.join())return fail();
 const proof=value as DirectoryIdentity;
 if(proof.version!==1||['operation_id','owner_id','contact_id','session_id'].some(key=>proof[key as keyof DirectoryIdentity]!==target[key as keyof RuntimeDeletionTarget])
  ||[proof.dev,proof.ino,proof.birthtime_ns,proof.uid].some(field=>typeof field!=='string'||!/^\d+$/.test(field)))return fail();
 return proof;
}
async function directory(home:string,target:RuntimeDeletionTarget):Promise<{path:string;status:BigIntStats}|null>{
 if([target.operation_id,target.owner_id,target.contact_id,target.session_id].some(id=>!uuid.test(id)))return fail();
 const root=join(await realpath(home),'assistant-runtime'),parts=[root,join(root,target.owner_id),join(root,target.owner_id,target.contact_id),join(root,target.owner_id,target.contact_id,target.session_id)];
 let last:BigIntStats|undefined;
 for(const path of parts){
  try{last=await lstat(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!last.isDirectory()||last.isSymbolicLink()||(last.mode&0o077n)!==0n||last.uid!==BigInt(process.getuid!())||await realpath(path)!==path)return fail();
 }
 return {path:parts.at(-1)!,status:last!};
}
async function marker(path:string,target:RuntimeDeletionTarget,allowMissing:boolean):Promise<void>{
 let file;
 try{file=await open(join(path,'ownership.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{
  const status=await file.stat({bigint:true});
  if(!status.isFile()||(status.mode&0o077n)!==0n||status.uid!==BigInt(process.getuid!())||status.size>4096n)return fail();
  if(await file.readFile('utf8')!==JSON.stringify({version:1,owner_id:target.owner_id,contact_id:target.contact_id,session_id:target.session_id}))return fail();
 }finally{await file.close();}
}
async function noLinks(path:string):Promise<void>{
 for(const name of await readdir(path)){
  const child=join(path,name),status=await lstat(child,{bigint:true});
  if(status.isSymbolicLink()||status.uid!==BigInt(process.getuid!())||!status.isFile()&&!status.isDirectory())return fail();
  if(status.isDirectory()){if((status.mode&0o077n)!==0n||await realpath(child)!==child)return fail();await noLinks(child);}
 }
}
export async function captureRuntimeDeletionIdentity(home:string,target:RuntimeDeletionTarget):Promise<DirectoryIdentity|null>{
 const before=await directory(home,target);if(!before)return null;
 await marker(before.path,target,false);await noLinks(before.path);
 const after=await directory(home,target);if(!after)return null;
 if(!same(identity(target,before.status),identity(target,after.status)))return fail();
 return identity(target,after.status);
}
export async function eraseRuntimeDeletionDirectory(home:string,target:RuntimeDeletionTarget,value:unknown):Promise<void>{
 const proof=value===null?null:requireRuntimeDeletionIdentity(target,value),current=await directory(home,target);if(!current)return;
 if(!proof||!same(identity(target,current.status),proof))return fail();
 await marker(current.path,target,true);await noLinks(current.path);
 // marker最后移除；此后最终rmdir或提交失败，仍只依赖已独立提交的同op目录身份续跑。
 for(const name of await readdir(current.path))if(name!=='ownership.json')await rm(join(current.path,name),{recursive:true,force:false});
 const final=await directory(home,target);if(!final)return;
 if(!same(identity(target,final.status),proof))return fail();
 await marker(current.path,target,true);
 try{await unlink(join(current.path,'ownership.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await rmdir(current.path);
 if(await directory(home,target)!==null)return fail();
}
