import type { ReplySessionView } from './RewritePanel';

export function AssistantSessionPanel({ replies }: { replies: ReplySessionView }) {
  const saved = replies.state.savedSession;
  return <section aria-label="助手会话">
    <button disabled={!replies.state.contactId || saved?.phase === 'loading'} onClick={() => void replies.readSavedSession()}>
      查看已保存讨论
    </button>
    {saved?.phase === 'loading' && <p role="status">正在读取已保存讨论…</p>}
    {saved?.phase === 'failed' && <p role="alert">已保存讨论暂不可用，请重试读取。</p>}
    {saved?.phase === 'ready' && <section aria-label="已保存的讨论">
      {!saved.turns.length && <p>当前会话还没有讨论。</p>}
      {saved.turns.map((turn, index) => <article key={turn.turnId} aria-label={`第${index + 1}轮讨论`}>
        {turn.placeholder ? <p>{turn.placeholder}</p> : <>
          <p>{typeof turn.input?.content.draft_text === 'string' ? turn.input.content.draft_text
            : typeof turn.input?.content.direction === 'string' ? turn.input.content.direction : '本轮回复输入'}</p>
          {typeof turn.input?.content.user_instruction === 'string' && <p>{turn.input.content.user_instruction}</p>}
          {turn.state === 'running' && <p>本轮生成尚未完成。</p>}
          {turn.state === 'failed' && <p>本轮生成未成功保存。</p>}
          {turn.reply?.candidates.map((candidate) => <p key={candidate.candidateId}>{candidate.text}</p>)}
        </>}
      </article>)}
    </section>}
  </section>;
}
