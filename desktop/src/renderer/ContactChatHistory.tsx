import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ContactSessionView } from './contact-session';
import type { ContactHistoryState } from '../shared/contact-history-bridge';
import type { MessageQuoteSnapshot } from '../shared/message-quote';
import { useRevisionedSession } from './use-revisioned-session';
import { HistoryImageBubble } from './HistoryImageBubble';

const initialHistory: ContactHistoryState = { revision: -1, contactId: null, scopeRevision: 0,
  messages: { phase: 'idle', items: [], nextCursor: null }, error: null };

function quoteAuthorLabel(quote: MessageQuoteSnapshot, contactName: string): string {
  if (quote.senderRole === 'owner') return '引用·我';
  if (quote.senderRole === 'contact') return `引用·${quote.sender?.trim() || contactName}`;
  return quote.sender?.trim() ? `引用作者未核验：${quote.sender}` : '引用作者未知';
}

function quoteTypeLabel(messageType: string): string {
  const semanticLabels: Record<string, string> = { image: '图片', voice: '语音', video: '视频', file: '文件', text: '文字消息' };
  if (Object.hasOwn(semanticLabels, messageType)) return `引用类型：${semanticLabels[messageType]}`;
  if (!/^(0|[1-9][0-9]{0,19})$/.test(messageType)) return `引用类型：未知类型（${messageType}）`;

  const value = BigInt(messageType);
  if (value > 18_446_744_073_709_551_615n) return `引用类型：未知类型（${messageType}）`;
  const base = value & 0xffff_ffffn;
  if (base === 49n) {
    const appLabels: Record<string, string> = {
      '3': '音乐', '5': '链接', '6': '文件', '8': '文件', '19': '合并转发聊天记录', '24': '文件',
      '33': '小程序', '36': '小程序', '49': '链接', '51': '视频号', '53': '接龙', '57': '引用回复',
      '62': '拍一拍', '76': '音乐', '87': '群公告', '2000': '转账', '2001': '红包',
    };
    const subtype = String(value >> 32n);
    const appLabel = Object.hasOwn(appLabels, subtype) ? appLabels[subtype] : undefined;
    return `引用类型：${appLabel ?? `其他消息（未识别，原码：${messageType}）`}`;
  }

  const numericLabels: Record<string, string> = {
    '1': '文字消息', '3': '图片', '34': '语音', '43': '视频', '47': '表情包', '42': '名片',
    '48': '位置', '50': '通话记录', '62': '视频', '10000': '系统消息',
  };
  return `引用类型：${numericLabels[String(base)] ?? `未知类型（${messageType}）`}`;
}

