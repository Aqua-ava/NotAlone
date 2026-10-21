import { FirstFrameError } from './FirstFrameError';
import type { BindingConsentView } from './use-binding-consent';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './bindings.css';

export function BindingPrivacyNotice({ allPrivate = false }: { allPrivate?: boolean }) {
  return <details className="bindings-explanation"><summary>读取范围与隐私说明</summary>
    <p>{allPrivate ? '你已确认同步全部微信私聊。应用会自动发现并关联现有及新增会话；已单独停止的会话不会自动重新加入。' : '只有你明确确认的微信会话才能读取文字；进入联系人页面只查询已保存的关联与授权，点击添加或刷新微信会话后才读取会话名单。'}</p>
    <p>应用运行且总开关开启时，可以在微信不在前台时同步已授权会话。关闭总开关或正常退出会停读；重新开启只在有效授权及基线之后补齐。</p>
    <p>停止某个联系人的同步会撤销该会话的读取授权，已保存的资料仍保留。删除资料需使用独立的来源删除流程。</p>
    <p>前台识别只在本机内存分析微信窗口并识别会话名称，不读取聊天正文，画面不保存、不上传。候选由你修改并亲自发送。</p>
  </details>;
}

export function BindingConsentPage({ contacts, consent, navigate, onClose, targetContactId, allPrivate = false }: {
  contacts: ContactSessionView; consent: BindingConsentView; navigate: (page: ManagerPage) => void;
  onClose(): void; targetContactId?: string; allPrivate?: boolean;
}) {
  const { state, selection, setSelection } = consent;
  const unbound = state.sessions.filter((session) => session.boundContactId === null && !state.bindings.some((binding) => binding.locator === session.locator));
  const title = allPrivate ? '管理单个微信会话' : '添加微信联系人';
  return <section className="bindings-section" aria-label={title}>
    <div className="bindings-toolbar"><h2>{title}</h2><div>
      <button className="button" disabled={!!state.busy || state.phase === 'offline' || state.phase === 'loading'} onClick={() => void consent.refresh()}>刷新微信会话</button>
      <button className="button" disabled={!!state.busy} onClick={onClose}>返回联系人</button>
    </div></div>
    <p>{allPrivate ? '全部私聊已纳入自动同步范围，无需逐个添加。这里用于处理身份冲突，或重新开启你曾单独停止的会话。' : '选择要同步的微信会话，再确认新建联系人或关联已有联系人。没有勾选的会话不会获得授权。'}</p>
    <p>{state.syncEnabled === true ? '总开关已开启：确认后立即允许同步所选会话。' : state.syncEnabled === false ? '总开关已关闭：确认后保留授权，开启总开关才开始同步。' : '总开关状态尚未确认；若已开启，确认后立即允许同步所选会话。'}</p>
    {state.phase === 'ready' && <section aria-label="可添加的微信会话">
      <div className="bindings-toolbar"><h3>{allPrivate ? '待处理或已停止同步的会话' : '可添加的微信会话'}</h3><span>已选 {Object.keys(selection).length} 个</span></div>
      {state.sessionIssue === 'not-requested' ? <p>点击“刷新微信会话”后读取列表，系统可能请求访问微信数据。</p> : unbound.length === 0 && <p>当前没有可添加的微信会话。</p>}
      <div className="binding-session-list">{unbound.map((session) => <div className="binding-row" key={session.locator}>
        <label className="binding-choice"><input type="checkbox" disabled={!!state.busy} aria-label={`选择会话 ${session.locator}`} checked={!!selection[session.locator]}
          onChange={(event) => setSelection((previous) => {
            const next = { ...previous }; if (event.target.checked) next[session.locator] = { displayName: session.displayName, target: targetContactId ?? '' }; else delete next[session.locator]; return next;
          })} /><span><b>{session.displayName}</b><code>{session.locator}</code></span></label>
        <select aria-label={`会话 ${session.locator} 对应联系人`} value={selection[session.locator]?.target ?? ''} disabled={!!state.busy || !selection[session.locator]}
          onChange={(event) => setSelection((previous) => ({ ...previous, [session.locator]: { ...previous[session.locator], target: event.target.value } }))}>
          <option value="" disabled>请选择对应联系人</option><option value="new">新建联系人（使用微信会话名称）</option>
          {contacts.state.contacts.map((contact) => <option key={contact.contactId} value={contact.contactId}>{contact.displayName} · {contact.contactId}</option>)}
        </select>
      </div>)}</div>
      <div className="bindings-submit"><span>同名联系人请核对会话与联系人标识。取消勾选不会撤销已有授权。</span><button className="button primary"
        disabled={!!state.busy || !Object.keys(selection).length || Object.values(selection).some((item) => !item.target)} onClick={() => void consent.confirm()}>确认并授权所选会话</button></div>
    </section>}
    {state.phase === 'unavailable' && <div><h3>微信同步尚未就绪</h3><p>请先完成本人渠道身份与本机微信读取配置。可继续使用手动联系人；已有单联系人文件可从设置中导入。</p><button className="button" onClick={() => navigate('import')}>前往从文件导入</button></div>}
  </section>;
}

