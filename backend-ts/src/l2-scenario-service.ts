/** L2 场景冻结、模型暂存、独立核验、事务发布和管理；不领取任务或发送外部消息。 */
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import type {MessagesBudgetProfile} from './model-input-budget.ts';
import type {ContextMetadata} from './reply-context-types.ts';
import {readReplyContactOverview, readReplyOwnerOverview} from './reply-context-overview.ts';
import {deleteSourceReplies} from './preference-erasure.ts';
import {
  L2ScenarioDocumentWorkspace,
  L2ScenarioError,
  DEFAULT_L2_SCENARIO_BUDGET,
  canonicalScenarioJSON,
  runScenarioDocumentAgent,
  scenarioDigest,
  scenarioTopicId,
  validateScenarioDocument,
  verifyScenarioProposal,
  type L2ScenarioBudget,
  type L2ScenarioDraft,
  type L2ScenarioMemory,
  type L2ScenarioScope,
  type L2ScenarioVersion,
  type ScenarioDocumentCallPort,
} from './l2-scenario-workspace.ts';

export interface L2ScenarioClaim {
  task_id: string;
  step_id: string;
  step_name: 'organize_memory';
  worker_id: string;
  lease_generation: number;
}

type Row = Record<string, any>;
type Transaction = <T>(work: (client: Client) => Promise<T>) => Promise<T>;

export interface L2ScenarioPreparedWork {
  batch_id: string;
  scope: L2ScenarioScope;
  claim: L2ScenarioClaim;
  settings_generation: number;
  organization_generation: number;
  correction_revision: number;
  input_manifest: Row[];
  inputs: L2ScenarioMemory[];
  current: L2ScenarioVersion[];
  dependency_ids: string[];
}

export interface L2ScenarioQualityStage {
  status: 'unknown' | 'failed' | 'verified';
  reasons: string[];
  contract_id: string | null;
  report_id: string | null;
}

export interface L2ScenarioQuality {
  organization: L2ScenarioQualityStage;
  reply: L2ScenarioQualityStage;
  automatic_use_allowed: boolean;
  synthetic: boolean;
}

export interface L2ScenarioQualityReader {
  read(client: Client, scope: L2ScenarioScope): Promise<L2ScenarioQuality>;
}

export interface L2ScenarioServiceOptions {
  transaction: Transaction;
  model: ScenarioDocumentCallPort;
  binding: {
    provider: string;
    model: string;
    maxTokens: number;
    temperature: number;
    reasoningEffort: 'off' | 'low' | 'high' | 'max';
  };
  profile: MessagesBudgetProfile;
  budget?: L2ScenarioBudget;
  now?: () => Date;
  /**
   * TS质量存储的明确注入点。未注入时只能返回 unknown + 禁止自动使用，
   * 不能把合成评测或未知状态宣称为正式资格。
   */
  quality?: L2ScenarioQualityReader;
  /**
   * 根集成接入票 12 的 SourceProcessingTraceStore 时，在最终事务中再次
   * fail-closed 核验实际来源；实现不得返回或复制来源正文。
   */
  validateSources?: (client: Client, work: L2ScenarioPreparedWork) => Promise<void>;
}

export interface L2ScenarioManagement {
  settings_generation: number;
  organization_generation: number;
  version_id: string;
  item_index: number;
  operation_id: string;
  reason: string;
  memory_id?: string;
}

export interface L2ScenarioParagraphRemoval {
  settings_generation: number;
  organization_generation: number;
  version_id: string;
  item_index: number;
  operation_id: string;
}

export class L2ScenarioConflict extends Error {
  readonly code: string;
  constructor(code = 'l2_scenario_changed') {
    super(code);
    this.code = code;
    this.name = 'L2ScenarioConflict';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = ['disabled', 'ready', 'empty', 'failed', 'updating', 'stale', 'blocked', 'paused'] as const;
const SOURCE_KINDS = new Set(['manual_entry', 'source_supported']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function failClosedQuality(): L2ScenarioQuality {
  return {
    organization: {
      status: 'unknown',
      reasons: ['quality_store_unconfigured'],
      contract_id: null,
      report_id: null,
    },
    reply: {
      status: 'unknown',
      reasons: ['quality_store_unconfigured'],
      contract_id: null,
      report_id: null,
    },
    automatic_use_allowed: false,
    synthetic: false,
  };
}

function checkedQuality(value: L2ScenarioQuality): L2ScenarioQuality {
  const stage = (item: L2ScenarioQualityStage): L2ScenarioQualityStage => {
    if (
      !item
      || !['unknown', 'failed', 'verified'].includes(item.status)
      || !Array.isArray(item.reasons)
      || !item.reasons.every(reason => typeof reason === 'string' && reason.length <= 1000)
      || item.contract_id !== null && (typeof item.contract_id !== 'string' || item.contract_id.length > 200)
      || item.report_id !== null && (typeof item.report_id !== 'string' || item.report_id.length > 200)
      || item.status === 'verified' && (item.contract_id === null || item.report_id === null || item.reasons.length)
    ) throw new L2ScenarioError('l2_scenario_quality_invalid');
    return {
      status: item.status,
      reasons: [...item.reasons],
      contract_id: item.contract_id,
      report_id: item.report_id,
    };
  };
  if (
    !value
    || typeof value.synthetic !== 'boolean'
    || typeof value.automatic_use_allowed !== 'boolean'
  ) throw new L2ScenarioError('l2_scenario_quality_invalid');
  const organization = stage(value.organization);
  const reply = stage(value.reply);
  if (
    value.synthetic && (organization.status === 'verified' || reply.status === 'verified')
    || value.automatic_use_allowed && (
      value.synthetic || organization.status !== 'verified' || reply.status !== 'verified'
    )
  ) throw new L2ScenarioError('l2_scenario_quality_invalid');
  return {organization, reply, automatic_use_allowed: value.automatic_use_allowed, synthetic: value.synthetic};
}

function positive(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new L2ScenarioError('l2_scenario_identity_invalid');
  return value.toLowerCase();
}

function contactParameter(scope: L2ScenarioScope): string | null {
  return scope.contact_id;
}

async function lockScope(client: Client, scope: L2ScenarioScope): Promise<void> {
  if (scope.contact_id !== null) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`contact:${scope.owner_id}:${scope.contact_id}`]);
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`owner:${scope.owner_id}`]);
}

