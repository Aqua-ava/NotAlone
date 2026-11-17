import type {MemoryBrowserDocuments} from './use-memory-browser';

/** 展示浏览模块已核验的发布集合；读取、刷新和资格次序由模块统一管理。 */
export function SqliteMemoryDocumentsPanel({state,level='L2',onRetry}:{state:MemoryBrowserDocuments;level?:'L2'|'L3';onRetry:()=>void}){
 const {snapshot,notice,busy,availability}=state;
 const blocked=availability!=='available',managementBusy=availability==='checking';
 const view=blocked?undefined:snapshot?.view;
 const documents=view?.publication?view.documents.filter(document=>document.kind===(level==='L2'?'scene':'profile')):[];
 const message=view?.status==='processing'?view.publication?'本轮处理中，当前仍可查看此前已发布资料。':'本轮处理中，尚无可用的发布集合。'
  :view?.status==='conflict'?view.publication?'本轮存在并发冲突；以下仍是当前可用的已发布资料。':'本轮存在并发冲突，请重新启动处理。'
  :view?.status==='needs_revalidation'?view.publication?'本轮资料待核验；以下仍是当前可用的已发布资料。':'来源或资料已失效，等待重新核验。'
  :view?.status==='completed'&&view.publication?'主题资料与长期概览已完成发布。'
  :view?.status==='idle'?'当前尚无已发布的主题资料。':null;
 return <section className="sqlite-memory-documents" aria-label="主题资料与长期概览">
  <h3 className="memory-collection-heading">{level==='L2'?'主题资料':'长期概览'} <span>{view?.publication||view?.status==='idle'?`${documents.length} 篇`:''}</span></h3>
  {blocked&&<><p role={managementBusy?'status':'alert'}>{managementBusy?'正在核对更新后的主题资料…':'资料资格尚未重新核验，已撤下正文和依据。'}</p>{!managementBusy&&<button type="button" onClick={onRetry}>重试读取主题资料</button>}</>}
  {busy&&!view&&<p role="status">正在核对主题资料…</p>}
  {notice&&<p role="alert">{notice}<button type="button" disabled={busy} onClick={onRetry}>重试读取主题资料</button></p>}
  {message&&<p role="status">{message}</p>}
  {level==='L3'&&view?.profileSelection&&view.profileSelection.rejected>0&&<p role="status">核验结果：{view.profileSelection.accepted} 条通过，{view.profileSelection.rejected} 条未通过。未通过的新提案未采纳。{view.profileSelection.retained>0?`另保留 ${view.profileSelection.retained} 条已有有效内容。`:view.profileSelection.accepted===0?'本轮没有新增概览。':''}</p>}
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