export function ContactSyncDetails({ contactId, consent, onConnect, allPrivate = false }: { contactId: string; consent: BindingConsentView; onConnect(): void; allPrivate?: boolean }) {
  const { state, setRevocation } = consent;
  const known = state.knownBindings?.filter((binding) => binding.contactId === contactId) ?? [];
  const active = state.bindings.filter((binding) => binding.contactId === contactId);
  if (state.phase !== 'ready' || !state.knownBindings) return <p>同步状态尚未确认，请刷新联系人后再操作。</p>;
  return <section className="contact-sync-details" aria-label="联系人自动同步"><h3>微信关联与同步</h3>
    {active.length === 0 && <><p>{known.length ? '已停止自动同步，已有资料仍保留。重新开启前请核对微信会话。' : allPrivate ? '尚未发现与这份资料关联的微信账号。全部私聊会按账号自动关联，不会按同名合并资料；需要时可在此核对关联。' : '尚未关联微信，当前资料来自手动输入或文件导入。'}</p>
      {known.map((binding) => <p key={binding.bindingId}>曾关联：{binding.displayName || binding.locator}</p>)}
      <button className="button" disabled={!!state.busy || !state.knownBindings} onClick={onConnect}>{known.length ? '开启自动同步' : allPrivate ? '核对微信关联' : '关联微信并开启同步'}</button></>}
    {active.map((binding) => {
      const session = state.sessions.find((item) => item.locator === binding.locator);
      return <div key={binding.bindingId} className="contact-binding"><p>已关联微信：{binding.displayName || binding.locator}</p>
        <details><summary>核对会话标识</summary><code>{binding.locator}</code><p>联系人标识：{binding.contactId}</p></details>
        {!state.sessionIssue && !session && <p className="binding-warning">当前微信列表没有此会话；授权仍保留，请核对后决定是否停止同步。</p>}
        {session && session.displayName !== binding.displayName && <p className="binding-warning">微信会话已改名为“{session.displayName}”。请停止同步后重新关联，原绑定不会静默改名。</p>}
        <button className="button" disabled={!!state.busy} aria-label={`停止会话 ${binding.locator} 的自动同步`} onClick={() => setRevocation(binding)}>停止自动同步</button>
      </div>;
    })}
  </section>;
}

export function BindingFeedback({ consent }: { consent: BindingConsentView }) {
  const { state, error, readError, retryRead, revocation, setRevocation } = consent;
  return <>
    {state.phase === 'loading' && <p role="status">正在读取联系人同步状态…</p>}
    {state.phase === 'offline' && <p>连接本机服务后查看联系人同步状态。</p>}
    {state.phase === 'unavailable' && <p>微信同步尚未就绪，仍可手动输入或导入资料。</p>}
    {state.phase === 'failed' && <p role="alert">联系人同步状态读取失败，请刷新联系人重试；当前不能确认授权范围。</p>}
    {state.sessionIssue && state.sessionIssue !== 'not-requested' && <p role="alert">微信会话名单暂时无法读取，已保存的授权仍有效；可在联系人详情中停止同步。</p>}
    {revocation && <div className="binding-dialog-backdrop"><section className="binding-dialog" role="dialog" aria-modal="true" aria-label="撤销后台读取授权确认">
      <h2>停止这个微信会话的自动同步？</h2><b>{revocation.displayName || revocation.locator}</b><code>{revocation.locator}</code>
      <p>联系人标识：{revocation.contactId}</p><p>停止会撤销此会话的后台读取授权。等待本轮读取收尾后生效，已保存的聊天和关系资料仍保留。</p>
      {state.errorCode === 'revoke-busy' && <p role="alert">当前同步仍在收尾，尚未撤销授权。请稍后重新确认撤销。</p>}
      {state.errorCode === 'revoke-failed' && <p role="alert">撤销结果尚未确认。请核对当前授权范围后重试。</p>}
      <div className="bindings-submit"><button className="button" disabled={!!state.busy} onClick={() => setRevocation(null)}>取消撤销</button>
        <button className="button primary" disabled={!!state.busy || state.phase !== 'ready'} onClick={() => void consent.revoke()}>确认撤销此会话授权</button></div>
    </section></div>}
    {state.busy === 'confirm' && <p role="status">正在复核会话并确认后台读取授权…</p>}
    {state.busy === 'revoke' && <p role="status">正在等待本轮收尾并撤销授权…</p>}
    {state.notice === 'confirmed' && <p role="status">已确认所选会话的后台读取授权。</p>}
    {state.notice === 'revoked' && <p role="status">已撤销此会话的后台读取授权，历史资料仍保留。</p>}
    {state.errorCode === 'selection-stale' && <p role="alert">会话、名称或联系人归属已变化，请重新核对并选择；已有授权不会被静默修改。</p>}
    {state.errorCode === 'confirmation-failed' && <p role="alert">授权确认未完成。请核对当前已授权范围后重试。</p>}
    {error && <p role="alert">{error}</p>}
    <FirstFrameError message={readError} retry={retryRead} />
  </>;
}
