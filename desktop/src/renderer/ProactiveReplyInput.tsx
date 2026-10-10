import { useEffect, useState } from 'react';
import type { ReplySessionView } from './RewritePanel';

export function ProactiveReplyInput({ replies }: { replies: ReplySessionView }) {
  const { state } = replies;
  const [purpose, setPurpose] = useState(state.purpose);
  useEffect(() => { setPurpose(state.purpose); }, [state.scopeRevision]);
  return <section aria-label="主动联系输入">
    <label>本次主动目的<textarea aria-label="主动目的" maxLength={4096} value={purpose}
      disabled={!state.contactId} placeholder="说明这次想做什么，如问候近况，不安排见面"
      onChange={(event) => { setPurpose(event.target.value); void replies.updatePurpose(event.target.value); }} /></label>
    <button aria-label="生成候选" disabled={!state.contactId || !purpose.trim() || state.phase === 'waiting' || Boolean(state.generationBlock)}
      onClick={() => void replies.generate()}>比较开口与候选</button>
    <p className="rewrite-privacy">主动目的单独保存，不会被当成对方消息。开口方式与候选一起比较，最终由你亲自发送。</p>
  </section>;
}
