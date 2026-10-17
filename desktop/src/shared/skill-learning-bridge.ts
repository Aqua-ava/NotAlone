import type { ContactSelection } from './contact-session-bridge';

export interface SkillDraft {
  draft_id: string; revision: number; status: 'pending' | 'published' | 'rejected'; logical_skill_id: string;
  proposal_kind: 'create' | 'update' | 'merge';
  sanitized_strategy: { name: string; description: string; scene: string; document: string;
    methods: Array<{ method_id: string; logical_skill_id: string; key: string; title: string; instruction: string;
      replaces_method_ids: string[]; mapping_status: 'new' | 'requires_review' }>;
    scope_suggestion: { kind: 'contact' | 'scene' | 'owner'; reason: string; contact_id: string | null } };
  private_evidence: { materials: Array<{ material_id: string; session_id: string; kind: string;
    priority: string; content: unknown; candidates?: Array<{candidate_id:string;message_group:Array<{message_id:string;text:string}>}>; external_messages: Array<{ message_id: string; text: string; speaker: string }> }>;
    existing_skills: unknown[]; source_dependencies: string[] };
  target_versions: Array<{ skill_id: string; version_id: string; version_number: number }>;
  comparison?: SkillComparison | null;
  last_decision?: 'defer' | 'approve' | 'reject' | null;
}
export interface SkillComparisonInput { incoming_text: string; intent: string; scene: string }
export interface SkillPublicationScope { kind: 'contact' | 'scene' | 'owner'; contact_id: string | null; scene: string | null }
export interface SkillStrategyEdit {
  name: string; description: string; scene: string;
  methods: Array<{ key: string; title: string; instruction: string; replaces_method_ids: string[] }>;
}
export interface SkillComparison {
  comparison_id: string; draft_revision: number; input_version: string; input: SkillComparisonInput;
  scope: SkillPublicationScope; valid: boolean;
  before: SkillComparisonSide; after: SkillComparisonSide;
}
export interface SkillComparisonSide {
  name: string | null; version_id: string | null; load_state: 'loaded' | 'resource_failed' | 'not_used';
  execution_view?: { policy_revision: number; method_ids: string[]; sha256: string };
  candidates: Array<{ text: string; basis: string; risk_notes: string[] }>;
}
export interface SkillPublication {
  skill_id: string; version_id: string; version_number: number; name: string;
  scope: SkillPublicationScope; revision: number;
}
export interface SkillReviewForm { strategy: SkillStrategyEdit; input: SkillComparisonInput; scope: SkillPublicationScope }
export interface SkillDraftReview {
  contactId: string; draft: SkillDraft; form: SkillReviewForm; comparison: SkillComparison | null;
  dirty: boolean; stale: boolean; phase: 'ready' | 'saving' | 'comparing' | 'publishing' | 'deciding' | 'failed';
  error: string | null; published: SkillPublication | null;
  retry: 'edit' | 'compare' | 'approve' | 'decision' | null;
}
export type SkillReviewSelection = ContactSelection & { draftId: string; expectedRevision: number };
export interface SkillVersionHistory {
  skill_id: string; name: string; status: 'active' | 'disabled'; revision: number; current_version_id: string | null;
  versions: Array<{ version_id: string; version_number: number; document: string; is_current: boolean; enabled: boolean;
    scope: SkillPublicationScope; source_dependency_count: number;
    methods: Array<{ method_id: string; title: string; instruction: string; replaces_method_ids: string[]; mapping_state: string }> }>;
}
export interface SkillHistoryState {
  phase: 'loading' | 'ready' | 'writing' | 'failed'; skills: SkillVersionHistory[]; error: string | null; retry: boolean;
}
export interface SkillPolicy {
  policy_id: string; skill_id: string; name: string; method_id: string | null; scope: SkillPublicationScope; revision: number;
}
export interface SkillPolicyState {
  phase: 'loading' | 'ready' | 'writing' | 'failed'; revision: number; policies: SkillPolicy[]; error: string | null; retry: boolean;
}
export type SkillPolicySelection = ContactSelection & {
  skillId: string; versionId: string; methodId: string | null; policyScope: SkillPublicationScope;
};
export interface SkillLearningState {
  revision: number; contactId: string | null; scopeRevision: number;
  phase: 'idle' | 'loading' | 'ready' | 'failed'; enabled: boolean; settingRevision: number; drafts: SkillDraft[];
  task: { task_id: string; status: string; error_code: string | null } | null;
  recentOutcomes: Array<'draft' | 'reuse' | 'no_change'>; error: string | null;
  review: SkillDraftReview | null;
  history: SkillHistoryState | null;
  policies: SkillPolicyState | null;
}
export interface SkillLearningBridge {
  getState(): Promise<SkillLearningState>;
  refresh(selection: ContactSelection): Promise<void>;
  configure(selection: ContactSelection & { enabled: boolean; confirmed: true }): Promise<void>;
  resume(selection: ContactSelection): Promise<void>;
  openReview(selection: ContactSelection & { draftId: string }): Promise<void>;
  updateReview(selection: SkillReviewSelection & { form: SkillReviewForm }): Promise<void>;
  saveReview(selection: SkillReviewSelection): Promise<void>;
  compareReview(selection: SkillReviewSelection): Promise<void>;
  approveReview(selection: SkillReviewSelection & { comparisonId: string; confirmed: true; replacementsConfirmed: true }): Promise<void>;
  decideReview(selection: SkillReviewSelection & { decision: 'reject' | 'defer' }): Promise<void>;
  retryReview(selection: SkillReviewSelection): Promise<void>;
  closeReview(selection: ContactSelection): Promise<void>;
  openHistory(selection: ContactSelection): Promise<void>;
  closeHistory(selection: ContactSelection): Promise<void>;
  rollbackHistory(selection: ContactSelection & { skillId: string; versionId: string }): Promise<void>;
  retryHistory(selection: ContactSelection): Promise<void>;
  openPolicies(selection: ContactSelection): Promise<void>;
  closePolicies(selection: ContactSelection): Promise<void>;
  changePolicy(selection: SkillPolicySelection): Promise<void>;
  undoPolicy(selection: ContactSelection & { policyId: string }): Promise<void>;
  retryPolicy(selection: ContactSelection): Promise<void>;
  onStateChanged(listener: (state: SkillLearningState) => void): () => void;
}
