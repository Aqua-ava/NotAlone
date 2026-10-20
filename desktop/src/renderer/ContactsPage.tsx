import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './contacts.css';
import { useState } from 'react';

export function ContactsPage({ session, navigate, manualRelease = false }: { session: ContactSessionView; navigate: (page: ManagerPage) => void; manualRelease?: boolean }) {
  const { state } = session;
  const [name, setName] = useState(''), [creating, setCreating] = useState(false);
  const selected = state.contacts.find((contact) => contact.contactId === state.selectedContactId);
  return <section className="contacts-panel" aria-label="联系人目录">
    <div className="contacts-toolbar"><div><h2>选择本次联系人</h2><p>先明确选择一位联系人，再手动粘贴文字或导入单联系人资料。</p></div>
      <button className="button" disabled={state.directoryPhase === 'unavailable' || state.directoryPhase === 'loading'}
        onClick={() => void session.refreshContacts()}>刷新联系人</button></div>
    {state.directoryPhase === 'loading' && <p className="contacts-note" aria-live="polite">正在读取联系人目录…</p>}
    {state.directoryPhase === 'unavailable' && <div className="contacts-empty"><h3>联系人暂不可用</h3><p>连接本机服务后，确认本次运行的本人身份，再查看联系人。</p></div>}
    {state.directoryPhase === 'owner-unconfigured' && <div className="contacts-empty"><h3>本次运行的本人身份未就绪</h3><p>请在应用配置中检查本人身份和受控配置，再重新连接。</p>
      <button className="button" onClick={() => navigate('config')}>前往应用配置</button></div>}
    {state.directoryPhase === 'error' && <p className="contacts-note" role="alert">联系人目录读取失败，请刷新重试。</p>}
    {state.directoryPhase === 'ready' && state.contacts.length === 0 && <div className="contacts-empty"><h3>还没有联系人</h3>
      <p>填写下方展示名称创建联系人，创建后再明确选择本次对象。名称相同也会创建不同的联系人。</p></div>}
    {state.directoryPhase === 'ready' && <form className="contact-create" aria-label="创建手动联系人" onSubmit={(event) => {
      event.preventDefault(); if (creating || !name.trim()) return; setCreating(true);
      void session.createContact(name).then((success) => { if (success) setName(''); }).finally(() => setCreating(false));
    }}><label>联系人展示名称<input aria-label="联系人展示名称" maxLength={100} value={name} disabled={creating}
      onChange={(event) => setName(event.target.value)} placeholder="由你确认的这位联系人" /></label>
      <button className="button primary" disabled={creating || !name.trim()}>{creating ? '正在创建…' : '创建联系人'}</button>
      <p>这只创建本机联系人，不建立微信身份或会话绑定，也不授权读取聊天。</p></form>}
    {state.contacts.length > 0 && <div className="contacts-columns"><ul className="contact-list" aria-label="可选联系人">
      {state.contacts.map((contact) => <li key={contact.contactId}>
        <button className="contact-row" aria-label={`选择${contact.displayName}`} aria-pressed={state.selectedContactId === contact.contactId}
          onClick={() => void (manualRelease ? session.confirmManualContact(contact.contactId) : session.selectContact(contact.contactId))}>
          <span className="contact-avatar" aria-hidden="true">{contact.displayName.slice(0, 1)}</span>
          <span className="contact-row-copy"><b>{contact.displayName}</b><small>{contact.messageCount} 条消息</small></span>
          <span className="contact-row-choice">{state.selectedContactId === contact.contactId ? '已选择' : '选择'}</span>
        </button></li>)}
    </ul><aside className="contact-summary" aria-label="本次联系人资料摘要">
      <h3>{selected ? selected.displayName : '等待你确认联系人'}</h3>
      {selected ? <><dl><div><dt>消息</dt><dd>{selected.messageCount} 条</dd></div></dl>
        <p>本次文字和候选对应这位联系人。切换后清空编辑输入，已生成候选与编辑按联系人保留。</p>
        <button className="button primary" onClick={() => { void session.confirmManualContact(selected.contactId).then((confirmed) => { if (confirmed) return window.notalone.openHelper(); }); }}>手动输入本次聊天</button>
        <button className="button" onClick={() => navigate('import')}>导入单联系人资料</button></>
        : <p>联系人不会自动选中。选择后，两个窗口会显示同一个本次对象。</p>}
    </aside></div>}
    <p className="contacts-note">支持手动输入和单联系人文件导入；本机已配置微信识别时，可在输入小窗恢复微信会话识别。候选由你编辑并亲自发送。</p>
    {session.error && <p className="contacts-note" role="alert">{session.error}</p>}
  </section>;
}
