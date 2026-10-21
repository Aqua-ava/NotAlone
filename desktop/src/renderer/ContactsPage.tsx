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
  const allPrivate = sync.report?.syncScope === 'all_private';
  const bindingCount = sync.report?.confirmedBindingCount;
  useEffect(() => {
    if (allPrivate && bindingCount !== undefined) void window.notalone.bindings.refreshSaved().catch(() => {});
  }, [allPrivate, bindingCount]);
  const enabled = sync.phase === 'ready' && !sync.errorCode ? sync.report?.enabled : null;
  const scopeKnown = consent.state.phase === 'ready' && consent.state.knownBindings !== undefined;
  function syncLabel(contactId: string) {
    if (!scopeKnown) return '同步状态待确认';
    if (consent.state.bindings.some((binding) => binding.contactId === contactId)) {
      return enabled === false ? '已授权 · 全部同步已暂停' : enabled === true ? '自动同步已开启' : '已授权 · 总开关状态待确认';
    }
    return consent.state.knownBindings?.some((binding) => binding.contactId === contactId) ? '自动同步未开启' : '仅手动资料';
  }
  function addWechat(contactId?: string) {
    consent.setSelection({}); setTargetContactId(contactId); setAddingWechat(true);
    void consent.refresh();
  }
  async function refreshContacts() {
    await Promise.allSettled([session.refreshContacts(), consent.refreshSaved(), window.notalone.syncControl.refresh()]);
  }
  const selected = state.contacts.find((contact) => contact.contactId === state.selectedContactId);
  return <section className="contacts-panel" aria-label="联系人目录">
    <div className="contacts-toolbar"><div><h2>联系人</h2><p>在这里查看每个人的同步状态，在顶部切换联系人后管理微信关联或手动输入。</p></div><div>
      <button className="button primary" disabled={!!consent.state.busy || state.directoryPhase !== 'ready'} onClick={() => addWechat()}>{allPrivate ? '管理单个微信会话' : '添加微信联系人'}</button>
      <button className="button" disabled={state.directoryPhase === 'unavailable' || state.directoryPhase === 'loading'}
        onClick={() => void refreshContacts()}>刷新联系人</button></div></div>
    {allPrivate && <p className="contacts-note" role="status">现有及以后新增的微信私聊会自动关联，无需逐个添加；已单独停止的会话保持排除。<button className="button" onClick={() => navigate('sync')}>查看同步范围</button></p>}
    {enabled === false && <p className="contacts-note" role="status">所有联系人同步已暂停：总开关已关闭，已有授权仍保留。<button className="button" onClick={() => navigate('sync')}>前往同步设置</button></p>}
    {enabled === true && sync.report?.backgroundPhase === 'degraded' && <p role="alert">自动同步已开启，但后台读取暂时不可用。请到同步设置查看。</p>}
    {addingWechat && <BindingConsentPage contacts={session} consent={consent} navigate={navigate} targetContactId={targetContactId} allPrivate={allPrivate}
      onClose={() => { setAddingWechat(false); consent.setSelection({}); }} />}
    <BindingFeedback consent={consent} />
    {state.directoryPhase === 'loading' && <p className="contacts-note" aria-live="polite">正在读取联系人目录…</p>}
    {state.directoryPhase === 'unavailable' && <div className="contacts-empty"><h3>联系人暂不可用</h3><p>连接本机服务后，确认本次运行的本人身份，再查看联系人。</p></div>}
    {state.directoryPhase === 'owner-unconfigured' && <div className="contacts-empty"><h3>本次运行的本人身份未就绪</h3><p>请在设置中检查本人身份和受控配置，再重新连接。</p>
      <button className="button" onClick={() => navigate('config')}>前往设置</button></div>}
    {state.directoryPhase === 'error' && <p className="contacts-note" role="alert">联系人目录读取失败，请刷新重试。</p>}
    {state.directoryPhase === 'ready' && state.contacts.length === 0 && <div className="contacts-empty"><h3>还没有联系人</h3>
      <p>{allPrivate ? '开启后台同步后会自动关联微信私聊；联系人出现后，可在顶部搜索本次对象。' : '点击“添加微信联系人”，选择真实会话并确认后，再在顶部选择本次对象。'}</p></div>}
    {state.contacts.length > 0 && <div className="contacts-columns"><ul className="contact-list" aria-label="联系人同步状态">
      {state.contacts.map((contact) => <li key={contact.contactId}>
        <div className="contact-row" data-current={state.selectedContactId === contact.contactId}>
          <span className="contact-avatar" aria-hidden="true">{contact.displayName.slice(0, 1)}</span>
          <span className="contact-row-copy"><b>{contact.displayName}</b><small>{contact.messageCount} 条消息</small><small className="contact-sync-status">{syncLabel(contact.contactId)}</small></span>
          <span className="contact-row-choice">{state.selectedContactId === contact.contactId ? '当前联系人' : ''}</span>
        </div></li>)}
    </ul><aside className="contact-summary" aria-label="本次联系人资料摘要">
      <h3>{selected ? selected.displayName : '请在顶部选择联系人'}</h3>
      {selected ? <><dl><div><dt>消息</dt><dd>{selected.messageCount} 条</dd></div></dl>
        <p className="contact-sync-status" role="status">{syncLabel(selected.contactId)}</p>
        <ContactSyncDetails contactId={selected.contactId} consent={consent} onConnect={() => addWechat(selected.contactId)} allPrivate={allPrivate} />
        <p>本次文字和候选对应这位联系人。切换后清空编辑输入，已生成候选与编辑按联系人保留。</p>
        <button className="button primary" onClick={() => { void session.confirmManualContact(selected.contactId).then((confirmed) => { if (confirmed) return window.notalone.openHelper(); }); }}>手动输入本次聊天</button>
        <p>如需从文件补充旧记录，可前往「设置 → 高级 → 从文件导入」。</p></>
        : <p>在顶部选择后，主窗口和输入小窗会同步为同一位联系人。</p>}
    </aside></div>}
    <BindingPrivacyNotice allPrivate={allPrivate} />
    <p className="contacts-note">支持手动输入和单联系人文件导入；本机已配置微信识别时，可在输入小窗恢复微信会话识别。候选由你编辑并亲自发送。</p>
    {session.error && <p className="contacts-note" role="alert">{session.error}</p>}
  </section>;
}
