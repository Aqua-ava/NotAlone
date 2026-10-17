import { useEffect, useState } from 'react';
import { StrategyControls } from './StrategyControls';
import type { ReplySessionView } from './RewritePanel';
import { DirectionGenerationNotice, needsDirectionClarification } from './ReplyGenerationGuidance';

export function ProactiveReplyInput({ replies }: { replies: ReplySessionView }) {
  const { state } = replies;
  const [purpose, setPurpose] = useState(state.purpose);
  useEffect(() => { setPurpose(state.purpose); }, [state.scopeRevision, state.purpose]);
  const canGenerate = Boolean(state.contactId) && Boolean(purpose.trim()) && state.phase !== 'waiting'
    && state.exploration.phase !== 'waiting' && !state.generationBlock && !needsDirectionClarification(state);
  return <section aria-label="主动联系输入">
    <label>本次主动目的<textarea aria-label="主动目的" maxLength={4096} value={purpose}
      disabled={!state.contactId} placeholder="说明这次想做什么，如问候近况，不安排见面"
      onChange={(event) => { setPurpose(event.target.value); void replies.updatePurpose(event.target.value); }} /></label>
    <StrategyControls replies={replies} />
    <button aria-label="生成候选" disabled={!canGenerate}
      onClick={() => void replies.generate()}>目的已明确，生成候选</button>
    <div className="rewrite-retry">
      {state.canRetry && <button disabled={!canGenerate} onClick={() => void replies.generate()}>重试同一次生成</button>}
      {state.result && <button disabled={!canGenerate} onClick={() => void replies.generate(true)}>重新生成</button>}
    </div>
    <DirectionGenerationNotice state={state} />
    <p className="rewrite-privacy">主动目的单独保存，不会被当成对方消息。开口方式与候选一起比较，最终由你亲自发送。</p>
  </section>;
}