export function ContactChatHistory({ session, settings, contactActions }: { session: ContactSessionView; settings?: ReactNode; contactActions?: ReactNode }) {
  const bridge = window.notalone.contactHistory;
  const { state, error, setError, latest, active, retry } = useRevisionedSession(initialHistory, bridge);
  const contactId = session.state.selectedContactId;
  const scopeRevision = session.state.scopeRevision;
  const settingsId = useId();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsScope, setSettingsScope] = useState<{ contactId: string; scopeRevision: number } | null>(null);
  const settingsOpen = settingsScope !== null && settingsScope.contactId === contactId && settingsScope.scopeRevision === scopeRevision;
  useEffect(() => { setSettingsScope(null); }, [contactId, scopeRevision]);
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
  return <section className="contact-chat" aria-label="联系人聊天记录" onKeyDown={(event) => {
    if (event.key === 'Escape' && settingsOpen) {
      setSettingsScope(null); settingsButton.current?.focus(); event.stopPropagation();
    }
  }}>
    <header className="contact-chat-header"><div><h3>聊天记录</h3><p>{selected?.displayName ?? '请在顶部选择联系人'}</p></div>
      <div className="contact-chat-actions">
        <button className="button" disabled={!sameScope || loading} onClick={() => void load()}>刷新记录</button>
        {selected && contactActions}
        {selected && settings && <button ref={settingsButton} className="button contact-chat-settings-toggle" type="button"
          aria-label="同步与资料管理" title="同步与资料管理" aria-expanded={settingsOpen} aria-controls={settingsId}
          onClick={() => setSettingsScope(settingsOpen ? null : { contactId: selected.contactId, scopeRevision })}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 3-.6 3a7 7 0 0 0-1.5.9L4 6l-3 5 2.3 2a7 7 0 0 0 0 1.8L1 17l3 5 2.9-.9a7 7 0 0 0 1.5.9l.6 3h6l.6-3a7 7 0 0 0 1.5-.9l2.9.9 3-5-2.3-2.2a7 7 0 0 0 0-1.8L23 11l-3-5-2.9.9a7 7 0 0 0-1.5-.9L15 3Z" transform="translate(2 0) scale(.83)" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>}
      </div>
    </header>
    {/* 收起时保留操作状态，避免丢失结果尚未确认的重新同步请求。 */}
    {selected && settings && <section key={selected.contactId} id={settingsId} className="contact-management contact-chat-settings" aria-label="当前联系人设置" hidden={!settingsOpen}>
      <h3>同步与资料管理</h3>
      {settings}
    </section>}
    {!selected ? <div className="contact-chat-empty"><p>在顶部选择联系人后，查看你们已保存的聊天记录。</p></div>
      : <div className="contact-chat-body" aria-busy={loading}>
        {messages.items.length > 0 && <p className="contact-chat-note">{unknownOrder
          ? '按消息时间展示；同一时间或时间未知的消息先后未核验。' : '最近消息在前。'}</p>}
        {(!sameScope || loading) && <p className="contact-chat-note" role="status">正在读取聊天记录…</p>}
        {sameScope && messages.phase === 'ready' && messages.items.length === 0 && <div className="contact-chat-empty"><p>还没有已保存的聊天记录</p><small>同步或导入这位联系人的资料后，会显示在这里。</small></div>}
        {sameScope && (messages.phase === 'failed' || state.error) && <p role="alert" className="contact-chat-note">{state.error || '聊天记录暂时无法读取，请刷新重试。'}</p>}
        <ol className="contact-chat-messages" aria-label="已保存的聊天消息">
          {messages.items.map(message => {
            const quoted = message.quoted ?? (message.messageType === 'quote'
              ? { text: '[引用内容不可用]', targetMessageId: null, senderRole: 'unknown' as const, state: 'unavailable' as const }
              : null);
            return <li key={message.messageId} className="contact-chat-message" data-speaker={message.speaker}>
              <div className="contact-chat-meta"><span>{message.speaker === 'user' ? '我' : message.speaker === 'system' ? '系统' : selected.displayName}</span>
                {message.occurredAt ? <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleString('zh-CN')}</time> : <span>时间未知</span>}</div>
              <div className="contact-chat-bubble">
                {quoted && <blockquote className="contact-chat-quote" aria-label="引用内容"
                  data-quote-state={quoted.state ?? 'legacy'}>
                  <span className="contact-chat-quote-author">{quoteAuthorLabel(quoted, selected.displayName)}</span>
                  {quoted.messageType && quoted.messageType !== 'text'
                    && <span className="contact-chat-quote-type">{quoteTypeLabel(quoted.messageType)}</span>}
                  <span className="contact-chat-quote-text">{quoted.text}</span>
                  {quoted.state === 'unresolved' && <span className="contact-chat-quote-status">原消息未关联</span>}
                {quoted.state === 'unavailable' && <span className="contact-chat-quote-status">
                  {message.messageType === 'quote' && message.mediaPlaceholder ? message.mediaPlaceholder : '引用来源不可用'}
                </span>}
                </blockquote>}
                {message.messageType === 'image' ? <HistoryImageBubble media={window.notalone.media}
                  imageMedia={message.imageMedia} selection={{ contactId: contactId!, messageId: message.messageId, scopeRevision }} />
                  : (message.text !== null || !quoted) && <p>{message.text ?? message.mediaPlaceholder ?? '无文字内容'}</p>}
              </div>
            </li>;
          })}
        </ol>
        {messages.nextCursor && <button className="button contact-chat-more" disabled={loading} onClick={() => void load(true)}>加载更早记录</button>}
      </div>}
    {error && <p className="contact-chat-note" role="alert">{error}<button className="button" onClick={() => void retry()}>重新读取状态</button></p>}
  </section>;
}
