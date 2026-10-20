import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { SkillDraft, SkillLearningState, SkillPolicySelection, SkillReviewForm, SkillReviewSelection, SkillStrategyEdit } from '../../shared/skill-learning-bridge';
import { isUuid } from '../uuid';
import { createHash, randomUUID } from 'node:crypto';
import { BackendRequestFailure } from '../backend/json-client';
import { readComparison, readPublication, readPublicationScope, readReviewForm, readReviewInput, readStrategyEdit, sameInput, sameScope, sameStrategy } from './review-validation';
import { SkillHistorySession } from './history';
import { SkillPolicySession, readPolicyScope } from './policies';

type Scope = ContactSelection & { generation: number };
type ReviewAction = 'edit' | 'compare' | 'approve' | 'decision';
export class SkillLearningController {
  private state: SkillLearningState = { revision: 0, contactId: null, scopeRevision: 0, phase: 'idle',
    enabled: false, settingRevision: 0, drafts: [], task: null, recentOutcomes: [], error: null, review: null, history: null, policies: null };
  private readonly history: SkillHistorySession;
  private readonly policies: SkillPolicySession;
  private scope: Scope | undefined;
  private operation = 0;
  private pending: AbortController | undefined;
  private mutating = false;
  private refreshing: { scope: Scope; promise: Promise<void> } | undefined;
  private reviewOperation = 0;
  private reviewPending: AbortController | undefined;
  private reviewBusy = false;
  private reviewBackground = false;
  private readonly reviewKeys = new Map<string, string>();
  private reviewRetry: { scope: Scope; draftId: string; action: ReviewAction; body: Record<string, unknown> } | undefined;
  private readonly deletions = new Set<object>();
  private readonly listeners = new Set<(state: SkillLearningState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    this.history = new SkillHistorySession(backend, () => this.scope, history => this.publish({ history }));
    this.policies = new SkillPolicySession(backend, () => this.scope, policies => this.publish({ policies }));
    contacts.onStateChanged(() => this.synchronize());
    backend.onStateChanged(() => this.synchronize());
    this.synchronize();
  }
  getState() { return structuredClone(this.state); }
  onStateChanged(listener: (state: SkillLearningState) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private synchronize() {
    const contacts = this.contacts.getState(); const generation = this.backend.getConnectionGeneration();
    const next = generation !== undefined && contacts.selectedContactId !== null && contacts.directoryPhase === 'ready'
      && contacts.contacts.some((item) => item.contactId === contacts.selectedContactId)
      ? { contactId: contacts.selectedContactId, scopeRevision: contacts.scopeRevision, generation } : undefined;
    if (next?.contactId === this.scope?.contactId && next?.scopeRevision === this.scope?.scopeRevision && next?.generation === this.scope?.generation) return;
    this.scope = next; this.clear();
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contacts.scopeRevision });
  }
  private clear() {
    this.refreshing = undefined;
    this.history.clear();
    this.policies.clear();
    ++this.operation; this.pending?.abort(); this.pending = undefined; this.mutating = false;
    ++this.reviewOperation; this.reviewPending?.abort(); this.reviewPending = undefined; this.reviewBusy = false; this.reviewBackground = false; this.reviewKeys.clear(); this.reviewRetry = undefined;
    this.publish({ drafts: [], task: null, recentOutcomes: [], enabled: false, settingRevision: 0, phase: 'idle', error: null, review: null });
  }
  invalidate() { this.clear(); }
  // 删除按真实操作结算；范围切换、重连和重复状态通知都不能解除尚未结算的隔离。
  beginDeletion(): () => void {
    const operation = {};
    this.deletions.add(operation);
    this.clear();
    return () => { if (this.deletions.delete(operation)) this.clear(); };
  }
  private assertScope(selection: ContactSelection, background = false): Scope {
    this.synchronize();
    if (!this.scope || selection.contactId !== this.scope.contactId || selection.scopeRevision !== this.scope.scopeRevision) throw new Error('学习联系人已变化，请重新选择。');
    // 前台动作可抢占只读核验；已经提交的写入仍由原操作结算。
    if (!background && this.reviewBackground) {
      ++this.reviewOperation; this.reviewPending?.abort(); this.reviewPending = undefined;
      this.reviewBusy = false; this.reviewBackground = false;
    }
    return this.scope;
  }
  async poll(selection: ContactSelection) { await this.refresh(selection, true); }
  async refresh(selection: ContactSelection, background = false): Promise<void> {
    const scope = this.assertScope(selection, background);
    if (this.refreshing?.scope === scope) {
      if (!background && this.pending && !this.mutating && this.state.phase === 'ready') this.publish({ phase: 'loading', error: null });
      return this.refreshing.promise;
    }
    if (this.deletions.size || this.reviewBusy || this.mutating) return;
    const refresh = { scope, promise: Promise.resolve() };
    refresh.promise = this.refreshScope(scope, background).finally(() => {
      if (this.refreshing === refresh) this.refreshing = undefined;
    });
    this.refreshing = refresh;
    return refresh.promise;
  }
  private async refreshScope(scope: Scope, background: boolean) {
    if (this.deletions.size || this.reviewBusy || this.mutating) return;
    // 未知提交结果保留给用户显式重试，自动刷新不能重放写操作。
    if (this.reviewRetry && this.state.review) return;
    const current = () => this.scope === scope && !this.deletions.size;
    if (this.state.review?.published) await this.performReview(scope, this.state.review.draft.draft_id, undefined, undefined, background);
    else await this.perform(scope, 'GET', undefined, background);
    if (!current()) return;
    if (this.state.history) await this.history.open(scope, background);
    if (current() && this.state.policies) await this.policies.open(scope, background);
  }
  async configure(selection: ContactSelection & { enabled: boolean; confirmed: true }) {
    const scope = this.assertScope(selection);
    if (this.state.phase !== 'ready') throw new Error('请先刷新核验已保存的经验整理授权。');
    await this.perform(scope, 'POST', { enabled: selection.enabled, confirmed: true,
      operation_key: randomUUID(), expected_revision: this.state.settingRevision });
  }
  async resume(selection: ContactSelection) { await this.perform(this.assertScope(selection), 'POST', { resume: true }); }
  async openReview(selection: ContactSelection & { draftId: string }) {
    const scope = this.assertScope(selection);
    if (this.deletions.size || this.reviewBusy) return;
    this.history.clear();
    if (!this.state.drafts.some(draft => draft.draft_id === selection.draftId)) throw new Error('请刷新并选择当前待审核草稿。');
    await this.performReview(scope, selection.draftId);
  }
  async openHistory(selection: ContactSelection) {
    const scope = this.assertScope(selection);
    if (this.deletions.size || this.reviewBusy) return;
    await this.history.open(scope);
  }
  async closeHistory(selection: ContactSelection) { this.assertScope(selection); this.history.clear(); this.policies.clear(); }
  async openPolicies(selection: ContactSelection) {
    const scope = this.assertScope(selection);
    if (!this.deletions.size) await this.policies.open(scope);
  }
  async closePolicies(selection: ContactSelection) { this.assertScope(selection); this.policies.clear(); }
  async changePolicy(selection: SkillPolicySelection) {
    const scope = this.assertScope(selection);
    if (this.deletions.size) throw new Error('来源删除仍在核验。');
    const version = this.state.history?.skills.find(item => item.skill_id === selection.skillId)?.versions.find(item => item.version_id === selection.versionId);
    if (this.state.history?.phase !== 'ready' || !version || selection.methodId !== null && !version.methods.some(item => item.method_id === selection.methodId)) throw new Error('请先选择已核验的明确方法或整个Skill。');
    await this.policies.change(scope, { skill_id: selection.skillId, version_id: selection.versionId, method_id: selection.methodId,
      scope: readPolicyScope(selection.policyScope, scope.contactId), disabled: true });
  }
  async retryPolicy(selection: ContactSelection) {
    const scope = this.assertScope(selection);
    if (this.deletions.size) throw new Error('来源删除仍在核验。');
    await this.policies.retryOriginal(scope);
  }
  async undoPolicy(selection: ContactSelection & { policyId: string }) {
    const scope = this.assertScope(selection);
    if (this.deletions.size) throw new Error('来源删除仍在核验。');
    await this.policies.undo(scope, selection.policyId);
  }
  async rollbackHistory(selection: ContactSelection & { skillId: string; versionId: string }) {
    const scope = this.assertScope(selection);
    if (this.deletions.size) throw new Error('来源删除仍在核验。');
    await this.history.rollback(scope, selection.skillId, selection.versionId);
  }
  async retryHistory(selection: ContactSelection) {
    const scope = this.assertScope(selection);
    if (this.deletions.size) throw new Error('来源删除仍在核验。');
    await this.history.retryOriginal(scope);
  }
  updateReview(selection: SkillReviewSelection & { form: SkillReviewForm }) {
    const { review, scope } = this.assertReview(selection);
    const form = readReviewForm(selection.form, scope.contactId);
    this.assertMappings(review.draft, form.strategy);
    if (sameStrategy(form.strategy, review.form.strategy) && sameInput(form.input, review.form.input) && sameScope(form.scope, review.form.scope)) return;
    this.publish({ review: { ...review, form, comparison: null, dirty: !sameStrategy(form.strategy, strategyOf(review.draft)), error: null, phase: 'ready' } });
  }
  async saveReview(selection: SkillReviewSelection) {
    const { scope, review } = this.assertReview(selection);
    const strategy = readStrategyEdit(review.form.strategy);
    this.assertMappings(review.draft, strategy);
    await this.performReview(scope, selection.draftId, 'edit', { expected_revision: selection.expectedRevision, strategy });
  }
  async compareReview(selection: SkillReviewSelection) {
    const { scope, review } = this.assertReview(selection);
    if (review.dirty) throw new Error('请先显式保存方法编辑，再生成对照。');
    const input = readReviewInput(review.form.input);
    const publicationScope = readPublicationScope(review.form.scope, scope.contactId, input.scene);
    await this.performReview(scope, selection.draftId, 'compare', { expected_revision: selection.expectedRevision, input, scope: publicationScope });
  }
  async approveReview(selection: SkillReviewSelection & { comparisonId: string; confirmed: true; replacementsConfirmed: true }) {
    const { scope, review } = this.assertReview(selection);
    const comparison = review.comparison;
    if (selection.confirmed !== true || selection.replacementsConfirmed !== true || review.dirty || !comparison?.valid
      || comparison.comparison_id !== selection.comparisonId || comparison.draft_revision !== selection.expectedRevision
      || !sameInput(comparison.input, readReviewInput(review.form.input)) || !sameScope(comparison.scope, review.form.scope)) throw new Error('请重新生成有效对照并确认事实、承诺、范围和替代映射。');
    await this.performReview(scope, selection.draftId, 'approve', { expected_revision: selection.expectedRevision,
      comparison_id: comparison.comparison_id, confirmed: true, replacements_confirmed: true, scope: comparison.scope });
  }
  async decideReview(selection: SkillReviewSelection & { decision: 'reject' | 'defer' }) {
    const { scope } = this.assertReview(selection);
    if (!['reject', 'defer'].includes(selection.decision)) throw new Error('审核决定无效。');
    await this.performReview(scope, selection.draftId, 'decision', { expected_revision: selection.expectedRevision, decision: selection.decision });
  }
  async retryReview(selection: SkillReviewSelection) {
    const { scope } = this.assertReview(selection, true), retry = this.reviewRetry;
    if (!retry || retry.scope !== scope || retry.draftId !== selection.draftId) throw new Error('没有待核验的原操作。');
    await this.performReview(scope, retry.draftId, retry.action, retry.body);
  }
  closeReview(selection: ContactSelection) {
    this.assertScope(selection);
    ++this.reviewOperation; this.reviewPending?.abort(); this.reviewPending = undefined; this.reviewBusy = false; this.reviewBackground = false;
    this.reviewRetry = undefined;
    this.publish({ review: null, phase: 'ready', error: null });
  }
  private assertReview(selection: SkillReviewSelection, retry = false) {
    const scope = this.assertScope(selection), review = this.state.review;
    if (this.deletions.size || this.reviewBusy || !review || review.stale || !retry && this.reviewRetry || review.draft.status !== 'pending'
      || review.draft.draft_id !== selection.draftId || review.draft.revision !== selection.expectedRevision) throw new Error('审核草稿已变化，请重新打开。');
    return { scope, review };
  }
  private assertMappings(draft: SkillDraft, strategy: SkillStrategyEdit) {
    const known = new Set(draft.sanitized_strategy.methods.flatMap(method => method.replaces_method_ids));
    if (strategy.methods.some(method => method.replaces_method_ids.some(id => !known.has(id)))) throw new Error('替代映射只能选择原版本已有方法。');
  }
  private operationKey(signature: string) {
    const digest = createHash('sha256').update(signature).digest('hex');
    let key = this.reviewKeys.get(digest);
    if (!key) {
      key = randomUUID(); this.reviewKeys.set(digest, key);
      if (this.reviewKeys.size > 100) this.reviewKeys.delete(this.reviewKeys.keys().next().value!);
    }
    return key;
  }
  private async performReview(scope: Scope, draftId: string, action?: ReviewAction, body?: Record<string, unknown>, background = false) {
    const previous = this.state.review;
    const operation = ++this.reviewOperation;
    ++this.operation; this.pending?.abort(); this.pending = undefined; this.mutating = false;
    this.reviewPending?.abort(); const pending = this.reviewPending = new AbortController(); this.reviewBusy = true;
    this.reviewBackground = background;
    const phase = action === 'edit' ? 'saving' : action === 'compare' ? 'comparing' : action === 'approve' ? 'publishing' : 'deciding';
    if (!action) this.reviewRetry = undefined;
    else this.reviewRetry = { scope, draftId, action, body: body! };
    this.publish({ phase: action || background && this.state.phase === 'ready' ? this.state.phase : 'loading', error: null,
      review: action && previous ? { ...previous, phase, error: null, ...(action === 'approve' ? {} : { comparison: null }) } : previous?.published ? previous : null });
    const requestBody = action ? { ...body, operation_key: this.operationKey(JSON.stringify({ draftId, action, body })) } : undefined;
    try {
      const result = await this.backend.requestJson({ method: action ? 'POST' : 'GET',
        path: `/api/contacts/${scope.contactId}/skill-learning/drafts/${draftId}${action ? `/${action}` : ''}`, body: requestBody, signal: pending.signal });
      if (operation !== this.reviewOperation || this.scope !== scope || result.generation !== scope.generation || this.deletions.size) return;
      const data = result.data as Record<string, unknown>;
      const draft = readDraft(data?.draft, scope.contactId, ['pending', 'published', 'rejected']);
      if (draft.draft_id !== draftId) throw new Error('审核草稿已变化。');
      const comparison = draft.comparison?.valid ? draft.comparison : null;
      if (action === 'compare' && (!comparison || !sameInput(comparison.input, body!.input as SkillReviewForm['input'])
        || !sameScope(comparison.scope, body!.scope as SkillReviewForm['scope']))) throw new Error('对照输入已变化。');
      const form = previous && action ? { ...previous.form, strategy: strategyOf(draft) }
        : formOf(draft, scope.contactId);
      if (comparison && action === 'compare') { form.input = comparison.input; form.scope = comparison.scope; }
      const published = action === 'approve' ? readPublication(data.published, scope.contactId, previous!.form.scope)
        : !action && draft.status === 'published' && previous?.published
          ? readPublication(data.published, scope.contactId, previous.published.scope) : null;
      if (action === 'approve' && (draft.status !== 'published' || published?.name !== draft.sanitized_strategy.name)) throw new Error('发布回执与草稿不一致。');
      const drafts = this.state.drafts.filter(item => item.draft_id !== draftId);
      if (draft.status === 'pending') drafts.push(draft);
      if (action === 'approve') this.history.clear();
      if (action) this.reviewKeys.clear();
      this.reviewRetry = undefined;
      this.publish({ phase: 'ready', drafts, review: action === 'decision' ? null : {
        contactId: scope.contactId, draft, form, comparison, published, dirty: false, stale: false, phase: 'ready', error: null, retry: null } });
    } catch (error) {
      if (operation === this.reviewOperation && this.scope === scope) {
        const rejected = error instanceof BackendRequestFailure && error.kind === 'response' && !!error.status && error.status < 500;
        if (rejected) { this.reviewRetry = undefined; this.reviewKeys.clear(); }
        this.publish({ phase: action ? 'ready' : 'failed', error: action ? null : '审核草稿暂不可用，请刷新重新打开。',
          review: error instanceof BackendRequestFailure && error.status === 404 ? null : action && previous ? { ...previous,
            comparison: null, retry: rejected ? null : action, stale: rejected && error.status === 409,
            phase: 'failed', error: rejected ? '草稿、来源或对照已变化，请重新打开核验。' : '操作未确认完成；请重试原操作，或重新打开核验。' } : null });
      }
    } finally { if (this.reviewPending === pending) { this.reviewPending = undefined; this.reviewBusy = false; this.reviewBackground = false; } }
  }
  private async perform(scope: Scope, method: 'GET' | 'POST', body?: unknown, background = false) {
    if (this.deletions.size || this.reviewBusy) return;
    if (this.mutating && this.scope === scope) return;
    const operation = ++this.operation; this.pending?.abort(); const pending = this.pending = new AbortController();
    this.mutating = method === 'POST';
    if (method === 'POST') this.reviewRetry = undefined;
    if (!background || this.state.phase !== 'ready') {
      this.publish({ phase: 'loading', ...(method === 'POST' ? { drafts: [], review: null } : {}), error: null });
    }
    try {
      const result = await this.backend.requestJson({ method, path: `/api/contacts/${scope.contactId}/skill-learning`, body, signal: pending.signal });
      if (operation !== this.operation || this.scope !== scope || result.generation !== scope.generation) return;
      const learning = readLearning(result.data, scope.contactId);
      let review = this.state.review;
      if (review?.draft.status === 'pending') {
        let current = learning.drafts.find(draft => draft.draft_id === review!.draft.draft_id);
        if (current?.revision === review.draft.revision && review.comparison) {
          const detail = await this.backend.requestJson({ method: 'GET',
            path: `/api/contacts/${scope.contactId}/skill-learning/drafts/${current.draft_id}`, signal: pending.signal });
          if (operation !== this.operation || this.scope !== scope || detail.generation !== scope.generation) return;
          const draft = readDraft((detail.data as Record<string, unknown>)?.draft, scope.contactId, ['pending', 'published', 'rejected']);
          if (draft.draft_id !== current.draft_id) throw new Error('审核草稿已变化。');
          current = draft;
          review = this.state.review;
        }
        if (!review || review.draft.draft_id !== current?.draft_id) {
          this.publish({ ...learning, review: current ? review : null, phase: 'ready' });
          return;
        }
        if (!current) review = null;
        else if (current.status !== 'pending' || current.revision !== review.draft.revision) review = { ...review, stale: true, comparison: null,
          error: '草稿已有新的修订，请重新打开核验；当前未保存编辑仍保留。' };
        else if (review.comparison && (!current.comparison?.valid || current.comparison.comparison_id !== review.comparison.comparison_id)) review = { ...review, comparison: null,
          error: '来源、目标或对照已变化，请重新生成并审核。' };
      }
      this.publish({ ...learning, review, phase: 'ready' });
    } catch {
      if (operation === this.operation && this.scope === scope) this.publish({ phase: 'failed', drafts: [], task: null, recentOutcomes: [], review: null, error: '经验整理暂不可用，请刷新重试。' });
    } finally { if (this.pending === pending) { this.pending = undefined; this.mutating = false; } }
  }
  private publish(change: Partial<SkillLearningState>) {
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}

