import { useEffect, useRef, useState } from 'react';
import type { AssistantContinuationClarification, RequirementChange } from '../shared/assistant-continuation-clarification';
import type { ReplySessionView } from './RewritePanel';

const withinTextLimit = (value: string) => Array.from(value).length <= 4096;

function RequirementDecisions({ clarification, disabled, confirm }: {
  clarification: AssistantContinuationClarification;
  disabled: boolean;
  confirm: (changes: readonly RequirementChange[]) => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<number, { action: RequirementChange['action'] | ''; replacement: string }>>({});
  const complete = clarification.requirement_options.every((option, index) => {
    const choice = choices[index];
    return choice && option.actions.some((action) => action === choice.action)
      && (choice.action !== 'replace' || Boolean(choice.replacement.trim()) && withinTextLimit(choice.replacement));
  });
  function submit() {
    if (!complete || disabled) return;
    const changes = clarification.requirement_options.map((option, index): RequirementChange => {
      const choice = choices[index];
      if (choice.action === 'add') return { action: 'add', replacement: option.requirement };
      if (choice.action === 'replace') return { action: 'replace', previous: option.requirement, replacement: choice.replacement.trim() };
      if (choice.action === 'keep' || choice.action === 'remove') return { action: choice.action, previous: option.requirement };
      throw new Error('请明确每条要求的处理方式。');
    });
    void confirm(changes);
  }
  return <fieldset disabled={disabled}>
    <legend>明确本次要求</legend>
    {clarification.requirement_options.map((option, index) => {
      const choice = choices[index] ?? { action: '', replacement: '' };
      return <div key={option.requirement}>
        <p>{option.requirement}</p>
        <label>要求{index + 1}处理方式<select aria-label={`要求${index + 1}处理方式`} value={choice.action}
          onChange={(event) => setChoices({ ...choices, [index]: { ...choice, action: event.target.value as RequirementChange['action'] } })}>
          <option value="">请选择处理方式</option>
          {option.actions.map((action) => <option key={action} value={action}>
            {action === 'keep' ? '保留' : action === 'replace' ? '替换' : action === 'remove' ? '移除' : '新增'}
          </option>)}
        </select></label>
        {choice.action === 'replace' && <label>要求{index + 1}替换内容<textarea aria-label={`要求${index + 1}替换内容`}
          value={choice.replacement} onChange={(event) => setChoices({ ...choices,
            [index]: { ...choice, replacement: event.target.value } })} /></label>}
      </div>;
    })}
    <button disabled={!complete || disabled} onClick={submit}>确认本次要求</button>
  </fieldset>;
}

export function AssistantContinuationControls({ replies, hasUnsavedEdits = false }: {
  replies: ReplySessionView;
  hasUnsavedEdits?: boolean;
}) {
  const { state } = replies;
  const [instruction, setInstruction] = useState('');
  const [intention, setIntention] = useState('');
  const submitted = useRef<{ instruction: string; intention: string } | null>(null);
  const continuation = state.continuation;
  const textTooLong = !withinTextLimit(instruction) || !withinTextLimit(intention);
  useEffect(() => {
    if (continuation?.phase !== 'completed' || !submitted.current) return;
    const actual = submitted.current; submitted.current = null;
    setInstruction((value) => value === actual.instruction ? '' : value);
    setIntention((value) => value === actual.intention ? '' : value);
  }, [continuation?.phase, continuation?.expectedInputVersionId]);
  const saved = state.savedSession;
  const hasCompleted = saved?.phase === 'ready' && saved.turns.some((turn) => turn.state === 'completed' && turn.reply);
  if (!hasCompleted || !state.contactId) return null;
  const disabled = state.phase === 'waiting' || state.exploration.phase === 'waiting' || Boolean(state.generationBlock)
    || state.sourceAvailability !== undefined || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed'
    || state.candidateVersions?.phase !== 'ready' || hasUnsavedEdits;
  function submit() {
    if (disabled || textTooLong || !instruction.trim() && !intention.trim()) return;
    submitted.current = { instruction, intention };
    void replies.continueSession(instruction.trim() || '继续', intention.trim() || undefined);
  }
  return <section aria-label="连续修改" className="assistant-continuation-controls">
    <header><h3>继续调整这组回复</h3><p>不满意的地方写在这里，助手会接着修改。</p></header>
    <p>编号指向当前展示的整组说法。正文编辑结束后自动保存，保存完成即可继续调整。</p>
    <p>连续修改使用本组保存的精确场景：{saved?.turns.find(turn => turn.inputVersionId === saved.currentInputVersionId)?.input?.scene ?? '未声明'}。如需变更场景，请重新生成。</p>
    <label>继续修改要求<textarea aria-label="继续修改要求" value={instruction} disabled={disabled}
      placeholder="例如：第二条简短一点" onChange={(event) => setInstruction(event.target.value)} /></label>
    <label>本次改口<textarea aria-label="本次改口" value={intention} disabled={disabled}
      placeholder="明确改变本次意愿时填写" onChange={(event) => setIntention(event.target.value)} /></label>
    <button disabled={disabled || textTooLong || !instruction.trim() && !intention.trim()}
      onClick={submit}>继续修改</button>
    {hasUnsavedEdits && <p role="status">本组仍有未保存修改，请先保存。</p>}
    {textTooLong && <p role="status">本次要求和改口分别最多4096个字符，请修改后继续。</p>}
    {continuation?.message && <p role={continuation.phase === 'failed' ? 'alert' : 'status'}>{continuation.message}</p>}
    {continuation?.phase === 'clarification' && continuation.clarification?.requirement_options.length ?
      <RequirementDecisions key={`${continuation.sessionId}:${continuation.expectedInputVersionId}:${JSON.stringify(continuation.clarification)}`}
        clarification={continuation.clarification} disabled={disabled} confirm={replies.confirmContinuation} /> : null}
    {continuation?.phase === 'completed' && <p role="status">本次继续已保存，生效要求：{continuation.effectiveRequirements?.join('；') || '没有额外要求'}</p>}
    {continuation?.phase === 'failed' && continuation.canRetry &&
      <button disabled={disabled} onClick={() => void replies.retryContinuation()}>重试本次连续修改</button>}
  </section>;
}
