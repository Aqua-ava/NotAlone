import {randomUUID} from 'node:crypto';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../../storage/sqlite/deletion/service.ts';
import type {ManagedAddress,DeletionSnapshot} from '../../storage/sqlite/deletion/contracts.ts';
import {MediaFiles} from './files.ts';
import type {AttemptHandle} from './actions.ts';
import type {MediaAdapter,MediaGoal,MediaSnapshot,MediaPreview,MediaValidation,MediaContactPort,MediaSourcePort} from './contracts.ts';
export interface MediaServiceOptions {storage:SqliteStorage;contacts:MediaContactPort;history:MediaSourcePort;userData:string;adapters:readonly MediaAdapter[];holders?:ActiveHolders;deletion?:DeletionService}
interface FileReference {fileId:string;generation:string;dataGeneration:string;address:ManagedAddress;mimeType:string;byteSize:string;digest:string;viewable:boolean;playable:boolean}
interface Begin {reused:boolean;cleanupRequired?:boolean;attemptId:string;dataGeneration:string;leaseToken?:string;recordId?:string;inputFile?:{fileId:string;address:ManagedAddress;byteSize:string;digest:string}|null;token?:any}
interface PreviewSession {state:'active'|'revoking';release:()=>Promise<void>;ack:()=>void;contactId:string;messageId:string}
export class SqliteMediaService {
 private readonly options:MediaServiceOptions;
 readonly holders:ActiveHolders;
 readonly files:MediaFiles;
 readonly deletion:DeletionService;
 private readonly active=new Map<string,{controller:AbortController;done:Promise<void>;contactId:string}>();
 private readonly previews=new Map<string,PreviewSession>();
 private readonly openings=new Set<Promise<MediaPreview>>();
 private closed=false;
 constructor(options:MediaServiceOptions){this.options=options;this.holders=options.holders??new ActiveHolders();this.files=new MediaFiles(options.userData);this.deletion=options.deletion??new DeletionService(options.storage,this.holders,this.files.managed);}
 get ownerId():string{return this.options.contacts.ownerId;}
 async initialize():Promise<void>{await this.options.storage.execute('media.recover',{ownerId:this.ownerId});await this.resumeCleanup();}
 private available():void{if(this.closed)throw new StorageFailure('media_closed');}
 async read(contactId:string,messageId:string):Promise<MediaSnapshot>{
  this.available();const state=await this.options.storage.execute<MediaSnapshot>('media.read',{ownerId:this.ownerId,contactId,messageId});
  for(const [key,goal] of [['extract','extract'],['originalUpgrade','original_upgrade'],['audioConversion','audio_conversion']] as const)state.capabilities[key]&&=this.options.adapters.some(a=>a.supports(state.kind,goal));
  if(!state.capabilities.reason&&!this.options.adapters.some(a=>a.supports(state.kind,'extract')))state.capabilities.reason='media_adapter_unavailable';return state;
 }
 async extract(contactId:string,messageId:string,input:{requestKey:string;goal:MediaGoal},signal?:AbortSignal):Promise<MediaSnapshot>{
  this.available();const scope={ownerId:this.ownerId,contactId,messageId};
  if(await this.options.storage.execute('media.request',{...scope,...input}))return this.read(contactId,messageId);
  const state=await this.read(contactId,messageId);
  const adapter=this.options.adapters.find(a=>a.supports(state.kind,input.goal));if(!adapter)throw new StorageFailure('media_adapter_unavailable');
  const token=input.goal==='audio_conversion'?null:await this.options.contacts.eligibility(contactId);
  const begin=await this.options.storage.execute<Begin>('media.begin',{...scope,...input,token,adapterVersion:adapter.version});
  if(begin.reused)return this.read(contactId,messageId);
  if(begin.cleanupRequired){await this.resumeCleanup();return this.extract(contactId,messageId,input,signal);}
  const handle:AttemptHandle={...scope,attemptId:begin.attemptId,leaseToken:begin.leaseToken!};
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let settle!:()=>void;const done=new Promise<void>(resolve=>{settle=resolve;});
  this.active.set(begin.attemptId,{controller,done,contactId});let release:(()=>Promise<void>)|undefined;let failure:unknown;const savedFiles:{address:ManagedAddress;bytes:number;digest:string}[]=[];
  const checkpoint=async()=>{if(this.closed||controller.signal.aborted)throw new StorageFailure('media_interrupted');await this.options.storage.execute('media.check',handle);};
  try{
   release=this.holders.register({key:`mediaAttempt:${begin.attemptId}`,ownerId:this.ownerId,contactId,generation:BigInt(begin.dataGeneration),close:async()=>{controller.abort();await done;}});
   await checkpoint();if(begin.inputFile)await this.files.verify(begin.inputFile.address,Number(begin.inputFile.byteSize),begin.inputFile.digest);const source=begin.recordId?await this.options.history.source(contactId,begin.recordId):null;await checkpoint();
   const result=await adapter.execute({contactId,messageId,goal:input.goal,kind:state.kind,signal:controller.signal,source,token:begin.token??null,
    input:begin.inputFile?{fileId:begin.inputFile.fileId,localPath:this.files.location(begin.inputFile.address)}:null,checkpoint,
    save:async file=>{
     await checkpoint();const allocated=await this.options.storage.execute<{fileId:string;locator:string}>('media.allocate',{...handle,role:file.role,parentFileId:file.parentFileId});
     let identified=false;
     try{
      const saved=await this.files.create(allocated.locator,async address=>{await this.options.storage.execute('media.identify',{...handle,fileId:allocated.fileId,address});identified=true;},checkpoint,file.bytes,{bytes:file.expectedBytes,digest:file.expectedSha256},location=>file.validate(location,controller.signal));
      savedFiles.push(saved);await this.options.storage.execute('media.validated',{...handle,fileId:allocated.fileId,validation:saved.validation as MediaValidation,byteSize:saved.bytes,digest:saved.digest});return {fileId:allocated.fileId};
     }catch(error){
      // 只有本次尚未创建的目标可以登记不存在；创建后身份未知不能猜测清除。
      if(!identified){try{this.files.managed.capture('media',allocated.locator);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')await this.options.storage.execute('media.uncreated',{...handle,fileId:allocated.fileId});}}
      throw error;
     }
    }});
   for(const saved of savedFiles){await checkpoint();await this.files.verify(saved.address,saved.bytes,saved.digest);}
   await checkpoint();await this.options.storage.execute('media.publish',{...handle,association:result.association,errorCode:result.errorCode});
  }catch(error){failure=error;try{await this.options.storage.execute('media.fail',{...handle,interrupted:controller.signal.aborted||this.closed,code:error instanceof StorageFailure?error.code:'media_execution_failed'});}catch{/* 旧执行不能修改删除已固定的资格；保持原计划可复核。 */}}
  finally{settle();try{await release?.();}finally{this.active.delete(begin.attemptId);signal?.removeEventListener('abort',abort);}}
  await this.resumeCleanup();
  if(failure)throw failure instanceof StorageFailure?failure:new StorageFailure('media_execution_failed');
  return this.read(contactId,messageId);
 }
 async clear(contactId:string,messageId:string,requestKey:string):Promise<MediaSnapshot>{
  this.available();await this.read(contactId,messageId);
  const op=await this.deletion.plan({ownerId:this.ownerId,requestKey,scope:{kind:'media_result_clear',contactId,messageId}});
  await this.deletion.advance({ownerId:this.ownerId,operationId:op.operationId});return this.read(contactId,messageId);
 }
 async resumeCleanup():Promise<void>{
  const operations=await this.options.storage.execute<string[]>('media.pendingCleanup',{ownerId:this.ownerId});
  for(const operationId of operations){try{await this.deletion.advance({ownerId:this.ownerId,operationId});}catch(error){if(!(error instanceof StorageFailure)||error.code!=='deletion_busy')throw error;}}
 }
 openPreview(contactId:string,messageId:string,fileId:string):Promise<MediaPreview>{
  const opening=this.acquirePreview(contactId,messageId,fileId);this.openings.add(opening);
  const settled=()=>{this.openings.delete(opening);};void opening.then(settled,settled);return opening;
 }
 private async acquirePreview(contactId:string,messageId:string,fileId:string):Promise<MediaPreview>{
  this.available();const scope={ownerId:this.ownerId,contactId,messageId,fileId};
  const file=await this.options.storage.execute<FileReference>('media.file',scope);this.available();if(!file.viewable&&!file.playable)throw new StorageFailure('media_preview_unavailable');
  const sessionId=randomUUID();let ack!:()=>void;const acknowledged=new Promise<void>(resolve=>{ack=resolve;});
  let session:PreviewSession|undefined;
  const release=this.holders.register({key:`mediaFile:${fileId}`,ownerId:this.ownerId,contactId,generation:BigInt(file.dataGeneration),close:async()=>{if(session)session.state='revoking';await acknowledged;}});
  session={state:'active',release,ack,contactId,messageId};this.previews.set(sessionId,session);
  try{const bytes=await this.files.preview(file.address,Number(file.byteSize),file.digest);await this.options.storage.execute('media.file',scope);this.available();if(session.state!=='active')throw new StorageFailure('media_preview_revoked');return {sessionId,mimeType:file.mimeType,dataBase64:bytes.toString('base64')};}
  catch(error){session.ack();await release();this.previews.delete(sessionId);throw error;}
 }
 previewStatus(sessionId:string):{state:'active'|'revoking'}{const session=this.previews.get(sessionId);if(!session)throw new StorageFailure('media_preview_not_found');return {state:session.state};}
 async releasePreview(sessionId:string):Promise<void>{const session=this.previews.get(sessionId);if(!session)return;session.ack();await session.release();this.previews.delete(sessionId);}
 async stop(contactId?:string):Promise<void>{const entries=[...this.active.values()].filter(e=>!contactId||e.contactId===contactId);for(const e of entries)e.controller.abort();await Promise.all(entries.map(e=>e.done));}
 async close():Promise<void>{this.closed=true;await Promise.allSettled([...this.openings]);for(const e of this.active.values())e.controller.abort();await Promise.all(this.options.adapters.map(a=>a.close?.()));await Promise.all([...this.active.values()].map(e=>e.done));for(const s of this.previews.values())s.state='revoking';
  let timer:NodeJS.Timeout|undefined;
  try{await Promise.race([Promise.all([...this.previews.values()].map(s=>s.release())),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new StorageFailure('media_preview_release_pending')),5000);})]);}finally{clearTimeout(timer);}
 }
}
