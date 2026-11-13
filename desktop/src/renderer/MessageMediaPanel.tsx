import { useEffect, useRef, useState } from 'react';
import type { MediaGoal, MediaSnapshot, MessageMediaBridge, MessageMediaSelection, MessageMediaState } from '../shared/media-bridge';

const stateLabels = {pending:'待执行',running:'进行中',completed:'已保存',failed:'本次提取失败',interrupted:'已中断，等待明确新操作',revoked:'本次操作资格已失效'};
const kindLabels = {image:'图片',video:'视频',voice:'语音'};
const emptyState:MessageMediaState={revision:-1,contactId:null,messageId:null,scopeRevision:0,phase:'idle',snapshot:null,busy:null,retryGoal:null,error:null};
const processingErrors:Record<string,string>={
  needs_image_key:'缺少当前账号已核验的图片密钥，或密钥不匹配；本次没有保存图片，消息记录仍保留。',
  unsupported:'此封装尚未支持，本次未保存新结果。',
  image_dat_invalid:'图片加密封装的长度或填充校验失败，本次未保存新结果。',
  media_format_unsupported:'此媒体格式或编码尚未支持，本次未保存新结果。',
  media_image_invalid:'图片内容或实际解码校验失败，本次未保存新结果。',
  media_video_invalid:'视频容器不完整或无法完整解码，本次未保存新结果。',
  media_resource_incomplete:'资源完整读取或复制证明不符，本次未保存新结果。',
  media_thumbnail_only:'本机目前只有缩略图，太小看不清，没有保存；消息记录仍保留，微信下载标准图后会自动补取。',
  media_original_unavailable:'本次图片提取未完成；消息记录和先前合法文件仍保留。',
  media_metadata_invalid:'图片元数据或标记无法核验，未保存该文件；消息记录仍保留。',
  media_local_file_missing:'本机没有找到对应图片文件，本次没有保存图片；消息记录仍保留。',
  media_quality_unverified:'图片资源未通过完整文件校验，本次没有保存图片；消息记录仍保留。',
  media_validation_timeout:'媒体校验超时，本次未完成；先前合法文件保留。',
  media_resource_limit:'媒体超过当前尺寸、帧数或时长上限，本次未保存新结果。',
  media_validator_unavailable:'本机媒体校验组件尚未就绪，当前不可提取。',
  media_association_unverified:'消息与资源尚未唯一核验，未读取图片；消息记录仍保留。',
  media_association_failed:'消息与微信资源记录无法唯一对应，未读取图片，不再自动重试；消息记录仍保留。',
  media_database_key_missing:'缺少微信图片资源库的数据库密钥（微信重建数据库后会换密钥），暂时取不到图片；补取密钥后会自动重试，消息记录仍保留。',
  media_resource_too_large:'文件超过当前单文件32MiB上限，本次未保存；已有文件保留。',
  media_space_insufficient:'本次空间不足，已停止新增写入。请清理本机空间；先前合法保存的媒体仍保留。',
    voice_decode_failed:'语音解码失败；语音处理本轮暂缓，先前合法文件保留。',
    voice_runtime_unavailable:'本机语音转换组件不可用；语音处理本轮暂缓。',
    voice_conversion_timeout:'本地转换超过时间上限，已停止；语音处理本轮暂缓。',
    voice_conversion_cancelled:'本地转换已取消，未发布新播放文件。',
    voice_container_invalid:'语音容器无效或不受支持，本次未保存新结果。',
    voice_resource_limit:'语音超过当前输入、包数或输出上限，本次已停止。',
    voice_pcm_invalid:'本次语音输出格式校验失败，未发布新播放文件。',
    voice_copy_unproven:'缺少语音完整读取或唯一归属证明，本次未保存。',
    voice_copy_incomplete:'语音实际字节与固定来源证明不符，本次未保存。',
    voice_source_unverified:'语音来源或消息范围未核验，本次未读取。',
    voice_authority_mismatch:'语音资源的当前读取资格不符，本次未保存。',
    voice_reader_release_failed:'语音读取尚未结算，清理未完成；请继续原清理操作。',
};
function resultLabel(snapshot:MediaSnapshot):string {
  if(snapshot.state==='cleared')return snapshot.kind==='image'?'已清除，消息记录仍保留':'媒体已清除，聊天占位保留';
  if(snapshot.state==='invalidated')return '媒体文件或来源已失效，请核对后明确重提或清除';
  if(snapshot.state==='deleting')return '正在清除媒体，尚未完成';
  const attempt=snapshot.latestAttempt;
  if(snapshot.kind==='image'){
    if(snapshot.files.some(file=>file.role==='image_display'&&file.viewable))return '图片已保存';
    if(attempt&&['pending','running'].includes(attempt.state))return stateLabels[attempt.state];
    return attempt?'图片提取未完成，消息记录已保留':'尚未提取图片，消息记录已保留';
  }
  if(!attempt)return '尚未提取';
  if(attempt.state==='completed'&&snapshot.kind==='voice'&&snapshot.files.some(f=>f.role==='audio_source')&&!snapshot.files.some(f=>f.role==='audio_playback'&&f.playable))return '语音已保存，暂不可播放';
  if(attempt.state==='completed')return attempt.outcome==='limited'?'已保存有限结果':'已保存完整结果';
  return stateLabels[attempt.state];
}

