import { ContactHistoryClear } from './HistoryClearPanel';
import { ContactChatHistory } from './ContactChatHistory';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './contacts.css';
import { useEffect, useState } from 'react';
import type { SyncControlState } from '../shared/sync-control-bridge';
import { useRevisionedSession } from './use-revisioned-session';
import { useBindingConsent } from './use-binding-consent';
import { BindingConsentPage, BindingFeedback } from './BindingConsentPage';
import { ContactDeletionMenu, ContactDeletionStatus, useContactDeletion } from './ContactDeletionPanel';

const initialSync: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };

export function ContactsPage({ session, navigate, initialSelection = false, onSelectionClosed }: { session: ContactSessionView; navigate: (page: ManagerPage) => void; initialSelection?: boolean; onSelectionClosed?: () => void }) {
  const { state } = session;
  const deletionBridge = window.notalone.contactDeletion;
  const deletion = useContactDeletion(deletionBridge);
  const [addingWechat, setAddingWechat] = useState(initialSelection), [targetContactId, setTargetContactId] = useState<string>();
  const [startSync, setStartSync] = useState(initialSelection);
  const consent = useBindingConsent(session);
  const { state: sync } = useRevisionedSession(initialSync, window.notalone.syncControl);
  useEffect(() => {
    // 仅本次账号确认已明确同意读取名单；普通进入目录仍只读保存状态。
    void (initialSelection ? consent.refresh() : window.notalone.bindings.refreshSaved()).catch(() => {});
    void window.notalone.syncControl.refresh().catch(() => {});
  }, []);
  const selectionOnly = consent.state.selectionOnly === true;
  const allPrivate = !selectionOnly && sync.report?.syncScope === 'all_private';
  const bindingCount = sync.report?.confirmedBindingCount;
  useEffect(() => {
    if (allPrivate && bindingCount !== undefined) void window.notalone.bindings.refreshSaved().catch(() => {});
  }, [allPrivate, bindingCount]);
  const enabled = sync.phase === 'ready' && !sync.errorCode ? sync.report?.enabled : null;
  function addWechat(contactId?: string) {
    consent.setSelection({}); setTargetContactId(contactId); setStartSync(false); setAddingWechat(true);
  }
  function closeSelection() {
    setAddingWechat(false); setStartSync(false); consent.setSelection({}); onSelectionClosed?.();
    void window.notalone.syncControl.refresh().catch(() => {});
  }
  async function refreshContacts() {
    await Promise.allSettled([session.refreshContacts(), consent.refreshSaved(), window.notalone.syncControl.refresh()]);
  }
  const selected = state.contacts.find((contact) => contact.contactId === state.selectedContactId);
  const visibleContacts = selected ? [selected, ...state.contacts.filter(contact => contact.contactId !== selected.contactId)] : state.contacts;
  if (addingWechat) return <section className="contacts-panel" aria-label="联系人目录">
    {deletionBridge && <ContactDeletionStatus bridge={deletionBridge} state={deletion.state} />}
    <BindingConsentPage contacts={session} consent={consent} navigate={navigate} targetContactId={targetContactId} allPrivate={allPrivate}
      startSync={startSync} onClose={closeSelection} />
    <BindingFeedback consent={consent} />
  </section>;
  return <section className="contacts-panel" aria-label="联系人目录">
    {deletionBridge && <ContactDeletionStatus bridge={deletionBridge} state={deletion.state} />}
    <div className="contacts-toolbar"><div><h2>联系人</h2><p>在顶部切换联系人，查看聊天记录与资料。</p></div><div>
      <button className="button primary" disabled={!!consent.state.busy || state.directoryPhase !== 'ready'} onClick={() => addWechat()}>{allPrivate ? '管理单个微信会话' : '添加微信联系人'}</button>
      <button className="button" disabled={state.directoryPhase === 'unavailable' || state.directoryPhase === 'loading'}
        onClick={() => void refreshContacts()}>刷新联系人</button></div></div>
    {allPrivate && <p className="contacts-note" role="status">现有及以后新增的微信私聊会自动关联，无需逐个添加；已单独停止的会话保持排除。<button className="button" onClick={() => navigate('sync')}>查看同步范围</button></p>}
    {enabled === false && <p className="contacts-note" role="status">所有联系人同步已暂停：总开关已关闭，已有授权仍保留。<button className="button" onClick={() => navigate('sync')}>前往同步设置</button></p>}
    <BindingFeedback consent={consent} />
    {state.directoryPhase === 'loading' && <p className="contacts-note" aria-live="polite">正在读取联系人目录…</p>}
    {state.directoryPhase === 'unavailable' && <div className="contacts-empty"><h3>联系人暂不可用</h3><p>连接本机服务后，确认本次运行的本人身份，再查看联系人。</p></div>}
    {state.directoryPhase === 'owner-unconfigured' && <div className="contacts-empty"><h3>本次运行的本人身份未就绪</h3><p>请在设置中检查本人身份和受控配置，再重新连接。</p>
      <button className="button" onClick={() => navigate('config')}>前往设置</button></div>}
    {state.directoryPhase === 'error' && <p className="contacts-note" role="alert">联系人目录读取失败，请刷新重试。</p>}
    {state.directoryPhase === 'ready' && state.contacts.length === 0 && <div className="contacts-empty"><h3>还没有联系人</h3>
      <p>{selectionOnly ? '逐人确认微信私聊后加入联系人；未选中的会话和以后新增的私聊不会获得读取授权。' : allPrivate ? '开启后台同步后会自动关联微信私聊；联系人出现后，可在顶部搜索本次对象。' : '首次使用可到同步设置连接微信，默认仅同步你选择并确认的私聊；也可以明确选择全部私聊。'}</p><button className="button primary" onClick={() => navigate('sync')}>前往同步设置连接微信</button></div>}
    {state.contacts.length > 0 && <div className="contacts-columns"><ul className="contact-list" aria-label="联系人列表">
      {visibleContacts.map((contact) => <li key={contact.contactId} className="contact-card" data-current={state.selectedContactId === contact.contactId}>
        <div className="contact-row">
          <span className="contact-avatar" aria-hidden="true">{Array.from(contact.displayName)[0]}</span>
          <div className="contact-row-copy"><div className="contact-row-name"><b>{contact.displayName}</b>
            {state.selectedContactId === contact.contactId && <span className="contact-row-choice">当前</span>}</div>
            <small>{contact.messageCount} 条消息</small>
          </div>
        </div>
      </li>)}
    </ul><ContactChatHistory session={session} contactActions={selected && deletionBridge && <ContactDeletionMenu
      bridge={deletionBridge} state={deletion.state} selected={selected} contacts={state.contacts} scopeRevision={state.scopeRevision} inline />}
      settings={selected && <>
      <ContactHistoryClear session={session} />
      <div className="contact-management-shortcuts">
        <button className="button" onClick={() => navigate('memory')}>查看关系资料</button>
        <button className="button primary" onClick={() => { void session.confirmManualContact(selected.contactId).then((confirmed) => { if (confirmed) return window.notalone.openHelper(); }); }}>为这位联系人打开助手</button>
      </div>
    </>} /></div>}
    {session.error && <p className="contacts-note" role="alert">{session.error}</p>}
  </section>;
}
