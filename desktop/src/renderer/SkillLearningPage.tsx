import { useEffect, useState } from 'react';
import type { ContactSessionView } from './contact-session';
import type { SkillComparisonSide, SkillDraft, SkillDraftReview, SkillLearningState, SkillPublicationScope, SkillReviewForm } from '../shared/skill-learning-bridge';
import { useRevisionedSession } from './use-revisioned-session';
import { SkillHistoryPanel } from './SkillHistoryPanel';
import { SkillPolicyPanel } from './SkillPolicyPanel';
import './skill.css';

const initial: SkillLearningState = { revision: -1, contactId: null, scopeRevision: 0, phase: 'idle', enabled: false, settingRevision: 0,
  drafts: [], task: null, recentOutcomes: [], error: null, review: null, history: null, policies: null };
const scopes = { contact: '当前联系人', scene: '同类场景', owner: '本人通用方法' };
const kinds = { create: '新建建议', update: '更新建议', merge: '合并建议' };
const materials: Record<string, string> = { assistant_discussion: '助手讨论', assistant_usage: '候选与使用痕迹',
  candidate_edit: '用户修改与纠正', candidate_selection: '明确候选选择', followup_observation: '任务后的有限观察' };

export function SkillLearningPage({ session }: { session: ContactSessionView }) {
  const bridge = window.notalone.skillLearning;
  const { state, error, setError } = useRevisionedSession(initial, bridge);
  const { selectedContactId: contactId, scopeRevision } = session.state;
  const [selection, setSelection] = useState<{ contactId: string; scopeRevision: number; tab: 'installed' | 'pending' } | null>(null);
  const tab = selection?.contactId === contactId && selection.scopeRevision === scopeRevision ? selection.tab : 'installed';
  const current = contactId !== null && state.contactId === contactId && state.scopeRevision === scopeRevision;
  useEffect(() => {
    if (!contactId) return;
    const refresh = () => { void bridge.refresh({ contactId, scopeRevision }).catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [bridge, contactId, scopeRevision]);
  useEffect(() => {
    if (contactId && current && tab === 'installed' && state.phase === 'ready' && !state.history) {
      void bridge.openHistory({ contactId, scopeRevision }).catch(() => {});
    }
  }, [bridge, contactId, scopeRevision, current, tab, state.phase, state.history, state.review?.phase]);
  if (!contactId) return <section className="empty-panel"><h2>请选择联系人</h2><p>选择联系人后，可查看适用的已有 Skill 和待审核建议。</p></section>;
  const run = (operation: Promise<void>) => { setError(''); void operation.catch(reason => setError(reason instanceof Error ? reason.message : 'Skill 操作暂不可用。')); };
  const configure = (enabled: boolean) => bridge.configure({ contactId, scopeRevision, enabled, confirmed: true });
  const review = current ? state.review : null;
  const selected = review && { contactId, scopeRevision, draftId: review.draft.draft_id, expectedRevision: review.draft.revision };
  const selectTab = (next: 'installed' | 'pending') => {
    setSelection({ contactId, scopeRevision, tab: next });
    if (next === 'installed' && current) run(bridge.openHistory({ contactId, scopeRevision }));
  };
  const pendingCount = current ? state.drafts.length : 0;
  return <section aria-label="Skill管理">
    <div className="skill-tabs" role="tablist" aria-label="Skill 分类" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'installed' : event.key === 'End' ? 'pending' : tab === 'installed' ? 'pending' : 'installed';
      selectTab(next);
      event.currentTarget.querySelector<HTMLButtonElement>(`#skill-tab-${next}`)?.focus();
    }}>
      <button type="button" role="tab" id="skill-tab-installed" aria-controls="skill-panel-installed" aria-selected={tab === 'installed'}
        tabIndex={tab === 'installed' ? 0 : -1} onClick={() => selectTab('installed')}>已有 Skill</button>
      <button type="button" role="tab" id="skill-tab-pending" aria-controls="skill-panel-pending" aria-selected={tab === 'pending'}
        tabIndex={tab === 'pending' ? 0 : -1} onClick={() => selectTab('pending')}>待审核{pendingCount > 0 && ` · ${pendingCount}`}</button>
    </div>
    {tab === 'installed' ? <div role="tabpanel" id="skill-panel-installed" aria-labelledby="skill-tab-installed">
      <p>查看当前联系人适用的已有 Skill、启用状态与版本内容。</p>
      <div className="button-row">
        <button className="button" disabled={!current || state.history?.phase === 'loading' || state.history?.phase === 'writing'}
          onClick={() => run(bridge.openHistory({ contactId, scopeRevision }))}>刷新已有 Skill</button>
        {current && state.history?.phase === 'ready' && <button className="button"
          onClick={() => run(bridge.openPolicies({ contactId, scopeRevision }))}>管理方法停用</button>}
      </div>
      {current && state.history ? <SkillHistoryPanel state={state.history}
        rollback={(skillId, versionId) => run(bridge.rollbackHistory({ contactId, scopeRevision, skillId, versionId }))}
        retry={() => run(bridge.retryHistory({ contactId, scopeRevision }))} /> : <p role="status">正在读取已有 Skill…</p>}
      {current && state.policies && <SkillPolicyPanel key={`${contactId}:${scopeRevision}`} state={state.policies} skills={state.history?.skills ?? []} contactId={contactId}
        change={target => run(bridge.changePolicy({ contactId, scopeRevision, ...target }))} undo={policyId => run(bridge.undoPolicy({ contactId, scopeRevision, policyId }))}
        retry={() => run(bridge.retryPolicy({ contactId, scopeRevision }))} close={() => run(bridge.closePolicies({ contactId, scopeRevision }))} />}
    </div> : <div role="tabpanel" id="skill-panel-pending" aria-labelledby="skill-tab-pending"><section aria-label="Skill待审核">
      <p>开启后，使用已配置模型整理此联系人的助手讨论、使用痕迹、修改及任务相关聊天。纠正优先，普通经验合批；可以没有新方法。</p>
      <p>后续聊天仅沿实际任务的外部消息锚点，使用同一已确认绑定24小时内的有限观察；时间相邻不证明方法有效或用户已发送。</p>
      <p>建议保存为独立草稿，尚未审核的内容不会影响回复。方法与私人审核依据分别保存，可随来源或助手会话删除。</p>
      <div className="button-row">
        <button className="button" disabled={!current || state.phase !== 'ready'} onClick={() => void configure(!state.enabled).catch(() => {})}>{state.enabled ? '关闭经验整理' : '开启此联系人的经验整理'}</button>
        <button className="button" onClick={() => void bridge.refresh({ contactId, scopeRevision }).catch(() => {})}>刷新待审核</button>
        {current && state.enabled && state.task && ['queued', 'failed', 'running', 'verifying'].includes(state.task.status)
          && <button className="button" onClick={() => void bridge.resume({ contactId, scopeRevision }).catch(() => {})}>继续整理</button>}
      </div>
      {current && <>
        <p role="status">待审核 {state.drafts.length} 项{state.task && ` · 整理状态：${({ queued: '等待', running: '整理中', verifying: '复核中', succeeded: '已完成', failed: '失败，可重试', cancelled: '已停止' } as Record<string, string>)[state.task.status]}`}</p>
        {state.recentOutcomes[0] === 'reuse' && <p>本批建议复用已有方法，没有新增草稿。</p>}
        {state.recentOutcomes[0] === 'no_change' && <p>本批没有值得保存的新方法。</p>}
        {!review && state.drafts.length === 0 && <p>暂无待审核建议。</p>}
        {!review && state.drafts.map(draft => <SkillDraftCard key={draft.draft_id} draft={draft}
          onReview={() => run(bridge.openReview({ contactId, scopeRevision, draftId: draft.draft_id }))} />)}
        {review && selected && <SkillReviewPanel key={`${contactId}:${scopeRevision}:${review.draft.draft_id}`} review={review} actions={{
          update: form => run(bridge.updateReview({ ...selected, form })), save: () => run(bridge.saveReview(selected)),
          compare: () => run(bridge.compareReview(selected)),
          approve: () => { if (review.comparison) run(bridge.approveReview({ ...selected, comparisonId: review.comparison.comparison_id, confirmed: true, replacementsConfirmed: true })); },
          decide: decision => run(bridge.decideReview({ ...selected, decision })), retry: () => run(bridge.retryReview(selected)),
          close: () => run(bridge.closeReview({ contactId, scopeRevision })),
          reopen: () => run(bridge.openReview({ contactId, scopeRevision, draftId: review.draft.draft_id })),
        }} />}
      </>}
    </section></div>}
    {state.error && <p role="alert">{state.error}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function SkillDraftCard({ draft, onReview }: { draft: SkillDraft; onReview?: () => void }) {
  const strategy = draft.sanitized_strategy;
  return <article className="memory-card" aria-label={`待审核 ${strategy.name}`}>
    <h2>{strategy.scene} · {strategy.name}</h2><p>{kinds[draft.proposal_kind]} · 修订 {draft.revision} · 尚未审核</p>
    {draft.last_decision === 'defer' && <p>已暂留，等待后续审核。</p>}
    <p>{strategy.description}</p>
    <p>建议范围：{scopes[strategy.scope_suggestion.kind]}。{strategy.scope_suggestion.reason}</p>
    {draft.target_versions.map((target) => <p key={target.version_id}>拟替代已有 Skill 的版本 {target.version_number}</p>)}
    <ul>{strategy.methods.map((method) => <li key={method.method_id}><b>{method.title}</b><p>{method.instruction}</p></li>)}</ul>
    <details><summary>查看真实来源与私人审核依据</summary>
      <p>选择或修改不证明已发送；后续反应不能单独证明方法有效。</p>
      {draft.private_evidence.materials.map((material) => <div key={material.material_id}>
        <h3>{materials[material.kind] ?? '参与材料'}{material.priority === 'correction' ? ' · 明确纠正优先' : ''}</h3>
        {privateText(material.content).map((text, index) => <p key={index}>{text}</p>)}
        {material.candidates?.map(candidate => <div key={candidate.candidate_id}><p>当时候选措辞，不代表用户已发送：</p>{candidate.message_group.map(message=><blockquote key={message.message_id}>{message.text}</blockquote>)}</div>)}
        {material.external_messages.map((message) => <blockquote key={message.message_id}>{message.text}</blockquote>)}
        <details><summary>核对来源定位</summary><p>助手会话：{material.session_id}</p><p>输入记录：{material.material_id}</p></details>
      </div>)}
      <details><summary>完整参与资料依赖</summary><ul>{draft.private_evidence.source_dependencies.map((identifier) => <li key={identifier}>{identifier}</li>)}</ul></details>
    </details>
    <details><summary>查看清洗后的策略正文</summary><pre>{strategy.document}</pre></details>
    {onReview && <button className="button" onClick={onReview}>打开对照审核</button>}
  </article>;
}

type ReviewActions = {
  update(form: SkillReviewForm): void; save(): void; compare(): void; approve(): void;
  decide(decision: 'reject' | 'defer'): void; retry(): void; close(): void; reopen(): void;
};

export function SkillReviewPanel({ review, actions }: { review: SkillDraftReview; actions: ReviewActions }) {
  const [factsConfirmed, setFactsConfirmed] = useState(false);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const { draft, form, comparison, published } = review;
  useEffect(() => { setFactsConfirmed(false); setMappingConfirmed(false); }, [comparison?.comparison_id, draft.revision]);
  const busy = !['ready', 'failed'].includes(review.phase);
  const blocked = busy || review.stale || !!review.retry || !!published;
  const change = (mutate: (next: SkillReviewForm) => void) => {
    const next = structuredClone(form); mutate(next); actions.update(next);
  };
  const mappings = knownMappings(draft);
  return <section className="skill-review" aria-label="Skill对照审核">
    <header><h2>审核 {draft.sanitized_strategy.name}</h2><p>{kinds[draft.proposal_kind]} · 草稿修订 {draft.revision}</p>
      <button className="button" onClick={actions.close}>返回待审核列表</button></header>
    {published ? <div className="skill-publication" role="status"><h3>已发布 {published.name} · 版本 {published.version_number}</h3>
      <p>适用范围：{scopeLabel(published.scope)}。后续候选通过该范围使用此版本。</p>
      <details><summary>查看发布版本</summary><p>{published.version_id}</p><p>Skill 库修订 {published.revision}</p></details></div> : <>
      {draft.target_versions.length > 0 && <section aria-label="版本变化与替代范围"><h3>逐项核对版本变化与替代范围</h3>
        <p>仅替代以下明确目标；所有实际参与策略与新材料的来源保守保留。不同范围的自动合并不予发布。</p>
        {draft.target_versions.map(target => {
          const previous = draft.private_evidence.existing_skills.find(item => !!item && typeof item === 'object'
            && (item as Record<string, unknown>).skill_id === target.skill_id) as Record<string, unknown> | undefined;
          return <section key={target.version_id}><h4>{typeof previous?.name === 'string' ? previous.name : target.skill_id} · 原版本 {target.version_number}</h4>
            <p>替代版本：{target.version_id}</p>
            {!!previous?.scope && <p>原适用范围：{scopeLabel(previous.scope as SkillPublicationScope)}</p>}
            <details><summary>查看原版本正文</summary><pre>{typeof previous?.document === 'string' ? previous.document : '原版本已不可用，请重新核验。'}</pre></details>
          </section>;
        })}
        <details open><summary>对照拟发布的新正文</summary><pre>{draft.sanitized_strategy.document}</pre></details>
      </section>}
      <p>策略正文只保存可复用方法，不能包含联系人身份、私人事实、原始聊天或未经确认的承诺。去掉姓名不能证明方法适合通用。</p>
      <fieldset className="skill-review-form" disabled={blocked}><legend>编辑清洗后的方法</legend>
        <label>Skill 名称<input value={form.strategy.name} maxLength={64} onChange={event => change(next => { next.strategy.name = event.target.value; })} /></label>
        <label>方法描述<textarea value={form.strategy.description} maxLength={1024} onChange={event => change(next => { next.strategy.description = event.target.value; })} /></label>
        <label>策略场景<input value={form.strategy.scene} maxLength={256} onChange={event => change(next => { next.strategy.scene = event.target.value; })} /></label>
        {form.strategy.methods.map((method, index) => <fieldset className="skill-method" key={index}><legend>方法 {index + 1}</legend>
          <label>方法标识<input value={method.key} maxLength={64} onChange={event => change(next => { next.strategy.methods[index].key = event.target.value; })} /></label>
          <label>方法标题<input value={method.title} maxLength={256} onChange={event => change(next => { next.strategy.methods[index].title = event.target.value; })} /></label>
          <label>方法正文<textarea value={method.instruction} maxLength={2048} onChange={event => change(next => { next.strategy.methods[index].instruction = event.target.value; })} /></label>
          {mappings.length ? <div><p>此方法延续或替代：</p>{mappings.map(mapping => <label className="skill-check" key={mapping.id}>
            <input type="checkbox" checked={method.replaces_method_ids.includes(mapping.id)} onChange={event => change(next => {
              next.strategy.methods[index].replaces_method_ids = event.target.checked ? [...method.replaces_method_ids, mapping.id]
                : method.replaces_method_ids.filter(id => id !== mapping.id);
            })} />{mapping.label}<small>{mapping.id}</small></label>)}</div> : <p>新方法，没有旧方法替代映射。</p>}
          <button className="button" disabled={form.strategy.methods.length <= 1} onClick={() => change(next => { next.strategy.methods.splice(index, 1); })}>移除方法 {index + 1}</button>
        </fieldset>)}
        <button className="button" disabled={form.strategy.methods.length >= 6} onClick={() => change(next => { next.strategy.methods.push({ key: '', title: '', instruction: '', replaces_method_ids: [] }); })}>添加方法</button>
        <button className="button" disabled={!review.dirty} onClick={actions.save}>保存方法编辑</button>
        <p>{review.dirty ? '方法编辑尚未保存，保存后须重新生成对照。' : '方法已保存；任何编辑都会使旧对照失效。'}</p>
      </fieldset>
      <fieldset className="skill-review-form" disabled={blocked}><legend>相同冻结输入与发布范围</legend>
        <label>对照来话<textarea value={form.input.incoming_text} maxLength={8192} onChange={event => change(next => { next.input.incoming_text = event.target.value; })} /></label>
        <label>当前意图与约束<textarea value={form.input.intent} maxLength={4096} onChange={event => change(next => { next.input.intent = event.target.value; })} /></label>
        <label>精确场景<input value={form.input.scene} maxLength={256} onChange={event => change(next => {
          next.input.scene = event.target.value; if (next.scope.kind === 'scene') next.scope.scene = event.target.value;
        })} /></label>
        <label>适用范围<select value={form.scope.kind} onChange={event => change(next => {
          const kind = event.target.value as SkillPublicationScope['kind'];
          next.scope = { kind, contact_id: kind === 'contact' ? review.contactId : null,
            scene: kind === 'scene' ? next.input.scene : null };
        })}><option value="contact">仅当前联系人</option><option value="scene">本人所有联系人中的精确场景</option><option value="owner">本人通用方法</option></select></label>
        <p>将发布到：{scopeLabel(form.scope)}。场景范围只在回复时明确输入相同场景才能使用。</p>
        <button className="button" disabled={review.dirty || !form.input.incoming_text.trim() || !form.input.intent.trim() || !form.input.scene.trim()} onClick={actions.compare}>相同输入生成对照</button>
      </fieldset>
      {comparison && <section className="skill-comparison" aria-label="冻结输入对照"><h3>同一输入的实际回复</h3>
        <p>输入版本：{comparison.input_version} · 草稿修订 {comparison.draft_revision}</p>
        <p>来话：{comparison.input.incoming_text}</p><p>当前意图：{comparison.input.intent}</p><p>精确场景：{comparison.input.scene}</p>
        <p>确认范围：{scopeLabel(comparison.scope)}</p>
        <div className="skill-comparison-grid"><ComparisonSide title="旧版本或无 Skill" side={comparison.before} />
          <ComparisonSide title="新草稿，仅本次隔离对照" side={comparison.after} /></div>
      </section>}
      <div className="skill-confirmations"><label className="skill-check"><input type="checkbox" checked={factsConfirmed} disabled={blocked || !comparison}
        onChange={event => setFactsConfirmed(event.target.checked)} />已核对当前意图、事实与承诺，并确认上述适用范围</label>
      <div>{draft.target_versions.map(target => <p key={target.version_id}>将替代 Skill {target.skill_id} 的版本 {target.version_number}</p>)}</div>
      <label className="skill-check"><input type="checkbox" checked={mappingConfirmed} disabled={blocked || !comparison}
        onChange={event => setMappingConfirmed(event.target.checked)} />{draft.proposal_kind === 'create' ? '确认新建方法且无替代关系' : '确认上述替代版本与方法延续映射'}</label></div>
      <div className="button-row"><button className="button" disabled={blocked || review.dirty || !comparison?.valid || !factsConfirmed || !mappingConfirmed} onClick={actions.approve}>批准并发布</button>
        <button className="button" disabled={blocked} onClick={() => actions.decide('reject')}>拒绝草稿</button>
        <button className="button" disabled={blocked} onClick={() => actions.decide('defer')}>暂留待审</button>
        {review.retry && <button className="button" disabled={busy} onClick={actions.retry}>重试原操作</button>}
        {(review.stale || review.retry) && <button className="button" disabled={busy} onClick={actions.reopen}>重新打开核验</button>}</div>
      <details><summary>核对原草稿与私人审核依据，仅当前联系人可见</summary><SkillDraftCard draft={draft} /></details>
    </>}
    {busy && <p role="status">{({ saving: '保存方法中', comparing: '生成隔离对照中', publishing: '核验并发布中', deciding: '保存审核决定中' } as Record<string, string>)[review.phase]}</p>}
    {review.error && <p role="alert">{review.error}</p>}
  </section>;
}

function ComparisonSide({ title, side }: { title: string; side: SkillComparisonSide }) {
  return <section className="memory-card" aria-label={title}><h4>{title}</h4>
    <p>{side.name ?? '无 Skill'} · {({ loaded: '已加载策略', resource_failed: '策略资源不可用', not_used: '未使用策略' })[side.load_state]}</p>
    {side.version_id && <p>版本：{side.version_id}</p>}
    {!!side.execution_view?.policy_revision && <p>已按明确范围排除方法，本次仅允许 {side.execution_view.method_ids.length} 个方法。</p>}
    {side.candidates.map((candidate, index) => <div key={index}><blockquote>{candidate.text}</blockquote><p>依据：{candidate.basis}</p>
      {candidate.risk_notes.map((note, position) => <p className="reply-risk" key={position}>{note}</p>)}</div>)}
  </section>;
}

function scopeLabel(scope: SkillPublicationScope) {
  return scope.kind === 'scene' ? `本人所有联系人 · 精确场景「${scope.scene}」` : scope.kind === 'owner' ? '本人通用方法' : '仅当前联系人';
}

function knownMappings(draft: SkillDraft) {
  const known = new Map<string, string>(draft.sanitized_strategy.methods.flatMap(method => method.replaces_method_ids.map(id => [id, `原有方法 ${id}`] as const)));
  for (const raw of draft.private_evidence.existing_skills) {
    const skill = raw as { name?: unknown; methods?: Array<{ method_id?: unknown; title?: unknown }> };
    if (typeof skill?.name !== 'string' || !Array.isArray(skill.methods)) continue;
    for (const method of skill.methods) if (typeof method.method_id === 'string' && known.has(method.method_id) && typeof method.title === 'string') known.set(method.method_id, `${skill.name} · ${method.title}`);
  }
  return [...known].map(([id, label]) => ({ id, label }));
}

function privateText(content: unknown): string[] {
  if (!content || typeof content !== 'object') return [];
  const labels: Record<string, string> = { correction: '明确纠正', requirements: '本次要求', purpose_hint: '用户目的',
    confirmed_intent: '已确认意愿', answer: '补充说明', draft: '用户草稿', direction: '表达方向', text: '文字' };
  const values: string[] = [];
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string' && value.trim() && labels[key]) values.push(`${labels[key]}：${value}`);
    else if (value && typeof value === 'object') values.push(...privateText(value));
  }
  return values;
}
