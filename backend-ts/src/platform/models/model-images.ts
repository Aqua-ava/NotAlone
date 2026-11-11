/** 正式模型图片只在调用内存中派生；不写附件缓存，不上传 Files API。 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {sha256} from '../../platform/sha256.ts';
import type {Context} from '@deepseek-ai/cordis';
import {AttachmentStore,AttachmentId,ImageVariantId,type ImageAttachmentRef,type ImageRequestTarget,type ImageMediaType,type RequestImageAttachment,type SaveImageAttachment,type StoredImageAttachment} from '@deepseek-ai/dsh-attachment';
import type {TextBlock,ImageBlock} from '@deepseek-ai/dsh-llm';
import sharp from 'sharp';
import {MODEL_IMAGE_LIMITS,normalizeModelImageInput,normalizeModelImageBytes,type NormalizableModelImage,type ModelImageNormalizationTier} from './image-normalization.ts';

export interface ModelImageInput extends NormalizableModelImage {}
export interface ModelImageManifest {
 id:string;sourceSha256:string;attachmentSha256:string;requestSha256:string;
 requestMimeType:ImageMediaType;width:number;height:number;bytes:number;frame:0;
 originalBytes?:number;normalizationTier?:ModelImageNormalizationTier;
}
interface Entry {id:string;sourceSha256:string;originalBytes:number;tier:ModelImageNormalizationTier;ref:ImageAttachmentRef;data:Buffer;request?:RequestImageAttachment}
interface ImageScope {entries:Entry[];signal:AbortSignal}
const failure=()=>new Error('extraction_model_image_invalid');

/** 来源受管副本由调用者保管；此官方附件适配只接受本次已冻结的完整字节。 */
export class ModelImageAttachments extends AttachmentStore {
 readonly imageLimits=MODEL_IMAGE_LIMITS;
 private readonly scopes=new AsyncLocalStorage<ImageScope>();
 private readonly active=new Set<ImageScope>();
 constructor(ctx:Context){super(ctx);}
 async validateImage(_input:SaveImageAttachment):Promise<void>{throw failure();}
 async saveImage(_input:SaveImageAttachment):Promise<ImageAttachmentRef>{throw failure();}
 private entry(ref:ImageAttachmentRef):Entry {
  const scope=this.scopes.getStore();scope?.signal.throwIfAborted();
  const value=scope?.entries.find(entry=>entry.ref.attachmentId===ref.attachmentId);
  if(!value||JSON.stringify(value.ref)!==JSON.stringify(ref))throw failure();return value;
 }
 async readImage(ref:ImageAttachmentRef,signal?:AbortSignal):Promise<StoredImageAttachment>{
  signal?.throwIfAborted();const entry=this.entry(ref);return {ref:structuredClone(ref),data:Buffer.from(entry.data)};
 }
 async readImageRequest(ref:ImageAttachmentRef,target:ImageRequestTarget,signal?:AbortSignal):Promise<RequestImageAttachment>{
  signal?.throwIfAborted();const entry=this.entry(ref);
  if(entry.request)return entry.request;
  if(![target.width,target.height,target.maxBytes].every(value=>Number.isSafeInteger(value)&&value>0))throw failure();
  const version=entry.ref.width<=target.width&&entry.ref.height<=target.height&&entry.data.length<=target.maxBytes
   ?{data:Buffer.from(entry.data),width:entry.ref.width,height:entry.ref.height,bytes:entry.data.length,mimeType:'image/jpeg' as const}
   :await normalizeModelImageBytes(entry.data,{tier:entry.tier,target,signal});
  try{
   signal?.throwIfAborted();this.entry(ref);
   entry.request={variantId:ImageVariantId(sha256(version.data)),attachment:structuredClone(ref),data:version.data,mediaType:'image/jpeg',bytes:version.bytes,
    width:version.width,height:version.height,depth:'uchar',space:'srgb',hasAlpha:false};
   for(const duplicate of this.scopes.getStore()!.entries)if(duplicate.ref.attachmentId===ref.attachmentId)duplicate.request=entry.request;
   return entry.request;
  }catch(error){version.data.fill(0);throw error;}
 }
 manifest():ModelImageManifest[]{
  return (this.scopes.getStore()?.entries??[]).map(entry=>{
   const image=entry.request;if(!image)throw failure();
   return {id:entry.id,sourceSha256:entry.sourceSha256,attachmentSha256:String(entry.ref.attachmentId),requestSha256:sha256(image.data),
    requestMimeType:image.mediaType,width:image.width,height:image.height,bytes:image.bytes,frame:0,originalBytes:entry.originalBytes,normalizationTier:entry.tier};
  });
 }
 async withImages<T>(inputs:readonly ModelImageInput[],signal:AbortSignal,work:(blocks:(TextBlock|ImageBlock)[])=>Promise<T>):Promise<T>{
  signal.throwIfAborted();
  if(!Array.isArray(inputs)||inputs.length>this.imageLimits.maxImagesPerMessage
   ||new Set(inputs.map(input=>input.id)).size!==inputs.length)throw failure();
  const scope:ImageScope={entries:[],signal};this.active.add(scope);
  let total=0;
  try{
   for(const input of inputs){
    signal.throwIfAborted();
    if(!input||typeof input.id!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(input.id))throw failure();
    const normalized=await normalizeModelImageInput(input,{signal}),data=Buffer.from(normalized.dataBase64,'base64');total+=data.length;
    try{
     if(total>this.imageLimits.maxMessageImageBytes)throw failure();
     const metadata=await sharp(data).metadata();
     const ref:ImageAttachmentRef={attachmentId:AttachmentId(sha256(data)),mediaType:'image/jpeg',bytes:data.length,width:metadata.width!,height:metadata.height!};
     scope.entries.push({id:input.id,sourceSha256:normalized.sourceSha256,originalBytes:normalized.originalBytes,tier:normalized.normalizationTier,ref,data});
    }catch(error){data.fill(0);throw error;}
   }
   return await this.scopes.run(scope,()=>work(scope.entries.flatMap(entry=>[
    {type:'text' as const,text:`图片 image_id=${entry.id}（对应本次消息中的同名图片引用）：`},
    {type:'image' as const,attachment:structuredClone(entry.ref)},
   ])));
  }finally{
   for(const entry of scope.entries){entry.data.fill(0);entry.request?.data.fill(0);}
   scope.entries.length=0;this.active.delete(scope);
  }
 }
 assertIdle():void{if(this.active.size)throw new Error('model_provider_images_not_settled');}
}