async function assertClaim(client: Client, scope: L2ScenarioScope, claim: L2ScenarioClaim): Promise<void> {
  const row = (await client.query(`SELECT 1 FROM public.background_task t
    JOIN public.background_task_step s ON s.task_id=t.id
    WHERE t.id=$1 AND s.id=$2 AND t.owner_id=$3 AND t.contact_id IS NOT DISTINCT FROM $4::uuid
      AND t.task_type='layered_memory' AND t.current_step='organize_memory'
      AND t.status IN ('queued','running','verifying') AND s.step_name=$5 AND s.status='running'
      AND s.worker_id=$6 AND s.lease_generation=$7 AND s.lease_expires_at>clock_timestamp()`,
  [claim.task_id, claim.step_id, scope.owner_id, contactParameter(scope), claim.step_name, claim.worker_id, claim.lease_generation])).rowCount;
  if (!row) throw new L2ScenarioConflict('l2_scenario_claim_stale');
}

async function readState(client: Client, scope: L2ScenarioScope, forUpdate = false): Promise<Row | undefined> {
  return (await client.query(`SELECT * FROM public.layered_memory_state
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
  [scope.owner_id, contactParameter(scope)])).rows[0];
}

async function currentJob(
  client: Client,
  scope: L2ScenarioScope,
  settingsGeneration: number,
  forUpdate = false,
): Promise<Row | undefined> {
  return (await client.query(`SELECT * FROM public.layered_memory_job
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
      AND settings_generation=$3 AND state NOT IN ('complete','invalidated')
    ORDER BY created_at DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
  [scope.owner_id, contactParameter(scope), settingsGeneration])).rows[0];
}

async function overview(client: Client, scope: L2ScenarioScope): Promise<ContextMetadata[]> {
  const snapshot = scope.contact_id === null
    ? await readReplyOwnerOverview(client, scope.owner_id, true)
    : await readReplyContactOverview(client, {owner_id: scope.owner_id, contact_id: scope.contact_id});
  return snapshot.entries;
}

function memoryFrom(entry: ContextMetadata, now: number): L2ScenarioMemory | null {
  const memory = entry.memory as Row;
  const provenance = entry.provenance?.kind;
  if (
    !SOURCE_KINDS.has(provenance)
    || memory.status !== 'active'
    || entry.is_latest !== true
    || !entry.current_leaf
    || !UUID.test(String(memory.memory_id))
    || !Number.isSafeInteger(memory.revision)
    || memory.revision < 1
    || typeof memory.text !== 'string'
    || !memory.text.trim()
  ) return null;
  if (memory.valid_at && Date.parse(memory.valid_at) > now) return null;
  if (memory.invalid_at && Date.parse(memory.invalid_at) <= now) return null;
  const manifest = entry.dependency_manifest as Row | null;
  if (!manifest || manifest.memory_id !== memory.memory_id) {
    throw new L2ScenarioConflict('l2_scenario_manifest_unavailable');
  }
  const messageIds = ((entry.provenance?.references ?? []) as Row[])
    .map(reference => reference.message_id)
    .filter((value): value is string => typeof value === 'string' && UUID.test(value));
  return {
    memory_id: memory.memory_id,
    revision: memory.revision,
    text: memory.text,
    category: String(memory.category),
    provenance_kind: provenance as 'manual_entry' | 'source_supported',
    timing: clone(memory.timing ?? {}),
    event: clone(memory.event ?? null),
    conditions: clone(memory.conditions ?? null),
    evolution: clone(memory.evolution ?? null),
    valid_at: memory.valid_at ?? null,
    invalid_at: memory.invalid_at ?? null,
    dependency_ids: [...(entry.dependency_ids ?? [])].map(String).sort(),
    message_ids: [...new Set(messageIds)].sort(),
    dependency_manifest: clone(manifest),
  };
}

function organizationManifest(input: L2ScenarioMemory): Row {
  return {...clone(input.dependency_manifest), organization_timing_sha256: scenarioDigest(input.timing)};
}

async function currentScenarios(client: Client, scope: L2ScenarioScope, generation: number): Promise<L2ScenarioVersion[]> {
  const manifest = (await client.query(`SELECT scenario_version_ids FROM public.layered_memory_generation
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3`,
  [scope.owner_id, contactParameter(scope), generation])).rows[0];
  if (!manifest || !Array.isArray(manifest.scenario_version_ids)) return [];
  const rows = (await client.query(`SELECT v.*,b.input_manifest,b.dependency_ids FROM public.scenario_document_version v
    JOIN public.layered_memory_batch b ON b.id=v.batch_id
    WHERE v.owner_id=$1 AND v.contact_id IS NOT DISTINCT FROM $2::uuid AND v.id=ANY($3::uuid[])
    ORDER BY v.scenario_id`,
  [scope.owner_id, contactParameter(scope), manifest.scenario_version_ids])).rows;
  return rows.map(row => ({
    scenario_id: row.scenario_id,
    version_id: row.id,
    title: row.title,
    hint: row.hint,
    paragraphs: clone(row.paragraphs),
    input_manifest: clone(row.input_manifest ?? []),
    dependency_ids: [...(row.dependency_ids ?? [])].map(String),
  }));
}

async function eraseScenarioReplyCopies(
  client: Client,
  scope: L2ScenarioScope,
  scenarioVersionId: string,
): Promise<void> {
  const profiles = (await client.query(`SELECT v.id FROM public.layered_profile_version v
    JOIN public.layered_profile_batch b ON b.id=v.batch_id
    WHERE b.owner_id=$1 AND b.contact_id IS NOT DISTINCT FROM $2::uuid
      AND $3=ANY(b.scenario_version_ids)`,
  [scope.owner_id, contactParameter(scope), scenarioVersionId])).rows.map(row => row.id as string);
  await deleteSourceReplies(
    client,
    scope.owner_id,
    [...new Set([scenarioVersionId, ...profiles])],
    scope.contact_id,
    false,
  );
}

