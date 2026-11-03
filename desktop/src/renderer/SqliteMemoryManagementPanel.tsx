import {useEffect,useRef,useState} from 'react';
import type {MemoryCandidateView,MemoryDecisionRequest,MemoryManagementOutcome,MemoryManagementSnapshot,MemorySource,MemoryVerificationState,MemoryVersionView,MemoryView,SqliteMemoryManagementBridge} from '../shared/sqlite-memory-management';
import {withdrawnProtectionVersion} from '../shared/sqlite-memory-management';
import {SqliteMemoryDocumentsPanel} from './SqliteMemoryDocumentsPanel';
import {useVisibleRefresh} from './use-visible-refresh';

type Decision=Omit<MemoryDecisionRequest,'requestKey'>;
const outcomeMessages={conflict:'资料已被其他操作修改，存在并发冲突。请重试读取后重新决定。',source_stale:'来源或范围已失效，已撤下原资料。请重试读取。',protected:'当前记忆受人工保护，请重试读取并核对；撤销前须先明确解除保护。',unavailable:'本次决定暂未确认，请重试读取当前状态后再操作。'};
const successMessages:Record<string,string>={accept:'采纳成功，已形成正式版本。',edit_accept:'修改采纳成功，固定模型原稿保留。',reject:'已拒绝候选。',correct:'错误修正成功，旧版不再作为当前事实。',change:'变化已记录，旧版不再作为当前事实。',protect:'已开启当前人工保护。',unprotect:'已解除当前人工保护。',restore:'自动更新已撤销，已新增恢复版本。',withdraw:'已撤销首次自动采纳，内容不再作为当前事实。'};
const formationNames:Record<string,string>={adoption:'采纳',correction:'纠正错误',change:'记录变化',restore:'撤销恢复',manual:'手动补充'};
const adoptionNames:Record<string,string>={auto:'自动采纳',user:'用户采纳',manual:'手动补充'};
function Verification({state}:{state:MemoryVerificationState}){
 return <p className="hint">{state==='verified'?<strong>来源已核验</strong>:<><strong>来源待核验</strong>；可查看原话，但尚未确认来源支持这条资料。</>}</p>;
}
function Sources({sources}:{sources:MemorySource[]}){
 return <details className="sqlite-memory-sources"><summary>查看来源</summary>{sources.length===0?<p>无可展示的来源。</p>:<ol>{sources.map((source,index)=><li key={`${source.recordId}:${index}`}>
  {source.contentKind==='image'?<><p>图片依据</p>{source.description&&<p>模型观察：{source.description}</p>}</>:<blockquote>{source.quote}</blockquote>}<details><summary>来源定位</summary><p>消息：{source.messageId}</p><p>来源记录：{source.recordId}</p><p>解释修订：{source.acceptedRevision}</p>{source.contentRef&&<p>图片版本：{source.contentRef.file_id}</p>}</details>
 </li>)}</ol>}</details>;
}
function Editor({label,initial,submitLabel,busy,save,cancel}:{label:string;initial:string;submitLabel:string;busy:boolean;save:(body:string)=>void;cancel:()=>void}){
 const [body,setBody]=useState(initial),length=[...body].length;
 return <form onSubmit={event=>{event.preventDefault();if(body.trim()&&length<=12000&&!busy)save(body);}}>
  <label>{label}<textarea value={body} onChange={event=>setBody(event.target.value)} maxLength={48000} rows={4} disabled={busy}/></label>
  <p className="hint">本次编辑尚未提交；固定原稿保持不变。{length}/12000 字</p>
  <div className="sqlite-memory-actions"><button type="submit" disabled={busy||!body.trim()||length>12000}>{submitLabel}</button><button type="button" disabled={busy} onClick={cancel}>取消编辑</button></div>
 </form>;
}
function Candidate({candidate,busy,decide}:{candidate:MemoryCandidateView;busy:boolean;decide:(request:Decision)=>void}){
 const [editing,setEditing]=useState(false),request={candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]};
 return <article className="sqlite-memory-card" aria-label="记忆候选">
  <p><strong>固定模型原稿</strong> · {{pending:'待决定（未确认）',adopted:'已采纳',rejected:'已拒绝',duplicate:'已跳过重复资料'}[candidate.state]??'状态待核对'}</p>
  <Verification state={candidate.verificationState}/>
  <p className="sqlite-memory-body">{candidate.body}</p><Sources sources={candidate.sources}/>
  {candidate.state==='pending'&&(editing?<Editor label="修改候选正文" initial={candidate.body} submitLabel="保存修改并采纳" busy={busy} cancel={()=>setEditing(false)} save={body=>decide({...request,action:'edit_accept',body})}/>:<div className="sqlite-memory-actions">
   <button type="button" disabled={busy} onClick={()=>decide({...request,action:'accept'})}>采纳原稿</button>
   <button type="button" disabled={busy} onClick={()=>setEditing(true)}>修改并采纳</button>
   <button type="button" disabled={busy} onClick={()=>decide({...request,action:'reject'})}>拒绝候选</button>
  </div>)}
 </article>;
}
function Version({version,current}:{version:MemoryVersionView;current:boolean}){
 return <div className={current?'':'sqlite-memory-old'}><p>版本 {version.versionNo} · {formationNames[version.formationKind]??version.formationKind} · {adoptionNames[version.adoptionMode]??version.adoptionMode}{current?' · 当前版本':' · 不作为当前事实'}</p>
  {version.body===null?<p>正文已清除或来源已失效。</p>:<><Verification state={version.verificationState}/>
   {version.timeStatus==='needs_revalidation'&&<p>时间待核验，暂不用于生成。</p>}
   {version.timeStatus==='invalid'&&<p>时间资料异常，暂不用于生成。</p>}
   {version.timeStatus==='out_of_window'&&<p>不在有效时间内，不再引用。</p>}
   <p className="sqlite-memory-body">{current&&version.timeStatus!=='out_of_window'?version.body:<s>{version.body}</s>}</p><Sources sources={version.sources}/></>}
  {version.restoredFromVersionNo&&<p>恢复自版本 {version.restoredFromVersionNo}，原前驱为版本 {version.previousVersionNo}。</p>}
 </div>;
}
function Memory({memory,busy,decide}:{memory:MemoryView;busy:boolean;decide:(request:Decision)=>void}){
 const [editing,setEditing]=useState<'correct'|'change'|null>(null),current=memory.current,withdrawnVersion=withdrawnProtectionVersion(memory);
 const request={memoryId:memory.id,expectedVersionNo:(current??withdrawnVersion)?.versionNo,expectedHeadRevision:memory.headRevision};
 const undoEligible=current?.adoptionMode==='auto'&&current.formationKind!=='restore';
 return <article className="sqlite-memory-card" aria-label="正式记忆">
  <p><strong>正式记忆</strong> · {memory.manualProtection?'当前人工保护已开启':'当前人工保护未开启'}{memory.state==='withdrawn'?' · 已撤销':memory.state==='invalidated'?' · 已失效':''}</p>
  {current?<Version version={current} current/>:<p>当前无可引用版本。</p>}
  {current&&(editing?<Editor key={`${memory.headRevision}:${editing}`} label={editing==='correct'?'修正后的正文':'变化后的正文'} initial={current.body??''} submitLabel={editing==='correct'?'保存错误修正':'保存变化记录'} busy={busy} cancel={()=>setEditing(null)} save={body=>decide({...request,action:editing,body})}/>:<div className="sqlite-memory-actions">
   <button type="button" disabled={busy} onClick={()=>setEditing('correct')}>纠正错误</button>
   <button type="button" disabled={busy} onClick={()=>setEditing('change')}>记录变化</button>
   <button type="button" disabled={busy} onClick={()=>decide({...request,action:memory.manualProtection?'unprotect':'protect'})}>{memory.manualProtection?'解除人工保护':'开启人工保护'}</button>
   {undoEligible&&<button type="button" disabled={busy||memory.manualProtection} onClick={()=>decide({...request,action:current.previousVersionNo===null?'withdraw':'restore',...(current.previousVersionNo===null?{}:{restoredFromVersionNo:current.previousVersionNo,expectedMergedParents:current.mergeParents.map(parent=>({...parent}))})})}>{current.mergeParentCount>1?`恢复合并前资料（共${current.mergeParentCount}项）`:current.previousVersionNo===null?'撤销首次自动采纳':'撤销自动更新'}</button>}
  </div>)}
  {undoEligible&&memory.manualProtection&&<p className="hint">撤销前须先明确解除当前人工保护。</p>}
  {withdrawnVersion&&<div className="sqlite-memory-actions"><button type="button" disabled={busy} onClick={()=>decide({...request,action:memory.manualProtection?'unprotect':'protect'})}>{memory.manualProtection?'解除人工保护':'开启人工保护'}</button><p className="hint">资料已撤回，仍可调整人工保护；开启后会阻止整组恢复。</p></div>}
  <details><summary>查看版本与决定历史</summary>{[...memory.versions].reverse().map(version=><Version key={version.versionNo} version={version} current={version.versionNo===current?.versionNo}/>)}
   <ol>{memory.decisions.map(decision=><li key={decision.id}>{decision.actorKind==='system'?'系统自动决定':'用户决定'} · {({auto_accept:'自动采纳',auto_update:'自动更新',auto_retire:'已并入合并资料',auto_noop:'跳过重复资料',...successMessages}[decision.action]??decision.action)} · {decision.outcome==='redacted'?'敏感材料已清除':'已生效'}</li>)}</ol>
  </details>
 </article>;
}

