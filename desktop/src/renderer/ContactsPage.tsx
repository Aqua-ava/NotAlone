import { ContactHistoryCoverage } from './HistoryCoverageStatus';
import { ContactHistoryClear } from './HistoryClearPanel';
import { ContactChatHistory } from './ContactChatHistory';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './contacts.css';
import { useEffect, useState } from 'react';
import type { SyncControlState } from '../shared/sync-control-bridge';
import { useRevisionedSession } from './use-revisioned-session';
import { useBindingConsent } from './use-binding-consent';
import { BindingConsentPage, BindingFeedback, BindingPrivacyNotice, ContactSyncDetails } from './BindingConsentPage';

const initialSync: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };

export function ContactsPage({ session, navigate }: { session: ContactSessionView; navigate: (page: ManagerPage) => void }) {
  const { state } = session;
  const [addingWechat, setAddingWechat] = useState(false), [targetContactId, setTargetContactId] = useState<string>();
  const consent = useBindingConsent(session);
  const { state: sync } = useRevisionedSession(initialSync, window.notalone.syncControl);
  useEffect(() => {
    void window.notalone.bindings.refreshSaved().catch(() => {});
    void window.notalone.syncControl.refresh().catch(() => {});
  }, []);
  const selectionOnly = consent.state.selectionOnly === true;
  const allPrivate = !selectionOnly && sync.report?.syncScope === 'all_private';
  const bindingCount = sync.report?.confirmedBindingCount;
  useEffect(() => {
    if (allPrivate && bindingCount !== undefined) void window.notalone.bindings.refreshSaved().catch(() => {});
  }, [allPrivate, bindingCount]);
  const enabled = sync.phase === 'ready' && !sync.errorCode ? sync.report?.enabled : null;
  const scopeKnown = consent.state.phase === 'ready' && consent.state.knownBindings !== undefined;
  function syncLabel(contactId: string) {
    if (!scopeKnown) return '同步状态待确认';
    if (consent.state.bindings.some((binding) => binding.contactId === contactId)) {
      if (enabled === false) return '已授权 · 全部同步已暂停';
      if (selectionOnly && sync.report?.bodyAvailable === false) return '已授权 · 等待读取能力核验';
      return enabled === true ? '自动同步已开启' : '已授权 · 总开关状态待确认';
    }
    return consent.state.knownBindings?.some((binding) => binding.contactId === contactId) ? '自动同步未开启' : '仅手动资料';
  }
  function addWechat(contactId?: string) {
    consent.setSelection({}); setTargetContactId(contactId); setAddingWechat(true);
  }
  async function refreshContacts() {
    await Promise.allSettled([session.refreshContacts(), consent.refreshSaved(), window.notalone.syncControl.refresh()]);
  }
  const selected = state.contacts.find((contact) => contact.contactId === state.selectedContactId);
  const visibleContacts = selected ? [selected, ...state.contacts.filter(contact => contact.contactId !== selected.contactId)] : state.contacts;
  return <section className="contacts-panel" aria-label="联系人目录">
    <div className="contacts-toolbar"><div><h2>联系人</h2><p>在顶部切换联系人，查看聊天记录与同步状态。</p></div><div>
      <button className="button primary" disabled={!!consent.state.busy || state.directoryPhase !== 'ready'} onClick={() => addWechat()}>{allPrivate ? '管理单个微信会话' : '添加微信联系人'}</button>
      <button className="button" disabled={state.directoryPhase === 'unavailable' || state.directoryPhase === 'loading'}
        onClick={() => void refreshContacts()}>刷新联系人</button></div></div>
    {allPrivate && <p className="contacts-note" role="status">现有及以后新增的微信私聊会自动关联，无需逐个添加；已单独停止的会话保持排除。<button className="button" onClick={() => navigate('sync')}>查看同步范围</button></p>}
    {enabled === false && <p className="contacts-note" role="status">所有联系人同步已暂停：总开关已关闭，已有授权仍保留。<button className="button" onClick={() => navigate('sync')}>前往同步设置</button></p>}
    {enabled === true && sync.report?.backgroundPhase === 'degraded' && <p className="contacts-note" role="alert">{sync.report.bodyAvailable === true
      ? '部分消息或会话待核验。'
      : '后台读取暂不可用。'}<button className="button" onClick={() => navigate('sync')}>查看同步详情</button></p>}
    {addingWechat && <BindingConsentPage contacts={session} consent={consent} navigate={navigate} targetContactId={targetContactId} allPrivate={allPrivate}
      onClose={() => { setAddingWechat(false); consent.setSelection({}); }} />}
    <BindingFeedback consent={consent} />
    {state.directoryPhase === 'loading' && <p className="contacts-note" aria-live="polite">正在读取联系人目录…</p>}
    {state.directoryPhase === 'unavailable' && <div className="contacts-empty"><h3>联系人暂不可用</h3><p>连接本机服务后，确认本次运行的本人身份，再查看联系人。</p></div>}
    {state.directoryPhase === 'owner-unconfigured' && <div className="contacts-empty"><h3>本次运行的本人身份未就绪</h3><p>请在设置中检查本人身份和受控配置，再重新连接。</p>
      <button className="button" onClick={() => navigate('config')}>前往设置</button></div>}
    {state.directoryPhase === 'error' && <p className="contacts-note" role="alert">联系人目录读取失败，请刷新重试。</p>}
    {state.directoryPhase === 'ready' && state.contacts.length === 0 && <div className="contacts-empty"><h3>还没有联系人</h3>
      <p>{selectionOnly ? '逐人确认微信私聊后加入联系人；未选中的会话和以后新增的私聊不会获得读取授权。' : allPrivate ? '开启后台同步后会自动关联微信私聊；联系人出现后，可在顶部搜索本次对象。' : '首次使用可到同步设置连接微信，默认仅同步你选择并确认的私聊；也可以明确选择全部私聊。'}</p><button className="button primary" onClick={() => navigate('sync')}>前往同步设置连接微信</button></div>}
    {state.contacts.length > 0 && <div className="contacts-columns"><ul className="contact-list" aria-label="联系人同步状态">
      {visibleContacts.map((contact) => <li key={contact.contactId} className="contact-card" data-current={state.selectedContactId === contact.contactId}>
        <div className="contact-row">
          <span className="contact-avatar" aria-hidden="true">{Array.from(contact.displayName)[0]}</span>
          <div className="contact-row-copy"><div className="contact-row-name"><b>{contact.displayName}</b>
            {state.selectedContactId === contact.contactId && <span className="contact-row-choice">当前</span>}</div>
            <small>{contact.messageCount} 条消息</small><small className="contact-sync-status">{syncLabel(contact.contactId)}</small>
            <ContactHistoryCoverage compact coverages={sync.report?.historyCoverages} contactId={contact.contactId} bodyAvailable={sync.report?.bodyAvailable} />
          </div>
        </div>
        {selected?.contactId === contact.contactId && <details className="contact-management">
          <summary>同步与资料管理</summary>
          <ContactHistoryCoverage coverages={sync.report?.historyCoverages} contactId={selected.contactId} bodyAvailable={sync.report?.bodyAvailable} />
          <ContactSyncDetails contactId={selected.contactId} consent={consent} onConnect={() => addWechat(selected.contactId)} allPrivate={allPrivate} />
          <ContactHistoryClear session={session} />
          <button className="button" onClick={() => navigate('memory')}>查看关系资料</button>
          <button className="button primary" onClick={() => { void session.confirmManualContact(selected.contactId).then((confirmed) => { if (confirmed) return window.notalone.openHelper(); }); }}>手动输入本次聊天</button>
        </details>}
      </li>)}
    </ul><ContactChatHistory session={session} /></div>}
    <BindingPrivacyNotice allPrivate={allPrivate} selectionOnly={selectionOnly} />
    <p className="contacts-note">{selectionOnly ? '联系人身份和微信读取授权分别核验；手动输入只确认本次资料归属，不建立微信身份或授予读取。候选由你编辑并亲自发送。' : '支持手动输入和单联系人文件导入；本机已配置微信识别时，可在输入小窗恢复微信会话识别。候选由你编辑并亲自发送。'}</p>
    {session.error && <p className="contacts-note" role="alert">{session.error}</p>}
  </section>;
}
