/** 正式模型图片只在调用内存中派生；不写附件缓存，不上传 Files API。 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {sha256} from '../../platform/sha256.ts';
import type {Context} from '@deepseek-ai/cordis';
import {AttachmentStore,AttachmentId,ImageVariantId,type ImageAttachmentRef,type ImageRequestTarget,type ImageMediaType,type RequestImageAttachment,type SaveImageAttachment,type StoredImageAttachment} from '@deepseek-ai/dsh-attachment';
import type {TextBlock,ImageBlock} from '@deepseek-ai/dsh-llm';
import sharp from 'sharp';

export interface ModelImageInput {id:string;mimeType:ImageMediaType;dataBase64:string}
export interface ModelImageManifest {
 id:string;sourceSha256:string;attachmentSha256:string;requestSha256:string;
 requestMimeType:ImageMediaType;width:number;height:number;bytes:number;frame:0;
}
interface Entry {id:string;sourceSha256:string;ref:ImageAttachmentRef;data:Buffer;request?:RequestImageAttachment}
interface ImageScope {entries:Entry[];signal:AbortSignal}
const mediaTypes=['image/png','image/jpeg','image/webp','image/gif'] as const;
const formats={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'} as const;
const failure=()=>new Error('extraction_model_image_invalid');

/** 来源受管副本由调用者保管；此官方附件适配只接受本次已冻结的完整字节。 */
export class ModelImageAttachments extends AttachmentStore {
 readonly imageLimits={maxImageBytes:32*1024*1024,maxImagesPerMessage:8,maxMessageImageBytes:32*1024*1024,
  maxImagePixels:32*1024*1024,maxImageDimension:32768,mediaTypes};
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
  const pipeline=sharp(entry.data,{limitInputPixels:this.imageLimits.maxImagePixels,failOn:'error'})
   .resize({width:target.width,height:target.height,fit:'inside',withoutEnlargement:true})
   .toColourspace('srgb').png().timeout({seconds:10});
  const {data,info}=await pipeline.toBuffer({resolveWithObject:true});
  try{
   signal?.throwIfAborted();this.entry(ref);
   if(data.length>target.maxBytes)throw new Error('extraction_model_image_budget_exceeded');
   const output=await sharp(data).metadata();
   if(output.depth!=='uchar'||output.space!=='srgb')throw failure();
   entry.request={variantId:ImageVariantId(sha256(data)),attachment:structuredClone(ref),data,mediaType:'image/png',bytes:data.length,
    width:info.width,height:info.height,depth:'uchar',space:'srgb',hasAlpha:output.hasAlpha};
   for(const duplicate of this.scopes.getStore()!.entries)if(duplicate.ref.attachmentId===ref.attachmentId)duplicate.request=entry.request;
   return entry.request;
  }catch(error){data.fill(0);throw error;}
 }
 manifest():ModelImageManifest[]{
  return (this.scopes.getStore()?.entries??[]).map(entry=>{
   const image=entry.request;if(!image)throw failure();
   return {id:entry.id,sourceSha256:entry.sourceSha256,attachmentSha256:String(entry.ref.attachmentId),requestSha256:sha256(image.data),
    requestMimeType:image.mediaType,width:image.width,height:image.height,bytes:image.bytes,frame:0};
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
    if(!input||typeof input.id!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(input.id)||!mediaTypes.includes(input.mimeType)
     ||typeof input.dataBase64!=='string'||input.dataBase64.length>Math.ceil(this.imageLimits.maxImageBytes/3)*4
     ||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))throw failure();
    const raw=Buffer.from(input.dataBase64,'base64');total+=raw.length;
    try{
     if(!raw.length||raw.toString('base64')!==input.dataBase64||total>this.imageLimits.maxMessageImageBytes)throw failure();
     const metadata=await sharp(raw,{limitInputPixels:this.imageLimits.maxImagePixels,failOn:'error'}).metadata();
     if(!metadata.format||formats[metadata.format as keyof typeof formats]!==input.mimeType)throw failure();
     const {data,info}=await sharp(raw,{limitInputPixels:this.imageLimits.maxImagePixels,failOn:'error',page:0,pages:1})
      .rotate().toColourspace('srgb').resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true})
      .png().timeout({seconds:10}).toBuffer({resolveWithObject:true});
     try{
      signal.throwIfAborted();
      if(data.length>this.imageLimits.maxImageBytes)throw failure();
      const ref:ImageAttachmentRef={attachmentId:AttachmentId(sha256(data)),mediaType:'image/png',bytes:data.length,width:info.width,height:info.height};
      scope.entries.push({id:input.id,sourceSha256:sha256(raw),ref,data});
     }catch(error){data.fill(0);throw error;}
    }finally{raw.fill(0);}
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
