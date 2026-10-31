import { useEffect } from 'react';
import type { ContactSessionView } from './contact-session';
import type { ContactHistoryState } from '../shared/contact-history-bridge';
import { useRevisionedSession } from './use-revisioned-session';

const initialHistory: ContactHistoryState = { revision: -1, contactId: null, scopeRevision: 0,
  messages: { phase: 'idle', items: [], nextCursor: null }, error: null };

export function ContactChatHistory({ session }: { session: ContactSessionView }) {
  const bridge = window.notalone.contactHistory;
  const { state, error, setError, latest, active, retry } = useRevisionedSession(initialHistory, bridge);
  const contactId = session.state.selectedContactId;
  const scopeRevision = session.state.scopeRevision;
  const selected = session.state.contacts.find(contact => contact.contactId === contactId);
  const sameScope = Boolean(selected) && state.contactId === contactId && state.scopeRevision === scopeRevision;
  const messages = sameScope ? state.messages : initialHistory.messages;
  const loading = messages.phase === 'loading';
  async function load(older = false) {
    if (!contactId || !sameScope) return;
    setError('');
    try { await bridge.load({ contactId, scopeRevision, older }); }
    catch {
      if (active.current && latest.current.contactId === contactId && latest.current.scopeRevision === scopeRevision) {
        setError('聊天记录暂时无法读取，请重试。');
      }
    }
  }
  useEffect(() => {
    if (sameScope && messages.phase === 'idle' && !error) void load();
  }, [sameScope, contactId, scopeRevision, messages.phase, error]);
  const unknownOrder = messages.items.some(message => message.ordering === 'unknown');
  return <section className="contact-chat" aria-label="联系人聊天记录">
    <header className="contact-chat-header"><div><h3>聊天记录</h3><p>{selected?.displayName ?? '请在顶部选择联系人'}</p></div>
      <button className="button" disabled={!sameScope || loading} onClick={() => void load()}>刷新记录</button>
    </header>
    {!selected ? <div className="contact-chat-empty"><p>在顶部选择联系人后，查看你们已保存的聊天记录。</p></div>
      : <div className="contact-chat-body" aria-busy={loading}>
        {messages.items.length > 0 && <p className="contact-chat-note">{unknownOrder
          ? '按保存位置展示，消息先后尚未核验。' : '最近消息在前。'}</p>}
        {(!sameScope || loading) && <p className="contact-chat-note" role="status">正在读取聊天记录…</p>}
        {sameScope && messages.phase === 'ready' && messages.items.length === 0 && <div className="contact-chat-empty"><p>还没有已保存的聊天记录</p><small>同步或导入这位联系人的资料后，会显示在这里。</small></div>}
        {sameScope && (messages.phase === 'failed' || state.error) && <p role="alert" className="contact-chat-note">{state.error || '聊天记录暂时无法读取，请刷新重试。'}</p>}
        <ol className="contact-chat-messages" aria-label="已保存的聊天消息">
          {messages.items.map(message => <li key={message.messageId} className="contact-chat-message" data-speaker={message.speaker}>
            <div className="contact-chat-meta"><span>{message.speaker === 'user' ? '我' : message.speaker === 'system' ? '系统' : selected.displayName}</span>
              {message.occurredAt ? <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleString('zh-CN')}</time> : <span>时间未知</span>}</div>
            <div className="contact-chat-bubble">
              {message.quoted && <blockquote aria-label="引用内容">{message.quoted.text}</blockquote>}
              <p>{message.text ?? message.mediaPlaceholder ?? '无文字内容'}</p>
            </div>
          </li>)}
        </ol>
        {messages.nextCursor && <button className="button contact-chat-more" disabled={loading} onClick={() => void load(true)}>加载更早记录</button>}
      </div>}
    {error && <p className="contact-chat-note" role="alert">{error}<button className="button" onClick={() => void retry()}>重新读取状态</button></p>}
  </section>;
}
