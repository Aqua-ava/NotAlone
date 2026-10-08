import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './contacts.css';

export function ContactsPage({ session, navigate }: { session: ContactSessionView; navigate: (page: ManagerPage) => void }) {
  const { state } = session;
  const selected = state.contacts.find((contact) => contact.contactId === state.selectedContactId);
  return <section className="contacts-panel" aria-label="联系人目录">
    <div className="contacts-toolbar"><div><h2>选择本次联系人</h2><p>切换联系人会清空小窗中上一位联系人的临时草稿。</p></div>
      <button className="button" disabled={state.directoryPhase === 'unavailable' || state.directoryPhase === 'loading'}
        onClick={() => void session.refreshContacts()}>刷新联系人</button></div>
    {state.directoryPhase === 'loading' && <p className="contacts-note" aria-live="polite">正在读取联系人目录…</p>}
    {state.directoryPhase === 'unavailable' && <div className="contacts-empty"><h3>联系人暂不可用</h3><p>连接本机服务后，确认本次运行的本人身份，再查看联系人。</p></div>}
    {state.directoryPhase === 'owner-unconfigured' && <div className="contacts-empty"><h3>本次运行的本人身份未就绪</h3><p>请在应用配置中检查本人身份和受控配置，再重新连接。</p>
      <button className="button" onClick={() => navigate('config')}>前往应用配置</button></div>}
    {state.directoryPhase === 'error' && <p className="contacts-note" role="alert">联系人目录读取失败，请刷新重试。</p>}
    {state.directoryPhase === 'ready' && state.contacts.length === 0 && <div className="contacts-empty"><h3>还没有联系人</h3>
      <p>通过历史导入确认一份单联系人资料，或在同步设置中确认会话后建立联系人。</p>
      <div><button className="button" onClick={() => navigate('import')}>前往历史导入</button>
        <button className="button" onClick={() => navigate('sync')}>前往同步设置</button></div></div>}
    {state.contacts.length > 0 && <div className="contacts-columns"><ul className="contact-list" aria-label="可选联系人">
      {state.contacts.map((contact) => <li key={contact.contactId}>
        <button className="contact-row" aria-label={`选择${contact.displayName}`} aria-pressed={state.selectedContactId === contact.contactId}
          onClick={() => void session.selectContact(contact.contactId)}>
          <span className="contact-avatar" aria-hidden="true">{contact.displayName.slice(0, 1)}</span>
          <span className="contact-row-copy"><b>{contact.displayName}</b><small>{contact.messageCount} 条消息 · {contact.sourceCount} 份来源</small></span>
          <span className="contact-row-choice">{state.selectedContactId === contact.contactId ? '已选择' : '选择'}</span>
        </button></li>)}
    </ul><aside className="contact-summary" aria-label="本次联系人资料摘要">
      <h3>{selected ? selected.displayName : '等待你确认联系人'}</h3>
      {selected ? <><dl><div><dt>消息</dt><dd>{selected.messageCount} 条</dd></div><div><dt>来源</dt><dd>{selected.sourceCount} 份</dd></div></dl>
        <p>本次小窗草稿对应这位联系人。目录摘要只反映已保存的消息和来源数量。</p></>
        : <p>联系人不会自动选中。选择后，两个窗口会显示同一个本次对象。</p>}
    </aside></div>}
    {session.error && <p className="contacts-note" role="alert">{session.error}</p>}
  </section>;
}
