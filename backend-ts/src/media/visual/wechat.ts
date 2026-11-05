import {createHash} from 'node:crypto';
import type {SharedWechatClient} from '../../history/wechat/shared-client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySource} from '../../history/sqlite/contracts.ts';
import {loadNarrowWechatOptions,supportsWechatImageKeyChannel} from '../../history/wechat/artifacts.ts';
import {NarrowWechatClient, type WechatImageOpenResult, type WechatImageSourceIdentity} from '../../history/wechat/native-client.ts';
import type {VisualRequest, VisualResource, VisualResourcePort} from './contracts.ts';
import {enrichImageToolOptions,prepareImageRuntimeKey} from './image-tools.ts';

const eligibilityKeys=['owner_id','contact_id','account_id','conversation_id','binding_id','grant_id','verification_id','read_epoch',
  'selection_generation','data_generation','identity_generation','scope_revision','barrier_generation','source_generation'] as const;
const hashPattern=/^[a-f0-9]{64}$/;
const integerPattern=/^(0|-?[1-9][0-9]{0,18})$/;
const unsignedPattern=/^(0|[1-9][0-9]{0,19})$/;
const reject=(code='media_association_unverified'):never=>{throw new StorageFailure(code);};

function fixed<T>(value:T):T {
  const copy=structuredClone(value);
  const freeze=(item:unknown):void=>{if(item&&typeof item==='object'){for(const child of Object.values(item))freeze(child);Object.freeze(item);}};
  freeze(copy);return copy;
}
function eligibility(value:unknown):ReadEligibility {
  if(!value||typeof value!=='object'||Array.isArray(value))return reject();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==eligibilityKeys.length||eligibilityKeys.some(key=>!Object.hasOwn(row,key))
    ||Object.values(row).some(item=>typeof item!=='string'||!item.length||item.length>2048||/[\u0000-\u001f\u007f]/.test(item)))return reject();
  return structuredClone(row) as unknown as ReadEligibility;
}
function identity(request:VisualRequest,source:HistorySource,token:ReadEligibility):WechatImageSourceIdentity {
  if(request.kind!=='image'||request.goal!=='extract'||source.contactId!==request.contactId||source.messageId!==request.messageId
    ||source.raw.kind!=='image'||source.raw.text!==null||source.support.status!=='supported'
    ||source.support.sourceGeneration!==token.source_generation||token.contact_id!==request.contactId
    ||!hashPattern.test(source.raw.partition)||!hashPattern.test(source.raw.table)
    ||typeof source.raw.localId!=='string'||!integerPattern.test(source.raw.localId)
    ||typeof source.raw.serverId!=='string'||!integerPattern.test(source.raw.serverId)
    ||typeof source.raw.sentAt!=='string'||!unsignedPattern.test(source.raw.sentAt)
    ||!Number.isSafeInteger(Number(source.raw.sentAt))||BigInt(source.raw.sentAt)>253402300799999n
    ||typeof source.support.accountKey!=='string'||typeof source.support.conversationKey!=='string'
    ||!/^[A-Za-z0-9_.@-]{1,255}$/.test(source.support.accountKey)||!/^[A-Za-z0-9_.@-]{1,255}$/.test(source.support.conversationKey))return reject();
  return {partition:source.raw.partition,table:source.raw.table,localId:source.raw.localId,serverId:source.raw.serverId,sentAt:source.raw.sentAt};
}
function mapped(error:unknown):unknown {
  if(!(error instanceof StorageFailure))return error;
  const codes:Record<string,string>={
    history_image_association_unverified:'media_association_unverified',
    history_image_original_unavailable:'media_original_unavailable',
    history_image_metadata_invalid:'media_metadata_invalid',
    history_image_local_file_missing:'media_local_file_missing',
    history_image_key_unavailable:'needs_image_key',
    history_image_thumbnail_only:'media_thumbnail_only',
    history_image_format_unsupported:'media_format_unsupported',
    history_image_decoder_unavailable:'media_validator_unavailable',
    history_image_quality_unverified:'media_quality_unverified',
    history_image_source_changed:'media_association_unverified',
    history_image_resource_invalid:'media_original_unavailable',
    history_image_token_invalid:'media_association_unverified',
    history_image_offset_invalid:'media_resource_incomplete',
    history_image_too_large:'media_resource_too_large',
    history_image_read_failed:'media_resource_incomplete',
    history_image_request_invalid:'media_association_unverified',
    history_account_changed:'media_association_unverified',
    history_scope_changed:'media_association_unverified',
    history_source_changed:'media_association_unverified',
    history_target_unverified:'media_association_unverified',
    history_native_cancelled:'media_interrupted',
  };
  const code=codes[error.code];
  return code?new StorageFailure(code):error;
}
async function checked(request:VisualRequest):Promise<void> {
  if(request.signal.aborted)throw new StorageFailure('media_interrupted');
  await request.checkpoint();
  if(request.signal.aborted)throw new StorageFailure('media_interrupted');
}
function association(opened:WechatImageOpenResult,source:HistorySource,messageId:string) {
  const proof=opened.qualityProof;
  if(proof.kind==='wechat-message-image-content-v2')return Object.freeze({protocol:'media-association-v1' as const,
    profileId:'wechat-message-image-v2',recordId:source.recordId,messageId,
    resourceIdentity:'wechat-message-image-v2:'+createHash('sha256').update(JSON.stringify([
      opened.resourceSourceGeneration,proof,opened.partition,opened.table,opened.localId,opened.serverId,opened.sentAt])).digest('hex')});
  const identitySource=proof.kind==='wechat-cdn-big-hd-exact-content-v4'||proof.kind==='wechat-message-image-content-v1'
    ?[opened.resourceSourceGeneration,proof.resourceInfoId,proof.matchingResourceIds,proof.resourceSize,proof.verifiedBytes,proof.verifiedSha256,
      proof.sourceSha256,proof.conversion,opened.partition,opened.table,opened.localId,opened.serverId,opened.sentAt]
    :proof.kind==='wechat-cdn-big-hd-exact-content-v3'
    ?[opened.resourceSourceGeneration,proof.resourceInfoId,proof.matchingResourceIds,proof.resourceSize,proof.verifiedBytes,proof.verifiedSha256,
      opened.partition,opened.table,opened.localId,opened.serverId,opened.sentAt]
    :[opened.resourceSourceGeneration,opened.resourceTable,opened.resourceId,opened.resourceTypeRaw,opened.variantCode,
      opened.partition,opened.table,opened.localId,opened.serverId,opened.sentAt];
  const identity=createHash('sha256').update(JSON.stringify(identitySource)).digest('hex');
  const profileId=proof.kind==='wechat-message-image-content-v1'?'wechat-message-image-v1':'wechat-image-original-v1';
  return Object.freeze({protocol:'media-association-v1' as const,profileId,recordId:source.recordId,
    messageId,resourceIdentity:profileId+':'+identity});
}
function resourceBytes(request:VisualRequest,client:NarrowWechatClient,opened:WechatImageOpenResult):AsyncIterable<Uint8Array> {
  let started=false;
  return (async function*(){
    if(started)throw new StorageFailure('media_resource_incomplete');
    started=true;
    const digest=createHash('sha256');let offset=0,finished=false;
    while(offset<opened.expectedBytes){
      await checked(request);
      let response;
      try{response=await client.readImageSelected(opened.resourceToken,offset,request.signal);}
      catch(error){throw mapped(error);}
      const chunk=Buffer.from(response.chunkBase64,'base64');
      try{
        if(response.offset!==offset||response.totalBytes!==opened.expectedBytes||response.bytesRead<1||response.bytesRead>65536
          ||response.eof!==(offset+response.bytesRead===opened.expectedBytes)||chunk.length!==response.bytesRead)throw new StorageFailure('media_resource_incomplete');
        digest.update(chunk);offset+=chunk.length;
        if(response.eof){
          if(response.verifiedSha256!==opened.expectedSha256||digest.digest('hex')!==opened.expectedSha256)throw new StorageFailure('media_resource_incomplete');
          finished=true;
        }else if(response.verifiedSha256!==undefined)throw new StorageFailure('media_resource_incomplete');
        await checked(request);
        yield chunk;
      }finally{chunk.fill(0);}
    }
    if(!finished||offset!==opened.expectedBytes)throw new StorageFailure('media_resource_incomplete');
  })();
}
async function closeResource(client:NarrowWechatClient,token:string,release?:()=>Promise<void>):Promise<void> {
  let closeError:unknown;
  try{await client.closeImageSelected(token);}catch(error){if(!client.stoppedReason)closeError=error;}
  if(release)await release();else await client.close();
  if(closeError)throw mapped(closeError);
}

