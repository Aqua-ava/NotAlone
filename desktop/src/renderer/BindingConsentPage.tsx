import { FirstFrameError } from './FirstFrameError';
import type { BindingConsentView } from './use-binding-consent';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './bindings.css';

export function BindingPrivacyNotice({ allPrivate = false, selectionOnly = false }: { allPrivate?: boolean; selectionOnly?: boolean }) {
  return <details className="bindings-explanation"><summary>读取范围与隐私说明</summary>
    <p>{selectionOnly ? '只有你逐人明确确认的微信私聊才能读取文字；进入联系人页面只查询已保存的关联与授权，添加页面中明确点击刷新微信会话后才读取会话名单。新私聊不会自动加入。' : allPrivate ? '你已确认同步全部微信私聊。应用会自动发现并关联现有及新增会话；已单独停止的会话不会自动重新加入。' : '只有你明确确认的微信会话才能读取文字；进入联系人页面只查询已保存的关联与授权，添加页面中明确点击刷新微信会话后才读取会话名单。'}</p>
    <p>应用运行且总开关开启时，可以在微信不在前台时同步已授权会话。关闭总开关或正常退出会停读；重新开启后按检查点继续。{selectionOnly ? '确认所选会话包含读取它在本机可读的历史文字，再持续同步新消息。非文字消息只保留占位，不自动下载媒体。' : '新绑定默认仅从本次绑定起同步；读取更早历史需要独立明确授权。'}</p>
    <p>{selectionOnly ? '停止某个联系人的同步会立即撤销新读取、记忆处理和本地媒体转换资格，已保存的资料仍保留。重新选择不会恢复旧请求，也不会解除已清空资料的排除。删除资料需单独操作。' : '停止某个联系人的同步会撤销该会话的读取授权，已保存的资料仍保留。删除资料需使用独立的来源删除流程。'}</p>
    <p>前台识别只在本机内存分析微信窗口并识别会话名称，不读取聊天正文，画面不保存、不上传。候选由你修改并亲自发送。</p>
  </details>;
}

