import { useEffect, useState } from 'react';
import type { ReplySessionView } from './RewritePanel';
import { StrategyControls } from './StrategyControls';
import { Icon } from './icons';
import { DirectionGenerationNotice, needsDirectionClarification } from './ReplyGenerationGuidance';

export function DirectedReplyInput({ replies }: { replies: ReplySessionView }) {
  const { state } = replies;
  const [direction, setDirection] = useState(state.direction);
  useEffect(() => { setDirection(state.direction); }, [state.scopeRevision, state.direction]);
  const enabled = Boolean(state.contactId);
  const canGenerate = enabled && Boolean(state.targetMessageId) && Boolean(direction.trim()) && state.phase !== 'waiting' && !state.generationBlock
    && state.exploration.phase !== 'waiting' && !needsDirectionClarification(state);
  return <section className="directed-input" aria-label="本次回复输入">
    <div className="message-heading"><b>选择待回复消息</b>
      <button disabled={!enabled || state.messages.phase === 'loading'} onClick={() => void replies.loadMessages()}>刷新消息</button></div>
    {state.messages.phase === 'loading' && <p role="status">正在读取这位联系人的消息…</p>}
    {state.messages.phase === 'failed' && <p role="alert">消息读取失败，请刷新重试，也可以切换到草稿改写。</p>}
    {state.messages.phase === 'ready' && !state.messages.items.length && <p>这位联系人暂无可用消息，可以使用草稿改写。</p>}
    <div className="reply-message-list" role="group" aria-label="待回复消息">
      {state.messages.items.map((message) => <label className="reply-message" key={message.messageId}>
        <input type="radio" name="target-message" checked={state.targetMessageId === message.messageId}
          onChange={() => void replies.selectMessage(message.messageId)} />
        <span><small>{message.speaker === 'contact' ? '对方' : message.speaker === 'user' ? '本人' : '系统'} · {message.occurredAt ? new Date(message.occurredAt).toLocaleString('zh-CN') : '时间未知'}</small>
          <span className="reply-message-text">{message.text ?? message.mediaPlaceholder ?? '无文字内容'}</span>
          {message.quoted && <small>引用：{message.quoted.text}</small>}</span>
      </label>)}
    </div>
    {state.messages.nextCursor && <button disabled={state.messages.phase === 'loading'} onClick={() => void replies.loadMessages(true)}>加载更早消息</button>}
    <StrategyControls replies={replies} />
    <div className="ime-input"><label>表达方向<textarea aria-label="表达方向" maxLength={4096}
      value={direction} disabled={!enabled} placeholder="明确说明想表达什么，例如解释时间安排，不增加承诺"
      onChange={(event) => { setDirection(event.target.value); void replies.updateDirection(event.target.value); }} /></label>
      <button className="generate-button" aria-label="生成候选" title="生成候选" disabled={!canGenerate}
        onClick={() => void replies.generate()}><Icon name="sparkle" size={18} /></button></div>
    <DirectionGenerationNotice state={state} />
    <p className="rewrite-privacy">本次回复使用选中消息、这位联系人的近期对话和相关资料。表达方向只作用于本次生成。</p>
    <div className="rewrite-retry">
      {state.canRetry && <button disabled={!canGenerate} onClick={() => void replies.generate()}>重试同一次生成</button>}
      {state.result && <button disabled={!canGenerate} onClick={() => void replies.generate(true)}>重新生成</button>}
    </div>
  </section>;
}