/** 只通过固定版本的窄原生客户端打开当前授权联系人中已关联的一条图片。 */
export function createWechatImageResourcePort(executable?:string,shared?:SharedWechatClient):VisualResourcePort {
  return {open:async(input:VisualRequest):Promise<VisualResource>=>{
    if(!executable)return reject('history_support_unverified');
    if(!input||typeof input!=='object'||!(input.signal instanceof AbortSignal)||typeof input.checkpoint!=='function')return reject();
    const token=fixed(eligibility(input.token)),source=fixed(input.source),expectedSource=fixed(source),expectedToken=fixed(token);
    const selected=identity(input,source,token);
    if(input.contactId!==token.contact_id)return reject();
    const request:VisualRequest=Object.freeze({...input,source:fixed(source),token:fixed(token)});
    let lease:Awaited<ReturnType<SharedWechatClient['acquire']>>|undefined;
    let client:NarrowWechatClient|undefined,opened:WechatImageOpenResult|undefined,transferred=false;
    try{
      await checked(request);
      const imageKeyChannel=await supportsWechatImageKeyChannel(executable);
      if(!imageKeyChannel)reject('history_support_unverified');
      if(shared){lease=await shared.acquire({},undefined,request.signal);client=lease.client;}
      else{
        const loadedOptions=await loadNarrowWechatOptions(executable);
        const options=await enrichImageToolOptions({...loadedOptions,imageKeyChannel:true});
        if(request.signal.aborted)throw new StorageFailure('media_interrupted');
        client=new NarrowWechatClient(options);
      }
      await checked(request);
      const selectedScope=await client.resolveSelected(source.support.conversationKey,request.signal);
      if(selectedScope.accountKey!==source.support.accountKey||selectedScope.conversationKey!==source.support.conversationKey
        ||selectedScope.sourceGeneration!==expectedToken.source_generation||selectedScope.sourceGeneration!==expectedSource.support.sourceGeneration)reject();
      await checked(request);
      await client.inspectSelected(request.signal);
      const support=await client.supportSelected(request.signal);
      if(support.status!=='supported'||support.accountKey!==source.support.accountKey||support.conversationKey!==source.support.conversationKey
        ||support.sourceGeneration!==expectedToken.source_generation)reject();
      await checked(request);
      const target=await client.targetSelected(request.signal);
      if(target.sourceGeneration!==expectedToken.source_generation
        ||!target.tables.some(item=>item.partition===selected.partition&&item.instance===selected.table))reject();
      await checked(request);
      try{opened=await client.openImageSelected(target,selected,request.signal);}
      catch(error){
        if(!(error instanceof StorageFailure)||error.code!=='history_image_key_unavailable')throw error;
        let runtimeKey:Awaited<ReturnType<typeof prepareImageRuntimeKey>>;
        try{runtimeKey=await prepareImageRuntimeKey(executable,source.support.accountKey,request.signal);}
        catch(providerError){await client.supplyImageRuntimeKey(null,request.signal).catch(()=>{});throw providerError;}
        await client.supplyImageRuntimeKey(runtimeKey,request.signal);
        if(!runtimeKey)throw error;
        opened=await client.openImageSelected(target,selected,request.signal);
      }
      if(opened.sourceGeneration!==expectedToken.source_generation||opened.sourceGeneration!==target.sourceGeneration
        ||!hashPattern.test(opened.resourceSourceGeneration))reject();
      // 缩略图太小，不保存：关闭句柄并按“仅缩略图”失败，聊天中该消息保持占位，之后按持久退避重试。
      if(opened.quality==='thumbnail')throw new StorageFailure('media_thumbnail_only');
      await checked(request);
      const stableOpened=fixed(opened),stableAuthority=fixed(expectedToken);
      let closing:Promise<void>|undefined;
      const close=()=>closing??=closeResource(client!,stableOpened.resourceToken,lease?()=>lease!.release():undefined);
      const resource:VisualResource=Object.freeze({
        association:association(stableOpened,expectedSource,input.messageId),authority:stableAuthority,envelope:'plain',
        expectedBytes:stableOpened.expectedBytes,expectedSha256:stableOpened.expectedSha256,complete:true as const,
        bytes:resourceBytes(request,client,stableOpened),
        close,
      });
      transferred=true;
      return resource;
    }catch(error){throw mapped(error);}
    finally{
      if(client&&!transferred){
        if(opened&&!client.stoppedReason)try{await client.closeImageSelected(opened.resourceToken);}catch{/* 关闭进程会释放已打开的本机资源。 */}
        if(lease)await lease.release();else await client.close();
      }
    }
  }};
}
