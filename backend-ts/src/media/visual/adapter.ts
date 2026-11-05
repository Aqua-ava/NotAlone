import {createHash} from 'node:crypto';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {MediaAdapter, MediaExecution, MediaGoal, MediaKind} from '../sqlite/contracts.ts';
import type {VisualRequest, VisualResource, VisualResourcePort, VisualValidator} from './contracts.ts';
import {decodeWechatDat, MAX_VISUAL_BYTES} from './dat.ts';
import {validateVisual} from './native.ts';

function fixedData<T>(value:T):T {
  const copy=structuredClone(value);
  const freeze=(item:unknown):void=>{if(item&&typeof item==='object'){for(const child of Object.values(item))freeze(child);Object.freeze(item);}};
  freeze(copy);return copy;
}
function proof(context:VisualRequest, resource:VisualResource):void {
  const {source,token}=context,association=resource.association;
  if (!source || !token || source.support.status!=='supported' || source.contactId!==context.contactId || source.messageId!==context.messageId ||
      source.raw.kind!==context.kind || source.support.sourceGeneration!==token.source_generation ||
      association.protocol!=='media-association-v1' || association.recordId!==source.recordId || association.messageId!==context.messageId ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(association.profileId) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(association.resourceIdentity) ||
      Object.keys(token).some(key=>resource.authority[key as keyof typeof token]!==token[key as keyof typeof token])) {
    throw new StorageFailure('media_association_unverified');
  }
  if(resource.complete!==true)throw new StorageFailure('media_resource_incomplete');
  if(!Number.isSafeInteger(resource.expectedBytes)||resource.expectedBytes<1||resource.expectedBytes>MAX_VISUAL_BYTES)throw new StorageFailure('media_resource_too_large');
  if(!/^[a-f0-9]{64}$/.test(resource.expectedSha256))throw new StorageFailure('media_resource_incomplete');
}
async function collect(context:VisualRequest,resource:VisualResource):Promise<Buffer> {
  const chunks:Buffer[]=[];let length=0;const hash=createHash('sha256');
  try {
  for await(const chunk of resource.bytes){
    await context.checkpoint();
    if(!(chunk instanceof Uint8Array)||!chunk.length||chunk.length>resource.expectedBytes-length)throw new StorageFailure('media_resource_incomplete');
    if(chunks.length>=8192)throw new StorageFailure('media_resource_limit');
    length+=chunk.length;hash.update(chunk);chunks.push(Buffer.from(chunk));
    await context.checkpoint();
  }
  if(length!==resource.expectedBytes||hash.digest('hex')!==resource.expectedSha256)throw new StorageFailure('media_resource_incomplete');
  return Buffer.concat(chunks,length);
  } finally {for(const chunk of chunks)chunk.fill(0);}
}
/** 类型处理不定位微信路径；只消费认证端口固定的一条完整资源。 */
export class VisualMediaAdapter implements MediaAdapter {
  readonly version='visual-media-v1';
  private readonly resources:VisualResourcePort;
  private readonly validate:VisualValidator;
  private readonly readers=new Set<()=>Promise<void>>();
  private readonly executions=new Set<Promise<unknown>>();
  private closing=false;
  constructor(resources:VisualResourcePort,validate:VisualValidator=validateVisual){this.resources=resources;this.validate=validate;}
  supports(kind:MediaKind,goal:MediaGoal):boolean{return (kind==='image'||kind==='video')&&goal==='extract';}
  execute(execution:MediaExecution){
    if(this.closing)return Promise.reject(new StorageFailure('media_closed'));
    const operation=this.run(execution);this.executions.add(operation);
    void operation.then(()=>this.executions.delete(operation),()=>this.executions.delete(operation));return operation;
  }
  async close():Promise<void>{this.closing=true;await Promise.allSettled([...this.executions]);await Promise.all([...this.readers].map(close=>close()));}
  private async run(execution:MediaExecution){
    if(!this.supports(execution.kind,execution.goal)||!execution.source||!execution.token)throw new StorageFailure('media_association_unverified');
    if(execution.source.support.status!=='supported'||execution.source.contactId!==execution.contactId||execution.source.messageId!==execution.messageId||execution.source.raw.kind!==execution.kind||execution.source.support.sourceGeneration!==execution.token.source_generation)throw new StorageFailure('media_association_unverified');
    // 预期与端口输入分开持有；端口不能同时改写被验证对象和预期。
    const context:VisualRequest=Object.freeze({contactId:execution.contactId,messageId:execution.messageId,kind:execution.kind as 'image'|'video',goal:'extract' as const,source:fixedData(execution.source),token:fixedData(execution.token),signal:execution.signal,checkpoint:execution.checkpoint});
    await context.checkpoint();
    const request:VisualRequest=Object.freeze({...context,source:fixedData(context.source),token:fixedData(context.token)});
    const opened=await this.resources.open(request);
    const closeResource=opened.close;
    let released=false,closing:Promise<void>|undefined;
    const close=():Promise<void>=>{
      if(released)return Promise.resolve();
      return closing??=Promise.resolve().then(()=>closeResource.call(opened)).then(()=>{released=true;this.readers.delete(close);},()=>{closing=undefined;throw new StorageFailure('media_reader_release_failed');});
    };
    this.readers.add(close);execution.retainReader(close);
    let output:Buffer|undefined,input:Buffer|undefined;
    try {
      // 长度/摘要/质量/关联均固定于打开回执，不能由后来的流补造或替换。
      const resource:VisualResource=Object.freeze({association:fixedData(opened.association),authority:fixedData(opened.authority),
        envelope:opened.envelope,expectedBytes:opened.expectedBytes,expectedSha256:opened.expectedSha256,complete:opened.complete,
        bytes:opened.bytes,withImageKey:opened.withImageKey?.bind(opened),close});
      await context.checkpoint();proof(context,resource);
      if(context.kind==='video'&&resource.envelope!=='plain')throw new StorageFailure('unsupported');
      input=await collect(context,resource);await context.checkpoint();
      const usesV2=resource.envelope==='wechat_dat'&&input.subarray(0,6).equals(Buffer.from([7,8,86,50,8,7]));
      if(resource.envelope==='wechat_dat'){
        if(resource.withImageKey){
          output=await resource.withImageKey(key=>{
            const aesKey=key.aesKey?Buffer.from(key.aesKey):undefined;
            try{return decodeWechatDat(input!,{aesKey,xorKey:key.xorKey});}finally{aesKey?.fill(0);}
          });
        } else output=decodeWechatDat(input);
        input.fill(0);
      } else if(resource.envelope==='plain')output=input;
      else throw new StorageFailure('unsupported');
      await context.checkpoint();
      const bytes=output;
      await execution.save({role:context.kind==='image'?'image_display':'video_playback',expectedBytes:bytes.length,
        expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){
          for(let offset=0;offset<bytes.length;offset+=65536){await context.checkpoint();yield bytes.subarray(offset,offset+65536);await context.checkpoint();}
        })(),validate:async(localPath,signal)=>{
          await context.checkpoint();let validation;
          try{validation=await this.validate(localPath,context.kind,signal);}catch(error){
            if(usesV2&&error instanceof StorageFailure&&error.code==='media_image_invalid')throw new StorageFailure('needs_image_key');
            throw error;
          }
          await context.checkpoint();
          if(validation.containerValid!==true||validation.viewable!==(context.kind==='image')||validation.playable!==(context.kind==='video'))throw new StorageFailure('media_validation_failed');
          return validation;
        }});
      await context.checkpoint();
      return {association:resource.association};
    } finally {output?.fill(0);input?.fill(0);await close();}
  }
}
