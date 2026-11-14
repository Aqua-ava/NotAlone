import {useEffect,useRef,useState} from 'react';
import type {MemoryCandidateView,MemoryDecisionRequest,MemoryManagementOutcome,MemoryManagementSnapshot,MemoryManagementRead,MemoryHistorySnapshot,MemorySource,MemoryVerificationState,MemoryVersionView,MemoryView,SqliteMemoryManagementBridge} from '../shared/sqlite-memory-management';
import {memoryReadResult,memoryReadFailureCode,withdrawnProtectionVersion} from '../shared/sqlite-memory-management';
import {SqliteMemoryDocumentsPanel} from './SqliteMemoryDocumentsPanel';
import {useVisibleRefresh} from './use-visible-refresh';
import {memoriesBySourceTime,memorySourceDateLabel,memorySourceTime} from './memory-source-time';

type Decision=Omit<MemoryDecisionRequest,'requestKey'>;
const outcomeMessages={conflict:'资料已被其他操作修改，存在并发冲突。请重试读取后重新决定。',source_stale:'来源或范围已失效，已撤下原资料。请重试读取。',protected:'当前记忆受人工保护，请重试读取并核对；撤销前须先明确解除保护。',unavailable:'本次决定暂未确认，请重试读取当前状态后再操作。'};
const successMessages:Record<string,string>={accept:'采纳成功，已形成正式版本。',edit_accept:'修改采纳成功，固定模型原稿保留。',reject:'已拒绝候选。',correct:'错误修正成功，旧版不再作为当前事实。',change:'变化已记录，旧版不再作为当前事实。',protect:'已开启当前人工保护。',unprotect:'已解除当前人工保护。',restore:'自动更新已撤销，已新增恢复版本。',withdraw:'已撤销首次自动采纳，内容不再作为当前事实。'};
const formationNames:Record<string,string>={adoption:'采纳',correction:'纠正错误',change:'记录变化',restore:'撤销恢复',manual:'手动补充'};
const adoptionNames:Record<string,string>={auto:'自动采纳',user:'用户采纳',manual:'手动补充'};
const memoryLevelNames={L1:'具体记忆',L2:'主题资料',L3:'长期概览'} as const;
type MemoryLevel=keyof typeof memoryLevelNames;
function SourceTime({sources}:{sources:MemorySource[]}){
 const time=memorySourceTime(sources);
 return <p className="memory-source-time">{time?<><span>聊天来源</span><time dateTime={new Date(time.start).toISOString()}>{memorySourceDateLabel(time)}</time>{!time.complete&&<span>部分日期未知</span>}</>:<span>聊天来源日期未知</span>}</p>;
}
function Verification({state}:{state:MemoryVerificationState}){
 return <p className="hint">{state==='verified'?<strong>来源已核验</strong>:<><strong>来源待核验</strong>；可查看原话，但尚未确认来源支持这条资料。</>}</p>;
}
function Sources({sources,verification}:{sources:MemorySource[];verification?:MemoryVerificationState}){
 return <details className="sqlite-memory-sources"><summary>查看来源</summary>{verification&&<Verification state={verification}/>}{sources.length===0?<p>无可展示的来源。</p>:<ol>{sources.map((source,index)=><li key={`${source.recordId}:${index}`}>
  {source.contentKind==='image'?<><p>图片依据</p>{source.description&&<p>模型观察：{source.description}</p>}</>:<blockquote>{source.quote}</blockquote>}<details><summary>来源定位</summary><p>消息：{source.messageId}</p><p>来源记录：{source.recordId}</p><p>解释修订：{source.acceptedRevision}</p>{source.contentRef&&'file_id' in source.contentRef&&<p>图片版本：{source.contentRef.file_id}</p>}</details>
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
/** 候选待确认原因码的固定文案；未知码走兜底文案，不猜测含义。 */
const pendingReasonTexts:Record<string,string>={
 memory_conditions_pending:'存在无法自行判定的数据条件：未决指代、时间不合格或条件缺少来源，需要人工确认。',
 memory_relation_conflict:'与旧资料构成真实矛盾，系统无法自行取舍，需要人工确认。',
 memory_relation_evidence_incomplete:'关系证据未覆盖所比较的旧资料，需要重新核验。',
 memory_relation_unsupported:'关系核验未通过，需要重新处理后再确认。',
 memory_relation_inconsistent:'模型判定自相矛盾，需要重新处理后再确认。',
 memory_duplicate_pending:'与旧资料的重复判定未通过，需要重新处理后再确认。',
 memory_merge_pending:'合并核验未通过，需要重新处理后再确认。',
 memory_multiple_targets_pending:'多条旧资料都可能成为改动目标，需要人工选择。',
 memory_protected:'目标记忆受人工保护，需要人工确认。',
 memory_timeline_pending:'时间线覆盖有风险，需要人工确认。',
 memory_media_relation_pending:'候选含图片或与图片主题的关联待确认，需要人工确认。',
 memory_processing_incomplete:'本轮运行尚未完成（等候额度、被打断或尚未开始），不需要逐条确认。',
};
function pendingStageText(candidate:MemoryCandidateView):{label:string;detail:string|null}{
 if(candidate.pendingStage==='processing_incomplete')return {label:'处理中/未完成',detail:pendingReasonTexts.memory_processing_incomplete};
 const reason=candidate.pendingReason??null;
 if(reason==='memory_conditions_pending')return {label:'待确认（数据条件）',detail:pendingReasonTexts.memory_conditions_pending};
 if(reason&&pendingReasonTexts[reason])return {label:'待确认',detail:pendingReasonTexts[reason]};
 return {label:'待确认',detail:reason?`处理原因未知（${reason}），可先查看来源或联系处理记录。`:null};
}
function Candidate({candidate,busy,decide}:{candidate:MemoryCandidateView;busy:boolean;decide:(request:Decision)=>void}){
 const [editing,setEditing]=useState(false),request={candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]};
 const stage=pendingStageText(candidate);
 return <article className="sqlite-memory-card memory-candidate-item" aria-label="记忆候选">
  <SourceTime sources={candidate.sources}/>
  <p>{stage.label}</p>
  {stage.detail&&<p className="hint">{stage.detail}</p>}
  <Verification state={candidate.verificationState}/>
  <p className="sqlite-memory-body">{candidate.body}</p><Sources sources={candidate.sources}/>
  {candidate.state==='pending'&&candidate.pendingStage!=='processing_incomplete'&&(editing?<Editor label="修改候选正文" initial={candidate.body} submitLabel="保存修改并采纳" busy={busy} cancel={()=>setEditing(false)} save={body=>decide({...request,action:'edit_accept',body})}/>:<div className="sqlite-memory-actions">
   <button type="button" disabled={busy} onClick={()=>decide({...request,action:'accept'})}>采纳原稿</button>
   <button type="button" disabled={busy} onClick={()=>setEditing(true)}>修改并采纳</button>
   <button type="button" disabled={busy} onClick={()=>decide({...request,action:'reject'})}>拒绝候选</button>
  </div>)}
 </article>;
}
function MemoryBody({version,current}:{version:MemoryVersionView;current:boolean}){
 return version.body===null?<p>正文已清除或来源已失效。</p>:<>
  {version.timeStatus==='needs_revalidation'&&<p className="hint">时间待核验，暂不用于生成。</p>}
  {version.timeStatus==='invalid'&&<p className="hint">时间资料异常，暂不用于生成。</p>}
  {version.timeStatus==='out_of_window'&&<p className="hint">不在有效时间内，不再引用。</p>}
  <p className="sqlite-memory-body">{current&&version.timeStatus!=='out_of_window'?version.body:<s>{version.body}</s>}</p>
 </>;
}
function Version({version,current}:{version:MemoryVersionView;current:boolean}){
 return <div className={current?'sqlite-memory-version':'sqlite-memory-old'}><p className="memory-version-meta">版本 {version.versionNo} · {formationNames[version.formationKind]??version.formationKind} · {adoptionNames[version.adoptionMode]??version.adoptionMode}{current?' · 当前版本':' · 不作为当前事实'}</p>
  <MemoryBody version={version} current={current}/>
  {version.body!==null&&<Sources sources={version.sources} verification={version.verificationState}/>}
  {!!version.originalCandidates?.length&&<details className="memory-original-candidates"><summary>提取原稿</summary>{version.originalCandidates.map(candidate=><article key={candidate.id} aria-label="已采纳原稿">
   <SourceTime sources={candidate.sources}/><p className="sqlite-memory-body">{candidate.body}</p><Sources sources={candidate.sources} verification={candidate.verificationState}/>
  </article>)}</details>}
  {version.restoredFromVersionNo&&<p>恢复自版本 {version.restoredFromVersionNo}，原前驱为版本 {version.previousVersionNo}。</p>}
 </div>;
}
function MemoryHistory({memory,bridge,request,authority}:{memory:MemoryView;bridge:SqliteMemoryManagementBridge;request:MemoryManagementRead;authority:MemoryManagementSnapshot}){
 const [open,setOpen]=useState(false),[loaded,setLoaded]=useState<{authority:MemoryManagementSnapshot;value:MemoryHistorySnapshot}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[readRetryable,setReadRetryable]=useState(false);
 const [previous,setPrevious]=useState<(string|undefined)[]>([]),active=useRef(true),generation=useRef(0),cursor=useRef<string|undefined>(undefined),latestAuthority=useRef(authority);
 latestAuthority.current=authority;
 useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++;};},[]);
 async function load(next?:string){
  if(!bridge.readHistory)return;const token=++generation.current;setLoaded(null);setBusy(true);setError('');setReadRetryable(false);
  const current=()=>active.current&&generation.current===token&&latestAuthority.current===authority;
  try{const value=memoryReadResult(await bridge.readHistory({...request,memoryId:memory.id,expectedHeadRevision:memory.headRevision,...(next?{cursor:next}:{})}));if(current())setLoaded({authority,value});}
  catch(error){if(current()){const code=memoryReadFailureCode(error);setReadRetryable(code!==null);setLoaded(null);setError(code==='memory_read_timeout'?'读取超时，请重试':code?'读取暂不可用，请重试':'历史资料已变化，请收起后重新展开。');}}
  finally{if(current())setBusy(false);}
 }
 // 每次权威列表重读都撤下旧历史；运行时来源资格变化不一定会推进记忆头或页面修订。
 useEffect(()=>{setLoaded(null);setError('');if(open)void load(cursor.current);return()=>{generation.current++;};},[authority,open]);
 const snapshot=loaded?.authority===authority?loaded.value:null,history=bridge.readHistory?snapshot?.view:memory;
 return <details className="memory-version-history" onToggle={event=>{const expanded=event.currentTarget.open;setOpen(expanded);if(!expanded){cursor.current=undefined;setPrevious([]);}}}>
  <summary>更新历史</summary>
  {open&&<>{busy&&<p role="status">正在读取本页历史…</p>}{error&&<p role="alert">{error}{readRetryable&&<button type="button" disabled={busy} onClick={()=>void load(cursor.current)}>重试读取历史资料</button>}</p>}
   {history&&<>{[...history.versions].reverse().map(version=><Version key={version.versionNo} version={version} current={version.versionNo===memory.current?.versionNo}/>)}
    <ol>{history.decisions.map(decision=><li key={decision.id}>{decision.actorKind==='system'?'系统自动决定':'用户决定'} · {({auto_accept:'自动采纳',auto_update:'自动更新',auto_retire:'已并入合并资料',auto_noop:'跳过重复资料',...successMessages}[decision.action]??decision.action)} · {decision.outcome==='redacted'?'敏感材料已清除':'已生效'}</li>)}</ol></>}
   {snapshot&&(previous.length>0||snapshot.view.nextCursor)&&<nav className="sqlite-memory-actions" aria-label="记忆历史分页"><button type="button" disabled={busy||!previous.length} onClick={()=>{const next=previous.at(-1);setPrevious(previous.slice(0,-1));cursor.current=next;void load(next);}}>较新的记录</button>
    <button type="button" disabled={busy||!snapshot.view.nextCursor} onClick={()=>{const next=snapshot.view.nextCursor!;setPrevious([...previous,cursor.current]);cursor.current=next;void load(next);}}>更早的记录</button></nav>}
  </>}
 </details>;
}
function Memory({memory,busy,decide,bridge,request:historyRequest,authority}:{memory:MemoryView;busy:boolean;decide:(request:Decision)=>void;bridge:SqliteMemoryManagementBridge;request:MemoryManagementRead;authority:MemoryManagementSnapshot}){
 const [editing,setEditing]=useState<'correct'|'change'|null>(null),[moreOpen,setMoreOpen]=useState(false),current=memory.current,withdrawnVersion=withdrawnProtectionVersion(memory);
 const request={memoryId:memory.id,expectedVersionNo:(current??withdrawnVersion)?.versionNo,expectedHeadRevision:memory.headRevision};
 const undoEligible=current?.adoptionMode==='auto'&&current.formationKind!=='restore';
 const hasHistory=!current||current.formationKind==='adoption'||BigInt(memory.headRevision)>1n||BigInt(current.versionNo)>1n||memory.versions.some(version=>version.versionNo!==current.versionNo);
 return <article className={`sqlite-memory-card memory-timeline-item${current?'':' memory-timeline-unavailable'}`} aria-label="正式记忆">
  <SourceTime sources={current?.sources??[]}/>
  {current?<div className="memory-current-content"><MemoryBody version={current} current/>
   {current.body!==null&&current.verificationState!=='verified'&&<Verification state={current.verificationState}/>}
   {current.sourcePendingRecheck&&<p className="hint" role="status"><strong>来源待重新核验</strong>；读取授权恢复前仍可查看已保存的资料，修改前会重新核验来源。</p>}
  </div>:<p className="memory-unavailable-body">当前无可引用版本。{memory.state==='withdrawn'?'已撤销。':memory.state==='invalidated'?'已失效。':''}</p>}
  <div className="memory-card-tools">
   {current&&<><span className="memory-origin">{{auto:'系统添加',user:'已确认',manual:'手动添加'}[current.adoptionMode]??'来历待核对'}</span>
    {memory.manualProtection&&<span className="memory-protection-status">已保护</span>}
    {current.body!==null&&<Sources sources={current.sources} verification={current.verificationState}/>}
    {!editing&&<button type="button" disabled={busy} onClick={()=>setEditing('correct')}>修改</button>}
   </>}
   <details className="memory-more" onToggle={event=>setMoreOpen(event.currentTarget.open)}>
    <summary>更多</summary>
    {moreOpen&&<>
     {(current||withdrawnVersion)&&<div className="sqlite-memory-actions">
      {current&&<button type="button" disabled={busy||editing!==null} onClick={()=>setEditing('change')}>记录变化</button>}
      <button type="button" disabled={busy||editing!==null} onClick={()=>decide({...request,action:memory.manualProtection?'unprotect':'protect'})}>{memory.manualProtection?'解除人工保护':'开启人工保护'}</button>
      {current&&undoEligible&&<button type="button" disabled={busy||editing!==null||memory.manualProtection} onClick={()=>decide({...request,action:current.previousVersionNo===null?'withdraw':'restore',...(current.previousVersionNo===null?{}:{restoredFromVersionNo:current.previousVersionNo,expectedMergedParents:current.mergeParents.map(parent=>({...parent}))})})}>{current.mergeParentCount>1?`恢复合并前资料（共${current.mergeParentCount}项）`:current.previousVersionNo===null?'撤销首次自动采纳':'撤销自动更新'}</button>}
     </div>}
     {undoEligible&&memory.manualProtection&&<p className="hint">撤销前须先明确解除当前人工保护。</p>}
     {withdrawnVersion&&<p className="hint">资料已撤回，仍可调整人工保护；开启后会阻止整组恢复。</p>}
     {hasHistory&&<MemoryHistory memory={memory} bridge={bridge} request={historyRequest} authority={authority}/>}
    </>}
   </details>
  </div>
  {current&&editing&&<Editor key={`${memory.headRevision}:${editing}`} label={editing==='correct'?'修正后的正文':'变化后的正文'} initial={current.body??''} submitLabel={editing==='correct'?'保存错误修正':'保存变化记录'} busy={busy} cancel={()=>setEditing(null)} save={body=>decide({...request,action:editing,body})}/>}
 </article>;
}