function unavailableReason(code:string|null):string {
  if(code&&processingErrors[code])return processingErrors[code];
  if(code==='media_adapter_unavailable'||code==='media_type_unavailable')return '此类型提取尚未接入，当前不可用。';
  if(code==='media_cleanup_pending')return '媒体清理尚未完成，请继续核对原清理操作。';
  if(code==='media_already_running')return '这条媒体正在处理，请刷新查看当前操作。';
  if(code==='read_not_authorized')return '读取总开关已关闭或当前读取资格已失效；已存文件仍可查看或清除。';
  if(code==='reading_disabled'||code==='identity_reading_disabled'||code==='read_disabled')return '读取总开关已关闭；已存文件仍可查看或清除。';
  if(code)return '当前读取或联系人资格不满足；请核对联系人勾选、读取开关和来源状态。';
  return '';
}

export function MessageMediaPanel({bridge,selection,messageType}:{bridge?:MessageMediaBridge;selection:MessageMediaSelection;messageType:string}) {
  const [expanded,setExpanded]=useState(false);
  if(!['image','video','voice'].includes(messageType))return null;
  return <div className="message-media-panel">
    <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>媒体文件</button>
    {expanded && (bridge?<MediaDetails key={`${selection.contactId}:${selection.messageId}:${selection.scopeRevision}`} bridge={bridge} selection={selection} messageType={messageType}/>
      :<p role="status">媒体能力尚未连接，当前不可用。</p>)}
  </div>;
}
function MediaDetails({bridge,selection,messageType}:{bridge:MessageMediaBridge;selection:MessageMediaSelection;messageType:string}) {
  const [state,setState]=useState<MessageMediaState>(emptyState),[error,setError]=useState<string|null>(null);
  const [preview,setPreview]=useState<{sessionId:string;url:string;mimeType:string}|null>(null);
  const previewRef=useRef<typeof preview>(null),imageRef=useRef<HTMLImageElement>(null),playerRef=useRef<HTMLMediaElement|null>(null);
  const mounted=useRef(false),sequence=useRef(0),receivedRevision=useRef(-1),revokedSessions=useRef(new Set<string>());
  const sameScope=(next:MessageMediaState)=>next.contactId===selection.contactId && next.messageId===selection.messageId && next.scopeRevision===selection.scopeRevision;
  const release=async(showError=true)=>{
    const current=previewRef.current;if(!current)return;previewRef.current=null;
    // 先撤下真实DOM引用，再确认释放；删除协调器在确认前保持未完成。
    const player=playerRef.current;if(player){player.pause();player.removeAttribute('src');player.load();}
    imageRef.current?.removeAttribute('src');URL.revokeObjectURL(current.url);
    if(mounted.current)setPreview(null);
    try{await bridge.releasePreview(current.sessionId);}catch{if(showError&&mounted.current)setError('播放引用已撤下，后台释放尚未确认；请刷新清理状态。');}
  };
  useEffect(()=>{
    mounted.current=true;
    const receive=(next:MessageMediaState)=>{
      if(!mounted.current || next.revision<=receivedRevision.current)return;
      receivedRevision.current=next.revision;
      if(!sameScope(next)){void release();setState(emptyState);return;}
      if(!next.snapshot || ['cleared','invalidated','deleting'].includes(next.snapshot.state))void release();
      setState(current=>next.revision>current.revision?next:current);
    };
    const unsubscribe=bridge.onStateChanged(receive),stopPreview=bridge.onPreviewRevoking(sessionId=>{
      revokedSessions.current.add(sessionId);
      if(previewRef.current?.sessionId===sessionId)void release();
    });
    void bridge.getState().then(receive).catch(()=>{});
    void bridge.inspect(selection).catch(()=>{if(mounted.current)setError('媒体状态暂不可用，请重新读取。');});
    return ()=>{mounted.current=false;++sequence.current;unsubscribe();stopPreview();void release(false);};
  },[bridge,selection.contactId,selection.messageId,selection.scopeRevision]);
  const snapshot=sameScope(state)?state.snapshot:null;
  const voiceProcessingDeferred=messageType==='voice'||snapshot?.kind==='voice';
  const run=async(action:()=>Promise<void>)=>{setError(null);try{await action();}catch{if(mounted.current)setError('媒体操作暂不可用，请刷新状态后重试。');}};
  const open=async(fileId:string)=>{
    setError(null);await release();const opening=++sequence.current;let acquired:string|undefined;
    try{
      const data=await bridge.openPreview({...selection,fileId});
      acquired=data.sessionId;
      if(!mounted.current || opening!==sequence.current || revokedSessions.current.has(data.sessionId)){await bridge.releasePreview(data.sessionId);acquired=undefined;return;}
      const decoded=atob(data.dataBase64),bytes=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
      const next={sessionId:data.sessionId,mimeType:data.mimeType,url:URL.createObjectURL(new Blob([bytes],{type:data.mimeType}))};
      previewRef.current=next;setPreview(next);acquired=undefined;
    }catch{if(acquired)void bridge.releasePreview(acquired).catch(()=>{});if(mounted.current)setError('该文件暂无法预览，可能超出预览上限或资格已失效；请刷新状态。');}
  };
  const goal=(goal:MediaGoal)=>void run(()=>bridge.extract({...selection,goal}));
  const busy=state.busy!==null,extracting=state.busy!==null&&!['clear','preview'].includes(state.busy);
  const liveAttempt=snapshot?.latestAttempt && ['pending','running'].includes(snapshot.latestAttempt.state);
  return <section className="message-media-details" aria-label="本条消息媒体">
    <p className="rewrite-privacy">只处理这条消息。保存的媒体留在本机，不转写或加入记忆。</p>
    {voiceProcessingDeferred&&<p role="status">语音保存与格式转换本轮暂缓；已存资料仍可查看或清除。</p>}
    {(state.phase==='loading')&&<p role="status">正在读取媒体状态…</p>}
    {extracting&&<p role="status">本次媒体操作进行中，可刷新查看，或清除以停止旧操作。</p>}
    {state.busy==='clear'&&<p role="status">正在核对清理，请等待文件和活动引用复核完成。</p>}
    {snapshot&&<>
      <p role="status">{resultLabel(snapshot)}</p>
      {snapshot.requestedAttempt&&<p role="status">本次请求：{stateLabels[snapshot.requestedAttempt.state]}</p>}
      {snapshot.files.length>0&&snapshot.latestAttempt&&['failed','interrupted','revoked'].includes(snapshot.latestAttempt.state)&&<p className="rewrite-privacy">以下是先前合法保存的文件，本次操作未发布新结果。</p>}
      {snapshot.latestAttempt?.errorCode&&<p className="rewrite-privacy">{processingErrors[snapshot.latestAttempt.errorCode]??'本次处理有未完成步骤，请根据文件状态核对结果。'}</p>}
      {snapshot.cleanup&&snapshot.cleanup.state!=='completed'&&<p role="status">{snapshot.cleanup.state==='blocked'?'清理尚未完成，可继续原清理操作。':'文件清理尚在复核中。'}</p>}
      {snapshot.files.length>0&&<ul className="message-media-files">{snapshot.files.map(file=><li key={file.fileId}>
        <span><span>{file.role==='image_display'?'已存图片':
          file.role==='audio_source'?'原始语音文件':file.role==='audio_playback'?'语音播放文件':'视频播放文件'}</span> · {file.format.toUpperCase()} · {file.byteSize} 字节</span>
        {file.role==='audio_source'&&!snapshot.files.some(f=>f.role==='audio_playback'&&f.playable)&&<span> · 尚不可播放</span>}
        {(file.viewable||file.playable)&&<button type="button" disabled={busy} onClick={()=>void open(file.fileId)}>{file.viewable?'查看文件':'播放文件'}</button>}
      </li>)}</ul>}
      {unavailableReason(snapshot.capabilities.reason)&&<p role="status">{unavailableReason(snapshot.capabilities.reason)}</p>}
      <div className="message-media-actions">
        {!voiceProcessingDeferred&&<button type="button" disabled={busy||!!liveAttempt||!snapshot.capabilities.extract} onClick={()=>goal('extract')}>保存这条{kindLabels[snapshot.kind]}</button>}
        <button type="button" disabled={state.busy==='clear'||state.busy==='preview'} onClick={()=>void run(()=>bridge.clear(selection))}>{snapshot.cleanup&&snapshot.cleanup.state!=='completed'?'继续清理原操作':'清除这条媒体'}</button>
      </div>
    </>}
    {preview&&<div className="message-media-preview">
      {preview.mimeType.startsWith('image/')?<img ref={imageRef} src={preview.url} alt="本条消息的已存图片" style={{maxWidth:'100%',maxHeight:360}}/>:
        preview.mimeType.startsWith('audio/')?<audio ref={node=>{playerRef.current=node;}} src={preview.url} controls/>:
        <video ref={node=>{playerRef.current=node;}} src={preview.url} controls style={{width:'100%',minHeight:160,maxHeight:360}}/>}
      <button type="button" onClick={()=>void release()}>关闭预览</button>
    </div>}
    {(error||state.error)&&<p role="alert">{error??state.error}</p>}
    {!voiceProcessingDeferred&&state.retryGoal&&<button type="button" disabled={busy} onClick={()=>void run(()=>bridge.retry(selection))}>重查同次媒体操作</button>}
    <button type="button" disabled={state.busy==='clear'} onClick={()=>void run(()=>bridge.inspect(selection))}>刷新媒体状态</button>
  </section>;
}
