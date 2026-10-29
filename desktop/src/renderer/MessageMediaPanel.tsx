import { useEffect, useRef, useState } from 'react';
import type { MediaGoal, MediaSnapshot, MessageMediaBridge, MessageMediaSelection, MessageMediaState } from '../shared/media-bridge';

const stateLabels = {pending:'待执行',running:'进行中',completed:'已保存',failed:'本次提取失败',interrupted:'已中断，等待明确新操作',revoked:'本次操作资格已失效'};
const kindLabels = {image:'图片',video:'视频',voice:'语音'};
const emptyState:MessageMediaState={revision:-1,contactId:null,messageId:null,scopeRevision:0,phase:'idle',snapshot:null,busy:null,retryGoal:null,error:null};
function resultLabel(snapshot:MediaSnapshot):string {
  if(snapshot.state==='cleared')return '媒体已清除，聊天占位保留';
  if(snapshot.state==='invalidated')return '媒体来源已失效';
  if(snapshot.state==='deleting')return '正在清除媒体，尚未完成';
  const attempt=snapshot.latestAttempt;
  if(!attempt)return '尚未提取';
  if(attempt.state==='completed')return attempt.outcome==='limited'?'已保存有限结果':attempt.outcome==='quality_unknown'?'已保存，质量未核验':'已保存完整结果';
  return stateLabels[attempt.state];
}
function unavailableReason(code:string|null):string {
  if(code==='media_adapter_unavailable'||code==='media_type_unavailable')return '此类型提取尚未接入，当前不可用。';
  if(code==='media_cleanup_pending')return '媒体清理尚未完成，请继续核对原清理操作。';
  if(code==='media_already_running')return '这条媒体正在处理，请刷新查看当前操作。';
  if(code==='read_not_authorized')return '读取总开关已关闭或当前读取资格已失效；已存文件仍可查看，本地语音转换按资格开放。';
  if(code==='reading_disabled'||code==='identity_reading_disabled'||code==='read_disabled')return '读取总开关已关闭；已存文件仍可查看，本地语音转换按资格开放。';
  if(code)return '当前读取或联系人资格不满足；请核对联系人勾选、读取开关和来源状态。';
  return '';
}

export function MessageMediaPanel({bridge,selection,messageType}:{bridge?:MessageMediaBridge;selection:MessageMediaSelection;messageType:string}) {
  const [expanded,setExpanded]=useState(false);
  if(!['image','video','voice'].includes(messageType))return null;
  return <div className="message-media-panel">
    <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>媒体文件</button>
    {expanded && (bridge?<MediaDetails key={`${selection.contactId}:${selection.messageId}:${selection.scopeRevision}`} bridge={bridge} selection={selection}/>
      :<p role="status">媒体能力尚未连接，当前不可用。</p>)}
  </div>;
}
function MediaDetails({bridge,selection}:{bridge:MessageMediaBridge;selection:MessageMediaSelection}) {
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
    {(state.phase==='loading')&&<p role="status">正在读取媒体状态…</p>}
    {extracting&&<p role="status">本次媒体操作进行中，可刷新查看，或清除以停止旧操作。</p>}
    {state.busy==='clear'&&<p role="status">正在核对清理，请等待文件和活动引用复核完成。</p>}
    {snapshot&&<>
      <p role="status">{resultLabel(snapshot)}</p>
      {snapshot.files.length>0&&snapshot.latestAttempt&&['failed','interrupted','revoked'].includes(snapshot.latestAttempt.state)&&<p className="rewrite-privacy">以下是先前合法保存的文件，本次操作未发布新结果。</p>}
      {snapshot.latestAttempt?.errorCode&&<p className="rewrite-privacy">{snapshot.latestAttempt.errorCode==='media_space_insufficient'?'本次空间不足，已停止新增写入。请清理本机空间；先前合法保存的媒体仍保留。':'本次处理有未完成步骤，请根据文件状态核对结果。'}</p>}
      {snapshot.cleanup&&snapshot.cleanup.state!=='completed'&&<p role="status">{snapshot.cleanup.state==='blocked'?'清理尚未完成，可继续原清理操作。':'文件清理尚在复核中。'}</p>}
      {snapshot.files.length>0&&<ul className="message-media-files">{snapshot.files.map(file=><li key={file.fileId}>
        <span><span>{file.role==='image_display'?(file.imageQuality==='original'?'原图':file.imageQuality==='thumbnail'?'缩略图，原图未取得':'图片质量未核验'):
          file.role==='audio_source'?'原始语音文件':file.role==='audio_playback'?'语音播放文件':'视频播放文件'}</span> · {file.format.toUpperCase()} · {file.byteSize} 字节</span>
        {file.role==='audio_source'&&!snapshot.files.some(f=>f.role==='audio_playback'&&f.playable)&&<span> · 尚不可播放</span>}
        {(file.viewable||file.playable)&&<button type="button" disabled={busy} onClick={()=>void open(file.fileId)}>{file.viewable?'查看文件':'播放文件'}</button>}
      </li>)}</ul>}
      {unavailableReason(snapshot.capabilities.reason)&&<p role="status">{unavailableReason(snapshot.capabilities.reason)}</p>}
      <div className="message-media-actions">
        <button type="button" disabled={busy||!!liveAttempt||!snapshot.capabilities.extract} onClick={()=>goal('extract')}>保存这条{kindLabels[snapshot.kind]}</button>
        {snapshot.kind==='image'&&<button type="button" disabled={busy||!!liveAttempt||!snapshot.capabilities.originalUpgrade} onClick={()=>goal('original_upgrade')}>补提原图</button>}
        {snapshot.kind==='voice'&&<button type="button" disabled={busy||!!liveAttempt||!snapshot.capabilities.audioConversion} onClick={()=>goal('audio_conversion')}>本地转为可播放文件</button>}
        <button type="button" disabled={state.busy==='clear'||state.busy==='preview'} onClick={()=>void run(()=>bridge.clear(selection))}>{snapshot.cleanup&&snapshot.cleanup.state!=='completed'?'继续清理原操作':'清除这条媒体'}</button>
      </div>
    </>}
    {preview&&<div className="message-media-preview">
      {preview.mimeType.startsWith('image/')?<img ref={imageRef} src={preview.url} alt="本条消息的已存图片" style={{maxWidth:'100%',maxHeight:360}}/>:
        preview.mimeType.startsWith('audio/')?<audio ref={node=>{playerRef.current=node;}} src={preview.url} controls/>:
        <video ref={node=>{playerRef.current=node;}} src={preview.url} controls style={{maxWidth:'100%',maxHeight:360}}/>}
      <button type="button" onClick={()=>void release()}>关闭预览</button>
    </div>}
    {(error||state.error)&&<p role="alert">{error??state.error}</p>}
    {state.retryGoal&&<button type="button" disabled={busy} onClick={()=>void run(()=>bridge.retry(selection))}>重查同次媒体操作</button>}
    <button type="button" disabled={state.busy==='clear'} onClick={()=>void run(()=>bridge.inspect(selection))}>刷新媒体状态</button>
  </section>;
}
