import {useEffect,useRef,useState} from 'react';
import type {MemoryDocumentsSnapshot,MemoryManagementRead,SqliteMemoryManagementBridge} from '../shared/sqlite-memory-management';
import {useVisibleRefresh} from './use-visible-refresh';

/** 一个范围只展示后端核验过的完整发布集合；失效事件先卸载快照。 */
export function SqliteMemoryDocumentsPanel({bridge,request,level='L2',refreshKey=0,blocked=false,managementBusy=false,retryManagement,visible=true}:{bridge:SqliteMemoryManagementBridge;request:MemoryManagementRead;level?:'L2'|'L3';refreshKey?:number;blocked?:boolean;managementBusy?:boolean;retryManagement?:()=>void;visible?:boolean}){
 const [snapshot,setSnapshot]=useState<MemoryDocumentsSnapshot|null>(null),[notice,setNotice]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const active=useRef(false),revision=useRef(0),busyRef=useRef(false),refreshQueued=useRef(false),refresh=useRef<()=>Promise<void>>(async()=>{});
 refresh.current=async()=>{
  if(!active.current||blocked)return;
  if(busyRef.current){refreshQueued.current=true;return;}const token=++revision.current;busyRef.current=true;setBusy(true);setNotice(null);
  try{
   const value=await bridge.readDocuments(request);
   if(active.current&&revision.current===token){setSnapshot(value);}
  }catch{
   if(active.current&&revision.current===token){setSnapshot(null);setNotice('来源或范围暂不可用，已撤下原资料，请重新读取。');}
  }finally{if(active.current&&revision.current===token){busyRef.current=false;setBusy(false);if(refreshQueued.current){refreshQueued.current=false;queueMicrotask(()=>void refresh.current());}}}
 };
 useEffect(()=>{
  if(blocked){setSnapshot(null);setNotice(null);setBusy(false);return;}
  active.current=true;const unsubscribe=bridge.onInvalidated(()=>{revision.current++;busyRef.current=false;refreshQueued.current=false;setBusy(false);setSnapshot(null);setNotice('资料资格或连接已变化，已撤下正文和依据，请重新读取。');});
  void refresh.current();
  return()=>{active.current=false;revision.current++;busyRef.current=false;refreshQueued.current=false;unsubscribe();};
 },[bridge,request.scope.scopeKind,request.scope.contactId,request.displayContactId,request.scopeRevision,blocked]);
 useEffect(()=>{if(refreshKey)void refresh.current();},[refreshKey]);
 const wasVisible=useRef(visible);
 useEffect(()=>{const reopened=visible&&!wasVisible.current;wasVisible.current=visible;if(reopened&&!notice)void refresh.current();},[visible]);
 useVisibleRefresh(()=>refresh.current(),visible&&!notice&&!blocked,2000);
 const view=blocked?undefined:snapshot?.view;
 const documents=view?.publication?view.documents.filter(document=>document.kind===(level==='L2'?'scene':'profile')):[];
 const message=view?.status==='processing'?view.publication?'本轮处理中，当前仍可查看此前已发布资料。':'本轮处理中，尚无可用的发布集合。'
  :view?.status==='conflict'?view.publication?'本轮存在并发冲突；以下仍是当前可用的已发布资料。':'本轮存在并发冲突，请重新启动处理。'
  :view?.status==='needs_revalidation'?view.publication?'本轮资料待核验；以下仍是当前可用的已发布资料。':'来源或资料已失效，等待重新核验。'
  :view?.status==='completed'&&view.publication?'主题资料与长期概览已完成发布。'
  :view?.status==='idle'?'当前尚无已发布的主题资料。':null;
 return <section className="sqlite-memory-documents" aria-label="主题资料与长期概览">
  <h3 className="memory-collection-heading">{level==='L2'?'主题资料':'长期概览'} <span>{view?.publication||view?.status==='idle'?`${documents.length} 篇`:''}</span></h3>
  {blocked&&<><p role={managementBusy?'status':'alert'}>{managementBusy?'正在核对更新后的主题资料…':'资料资格尚未重新核验，已撤下正文和依据。'}</p>{!managementBusy&&<button type="button" onClick={retryManagement}>重试读取主题资料</button>}</>}
  {busy&&!view&&<p role="status">正在核对主题资料…</p>}
  {notice&&<p role="alert">{notice}<button type="button" disabled={busy} onClick={()=>void refresh.current()}>重试读取主题资料</button></p>}
  {message&&<p role="status">{message}</p>}
  {view?.publication&&view.documents.length===0&&<p>当前发布集合没有可展示的资料。</p>}
  {documents.length===0&&<p className="memory-browser-empty">{blocked||view?.status==='needs_revalidation'?'资料待核验，暂不可查看。':busy&&!view?'正在读取资料…':level==='L2'?'当前还没有可展示的主题资料。':'当前还没有可展示的长期概览。'}</p>}
  <div className="memory-flat-grid memory-document-grid">{documents.map(document=><article key={`${document.id}:${document.versionNo}`} className="sqlite-memory-card" aria-label={document.kind==='scene'?'主题资料':'长期概览'}>
   <h3>{document.title}</h3><p className="hint">{document.kind==='scene'?'主题资料':'长期概览'}</p>
   {document.statements.map((statement,index)=><div key={index}>
    {statement.kind==='inference'&&<p className="hint">推断{statement.uncertainty?` · ${statement.uncertainty}`:''}</p>}
    {statement.kind==='contradiction'&&<p className="hint">{statement.resolutionState==='resolved'?'已记录解决':'存在未解矛盾'}：{statement.leftClaim} / {statement.rightClaim}{statement.resolutionText?`；${statement.resolutionText}`:''}</p>}
    <p className="sqlite-memory-body">{statement.text}</p>{statement.basis&&<p>说明：{statement.basis}</p>}
    <details className="sqlite-memory-sources"><summary>查看依据</summary><ul>{statement.references.map(reference=><li key={`${reference.memoryId}:${reference.versionNo}`}>
     <p>记忆 {reference.memoryId} · 版本 {reference.versionNo}</p><blockquote>{reference.memoryText}</blockquote>
    </li>)}</ul></details>
   </div>)}
  </article>)}</div>
 </section>;
}