export function BindingConsentPage({ contacts, consent, navigate, onClose, targetContactId, allPrivate = false }: {
  contacts: ContactSessionView; consent: BindingConsentView; navigate: (page: ManagerPage) => void;
  onClose(): void; targetContactId?: string; allPrivate?: boolean;
}) {
  const { state, selection, setSelection } = consent;
  const selectionOnly = state.selectionOnly === true;
  const allPrivateMode = allPrivate && !selectionOnly;
  const unbound = state.sessions.filter((session) => session.boundContactId === null && !state.bindings.some((binding) => binding.locator === session.locator));
  const title = allPrivateMode ? '管理单个微信会话' : '添加微信联系人';
  return <section className="bindings-section" aria-label={title}>
    <div className="bindings-toolbar"><h2>{title}</h2><div>
      <button className="button" disabled={!!state.busy || state.phase === 'offline' || state.phase === 'loading'} onClick={() => void consent.refresh()}>刷新微信会话</button>
      <button className="button" disabled={!!state.busy} onClick={onClose}>返回联系人</button>
    </div></div>
    <p>{selectionOnly ? '选择要同步的微信私聊，再核对渠道身份并确认加入联系人。没有勾选的会话不会获得授权，新私聊不会自动加入。' : allPrivateMode ? '全部私聊已纳入自动同步范围，无需逐个添加。这里用于处理身份冲突，或重新开启你曾单独停止的会话。' : '选择要同步的微信会话，再确认新建联系人或关联已有联系人。没有勾选的会话不会获得授权。'}</p>
    <p>{selectionOnly
      ? state.syncEnabled === true ? '总开关已开启：确认后允许读取所选会话的本机历史文字，再持续同步新消息。' : state.syncEnabled === false ? '总开关已关闭：确认后保留授权，开启总开关后才开始读取所选会话。' : '总开关状态尚未确认；核验身份、确认所选会话并开启后才允许读取。'
      : state.syncEnabled === true ? '总开关已开启：确认后允许所选会话从本次绑定起持续同步新消息。' : state.syncEnabled === false ? '总开关已关闭：确认后保留授权，开启总开关后从本次绑定起同步。' : '总开关状态尚未确认；确认绑定并开启后，从本次绑定起同步。'}</p>
    <p>点击“刷新微信会话”表示同意读取当前微信账号的会话列表，以便核对并选择联系人；列表附带的消息摘要会立即丢弃，不保存或用于回复。此操作不授权读取聊天正文。</p>
    <p>{selectionOnly ? '确认后允许读取本次所选会话在本机可读的历史文字和后续新消息；非文字消息只保留占位，不自动下载媒体。' : '更早的历史消息需独立确认；本次历史选择仅覆盖本次所选会话，后续新增会话不会继承。已有明确历史授权仍按其原范围执行。'}</p>
    {state.phase === 'ready' && <section aria-label="可添加的微信会话">
      <div className="bindings-toolbar"><h3>{allPrivateMode ? '待处理或已停止同步的会话' : '可添加的微信会话'}</h3><span>已选 {Object.keys(selection).length} 个</span></div>
      {state.sessionIssue === 'not-requested' ? <p>点击“刷新微信会话”后读取列表，系统可能请求访问微信数据。</p> : unbound.length === 0 && <p>当前没有可添加的微信会话。</p>}
      <div className="binding-session-list">{unbound.map((session) => <div className="binding-row" key={session.locator}>
        <label className="binding-choice"><input type="checkbox" disabled={!!state.busy} aria-label={`选择会话 ${session.locator}`} checked={!!selection[session.locator]}
          onChange={(event) => setSelection((previous) => {
            const next = { ...previous }; if (event.target.checked) next[session.locator] = { displayName: session.displayName, target: targetContactId ?? '' }; else delete next[session.locator]; return next;
          })} /><span><b>{session.displayName}</b><code>{session.locator}</code></span></label>
        <select aria-label={`会话 ${session.locator} 对应联系人`} value={selection[session.locator]?.target ?? ''} disabled={!!state.busy || !selection[session.locator]}
          onChange={(event) => setSelection((previous) => ({ ...previous, [session.locator]: { ...previous[session.locator], target: event.target.value } }))}>
          <option value="" disabled>请选择对应联系人</option><option value="new">{selectionOnly ? '从此微信身份加入联系人' : '新建联系人（使用微信会话名称）'}</option>
          {contacts.state.contacts.map((contact) => <option key={contact.contactId} value={contact.contactId}>{contact.displayName} · {contact.contactId}</option>)}
        </select>
      </div>)}</div>
      {!selectionOnly && <><label><input type="checkbox" checked={consent.historyAuthorized ?? false} disabled={!!state.busy || !Object.keys(selection).length}
        onChange={event => consent.setHistoryAuthorized(event.target.checked)} />同时读取本次所选会话在本机可用的历史消息</label>
      <p>默认不读取绑定以前的历史。更改所选会话、对应联系人或刷新列表后，需要重新勾选历史授权。</p></>}
      <div className="bindings-submit"><span>{selectionOnly ? '同名联系人请核对稳定会话与联系人标识；停止已有同步请在联系人详情中撤销授权。' : '同名联系人请核对会话与联系人标识。取消勾选不会撤销已有授权。'}</span><button className="button primary"
        disabled={!!state.busy || !Object.keys(selection).length || Object.values(selection).some((item) => !item.target)} onClick={() => void consent.confirm()}>确认并授权所选会话</button></div>
    </section>}
    {state.phase === 'unavailable' && <div><h3>微信同步尚未就绪</h3>{selectionOnly ? <p>当前无法核验微信账号或会话身份，尚不能读取聊天正文。请核对已有微信读取组件与账号状态后重试。</p> : <><p>请先完成本人渠道身份与本机微信读取配置。可继续使用手动联系人；手动文件导入入口已退役。</p></>}</div>}
  </section>;
}

