import { useEffect, useRef, useState } from 'react';
import type { ReplySessionView } from './RewritePanel';
import { ReplySceneInput } from './ReplySceneInput';

export function StrategyControls({ replies }: { replies: ReplySessionView }) {
  const { state } = replies, result = state.exploration.result;
  const [answerDraft, setAnswerDraft] = useState({ question: '', text: '' });
  const pausedQuestion = useRef('');
  const question = result?.question ? `${result.inputVersion}:${result.question.questionId}` : '';
  const answer = question && answerDraft.question === question ? answerDraft.text : '';
  useEffect(() => { pausedQuestion.current = ''; setAnswerDraft({ question: '', text: '' }); },
    [state.contactId, state.scopeRevision, state.mode, state.inputClearRevision]);
  const available = Boolean(state.contactId) && !state.generationBlock && state.phase !== 'waiting'
    && state.exploration.phase !== 'waiting' && (state.mode !== 'reply_to_message' || Boolean(state.targetMessageId));
  return <section className="strategy-controls" aria-label="理解与方向">
    <div className="strategy-heading">
      <div><h2>理清沟通方向</h2><p>先明确怎么聊，再生成具体说法。</p></div>
      <button className="primary" disabled={!available} onClick={() => void replies.explore()}>帮我理清方向</button>
    </div>
    <div className="strategy-form-grid">
      <label className="strategy-field">纠正理解<span>助手理解有偏差时，在这里补充</span>
        <textarea aria-label="纠正理解" rows={2} maxLength={4096} value={state.correction}
          placeholder="例如：只是普通问候，不是想约见面"
          disabled={!state.contactId} onChange={(event) => void replies.updateCorrection(event.target.value)} /></label>
      <label className="strategy-field">本次要求<span>只约束这一次的表达</span>
        <textarea aria-label="本次策略要求" rows={2} maxLength={4096} value={state.requirements}
          placeholder="例如：简短自然，不提见面"
          disabled={!state.contactId} onChange={(event) => void replies.updateRequirements(event.target.value)} /></label>
    </div>
    <div className="strategy-actions">
      <button disabled={!available} onClick={() => void replies.explore()}>更新理解</button>
      <span className="strategy-note">补充或纠正后，更新方向建议。</span>
    </div>
    <details className="strategy-settings">
      <summary>场景与策略设置（可选）</summary>
      <ReplySceneInput replies={replies} />
      <label className="strategy-field">策略选择<select aria-label="策略选择" disabled={!available} value={state.skillChoice.mode === 'user' ? state.skillChoice.versionId! : state.skillChoice.mode}
        onChange={(event) => void replies.updateSkill(event.target.value === 'auto' || event.target.value === 'disabled'
          ? { mode: event.target.value, versionId: null } : { mode: 'user', versionId: event.target.value })}>
        <option value="auto">按当前场景选择</option><option value="disabled">关闭 Skill，使用通用流程</option>
        {state.skillChoices.map((skill) => <option key={skill.versionId} value={skill.versionId}>{skill.name} · 版本 {skill.versionNumber}</option>)}
      </select></label>
    </details>
    {state.exploration.automaticUpdatesPaused && state.errorCode !== 'provider_context_limit'
      && <p className="strategy-status" role="status">本次自动更新已暂停，请点“更新理解”继续。</p>}
    {state.exploration.phase === 'waiting' && <p className="strategy-status" role="status">正在理解本次情境…</p>}
    {state.exploration.phase === 'failed' && state.errorCode !== 'provider_context_limit'
      && <p className="strategy-status" role="alert">方向建议暂不可用，请核对输入或更新策略后明确重试。</p>}
    {state.exploration.phase === 'paused' && <p className="strategy-status" role="status">本次已暂停。需要继续时，请明确开启新的探索。</p>}
    {result && <div className="strategy-result">
      <section className="strategy-summary" aria-label="当前理解">
        <h3>助手对这次沟通的理解</h3>
        <p>{result.understanding}</p>
        {result.currentStep && <p className="strategy-current-step"><strong>建议下一步</strong>{result.currentStep}</p>}
        {result.confirmedIntent && <p className="strategy-confirmed"><strong>已确认本次意愿：</strong>{result.confirmedIntent}</p>}
        <p className="strategy-meta">{result.usedSkill ? `实际 Skill：${result.usedSkill.name} · 版本 ${result.usedSkill.versionNumber}` : '本次使用通用流程。'}</p>
      </section>
      <details className="strategy-details"><summary>本次理解的依据</summary>
        <div className="strategy-evidence">{result.evidence.filter((item) => result.citationIds.includes(item.evidenceId))
          .map((item) => <p key={item.evidenceId}>{item.text}</p>)}</div>
      </details>
      {(result.ambiguities.length > 0 || result.tradeoffs.length > 0) && <details className="strategy-details">
        <summary>待确认的事项与表达取舍</summary>
        {result.ambiguities.length > 0 && <div><h4>尚未确定</h4><ul>{result.ambiguities.map((text) => <li key={text}>{text}</li>)}</ul></div>}
        {result.tradeoffs.length > 0 && <div><h4>表达取舍</h4><ul>{result.tradeoffs.map((text) => <li key={text}>{text}</li>)}</ul></div>}
      </details>}
      {result.directions.length > 0 && <section aria-label="可选沟通方向">
        <div className="strategy-heading"><div><h3>选择沟通方向</h3><p>这是沟通思路，确认后再生成消息。</p></div></div>
        <div className="strategy-direction-grid">{result.directions.map((option) => <article
          className={`strategy-direction-card${option.recommended ? ' is-recommended' : ''}`} key={option.suggestionId}>
          <div className="strategy-direction-header"><h4>{option.title}</h4>{option.recommended && <span>建议方向</span>}</div>
          <p>{option.direction}</p><p className="strategy-note">{option.reason}{option.recommended ? ' 推荐依据见当前引用。' : ''}</p>
          {option.citationIds.length > 0 && <details className="strategy-details"><summary>查看方向依据</summary>
            <div className="strategy-evidence">{result.evidence.filter((item) => option.citationIds.includes(item.evidenceId))
              .map((item) => <p key={item.evidenceId}>{item.text}</p>)}</div>
          </details>}
          <button aria-label={`确认方向：${option.title}`} disabled={!available}
            onClick={() => void replies.selectDirection(option.suggestionId, result.inputVersion)}>
            {option.pause ? '暂停' : result.question || result.ambiguities.length ? '确认方向，继续澄清' : '确认方向'}
          </button>
        </article>)}</div>
      </section>}
      {result.question && <div className="strategy-question" role="group" aria-label="关键澄清">
        <h3>还需要你确认</h3><p>{result.question.text}</p>
        <label className="strategy-field">关键问题回答<textarea id="reply-clarification-answer" aria-label="关键问题回答" rows={3} maxLength={4096} value={answer} disabled={!available}
          placeholder="在这里补充你的想法"
          onChange={(event) => {
            setAnswerDraft({ question, text: event.target.value });
            if (pausedQuestion.current !== question) {
              pausedQuestion.current = question;
              void replies.beginClarificationEdit(result.inputVersion, result.question!.questionId);
            }
          }} /></label>
        <button disabled={!available || !answer.trim()} onClick={() => {
          pausedQuestion.current = '';
          void replies.answerClarification(answer.trim(), result.inputVersion, result.question!.questionId);
        }}>提交回答</button>
      </div>}
      <div className="strategy-actions">
        <button disabled={!available || Boolean(result.confirmedIntent)} onClick={() => void replies.explore(true)}>换一组方向</button>
        <button disabled={!available} onClick={() => void replies.stopExploration()}>暂停本次探索</button>
      </div>
    </div>}
    {state.exploration.canRetry && <button disabled={!available} onClick={() => void replies.retryExploration()}>重试策略操作</button>}
    <p className="strategy-note">纠正理解只更新建议，回答只补充信息。确认本次意愿后，点击生成才创建候选，最终由你亲自发送。</p>
  </section>;
}
