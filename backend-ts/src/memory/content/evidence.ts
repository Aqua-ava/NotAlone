import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {canonicalJSON} from '../evidence/canonical-json.ts';
import type {FrozenMemoryContent,MemoryContentRegistry,MemoryContentScope} from './registry.ts';

export type ImageContentReference={file_id:string;sha256:string;mime_type:string;media_generation:string};
export type ContentRepresentation={representation:'text';text:string}|{representation:'image';reference:ImageContentReference};
export interface ContentEvidence {message_id:string;quote:string|null;description?:string;}
export type VersionedContentReference={version:1;frozen:FrozenMemoryContent;ownerId:string;contactId:string;messageId:string}&
 ({representation:'text';start:number;end:number}|{representation:'image';reference:ImageContentReference});
export type ContentCitationReference=ImageContentReference|VersionedContentReference;
export interface ContentCitation {
 contentKind:string;contentRef:ContentCitationReference|null;spanStart:bigint|null;spanEnd:bigint|null;explanation:string|null;
}
export interface ContentSource {
 message_id:string;text:string|null;occurred_at:string|null;content_kind?:string;content_ref?:ContentCitationReference;
 observation?:{kind:'model_observation';text:string};
}
const fail=(code='memory_source_stale'):never=>{throw new StorageFailure(code);};
const same=(a:unknown,b:unknown)=>canonicalJSON(a)===canonicalJSON(b);
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;

