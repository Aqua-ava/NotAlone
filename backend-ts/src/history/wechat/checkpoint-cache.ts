import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import type {HistoryScope} from '../sqlite/contracts.ts';

const hash=(...parts:string[])=>createHash('sha256').update(parts.join('\0')).digest('hex');
const digest=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9-]{36}$/;
const fail=():never=>{throw new StorageFailure('history_checkpoint_invalid');};
interface Binding {format:'notalone-checkpoint-binding-v1';ownerId:string;contactId:string;generation:string;scopes:string[]}
/** 派生页索引的删除登记不依赖当前读取授权；普通关闭保留，联系人／来源删除先排空读者再清理。 */
export class WechatHistoryCheckpointCache {
 readonly #root?:string;readonly #owner:string;readonly #storage:SqliteStorage;readonly #holders:ActiveHolders;
 readonly #stop:(contactId:string)=>Promise<void>;
 readonly #registered=new Map<string,{generation:string;release:()=>Promise<void>}>();
 constructor(storage:SqliteStorage,owner:string,holders:ActiveHolders,executable:string|undefined,stop:(contactId:string)=>Promise<void>){
  this.#storage=storage;this.#owner=owner;this.#holders=holders;this.#stop=stop;
  if(executable)this.#root=path.join(path.dirname(path.dirname(path.dirname(executable))),'wechat-history-checkpoints');
 }
 async #directory(dir:string,create=false):Promise<boolean>{
  if(create)await mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const st=await lstat(dir).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!st)return false;
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o777)!==0o700||st.uid!==process.getuid?.())fail();return true;
 }
 #bindingPath(contactId:string,ownerId=this.#owner){return path.join(this.#root!,'bindings',hash(ownerId,contactId)+'.json');}
 async #read(file:string):Promise<Binding|null>{
  const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!f)return null;
  try{
   const st=await f.stat();if(!st.isFile()||(st.mode&0o777)!==0o600||st.uid!==process.getuid?.()||st.size>16384)fail();
   const bytes=Buffer.alloc(16385);let count=0;for(;;){const r=await f.read(bytes,count,bytes.length-count,count);count+=r.bytesRead;if(!r.bytesRead||count===bytes.length)break;}
   const after=await f.stat();if(count>16384||count!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs)fail();
   const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count))) as Binding;
   if(!row||row.format!=='notalone-checkpoint-binding-v1'||!uuid.test(row.ownerId)||!uuid.test(row.contactId)||typeof row.generation!=='string'||!/^[0-9]+$/.test(row.generation)||!Array.isArray(row.scopes)||row.scopes.length>128||row.scopes.some(s=>!digest.test(s))||new Set(row.scopes).size!==row.scopes.length||Object.keys(row).sort().join(',')!=='contactId,format,generation,ownerId,scopes')fail();
   if(path.basename(file)!==hash(row.ownerId,row.contactId)+'.json')fail();return row;
  }finally{await f.close();}
 }
 #register(contactId:string,generation:string){
  const old=this.#registered.get(contactId);if(old){if(old.generation!==generation)fail();return;}
  const release=this.#holders.register({key:`history:checkpoint_${contactId}_${generation}`,ownerId:this.#owner,contactId,generation:BigInt(generation),coversAllSources:true,close:async()=>{
   await this.#stop(contactId);await this.#forgetFiles(contactId);this.#registered.delete(contactId);
  }});this.#registered.set(contactId,{generation,release});
 }
 async initialize():Promise<void>{
  if(!this.#root)return;
  const contacts=await this.#storage.execute<{contactId:string;generation:string}[]>('history.checkpointContacts',{ownerId:this.#owner});
  for(const row of contacts)this.#register(row.contactId,row.generation);
  if(!await this.#directory(this.#root)||!await this.#directory(path.join(this.#root,'bindings')))return;
  const live=new Map(contacts.map(row=>[row.contactId,row.generation])),files=await readdir(path.join(this.#root,'bindings'));if(files.length>10000)fail();
  for(const name of files){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const record=await this.#read(path.join(this.#root,'bindings',name));if(record&&(record.ownerId!==this.#owner||live.get(record.contactId)!==record.generation))await this.#forgetFiles(record.contactId,record.ownerId);}
 }
 async track(scope:HistoryScope):Promise<void>{
  if(!this.#root)return;
  if(scope.token.owner_id!==this.#owner||!uuid.test(scope.token.contact_id))fail();
  this.#register(scope.token.contact_id,scope.token.data_generation);
  await this.#directory(this.#root,true);await this.#directory(path.join(this.#root,'bindings'),true);
  const file=this.#bindingPath(scope.token.contact_id),prior=await this.#read(file),source=hash(scope.accountKey,scope.conversationKey);
  if(prior&&(prior.ownerId!==this.#owner||prior.contactId!==scope.token.contact_id))fail();
  if(prior&&prior.generation!==scope.token.data_generation)fail();if(prior?.scopes.includes(source))return;
  const scopes=[...(prior?.scopes??[]),source];if(scopes.length>128)fail();
  const record:Binding={format:'notalone-checkpoint-binding-v1',ownerId:this.#owner,contactId:scope.token.contact_id,generation:scope.token.data_generation,scopes};
  const pending=file+'.'+randomUUID()+'.pending',handle=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}
  await rename(pending,file);const dir=await open(path.dirname(file),constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}finally{await unlink(pending).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
 async #syncDirectories(){for(const selected of [this.#root!,path.join(this.#root!,'bindings')]){const dir=await open(selected,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}}
 async #forgetFiles(contactId:string,ownerId=this.#owner):Promise<void>{
  if(!this.#root||!await this.#directory(this.#root)||!await this.#directory(path.join(this.#root,'bindings')))return;
  const file=this.#bindingPath(contactId,ownerId),binding=await this.#read(file);
  for(const name of await readdir(path.dirname(file))){if(!new RegExp('^'+hash(ownerId,contactId)+'\\.[a-f0-9-]{36}\\.pending$').test(name))continue;const pending=path.join(path.dirname(file),name),st=await lstat(pending);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||st.uid!==process.getuid?.())fail();await unlink(pending);}
  if(!binding){await this.#syncDirectories();return;}
  if(binding.ownerId!==ownerId||binding.contactId!==contactId)fail();
  const names=await readdir(this.#root);if(names.length>30000)fail();
  for(const name of names){if(!binding.scopes.some(scope=>new RegExp('^'+scope+'-(?:[a-f0-9]{64}\\.json|\\.pending-[A-Za-z0-9]+)$').test(name)))continue;
   const selected=path.join(this.#root,name),st=await lstat(selected);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||st.uid!==process.getuid?.())fail();await unlink(selected);
  }
  await unlink(file);
  await this.#syncDirectories();
 }
 async forget(contactId:string):Promise<void>{const held=this.#registered.get(contactId);if(held)await held.release();else{await this.#stop(contactId);await this.#forgetFiles(contactId);}}
}