export function ContactSyncDetails({ contactId, consent, onConnect, allPrivate = false }: { contactId: string; consent: BindingConsentView; onConnect(): void; allPrivate?: boolean }) {
  const { state, setRevocation } = consent;
  const selectionOnly = state.selectionOnly === true;
  const allPrivateMode = allPrivate && !selectionOnly;
  const known = state.knownBindings?.filter((binding) => binding.contactId === contactId) ?? [];
  const active = state.bindings.filter((binding) => binding.contactId === contactId);
  if (state.phase !== 'ready' || !state.knownBindings) return <p>同步状态尚未确认，请刷新联系人后再操作。</p>;
  return <section className="contact-sync-details" aria-label="联系人自动同步"><h3>微信关联与同步</h3>
    {active.length === 0 && <><p>{known.length ? '已停止自动同步，已有资料仍保留。重新开启前请核对微信会话。' : selectionOnly ? '尚未核验这位联系人的微信身份。请明确选择对应私聊；同名不会自动合并。' : allPrivateMode ? '尚未发现与这份资料关联的微信账号。全部私聊会按账号自动关联，不会按同名合并资料；需要时可在此核对关联。' : '尚未关联微信，当前资料来自手动输入或文件导入。'}</p>
      {known.map((binding) => <p key={binding.bindingId}>曾关联：{binding.displayName || binding.locator}</p>)}
      <button className="button" disabled={!!state.busy || !state.knownBindings} onClick={onConnect}>{known.length ? '开启自动同步' : selectionOnly ? '核对微信关联并授权' : allPrivateMode ? '核对微信关联' : '关联微信并开启同步'}</button></>}
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
  const selectionOnly = state.selectionOnly === true;
  return <>
    {state.phase === 'loading' && <p role="status">正在读取联系人同步状态…</p>}
    {state.phase === 'offline' && <p>连接本机服务后查看联系人同步状态。</p>}
    {state.phase === 'unavailable' && <p>{selectionOnly ? '微信账号或会话身份尚未核验，当前不能读取对应正文。' : '微信同步尚未就绪，仍可手动输入或导入资料。'}</p>}
    {state.phase === 'failed' && <p role="alert">联系人同步状态读取失败，请刷新联系人重试；当前不能确认授权范围。</p>}
    {state.sessionIssue && state.sessionIssue !== 'not-requested' && <p role="alert">{selectionOnly ? '微信会话名单暂时无法核验，不能据此确认当前读取资格；可在联系人详情中停止同步。' : '微信会话名单暂时无法读取，已保存的授权仍有效；可在联系人详情中停止同步。'}</p>}
    {revocation && <div className="binding-dialog-backdrop"><section className="binding-dialog" role="dialog" aria-modal="true" aria-label="撤销后台读取授权确认">
      <h2>停止这个微信会话的自动同步？</h2><b>{revocation.displayName || revocation.locator}</b><code>{revocation.locator}</code>
      <p>联系人标识：{revocation.contactId}</p><p>{selectionOnly ? '确认后立即撤销此联系人的新读取、记忆处理和本地媒体转换资格；旧请求即使迟到也不能提交。已合法保存的聊天和关系资料仍保留。' : '停止会撤销此会话的后台读取授权。等待本轮读取收尾后生效，已保存的聊天和关系资料仍保留。'}</p>
      {state.errorCode === 'revoke-busy' && <p role="alert">{selectionOnly ? '撤销结果尚未确认，请刷新授权范围后重试。' : '当前同步仍在收尾，尚未撤销授权。请稍后重新确认撤销。'}</p>}
      {state.errorCode === 'revoke-failed' && <p role="alert">撤销结果尚未确认。请核对当前授权范围后重试。</p>}
      <div className="bindings-submit"><button className="button" disabled={!!state.busy} onClick={() => setRevocation(null)}>取消撤销</button>
        <button className="button primary" disabled={!!state.busy || state.phase !== 'ready'} onClick={() => void consent.revoke()}>确认撤销此会话授权</button></div>
    </section></div>}
    {state.busy === 'confirm' && <p role="status">正在复核会话并确认后台读取授权…</p>}
    {state.busy === 'revoke' && <p role="status">{selectionOnly ? '正在撤销此联系人的处理资格…' : '正在等待本轮收尾并撤销授权…'}</p>}
    {state.notice === 'confirmed' && <p role="status">已确认所选会话的后台读取授权。</p>}
    {state.notice === 'revoked' && <p role="status">{selectionOnly ? '已撤销此联系人的读取与处理资格，已有资料仍保留。' : '已撤销此会话的后台读取授权，历史资料仍保留。'}</p>}
    {state.errorCode === 'selection-stale' && <p role="alert">会话、名称或联系人归属已变化，请重新核对并选择；已有授权不会被静默修改。</p>}
    {state.errorCode === 'confirmation-failed' && <p role="alert">授权确认未完成。请核对当前已授权范围后重试。</p>}
    {error && <p role="alert">{error}</p>}
    <FirstFrameError message={readError} retry={retryRead} />
  </>;
}