function readLearning(value: unknown, contactId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('草稿格式无效。');
  const data = value as Record<string, unknown>;
  if (typeof data.enabled !== 'boolean' || !Number.isSafeInteger(data.scope_revision)
    || (data.scope_revision as number) < 0 || !Array.isArray(data.drafts) || !Array.isArray(data.recent_outcomes)
    || data.drafts.length > 100 || data.recent_outcomes.length > 5
    || !data.recent_outcomes.every((outcome) => ['draft', 'reuse', 'no_change'].includes(outcome))) throw new Error('草稿格式无效。');
  const drafts = data.drafts.map(raw => readDraft(raw, contactId, ['pending']));
  const task = data.task as SkillLearningState['task'];
  if (task !== null && (!task || !isUuid(task.task_id) || !['queued', 'running', 'verifying', 'succeeded', 'failed', 'cancelled'].includes(task.status))) throw new Error('学习进度无效。');
  return { enabled: data.enabled, settingRevision: data.scope_revision as number, drafts, task,
    recentOutcomes: data.recent_outcomes as SkillLearningState['recentOutcomes'] };
}

function readDraft(raw: unknown, contactId: string, statuses: SkillDraft['status'][]): SkillDraft {
    const draft = raw as SkillDraft;
    if (!draft || !isUuid(draft.draft_id) || !isUuid(draft.logical_skill_id) || !statuses.includes(draft.status)
      || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || !['create', 'update', 'merge'].includes(draft.proposal_kind)
      || !draft.sanitized_strategy || !boundedText(draft.sanitized_strategy.document, 24000)
      || !boundedText(draft.sanitized_strategy.name, 64) || !boundedText(draft.sanitized_strategy.description, 1024)
      || !boundedText(draft.sanitized_strategy.scene, 256)
      || !draft.sanitized_strategy.scope_suggestion
      || !['contact', 'scene', 'owner'].includes(draft.sanitized_strategy.scope_suggestion.kind)
      || !boundedText(draft.sanitized_strategy.scope_suggestion.reason, 1024)
      || draft.sanitized_strategy.scope_suggestion.contact_id !== (draft.sanitized_strategy.scope_suggestion.kind === 'contact' ? contactId : null)
      || !Array.isArray(draft.sanitized_strategy.methods) || draft.sanitized_strategy.methods.length < 1
      || draft.sanitized_strategy.methods.length > 6 || !draft.sanitized_strategy.methods.every((item) => item && isUuid(item.method_id)
        && item.logical_skill_id === draft.logical_skill_id && boundedText(item.key, 64)
        && boundedText(item.title, 256) && boundedText(item.instruction, 2048)
        && Array.isArray(item.replaces_method_ids) && item.replaces_method_ids.every(isUuid)
        && ['new', 'requires_review'].includes(item.mapping_status))
      || !draft.private_evidence || !Array.isArray(draft.private_evidence.materials)
      || draft.private_evidence.materials.length > 8 || !draft.private_evidence.materials.every((item) => item
        && isUuid(item.material_id) && isUuid(item.session_id)
        && ['assistant_discussion', 'assistant_usage', 'candidate_edit', 'candidate_selection', 'followup_observation'].includes(item.kind)
        && ['ordinary', 'correction'].includes(item.priority)
        && item.content !== null && typeof item.content === 'object'
        && (item.candidates === undefined || Array.isArray(item.candidates) && item.candidates.length <= 8
          && item.candidates.every(candidate => candidate && isUuid(candidate.candidate_id)
            && Array.isArray(candidate.message_group) && candidate.message_group.length <= 8
            && candidate.message_group.every(message => message && isUuid(message.message_id)
              && typeof message.text === 'string' && message.text.length <= 24000)))
        && Array.isArray(item.external_messages) && item.external_messages.length <= 6
        && item.external_messages.every((message) => message && isUuid(message.message_id)
          && typeof message.text === 'string' && message.text.length <= 24000
          && ['user', 'contact', 'unknown'].includes(message.speaker)))
      || !Array.isArray(draft.private_evidence.existing_skills)
      || !Array.isArray(draft.private_evidence.source_dependencies) || !draft.private_evidence.source_dependencies.every(isUuid)
      || !Array.isArray(draft.target_versions) || draft.target_versions.length > 8
      || !draft.target_versions.every((target) => target && isUuid(target.skill_id) && isUuid(target.version_id)
        && Number.isSafeInteger(target.version_number) && target.version_number >= 1)
      || draft.proposal_kind === 'create' && draft.target_versions.length !== 0
      || draft.proposal_kind === 'update' && draft.target_versions.length !== 1
      || draft.proposal_kind === 'merge' && draft.target_versions.length < 2
      || !(draft.last_decision === undefined || draft.last_decision === null || ['defer', 'approve', 'reject'].includes(draft.last_decision))) throw new Error('草稿格式无效。');
    if (draft.comparison !== undefined && draft.comparison !== null) {
      readComparison(draft.comparison, contactId, draft.revision);
      if (draft.comparison.after.name !== draft.sanitized_strategy.name) throw new Error('对照策略名称已变化。');
    }
    return structuredClone(draft);
}

function strategyOf(draft: SkillDraft): SkillStrategyEdit {
  const strategy = draft.sanitized_strategy;
  return { name: strategy.name, description: strategy.description, scene: strategy.scene,
    methods: strategy.methods.map(method => ({ key: method.key, title: method.title, instruction: method.instruction,
      replaces_method_ids: [...method.replaces_method_ids] })) };
}

function formOf(draft: SkillDraft, contactId: string): SkillReviewForm {
  const comparison = draft.comparison?.valid ? draft.comparison : null;
  const kind = draft.sanitized_strategy.scope_suggestion.kind;
  return { strategy: strategyOf(draft), input: comparison?.input ?? { incoming_text: '', intent: '', scene: draft.sanitized_strategy.scene },
    scope: comparison?.scope ?? { kind, contact_id: kind === 'contact' ? contactId : null,
      scene: kind === 'scene' ? draft.sanitized_strategy.scene : null } };
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}