/** 资格失效或顶部范围变化立即卸载正文、依据和未提交编辑，迟到结果不再挂回。 */
export function SqliteMemoryManagementPanel({bridge,contactId,scopeRevision,documentsRefreshKey=0,completedRunId=null,visible=true,releaseOnUnmount=true}:{bridge:SqliteMemoryManagementBridge;contactId:string|null;scopeRevision:number;documentsRefreshKey?:number;completedRunId?:string|null;visible?:boolean;releaseOnUnmount?:boolean}){
 const [scopeKind,setScopeKind]=useState<'contact'|'self'>('contact');
 const [level,setLevel]=useState<'L1'|'L2'|'L3'>('L1');
 const context=useRef({bridge,contactId,scopeRevision,scopeKind});
 if(context.current.bridge!==bridge||context.current.contactId!==contactId||context.current.scopeRevision!==scopeRevision||context.current.scopeKind!==scopeKind)context.current={bridge,contactId,scopeRevision,scopeKind};
 const accepted=context.current;
 const [state,setState]=useState<{context:typeof accepted;snapshot:MemoryManagementSnapshot}|null>(null),[notice,setNotice]=useState<{context:typeof accepted;message:string;error:boolean}|null>(null),[busy,setBusy]=useState(false),[documentsBlocked,setDocumentsBlocked]=useState(false);
 const active=useRef(false),revision=useRef(0),reading=useRef<number|null>(null),refresh=useRef<(preserve?:boolean,silent?:boolean)=>Promise<boolean>>(async()=>false);
 const decisionPending=useRef(false),lastCompletedRun=useRef(completedRunId),completionRefreshPending=useRef(false);
 const scope={scopeKind,contactId:scopeKind==='self'?null:contactId};
 const readRequest=contactId?{scope,displayContactId:contactId,scopeRevision}:null;
 const current=state?.context===accepted?state.snapshot:null,currentNotice=notice?.context===accepted?notice:null;
 refresh.current=async(preserve=false,silent=false)=>{
  if(!readRequest||decisionPending.current||silent&&(busy||reading.current!==null||currentNotice?.error))return false;
  const token=++revision.current;reading.current=token;if(!preserve)setState(null);if(!silent){setBusy(true);setNotice(null);}
  try{const next=await bridge.read(readRequest);if(active.current&&context.current===accepted&&token===revision.current){setState({context:accepted,snapshot:next});if(!decisionPending.current)setDocumentsBlocked(false);return true;}}
  catch{if(active.current&&context.current===accepted&&token===revision.current){setState(null);setDocumentsBlocked(true);setNotice({context:accepted,message:'来源或范围暂不可用，已撤下原资料，请重新读取。',error:true});}}
  finally{if(reading.current===token)reading.current=null;if(active.current&&context.current===accepted&&token===revision.current&&!silent)setBusy(false);}
  return false;
 };
 useEffect(()=>{
  active.current=true;reading.current=null;decisionPending.current=false;completionRefreshPending.current=false;setState(null);setNotice(null);setBusy(false);setDocumentsBlocked(false);
  const unsubscribe=bridge.onInvalidated(()=>{revision.current++;reading.current=null;decisionPending.current=false;completionRefreshPending.current=false;setState(null);setDocumentsBlocked(true);setBusy(false);setNotice({context:accepted,message:'资料资格或连接已变化，已撤下正文、依据和编辑，请重试读取。',error:true});});
  if(contactId)void refresh.current();
  return()=>{active.current=false;revision.current++;unsubscribe();};
 },[accepted]);
 // 范围切换由 context 撤下旧快照；释放桥会广播失效，只在面板卸载或桥更换时执行。
 useEffect(()=>()=>{if(releaseOnUnmount)void bridge.release().catch(()=>{});},[bridge,releaseOnUnmount]);
 useEffect(()=>{
  if(completedRunId!==lastCompletedRun.current){lastCompletedRun.current=completedRunId;if(completedRunId)completionRefreshPending.current=true;}
  if(completionRefreshPending.current&&!busy&&contactId){completionRefreshPending.current=false;void refresh.current(true,true);}
 },[completedRunId,busy,accepted]);
 // 页面切换保留已核验快照，重新显示时静默更新；隐藏时仍接收资格失效事件。
 const wasVisible=useRef(visible);
 useEffect(()=>{const reopened=visible&&!wasVisible.current;wasVisible.current=visible;if(reopened)void refresh.current(true,true);},[visible]);
 useVisibleRefresh(()=>refresh.current(true,true),visible&&!!contactId&&!busy&&!currentNotice?.error);
 async function decide(request:Decision){
  if(!current||!readRequest||busy)return;const snapshot=current,token=++revision.current;decisionPending.current=true;setDocumentsBlocked(true);setState(null);setBusy(true);setNotice(null);
  let outcome:MemoryManagementOutcome;
  try{outcome=await bridge.decide({...readRequest,connectionGeneration:snapshot.connectionGeneration,request:{...request,requestKey:crypto.randomUUID()}});}catch{outcome={status:'unavailable'};}
  if(!active.current||context.current!==accepted||token!==revision.current){decisionPending.current=false;return;}
  decisionPending.current=false;
  if(outcome.status!=='applied'){setBusy(false);setNotice({context:accepted,message:outcomeMessages[outcome.status],error:true});return;}
  const refreshed=await refresh.current();if(active.current&&context.current===accepted)setNotice({context:accepted,message:refreshed?(successMessages[request.action]??'决定已保存。'):'决定已保存，但当前资料暂不可读。已撤下原资料，请重新读取。',error:!refreshed});
 }
 return <section className="sqlite-memory-management" aria-label="记忆候选与版本">
  <header className="memory-browser-toolbar"><div className="memory-person-switch" role="group" aria-label="记忆对象">{(['contact','self'] as const).map(kind=><button key={kind} type="button" aria-pressed={scopeKind===kind} disabled={!contactId} onClick={()=>setScopeKind(kind)}>{kind==='contact'?'对方':'我'}</button>)}</div></header>
  <div className="memory-level-tabs" role="group" aria-label="记忆层级">{(['L1','L2','L3'] as const).map(value=><button key={value} type="button" aria-label={value} aria-pressed={level===value} onClick={()=>setLevel(value)}><span>{value}</span><strong>{{L1:'具体记忆',L2:'主题资料',L3:'长期概览'}[value]}</strong></button>)}</div>
  {!contactId?<p className="memory-browser-empty">请先从顶部选择联系人。</p>:<div className="memory-flat-content" key={`${scopeKind}:${contactId}:${scopeRevision}`}>
   {scopeKind==='self'&&<p className="hint memory-scope-hint">仅展示来源完整归属于当前联系人的本人资料。</p>}
   <div hidden={level!=='L1'}>
   {currentNotice&&<p role={currentNotice.error?'alert':'status'}>{currentNotice.message}{currentNotice.error&&<button type="button" disabled={busy} onClick={()=>void refresh.current()}>重试读取记忆资料</button>}</p>}{busy&&<p role="status">正在核对记忆资料…</p>}
   {current&&<><h3 className="memory-collection-heading">正式记忆 <span>{current.view.memories.length} 条</span></h3>{current.view.memories.length===0?<p className="memory-browser-empty">当前范围没有可展示的正式记忆。</p>:<div className="memory-flat-grid">{current.view.memories.map(memory=><Memory key={`${memory.id}:${memory.headRevision}`} memory={memory} busy={busy} decide={request=>void decide(request)}/>)}</div>}
    <h3 className="memory-collection-heading">候选原稿 <span>{current.view.candidates.length} 条</span></h3>{current.view.candidates.length===0?<p className="memory-browser-empty">当前范围没有可展示的候选。</p>:<div className="memory-flat-grid">{current.view.candidates.map(candidate=><Candidate key={`${candidate.id}:${candidate.stateRevision}`} candidate={candidate} busy={busy} decide={request=>void decide(request)}/>)}</div>}</>}
   </div>
   <div hidden={level==='L1'}>{readRequest&&scopeKind==='contact'&&typeof bridge.readDocuments==='function'?<SqliteMemoryDocumentsPanel visible={visible&&level!=='L1'} bridge={bridge} request={readRequest} level={level==='L3'?'L3':'L2'} refreshKey={documentsRefreshKey} blocked={documentsBlocked} managementBusy={busy} retryManagement={()=>void refresh.current()}/>:<p className="memory-browser-empty">{scopeKind==='self'?(level==='L3'?'本人全局概览不在当前联系人页面展示。':'本人全局主题资料不在当前联系人页面展示。'):'当前连接暂不支持读取主题资料与长期概览。'}</p>}</div>
  </div>}
 </section>;
}
