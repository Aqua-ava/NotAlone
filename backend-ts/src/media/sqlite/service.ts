import {randomUUID} from 'node:crypto';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../../storage/sqlite/deletion/service.ts';
import type {ManagedAddress,DeletionSnapshot} from '../../storage/sqlite/deletion/contracts.ts';
import {MediaFiles} from './files.ts';
import type {AttemptHandle} from './actions.ts';
import type {MediaAdapter,MediaGoal,MediaSnapshot,MediaPreview,MediaValidation,MediaContactPort,MediaSourcePort,MediaFileInput,MediaAttemptView} from './contracts.ts';
import {automaticImageGeneration,ImagePreparationFailure} from './image-refresh.ts';
export interface MediaServiceOptions {storage:SqliteStorage;contacts:MediaContactPort;history:MediaSourcePort;userData:string;adapters:readonly MediaAdapter[];holders?:ActiveHolders;deletion?:DeletionService;changed?:(contactId:string,messageId:string)=>void;ensureSourceReady?:(contactId:string,signal?:AbortSignal)=>Promise<void>}
interface FileReference {fileId:string;generation:string;dataGeneration:string;address:ManagedAddress;mimeType:string;byteSize:string;digest:string;viewable:boolean;playable:boolean}
interface Begin {reused:boolean;cleanupRequired?:boolean;attemptId:string;dataGeneration:string;leaseToken?:string;recordId?:string;inputFile?:{fileId:string;address:ManagedAddress;byteSize:string;digest:string}|null;token?:any}
interface PreviewSession {state:'active'|'revoking';release:()=>Promise<void>;ack:()=>void;contactId:string;messageId:string;fileId:string}
/** 仅消费记忆轮次已冻结的合法副本；调用者持有记忆任务holder直到模型与本次读取结算。 */
export interface MemoryImageInput {
 contactId:string;messageId:string;fileId:string;sha256:string;mediaGeneration:string;mimeType:string;byteSize:number;
 signal:AbortSignal;requireCurrent():Promise<void>;
}
export class SqliteMediaService {
 private readonly options:MediaServiceOptions;
 readonly holders:ActiveHolders;
 readonly files:MediaFiles;
 readonly deletion:DeletionService;
 private readonly active=new Map<string,{controller:AbortController;done:Promise<void>;contactId:string;goal:MediaGoal}>();
 private readonly previews=new Map<string,PreviewSession>();
 private readonly openings=new Set<Promise<MediaPreview>>();
 private readonly operations=new Set<Promise<unknown>>();
 private readonly probes=new Map<string,Promise<void>>();
 private closed=false;
 constructor(options:MediaServiceOptions){this.options=options;this.holders=options.holders??new ActiveHolders();this.files=new MediaFiles(options.userData);this.deletion=options.deletion??new DeletionService(options.storage,this.holders,this.files.managed);}
 get ownerId():string{return this.options.contacts.ownerId;}
 private track<T>(operation:Promise<T>):Promise<T>{this.operations.add(operation);const settled=()=>{this.operations.delete(operation);};void operation.then(settled,settled);return operation;}
 initialize():Promise<void>{return this.track(this.start());}
 private async start():Promise<void>{await this.options.storage.execute('media.recover',{ownerId:this.ownerId});await this.resumeCleanup();
  const current=await this.options.storage.execute<{contactId:string;messageId:string;fileId:string}[]>('media.currentFiles',{ownerId:this.ownerId});
  for(const file of current){
   try{await this.verifyFile(file.contactId,file.messageId,file.fileId);}catch(error){
    // 个别副本的旧来源失效只阻止该副本访问，不阻断其他联系人的宿主启动。
    if(!(error instanceof StorageFailure)||error.code!=='history_source_not_available')throw error;
   }
  }
 }
 private available():void{if(this.closed)throw new StorageFailure('media_closed');}
 read(contactId:string,messageId:string):Promise<MediaSnapshot>{return this.track(this.readCurrent(contactId,messageId));}
 private async readCurrent(contactId:string,messageId:string):Promise<MediaSnapshot>{
  this.available();const scope={ownerId:this.ownerId,contactId,messageId};let state=await this.options.storage.execute<MediaSnapshot>('media.read',scope);this.available();
  for(const file of state.files)await this.verifyFile(contactId,messageId,file.fileId);
  state=await this.options.storage.execute<MediaSnapshot>('media.read',scope);this.available();
  for(const [key,goal] of [['extract','extract'],['audioConversion','audio_conversion']] as const)state.capabilities[key]&&=this.options.adapters.some(a=>a.supports(state.kind,goal));
  if(!state.capabilities.reason&&!this.options.adapters.some(a=>a.supports(state.kind,'extract')))state.capabilities.reason='media_adapter_unavailable';return state;
 }
 extract(contactId:string,messageId:string,input:{requestKey:string;goal:MediaGoal},signal?:AbortSignal):Promise<MediaSnapshot>{
  return this.track(this.runExtraction(contactId,messageId,input,signal));
 }
 private async runExtraction(contactId:string,messageId:string,input:{requestKey:string;goal:MediaGoal},signal?:AbortSignal):Promise<MediaSnapshot>{
  this.available();const scope={ownerId:this.ownerId,contactId,messageId};
  const requested=await this.options.storage.execute<MediaAttemptView|null>('media.request',{...scope,...input});if(requested)return {...await this.read(contactId,messageId),requestedAttempt:requested};
  const kind=await this.options.storage.execute<MediaSnapshot['kind']>('media.kind',scope);
  const adapter=this.options.adapters.find(a=>a.supports(kind,input.goal));if(!adapter)throw new StorageFailure('media_adapter_unavailable');
  // 重启后的手动取图先重验当前会话来源；不读取历史页或派发记忆任务。
  if(signal?.aborted)throw new StorageFailure('media_interrupted');
  if(input.goal!=='audio_conversion')try{await this.options.ensureSourceReady?.(contactId,signal);}catch(error){
   if(automaticImageGeneration(input.requestKey,messageId)!==null&&!signal?.aborted&&!this.closed){
    try{
     const token=await this.options.contacts.eligibility(contactId);
     await this.options.storage.execute('media.imagePreparationFailed',{...scope,...input,token,requestedAt:Date.now(),code:error instanceof StorageFailure?error.code:'media_execution_failed'});
    }catch(receiptError){throw new ImagePreparationFailure(receiptError instanceof StorageFailure?receiptError.code:'media_execution_failed');}
    throw new ImagePreparationFailure(error instanceof StorageFailure?error.code:'media_execution_failed');
   }
   throw error;
  }
  const state=await this.read(contactId,messageId);
  const token=input.goal==='audio_conversion'?null:await this.options.contacts.eligibility(contactId);
  this.available();const begin=await this.options.storage.execute<Begin>('media.begin',{...scope,...input,token,adapterVersion:adapter.version,requestedAt:Date.now()});
  if(begin.reused)return this.requestResult(contactId,messageId,input);
  if(begin.cleanupRequired){await this.resumeCleanup();if((await this.read(contactId,messageId)).cleanup)throw new StorageFailure('media_cleanup_pending');return this.runExtraction(contactId,messageId,input,signal);}
  const handle:AttemptHandle={...scope,attemptId:begin.attemptId,leaseToken:begin.leaseToken!};
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let settle!:()=>void;const done=new Promise<void>(resolve=>{settle=resolve;});
  this.active.set(begin.attemptId,{controller,done,contactId,goal:input.goal});let release:(()=>Promise<void>)|undefined;let failure:unknown;const savedFiles:{address:ManagedAddress;bytes:number;digest:string}[]=[];const saves:Promise<{fileId:string}>[]=[];const finiteFailures=new Set<unknown>();let acceptingSaves=true;const readers=new Set<()=>Promise<void>>();
  const checkpoint=async()=>{if(this.closed||controller.signal.aborted)throw new StorageFailure('media_interrupted');await this.options.storage.execute('media.check',handle);};
  const saveFile=async(file:MediaFileInput):Promise<{fileId:string}>=>{
     await checkpoint();if(file.failureMode&&(file.failureMode!=='retain_audio_source'||state.kind!=='voice'||input.goal!=='extract'||file.role!=='audio_playback'))throw new StorageFailure('media_failure_mode_invalid');const allocated=await this.options.storage.execute<{fileId:string;locator:string}>('media.allocate',{...handle,role:file.role,parentFileId:file.parentFileId});
     let identified=false;
     try{
      const saved=await this.files.create(allocated.locator,async address=>{await this.options.storage.execute('media.identify',{...handle,fileId:allocated.fileId,address});identified=true;},checkpoint,file.bytes,{bytes:file.expectedBytes,digest:file.expectedSha256},location=>file.validate(location,controller.signal));
      savedFiles.push(saved);await this.options.storage.execute('media.validated',{...handle,fileId:allocated.fileId,validation:saved.validation as MediaValidation,byteSize:saved.bytes,digest:saved.digest});return {fileId:allocated.fileId};
     }catch(error){
      // 只有本次尚未创建的目标可以登记不存在；创建后身份未知不能猜测清除。
      if(!identified){try{this.files.managed.capture('media',allocated.locator);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')await this.options.storage.execute('media.uncreated',{...handle,fileId:allocated.fileId});}}
      if(file.failureMode==='retain_audio_source'){await checkpoint();await this.options.storage.execute('media.discardPlayback',{...handle,fileId:allocated.fileId});finiteFailures.add(error);}
      throw error;
     }

  };
  const trackedSave=(file:MediaFileInput):Promise<{fileId:string}>=>{
   const saving=acceptingSaves?saveFile(file):Promise.reject(new StorageFailure('media_adapter_finished'));saves.push(saving);void saving.catch(()=>{});return saving;
  };
  try{
   release=this.holders.register({key:`mediaAttempt:${begin.attemptId}`,ownerId:this.ownerId,contactId,generation:BigInt(begin.dataGeneration),close:async()=>{controller.abort();await done;for(const close of readers){await close();readers.delete(close);}}});
   await checkpoint();if(begin.inputFile)await this.files.verify(begin.inputFile.address,Number(begin.inputFile.byteSize),begin.inputFile.digest);const source=begin.recordId?await this.options.history.source(contactId,begin.recordId):null;await checkpoint();
   const result=await adapter.execute({contactId,messageId,goal:input.goal,kind:state.kind,signal:controller.signal,source,token:begin.token??null,
    input:begin.inputFile?{fileId:begin.inputFile.fileId,localPath:this.files.location(begin.inputFile.address),expectedBytes:Number(begin.inputFile.byteSize),expectedSha256:begin.inputFile.digest}:null,checkpoint,
    retainReader:close=>{if(!acceptingSaves)throw new StorageFailure('media_adapter_finished');readers.add(close);},save:trackedSave});
   acceptingSaves=false;const results=await Promise.allSettled(saves);
   const rejected=results.find(result=>result.status==='rejected'&&!finiteFailures.has(result.reason));if(rejected?.status==='rejected')throw rejected.reason;
   for(const saved of savedFiles){await checkpoint();await this.files.verify(saved.address,saved.bytes,saved.digest);}
   await checkpoint();if(begin.inputFile)await this.files.verify(begin.inputFile.address,Number(begin.inputFile.byteSize),begin.inputFile.digest);await checkpoint();await this.options.storage.execute('media.publish',{...handle,association:result.association,errorCode:result.errorCode});
  }catch(error){failure=error;acceptingSaves=false;controller.abort();await Promise.allSettled(saves);try{await this.options.storage.execute('media.fail',{...handle,interrupted:failure instanceof StorageFailure&&['media_closed','media_interrupted'].includes(failure.code)||this.closed,code:error instanceof StorageFailure?error.code:'media_execution_failed'});}catch{/* 旧执行不能修改删除已固定的资格；保持原计划可复核。 */}}
  finally{settle();try{await release?.();}finally{this.active.delete(begin.attemptId);signal?.removeEventListener('abort',abort);}}
  await this.resumeCleanup();
  this.options.changed?.(contactId,messageId);
  if(failure)throw failure instanceof StorageFailure?failure:new StorageFailure('media_execution_failed');
  return this.requestResult(contactId,messageId,input);
 }
 private async requestResult(contactId:string,messageId:string,input:{requestKey:string;goal:MediaGoal}):Promise<MediaSnapshot>{
  const snapshot=await this.read(contactId,messageId);const requestedAttempt=await this.options.storage.execute<MediaAttemptView|null>('media.request',{ownerId:this.ownerId,contactId,messageId,...input});return requestedAttempt?{...snapshot,requestedAttempt}:snapshot;
 }
 clear(contactId:string,messageId:string,requestKey:string):Promise<MediaSnapshot>{return this.track(this.runClear(contactId,messageId,requestKey));}
 private async runClear(contactId:string,messageId:string,requestKey:string):Promise<MediaSnapshot>{
  this.available();await this.read(contactId,messageId);
  const op=await this.deletion.plan({ownerId:this.ownerId,requestKey,scope:{kind:'media_result_clear',contactId,messageId}});
  await this.deletion.advance({ownerId:this.ownerId,operationId:op.operationId});this.options.changed?.(contactId,messageId);return this.read(contactId,messageId);
 }
 resumeCleanup():Promise<void>{return this.track(this.runCleanup());}
 private async runCleanup():Promise<void>{
  const operations=await this.options.storage.execute<string[]>('media.pendingCleanup',{ownerId:this.ownerId});
  for(const operationId of operations){try{await this.deletion.advance({ownerId:this.ownerId,operationId});}catch(error){if(!(error instanceof StorageFailure)||error.code!=='deletion_busy')throw error;}}
 }
 private async verifyFile(contactId:string,messageId:string,fileId:string):Promise<void>{
  const prior=this.probes.get(fileId);if(prior)return prior;
  const probe=this.inspectFile(contactId,messageId,fileId);this.probes.set(fileId,probe);
  try{await probe;}finally{this.probes.delete(fileId);}
 }
 private async inspectFile(contactId:string,messageId:string,fileId:string):Promise<void>{
  const scope={ownerId:this.ownerId,contactId,messageId,fileId};let file:FileReference;
  try{file=await this.options.storage.execute<FileReference>('media.file',scope);}catch(error){if(error instanceof StorageFailure&&error.code==='media_file_not_found')return;throw error;}
  let settle!:()=>void;const done=new Promise<void>(resolve=>{settle=resolve;});
  const release=this.holders.register({key:`mediaProbe:${fileId}`,ownerId:this.ownerId,contactId,generation:BigInt(file.dataGeneration),close:()=>done});
  try{
   try{await this.files.verify(file.address,Number(file.byteSize),file.digest);}catch{
    await this.options.storage.execute('media.fileUnavailable',{...scope,address:file.address});
    for(const preview of this.previews.values())if(preview.contactId===contactId&&preview.messageId===messageId)preview.state='revoking';return;
   }
   await this.options.storage.execute('media.file',scope);
  }finally{settle();await release();}
 }
 openPreview(contactId:string,messageId:string,fileId:string):Promise<MediaPreview>{
  const opening=this.acquirePreview(contactId,messageId,fileId);this.openings.add(opening);
  const settled=()=>{this.openings.delete(opening);};void opening.then(settled,settled);return opening;
 }
 readMemoryImage(input:MemoryImageInput):Promise<{mimeType:string;dataBase64:string}>{return this.track(this.acquireMemoryImage(input));}
 private async acquireMemoryImage(input:MemoryImageInput):Promise<{mimeType:string;dataBase64:string}>{
  const scope={ownerId:this.ownerId,contactId:input.contactId,messageId:input.messageId,fileId:input.fileId};
  const checkpoint=async():Promise<FileReference>=>{
   this.available();input.signal.throwIfAborted();await input.requireCurrent();
   const file=await this.options.storage.execute<FileReference>('media.file',scope);
   if(file.fileId!==input.fileId||file.digest!==input.sha256||file.generation!==input.mediaGeneration
    ||file.mimeType!==input.mimeType||Number(file.byteSize)!==input.byteSize||!file.viewable||!file.mimeType.startsWith('image/'))throw new StorageFailure('memory_extraction_source_stale');
   this.available();input.signal.throwIfAborted();return file;
  };
  const file=await checkpoint();let bytes:Buffer;
  try{bytes=await this.files.preview(file.address,input.byteSize,input.sha256);}
  catch(error){
   // 单文件读取失败前后都核验原范围；撤销、删除或替图仍走原来的失效路径。
   await checkpoint();
   const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
   if(['ENOENT','EACCES','EPERM','EIO','media_file_identity_changed','media_copy_incomplete','media_preview_too_large','media_file_io_failed'].includes(code))throw new StorageFailure('memory_content_image_unavailable');
   throw error;
  }
  await checkpoint();
  return {mimeType:file.mimeType,dataBase64:bytes.toString('base64')};
 }
 private async acquirePreview(contactId:string,messageId:string,fileId:string):Promise<MediaPreview>{
  this.available();const scope={ownerId:this.ownerId,contactId,messageId,fileId};
  const file=await this.options.storage.execute<FileReference>('media.file',scope);this.available();if(!file.viewable&&!file.playable)throw new StorageFailure('media_preview_unavailable');
  const sessionId=randomUUID();let ack!:()=>void;const acknowledged=new Promise<void>(resolve=>{ack=resolve;});
  let session:PreviewSession|undefined;
  const release=this.holders.register({key:`mediaFile:${fileId}`,ownerId:this.ownerId,contactId,generation:BigInt(file.dataGeneration),close:async()=>{if(session)session.state='revoking';await acknowledged;}});
  session={state:'active',release,ack,contactId,messageId,fileId};this.previews.set(sessionId,session);
  try{const bytes=await this.files.preview(file.address,Number(file.byteSize),file.digest);await this.options.storage.execute('media.file',scope);this.available();if(session.state!=='active')throw new StorageFailure('media_preview_revoked');return {sessionId,mimeType:file.mimeType,dataBase64:bytes.toString('base64')};}
  catch(error){session.ack();await release();this.previews.delete(sessionId);throw error;}
 }
 previewStatus(sessionId:string):{state:'active'|'revoking'}{const session=this.previews.get(sessionId);if(!session)throw new StorageFailure('media_preview_not_found');return {state:session.state};}
 async releasePreview(sessionId:string):Promise<void>{const session=this.previews.get(sessionId);if(!session)return;session.ack();await session.release();this.previews.delete(sessionId);}
 async stop(contactId?:string,mode:'all'|'wechat'='all'):Promise<void>{const entries=[...this.active.values()].filter(e=>(!contactId||e.contactId===contactId)&&(mode==='all'||e.goal!=='audio_conversion'));for(const e of entries)e.controller.abort();await Promise.all(entries.map(e=>e.done));}
 async close():Promise<void>{this.closed=true;for(const e of this.active.values())e.controller.abort();for(const s of this.previews.values())s.state='revoking';await Promise.all(this.options.adapters.map(a=>a.close?.()));await Promise.allSettled([...this.openings,...this.operations]);
  let timer:NodeJS.Timeout|undefined;
  try{await Promise.race([Promise.all([...this.previews.values()].map(s=>s.release())),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new StorageFailure('media_preview_release_pending')),5000);})]);}finally{clearTimeout(timer);}
 }
}
