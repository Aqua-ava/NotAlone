import { useEffect, useRef, useState } from 'react';
import type { BindingConsentState, BindingSummary } from '../shared/binding-consent-bridge';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './bindings.css';

const initial: BindingConsentState = { revision: -1, scopeRevision: 0, phase: 'offline',
  sessions: [], bindings: [], syncEnabled: null, sessionIssue: null, busy: null, errorCode: null, notice: null };
type Selection = { displayName: string; target: string };

export function BindingConsentPage({ contacts, navigate }: { contacts: ContactSessionView; navigate: (page: ManagerPage) => void }) {
  const [state, setState] = useState(initial);
  const latest = useRef(initial);
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [error, setError] = useState('');
  const [revocation, setRevocation] = useState<BindingSummary | null>(null);
  useEffect(() => {
    let active = true;
    const receive = (next: BindingConsentState) => {
      if (!active || next.revision < latest.current.revision) return;
      if (next.scopeRevision !== latest.current.scopeRevision) { setSelection({}); setRevocation(null); setError(''); }
      latest.current = next; setState(next);
    };
    const unsubscribe = window.notalone.bindings.onStateChanged(receive);
    void window.notalone.bindings.getState().then(receive).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (state.phase !== 'ready') return;
    setSelection((previous) => Object.fromEntries(Object.entries(previous).filter(([locator, item]) =>
      state.sessions.some((session) => session.locator === locator && session.displayName === item.displayName && session.boundContactId === null)
      && !state.bindings.some((binding) => binding.locator === locator)
      && (!item.target || item.target === 'new' || contacts.state.contacts.some((contact) => contact.contactId === item.target)))));
  }, [state, contacts.state.contacts]);
  async function refresh() {
    try { await window.notalone.bindings.refresh(); setError(''); }
    catch { setError('会话与授权暂时无法刷新，请重试。'); }
  }
  async function confirm() {
    const scopeRevision = state.scopeRevision;
    try {
      await window.notalone.bindings.confirmSelections({ scopeRevision, selections: Object.entries(selection).map(([locator, item]) =>
        ({ locator, displayName: item.displayName, contactId: item.target === 'new' ? null : item.target })) });
      if (scopeRevision === latest.current.scopeRevision) setError('');
    } catch { if (scopeRevision === latest.current.scopeRevision) setError('本次授权选择已失效，请刷新后重新确认。'); }
  }
  async function revoke() {
    if (!revocation) return;
    const scopeRevision = state.scopeRevision;
    try { await window.notalone.bindings.revokeBinding({ scopeRevision, contactId: revocation.contactId, bindingId: revocation.bindingId }); }
    catch { if (scopeRevision === latest.current.scopeRevision) setError('撤销结果尚未确认，请刷新授权范围后重试。'); }
  }
  const available = state.phase === 'ready';
  const unbound = state.sessions.filter((session) => session.boundContactId === null && !state.bindings.some((binding) => binding.locator === session.locator));
  return <div className="bindings-page">
    <section className="bindings-explanation" aria-label="后台读取授权说明">
      <div className="bindings-toolbar"><h2>由你确认后台读取范围</h2><button className="button" disabled={!!state.busy || state.phase === 'offline' || state.phase === 'loading'} onClick={() => void refresh()}>刷新会话与授权</button></div>
      <p>这里只查看一对一会话元数据。勾选会话、核对对应联系人并最终确认后，才授予该会话的后台文字读取权限。</p>
      <p>{state.syncEnabled === true ? '当前总开关已开启：新确认范围会立即允许后台读取。' : state.syncEnabled === false ? '当前总开关已关闭：确认只追加授权，开启总开关后才读取正文。' : '当前总开关状态未确认；若它已开启，新确认范围会立即允许后台读取。'}</p>
      <p>应用运行且总开关开启时，可在微信不在前台时读取已确认范围。关闭同步或正常退出会停读；重新开启只在有效授权及基线之后补齐。前台定位需屏幕录制权限，在本机内存分析当前微信窗口布局，仅识别会话名称；画面不保存、不上传，不识别聊天正文。候选由你修改并亲自发送。</p>
      <p>取消勾选只改变本次未提交选择。撤销后台读取授权须另行明确操作；已有历史资料仍保留，清除来源使用独立删除流程。</p>
    </section>
    {state.phase === 'loading' && <p role="status">正在读取会话与授权…</p>}
    {state.phase === 'offline' && <p>连接本机服务后查看会话和已授权范围。</p>}
    {state.phase === 'owner-unconfigured' && <div className="bindings-explanation"><p>本次运行的本人身份未就绪，请检查受控配置。</p><button className="button" onClick={() => navigate('config')}>前往设置</button></div>}
    {state.phase === 'unavailable' && <div className="bindings-explanation"><h3>同步宿主尚未就绪</h3><p>本人渠道身份缺失时，请先确认一份含本人身份的单联系人历史导入，正常退出并重新打开 App，再配置已安装的只读 CLI。导入不会自动授权会话正文读取。</p><button className="button" onClick={() => navigate('import')}>前往从文件导入</button></div>}
    {state.phase === 'failed' && <p role="alert">会话与授权读取失败，请刷新重试。当前范围无法确认，暂不能提交授权变更。</p>}
    {state.sessionIssue && state.sessionIssue !== 'not-requested' && <p role="alert">无法取得当前 CLI 会话元数据，请检查已安装的只读 CLI 后刷新。已有授权如下显示，仍可明确撤销。</p>}
    {available && <>
      <section className="bindings-section" aria-label="待授权会话"><div className="bindings-toolbar"><h2>待授权会话</h2><span>已选 {Object.keys(selection).length} 个</span></div>
        {state.sessionIssue === 'not-requested' ? <p>尚未读取微信会话。点击“刷新会话与授权”后读取列表，系统可能请求访问微信数据。</p> : unbound.length === 0 && <p>当前没有可新增授权的会话。</p>}
        {unbound.map((session) => <div className="binding-row" key={session.locator}>
          <label className="binding-choice"><input type="checkbox" disabled={!!state.busy} aria-label={`选择会话 ${session.locator}`} checked={!!selection[session.locator]}
            onChange={(event) => setSelection((previous) => {
              const next = { ...previous }; if (event.target.checked) next[session.locator] = { displayName: session.displayName, target: '' }; else delete next[session.locator]; return next;
            })} /><span><b>{session.displayName}</b><code>{session.locator}</code></span></label>
          <select aria-label={`会话 ${session.locator} 对应联系人`} value={selection[session.locator]?.target ?? ''} disabled={!!state.busy || !selection[session.locator]}
            onChange={(event) => setSelection((previous) => ({ ...previous, [session.locator]: { ...previous[session.locator], target: event.target.value } }))}>
            <option value="" disabled>请明确选择对应联系人</option><option value="new">新建联系人（使用本次会话显示名）</option>
            {contacts.state.contacts.map((contact) => <option key={contact.contactId} value={contact.contactId}>{contact.displayName} · {contact.contactId}</option>)}
          </select>
        </div>)}
        <div className="bindings-submit"><span>名称只用于展示，请核对稳定会话标识与联系人标识。</span><button className="button primary"
          disabled={!!state.busy || !Object.keys(selection).length || Object.values(selection).some((item) => !item.target)} onClick={() => void confirm()}>确认并授权所选会话</button></div>
      </section>
      <section className="bindings-section" aria-label="已授权会话"><h2>已授权会话</h2>
        {state.bindings.length === 0 && <p>尚未授权任何会话。</p>}
        {state.bindings.map((binding) => {
          const session = state.sessions.find((item) => item.locator === binding.locator);
          return <div className="binding-row authorized" key={binding.bindingId}>
            <div><b>{binding.displayName || binding.locator}</b><code>{binding.locator}</code>
              <p>联系人：{contacts.state.contacts.find((contact) => contact.contactId === binding.contactId)?.displayName ?? '当前目录未显示'} · {binding.contactId}</p>
              <small>有效授权 · {binding.bindingId}</small>
              {!state.sessionIssue && !session && <p className="binding-warning">当前 CLI 列表已无此会话，授权仍有效；请核对并明确撤销，重新出现后再确认。</p>}
              {session && session.displayName !== binding.displayName && <p className="binding-warning">会话显示名已变为“{session.displayName}”，不会静默更新绑定。请明确撤销后重新核对并确认。</p>}
            </div><button className="button" disabled={!!state.busy} aria-label={`撤销会话 ${binding.locator} 的后台读取授权`}
              onClick={() => { setRevocation(binding); setError(''); }}>撤销后台读取授权</button>
          </div>;
        })}
      </section>
    </>}
    {revocation && <div className="binding-dialog-backdrop"><section className="binding-dialog" role="dialog" aria-modal="true" aria-label="撤销后台读取授权确认">
      <h2>确认撤销这一个会话的后台读取授权？</h2><b>{revocation.displayName || revocation.locator}</b><code>{revocation.locator}</code>
      <p>联系人标识：{revocation.contactId}</p><p>等待当前一轮读取收尾后撤销；成功响应后不再新增此会话的正文读取。已经读取的历史资料与绑定记录保留，清除来源请使用独立删除流程。</p>
      {state.errorCode === 'revoke-busy' && <p role="alert">当前同步仍在收尾，尚未撤销授权。请稍后重新确认撤销。</p>}
      {state.errorCode === 'revoke-failed' && <p role="alert">撤销结果尚未确认。请核对当前授权范围后重试。</p>}
      <div className="bindings-submit"><button className="button" disabled={!!state.busy} onClick={() => setRevocation(null)}>取消撤销</button>
        <button className="button primary" disabled={!!state.busy || state.phase !== 'ready'} onClick={() => void revoke()}>确认撤销此会话授权</button></div>
    </section></div>}
    {state.busy === 'confirm' && <p role="status">正在复核会话并确认后台读取授权…</p>}
    {state.busy === 'revoke' && <p role="status">正在等待本轮收尾并撤销授权…</p>}
    {state.notice === 'confirmed' && <p role="status">已确认所选会话的后台读取授权。</p>}
    {state.notice === 'revoked' && <p role="status">已撤销此会话的后台读取授权，历史资料仍保留。</p>}
    {state.errorCode === 'selection-stale' && <p role="alert">会话、名称或联系人归属已变化，请重新核对并选择；已有授权不会被静默修改。</p>}
    {state.errorCode === 'confirmation-failed' && <p role="alert">授权确认未完成。请核对当前已授权范围后重试。</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
