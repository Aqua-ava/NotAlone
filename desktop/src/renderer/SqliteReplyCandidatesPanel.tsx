import {useEffect,useRef,useState} from 'react';
import {Icon} from './icons';
import {CandidateBasis,SqliteCandidateReferences} from './SqliteCandidateReferences';
import type {SqliteDiscussionBridge,SqliteDiscussionReceipt} from '../shared/sqlite-discussion-bridge';
import {sqliteReplySourceUnavailableMessage,readSqliteCandidatePage,readSqliteCandidateVersion,readSqliteCandidateStatus,type SqliteCandidateStatus,type SqliteCandidatePage,type SqliteCandidateVersion,type SqliteCandidateOperation,type SqliteReplyWorkspace} from '../shared/sqlite-reply-candidates';
type CandidateRequest=SqliteCandidatePage['requests'][number];
type GenerationInput={text:string;workspace:SqliteReplyWorkspace;carry?:string};
const progressLabel=(phase:SqliteCandidateStatus['phase'])=>({not_found:'正在接纳本次请求…',preparing:'正在整理本次资料…',queued:'正在等待生成…',generating:'正在等待模型回复…',saving:'正在保存候选…',committed:'正在读取已保存候选…',failed:'正在核对本次结果…',unknown:'正在核对本次结果…'}[phase]);
function interruptionMessage(code:string|null|undefined,sent:boolean|undefined,abandoned:boolean|undefined):string|undefined{
 // 仅本机确认“已发出但未收到结果”并自动放弃时才这样说；已收到响应的失败同样已发送，不能套用。
 if(abandoned===true)return '已发出但没有收到结果，已自动放弃；可重新生成，旧请求可能已产生费用。';
 if(code==='discussion_preparation_timeout')return sent===false?'整理资料超时，尚未发给模型。':'本次生成超时，没有保存候选。';
 if(code==='discussion_storage_interrupted')return sent===false?'本机资料服务在准备时中断，尚未发给模型。':'本机资料服务中断，请重新生成。';
 if(code==='runtime_interrupted')return sent===false?'应用在整理资料时中断，尚未发给模型。':'应用在生成期间中断，请重新生成。';
}
function statusFailure(status:SqliteCandidateStatus):string{
 if(status.phase==='unknown')return '模型请求已发出，结果暂未确认。请核对原请求。';
 if(status.phase==='not_found')return '尚未找到原请求，请稍后核对。';
 if(status.phase!=='failed')return '原请求仍在处理，请稍后核对。';
 const interruption=interruptionMessage(status.errorCode,status.sent,status.abandoned);if(interruption)return interruption;
 if(status.errorCode==='discussion_source_unavailable'||status.errorCode==='history_source_not_available')return sqliteReplySourceUnavailableMessage;
 if(status.errorCode==='reply_sources_not_ready'&&!status.sent)return '聊天读取暂未恢复，请重试生成。';
 if(status.errorCode?.includes('timeout'))return status.sent?'本次生成超时，没有保存候选。':'整理资料超时，尚未发给模型。';
 if(status.errorCode&&/source|stale|knowledge|invalidated/.test(status.errorCode))return '本次参考资料发生变化，请重新生成。';
 return status.sent?'本次生成失败，没有保存候选。':'本次准备失败，尚未发给模型。';
}
interface Props {bridge:SqliteDiscussionBridge;contactId:string|null;scopeRevision:number;sessionId:string|null;disabled?:boolean;readOnly?:boolean;initialDraft?:string;onDraftChange?:(text:string,scope:{contactId:string;scopeRevision:number})=>void;onSubmitted?:(receipt:SqliteDiscussionReceipt)=>void}
/** 草稿、候选和依据共用同一失效边界；迟到回包不能重新挂回旧正文。 */
export function SqliteReplyCandidatesPanel({bridge,contactId,scopeRevision,sessionId,disabled=false,readOnly=false,initialDraft='',onDraftChange,onSubmitted}:Props){
 const scopeKey=JSON.stringify([contactId,scopeRevision,sessionId]),latest=useRef({scopeKey,bridge});latest.current={scopeKey,bridge};
 const revision=useRef(0),mounted=useRef(false),operation=useRef<object|null>(null);
 const retry=useRef<(GenerationInput&{requestKey:string})|null>(null);
 const seeded=useRef<string|null>(null),stopProgress=useRef<(()=>void)|null>(null);
 const [progress,setProgress]=useState<SqliteCandidateStatus|null>(null);
 const [progressUnreadable,setProgressUnreadable]=useState(false);
 const qualifiedRequests=useRef<string[]>([]),generationFailure=useRef<{requestKey:string;message:string}|null>(null);
 const [page,setPage]=useState<SqliteCandidatePage|null>(null),[draft,setDraft]=useState(''),[carry,setCarry]=useState<string|undefined>();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [edits,setEdits]=useState<Record<string,string[]>>({}),[inspected,setInspected]=useState<Record<string,SqliteCandidateVersion>>({});
 // 折叠状态按 requestId 覆盖默认值：最新一次默认展开，用户手动切换后以手动为准；clear() 时重置。
 const [openRequests,setOpenRequests]=useState<Record<string,boolean>>({});
 const [referenceRevision,setReferenceRevision]=useState(0);
 const available=!!bridge.candidates&&!!contactId&&!!sessionId&&!disabled;
 const writable=available&&!readOnly;
 const unresolved=!!retry.current&&!(progress?.phase==='failed'&&progress.retryable);
 function clearVersions(){setEdits({});setInspected({});}
 function discardCandidateReference(){setCarry(undefined);retry.current=null;}
 function clear(){stopProgress.current?.();setProgress(null);setProgressUnreadable(false);++revision.current;operation.current=null;retry.current=null;generationFailure.current=null;qualifiedRequests.current=[];setPage(null);setCarry(undefined);setBusy(false);setError('');setNotice('');clearVersions();setOpenRequests({});}
 useEffect(()=>{mounted.current=true;const off=bridge.onInvalidated(()=>clear());return()=>{mounted.current=false;stopProgress.current?.();++revision.current;operation.current=null;off();};},[bridge,scopeKey]);
 useEffect(()=>{clear();setDraft('');seeded.current=null;if(available)void run({action:'read'});},[scopeKey,bridge]);
 // 临时禁用只暂停新操作；来源及范围失效仍由订阅和scopeKey立即清除。
 useEffect(()=>{if(available&&!page)void run({action:'read'});},[disabled]);
 // 联系人草稿是独立输入的权威；首次回显只播种当前讨论，不在交接时消费它。
 // 用户已经编辑后，迟到的联系人回显不能覆盖本地新按键。
 useEffect(()=>{
  if(writable&&initialDraft&&seeded.current!==scopeKey){seeded.current=scopeKey;setDraft(initialDraft);}
 },[scopeKey,writable,initialDraft]);
 type Command=(SqliteCandidateOperation extends infer O?O extends SqliteCandidateOperation?Omit<O,'contactId'|'scopeRevision'|'sessionId'>:never:never)|{action:'continue';candidateId:string;versionNo:number};
 function showPage(value:unknown){
  const next=readSqliteCandidatePage(value);
  // 仅保留无正文的来源标识，短暂读取失败后仍能核对候选及旧携入的资格。
  const readable=qualifiedRequests.current;
  if(readable.some(id=>!next.requests.some(r=>r.requestId===id&&r.sourceState==='available'))){
   discardCandidateReference();setNotice('');
  }
  qualifiedRequests.current=next.requests.filter(r=>r.sourceState==='available'&&r.candidates.length).map(r=>r.requestId);
  setPage(next);
  setReferenceRevision(value=>value+1);
  clearVersions();
 }
 function rejectOperation(error:unknown){
  const text=(error instanceof Error?error.message:'候选结果尚未确认，请重新读取。').replace(/^Error invoking remote method '[^']+': Error: /,'');
  clearVersions();setNotice('');
  if(text===sqliteReplySourceUnavailableMessage||/失效|已变化|已不可用|请先确认/.test(text)){
   qualifiedRequests.current=[];setPage(null);discardCandidateReference();
  }else setPage(old=>old?{requests:[]}:null);
  setError(text);return text;
 }
 async function run(command:Command){
  if(!available||!bridge.candidates||!contactId||!sessionId||operation.current
   ||readOnly&&!['read','version','status'].includes(command.action))return;
  const token={},boundary=revision.current;operation.current=token;setBusy(true);setError('');
  const current=()=>mounted.current&&operation.current===token&&revision.current===boundary&&latest.current.scopeKey===scopeKey&&latest.current.bridge===bridge;
  const scope={contactId,scopeRevision,sessionId};
  const execute=(command:Command)=>bridge.candidates!.execute({...scope,...command,action:command.action==='continue'?'select':command.action} as SqliteCandidateOperation);
  const reloadPage=async()=>{const next=await execute({action:'read'});if(!current())return false;showPage(next);return true;};
  const readStatus=async(requestKey:string)=>{const status=readSqliteCandidateStatus(await execute({action:'status',requestKey}));if(status.requestKey!==requestKey)throw new Error('候选状态不匹配。');return status;};
  const showStatus=async(status:SqliteCandidateStatus)=>{
   if(!current())return;setProgress(status);setProgressUnreadable(false);
   if(status.phase!=='committed'){
    if(status.phase==='failed'&&!status.sent&&status.errorCode==='reply_sources_not_ready'){
     // 保留联系人独立输入；撤下旧选稿与重试引用，不随恢复请求重新携入。
     const carried=!!retry.current?.carry||!!carry;
     qualifiedRequests.current=[];setCarry(undefined);clearVersions();
     setPage(old=>old?{requests:[]}:null);
     if(carried)discardCandidateReference();
    }
    setError(status.phase==='not_found'&&generationFailure.current?.requestKey===status.requestKey?generationFailure.current.message:statusFailure(status));return;
   }
   const original=retry.current;if(!await reloadPage())return;
   retry.current=null;setError('');setCarry(undefined);
   if(original&&draft===original.text){setDraft('');onDraftChange?.('',{contactId,scopeRevision});}
   setNotice('已找到原请求保存的候选。');
  };
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{stopped=true;clearTimeout(timer);if(stopProgress.current===stop)stopProgress.current=null;};
  if(command.action==='generate'){
   stopProgress.current?.();stopProgress.current=stop;generationFailure.current=null;setNotice('');setProgressUnreadable(false);
   setProgress({requestKey:command.requestKey,phase:'preparing',sent:false,errorCode:null,retryable:false,startedAt:Date.now(),finishedAt:null});
   const until=Date.now()+120000;
   const poll=async()=>{if(stopped||!current()||Date.now()>until)return;try{const status=await readStatus(command.requestKey);if(current()&&!stopped){setProgress(status);setProgressUnreadable(false);}if(['committed','failed','unknown'].includes(status.phase))return;}catch{if(current()&&!stopped)setProgressUnreadable(true);}if(current()&&!stopped)timer=setTimeout(()=>void poll(),1000);};
   timer=setTimeout(()=>void poll(),350);
  }
  try{
   if(command.action==='status'){await showStatus(await readStatus(command.requestKey));return;}
   const response=await execute(command);if(!current())return;
   if(command.action==='read'){showPage(response);}
   else if(command.action==='version')setInspected(v=>({...v,[command.candidateId]:readSqliteCandidateVersion(response)}));
   else{
    if(command.action==='generate'){
     const r=response as {session_id:string;request_key:string;segmented:boolean;replayed:boolean};
     if(r.request_key!==command.requestKey||typeof r.session_id!=='string'||typeof r.segmented!=='boolean'||typeof r.replayed!=='boolean')throw new Error('候选结果尚未确认，请保留原请求重试核对。');
     setProgress({requestKey:command.requestKey,phase:'committed',sent:true,errorCode:null,retryable:false,startedAt:null,finishedAt:Date.now()});setProgressUnreadable(false);retry.current=null;if(draft===command.text){setDraft('');if(contactId)onDraftChange?.('',{contactId,scopeRevision});}setCarry(undefined);setNotice(r.replayed?'已定位原请求，候选已重新核对。':'候选已保存，最终消息请自行发送。');
     onSubmitted?.({sessionId:r.session_id,requestKey:r.request_key,segmented:r.segmented,replayed:r.replayed});
     if(r.session_id!==sessionId)return;
    }else if(command.action==='select'||command.action==='continue'){
     const selection=response as {id:string};if(typeof selection.id!=='string')throw new Error(command.action==='continue'?'选稿结果尚未确认。':'选稿结果尚未确认，请重新读取。');
     if(command.action==='continue'){setCarry(selection.id);setNotice(`下一次明确请求将继续第${command.versionNo}版候选。`);return;}
     setNotice(`已选用第${command.versionNo}版；选用不表示已发送。`);
    }else setNotice('修改已保存为新版本，继承依据尚未重新核验。');
    await reloadPage();
   }
  }catch(e){
   stop();
   if(current()){const message=rejectOperation(e);if(command.action==='generate')generationFailure.current={requestKey:command.requestKey,message};}
   if(command.action==='generate'&&current())try{await showStatus(await readStatus(command.requestKey));}catch{if(current())setProgressUnreadable(true);}
  }
  finally{stop();if(current()){operation.current=null;setBusy(false);}}
 }
 function sendGeneration({text,workspace,carry}:GenerationInput){
  if(!writable)return;
  const requestKey=crypto.randomUUID();retry.current={requestKey,text,workspace,carry};
  return run({action:'generate',requestKey,text,workspace,acceptIncomplete:false,...(carry?{carriedSelectionId:carry}:{})});
 }
 function generate(action:'express'|'suggest'){
  if(action==='express'&&!draft.trim()||!page||unresolved||operation.current)return;
  return sendGeneration({text:draft,workspace:{action,draftText:draft,contextText:'',includeRelationshipContext:true},carry});
 }
 function retryOriginal(){
  const original=retry.current;if(!original||operation.current)return;
  return progress?.phase==='failed'&&progress.retryable?sendGeneration(original):run({action:'status',requestKey:original.requestKey});
 }
 // 请求排序由后端保证升序：最后一项为最新一次。页面只含最近 20 次，标题按倒数计数才不会在 hasMoreRequests 时错位。
 function requestTitle(index:number,total:number){return index===total-1?'最新一次':`倒数第 ${total-index} 次`;}
 function requestOpen(requestId:string,index:number,total:number){return openRequests[requestId]??index===total-1;}
 function requestStatus(request:CandidateRequest){
  if(request.generationState==='failed'&&!request.candidates.length)return '生成失败';
  if(request.generationState==='unknown')return '结果未确认';
  if(request.sourceState==='unavailable')return '来源已失效';
  if(request.generationState==='running')return '生成中';
  return `${request.candidates.length} 个说法`;
 }
 // 展示本次请求实际载入的 Skill；来源分为模型按需调用、用户指定和自动预载。
 function skillUsageLabel(request:CandidateRequest){
  const found=new Map<string,CandidateRequest['loadedSkills'][number]>();
  for(const skill of request.loadedSkills){const key=`${skill.packageId}:${skill.revisionNo}`,old=found.get(key);if(!old||skill.relativePath==='SKILL.md'&&old.relativePath!=='SKILL.md')found.set(key,skill);}
  if(!found.size)return '本次未载入 Skill';
  const origin=(skill:CandidateRequest['loadedSkills'][number])=>skill.origin==='explicit'?'用户指定':skill.origin==='auto_preload'?'自动预载':'模型调用';
  return `本次载入的 Skill：${[...found.values()].map(skill=>`${skill.title??skill.name??'未命名 Skill'}（${origin(skill)}）`).join('、')}`;
 }
 function requestSummary(request:CandidateRequest,index:number,total:number){
  const summary=[requestTitle(index,total),requestStatus(request)];
  if(request.selections.length)summary.push('已选用');
  if(request.candidates.some(candidate=>Object.hasOwn(edits,candidate.candidateId)))summary.push('有未保存修改');
  return summary.join(' · ');
 }
 // 浏览器在 open 被程序化修改时也会派发 toggle；只记录与当前渲染状态不一致的用户切换，避免新请求追加后旧的最新项被错误保留展开。
 function toggleRequest(requestId:string,index:number,total:number,open:boolean){
  if(open===requestOpen(requestId,index,total))return;
  setOpenRequests(old=>old[requestId]===open?old:{...old,[requestId]:open});
 }
 return <section aria-label="表达工作区" className="compose-panel unified-workspace sqlite-reply-candidates">
  <header className="compose-heading"><span className="section-eyebrow">一起想，把话说好</span><h2>有什么想说的？</h2><p>想说什么、希望什么语气，都可以写在这里；没有思路，也可以让我帮你想。</p></header>
  {!available&&<p role="status">{!contactId ? '请先选择本次联系人。'
   : !sessionId ? '联系人已选中，请先打开当前助手讨论。' : '联系人已选中，助手讨论暂不可用，请核对上方状态。'}</p>}
  {readOnly&&<p role="status">历史候选仅供回看；请先继续此讨论，再生成、修改或选用。</p>}
  <textarea aria-label="有什么想说的" rows={3} maxLength={65536} value={draft} placeholder="例如：想问问她最近怎么样，语气自然一点，简短一些。也可以留空，点击「帮我想想」…" disabled={!writable||busy} onChange={e=>{seeded.current=scopeKey;setDraft(e.target.value);if(contactId)onDraftChange?.(e.target.value,{contactId,scopeRevision});}} />
  <div className="workspace-actions">
    <button className="generate-button" aria-label="帮我表达" disabled={!writable||busy||unresolved||!page||!draft.trim()} onClick={()=>void generate('express')}><Icon name="write" size={18}/>帮我表达</button>
    <button className="compose-primary workspace-suggest" aria-label="帮我想想" disabled={!writable||busy||unresolved||!page} onClick={()=>void generate('suggest')}><Icon name="sparkle" size={18}/>帮我想想</button>
  </div>
  <p className="workspace-action-hint">有想法，帮你组织表达；没思路，给你几种说法和建议理由。</p>
  {(busy||retry.current&&progressUnreadable)&&<p className="rewrite-privacy" aria-live="polite">{progressUnreadable?'暂时无法核对本次进度，请保留原请求，勿重复生成。':progress?progressLabel(progress.phase):'正在读取候选…'}</p>}
  {retry.current&&!busy&&writable&&<button className="button" onClick={()=>void retryOriginal()}>{progress?.phase==='failed'&&progress.retryable?progress.errorCode==='reply_sources_not_ready'?'重试生成':'重新生成':'核对原请求'}</button>}
  <button className="button" disabled={!available||busy} onClick={()=>void run({action:'read'})}>刷新候选</button>
  {carry&&<button className="button" disabled={busy} onClick={()=>{setCarry(undefined);setNotice('已取消本次候选继续。');}}>取消候选继续</button>}
  {error&&<p role="alert">{error}</p>}{error===sqliteReplySourceUnavailableMessage&&<button className="button" disabled={busy} onClick={()=>void window.notalone.openManager().catch(()=>{if(mounted.current&&latest.current.scopeKey===scopeKey)setNotice('同步设置暂未打开，请重试。');})}>处理同步问题</button>}{notice&&<p role="status">{notice}</p>}
  {page?.hasMoreRequests&&<p role="status">仅显示最近20次候选请求；更早记录未加载。</p>}
  {page?.requests.map((request,requestIndex)=><details key={request.requestId} className="sqlite-candidate-request" open={requestOpen(request.requestId,requestIndex,page.requests.length)} onToggle={event=>toggleRequest(request.requestId,requestIndex,page.requests.length,event.currentTarget.open)}>
   <summary>{requestSummary(request,requestIndex,page.requests.length)}</summary>
   {request.skillWarning&&<p role="status">{request.skillWarning}</p>}
   {request.sourceState==='available'&&request.candidates.length>0&&<p className="candidate-skill-usage">{skillUsageLabel(request)}</p>}
   {request.sourceState==='available'&&request.candidates.length>0&&requestOpen(request.requestId,requestIndex,page.requests.length)&&bridge.candidates&&contactId&&sessionId&&<SqliteCandidateReferences key={`${request.requestId}:${referenceRevision}`} bridge={bridge.candidates} scope={{contactId,scopeRevision,sessionId}} request={request} disabled={!available||busy} onUnavailable={()=>{clear();rejectOperation(new Error('本次候选来源已失效，请重新读取。'));}}/>}
   {request.generationState==='unknown'&&<p role="status">本次模型调用结果暂未确认，请等待本机恢复处理。</p>}
   {request.generationState==='failed'&&!busy&&<p role="status">{interruptionMessage(request.generationErrorCode,request.generationSent,request.generationAbandoned)??'本次候选生成失败，没有可选正文。'}</p>}
   {request.sourceState==='unavailable'&&(!request.generationState||request.generationState==='committed'||request.generationState==='invalidated')&&<p role="status">这次候选的来源已失效，正文与依据已撤下。</p>}
   {request.candidates.map((candidate,candidateIndex)=>{const v=inspected[candidate.candidateId]??candidate,parts=edits[v.candidateId]??v.parts;return <article key={v.candidateId} aria-label={`说法${candidateIndex+1}`}>
    <h4>说法 {candidateIndex+1}{v.origin==='manual'&&<span> · 已修改</span>}{v.versionNo!==candidate.versionNo&&<span> · 正在回看第 {v.versionNo} 版（非最新）</span>}</h4>
    {parts.length>1&&<p className="candidate-sequence-hint">共{parts.length}条，按顺序分别发送，不是备选</p>}
    {parts.map((part,index)=><label key={index}>第{index+1}条{parts.length>1&&(index===0?'（先发）':'（接着发）')}<textarea aria-label={`候选第${index+1}条`} value={part} readOnly={readOnly} disabled={busy||!available} onChange={e=>setEdits(old=>({...old,[v.candidateId]:parts.map((p,n)=>n===index?e.target.value:p)}))} /></label>)}
    <button className="button" disabled={busy||!writable||!edits[v.candidateId]} onClick={()=>void run({action:'edit',candidateId:v.candidateId,versionNo:v.versionNo,parts})}>保存修改</button>
    <button className="button" title="记录选用当前已保存的版本；消息仍由你亲自发送" disabled={busy||!writable} onClick={()=>void run({action:'select',candidateId:v.candidateId,versionNo:v.versionNo})}>选用这个说法</button>
    <button className="button" title="记录选用，并将当前已保存版本带入下一次明确生成；点击后不会立即生成" disabled={busy||!writable} onClick={()=>void run({action:'continue',candidateId:v.candidateId,versionNo:v.versionNo})}>以这个说法继续</button>
    {v.versionNo>1&&<button className="button" disabled={busy} onClick={()=>void run({action:'version',candidateId:v.candidateId,versionNo:v.versionNo-1})}>查看上一版</button>}
    {v.versionNo!==candidate.versionNo&&<button className="button" disabled={busy} onClick={()=>{setInspected(old=>{const next={...old};delete next[v.candidateId];return next;});setEdits({});}}>回到最新版本</button>}
    <CandidateBasis version={v}/>
   </article>;})}
   {!!request.selections.length&&<p>已记录{request.selections.length}次选稿，最近选用第{request.selections.at(-1)!.versionNo}版。</p>}
  </details>)}
 </section>;
}