function protectedMemoryIds(feedback: Row[]): Set<string> {
  return new Set(feedback.flatMap(row => Array.isArray(row.protected_memory_ids) ? row.protected_memory_ids : []));
}

function protectedMessageIds(feedback: Row[]): Set<string> {
  return new Set(feedback.flatMap(row => Array.isArray(row.protected_message_ids) ? row.protected_message_ids : []));
}

async function feedbackRows(client: Client, scope: L2ScenarioScope, forUpdate = false): Promise<Row[]> {
  return (await client.query(`SELECT * FROM public.layered_memory_feedback
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND state IN ('active','erased_guard')
    ORDER BY created_at,id${forUpdate ? ' FOR UPDATE' : ''}`,
  [scope.owner_id, contactParameter(scope)])).rows;
}

function currentInputs(
  entries: readonly ContextMetadata[],
  memoryGuard: ReadonlySet<string>,
  messageGuard: ReadonlySet<string>,
  now: number,
): L2ScenarioMemory[] {
  return entries.flatMap(entry => {
    const memory = memoryFrom(entry, now);
    return memory
      && !memoryGuard.has(memory.memory_id)
      && !memory.message_ids.some(id => messageGuard.has(id))
      ? [memory]
      : [];
  });
}

function deterministicUuid(...parts: string[]): string {
  const bytes = Buffer.from(scenarioDigest(parts), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function validBudget(value: L2ScenarioBudget): L2ScenarioBudget {
  const budget = clone(value);
  for (const item of Object.values(budget)) {
    if (!Number.isSafeInteger(item) || item < 1) throw new L2ScenarioError('l2_scenario_budget_invalid');
  }
  if (budget.max_model_calls < 2 || budget.max_model_calls > 16) {
    throw new L2ScenarioError('l2_scenario_budget_invalid');
  }
  return budget;
}

export class L2ScenarioService {
  readonly budget: L2ScenarioBudget;
  private readonly transaction: Transaction;
  private readonly model: ScenarioDocumentCallPort;
  private readonly binding: L2ScenarioServiceOptions['binding'];
  private readonly profile: MessagesBudgetProfile;
  private readonly now: () => Date;
  private readonly validateSources: L2ScenarioServiceOptions['validateSources'];
  private readonly quality: L2ScenarioQualityReader | undefined;

  constructor(options: L2ScenarioServiceOptions) {
    this.transaction = options.transaction;
    this.model = options.model;
    this.binding = clone(options.binding);
    this.profile = clone(options.profile);
    this.budget = validBudget(options.budget ?? DEFAULT_L2_SCENARIO_BUDGET);
    this.now = options.now ?? (() => new Date());
    this.validateSources = options.validateSources;
    this.quality = options.quality;
  }

  async prepare(scope: L2ScenarioScope, claim: L2ScenarioClaim): Promise<L2ScenarioPreparedWork | null> {
    this.validateScope(scope);
    this.validateClaim(claim);
    return this.transaction(async client => {
      await lockScope(client, scope);
      await assertClaim(client, scope, claim);
      const state = await readState(client, scope, true);
      if (!state?.enabled || !STATUS.includes(state.status)) throw new L2ScenarioConflict('l2_scenario_disabled');
      const job = (await client.query(`SELECT * FROM public.layered_memory_job
        WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
      [claim.task_id, scope.owner_id, contactParameter(scope)])).rows[0];
      if (
        !job
        || job.state !== 'active'
        || Number(job.settings_generation) !== Number(state.settings_generation)
        || !['document-tools-v1', 'profile-tools-v1'].some(tag => String(job.contract).split(':').includes(tag))
      ) throw new L2ScenarioConflict('l2_scenario_job_stale');
      if (job.pending_receipt) return null;
      const succeeded = (await client.query(`SELECT id FROM public.layered_memory_batch
        WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid AND status='succeeded'
        ORDER BY created_at DESC LIMIT 1`,
      [claim.task_id, scope.owner_id, contactParameter(scope)])).rows[0];
      if (succeeded) return null;
      await client.query(`DELETE FROM public.layered_memory_batch
        WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid AND status<>'succeeded'`,
      [claim.task_id, scope.owner_id, contactParameter(scope)]);
      const feedback = await feedbackRows(client, scope);
      const entries = await overview(client, scope);
      const current = await currentScenarios(client, scope, Number(state.organization_generation));
      const available = currentInputs(entries, protectedMemoryIds(feedback), protectedMessageIds(feedback), this.now().getTime());
      const byVersion = new Map(available.map(memory => [`${memory.memory_id}:${memory.revision}`, memory]));
      const selected = available.slice(0, Math.min(this.budget.max_memories, this.budget.max_batch_memories));
      const selectedVersions = new Set(selected.map(memory => `${memory.memory_id}:${memory.revision}`));
      for (const document of current) {
        for (const paragraph of document.paragraphs) {
          for (const reference of paragraph.references) {
            const key = `${reference.memory_id}:${reference.revision}`;
            const memory = byVersion.get(key);
            if (memory && !selectedVersions.has(key) && selected.length < this.budget.max_memories) {
              selected.push(memory);
              selectedVersions.add(key);
            }
          }
        }
      }
      const eligible = selected;
      if (!eligible.length) {
        await client.query(`UPDATE public.layered_memory_state
          SET status='empty',error_code=NULL,maintenance_allowed=true,updated_at=$3
          WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
        [scope.owner_id, contactParameter(scope), this.now()]);
        return null;
      }
      const inputManifest = eligible.map(organizationManifest);
      const dependencies = new Set<string>([
        ...eligible.flatMap(memory => [memory.memory_id, ...memory.dependency_ids]),
        ...current.flatMap(document => document.dependency_ids),
        ...feedback.flatMap(row => [
          ...(row.dependency_ids ?? []),
          ...(row.protected_memory_ids ?? []),
          ...(row.protected_message_ids ?? []),
        ]),
      ]);
      const batchId = deterministicUuid('l2-batch', claim.task_id, scenarioDigest(inputManifest));
      const workKey = scenarioDigest({job: claim.task_id, inputs: inputManifest});
      await client.query(`INSERT INTO public.layered_memory_batch
        (id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id,scenario_input,reused_version_ids,correction_input)
        VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(id) DO NOTHING`,
      [batchId, scope.owner_id, contactParameter(scope), state.settings_generation, workKey,
        JSON.stringify(inputManifest), JSON.stringify(eligible), [...dependencies].sort(), this.now(), claim.task_id,
        JSON.stringify(current), current.map(document => document.version_id),
        JSON.stringify(feedback.map(row => ({
          feedback_id: row.id,
          rejected_text: row.rejected_text,
          reason: row.reason,
          rule: 'independent-literal-v1',
        })))]);
      const batch = (await client.query(`SELECT id,status FROM public.layered_memory_batch
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND work_key=$3`,
      [scope.owner_id, contactParameter(scope), workKey])).rows[0];
      if (!batch || batch.status !== 'running') throw new L2ScenarioConflict('l2_scenario_work_unavailable');
      await client.query(`UPDATE public.layered_memory_state
        SET status='updating',error_code=NULL,updated_at=$3
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
      [scope.owner_id, contactParameter(scope), this.now()]);
      return {
        batch_id: batch.id,
        scope,
        claim: clone(claim),
        settings_generation: Number(state.settings_generation),
        organization_generation: Number(state.organization_generation),
        correction_revision: Number(state.correction_revision ?? 0),
        input_manifest: clone(inputManifest),
        inputs: eligible,
        current,
        dependency_ids: [...dependencies].sort(),
      };
    });
  }

  requireCurrent(work: L2ScenarioPreparedWork): Promise<void> {
    return this.transaction(async client => {
      await lockScope(client, work.scope);
      await this.assertCurrent(client, work, true);
    });
  }

  private async assertCurrent(client: Client, work: L2ScenarioPreparedWork, lockBatch = false): Promise<void> {
    await assertClaim(client, work.scope, work.claim);
    const state = await readState(client, work.scope, true);
    const job = (await client.query(`SELECT * FROM public.layered_memory_job
      WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
    [work.claim.task_id, work.scope.owner_id, contactParameter(work.scope)])).rows[0];
    if (
      !state?.enabled
      || Number(state.settings_generation) !== work.settings_generation
      || Number(state.organization_generation) !== work.organization_generation
      || Number(state.correction_revision ?? 0) !== work.correction_revision
      || !job
      || job.state !== 'active'
      || Number(job.settings_generation) !== work.settings_generation
    ) throw new L2ScenarioConflict('l2_scenario_changed');
    const batch = (await client.query(`SELECT 1 FROM public.layered_memory_batch
      WHERE id=$1 AND task_id=$2 AND owner_id=$3 AND contact_id IS NOT DISTINCT FROM $4::uuid AND status='running'${
        lockBatch ? ' FOR UPDATE' : ''
      }`, [work.batch_id, work.claim.task_id, work.scope.owner_id, contactParameter(work.scope)])).rowCount;
    if (!batch) throw new L2ScenarioConflict('l2_scenario_batch_stale');
    const feedback = await feedbackRows(client, work.scope);
    if (this.validateSources) await this.validateSources(client, work);
    const current = currentInputs(
      await overview(client, work.scope),
      protectedMemoryIds(feedback),
      protectedMessageIds(feedback),
      this.now().getTime(),
    );
    const byKey = new Map(current.map(memory => [`${memory.memory_id}:${memory.revision}`, organizationManifest(memory)]));
    if (
      canonicalScenarioJSON(work.input_manifest)
      !== canonicalScenarioJSON(work.inputs.map(memory => byKey.get(`${memory.memory_id}:${memory.revision}`)))
    ) throw new L2ScenarioConflict('l2_scenario_source_changed');
    const scenarioSnapshot = (documents: readonly L2ScenarioVersion[]) => documents.map(document => ({
      scenario_id: document.scenario_id,
      version_id: document.version_id,
      title: document.title,
      hint: document.hint,
      paragraphs: document.paragraphs,
      input_manifest: document.input_manifest,
      dependency_ids: document.dependency_ids,
    }));
    if (
      canonicalScenarioJSON(scenarioSnapshot(await currentScenarios(client, work.scope, work.organization_generation)))
      !== canonicalScenarioJSON(scenarioSnapshot(work.current))
    ) throw new L2ScenarioConflict('l2_scenario_generation_changed');
  }

  async recordProposal(work: L2ScenarioPreparedWork, scenarios: readonly L2ScenarioDraft[]): Promise<void> {
    await this.transaction(async client => {
      await lockScope(client, work.scope);
      await this.assertCurrent(client, work);
      await client.query(`UPDATE public.layered_memory_batch SET output_payload=$2 WHERE id=$1`,
        [work.batch_id, JSON.stringify({scenarios, filtered: {scenarios}, verification_result: null})]);
    });
  }

  async publish(
    work: L2ScenarioPreparedWork,
    scenarios: readonly L2ScenarioDraft[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transaction(async client => {
      await lockScope(client, work.scope);
      await this.assertCurrent(client, work, true);
      signal?.throwIfAborted();
      const state = await readState(client, work.scope, true);
      if (!state) throw new L2ScenarioConflict('l2_scenario_changed');
      validateScenarioDocument({scenarios: scenarios.map(({scenario_id, ...rest}) => ({
        ...(scenario_id ? {scenario_id} : {}), ...rest,
      }))}, work.inputs, work.current, this.budget);
      const generation = work.organization_generation + 1;
      const previousById = new Map(work.current.map(document => [document.scenario_id, document]));
      const previousByVersion = new Map(work.current.map(document => [document.version_id, document]));
      const replacementIds = new Set(scenarios.flatMap(scenario => scenario.replaces));
      const retained = work.current.filter(document =>
        !replacementIds.has(document.version_id)
        && !scenarios.some(scenario => scenario.scenario_id === document.scenario_id));
      const planned: {
        scenario_id: string;
        version_id: string;
        title: string;
        hint: string;
        paragraphs: L2ScenarioVersion['paragraphs'];
        replaced: string[];
      }[] = [];
      const touched = new Set<string>();
      const topicIds = new Set<string>();
      for (const scenario of scenarios) {
        const scenarioId = scenario.scenario_id
          ?? scenarioTopicId(work.scope.contact_id ?? work.scope.owner_id, `${work.scope.owner_id}:${scenario.topic_key}`);
        if (topicIds.has(scenario.topic_key) || touched.has(scenarioId)) {
          throw new L2ScenarioConflict('l2_scenario_identity_conflict');
        }
        topicIds.add(scenario.topic_key);
        touched.add(scenarioId);
        const previous = previousById.get(scenarioId);
        if (
          !previous
          && (await client.query(`SELECT 1 FROM public.scenario_document_version
            WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND scenario_id=$3 LIMIT 1`,
          [work.scope.owner_id, contactParameter(work.scope), scenarioId])).rowCount
        ) throw new L2ScenarioConflict('l2_scenario_retired_identity');
        if (previous && !scenario.replaces.includes(previous.version_id)) {
          throw new L2ScenarioConflict('l2_scenario_replacement_required');
        }
        for (const version of scenario.replaces) {
          if (!previousByVersion.has(version)) throw new L2ScenarioConflict('l2_scenario_replacement_stale');
        }
        const versionId = deterministicUuid(
          'l2-version', work.batch_id, scenarioId, scenarioDigest({
            title: scenario.title,
            hint: scenario.hint,
            paragraphs: scenario.paragraphs,
            replaces: scenario.replaces,
          }),
        );
        planned.push({
          scenario_id: scenarioId,
          version_id: versionId,
          title: scenario.title,
          hint: scenario.hint,
          paragraphs: clone(scenario.paragraphs),
          replaced: [...scenario.replaces],
        });
      }
      if (!planned.length) throw new L2ScenarioConflict('l2_scenario_no_changes');
      const finalDocuments = [...retained, ...planned.map(item => ({
        scenario_id: item.scenario_id,
        version_id: item.version_id,
        title: item.title,
        hint: item.hint,
        paragraphs: item.paragraphs,
        input_manifest: work.input_manifest,
        dependency_ids: work.dependency_ids,
      }))];
      if (new Set(finalDocuments.map(document => document.scenario_id)).size !== finalDocuments.length) {
        throw new L2ScenarioConflict('l2_scenario_identity_conflict');
      }
      for (const item of planned) {
        await client.query(`INSERT INTO public.scenario_document_version
          (id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at)
          VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)`,
        [item.version_id, work.scope.owner_id, contactParameter(work.scope), item.scenario_id, work.batch_id,
          generation, item.title, item.hint, JSON.stringify(item.paragraphs), this.now()]);
        for (const oldVersion of item.replaced) {
          const old = previousByVersion.get(oldVersion)!;
          await client.query(`INSERT INTO public.scenario_document_mapping
            (owner_id,contact_id,source_scenario_id,source_version_id,target_scenario_id,target_version_id,batch_id)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [work.scope.owner_id, contactParameter(work.scope), old.scenario_id, old.version_id,
            item.scenario_id, item.version_id, work.batch_id]);
        }
        const previous = previousById.get(item.scenario_id);
        if (previous && !item.replaced.includes(previous.version_id)) {
          await client.query(`INSERT INTO public.scenario_document_mapping
            (owner_id,contact_id,source_scenario_id,source_version_id,target_scenario_id,target_version_id,batch_id)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [work.scope.owner_id, contactParameter(work.scope), previous.scenario_id, previous.version_id,
            item.scenario_id, item.version_id, work.batch_id]);
        }
      }
      const dependencies = new Set(work.dependency_ids);
      for (const document of retained) for (const dependency of document.dependency_ids) dependencies.add(dependency);
      await client.query(`INSERT INTO public.layered_memory_generation
        (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,dependency_ids,created_at)
        VALUES($1,$2,$3,2,$4,NULL,$5,$6)`,
      [work.scope.owner_id, contactParameter(work.scope), generation,
        finalDocuments.map(document => document.version_id), [...dependencies].sort(), this.now()]);
      const changed = await client.query(`UPDATE public.layered_memory_state
        SET organization_generation=$3,status='ready',covered_count=$4,updated_at=$5,error_code=NULL
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
          AND settings_generation=$6 AND organization_generation=$7 AND enabled`,
      [work.scope.owner_id, contactParameter(work.scope), generation,
        new Set(finalDocuments.flatMap(document => document.input_manifest)
          .map(entry => entry.memory_id)
          .filter(id => typeof id === 'string')).size, this.now(),
        work.settings_generation, work.organization_generation]);
      if (changed.rowCount !== 1) throw new L2ScenarioConflict('l2_scenario_changed');
      await client.query(`UPDATE public.layered_memory_batch
        SET status='succeeded',output_payload=output_payload||$2::jsonb
        WHERE id=$1 AND status='running'`,
      [work.batch_id, JSON.stringify({verification_result: true, organization_generation: generation})]);
      await client.query(`UPDATE public.layered_memory_job
        SET pending_receipt=true,profile_status=CASE WHEN profile_required THEN 'pending' ELSE 'not_required' END,
          batch_number=batch_number+1,receipt_batch_id=$2,receipt_lease_generation=$3
        WHERE task_id=$1 AND state='active'`,
      [work.claim.task_id, work.batch_id, work.claim.lease_generation]);
    });
  }

  async fail(work: L2ScenarioPreparedWork, code: string): Promise<void> {
    if (!/^[a-z0-9_]{1,80}$/.test(code)) throw new L2ScenarioError('l2_scenario_failure_code_invalid');
    await this.transaction(async client => {
      await lockScope(client, work.scope);
      try {
        await assertClaim(client, work.scope, work.claim);
      } catch (error) {
        if (error instanceof L2ScenarioConflict) return;
        throw error;
      }
      const state = await readState(client, work.scope);
      if (!state?.enabled || Number(state.settings_generation) !== work.settings_generation
        || Number(state.organization_generation) !== work.organization_generation) return;
      const failed = await client.query(`UPDATE public.layered_memory_batch SET status='failed',error_code=$2
        WHERE id=$1 AND task_id=$3 AND owner_id=$4 AND contact_id IS NOT DISTINCT FROM $5::uuid AND status='running'`,
      [work.batch_id, code, work.claim.task_id, work.scope.owner_id, contactParameter(work.scope)]);
      if (failed.rowCount !== 1) return;
      await client.query(`UPDATE public.layered_memory_state
        SET status=$3,error_code=$4,updated_at=$5
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
          AND settings_generation=$6 AND organization_generation=$7`,
      [work.scope.owner_id, contactParameter(work.scope), code === 'l2_scenario_budget_exhausted' ? 'paused' : 'failed',
        code, this.now(), work.settings_generation, work.organization_generation]);
    });
  }

  async run(scope: L2ScenarioScope, claim: L2ScenarioClaim, signal: AbortSignal): Promise<{state: Row; status: 'completed'|'idle'}> {
    signal.throwIfAborted();
    const work = await this.prepare(scope, claim);
    if (!work) {
      signal.throwIfAborted();
      return {state: await this.read(scope), status: 'idle'};
    }
    try {
      signal.throwIfAborted();
      const workspace = new L2ScenarioDocumentWorkspace(work.inputs, work.current, this.budget);
      const proposal = await runScenarioDocumentAgent({
        workspace,
        port: this.model,
        claim: work.claim,
        owner_id: scope.owner_id,
        contact_id: scope.contact_id,
        batch_id: work.batch_id,
        binding: this.binding,
        profile: this.profile,
        signal,
        requireCurrent: () => this.requireCurrent(work),
      });
      signal.throwIfAborted();
      await this.recordProposal(work, proposal.scenarios);
      signal.throwIfAborted();
      await verifyScenarioProposal({
        scenarios: proposal.scenarios,
        memories: work.inputs,
        port: this.model,
        claim: work.claim,
        owner_id: scope.owner_id,
        contact_id: scope.contact_id,
        batch_id: work.batch_id,
        binding: this.binding,
        profile: this.profile,
        signal,
        requireCurrent: () => this.requireCurrent(work),
      });
      signal.throwIfAborted();
      await this.publish(work, proposal.scenarios, signal);
      return {state: await this.read(scope), status: 'completed'};
    } catch (error) {
      const code = error instanceof L2ScenarioError || error instanceof L2ScenarioConflict
        ? error.code
        : 'l2_scenario_model_failed';
      await this.fail(work, signal.aborted ? 'l2_scenario_cancelled' : code).catch(() => {});
      throw error;
    }
  }

  async read(scope: L2ScenarioScope, mappingCursor: string|null = null): Promise<Row> {
    this.validateScope(scope);
    if (mappingCursor !== null && !/^[0-9]{1,18}:[0-9]{1,10}$/.test(mappingCursor)) {
      throw new L2ScenarioError('l2_scenario_mapping_cursor_invalid');
    }
    return this.transaction(async client => {
      const state = await readState(client, scope);
      if (!state) throw new L2ScenarioConflict('l2_scenario_not_found');
      const job = await currentJob(client, scope, positive(state.settings_generation));
      const generation = Number(state.organization_generation);
      const manifest = (await client.query(`SELECT * FROM public.layered_memory_generation
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3`,
      [scope.owner_id, contactParameter(scope), generation])).rows[0];
      const versionIds = manifest?.scenario_version_ids ?? [];
      const rows = versionIds.length
        ? (await client.query(`SELECT * FROM public.scenario_document_version
          WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND id=ANY($3::uuid[])
          ORDER BY scenario_id`, [scope.owner_id, contactParameter(scope), versionIds])).rows
        : [];
      const scenarios = rows.map(row => ({
        scenario_id: row.scenario_id,
        version_id: row.id,
        title: row.title,
        hint: row.hint,
        system_generated: true,
        updated_at: new Date(row.created_at).toISOString(),
        paragraphs: clone(row.paragraphs),
      }));
      const profileRow = manifest?.profile_version_id
        ? (await client.query(`SELECT * FROM public.layered_profile_version
          WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid`,
        [manifest.profile_version_id, scope.owner_id, contactParameter(scope)])).rows[0]
        : null;
      const profile = profileRow && !profileRow.withdrawn
        && ['ready', 'paused', 'disabled'].includes(String(state.status)) ? {
        version_id: profileRow.id,
        system_generated: true,
        updated_at: new Date(profileRow.created_at).toISOString(),
        entries: clone(profileRow.entries),
      } : null;
      let mappingOffset = 0;
      if (mappingCursor !== null) {
        const [generationValue, offsetValue] = mappingCursor.split(':');
        if (Number(generationValue) !== generation) throw new L2ScenarioConflict('l2_scenario_mapping_cursor_stale');
        mappingOffset = Number(offsetValue);
      }
      const mappings = versionIds.length
        ? (await client.query(`WITH RECURSIVE lineage AS (
            SELECT source_scenario_id,source_version_id,target_version_id
            FROM public.scenario_document_mapping
            WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
            UNION
            SELECT l.source_scenario_id,l.source_version_id,m.target_version_id
            FROM lineage l JOIN public.scenario_document_mapping m
              ON m.source_version_id=l.target_version_id AND m.owner_id=$1 AND m.contact_id IS NOT DISTINCT FROM $2::uuid
          ) SELECT DISTINCT l.source_scenario_id,l.source_version_id,v.scenario_id,v.id target_version_id
            FROM lineage l JOIN public.scenario_document_version v ON v.id=l.target_version_id
            WHERE v.id=ANY($3::uuid[]) ORDER BY l.source_version_id,v.id OFFSET $4 LIMIT 101`,
        [scope.owner_id, contactParameter(scope), versionIds, mappingOffset])).rows
        : [];
      const grouped = new Map<string, Row>();
      for (const row of mappings.slice(0, 100)) {
        const key = row.source_version_id;
        const item = grouped.get(key) ?? {
          source_scenario_id: row.source_scenario_id,
          source_version_id: row.source_version_id,
          targets: [],
        };
        item.targets.push({scenario_id: row.scenario_id, version_id: row.target_version_id});
        grouped.set(key, item);
      }
      const nextMappingCursor = mappings.length > 100 ? `${generation}:${mappingOffset + 100}` : null;
      const feedback = await feedbackRows(client, scope);
      const entries = await overview(client, scope);
      const now = this.now().getTime();
      const allEligible = currentInputs(entries, new Set(), new Set(), now);
      const eligible = currentInputs(
        entries,
        protectedMemoryIds(feedback),
        protectedMessageIds(feedback),
        now,
      );
      const eligibleById = new Map(allEligible.map(memory => [memory.memory_id, memory]));
      const protectedMemories = protectedMemoryIds(feedback);
      const protectedMessages = protectedMessageIds(feedback);
      const pendingFactCount = Number((await client.query(`SELECT count(*)::int AS count
        FROM public.layered_memory_fact_correction
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
      [scope.owner_id, contactParameter(scope)])).rows[0]?.count ?? 0);
      let quality=failClosedQuality();
      if(this.quality){
        try{quality=checkedQuality(await this.quality.read(client,scope));}
        catch{
          quality={...failClosedQuality(),organization:{...failClosedQuality().organization,reasons:['quality_store_unavailable']},
            reply:{...failClosedQuality().reply,reasons:['quality_store_unavailable']}};
        }
      }
      const used = positive(job?.model_calls_used);
      const limit = positive(job?.model_call_limit, this.budget.max_model_calls);
      return {
        schema_version: 2,
        scope_kind: scope.contact_id === null ? 'owner' : 'contact',
        contact_id: scope.contact_id,
        settings_generation: positive(state.settings_generation),
        enabled: Boolean(state.enabled),
        runtime_policy: 'verified_items',
        quality_status: quality.synthetic ? 'synthetic' : quality.organization.status,
        quality,
        status: STATUS.includes(state.status) ? state.status : 'failed',
        work_id: job?.task_id ?? null,
        work_revision: positive(job?.revision),
        current_batch: positive(job?.batch_number),
        model_calls_used: used,
        model_call_limit: limit,
        eligible_count: allEligible.length,
        covered_count: positive(state.covered_count),
        remaining_count: Math.max(0, allEligible.length - positive(state.covered_count)),
        mapping_cursor: mappingCursor,
        mapping_next_cursor: nextMappingCursor,
        maintenance_pending: positive(state.dirty_revision) > positive(state.consumed_revision),
        scenario_mappings: [...grouped.values()],
        organization_generation: generation,
        updated_at: state.updated_at ? new Date(state.updated_at).toISOString() : null,
        error_code: state.error_code ?? null,
        purpose: scope.contact_id === null ? '整理本人已采纳资料的主题背景。' : '整理当前联系人已采纳资料的主题背景。',
        budget: {
          max_memories: this.budget.max_memories,
          max_batch_memories: this.budget.max_batch_memories,
          max_scenarios: this.budget.max_scenarios,
          max_paragraphs: this.budget.max_paragraphs,
          max_characters: this.budget.max_characters,
          max_model_calls: this.budget.max_model_calls,
          max_profile_entries: 16,
          model_calls_used: used,
          model_calls_remaining: Math.max(0, limit - used),
        },
        scenarios,
        profile,
        correction_revision: positive(state.correction_revision),
        protected_count: allEligible.filter(memory => !eligible.some(item => item.memory_id === memory.memory_id)).length,
        pending_fact_count: pendingFactCount,
        feedback: feedback.map(row => {
          return {
            id: row.id,
            target_kind: row.target_kind,
            version_id: row.version_id,
            item_index: row.item_index,
            reason: row.state === 'active' ? row.reason : null,
            state: row.state,
            target_text: row.state === 'active' ? row.rejected_text : null,
            basis: allEligible.flatMap(memory => {
              const protectedById = protectedMemories.has(memory.memory_id);
              const protectedByMessage = memory.message_ids.some(id => protectedMessages.has(id));
              if (!protectedById && !protectedByMessage) return [];
              const current = eligibleById.get(memory.memory_id)!;
              return [{memory_id: current.memory_id, revision: current.revision}];
            }),
          };
        }),
        correction_target: null,
      };
    });
  }

  async reportParagraphError(scope: L2ScenarioScope, command: L2ScenarioManagement): Promise<Row> {
    this.validateScope(scope);
    this.validateManageCommand(command);
    await this.transaction(async client => {
      await lockScope(client, scope);
      const state = await readState(client, scope, true);
      const prior = (await client.query(`SELECT * FROM public.layered_memory_feedback
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND operation_id=$3`,
      [scope.owner_id, contactParameter(scope), command.operation_id])).rows[0];
      if (prior) {
        if (
          prior.request_digest !== scenarioDigest(command)
          || Number(state?.settings_generation) !== command.settings_generation
          || Number(prior.settings_generation) !== command.settings_generation
        ) throw new L2ScenarioConflict('l2_scenario_operation_changed');
        return;
      }
      if (
        !state
        || Number(state.settings_generation) !== command.settings_generation
        || Number(state.organization_generation) !== command.organization_generation
      ) throw new L2ScenarioConflict('l2_scenario_changed');
      const generation = await currentScenarios(client, scope, command.organization_generation);
      const target = generation.find(document => document.version_id === command.version_id);
      const paragraph = target?.paragraphs[command.item_index];
      if (
        !target
        || !paragraph
        || command.memory_id !== undefined
          && !paragraph.references.some(reference => reference.memory_id === command.memory_id)
      ) throw new L2ScenarioConflict('l2_scenario_feedback_target_stale');
      const entries = (await overview(client, scope))
        .map(entry => memoryFrom(entry, this.now().getTime()))
        .filter(Boolean) as L2ScenarioMemory[];
      const byKey = new Map(entries.map(memory => [`${memory.memory_id}:${memory.revision}`, memory]));
      const protectedMemories = target.input_manifest.map(entry => byKey.get(`${entry.memory_id}:${entry.revision}`));
      const memory = command.memory_id === undefined
        ? protectedMemories[0]
        : protectedMemories.find(item => item?.memory_id === command.memory_id);
      if (protectedMemories.some(item => !item) || !memory) {
        throw new L2ScenarioConflict('l2_scenario_feedback_target_stale');
      }
      const protectedMemoryIds = [...new Set(protectedMemories.map(item => item!.memory_id))].sort();
      const protectedMessageIds = [...new Set(protectedMemories.flatMap(item => item!.message_ids))].sort();
      const batch = (await client.query('SELECT input_manifest,dependency_ids FROM public.layered_memory_batch WHERE id=$1',
        [target.input_manifest.length ? (await client.query(`SELECT batch_id FROM public.scenario_document_version WHERE id=$1`, [target.version_id])).rows[0]?.batch_id : null])).rows[0];
      const dependencies = [...new Set<string>([
        ...protectedMemories.flatMap(item => [item!.memory_id,...item!.dependency_ids]),
        ...protectedMemoryIds,
        ...(batch?.dependency_ids ?? []),
        ...target.dependency_ids,
      ])].sort();
      await client.query(`INSERT INTO public.layered_memory_feedback
        (id,owner_id,contact_id,operation_id,request_digest,settings_generation,target_kind,version_id,item_index,reason,
          rejected_text,input_manifest,dependency_ids,protected_memory_ids,protected_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,'scenario',$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), scope.owner_id, contactParameter(scope), command.operation_id, scenarioDigest(command),
        command.settings_generation, command.version_id, command.item_index, command.reason, paragraph.text,
        JSON.stringify(batch?.input_manifest ?? target.input_manifest), dependencies, protectedMemoryIds, protectedMessageIds]);
      await eraseScenarioReplyCopies(client, scope, command.version_id);
      await client.query('DELETE FROM public.scenario_document_version WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid',
        [command.version_id, scope.owner_id, contactParameter(scope)]);
      await client.query(`UPDATE public.layered_memory_state
        SET correction_revision=correction_revision+1,dirty_revision=dirty_revision+1,
          next_due_at=clock_timestamp(),error_code='correction_protected'
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
      [scope.owner_id, contactParameter(scope)]);
      await client.query(`UPDATE public.layered_memory_job SET state='invalidated'
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND state='active'`,
      [scope.owner_id, contactParameter(scope)]);
    });
    return this.read(scope);
  }

  /**
   * 段落级删除按安全产品边界撤回包含该段的派生场景；不从用户反馈伪造一份
   * “系统生成”正文。底层合法记忆保持不变，后续整理只能重新生成。
   */
  async removeParagraph(scope: L2ScenarioScope, command: L2ScenarioParagraphRemoval): Promise<Row> {
    return this.reportParagraphError(scope, {
      ...command,
      memory_id: await this.referencedMemory(scope, command),
      reason: '用户删除该段落；撤回整份派生场景，底层合法记忆保持不变。',
    });
  }

  private async referencedMemory(scope: L2ScenarioScope, command: L2ScenarioParagraphRemoval): Promise<string> {
    return this.transaction(async client => {
      const state = await readState(client, scope);
      if (!state || Number(state.settings_generation) !== command.settings_generation
        || Number(state.organization_generation) !== command.organization_generation) {
        throw new L2ScenarioConflict('l2_scenario_changed');
      }
      const row = (await client.query('SELECT paragraphs FROM public.scenario_document_version WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid',
        [command.version_id, scope.owner_id, contactParameter(scope)])).rows[0];
      const reference = row?.paragraphs?.[command.item_index]?.references?.[0]?.memory_id;
      if (typeof reference !== 'string' || !UUID.test(reference)) {
        throw new L2ScenarioConflict('l2_scenario_feedback_target_stale');
      }
      return reference;
    });
  }

  async withdrawScenario(scope: L2ScenarioScope, settingsGeneration: number, organizationGeneration: number, versionId: string): Promise<Row> {
    this.validateScope(scope);
    if (!Number.isSafeInteger(settingsGeneration) || settingsGeneration < 0 || !Number.isSafeInteger(organizationGeneration)
      || organizationGeneration < 0 || !UUID.test(versionId)) throw new L2ScenarioError('l2_scenario_management_invalid');
    await this.transaction(async client => {
      await lockScope(client, scope);
      const state = await readState(client, scope, true);
      if (!state || Number(state.settings_generation) !== settingsGeneration
        || Number(state.organization_generation) !== organizationGeneration) {
        throw new L2ScenarioConflict('l2_scenario_changed');
      }
      const current = await currentScenarios(client, scope, organizationGeneration);
      if (!current.some(document => document.version_id === versionId)) {
        throw new L2ScenarioConflict('l2_scenario_version_stale');
      }
      await eraseScenarioReplyCopies(client, scope, versionId);
      await client.query('DELETE FROM public.scenario_document_version WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid',
        [versionId, scope.owner_id, contactParameter(scope)]);
      await client.query(`UPDATE public.layered_memory_job SET state='invalidated'
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND state='active'`,
      [scope.owner_id, contactParameter(scope)]);
    });
    return this.read(scope);
  }

  private validateScope(scope: L2ScenarioScope): void {
    if (!scope || !UUID.test(scope.owner_id) || scope.contact_id !== null && !UUID.test(scope.contact_id)) {
      throw new L2ScenarioError('l2_scenario_scope_invalid');
    }
  }

  private validateClaim(claim: L2ScenarioClaim): void {
    if (
      !claim
      || ![claim.task_id, claim.step_id, claim.worker_id].every(id => typeof id === 'string' && UUID.test(id))
      || claim.step_name !== 'organize_memory'
      || !Number.isSafeInteger(claim.lease_generation)
      || claim.lease_generation < 1
    ) throw new L2ScenarioError('l2_scenario_claim_invalid');
  }

  private validateManageCommand(command: L2ScenarioManagement): void {
    if (
      !command
      || !Number.isSafeInteger(command.settings_generation)
      || command.settings_generation < 0
      || !Number.isSafeInteger(command.organization_generation)
      || command.organization_generation < 0
      || !Number.isSafeInteger(command.item_index)
      || command.item_index < 0
      || command.item_index >= 100
      || [command.operation_id, command.version_id].some(value => typeof value !== 'string' || !UUID.test(value))
      || command.memory_id !== undefined && !UUID.test(command.memory_id)
      || typeof command.reason !== 'string'
      || !command.reason.trim()
      || count(command.reason.trim()) > 500
    ) throw new L2ScenarioError('l2_scenario_management_invalid');
  }
}

function count(value: string): number {
  return [...value].length;
}