/** 引句按 Unicode 码点定位；重复引句不能猜测其原文位置。 */
export function quoteSpan(text:string,quote:string):{start:bigint;end:bigint}|null {
 const body=[...text],needle=[...quote],starts:number[]=[];
 if(!needle.length)return null;
 for(let n=0;n<=body.length-needle.length;n++)if(needle.every((c,i)=>body[n+i]===c))starts.push(n);
 return starts.length===1?{start:BigInt(starts[0]!),end:BigInt(starts[0]!+needle.length)}:null;
}
export function imageContentReference(value:unknown):ImageContentReference {
 const ref=value as ImageContentReference;
 if(!ref||typeof ref.file_id!=='string'||!/^[0-9a-f-]{36}$/i.test(ref.file_id)||typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256)
  ||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mime_type)||typeof ref.media_generation!=='string'||!/^\d+$/.test(ref.media_generation))return fail();
 return {file_id:ref.file_id,sha256:ref.sha256,mime_type:ref.mime_type,media_generation:ref.media_generation};
}
function assertScope(scope:MemoryContentScope):void {
 if(scope.message.owner_id!==undefined&&scope.message.owner_id!==scope.ownerId||scope.message.contact_id!==undefined&&scope.message.contact_id!==scope.contactId)return fail();
}
/** 物理内容的可读性、身份和定位由适配器证明，语义支持仍由记忆核验决定。 */
export function contentEvidence(registry:MemoryContentRegistry,tx:StorageTransaction,scope:MemoryContentScope,frozen:FrozenMemoryContent):ContentRepresentation {
 assertScope(scope);
 const current=registry.snapshot(tx,scope);
 if(!current||!same(current,frozen))return fail('memory_content_source_stale');
 return readRepresentation(registry,tx,scope,frozen);
}
function readRepresentation(registry:MemoryContentRegistry,tx:StorageTransaction,scope:MemoryContentScope,frozen:FrozenMemoryContent):ContentRepresentation {
 const plugin=registry.require(frozen);
 if(!plugin.evidence)return fail('memory_content_evidence_unavailable');
 const value=plugin.evidence(tx,{...scope,frozen});
 if(!value)return fail('memory_content_evidence_unavailable');
 if(value.representation==='text'&&nonempty(value.text))return {representation:'text',text:value.text};
 if(value.representation==='image')return {representation:'image',reference:imageContentReference(value.reference)};
 return fail('memory_content_evidence_unavailable');
}
export function contentCitation(registry:MemoryContentRegistry,tx:StorageTransaction,scope:MemoryContentScope,frozen:FrozenMemoryContent,evidence:ContentEvidence):ContentCitation {
 if(evidence.message_id!==scope.message.id)return fail();
 const value=contentEvidence(registry,tx,scope,frozen),base={contentKind:frozen.kind,spanStart:null,spanEnd:null,explanation:null};
 if(value.representation==='text'){
  if(!nonempty(evidence.quote)||evidence.description!==undefined&&evidence.description!==null)return fail();
  const span=quoteSpan(value.text,evidence.quote);if(!span)return fail();
  if(frozen.kind==='text')return {...base,contentRef:null,spanStart:span.start,spanEnd:span.end};
  return {...base,contentRef:{version:1,frozen:structuredClone(frozen),ownerId:scope.ownerId,contactId:scope.contactId,messageId:String(scope.message.id),representation:'text',start:Number(span.start),end:Number(span.end)}};
 }
 if(evidence.quote!==null||!nonempty(evidence.description))return fail();
 return {...base,explanation:evidence.description,contentRef:frozen.kind==='image'?value.reference:
  {version:1,frozen:structuredClone(frozen),ownerId:scope.ownerId,contactId:scope.contactId,messageId:String(scope.message.id),representation:'image',reference:value.reference}};
}
function slice(text:string,start:unknown,end:unknown):string {
 if(typeof start!=='bigint'&&typeof start!=='number'||typeof end!=='bigint'&&typeof end!=='number')return fail();
 const a=Number(start),b=Number(end),points=[...text];
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<=a||b>points.length)return fail();
 return points.slice(a,b).join('');
}
/** 同一引用在消费时复验当前来源；旧文字区间和旧图片引用保持原格式。 */
export function contentSource(registry:MemoryContentRegistry,tx:StorageTransaction,scope:MemoryContentScope,citation:ContentCitation):ContentSource {
 assertScope(scope);
 const frozen=registry.snapshot(tx,scope);if(!frozen||frozen.kind!==citation.contentKind)return fail('memory_content_source_stale');
 const value=readRepresentation(registry,tx,scope,frozen),base={message_id:String(scope.message.id),occurred_at:scope.message.sent_at==null?null:new Date(Number(scope.message.sent_at)).toISOString()};
 if(citation.contentKind==='text'){
  if(citation.contentRef!==null||value.representation!=='text')return fail();
  return {...base,text:slice(value.text,citation.spanStart,citation.spanEnd)};
 }
 const ref=citation.contentRef;if(!ref||citation.spanStart!==null||citation.spanEnd!==null)return fail();
 if(citation.contentKind==='image'){
  if(value.representation!=='image'||!same(imageContentReference(ref),value.reference))return fail('memory_content_source_stale');
  return {...base,text:null,content_kind:frozen.kind,content_ref:ref,...(nonempty(citation.explanation)?{observation:{kind:'model_observation' as const,text:citation.explanation}}:{})};
 }
 const versioned=ref as VersionedContentReference;
 if(versioned.version!==1||versioned.ownerId!==scope.ownerId||versioned.contactId!==scope.contactId||versioned.messageId!==scope.message.id||!same(versioned.frozen,frozen))return fail('memory_content_source_stale');
 if(versioned.representation==='text'&&value.representation==='text')return {...base,text:slice(value.text,versioned.start,versioned.end),content_kind:frozen.kind,content_ref:ref};
 if(versioned.representation==='image'&&value.representation==='image'&&same(imageContentReference(versioned.reference),value.reference))return {...base,text:null,content_kind:frozen.kind,content_ref:ref,...(nonempty(citation.explanation)?{observation:{kind:'model_observation' as const,text:citation.explanation}}:{})};
 return fail('memory_content_source_stale');
}
/** 检查模型引用确实落在所提供的原文或视觉材料，不能据此宣布语义正确。 */
export function matchesContentEvidence(evidence:ContentEvidence,sources:readonly ContentSource[]):boolean {
 return sources.some(source=>source.message_id===evidence.message_id&&(source.text===null
  ?evidence.quote===null&&nonempty(evidence.description)&&!!source.content_ref
  :nonempty(evidence.quote)&&(evidence.description===undefined||evidence.description===null)&&quoteSpan(source.text,evidence.quote)!==null));
}
/** 模型容量按实际视觉附件计数，与来源消息类型解耦。 */
export function sourceImageReference(source:ContentSource):ImageContentReference|null {
 if(source.text!==null)return null;
 const ref=source.content_ref as VersionedContentReference|undefined;
 if(ref?.version===1){if(ref.representation!=='image')return fail();return imageContentReference(ref.reference);}
 return imageContentReference(source.content_ref);
}