/** 资格失效或顶部范围变化立即卸载正文、依据和未提交编辑，迟到结果不再挂回。 */
export function SqliteMemoryManagementPanel({bridge,contactId,scopeRevision,documentsRefreshKey=0,completedRunId=null,visible=true,releaseOnUnmount=true}:{bridge:SqliteMemoryManagementBridge;contactId:string|null;scopeRevision:number;documentsRefreshKey?:number;completedRunId?:string|null;visible?:boolean;releaseOnUnmount?:boolean}){
 const [scopeKind,setScopeKind]=useState<'contact'|'self'>('contact');
 const [level,setLevel]=useState<MemoryLevel>('L1');
 const pageCursor=useRef<string|undefined>(undefined),[previousPages,setPreviousPages]=useState<(string|undefined)[]>([]);
 const context=useRef({bridge,contactId,scopeRevision,scopeKind});
 if(context.current.bridge!==bridge||context.current.contactId!==contactId||context.current.scopeRevision!==scopeRevision||context.current.scopeKind!==scopeKind)context.current={bridge,contactId,scopeRevision,scopeKind};
 const accepted=context.current;
 const [state,setState]=useState<{context:typeof accepted;snapshot:MemoryManagementSnapshot}|null>(null),[notice,setNotice]=useState<{context:typeof accepted;message:string;error:boolean}|null>(null),[busy,setBusy]=useState(false),[documentsBlocked,setDocumentsBlocked]=useState(false);
 const active=useRef(false),revision=useRef(0),reading=useRef<number|null>(null),refresh=useRef<(preserve?:boolean,silent?:boolean)=>Promise<boolean>>(async()=>false);
 const decisionPending=useRef(false),lastCompletedRun=useRef(completedRunId),completionRefreshPending=useRef(false);
 const scope={scopeKind,contactId:scopeKind==='self'?null:contactId};
 const readRequest=contactId?{scope,displayContactId:contactId,scopeRevision}:null;
 const current=state?.context===accepted?state.snapshot:null,currentNotice=notice?.context===accepted?notice:null;
 // 旧读视图或旧快照没有 pendingStage 时按待确认展示，避免已有数据改口径。
 const pendingCandidates=current?.view.candidates.filter(candidate=>candidate.state==='pending'&&candidate.pendingStage!=='processing_incomplete')??[];
 const incompleteCandidates=current?.view.candidates.filter(candidate=>candidate.state==='pending'&&candidate.pendingStage==='processing_incomplete')??[];
 refresh.current=async(preserve=false,silent=false)=>{
  if(!readRequest||decisionPending.current||silent&&(busy||reading.current!==null||currentNotice?.error))return false;
  const token=++revision.current;reading.current=token;if(!preserve)setState(null);if(!silent){setBusy(true);setNotice(null);}
  try{const next=memoryReadResult(await bridge.read({...readRequest,...(pageCursor.current?{cursor:pageCursor.current}:{})}));if(active.current&&context.current===accepted&&token===revision.current){setState({context:accepted,snapshot:next});if(!decisionPending.current)setDocumentsBlocked(false);return true;}}
  catch(error){if(active.current&&context.current===accepted&&token===revision.current){const code=memoryReadFailureCode(error);if(code){setNotice({context:accepted,message:code==='memory_read_timeout'?'读取超时，请重试':'读取暂不可用，请重试',error:true});}else{setState(null);setDocumentsBlocked(true);setNotice({context:accepted,message:'来源或范围暂不可用，已撤下原资料，请重新读取。',error:true});}}}
  finally{if(reading.current===token)reading.current=null;if(active.current&&context.current===accepted&&token===revision.current&&!silent)setBusy(false);}
  return false;
 };
 useEffect(()=>{
  active.current=true;pageCursor.current=undefined;setPreviousPages([]);reading.current=null;decisionPending.current=false;completionRefreshPending.current=false;setState(null);setNotice(null);setBusy(false);setDocumentsBlocked(false);
  const unsubscribe=bridge.onInvalidated(()=>{revision.current++;reading.current=null;decisionPending.current=false;completionRefreshPending.current=false;setState(null);setDocumentsBlocked(true);setBusy(false);setNotice({context:accepted,message:'资料资格或连接已变化，已撤下正文、依据和编辑，请重试读取。',error:true});});
  if(contactId)void refresh.current();
  return()=>{active.current=false;revision.current++;unsubscribe();};
 },[accepted]);
 // 范围切换由 context 撤下旧快照；释放桥会广播失效，只在面板卸载或桥更换时执行。
 useEffect(()=>()=>{if(releaseOnUnmount)void bridge.release().catch(()=>{});},[bridge,releaseOnUnmount]);
 useEffect(()=>{
  if(completedRunId!==lastCompletedRun.current){lastCompletedRun.current=completedRunId;if(completedRunId)completionRefreshPending.current=true;}
  if(completionRefreshPending.current&&!busy&&contactId){completionRefreshPending.current=false;pageCursor.current=undefined;setPreviousPages([]);void refresh.current(true,true);}
 },[completedRunId,busy,accepted]);
 // 页面切换保留已核验快照，重新显示时静默更新；隐藏时仍接收资格失效事件。
 const wasVisible=useRef(visible);
 useEffect(()=>{const reopened=visible&&!wasVisible.current;wasVisible.current=visible;if(reopened)void refresh.current(true,true);},[visible]);
 useVisibleRefresh(()=>refresh.current(true,true),visible&&level==='L1'&&!!contactId&&!busy&&!currentNotice?.error,current?.view.page?.preparing?1000:30000);
 function restart(){const preserve=!!current&&pageCursor.current===undefined;pageCursor.current=undefined;setPreviousPages([]);void refresh.current(preserve);}
 function changePage(next:string|undefined,previous:(string|undefined)[]){pageCursor.current=next;setPreviousPages(previous);void refresh.current();}
 async function decide(request:Decision){
  if(!current||!readRequest||busy)return;const snapshot=current,token=++revision.current;decisionPending.current=true;setDocumentsBlocked(true);setState(null);setBusy(true);setNotice(null);
  let outcome:MemoryManagementOutcome;
  try{outcome=await bridge.decide({...readRequest,connectionGeneration:snapshot.connectionGeneration,request:{...request,requestKey:crypto.randomUUID()}});}catch{outcome={status:'unavailable'};}
  if(!active.current||context.current!==accepted||token!==revision.current){decisionPending.current=false;return;}
  decisionPending.current=false;
  if(outcome.status!=='applied'){setBusy(false);setNotice({context:accepted,message:outcomeMessages[outcome.status],error:true});return;}
  pageCursor.current=undefined;setPreviousPages([]);const refreshed=await refresh.current();if(active.current&&context.current===accepted)setNotice({context:accepted,message:refreshed?(successMessages[request.action]??'决定已保存。'):'决定已保存，但当前资料暂不可读。已撤下原资料，请重新读取。',error:!refreshed});
 }
 return <section className="sqlite-memory-management memory-timeline-browser" aria-label="记忆候选与版本">
  <header className="memory-browser-toolbar"><p className="memory-browser-caption">相处的点滴</p><div className="memory-person-switch" role="group" aria-label="记忆对象">{(['contact','self'] as const).map(kind=><button key={kind} type="button" aria-pressed={scopeKind===kind} disabled={!contactId} onClick={()=>setScopeKind(kind)}>{kind==='contact'?'对方':'我'}</button>)}</div></header>
  <div className="memory-level-tabs" role="group" aria-label="记忆层级">{(['L1','L2','L3'] as const).map(value=><button key={value} type="button" aria-pressed={level===value} onClick={()=>setLevel(value)}>{memoryLevelNames[value]}</button>)}</div>
  {!contactId?<p className="memory-browser-empty">请先从顶部选择联系人。</p>:<div className="memory-flat-content" key={`${scopeKind}:${contactId}:${scopeRevision}`}>
   {scopeKind==='self'&&<p className="hint memory-scope-hint">仅展示来源完整归属于当前联系人的本人资料。</p>}
   <div hidden={level!=='L1'}>
   {currentNotice&&<p role={currentNotice.error?'alert':'status'}>{currentNotice.message}{currentNotice.error&&<button type="button" disabled={busy} onClick={restart}>重试读取记忆资料</button>}</p>}{busy&&<p role="status">正在核对记忆资料…</p>}
   {current?.view.page?.preparing&&<p role="status">正在准备记忆列表，请稍候…</p>}
   {current&&!current.view.page?.preparing&&<><div className={`memory-timeline-layout${pendingCandidates.length||incompleteCandidates.length?' memory-timeline-with-pending':''}`}><section className="memory-timeline-section" aria-label="正式记忆时间线"><h3 className="memory-collection-heading">正式记忆 <span>{current.view.page?'本页 ':''}{current.view.memories.length} 条</span></h3>{current.view.memories.length===0?<p className="memory-browser-empty">本页没有可展示的正式记忆。</p>:<div className="memory-timeline-list">{memoriesBySourceTime(current.view.memories).map(memory=><Memory key={`${memory.id}:${memory.headRevision}`} memory={memory} busy={busy} bridge={bridge} request={readRequest!} authority={current} decide={request=>void decide(request)}/>)}</div>}</section>
    {incompleteCandidates.length>0&&<aside className="memory-candidates-aside" aria-label="处理中未完成记忆"><h3 className="memory-collection-heading">处理中/未完成 <span>{current.view.page?'本页 ':''}{incompleteCandidates.length} 条</span></h3>
      <p className="hint">这些候选不需要逐条确认；继续或重试请使用处理页面的「继续」或「放弃未知并重试」入口。</p>
      <div className="memory-candidate-list">{incompleteCandidates.map(candidate=><Candidate key={`${candidate.id}:${candidate.stateRevision}`} candidate={candidate} busy={busy} decide={request=>void decide(request)}/>)}</div></aside>}
    {pendingCandidates.length>0&&<aside className="memory-candidates-aside" aria-label="待确认记忆"><h3 className="memory-collection-heading">待确认记忆 <span>{current.view.page?'本页 ':''}{pendingCandidates.length} 条</span></h3><div className="memory-candidate-list">{pendingCandidates.map(candidate=><Candidate key={`${candidate.id}:${candidate.stateRevision}`} candidate={candidate} busy={busy} decide={request=>void decide(request)}/>)}</div></aside>}</div><p className="memory-timeline-note">{current.view.page?'本页':''}按已知聊天来源时间排列 · 日期以本机时区显示，不代表事件发生日。</p></>}
   <nav className="sqlite-memory-actions" aria-label="记忆列表分页">
    <button type="button" disabled={busy||!previousPages.length} onClick={()=>changePage(previousPages.at(-1),previousPages.slice(0,-1))}>上一页记忆</button>
    <span>第 {previousPages.length+1} 页</span>
    <button type="button" disabled={busy||!current?.view.page?.nextCursor} onClick={()=>changePage(current!.view.page!.nextCursor!,[...previousPages,pageCursor.current])}>下一页记忆</button>
    <button type="button" disabled={busy} onClick={restart}>重新读取第一页</button>
   </nav>
   </div>
   <div hidden={level==='L1'}>{readRequest&&scopeKind==='contact'&&typeof bridge.readDocuments==='function'?<SqliteMemoryDocumentsPanel visible={visible&&level!=='L1'} bridge={bridge} request={readRequest} level={level==='L3'?'L3':'L2'} refreshKey={documentsRefreshKey} blocked={documentsBlocked} managementBusy={busy} retryManagement={()=>void refresh.current()}/>:<p className="memory-browser-empty">{scopeKind==='self'?(level==='L3'?'本人全局概览不在当前联系人页面展示。':'本人全局主题资料不在当前联系人页面展示。'):'当前连接暂不支持读取主题资料与长期概览。'}</p>}</div>
  </div>}
 </section>;
}
