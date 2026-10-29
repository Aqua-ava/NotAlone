import type {SqliteDiscussionEntry,SqliteRuntimeRecovery} from '../shared/sqlite-discussion';
/** 资格与删除事件先撤销主进程快照，再显示新的权威正文。 */
export function SqliteDiscussionEntries({entries,recovery}:{entries:SqliteDiscussionEntry[];recovery?:SqliteRuntimeRecovery}){
 return <section aria-label="助手讨论发言">
  {recovery==='blocked'&&<p role="status">运行记录恢复受阻，已保存的有效讨论仍可查看。再次发起请求前会重新核验资料。</p>}
  {!entries.length&&<p>当前会话还没有讨论。</p>}
  {entries.map(entry=><article key={entry.entryId} className="saved-discussion">
   <strong>{entry.role==='user'?'我的要求':'助手发言'}</strong>
   {entry.contentState==='available'?<p style={{whiteSpace:'pre-wrap'}}>{entry.text}</p>:<p>相关资料已失效，内容已撤下。</p>}
  </article>)}
 </section>;
}
