import { useEffect, useState } from 'react';
import type { ReplySessionView } from './RewritePanel';

export function StrategyControls({ replies }: { replies: ReplySessionView }) {
  const { state } = replies, result = state.exploration.result;
  const [answer, setAnswer] = useState('');
  useEffect(() => setAnswer(''), [state.scopeRevision, result?.question?.questionId]);
  const available = Boolean(state.contactId) && !state.generationBlock && state.phase !== 'waiting'
    && state.exploration.phase !== 'waiting' && (state.mode !== 'reply_to_message' || Boolean(state.targetMessageId));
  return <section aria-label="理解与方向">
    <button disabled={!available} onClick={() => void replies.explore()}>帮我理清方向</button>
    <label>纠正理解<textarea aria-label="纠正理解" maxLength={4096} value={state.correction}
      disabled={!state.contactId} onChange={(event) => void replies.updateCorrection(event.target.value)} /></label>
    <label>本次要求<textarea aria-label="本次策略要求" maxLength={4096} value={state.requirements}
      disabled={!state.contactId} onChange={(event) => void replies.updateRequirements(event.target.value)} /></label>
    <label>策略选择<select aria-label="策略选择" disabled={!available} value={state.skillChoice.mode === 'user' ? state.skillChoice.versionId! : state.skillChoice.mode}
      onChange={(event) => void replies.updateSkill(event.target.value === 'auto' || event.target.value === 'disabled'
        ? { mode: event.target.value, versionId: null } : { mode: 'user', versionId: event.target.value })}>
      <option value="auto">按当前场景选择</option><option value="disabled">关闭 Skill，使用通用流程</option>
      {state.skillChoices.map((skill) => <option key={skill.versionId} value={skill.versionId}>{skill.name} · 版本 {skill.versionNumber}</option>)}
    </select></label>
    <button disabled={!available} onClick={() => void replies.explore()}>更新理解</button>
    {state.exploration.phase === 'waiting' && <p role="status">正在理解本次情境…</p>}
    {state.exploration.phase === 'failed' && <p role="alert">方向建议暂不可用，请核对输入或更新策略后明确重试。</p>}
    {state.exploration.phase === 'paused' && <p role="status">本次已暂停。需要继续时，请明确开启新的探索。</p>}
    {result && <>
      <p>{result.understanding}</p>
      <p>{result.usedSkill ? `实际 Skill：${result.usedSkill.name} · 版本 ${result.usedSkill.versionNumber}` : '本次使用通用流程。'}</p>
      <details open><summary>本次理解的依据</summary>{result.evidence.filter((item) => result.citationIds.includes(item.evidenceId))
        .map((item) => <p key={item.evidenceId}>{item.text}</p>)}</details>
      {result.ambiguities.map((text) => <p key={text}>尚未确定：{text}</p>)}
      {result.currentStep && <p>当前一步：{result.currentStep}</p>}
      {result.tradeoffs.map((text) => <p key={text}>表达取舍：{text}</p>)}
      {result.confirmedIntent && <p>已确认本次意愿：{result.confirmedIntent}</p>}
      {result.directions.map((option) => <div key={option.suggestionId}>
        <button aria-label={`确认方向：${option.title}`} disabled={!available}
          onClick={() => void replies.selectDirection(option.suggestionId, result.inputVersion)}>
          {option.title} · {option.pause ? '暂停' : result.question || result.ambiguities.length ? '确认方向，继续澄清' : '确认并生成'}
        </button>
        <p>{option.direction} {option.reason}{option.recommended ? ' 推荐依据见当前引用。' : ''}</p>
        {result.evidence.filter((item) => option.citationIds.includes(item.evidenceId)).map((item) => <small key={item.evidenceId}>{item.text}</small>)}
      </div>)}
      {result.question && <div role="group" aria-label="关键澄清">
        <p>{result.question.text}</p>
        <label>关键问题回答<textarea aria-label="关键问题回答" maxLength={4096} value={answer} disabled={!available}
          onChange={(event) => setAnswer(event.target.value)} /></label>
        <button disabled={!available || !answer.trim()} onClick={() => void replies.answerClarification(answer.trim(), result.inputVersion, result.question!.questionId)}>提交回答</button>
      </div>}
      <button disabled={!available || Boolean(result.confirmedIntent)} onClick={() => void replies.explore(true)}>换一组方向</button>
      <button disabled={!available} onClick={() => void replies.stopExploration()}>暂停本次探索</button>
    </>}
    {state.exploration.canRetry && <button disabled={!available} onClick={() => void replies.retryExploration()}>重试策略操作</button>}
    <p>纠正理解只更新建议，回答只补充信息。确认本次意愿后才生成候选，最终由你亲自发送。</p>
  </section>;
}
