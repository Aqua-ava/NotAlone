/** 模型图片只在内存规范化；来源身份与发送版本分别校验，不写附件或缩略图文件。 */
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import sharp from 'sharp';

export const MODEL_IMAGE_LIMITS=Object.freeze({
 maxImageBytes:2*1024*1024,maxImagesPerMessage:8,maxMessageImageBytes:32*1024*1024,
 maxImagePixels:32*1024*1024,maxImageDimension:32768,primaryMaxEdge:1536,degradedMaxEdge:1024,quality:85,
 mediaTypes:['image/png','image/jpeg','image/webp','image/gif'] as const,
});
export type ModelImageNormalizationTier='primary'|'degraded';
export interface NormalizableModelImage {
 id:string;mimeType:typeof MODEL_IMAGE_LIMITS.mediaTypes[number];dataBase64:string;
 sourceSha256?:string;originalBytes?:number;normalizationTier?:ModelImageNormalizationTier;normalizationProof?:string;
}
export interface NormalizedModelImage extends NormalizableModelImage {
 mimeType:'image/jpeg';sourceSha256:string;originalBytes:number;normalizationTier:ModelImageNormalizationTier;normalizationProof:string;
}
export interface NormalizedImageVersion {data:Buffer;mimeType:'image/jpeg';width:number;height:number;bytes:number;tier:ModelImageNormalizationTier}
export class ModelImageNormalizationError extends Error {
 readonly code:'extraction_model_image_invalid'|'extraction_model_image_budget_exceeded'|'extraction_model_image_variant_unchanged';
 constructor(code:ModelImageNormalizationError['code']){super(code);this.code=code;}
}
const proofSecret=randomBytes(32),hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const formats={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'} as const;
const invalid=():never=>{throw new ModelImageNormalizationError('extraction_model_image_invalid');};
function proof(input:NormalizableModelImage):Buffer {
 return createHmac('sha256',proofSecret).update(JSON.stringify([input.id,input.sourceSha256,input.originalBytes,input.normalizationTier,input.mimeType,hash(Buffer.from(input.dataBase64,'base64'))])).digest();
}
/** 证明随普通结构化复制保留，任意改写来源、字节或降级层级均失效。 */
export function verifyNormalizedModelImage(input:NormalizableModelImage,expectedSourceSha256:string):boolean {
 if(typeof input.dataBase64!=='string'||input.dataBase64.length>Math.ceil(MODEL_IMAGE_LIMITS.maxImageBytes/3)*4
  ||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)||Buffer.from(input.dataBase64,'base64').toString('base64')!==input.dataBase64
  ||input.sourceSha256!==expectedSourceSha256||!/^[a-f0-9]{64}$/.test(expectedSourceSha256)
  ||input.mimeType!=='image/jpeg'||!['primary','degraded'].includes(String(input.normalizationTier))
  ||!Number.isSafeInteger(input.originalBytes)||Number(input.originalBytes)<1
  ||typeof input.normalizationProof!=='string'||!/^[a-f0-9]{64}$/.test(input.normalizationProof))return false;
 const supplied=Buffer.from(input.normalizationProof,'hex');return timingSafeEqual(supplied,proof(input));
}
/** 实际解码、应用方向、首帧、白底和去元数据后编码；超字节时继续缩小，不突破硬上限。 */
export async function normalizeModelImageBytes(data:Buffer,options:{tier?:ModelImageNormalizationTier;signal?:AbortSignal;target?:{width:number;height:number;maxBytes:number}}={}):Promise<NormalizedImageVersion>{
 const tier=options.tier??'primary',edge=tier==='degraded'?MODEL_IMAGE_LIMITS.degradedMaxEdge:MODEL_IMAGE_LIMITS.primaryMaxEdge;
 if(!['primary','degraded'].includes(tier)||!data.length||data.length>MODEL_IMAGE_LIMITS.maxMessageImageBytes)invalid();
 const target=options.target??{width:edge,height:edge,maxBytes:MODEL_IMAGE_LIMITS.maxImageBytes};
 if(![target.width,target.height,target.maxBytes].every(value=>Number.isSafeInteger(value)&&value>0))invalid();
 let width=Math.min(edge,target.width),height=Math.min(edge,target.height);
 const maxBytes=Math.min(MODEL_IMAGE_LIMITS.maxImageBytes,target.maxBytes);
 for(let attempt=0;attempt<8;attempt++){
  options.signal?.throwIfAborted();
  const {data:encoded,info}=await sharp(data,{limitInputPixels:MODEL_IMAGE_LIMITS.maxImagePixels,failOn:'error',page:0,pages:1})
   .rotate().resize({width,height,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'})
   .toColourspace('srgb').jpeg({quality:MODEL_IMAGE_LIMITS.quality}).timeout({seconds:10}).toBuffer({resolveWithObject:true});
  try{
   options.signal?.throwIfAborted();
   if(encoded.length<=maxBytes)return {data:encoded,mimeType:'image/jpeg',width:info.width,height:info.height,bytes:encoded.length,tier};
   const ratio=Math.min(0.9,Math.sqrt(maxBytes/encoded.length)*0.95);
   width=Math.max(1,Math.floor(info.width*ratio));height=Math.max(1,Math.floor(info.height*ratio));
  }catch(error){encoded.fill(0);throw error;}
  encoded.fill(0);
 }
 throw new ModelImageNormalizationError('extraction_model_image_budget_exceeded');
}
/** 原图生成新证明；已经规范化的图片只在证明有效时继承原图身份。 */
export async function normalizeModelImageInput(input:NormalizableModelImage,options:{tier?:ModelImageNormalizationTier;signal?:AbortSignal}={}):Promise<NormalizedModelImage>{
 options.signal?.throwIfAborted();
 if(!MODEL_IMAGE_LIMITS.mediaTypes.includes(input.mimeType)||typeof input.dataBase64!=='string'
  ||input.dataBase64.length>Math.ceil(MODEL_IMAGE_LIMITS.maxMessageImageBytes/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))invalid();
 const raw=Buffer.from(input.dataBase64,'base64');
 try{
  if(!raw.length||raw.toString('base64')!==input.dataBase64)invalid();
  const hasProof=input.normalizationProof!==undefined;
  if(hasProof&&!verifyNormalizedModelImage(input,input.sourceSha256??''))invalid();
  const tier=options.tier??(hasProof?input.normalizationTier:'primary')??'primary';
  if(hasProof&&tier===input.normalizationTier)return structuredClone(input) as NormalizedModelImage;
  const metadata=await sharp(raw,{limitInputPixels:MODEL_IMAGE_LIMITS.maxImagePixels,failOn:'error',page:0,pages:1}).metadata();
  if(!metadata.format||formats[metadata.format as keyof typeof formats]!==input.mimeType
   ||!metadata.width||!metadata.height||Math.max(metadata.width,metadata.height)>MODEL_IMAGE_LIMITS.maxImageDimension)invalid();
  const smaller=tier==='degraded'&&hasProof?{width:Math.min(MODEL_IMAGE_LIMITS.degradedMaxEdge,Math.max(1,Math.floor(metadata.width*0.75))),
   height:Math.min(MODEL_IMAGE_LIMITS.degradedMaxEdge,Math.max(1,Math.floor(metadata.height*0.75))),maxBytes:MODEL_IMAGE_LIMITS.maxImageBytes}:undefined;
  if(smaller&&smaller.width>=metadata.width&&smaller.height>=metadata.height)throw new ModelImageNormalizationError('extraction_model_image_variant_unchanged');
  const normalized=await normalizeModelImageBytes(raw,{tier,signal:options.signal,...(smaller?{target:smaller}:{})});
  try{
   const result:NormalizedModelImage={id:input.id,mimeType:'image/jpeg',dataBase64:normalized.data.toString('base64'),
    sourceSha256:hasProof?input.sourceSha256!:hash(raw),originalBytes:hasProof?input.originalBytes!:raw.length,normalizationTier:tier,normalizationProof:''};
   result.normalizationProof=proof(result).toString('hex');return result;
  }finally{normalized.data.fill(0);}
 }catch(error){
  options.signal?.throwIfAborted();
  if(error instanceof ModelImageNormalizationError)throw error;
  throw new ModelImageNormalizationError('extraction_model_image_invalid');
 }finally{raw.fill(0);}
}
