import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ContactSessionView } from './contact-session';
import type { ContactHistoryState } from '../shared/contact-history-bridge';
import type { MessageQuoteSnapshot } from '../shared/message-quote';
import { useRevisionedSession } from './use-revisioned-session';
import { HistoryImageBubble } from './HistoryImageBubble';
import { ContactChatToolbar } from './ContactChatToolbar';
import { useChatHistoryScroll } from './use-chat-history-scroll';

const initialHistory: ContactHistoryState = { revision: -1, contactId: null, scopeRevision: 0,
  messages: { phase: 'idle', items: [], nextCursor: null }, error: null };

function messageTime(value: string | null): Date | null {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function startsTimeGroup(current: Date | null, previous: Date | null): boolean {
  if (!current || !previous) return current !== previous;
  return current.toDateString() !== previous.toDateString() || current.getTime() - previous.getTime() >= 5 * 60_000;
}

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

export function ContactChatHistory({ session, settings, actions, contactActions, syncStatus, syncIssue = false, settingsTargetContactId }: { syncStatus?: ReactNode; syncIssue?: boolean; actions?: ReactNode; settingsTargetContactId?: string | null; session: ContactSessionView; settings?: ReactNode; contactActions?: ReactNode }) {
  const bridge = window.notalone.contactHistory;
  const { state, error, setError, latest, active, retry } = useRevisionedSession(initialHistory, bridge);
  const contactId = session.state.selectedContactId;
  const scopeRevision = session.state.scopeRevision;
  const settingsId = useId();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsScope, setSettingsScope] = useState<{ contactId: string; scopeRevision: number } | null>(null);
  const settingsOpen = settingsScope !== null && settingsScope.contactId === contactId && settingsScope.scopeRevision === scopeRevision;
  useEffect(() => { setSettingsScope(settingsTargetContactId && settingsTargetContactId === contactId ? { contactId, scopeRevision } : null); }, [contactId, scopeRevision, settingsTargetContactId]);
  const selected = session.state.contacts.find(contact => contact.contactId === contactId);
  const sameScope = Boolean(selected) && state.contactId === contactId && state.scopeRevision === scopeRevision;
  const messages = sameScope ? state.messages : initialHistory.messages;
  const loading = messages.phase === 'loading';
  const scope = `${contactId}:${scopeRevision}`;
  const scroll = useChatHistoryScroll(scope, state.revision, messages.phase, messages.items.length > 0);
  // 后台继续倒序分页，展示层按原有稳定顺序翻转，不重新猜测同时间消息的先后。
  const timeline = [...messages.items].reverse();
  async function load(older = false) {
    if (!contactId || !sameScope) return;
    scroll.prepareLoad(older);
    setError('');
    try { await bridge.load({ contactId, scopeRevision, older }); }
    catch {
      if (active.current && latest.current.contactId === contactId && latest.current.scopeRevision === scopeRevision) {
        setError('聊天暂时没加载出来，请重试。');
      }
    }
  }
  useEffect(() => {
    if (sameScope && messages.phase === 'idle' && !error) void load();
  }, [sameScope, contactId, scopeRevision, messages.phase, error]);
  const historyFailed = sameScope && (messages.phase === 'failed' || !!state.error || !!error);
  const unknownOrder = messages.items.some(message => message.ordering === 'unknown');
  return <section className="contact-chat" aria-label="联系人聊天记录" onKeyDown={(event) => {
    if (event.key === 'Escape' && settingsOpen) {
      setSettingsScope(null);
      const menu = settingsButton.current?.closest('details');
      if (menu) menu.open = true;
      settingsButton.current?.focus(); event.stopPropagation();
    }
  }}>
    <header className="contact-chat-header"><div><h3>{selected?.displayName ?? '聊天记录'}</h3>
      {selected && syncStatus && <div className="contact-sync-summary">{syncStatus}{syncIssue && <button className="button" onClick={() => setSettingsScope({ contactId: selected.contactId, scopeRevision })}>处理同步问题</button>}</div>}
      {unknownOrder && <details className="contact-chat-order"><summary>部分顺序未核验</summary>
        <p>按消息时间展示；同一时间或时间未知的消息先后未核验。</p></details>}</div>
      <div className="contact-chat-header-actions">
      {actions}
      <ContactChatToolbar key={scope}>
        {selected && settings && <button ref={settingsButton} className="button contact-chat-settings-toggle" type="button"
          aria-label="同步与资料" title="同步与资料" aria-expanded={settingsOpen} aria-controls={settingsId}
          onClick={() => setSettingsScope(settingsOpen ? null : { contactId: selected.contactId, scopeRevision })}>
          同步与资料
        </button>}
        {selected && contactActions}
      </ContactChatToolbar>
      </div>
    </header>
    {/* 收起时保留操作状态，避免丢失结果尚未确认的重新同步请求。 */}
    {selected && settings && <section key={selected.contactId} id={settingsId} className="contact-management contact-chat-settings" aria-label="当前联系人设置" hidden={!settingsOpen}>
      <h3>同步与资料</h3>
      {settings}
    </section>}
    {!selected ? <div className="contact-chat-empty"><p>在顶部选择联系人后，查看你们已保存的聊天记录。</p></div>
      : <div className="contact-chat-viewport">
        <div ref={scroll.body} className="contact-chat-body" aria-busy={loading} onScroll={scroll.onScroll}>
        <div ref={scroll.content}>
        {messages.nextCursor && <button className="button contact-chat-more" disabled={loading} onClick={() => void load(true)}>加载更早记录</button>}
        {(!sameScope || loading) && <p className="contact-chat-note" role="status">正在读取聊天记录…</p>}
        {sameScope && messages.phase === 'ready' && messages.items.length === 0 && <div className="contact-chat-empty"><p>还没有已保存的聊天记录</p><small>同步或导入这位联系人的资料后，会显示在这里。</small></div>}
        {historyFailed && <p className="contact-chat-note" role="alert">{error || state.error || '聊天暂时没加载出来。'} <button className="button" disabled={loading} onClick={() => void load()}>重试加载聊天</button></p>}
        <ol className="contact-chat-messages" aria-label="已保存的聊天消息">
          {timeline.map((message, index) => {
            const time = messageTime(message.occurredAt);
            const showTime = index === 0 || startsTimeGroup(time, messageTime(timeline[index - 1].occurredAt));
            const sender = message.speaker === 'user' ? '我' : message.speaker === 'system' ? '系统' : selected.displayName;
            const quoted = message.quoted ?? (message.messageType === 'quote'
              ? { text: '[引用内容不可用]', targetMessageId: null, senderRole: 'unknown' as const, state: 'unavailable' as const }
              : null);
            return <li key={message.messageId} className="contact-chat-message" data-speaker={message.speaker} data-message-id={message.messageId} aria-label={`${sender}的消息`}>
              {showTime && <div className="contact-chat-time">{time
                ? <time dateTime={message.occurredAt!}>{time.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                : <span>时间未知</span>}</div>}
              <div className="contact-chat-message-row">
              {message.speaker !== 'system' && <span className="contact-chat-avatar" aria-hidden="true" title={sender}>{Array.from(sender)[0]}</span>}
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
              <details className="contact-chat-message-details"><summary aria-label="消息详情" title="消息详情">⋯</summary>
                <div className="contact-chat-meta"><span>{sender}</span>
                  {time ? <time dateTime={message.occurredAt!}>{time.toLocaleString('zh-CN')}</time> : <span>时间未知</span>}
                  {message.ordering === 'unknown' && <span>同时间或时间未知的消息先后未核验</span>}</div>
              </details>
              </div>
            </li>;
          })}
        </ol>
        </div>
      </div>
        {scroll.away && <button className="button contact-chat-latest" onClick={scroll.scrollToLatest}>回到最新</button>}
      </div>}
    {error && !sameScope && <p className="contact-chat-note" role="alert">聊天暂时没加载出来。<button className="button" onClick={() => void retry()}>重试加载聊天</button></p>}
  </section>;
}
