import { useEffect, useState } from 'react';
import type { ReplySessionView } from './RewritePanel';

export function ReplySceneInput({ replies }: { replies: ReplySessionView }) {
  const { state } = replies;
  const [scene, setScene] = useState(state.scene ?? '');
  useEffect(() => { setScene(state.scene ?? ''); }, [state.scopeRevision, state.inputClearRevision]);
  const disabled = !state.contactId || state.phase === 'waiting' || state.exploration.phase === 'waiting'
    || state.sourceAvailability !== undefined || state.sessionDeletion === 'deleting';
  return <div className="reply-scene-input">
    <label>本次精确场景（可选）<input aria-label="本次精确场景" maxLength={256} value={scene} disabled={disabled}
      placeholder="例如：核对安排；只在你明确填写时使用场景限定方法"
      onChange={event => { setScene(event.target.value); void replies.updateScene(event.target.value); }} /></label>
    <p>空白不使用场景限定的方法。连续修改和中断重试沿各自保存的原场景；更改场景请重新生成。</p>
  </div>;
}
