/** 明确删除时核验并擦除本App可恢复备份；提交后重试Skill文件清单。 */
import {constants} from 'node:fs';
import {open,lstat,readdir,unlink,type FileHandle} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {HostStorage,HostStorageError} from '../platform/database/host-storage.ts';
import {SkillFiles} from '../skills/skill-files.ts';
import {canonicalRoot,checkNoLinks} from '../skills/skill-package.ts';
import {cleanupSkillFiles} from '../skills/skill-cleanup.ts';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const allowed=new Set(['checkpoint.json','database.dump','legacy-launch.json','retired-launch.json','verification.json']);
const fail=():never=>{throw new HostStorageError('update_backup_cleanup_required');};
async function missing(path:string):Promise<boolean>{try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}}
async function privateHandle(path:string,directory:boolean,handles:FileHandle[]):Promise<FileHandle>{
 checkNoLinks(path);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));handles.push(file);
 const stat=await file.stat();if((directory?!stat.isDirectory():!stat.isFile())||stat.uid!==process.getuid?.()||(stat.mode&0o077))fail();
 await unchanged(path,file);return file;
}
async function unchanged(path:string,file:FileHandle):Promise<void>{checkNoLinks(path);const a=await file.stat(),b=await lstat(path);if(a.dev!==b.dev||a.ino!==b.ino||b.isSymbolicLink())fail();}
async function json(path:string,limit:number,handles:FileHandle[]):Promise<Record<string,any>>{
 const file=await privateHandle(path,false,handles);if((await file.stat()).size>limit)fail();const buffer=Buffer.alloc(limit+1);let count=0;while(count<buffer.length){const result=await file.read(buffer,count,buffer.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}if(count>limit)fail();const value=JSON.parse(buffer.subarray(0,count).toString('utf8'));await unchanged(path,file);
 if(!value||typeof value!=='object'||Array.isArray(value))fail();return value;
}
export async function eraseManagedUpdateBackups(client:pg.Client,environment:NodeJS.ProcessEnv):Promise<void>{
 const configured=environment.NOTALONE_MANAGED_USER_DATA;if(!configured)return;
 const handles:FileHandle[]=[];
 try{
  if(!isAbsolute(configured))fail();const root=canonicalRoot(configured);checkNoLinks(root);const metadata=await lstat(root);
  if(!metadata.isDirectory()||metadata.uid!==process.getuid?.()||(metadata.mode&0o022))fail();
  const updates=join(root,'updates');if(await missing(updates))return;
  const updatesHandle=await privateHandle(updates,true,handles),names=await readdir(updates);if(names.length>1024)fail();
  const folders:string[]=[];
  for(const name of names){if(name==='恢复说明.txt')await privateHandle(join(updates,name),false,handles);else if(uuid.test(name))folders.push(name);else fail();}
  if(!folders.length)return;
  const managed=join(root,'managed');await privateHandle(managed,true,handles);const state=await json(join(managed,'state.json'),4096,handles);
  if(state.formatVersion!==1||state.bootstrapComplete!==true)fail();
  if(!(await client.query('SELECT pg_catalog.pg_try_advisory_xact_lock(1852798049,1) AS locked')).rows[0].locked)fail();
  const identity=(await client.query('SELECT system_identifier::text,d.oid,d.datname,d.datdba FROM pg_catalog.pg_control_system(),pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()')).rows[0];
  const fingerprint=createHash('sha256').update(JSON.stringify([identity.system_identifier,identity.oid,identity.datname,identity.datdba])).digest('hex');
  const archives:{path:string;directory:FileHandle;file:FileHandle}[]=[];
  for(const folder of folders){
   const path=join(updates,folder),directory=await privateHandle(path,true,handles),files=await readdir(path);if(files.some(name=>!allowed.has(name)))fail();
   const found=new Map<string,FileHandle>();for(const name of files)found.set(name,await privateHandle(join(path,name),false,handles));
   const checkpoint=await json(join(path,'checkpoint.json'),131072,handles),target=checkpoint.destination_fingerprint??checkpoint.target_fingerprint;
   if(checkpoint.format_version!==1||typeof target!=='string'||!hash.test(target)||target!==fingerprint||checkpoint.phase!=='complete'||checkpoint.restore_verified!==true||checkpoint.connection_gate!==false||(checkpoint.source_gate??false)!==false||('destination_fingerprint' in checkpoint&&checkpoint.activation_complete!==true))fail();
   if(found.has('database.dump'))archives.push({path,directory,file:found.get('database.dump')!});
  }
  // 所有档案归属确认后才擦除；任一失败令调用方事务回滚且原删除键可重试。
  for(const archive of archives){await unchanged(updates,updatesHandle);await unchanged(archive.path,archive.directory);await unchanged(join(archive.path,'database.dump'),archive.file);await unlink(join(archive.path,'database.dump'));await archive.directory.sync();}
  for(const archive of archives)if(!(await missing(join(archive.path,'database.dump'))))fail();
 }catch{fail();}finally{await Promise.allSettled(handles.map(handle=>handle.close()));}
}
/** 只回收隐藏目录，绝不扫描用户工作目录正文。调用方已持有owner锁。 */
export async function queueUnreferencedPreferenceFiles(client:pg.Client,owner:string,files:SkillFiles):Promise<void>{
 if(!uuid.test(owner))throw new HostStorageError('skill_file_cleanup_required');
 const root=canonicalRoot(files.root);
 for(const kind of ['.versions','.staging']){
  const base=join(root,kind,owner);checkNoLinks(base);if(await missing(base))continue;
  for(const skill of await readdir(base)){
   if(!uuid.test(skill))continue;const path=join(base,skill),stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isDirectory())continue;
   if(kind==='.staging'){
    if(!(await client.query('SELECT 1 FROM public.reply_skill_working_copy WHERE skill_id=$1',[skill])).rowCount)await client.query('INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES($1) ON CONFLICT DO NOTHING',[`${kind}/${owner}/${skill}`]);
   }else for(const version of await readdir(path)){
    if(!uuid.test(version))continue;
    if(!(await client.query('SELECT 1 FROM public.reply_skill_version WHERE id=$1 AND skill_id=$2',[version,skill])).rowCount)await client.query('INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES($1) ON CONFLICT DO NOTHING',[`${kind}/${owner}/${skill}/${version}`]);
   }
  }
 }
}
export async function cleanupPreferenceFiles(storage:HostStorage,owner:string):Promise<void>{
 const configured=storage.runtimeEnvironment().NOTALONE_SKILLS_DIR;
 await storage.businessTransaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
  const files=new SkillFiles(configured);await queueUnreferencedPreferenceFiles(client,owner,files);await cleanupSkillFiles(client,owner,files);
  if((await client.query("SELECT 1 FROM public.reply_skill_file_cleanup WHERE split_part(relative_path,'/',1)=$1 OR(split_part(relative_path,'/',1) IN('.versions','.staging') AND split_part(relative_path,'/',2)=$1) LIMIT 1",[owner])).rowCount)throw new HostStorageError('skill_file_cleanup_required');
 });
}
