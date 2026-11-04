import {useEffect,useRef,useState} from 'react';
import {Icon} from './icons';
import type {RewriteTone} from '../shared/reply-bridge';
import type {SqliteDiscussionBridge,SqliteDiscussionReceipt} from '../shared/sqlite-discussion-bridge';
import {readSqliteCandidatePage,readSqliteCandidateSkillPage,readSqliteCandidateVersion,readSqliteCandidateStatus,type SqliteCandidateStatus,type SqliteCandidatePage,type SqliteCandidateVersion,type SqliteCandidateOperation,type SqliteCandidateLoadedSkill} from '../shared/sqlite-reply-candidates';
type WorkspaceInput={action:'express'|'suggest';draftText:string;tone:RewriteTone;instruction:string;contextText:string;includeRelationshipContext:boolean};
const defaultOptions=()=>({tone:'original' as RewriteTone,instruction:'',contextText:'',includeRelationshipContext:true});
const progressLabel=(phase:SqliteCandidateStatus['phase'])=>({not_found:'正在接纳本次请求…',preparing:'正在整理本次资料…',queued:'正在等待生成…',generating:'正在等待模型回复…',saving:'正在保存候选…',committed:'正在读取已保存候选…',failed:'正在核对本次结果…',unknown:'正在核对本次结果…'}[phase]);
function statusFailure(status:SqliteCandidateStatus):string{
 if(status.phase==='unknown')return '模型请求已发出，结果暂未确认。请核对原请求。';
 if(status.phase==='not_found')return '尚未找到原请求，请稍后核对。';
 if(status.phase!=='failed')return '原请求仍在处理，请稍后核对。';
 if(status.errorCode==='reply_sources_not_ready'&&!status.sent)return '聊天读取暂未恢复，请重试生成。';
 if(status.errorCode?.includes('timeout'))return status.sent?'本次生成超时，没有保存候选。':'整理资料超时，尚未发给模型。';
 if(status.errorCode&&/source|stale|knowledge|invalidated/.test(status.errorCode))return '本次参考资料发生变化，请重新生成。';
 return status.sent?'本次生成失败，没有保存候选。':'本次准备失败，尚未发给模型。';
}
function LoadedSkillInputs({bridge,contactId,scopeRevision,sessionId,requestId,skills}:{bridge:SqliteDiscussionBridge;contactId:string;scopeRevision:number;sessionId:string;requestId:string;skills:SqliteCandidateLoadedSkill[]}){
 const inline=skills.every(skill=>typeof skill.text==='string');
 const alive=useRef(true),[items,setItems]=useState<(SqliteCandidateLoadedSkill&{text:string})[]>(inline?skills as (SqliteCandidateLoadedSkill&{text:string})[]:[]);
 const [nextOffset,setNextOffset]=useState<number|null>(inline?null:0),[total,setTotal]=useState(skills.length),[loading,setLoading]=useState(false),[error,setError]=useState('');
 useEffect(()=>()=>{alive.current=false;},[]);
 const load=async(offset:number)=>{if(loading||!bridge.candidates)return;setLoading(true);setError('');try{const page=readSqliteCandidateSkillPage(await bridge.candidates.execute({contactId,scopeRevision,sessionId,action:'skills',requestId,offset}),offset);if(!alive.current)return;setItems(old=>[...old,...page.items]);setNextOffset(page.nextOffset);setTotal(page.total);}catch(error){if(alive.current){const message=error instanceof Error?error.message:'',deterministic=message==='本次Skill输入超出可显示范围。';setError(deterministic||message==='本次候选操作无效。'?message:'Skill 正文暂不可读取，请重试。');if(deterministic)setNextOffset(null);}}finally{if(alive.current)setLoading(false);}};
 return <details onToggle={event=>{if(event.currentTarget.open&&!inline&&!items.length&&nextOffset!==null)void load(nextOffset);}}><summary>实际进入模型输入的 Skill 内容</summary>
  {error&&<p role="alert">{error}</p>}{loading&&!items.length&&<p role="status">正在读取 Skill 正文…</p>}
  {!!items.length&&<div role="group" aria-label="实际进入模型输入的 Skill 内容">{items.map((skill,index)=><div key={`${skill.packageId}:${skill.revisionNo}:${skill.relativePath}:${index}`}><p>{skill.name?`${skill.name} · `:''}第{skill.revisionNo}版 · {skill.relativePath}</p><p>{skill.text}</p></div>)}</div>}
  {!loading&&!items.length&&!error&&nextOffset===null&&<p>未找到实际进入本次请求的 Skill 正文。</p>}
  {nextOffset!==null&&<button className="button" disabled={loading} onClick={()=>void load(nextOffset)}>{loading?'正在读取…':`加载更多 Skill 正文（${items.length}/${total}）`}</button>}
 </details>;
}
interface Props {bridge:SqliteDiscussionBridge;contactId:string|null;scopeRevision:number;sessionId:string|null;disabled?:boolean;initialDraft?:string;onInitialDraftTaken?:()=>void;onDraftChange?:(text:string,scope:{contactId:string;scopeRevision:number})=>void;onSubmitted?:(receipt:SqliteDiscussionReceipt)=>void}
/** 草稿、候选、依据和实际Skill快照共用同一失效边界；迟到回包不能重新挂回旧正文。 */
export function SqliteReplyCandidatesPanel({bridge,contactId,scopeRevision,sessionId,disabled=false,initialDraft='',onInitialDraftTaken,onDraftChange,onSubmitted}:Props){
 const scopeKey=JSON.stringify([contactId,scopeRevision,sessionId]),latest=useRef({scopeKey,bridge});latest.current={scopeKey,bridge};
 const revision=useRef(0),mounted=useRef(false),operation=useRef<object|null>(null);
 const retry=useRef<{fingerprint:string;requestKey:string;text:string;workspace:WorkspaceInput;carry?:string}|null>(null);
 const seeded=useRef<string|null>(null),consumedHandoff=useRef<string|null>(null),stopProgress=useRef<(()=>void)|null>(null);
 const [progress,setProgress]=useState<SqliteCandidateStatus|null>(null);
 const qualifiedRequests=useRef<string[]>([]);
 const [page,setPage]=useState<SqliteCandidatePage|null>(null),[draft,setDraft]=useState(''),[carry,setCarry]=useState<string|undefined>();
 const [options,setOptions]=useState(defaultOptions);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [edits,setEdits]=useState<Record<string,string[]>>({}),[inspected,setInspected]=useState<Record<string,SqliteCandidateVersion>>({});
 const available=!!bridge.candidates&&!!contactId&&!!sessionId&&!disabled;
 const unresolved=!!retry.current&&!(progress?.phase==='failed'&&progress.retryable);
 function clear(){stopProgress.current?.();setProgress(null);++revision.current;operation.current=null;retry.current=null;qualifiedRequests.current=[];setPage(null);setDraft('');setOptions(defaultOptions());setCarry(undefined);setBusy(false);setError('');setNotice('');setEdits({});setInspected({});}
 useEffect(()=>{mounted.current=true;const off=bridge.onInvalidated(()=>{seeded.current=scopeKey;clear();if(contactId)onDraftChange?.('',{contactId,scopeRevision});});return()=>{mounted.current=false;stopProgress.current?.();++revision.current;operation.current=null;off();};},[bridge,scopeKey]);
 useEffect(()=>{clear();if(available)void run({action:'read'});},[scopeKey,bridge]);
 // 临时禁用只暂停新操作；来源及范围失效仍由订阅和scopeKey立即清除。
 useEffect(()=>{if(available&&!page)void run({action:'read'});},[disabled]);
 // 讨论切换可能先于联系人草稿回显；空值不提前消费这次交接。
 // 联系人草稿的异步清空可能晚于讨论切换；按联系人/范围/内容消费一次，不能用含 sessionId 的 scopeKey 去重。
 const handoffKey=JSON.stringify([contactId,scopeRevision,initialDraft]);
 useEffect(()=>{
  if(!initialDraft){consumedHandoff.current=null;return;}
  if(available&&seeded.current!==scopeKey&&consumedHandoff.current!==handoffKey){
   consumedHandoff.current=handoffKey;seeded.current=scopeKey;setDraft(initialDraft);onInitialDraftTaken?.();
  }
 },[scopeKey,available,initialDraft,handoffKey,onInitialDraftTaken]);
 type Command=SqliteCandidateOperation extends infer O?O extends SqliteCandidateOperation?Omit<O,'contactId'|'scopeRevision'|'sessionId'>:never:never;
 function showPage(next:SqliteCandidatePage,preserveEdits=false){
  // 仅保留无正文的来源标识，短暂读取失败后仍能核对旧草稿的资格。
  const readable=qualifiedRequests.current;
  if(readable.some(id=>!next.requests.some(r=>r.requestId===id&&r.sourceState==='available'))){
   seeded.current=scopeKey;setDraft('');if(contactId)onDraftChange?.('',{contactId,scopeRevision});setCarry(undefined);retry.current=null;setNotice('');
  }
  qualifiedRequests.current=next.requests.filter(r=>r.sourceState==='available'&&r.candidates.length).map(r=>r.requestId);
  setPage(next);
  if(!preserveEdits){setEdits({});setInspected({});}
  else{
   const previous=new Map(page?.requests.flatMap(r=>r.candidates.map(c=>[c.candidateId,c.versionNo] as const))??[]);
   const unchanged=new Set(next.requests.filter(r=>r.sourceState==='available').flatMap(r=>r.candidates.filter(c=>previous.get(c.candidateId)===c.versionNo).map(c=>c.candidateId)));
   setEdits(old=>Object.fromEntries(Object.entries(old).filter(([id])=>unchanged.has(id))));
   setInspected(old=>Object.fromEntries(Object.entries(old).filter(([id])=>unchanged.has(id))));
  }
 }
 function rejectOperation(error:unknown){
  const text=(error instanceof Error?error.message:'候选结果尚未确认，请重新读取。').replace(/^Error invoking remote method '[^']+': Error: /,'');
  setEdits({});setInspected({});setNotice('');
  if(/失效|已变化|已不可用|请先确认/.test(text)){
   seeded.current=scopeKey;qualifiedRequests.current=[];setPage(null);setDraft('');if(contactId)onDraftChange?.('',{contactId,scopeRevision});setCarry(undefined);retry.current=null;
  }else setPage(old=>old?{coverage:old.coverage,requests:[]}:null);
  setError(text);
 }
 async function run(command:Command,refreshContext=false){
  if(!available||!bridge.candidates||!contactId||!sessionId||operation.current)return;
  const token={},boundary=revision.current;operation.current=token;setBusy(true);setError('');
  const current=()=>mounted.current&&operation.current===token&&revision.current===boundary&&latest.current.scopeKey===scopeKey&&latest.current.bridge===bridge;
  const scope={contactId,scopeRevision,sessionId};
  const readStatus=async(requestKey:string)=>{const status=readSqliteCandidateStatus(await bridge.candidates!.execute({...scope,action:'status',requestKey}));if(status.requestKey!==requestKey)throw new Error('候选状态不匹配。');return status;};
  const showStatus=async(status:SqliteCandidateStatus)=>{
   if(!current())return;setProgress(status);
   if(status.phase!=='committed'){
    if(status.phase==='failed'&&!status.sent&&status.errorCode==='reply_sources_not_ready'){
     // 只保留用户独立输入；旧选稿及其派生草稿不能随恢复请求重新带入。
     const carried=!!retry.current?.carry||!!carry;
     qualifiedRequests.current=[];setCarry(undefined);setEdits({});setInspected({});
     setPage(old=>old?{coverage:old.coverage,requests:[]}:null);
     if(carried){seeded.current=scopeKey;setDraft('');onDraftChange?.('',{contactId,scopeRevision});retry.current=null;}
    }
    setError(statusFailure(status));return;
   }
   const next=await bridge.candidates!.execute({...scope,action:'read'});if(!current())return;
   const original=retry.current;showPage(readSqliteCandidatePage(next));retry.current=null;setError('');setCarry(undefined);
   if(original&&draft===original.text){setDraft('');onDraftChange?.('',{contactId,scopeRevision});}
   setNotice('已找到原请求保存的候选。');
  };
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{stopped=true;clearTimeout(timer);if(stopProgress.current===stop)stopProgress.current=null;};
  if(command.action==='generate'){
   stopProgress.current?.();stopProgress.current=stop;setNotice('');
   setProgress({requestKey:command.requestKey,phase:'preparing',sent:false,errorCode:null,retryable:false,startedAt:Date.now(),finishedAt:null});
   const until=Date.now()+120000;
   const poll=async()=>{if(stopped||!current()||Date.now()>until)return;try{const status=await readStatus(command.requestKey);if(current()&&!stopped)setProgress(status);if(['committed','failed','unknown'].includes(status.phase))return;}catch{/* 短暂核对失败不改变生成结果，也不触发生成。 */}if(current()&&!stopped)timer=setTimeout(()=>void poll(),1000);};
   timer=setTimeout(()=>void poll(),350);
  }
  try{
   const response=await bridge.candidates.execute({...scope,...command} as SqliteCandidateOperation);if(!current())return;
   if(command.action==='status'){
    const status=readSqliteCandidateStatus(response);if(status.requestKey!==command.requestKey)throw new Error('候选状态不匹配。');await showStatus(status);
   }else if(command.action==='read'){showPage(readSqliteCandidatePage(response),refreshContext);}
   else if(command.action==='version')setInspected(v=>({...v,[command.candidateId]:readSqliteCandidateVersion(response)}));
   else{
    if(command.action==='generate'){
     const r=response as {session_id:string;request_key:string;segmented:boolean;replayed:boolean};
     if(r.request_key!==command.requestKey||typeof r.session_id!=='string'||typeof r.segmented!=='boolean'||typeof r.replayed!=='boolean')throw new Error('候选结果尚未确认，请保留原请求重试核对。');
     setProgress({requestKey:command.requestKey,phase:'committed',sent:true,errorCode:null,retryable:false,startedAt:null,finishedAt:Date.now()});retry.current=null;if(draft===command.text){setDraft('');if(contactId)onDraftChange?.('',{contactId,scopeRevision});}setCarry(undefined);setNotice(r.replayed?'已定位原请求，候选已重新核对。':'候选已保存，最终消息请自行发送。');
     onSubmitted?.({sessionId:r.session_id,requestKey:r.request_key,segmented:r.segmented,replayed:r.replayed});
     if(r.session_id!==sessionId)return;
    }else if(command.action==='select'){
     const selection=response as {id:string};if(typeof selection.id!=='string')throw new Error('选稿结果尚未确认，请重新读取。');
     setNotice(`已选用第${command.versionNo}版；选用不表示已发送。`);
    }else setNotice('修改已保存为新版本，继承依据尚未重新核验。');
    const next=await bridge.candidates.execute({...scope,action:'read'});if(!current())return;showPage(readSqliteCandidatePage(next));
   }
  }catch(e){
   stop();
   if(current())rejectOperation(e);
   if(command.action==='generate'&&current())try{await showStatus(await readStatus(command.requestKey));}catch{/* 保留原请求，只允许核对，不能猜测未发送。 */}
  }
  finally{stop();if(current()){operation.current=null;setBusy(false);}}
 }
 function changeOptions(update:Partial<ReturnType<typeof defaultOptions>>){
  setOptions(value=>({...value,...update}));
  if(carry&&update.includeRelationshipContext===false){
   setCarry(undefined);setNotice('关闭关系背景后已取消旧候选继续。');
  }
 }
 async function generate(action:'express'|'suggest'){
  if(action==='express'&&!draft.trim()||!page||unresolved||operation.current)return;
  const workspace:WorkspaceInput={action,draftText:draft,...options};
  const fingerprint=JSON.stringify({workspace,carry}),requestKey=crypto.randomUUID();
  retry.current={fingerprint,requestKey,text:draft,workspace,carry};
  await run({action:'generate',requestKey,text:draft,workspace,acceptIncomplete:false,...(carry?{carriedSelectionId:carry}:{})});
 }
 async function retryOriginal(){
  const original=retry.current;if(!original||operation.current)return;
  if(progress?.phase!=='failed'||!progress.retryable){await run({action:'status',requestKey:original.requestKey});return;}
  const requestKey=crypto.randomUUID();retry.current={...original,requestKey};
  await run({action:'generate',requestKey,text:original.text,workspace:original.workspace,acceptIncomplete:false,...(original.carry?{carriedSelectionId:original.carry}:{})});
 }
 async function continueVersion(v:SqliteCandidateVersion){
  if(!options.includeRelationshipContext)return;
  if(!available||!bridge.candidates||!contactId||!sessionId||operation.current)return;
  const token={},boundary=revision.current;operation.current=token;setBusy(true);setError('');
  const current=()=>mounted.current&&operation.current===token&&revision.current===boundary&&latest.current.scopeKey===scopeKey&&latest.current.bridge===bridge;
  try{const result=await bridge.candidates.execute({contactId,scopeRevision,sessionId,action:'select',candidateId:v.candidateId,versionNo:v.versionNo}) as {id:string};if(current()){if(typeof result.id!=='string')throw new Error('选稿结果尚未确认。');setCarry(result.id);setNotice(`下一次明确请求将继续第${v.versionNo}版候选。`);}}
  catch(e){if(current())rejectOperation(e);}
  finally{if(current()){operation.current=null;setBusy(false);}}
 }
 return <section aria-label="表达工作区" className="compose-panel unified-workspace sqlite-reply-candidates">
  <header className="compose-heading"><span className="section-eyebrow">一起想，把话说好</span><h2>有什么想说的？</h2><p>写下想法、方向或草稿；没有思路，也可以让我帮你想。</p></header>
  {!available&&<p role="status">请先选择本次联系人并打开当前助手会话。</p>}
  <textarea aria-label="有什么想说的" rows={3} maxLength={65536} value={draft} placeholder="写下你的想法或草稿，也可以留空，点击「帮我想想」…" disabled={!available||busy} onChange={e=>{seeded.current=scopeKey;setDraft(e.target.value);if(contactId)onDraftChange?.(e.target.value,{contactId,scopeRevision});}} />
  <div className="workspace-actions">
    <button className="generate-button" aria-label="帮我表达" disabled={!available||busy||unresolved||!page||!draft.trim()} onClick={()=>void generate('express')}><Icon name="write" size={18}/>帮我表达</button>
    <button className="compose-primary workspace-suggest" aria-label="帮我想想" disabled={!available||busy||unresolved||!page} onClick={()=>void generate('suggest')}><Icon name="sparkle" size={18}/>帮我想想</button>
  </div>
  <p className="workspace-action-hint">有想法，帮你组织表达；没思路，给你几种说法和建议理由。</p>
  <details className="workspace-context"><summary>最近聊天 · 查看／补充</summary><div className="workspace-context-body">
    <label className="rewrite-context"><input type="checkbox" checked={options.includeRelationshipContext} disabled={!available||busy} onChange={e=>changeOptions({includeRelationshipContext:e.target.checked})}/>参考最近聊天和相关关系资料</label>
    <p className="rewrite-privacy">使用这位联系人当前可用的资料，具体依据会随候选展示。</p>
    <button className="button" disabled={!available||busy} onClick={()=>void run({action:'read'},true)}>刷新最近聊天</button>
    {!page?.recentMessages?.length&&<p>暂无可用的最近聊天。可以补充上下文，或先写下想法。</p>}
    {!!page?.recentMessages?.length&&<><p className="rewrite-privacy">以下最多50条，按消息时间从新到旧展示；聊天先后仍未核验。关系背景开启时，这些消息会作为本次生成候选的参考。</p>
      <div className="workspace-message-list" role="group" aria-label="最近聊天材料">{page.recentMessages.map(message=><div className="reply-message workspace-message-row" key={message.messageId}><div className="reply-message-selection"><span><small>{message.sender==='owner'?'我':message.sender==='contact'?'对方':'角色未核验'} · {message.occurredAt?new Date(message.occurredAt).toLocaleString('zh-CN'):'时间未知'}</small><span className="reply-message-text">{message.text}</span></span></div></div>)}</div></>}
    <label>补充聊天上下文<textarea aria-label="补充聊天上下文" rows={3} maxLength={65536} value={options.contextText} disabled={!available||busy} placeholder="只粘贴这位联系人的聊天内容，建议标明是谁说的话。" onChange={e=>setOptions(v=>({...v,contextText:e.target.value}))}/></label>
    <p className="rewrite-privacy">补充内容只作为本次聊天背景，不会被当成你的表达意图。</p>
  </div></details>
  <details className="compose-settings"><summary>语气和本次要求</summary><div className="rewrite-options">
    <label>本次语气<select aria-label="本次语气" value={options.tone} disabled={!available||busy} onChange={e=>setOptions(v=>({...v,tone:e.target.value as RewriteTone}))}><option value="original">自然表达</option><option value="warm">自然温和</option><option value="concise">简洁直接</option><option value="polite">礼貌克制</option></select></label>
    <label>本次要求<textarea aria-label="本次要求" rows={2} maxLength={4096} value={options.instruction} disabled={!available||busy} placeholder="例如：不要催促、简短一些…" onChange={e=>setOptions(v=>({...v,instruction:e.target.value}))}/></label>
  </div></details>
  {busy&&<p className="rewrite-privacy" aria-live="polite">{progress?progressLabel(progress.phase):'正在读取候选…'}</p>}
  {retry.current&&!busy&&<button className="button" onClick={()=>void retryOriginal()}>{progress?.phase==='failed'&&progress.retryable?progress.errorCode==='reply_sources_not_ready'?'重试生成':'重新生成':'核对原请求'}</button>}
  <button className="button" disabled={!available||busy} onClick={()=>void run({action:'read'})}>刷新候选</button>
  {carry&&<button className="button" disabled={busy} onClick={()=>{setCarry(undefined);setNotice('已取消本次候选继续。');}}>取消候选继续</button>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {page?.hasMoreRequests&&<p role="status">仅显示最近20次候选请求；更早记录未加载。</p>}
  {page?.requests.map(request=><div key={request.requestId} className="sqlite-candidate-request">
   {request.skillWarning&&<p role="status">{request.skillWarning}</p>}
   {!!request.preloadedSkills?.length&&<p>本次预加载的 Skill：{request.preloadedSkills.map(skill=>`${skill.name??skill.packageId}（第${skill.revisionNo}版）`).join('、')}</p>}
   {request.coverageWarning&&<p role="status">{request.coverageWarning}</p>}
   {request.generationState==='unknown'&&<p role="status">本次模型调用结果未知，请核对原请求，不能换身份重发。</p>}
   {request.generationState==='failed'&&!progress&&!busy&&<p role="status">本次候选生成失败，没有可选正文。</p>}
   {request.sourceState==='unavailable'&&(!request.generationState||request.generationState==='committed'||request.generationState==='invalidated')&&<p role="status">这次候选的来源已失效，正文与依据已撤下。</p>}
   {request.candidates.map(candidate=>{const v=inspected[candidate.candidateId]??candidate,parts=edits[v.candidateId]??v.parts;return <article key={v.candidateId} aria-label={`候选第${request.candidates.indexOf(candidate)+1}组`}>
    <h4>候选第{request.candidates.indexOf(candidate)+1}组 · 第{v.versionNo}版{v.origin==='manual'?'（手工编辑）':''}</h4>
    {parts.map((part,index)=><label key={index}>第{index+1}条<textarea aria-label={`候选第${index+1}条`} value={part} disabled={busy||!available} onChange={e=>setEdits(old=>({...old,[v.candidateId]:parts.map((p,n)=>n===index?e.target.value:p)}))} /></label>)}
    <button className="button" disabled={busy||!available||!edits[v.candidateId]} onClick={()=>void run({action:'edit',candidateId:v.candidateId,versionNo:v.versionNo,parts})}>保存修改</button>
    <button className="button" disabled={busy||!available} onClick={()=>void run({action:'select',candidateId:v.candidateId,versionNo:v.versionNo})}>选用此版本</button>
    <button className="button" disabled={busy||!available||!options.includeRelationshipContext} onClick={()=>void continueVersion(v)}>以此版本继续</button>
    {v.versionNo>1&&<button className="button" disabled={busy} onClick={()=>void run({action:'version',candidateId:v.candidateId,versionNo:v.versionNo-1})}>查看上一版</button>}
    {v.versionNo!==candidate.versionNo&&<button className="button" disabled={busy} onClick={()=>{setInspected(old=>{const next={...old};delete next[v.candidateId];return next;});setEdits({});}}>回到最新版本</button>}
    <details><summary>依据</summary>{v.basis.map(b=><div key={b.itemNo}><p>{b.verification==='inherited_unverified'?'继承原依据，手工修改尚未重新核验':'产生此模型版本的实际输入'} · {({message:'聊天原文',entry:'本次讨论',memory:'已采纳记忆',memory_candidate:'未确认记忆',document:'已发布资料',selection:'明确选稿',coverage:'历史覆盖'} as Record<string,string>)[b.kind]??'实际资料'}</p><p className="discussion-entry-text">{b.text}</p></div>)}</details>
   </article>;})}
   {!!request.loadedSkills.length&&contactId&&sessionId&&<LoadedSkillInputs bridge={bridge} contactId={contactId} scopeRevision={scopeRevision} sessionId={sessionId} requestId={request.requestId} skills={request.loadedSkills}/>}
   {!!request.selections.length&&<p>已记录{request.selections.length}次选稿，最近选用第{request.selections.at(-1)!.versionNo}版。</p>}
  </div>)}
 </section>;
}
