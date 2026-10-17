import type { ContactSelection } from './contact-session-bridge';

export type MemoryCategory = 'common_fact' | 'preference' | 'taboo' | 'recent_state' | 'relationship_note';
export type MemoryTopic = 'health' | 'work' | 'family' | 'travel' | 'finance' | 'study' | 'emotion' | 'other';
export type MemoryCurrentStatus = 'current_verified' | 'current_unverified' | 'historical' | 'stable';
export type MemoryEventStage = 'planned' | 'agreed' | 'rescheduled' | 'cancelled' | 'occurred' | 'unknown';
export interface MemoryEventEvidence { messageId: string; charStart: number; charEnd: number; }
export interface MemoryEvent {
  version: 1;
  stage: MemoryEventStage;
  stageVerified: boolean;
  stageEvidence: MemoryEventEvidence[];
  occurrenceStart: string | null;
  occurrenceEnd: string | null;
  occurrenceVerified: boolean;
  occurrenceEvidence: MemoryEventEvidence[];
}
export interface MemoryTiming {
  recordedAt: string | null;
  sourceStartedAt: string | null;
  sourceEndedAt: string | null;
  sourceTimeComplete: boolean;
  currentStatus: MemoryCurrentStatus;
  currentStatusReason: string;
}
export interface MemoryContent {
  text: string;
  category: MemoryCategory;
  topic: MemoryTopic;
  sourceIds: string[];
  confidence: number;
  riskFlags: string[];
  timing: MemoryTiming;
  validAt: string | null;
  invalidAt: string | null;
  event?: MemoryEvent | null;
}
export interface ActiveMemory extends MemoryContent {
  memoryId: string;
  level: 'contact' | 'owner';
  adoptionMethod: 'auto' | 'manual';
  status: 'active';
  revision: number;
  supersedesMemoryId: string | null;
  sourceCandidateId: string | null;
  canRevertAutoUpdate?: boolean;
  versionEvidenceSourceCurrent?: boolean;
}
export interface MemoryVersion extends Omit<ActiveMemory, 'status'> { status: 'active' | 'invalidated'; }
export interface MemoryHistoryState extends MemorySection<MemoryVersion> {
  memoryId: string | null;
  level: 'contact' | 'owner' | null;
}
export interface OverviewSourceReference {
  sourceId: string;
  sourceKind: 'source_document' | 'local_wechat_observation' | 'manual';
  messageId: string | null;
  sourceRefId: string | null;
  locator: string | null;
  contactId?: string | null;
}
export interface ContactOverviewEntry {
  memory: MemoryVersion;
  isLatest: boolean;
  currentLeaf: { memoryId: string; revision: number } | null;
  provenance: { kind: 'manual_entry' | 'source_supported' | 'unknown'; references: OverviewSourceReference[] };
}
export interface ContactRelationshipOverview {
  version: 1;
  scopeKind: 'contact';
  contactId: string;
  projectionRevision: string;
  memoryRevision: number;
  builtAt: string;
  entries: ContactOverviewEntry[];
}
export interface OwnerFactsPreferencesOverview extends Omit<ContactRelationshipOverview, 'scopeKind' | 'contactId'> {
  scopeKind: 'owner';
  contactId: null;
}
export interface MemoryOverviewState<T = ContactRelationshipOverview> {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  value: T | null;
}
export interface PendingMemoryCandidate extends MemoryContent {
  candidateId: string;
  subject: 'self' | 'contact' | 'shared';
  status: 'pending';
  correctionReview?: MemoryCorrectionReview[];
}
export interface MemoryCorrectionReview {
  decisionId: string;
  decision: 'corrected' | 'rejected';
  previousText: string;
  correctedText: string | null;
  newMessageIds: string[];
  newSourceIds: string[];
  semanticRelation: 'same' | 'uncertain';
  reason: string;
}
export interface MemorySource {
  sourceId: string;
  fileName: string | null;
  recordCount: number;
  status: 'active' | 'delete_requested' | 'deleting' | 'delete_failed' | 'deleted';
}
export interface MemorySection<T> {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  items: T[];
}
export type MemorySectionName = 'contact' | 'owner' | 'pending' | 'sources';
export interface LayeredMemoryReference {
  memoryId: string;
  revision: number;
  provenanceKind: 'manual_entry' | 'source_supported';
  timing: MemoryTiming;
}
export interface LayeredMemoryScenario {
  scenarioId: string;
  versionId: string;
  title: string;
  hint: string;
  systemGenerated: true;
  updatedAt: string;
  paragraphs: { text: string; references: LayeredMemoryReference[] }[];
}
export interface LayeredMemory {
  schemaVersion: 1;
  scopeKind: 'contact';
  contactId: string;
  settingsGeneration: number;
  enabled: boolean;
  qualityStatus: 'unknown' | 'synthetic';
  status: 'disabled' | 'ready' | 'empty' | 'failed' | 'updating' | 'paused' | 'stale' | 'blocked';
  workId: string | null;
  workRevision: number;
  currentBatch: number;
  modelCallsUsed: number;
  modelCallLimit: number;
  eligibleCount: number;
  coveredCount: number;
  remainingCount: number;
  mappingCursor: string | null;
  mappingNextCursor: string | null;
  maintenancePending: boolean;
  scenarioMappings: { sourceScenarioId: string; sourceVersionId: string; targets: { scenarioId: string; versionId: string }[] }[];
  organizationGeneration: number;
  updatedAt: string | null;
  errorCode: string | null;
  purpose: string;
  budget: { maxMemories: number; maxScenarios: number; maxParagraphs: number; maxCharacters: number; maxModelCalls: number };
  scenarios: LayeredMemoryScenario[];
}
export interface LayeredMemoryReadRequest extends ContactSelection { mappingCursor?: string | null }
export interface LayeredMemoryManagementRequest extends ContactSelection {
  action: 'enable' | 'refresh' | 'disable' | 'delete' | 'pause' | 'continue';
  settingsGeneration: number;
  purposeConfirmed?: true;
  workRevision?: number;
}
export interface MemoryReadingState {
  revision: number;
  contactId: string | null;
  scopeRevision: number;
  mutation: { phase: 'idle' | 'working' | 'success' | 'error'; message: string; backupCleanupRequired?: boolean };
  contact: MemorySection<ActiveMemory>;
  owner: MemorySection<ActiveMemory>;
  pending: MemorySection<PendingMemoryCandidate>;
  sources: MemorySection<MemorySource>;
  history: MemoryHistoryState;
  overview: MemoryOverviewState;
  ownerOverview: MemoryOverviewState<OwnerFactsPreferencesOverview>;
  layeredMemory: MemoryOverviewState<LayeredMemory>;
}
export interface MemoryReadRequest extends ContactSelection { section?: MemorySectionName; }
export interface MemoryAdditionRequest extends ContactSelection {
  level: 'owner' | 'contact'; text: string; category: MemoryCategory;
}
export interface MemoryCandidateRequest extends ContactSelection { candidateId: string; }
export interface MemoryCandidateUpdateRequest extends MemoryCandidateRequest {
  previousMemoryId: string;
  expectedRevision: number;
}
export interface MemoryRemovalRequest extends ContactSelection {
  level: 'owner' | 'contact'; memoryId: string; revision: number;
}
export interface MemoryCorrectionRequest extends ContactSelection {
  level: 'owner' | 'contact'; memoryId: string; revision: number; text: string; category: MemoryCategory;
}
export interface MemoryBridge {
  getState(): Promise<MemoryReadingState>;
  refresh(request: MemoryReadRequest): Promise<void>;
  refreshOverview(request: ContactSelection): Promise<void>;
  refreshOwnerOverview(request: ContactSelection): Promise<void>;
  readLayeredMemory(request: LayeredMemoryReadRequest): Promise<void>;
  manageLayeredMemory(request: LayeredMemoryManagementRequest): Promise<void>;
  add(request: MemoryAdditionRequest): Promise<void>;
  remove(request: MemoryRemovalRequest): Promise<void>;
  discardCandidate(request: MemoryCandidateRequest): Promise<void>;
  confirmCandidate(request: MemoryCandidateRequest): Promise<void>;
  applyCandidateUpdate(request: MemoryCandidateUpdateRequest): Promise<void>;
  correct(request: MemoryCorrectionRequest): Promise<void>;
  openVersions(request: MemoryRemovalRequest): Promise<void>;
  revertAutoUpdate(request: MemoryRemovalRequest): Promise<void>;
  onStateChanged(listener: (state: MemoryReadingState) => void): () => void;
}
