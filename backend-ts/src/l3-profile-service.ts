/** L3 长期背景的持久工作、增量跳过、独立核验、原子发布、撤回和纠错。 */
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import type {MessagesBudgetProfile} from './model-input-budget.ts';
import type {ContextMetadata} from './reply-context-types.ts';
import {readReplyContactOverview, readReplyOwnerOverview} from './reply-context-overview.ts';
import {epochMicros} from './contact-overview-time.ts';
import {deleteSourceReplies} from './preference-erasure.ts';
import {
  DEFAULT_L2_SCENARIO_BUDGET,
  L2ScenarioError,
  canonicalScenarioJSON,
  scenarioDigest,
  type L2ScenarioBudget,
  type L2ScenarioMemory,
  type L2ScenarioVersion,
  type ScenarioDocumentCall,
  type ScenarioDocumentCallPort,
} from './l2-scenario-workspace.ts';
import {
  L3ProfileWorkspace,
  filterProfileProposal,
  profileDigest,
  runProfileDocumentAgent,
  validateIncrementalProfile,
  validateProfile,
  validateProfileCorrections,
  verifyProfileProposal,
  type L3ProfileDocument,
  type L3ProfileDraft,
  type L3ProfileEntry,
  type ProfileVerification,
} from './l3-profile-workspace.ts';

export interface L3ProfileScope {
  owner_id: string;
  contact_id: string | null;
}

export interface L3ProfileClaim {
  task_id: string;
  step_id: string;
  step_name: 'organize_memory';
  worker_id: string;
  lease_generation: number;
}

type Row = Record<string, any>;
type Transaction = <T>(work: (client: Client) => Promise<T>) => Promise<T>;

export interface L3ProfilePreparedWork {
  profile_batch_id: string;
  work_token: string;
  scope: L3ProfileScope;
  claim: L3ProfileClaim;
  settings_generation: number;
  organization_generation: number;
  correction_revision: number;
  scenario_version_ids: string[];
  scenarios: L2ScenarioVersion[];
  scenario_snapshot: Row[];
  memories: L2ScenarioMemory[];
  manifest: Row[];
  dependencies: string[];
  existing_profile: L3ProfileDocument | null;
  changed_scenarios: L2ScenarioVersion[];
  removed_scenario_version_ids: string[];
  base_profile_version_id: string | null;
  feedback: Row[];
  model_calls_remaining: number;
  contract: string;
}

export class L3ProfileServiceConflict extends Error {
  readonly code: string;
  constructor(code = 'l3_profile_changed') {
    super(code);
    this.code = code;
    this.name = 'L3ProfileServiceConflict';
  }
}

export interface L3ProfileServiceOptions {
  transaction: Transaction;
  model: ScenarioDocumentCallPort;
  binding: ScenarioDocumentCall['binding'];
  profile: MessagesBudgetProfile;
  budget?: L2ScenarioBudget;
  now?: () => Date;
  lease_seconds?: number;
  validateSources?: (client: Client, work: {scope: L3ProfileScope; inputs: L2ScenarioMemory[]}) => Promise<void>;
}

export interface L3ProfileManagement {
  settings_generation: number;
  organization_generation: number;
  version_id: string;
  item_index: number;
  operation_id: string;
  reason: string;
}

export interface L3ProfileRead {
  schema_version: 2;
  scope_kind: 'owner'|'contact';
  contact_id: string|null;
  settings_generation: number;
  organization_generation: number;
  status: string;
  error_code: string|null;
  profile: {
    version_id: string;
    system_generated: true;
    updated_at: string;
    entries: L3ProfileEntry[];
  }|null;
  scenarios: L2ScenarioVersion[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = new Set(['disabled','ready','empty','failed','updating','stale','blocked','paused']);
const SOURCE_KINDS = new Set(['manual_entry','source_supported']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positive(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
}

function correctionContext(feedback: readonly Row[]): Row[] {
  return feedback.flatMap(row => {
    if (
      row.state !== 'active'
      || typeof row.rejected_text !== 'string'
      || !row.rejected_text.trim()
    ) return [];
    return [{
      feedback_id:String(row.id),
      rejected_text:row.rejected_text,
      reason:typeof row.reason === 'string' ? row.reason : '',
      rule:'independent-literal-v1',
    }];
  });
}

function contactParameter(scope: L3ProfileScope): string|null {
  return scope.contact_id;
}

async function lockScope(client: Client, scope: L3ProfileScope): Promise<void> {
  if (scope.contact_id !== null) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`contact:${scope.owner_id}:${scope.contact_id}`]);
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`owner:${scope.owner_id}`]);
}

async function assertClaim(client: Client, scope: L3ProfileScope, claim: L3ProfileClaim): Promise<void> {
  const row = (await client.query(`SELECT 1 FROM public.background_task t
    JOIN public.background_task_step s ON s.task_id=t.id
    WHERE t.id=$1 AND s.id=$2 AND t.owner_id=$3 AND t.contact_id IS NOT DISTINCT FROM $4::uuid
      AND t.task_type='layered_memory' AND t.current_step='organize_memory'
      AND t.status IN ('queued','running','verifying') AND s.step_name='organize_memory'
      AND s.status='running' AND s.worker_id=$5 AND s.lease_generation=$6
      AND s.lease_expires_at>clock_timestamp()`,
  [claim.task_id, claim.step_id, scope.owner_id, contactParameter(scope), claim.worker_id, claim.lease_generation])).rowCount;
  if (!row) throw new L3ProfileServiceConflict('l3_profile_claim_stale');
}

async function readState(client: Client, scope: L3ProfileScope, forUpdate = false): Promise<Row|undefined> {
  return (await client.query(`SELECT * FROM public.layered_memory_state
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
  [scope.owner_id, contactParameter(scope)])).rows[0];
}

async function readJob(client: Client, scope: L3ProfileScope, taskId: string, forUpdate = false): Promise<Row|undefined> {
  return (await client.query(`SELECT * FROM public.layered_memory_job
    WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
  [taskId, scope.owner_id, contactParameter(scope)])).rows[0];
}

async function overview(client: Client, scope: L3ProfileScope): Promise<ContextMetadata[]> {
  return (scope.contact_id === null
    ? await readReplyOwnerOverview(client, scope.owner_id, true)
    : await readReplyContactOverview(client, {owner_id:scope.owner_id, contact_id:scope.contact_id})).entries;
}

function memoryFrom(entry: ContextMetadata, now: bigint): L2ScenarioMemory|null {
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
  if (memory.valid_at && epochMicros(memory.valid_at) > now) return null;
  if (memory.invalid_at && epochMicros(memory.invalid_at) <= now) return null;
  const manifest = entry.dependency_manifest as Row|null;
  if (!manifest || manifest.memory_id !== memory.memory_id) {
    throw new L3ProfileServiceConflict('l3_profile_manifest_unavailable');
  }
  const messageIds = ((entry.provenance?.references ?? []) as Row[])
    .map(reference => reference.message_id)
    .filter((value): value is string => typeof value === 'string' && UUID.test(value));
  return {
    memory_id:memory.memory_id,
    revision:memory.revision,
    level:memory.level === 'owner' ? 'owner' : 'contact',
    text:memory.text,
    category:String(memory.category),
    provenance_kind:provenance as 'manual_entry'|'source_supported',
    timing:clone(memory.timing ?? {}),
    event:clone(memory.event ?? null),
    conditions:clone(memory.conditions ?? null),
    evolution:clone(memory.evolution ?? null),
    valid_at:memory.valid_at ?? null,
    invalid_at:memory.invalid_at ?? null,
    dependency_ids:[...(entry.dependency_ids ?? [])].map(String).sort(),
    message_ids:[...new Set(messageIds)].sort(),
    dependency_manifest:clone(manifest),
  };
}

function organizationManifest(input: L2ScenarioMemory): Row {
  return {...clone(input.dependency_manifest), organization_timing_sha256:scenarioDigest(input.timing)};
}

async function currentGeneration(client: Client, scope: L3ProfileScope, generation: number): Promise<Row|undefined> {
  return (await client.query(`SELECT * FROM public.layered_memory_generation
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3`,
  [scope.owner_id, contactParameter(scope), generation])).rows[0];
}

async function scenarioRows(client: Client, scope: L3ProfileScope, ids: readonly string[]): Promise<Row[]> {
  if (!ids.length) return [];
  return (await client.query(`SELECT v.*,b.input_manifest,b.dependency_ids,v.organization_generation AS batch_generation
    FROM public.scenario_document_version v JOIN public.layered_memory_batch b ON b.id=v.batch_id
    WHERE v.owner_id=$1 AND v.contact_id IS NOT DISTINCT FROM $2::uuid AND v.id=ANY($3::uuid[])
    ORDER BY v.scenario_id`, [scope.owner_id, contactParameter(scope), ids])).rows;
}

async function currentScenarioRows(
  client: Client,
  scope: L3ProfileScope,
  generation: number,
): Promise<{manifest:Row; ids:string[]; rows:Row[]}|null> {
  const manifest = await currentGeneration(client, scope, generation);
  if (!manifest) return null;
  const ids = manifest.scenario_version_ids;
  if (
    !Array.isArray(ids)
    || ids.some((id: unknown) => typeof id !== 'string' || !UUID.test(id))
    || new Set(ids).size !== ids.length
  ) throw new L3ProfileServiceConflict('l3_profile_generation_changed');
  const rows = await scenarioRows(client, scope, ids);
  if (
    rows.length !== ids.length
    || new Set(rows.map(row => row.id)).size !== rows.length
    || new Set(rows.map(row => row.scenario_id)).size !== rows.length
  ) throw new L3ProfileServiceConflict('l3_profile_generation_changed');
  return {manifest, ids, rows};
}

async function currentScenarios(client: Client, scope: L3ProfileScope, generation: number): Promise<L2ScenarioVersion[]> {
  const current = await currentScenarioRows(client, scope, generation);
  if (!current) return [];
  return current.rows.map(row => ({
    scenario_id:row.scenario_id,
    version_id:row.id,
    title:row.title,
    hint:row.hint,
    paragraphs:clone(row.paragraphs),
    input_manifest:clone(row.input_manifest ?? []),
    dependency_ids:[...(row.dependency_ids ?? [])].map(String),
  }));
}

async function feedbackRows(client: Client, scope: L3ProfileScope): Promise<Row[]> {
  return (await client.query(`SELECT * FROM public.layered_memory_feedback
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND state IN ('active','erased_guard')
    ORDER BY created_at,id`, [scope.owner_id, contactParameter(scope)])).rows;
}

function guarded(
  entries: readonly ContextMetadata[],
  feedback: readonly Row[],
  now: bigint,
): L2ScenarioMemory[] {
  const memoryGuard = new Set(feedback.flatMap(row => row.protected_memory_ids ?? []));
  const messageGuard = new Set(feedback.flatMap(row => row.protected_message_ids ?? []));
  return entries.flatMap(entry => {
    const memory = memoryFrom(entry, now);
    return memory && !memoryGuard.has(memory.memory_id) && !memory.message_ids.some(id => messageGuard.has(id))
      ? [memory]
      : [];
  });
}

function snapshot(scenarios: readonly L2ScenarioVersion[]): Row[] {
  return scenarios.map(scenario => ({
    scenario_id:scenario.scenario_id,
    version_id:scenario.version_id,
    title:scenario.title,
    hint:scenario.hint,
    paragraphs:scenario.paragraphs,
    input_manifest:scenario.input_manifest,
    dependency_ids:scenario.dependency_ids,
  }));
}

function deterministicUuid(...parts: string[]): string {
  const bytes = Buffer.from(scenarioDigest(parts), 'hex').subarray(0,16);
  bytes[6] = bytes[6]! & 0x0f | 0x50;
  bytes[8] = bytes[8]! & 0x3f | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

function checkedBudget(value: L2ScenarioBudget): L2ScenarioBudget {
  const budget = clone(value);
  for (const item of Object.values(budget)) {
    if (!Number.isSafeInteger(item) || item < 1) throw new L2ScenarioError('l3_profile_budget_invalid');
  }
  if (budget.max_model_calls < 2 || budget.max_model_calls > 16) throw new L2ScenarioError('l3_profile_budget_invalid');
  return budget;
}

export class L3ProfileService {
  readonly budget: L2ScenarioBudget;
  private readonly transaction: Transaction;
  private readonly model: ScenarioDocumentCallPort;
  private readonly binding: ScenarioDocumentCall['binding'];
  private readonly profile: MessagesBudgetProfile;
  private readonly now: () => Date;
  private readonly leaseSeconds: number;
  private readonly validateSources: L3ProfileServiceOptions['validateSources'];

  constructor(options: L3ProfileServiceOptions) {
    this.transaction = options.transaction;
    this.model = options.model;
    this.binding = clone(options.binding);
    this.profile = clone(options.profile);
    this.budget = checkedBudget(options.budget ?? DEFAULT_L2_SCENARIO_BUDGET);
    this.now = options.now ?? (() => new Date());
    this.leaseSeconds = Number.isSafeInteger(options.lease_seconds) && options.lease_seconds! > 0
      ? Math.min(options.lease_seconds!, 900)
      : 300;
    this.validateSources = options.validateSources;
  }

  private validateScope(scope: L3ProfileScope): void {
    if (!scope || !UUID.test(scope.owner_id) || scope.contact_id !== null && !UUID.test(scope.contact_id)) {
      throw new L2ScenarioError('l3_profile_scope_invalid');
    }
  }

  private validateClaim(claim: L3ProfileClaim): void {
    if (
      !claim
      || ![claim.task_id,claim.step_id,claim.worker_id].every(value => typeof value === 'string' && UUID.test(value))
      || claim.step_name !== 'organize_memory'
      || !Number.isSafeInteger(claim.lease_generation)
      || claim.lease_generation < 1
    ) throw new L2ScenarioError('l3_profile_claim_invalid');
  }

  private validateManagement(command: L3ProfileManagement): void {
    if (
      !command
      || !Number.isSafeInteger(command.settings_generation)
      || command.settings_generation < 0
      || !Number.isSafeInteger(command.organization_generation)
      || command.organization_generation < 0
      || !Number.isSafeInteger(command.item_index)
      || command.item_index < 0
      || command.item_index >= 100
      || [command.version_id,command.operation_id].some(value => typeof value !== 'string' || !UUID.test(value))
      || typeof command.reason !== 'string'
      || !command.reason.trim()
      || [...command.reason.trim()].length > 500
    ) throw new L2ScenarioError('l3_profile_management_invalid');
  }

  private async assertCurrent(client: Client, work: L3ProfilePreparedWork): Promise<void> {
    await assertClaim(client, work.scope, work.claim);
    const state = await readState(client, work.scope, true);
    const job = await readJob(client, work.scope, work.claim.task_id, true);
    if (
      !state?.enabled
      || !STATUS.has(String(state.status))
      || Number(state.settings_generation) !== work.settings_generation
      || Number(state.organization_generation) !== work.organization_generation
      || Number(state.correction_revision ?? 0) !== work.correction_revision
      || !job
      || job.state !== 'active'
      || !job.profile_required
      || !['pending','failed'].includes(String(job.profile_status))
    ) throw new L3ProfileServiceConflict('l3_profile_changed');
    const batch = (await client.query(`SELECT * FROM public.layered_profile_batch
      WHERE id=$1 AND task_id=$2 AND owner_id=$3 AND contact_id IS NOT DISTINCT FROM $4::uuid
        AND status='running' AND work_token=$5 AND lease_expires_at>$6 FOR UPDATE`,
    [work.profile_batch_id, work.claim.task_id, work.scope.owner_id, contactParameter(work.scope),
      work.work_token, this.now()])).rows[0];
    if (!batch) throw new L3ProfileServiceConflict('l3_profile_batch_stale');
    if (
      Number(batch.settings_generation) !== work.settings_generation
      || Number(batch.organization_generation) !== work.organization_generation
      || canonicalScenarioJSON(batch.scenario_version_ids) !== canonicalScenarioJSON(work.scenario_version_ids)
      || canonicalScenarioJSON(batch.input_manifest) !== canonicalScenarioJSON(work.manifest)
    ) throw new L3ProfileServiceConflict('l3_profile_batch_stale');
    const scenarios = await currentScenarios(client, work.scope, work.organization_generation);
    if (canonicalScenarioJSON(snapshot(scenarios)) !== canonicalScenarioJSON(work.scenario_snapshot)) {
      throw new L3ProfileServiceConflict('l3_profile_generation_changed');
    }
    const feedback = await feedbackRows(client, work.scope);
    const current = guarded(await overview(client, work.scope), feedback, BigInt(this.now().getTime()) * 1_000n);
    const currentManifest = new Map(current.map(memory => [`${memory.memory_id}:${memory.revision}`, organizationManifest(memory)]));
    if (canonicalScenarioJSON(work.manifest) !== canonicalScenarioJSON(work.memories.map(memory =>
      currentManifest.get(`${memory.memory_id}:${memory.revision}`)))) {
      throw new L3ProfileServiceConflict('l3_profile_source_changed');
    }
    if (this.validateSources) await this.validateSources(client, {scope:work.scope, inputs:work.memories});
    if (work.base_profile_version_id) {
      const base = (await client.query(`SELECT id,withdrawn FROM public.layered_profile_version
        WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid`,
      [work.base_profile_version_id, work.scope.owner_id, contactParameter(work.scope)])).rows[0];
      if (!base || base.withdrawn) throw new L3ProfileServiceConflict('l3_profile_base_stale');
    }
  }

  requireCurrent(work: L3ProfilePreparedWork): Promise<void> {
    return this.transaction(async client => {
      await lockScope(client, work.scope);
      await this.assertCurrent(client, work);
    });
  }

  async prepare(scope: L3ProfileScope, claim: L3ProfileClaim): Promise<L3ProfilePreparedWork|'settled'|null> {
    this.validateScope(scope);
    this.validateClaim(claim);
    return this.transaction(async client => {
      await lockScope(client, scope);
      await assertClaim(client, scope, claim);
      const state = await readState(client, scope, true);
      const job = await readJob(client, scope, claim.task_id, true);
      if (!state?.enabled || !STATUS.has(String(state.status))) throw new L3ProfileServiceConflict('l3_profile_disabled');
      if (
        !job
        || job.state !== 'active'
        || Number(job.settings_generation) !== Number(state.settings_generation)
      ) throw new L3ProfileServiceConflict('l3_profile_job_stale');
      if (!job.profile_required) return 'settled';
      if (['succeeded','not_required'].includes(String(job.profile_status))) return 'settled';
      if (
        !job.pending_receipt
        || !job.receipt_batch_id
        || !job.receipt_lease_generation
      ) throw new L3ProfileServiceConflict('l3_profile_l2_receipt_missing');
      const receipt = (await client.query(`SELECT status,settings_generation
        FROM public.layered_memory_batch WHERE id=$1 AND task_id=$2 AND owner_id=$3
          AND contact_id IS NOT DISTINCT FROM $4::uuid`,
      [job.receipt_batch_id, claim.task_id, scope.owner_id, contactParameter(scope)])).rows[0];
      if (
        !receipt
        || receipt.status !== 'succeeded'
        || Number(receipt.settings_generation) !== Number(job.settings_generation)
      ) throw new L3ProfileServiceConflict('l3_profile_l2_receipt_stale');

      const generationValue = Number(state.organization_generation);
      const current = await currentScenarioRows(client, scope, generationValue);
      if (!current) throw new L3ProfileServiceConflict('l3_profile_generation_missing');
      const {manifest: generation, rows: currentScenariosRows} = current;
      const feedback = await feedbackRows(client, scope);
      if (!currentScenariosRows.length) {
        await client.query(`UPDATE public.layered_profile_batch SET status='failed',error_code='profile_not_required'
          WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND status='running'`,
        [scope.owner_id, contactParameter(scope)]);
        await client.query(`UPDATE public.layered_memory_job SET profile_status='not_required'
          WHERE task_id=$1 AND state='active'`, [claim.task_id]);
        return 'settled';
      }
      const allowed = guarded(await overview(client, scope), feedback, BigInt(this.now().getTime()) * 1_000n);
      const allowedManifest = new Map(allowed.map(memory => [`${memory.memory_id}:${memory.revision}`, organizationManifest(memory)]));
      const inputCurrent = (item: Row) => {
        const current = allowedManifest.get(`${item.memory_id}:${item.revision}`);
        return Boolean(current) && canonicalScenarioJSON(current) === canonicalScenarioJSON(item);
      };
      const validScenarioRows = currentScenariosRows.filter(row =>
        row.paragraphs.every((paragraph: Row) => paragraph.references.every((reference: Row) =>
          allowedManifest.has(`${reference.memory_id}:${reference.revision}`)))
        && row.input_manifest.every(inputCurrent));
      if (!validScenarioRows.length) {
        await this.publishWithoutProfile(client, scope, state, generationValue, []);
        await client.query(`UPDATE public.layered_memory_job SET profile_status='not_required'
          WHERE task_id=$1 AND state='active'`, [claim.task_id]);
        await client.query(`UPDATE public.layered_memory_state SET status='empty',error_code=NULL,updated_at=$3
          WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
        [scope.owner_id, contactParameter(scope), this.now()]);
        return 'settled';
      }
      const scenarioIds = validScenarioRows.map(row => row.id as string);
      const scenarios = await currentScenarios(client, scope, generationValue);
      const visibleScenarios = scenarios.filter(scenario => scenarioIds.includes(scenario.version_id));
      const memoryIds = new Set<string>();
      const rawManifest = new Map<string, Row>();
      for (const row of validScenarioRows) {
        for (const item of row.input_manifest as Row[]) {
          const key = `${item.memory_id}:${item.revision}`;
          rawManifest.set(key, item);
          memoryIds.add(item.memory_id);
        }
      }
      const memories = allowed
        .filter(memory => memoryIds.has(memory.memory_id))
        .sort((left,right) => `${left.memory_id}:${left.revision}`.localeCompare(`${right.memory_id}:${right.revision}`));
      const manifest = [...rawManifest.keys()].sort().map(key => allowedManifest.get(key)!);
      if (
        memories.length !== memoryIds.size
        || manifest.some(item => !item)
        || canonicalScenarioJSON(manifest) !== canonicalScenarioJSON([...rawManifest.keys()].sort().map(key => {
          const memory = memories.find(candidate => `${candidate.memory_id}:${candidate.revision}` === key);
          return memory ? organizationManifest(memory) : null;
        }))
      ) throw new L3ProfileServiceConflict('l3_profile_source_changed');
      if (generation.profile_version_id) {
        const current = (await client.query(`SELECT v.id,v.withdrawn,b.status,b.scenario_version_ids,b.input_manifest
          FROM public.layered_profile_version v
          JOIN public.layered_profile_batch b ON b.id=v.batch_id
          WHERE v.id=$1 AND v.owner_id=$2 AND v.contact_id IS NOT DISTINCT FROM $3::uuid`,
        [generation.profile_version_id, scope.owner_id, contactParameter(scope)])).rows[0];
        const sameScenarios = Array.isArray(current?.scenario_version_ids)
          && canonicalScenarioJSON([...current.scenario_version_ids].sort())
            === canonicalScenarioJSON([...scenarioIds].sort());
        if (
          current
          && !current.withdrawn
          && current.status === 'succeeded'
          && validScenarioRows.length === currentScenariosRows.length
          && sameScenarios
          && canonicalScenarioJSON(current.input_manifest) === canonicalScenarioJSON(manifest)
        ) {
          await client.query(`UPDATE public.layered_memory_job SET profile_status='succeeded'
            WHERE task_id=$1 AND state='active'`, [claim.task_id]);
          await client.query(`UPDATE public.layered_memory_state SET status='ready',error_code=NULL,updated_at=$3
            WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
          [scope.owner_id, contactParameter(scope), this.now()]);
          return 'settled';
        }
      }

      let baseProfile: Row|undefined;
      if (!feedback.length) {
        baseProfile = (await client.query(`SELECT v.*,b.scenario_version_ids,b.input_manifest,b.dependency_ids,b.correction_input
          FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id
          WHERE v.owner_id=$1 AND v.contact_id IS NOT DISTINCT FROM $2::uuid
            AND b.settings_generation=$3 AND b.status='succeeded' AND NOT v.withdrawn
          ORDER BY v.created_at DESC,v.id DESC LIMIT 1`,
        [scope.owner_id, contactParameter(scope), state.settings_generation])).rows[0];
        if (baseProfile && (
          !Array.isArray(baseProfile.scenario_version_ids)
          || baseProfile.scenario_version_ids.some((id: unknown) =>
            typeof id !== 'string' || !scenarioIds.includes(id))
          || Array.isArray(baseProfile.correction_input) && baseProfile.correction_input.length
          || !Array.isArray(baseProfile.input_manifest)
          || baseProfile.input_manifest.some((item: Row) => !inputCurrent(item))
        )) baseProfile = undefined;
      }
      const existing = baseProfile ? {
        version_id:baseProfile.id as string,
        entries:clone(baseProfile.entries) as L3ProfileEntry[],
      } : null;
      const baseIds = new Set<string>(baseProfile?.scenario_version_ids ?? []);
      const changedScenarios = visibleScenarios.filter(scenario => !baseIds.has(scenario.version_id));
      const removedScenarioVersionIds = [...baseIds].filter(id => !scenarioIds.includes(id)).sort();
      const contract = 'l3-profile-tools-v1:verified-items-v1';
      if (
        baseProfile
        && scenarioIds.length === baseIds.size
        && scenarioIds.every(id => baseIds.has(id))
        && canonicalScenarioJSON(baseProfile.input_manifest) === canonicalScenarioJSON(manifest)
      ) {
        await this.publishReuse(client, scope, state, claim.task_id, scenarioIds, baseProfile.id, validScenarioRows);
        return 'settled';
      }

      const dependencies = new Set<string>([
        ...validScenarioRows.flatMap(row => row.dependency_ids ?? []),
        ...memories.flatMap(memory => [memory.memory_id,...memory.dependency_ids]),
        ...feedback.flatMap(row => [
          ...(row.dependency_ids ?? []),
          ...(row.protected_memory_ids ?? []),
          ...(row.protected_message_ids ?? []),
        ]),
      ]);
      const payload = {
        contract,
        existing_profile:existing,
        changed_scenario_ids:changedScenarios.map(scenario => scenario.scenario_id),
        removed_scenario_version_ids:removedScenarioVersionIds,
        base_profile_version_id:existing?.version_id ?? null,
        scenarios:visibleScenarios,
        memories:memories.map(memory => ({
          memory_id:memory.memory_id,
          revision:memory.revision,
          text:memory.text,
          category:memory.category,
          provenance_kind:memory.provenance_kind,
          timing:memory.timing,
          event:memory.event,
          conditions:memory.conditions,
          evolution:memory.evolution,
          valid_at:memory.valid_at,
          invalid_at:memory.invalid_at,
        })),
        corrections:correctionContext(feedback),
      };
      if (JSON.stringify(payload).length > this.budget.max_characters) {
        await client.query(`UPDATE public.layered_memory_state SET status='failed',error_code='profile_input_budget_exceeded',updated_at=$3
          WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
        [scope.owner_id, contactParameter(scope), this.now()]);
        await client.query(`UPDATE public.layered_memory_job SET profile_status='failed'
          WHERE task_id=$1 AND state='active'`, [claim.task_id]);
        return null;
      }
      const modelCallsUsed = positive(job.model_calls_used);
      const modelCallLimit = positive(job.model_call_limit, this.budget.max_model_calls);
      const modelCallsRemaining = Math.max(0, modelCallLimit - modelCallsUsed);
      // 新画像至少需要一轮提案与一轮独立核验；不足时不发起物理调用。
      if (modelCallsRemaining < 2) {
        await client.query(`UPDATE public.layered_memory_state SET status='paused',error_code='model_call_budget_exhausted',updated_at=$3
          WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
        [scope.owner_id, contactParameter(scope), this.now()]);
        await client.query(`UPDATE public.layered_memory_job SET state='paused',profile_status='failed'
          WHERE task_id=$1 AND state='active'`, [claim.task_id]);
        return null;
      }
      const workKey = profileDigest({
        task:claim.task_id,
        settings:Number(state.settings_generation),
        revision:Number(job.revision),
        contract,
        budget:this.budget,
        scenario_version_ids:scenarioIds,
        manifest,
        base:existing?.version_id ?? null,
      });
      let previous = (await client.query(`SELECT * FROM public.layered_profile_batch
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND work_key=$3 FOR UPDATE`,
      [scope.owner_id, contactParameter(scope), workKey])).rows[0];
      const now = this.now();
      if (previous && ['succeeded','withdrawn'].includes(previous.status)) {
        await client.query(`UPDATE public.layered_memory_job SET profile_status='succeeded'
          WHERE task_id=$1 AND state='active'`, [claim.task_id]);
        return 'settled';
      }
      if (previous && previous.status === 'running' && new Date(previous.lease_expires_at) > now) return null;
      if (previous && Number(previous.attempt_count) >= 2) {
        await client.query(`UPDATE public.layered_profile_batch SET status='failed',error_code='profile_retry_exhausted'
          WHERE id=$1`, [previous.id]);
        await client.query(`UPDATE public.layered_memory_job SET profile_status='failed'
          WHERE task_id=$1 AND state='active'`, [claim.task_id]);
        await client.query(`UPDATE public.layered_memory_state SET status='failed',error_code='profile_retry_exhausted',updated_at=$3
          WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
        [scope.owner_id, contactParameter(scope), now]);
        return null;
      }
      const budgetBatchId = validScenarioRows
        .slice().sort((left,right) => Number(right.batch_generation) - Number(left.batch_generation))[0]!.batch_id;
      const profileBatchId = previous?.id ?? randomUUID();
      const workToken = randomUUID();
      const leaseExpires = new Date(now.getTime() + this.leaseSeconds * 1_000);
      if (previous) {
        await client.query(`UPDATE public.layered_profile_batch
          SET work_token=$2,status='running',attempt_count=attempt_count+1,lease_expires_at=$3,
            organization_generation=$4,input_manifest=$5,input_payload=$6,output_payload=NULL,error_code=NULL,
            dependency_ids=$7,correction_input=$8,scenario_version_ids=$9
          WHERE id=$1`,
        [profileBatchId, workToken, leaseExpires, generationValue, JSON.stringify(manifest), JSON.stringify(payload),
          [...dependencies].sort(), JSON.stringify(feedback), scenarioIds]);
      } else {
        await client.query(`INSERT INTO public.layered_profile_batch
          (id,owner_id,contact_id,settings_generation,organization_generation,work_key,work_token,budget_batch_id,task_id,
           status,lease_expires_at,scenario_version_ids,input_manifest,input_payload,dependency_ids,error_code,created_at,correction_input)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,$11,$12,$13,$14,NULL,$15,$16)`,
        [profileBatchId, scope.owner_id, contactParameter(scope), state.settings_generation, generationValue,
          workKey, workToken, budgetBatchId, claim.task_id, leaseExpires, scenarioIds, JSON.stringify(manifest),
          JSON.stringify(payload), [...dependencies].sort(), now, JSON.stringify(feedback)]);
      }
      await client.query(`UPDATE public.layered_memory_job SET profile_status='pending'
        WHERE task_id=$1 AND state='active'`, [claim.task_id]);
      await client.query(`UPDATE public.layered_memory_state SET status='updating',error_code=NULL,updated_at=$3
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
      [scope.owner_id, contactParameter(scope), now]);
      return {
        profile_batch_id:profileBatchId,
        work_token:workToken,
        scope:{...scope},
        claim:clone(claim),
        settings_generation:Number(state.settings_generation),
        organization_generation:generationValue,
        correction_revision:Number(state.correction_revision ?? 0),
        scenario_version_ids:scenarioIds,
        scenarios:visibleScenarios,
        scenario_snapshot:snapshot(visibleScenarios),
        memories,
        manifest,
        dependencies:[...dependencies].sort(),
        existing_profile:existing,
        changed_scenarios:changedScenarios,
        removed_scenario_version_ids:removedScenarioVersionIds,
        base_profile_version_id:existing?.version_id ?? null,
        feedback,
        model_calls_remaining:modelCallsRemaining,
        contract,
      };
    });
  }

  private async publishReuse(
    client: Client,
    scope: L3ProfileScope,
    state: Row,
    taskId: string,
    scenarioIds: readonly string[],
    profileVersionId: string,
    scenarioRowsValue: readonly Row[],
  ): Promise<void> {
    const dependencies = new Set<string>();
    for (const row of scenarioRowsValue) for (const id of row.dependency_ids ?? []) dependencies.add(id);
    const profile = (await client.query(`SELECT b.dependency_ids FROM public.layered_profile_version v
      JOIN public.layered_profile_batch b ON b.id=v.batch_id
      WHERE v.id=$1 AND v.owner_id=$2 AND v.contact_id IS NOT DISTINCT FROM $3::uuid AND NOT v.withdrawn`,
    [profileVersionId, scope.owner_id, contactParameter(scope)])).rows[0];
    if (!profile) throw new L3ProfileServiceConflict('l3_profile_base_stale');
    for (const id of profile.dependency_ids ?? []) dependencies.add(id);
    const generation = Number(state.organization_generation) + 1;
    await client.query(`INSERT INTO public.layered_memory_generation
      (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,dependency_ids,created_at)
      VALUES($1,$2,$3,2,$4,$5,$6,$7)`,
    [scope.owner_id, contactParameter(scope), generation, scenarioIds, profileVersionId,
      [...dependencies].sort(), this.now()]);
    const changed = await client.query(`UPDATE public.layered_memory_state
      SET organization_generation=$3,status='ready',error_code=NULL,updated_at=$4
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
        AND organization_generation=$5 AND enabled`,
    [scope.owner_id, contactParameter(scope), generation, this.now(), Number(state.organization_generation)]);
    if (changed.rowCount !== 1) throw new L3ProfileServiceConflict('l3_profile_changed');
    await client.query(`UPDATE public.layered_memory_job SET profile_status='succeeded'
      WHERE task_id=$1 AND state='active'`, [taskId]);
  }

  async recordProposal(work: L3ProfilePreparedWork, original: unknown, filtered: L3ProfileDraft, rejected: unknown): Promise<void> {
    await this.transaction(async client => {
      await lockScope(client, work.scope);
      await this.assertCurrent(client, work);
      await client.query(`UPDATE public.layered_profile_batch
        SET output_payload=$2 WHERE id=$1 AND status='running'`,
      [work.profile_batch_id, JSON.stringify({original, filtered, rejected, verification_result:null})]);
    });
  }

  async recordVerification(work: L3ProfilePreparedWork, result: ProfileVerification, errorCode: string|null): Promise<void> {
    await this.transaction(async client => {
      await lockScope(client, work.scope);
      await this.assertCurrent(client, work);
      await client.query(`UPDATE public.layered_profile_batch
        SET output_payload=jsonb_set(COALESCE(output_payload,'{}'::jsonb),'{verification_result}',$2::jsonb),
          error_code=$3
        WHERE id=$1 AND status='running'`,
      [work.profile_batch_id, JSON.stringify(result), errorCode]);
    });
  }

  async publish(work: L3ProfilePreparedWork, proposal: L3ProfileDraft, signal?: AbortSignal): Promise<void> {
    await this.transaction(async client => {
      await lockScope(client, work.scope);
      await this.assertCurrent(client, work);
      signal?.throwIfAborted();
      validateProfile({entries:proposal.entries}, work.memories, this.budget);
      validateProfileCorrections(
        proposal.entries,
        new Set(correctionContext(work.feedback).map(item => String(item.rejected_text))),
      );
      validateIncrementalProfile(proposal, work.existing_profile, work.changed_scenarios);
      const profileId = deterministicUuid('l3-profile', work.profile_batch_id, profileDigest(proposal.entries));
      await client.query(`INSERT INTO public.layered_profile_version
        (id,owner_id,contact_id,batch_id,schema_version,entries,withdrawn,created_at)
        VALUES($1,$2,$3,$4,2,$5,false,$6)`,
      [profileId, work.scope.owner_id, contactParameter(work.scope), work.profile_batch_id,
        JSON.stringify(proposal.entries), this.now()]);
      const generation = work.organization_generation + 1;
      await client.query(`INSERT INTO public.layered_memory_generation
        (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,dependency_ids,created_at)
        VALUES($1,$2,$3,2,$4,$5,$6,$7)`,
      [work.scope.owner_id, contactParameter(work.scope), generation, work.scenario_version_ids,
        profileId, work.dependencies, this.now()]);
      const changed = await client.query(`UPDATE public.layered_memory_state
        SET organization_generation=$3,status='ready',error_code=NULL,updated_at=$4
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
          AND settings_generation=$5 AND organization_generation=$6 AND enabled`,
      [work.scope.owner_id, contactParameter(work.scope), generation, this.now(),
        work.settings_generation, work.organization_generation]);
      if (changed.rowCount !== 1) throw new L3ProfileServiceConflict('l3_profile_changed');
      await client.query(`UPDATE public.layered_profile_batch SET status='succeeded',output_payload=
        COALESCE(output_payload,'{}'::jsonb)||$2::jsonb WHERE id=$1 AND status='running'`,
      [work.profile_batch_id, JSON.stringify({verification_result:true, organization_generation:generation})]);
      await client.query(`UPDATE public.layered_memory_job SET profile_status='succeeded'
        WHERE task_id=$1 AND state='active'`, [work.claim.task_id]);
    });
  }

  async fail(work: L3ProfilePreparedWork, code: string): Promise<void> {
    if (!/^[a-z0-9_]{1,80}$/.test(code)) throw new L2ScenarioError('l3_profile_failure_code_invalid');
    await this.transaction(async client => {
      await lockScope(client, work.scope);
      try { await assertClaim(client, work.scope, work.claim); }
      catch (error) {
        if (error instanceof L3ProfileServiceConflict) return;
        throw error;
      }
      const state = await readState(client, work.scope);
      if (!state?.enabled || Number(state.settings_generation) !== work.settings_generation
        || Number(state.organization_generation) !== work.organization_generation
        || Number(state.correction_revision ?? 0) !== work.correction_revision) return;
      const failed = await client.query(`UPDATE public.layered_profile_batch SET status='failed',error_code=$2
        WHERE id=$1 AND status='running'`, [work.profile_batch_id, code]);
      if (!failed.rowCount) return;
      await client.query(`UPDATE public.layered_memory_job SET profile_status='failed'
        WHERE task_id=$1 AND state='active'`, [work.claim.task_id]);
      await client.query(`UPDATE public.layered_memory_state SET status=$3,error_code=$2,updated_at=$4
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $5::uuid
          AND settings_generation=$6 AND organization_generation=$7`,
      [work.scope.owner_id, code, code === 'model_call_budget_exhausted' ? 'paused' : 'failed',
        this.now(), contactParameter(work.scope), work.settings_generation, work.organization_generation]);
    });
  }

  async run(scope: L3ProfileScope, claim: L3ProfileClaim, signal: AbortSignal): Promise<L3ProfileRead> {
    signal.throwIfAborted();
    const work = await this.prepare(scope, claim);
    if (!work || work === 'settled') return this.read(scope);
    try {
      signal.throwIfAborted();
      const corrections = correctionContext(work.feedback);
      const rejectedTexts = new Set(corrections.map(item => String(item.rejected_text)));
      const workspace = new L3ProfileWorkspace(work.existing_profile, work.scenarios, work.memories, this.budget);
      const agent = await runProfileDocumentAgent({
        workspace,
        existing:work.existing_profile,
        scenarios:work.scenarios,
        memories:work.memories,
        changedScenarios:work.changed_scenarios,
        removedScenarioVersionIds:work.removed_scenario_version_ids,
        baseProfileVersionId:work.base_profile_version_id,
        corrections,
        port:this.model,
        claim:work.claim,
        owner_id:scope.owner_id,
        contact_id:scope.contact_id,
        batch_id:work.profile_batch_id,
        binding:this.binding,
        profile:this.profile,
        signal,
        requireCurrent:() => this.requireCurrent(work),
        remainingCalls:work.model_calls_remaining,
      });
      const filtered = filterProfileProposal(
        {entries:agent.proposal.entries},
        work.memories,
        this.budget,
        rejectedTexts,
      );
      await this.recordProposal(work, agent.proposal, {entries:filtered.entries}, filtered.rejected);
      if (agent.proposal.entries.length && !filtered.entries.length) {
        throw new L2ScenarioError('l3_profile_proposal_invalid');
      }
      signal.throwIfAborted();
      const verification = await verifyProfileProposal({
        entries:filtered.entries,
        memories:work.memories,
        scenarios:work.scenarios,
        budget:this.budget,
        port:this.model,
        claim:work.claim,
        owner_id:scope.owner_id,
        contact_id:scope.contact_id,
        batch_id:work.profile_batch_id,
        binding:this.binding,
        profile:this.profile,
        signal,
        requireCurrent:() => this.requireCurrent(work),
        corrections,
      });
      await this.recordVerification(work, verification.result, null);
      const supported = filtered.entries.filter((_entry,index) =>
        verification.result.results.some(result => result.entry_index === index && result.supported));
      if (filtered.entries.length && !supported.length) throw new L2ScenarioError('l3_profile_faithfulness_rejected');
      signal.throwIfAborted();
      await this.publish(work, validateProfile({entries:supported}, work.memories, this.budget), signal);
      return this.read(scope);
    } catch (error) {
      const code = error instanceof L2ScenarioError || error instanceof L3ProfileServiceConflict
        ? error.code
        : signal.aborted ? 'l3_profile_cancelled' : 'l3_profile_model_failed';
      await this.fail(work, code).catch(() => {});
      throw error;
    }
  }

  async read(scope: L3ProfileScope): Promise<L3ProfileRead> {
    this.validateScope(scope);
    return this.transaction(async client => {
      const state = await readState(client, scope);
      if (!state) throw new L3ProfileServiceConflict('l3_profile_not_found');
      const generationValue = Number(state.organization_generation);
      const generation = await currentGeneration(client, scope, generationValue);
      const scenarios = generation?.scenario_version_ids?.length
        ? await currentScenarios(client, scope, generationValue)
        : [];
      let profile: L3ProfileRead['profile'] = null;
      if (generation?.profile_version_id) {
        const row = (await client.query(`SELECT * FROM public.layered_profile_version
          WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid`,
        [generation.profile_version_id, scope.owner_id, contactParameter(scope)])).rows[0];
        if (row && !row.withdrawn) profile = {
          version_id:row.id,
          system_generated:true,
          updated_at:new Date(row.created_at).toISOString(),
          entries:clone(row.entries),
        };
      }
      return {
        schema_version:2,
        scope_kind:scope.contact_id === null ? 'owner' : 'contact',
        contact_id:scope.contact_id,
        settings_generation:positive(state.settings_generation),
        organization_generation:generationValue,
        status:STATUS.has(String(state.status)) ? state.status : 'failed',
        error_code:state.error_code ?? null,
        profile,
        scenarios,
      };
    });
  }

  async withdraw(
    scope: L3ProfileScope,
    settingsGeneration: number,
    organizationGeneration: number,
    profileVersionId: string,
  ): Promise<L3ProfileRead> {
    this.validateScope(scope);
    if (!Number.isSafeInteger(settingsGeneration) || settingsGeneration < 0
      || !Number.isSafeInteger(organizationGeneration) || organizationGeneration < 0
      || !UUID.test(profileVersionId)) throw new L2ScenarioError('l3_profile_management_invalid');
    await this.transaction(async client => {
      await lockScope(client, scope);
      const state = await readState(client, scope, true);
      if (!state || Number(state.settings_generation) !== settingsGeneration) {
        throw new L3ProfileServiceConflict('l3_profile_changed');
      }
      const profile = (await client.query(`SELECT v.*,b.id AS profile_batch_id
        FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id
        WHERE v.id=$1 AND v.owner_id=$2 AND v.contact_id IS NOT DISTINCT FROM $3::uuid`,
      [profileVersionId, scope.owner_id, contactParameter(scope)])).rows[0];
      if (!profile) throw new L3ProfileServiceConflict('l3_profile_version_stale');
      if (profile.withdrawn && Number(state.organization_generation) === organizationGeneration + 1) {
        const generation = await currentGeneration(client, scope, Number(state.organization_generation));
        if (generation && generation.profile_version_id === null) return;
      }
      const current = await currentGeneration(client, scope, organizationGeneration);
      if (
        Number(state.organization_generation) !== organizationGeneration
        || !current
        || current.profile_version_id !== profileVersionId
        || profile.withdrawn
      ) throw new L3ProfileServiceConflict('l3_profile_changed');
      await deleteSourceReplies(client, scope.owner_id, [profileVersionId], scope.contact_id, false);
      await client.query(`UPDATE public.layered_profile_version SET withdrawn=true WHERE id=$1`, [profileVersionId]);
      await client.query(`UPDATE public.layered_profile_batch SET status='withdrawn' WHERE id=$1`, [profile.profile_batch_id]);
      await this.publishWithoutProfile(client, scope, state, organizationGeneration, current.scenario_version_ids ?? []);
      await client.query(`UPDATE public.layered_memory_job SET state='invalidated'
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND state='active'`,
      [scope.owner_id, contactParameter(scope)]);
    });
    return this.read(scope);
  }

  async reportError(scope: L3ProfileScope, command: L3ProfileManagement): Promise<L3ProfileRead> {
    this.validateScope(scope);
    this.validateManagement(command);
    await this.transaction(async client => {
      await lockScope(client, scope);
      const state = await readState(client, scope, true);
      const prior = (await client.query(`SELECT * FROM public.layered_memory_feedback
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND operation_id=$3`,
      [scope.owner_id, contactParameter(scope), command.operation_id])).rows[0];
      if (prior) {
        if (prior.request_digest !== scenarioDigest(command)
          || Number(state?.settings_generation) !== command.settings_generation
          || Number(prior.settings_generation) !== command.settings_generation) {
          throw new L3ProfileServiceConflict('l3_profile_operation_changed');
        }
        return;
      }
      if (
        !state
        || Number(state.settings_generation) !== command.settings_generation
        || Number(state.organization_generation) !== command.organization_generation
      ) throw new L3ProfileServiceConflict('l3_profile_changed');
      const generation = await currentGeneration(client, scope, command.organization_generation);
      if (!generation || generation.profile_version_id !== command.version_id) {
        throw new L3ProfileServiceConflict('l3_profile_feedback_target_stale');
      }
      const profile = (await client.query(`SELECT v.*,b.input_manifest,b.dependency_ids,b.id AS profile_batch_id
        FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id
        WHERE v.id=$1 AND v.owner_id=$2 AND v.contact_id IS NOT DISTINCT FROM $3::uuid AND NOT v.withdrawn`,
      [command.version_id, scope.owner_id, contactParameter(scope)])).rows[0];
      const entry = profile?.entries?.[command.item_index];
      if (!profile || !entry) throw new L3ProfileServiceConflict('l3_profile_feedback_target_stale');
      const feedback = await feedbackRows(client, scope);
      const allowed = guarded(await overview(client, scope), feedback, BigInt(this.now().getTime()) * 1_000n);
      const byVersion = new Map(allowed.map(memory => [`${memory.memory_id}:${memory.revision}`, memory]));
      const protectedMemories = profile.input_manifest.map((item: Row) =>
        byVersion.get(`${item.memory_id}:${item.revision}`));
      if (protectedMemories.some((memory: L2ScenarioMemory|undefined) => !memory)) {
        throw new L3ProfileServiceConflict('l3_profile_feedback_target_stale');
      }
      const protectedMemoryIds = [...new Set(protectedMemories.map((memory: L2ScenarioMemory) => memory.memory_id))].sort();
      const protectedMessageIds = [...new Set(protectedMemories.flatMap((memory: L2ScenarioMemory) => memory.message_ids))].sort();
      const dependencies = [...new Set<string>([
        ...(profile.dependency_ids ?? []),
        ...(profile.input_manifest ?? []).map((item: Row) => item.memory_id),
        ...protectedMessageIds,
      ])].sort();
      await client.query(`INSERT INTO public.layered_memory_feedback
        (id,owner_id,contact_id,operation_id,request_digest,settings_generation,target_kind,version_id,item_index,reason,
          rejected_text,input_manifest,dependency_ids,protected_memory_ids,protected_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,'profile',$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), scope.owner_id, contactParameter(scope), command.operation_id, scenarioDigest(command),
        command.settings_generation, command.version_id, command.item_index, command.reason,
        String(entry.text), JSON.stringify(profile.input_manifest), dependencies, protectedMemoryIds, protectedMessageIds]);
      await deleteSourceReplies(client, scope.owner_id, [command.version_id], scope.contact_id, false);
      await client.query(`UPDATE public.layered_profile_version SET withdrawn=true WHERE id=$1`, [command.version_id]);
      await client.query(`UPDATE public.layered_profile_batch SET status='withdrawn' WHERE id=$1`, [profile.profile_batch_id]);
      await this.publishWithoutProfile(client, scope, state, command.organization_generation, generation.scenario_version_ids ?? []);
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

  private async publishWithoutProfile(
    client: Client,
    scope: L3ProfileScope,
    state: Row,
    expectedGeneration: number,
    scenarioIds: readonly string[],
  ): Promise<void> {
    if (new Set(scenarioIds).size !== scenarioIds.length) {
      throw new L3ProfileServiceConflict('l3_profile_generation_changed');
    }
    const rows = await scenarioRows(client, scope, scenarioIds);
    if (
      rows.length !== scenarioIds.length
      || new Set(rows.map(row => row.id)).size !== rows.length
      || new Set(rows.map(row => row.scenario_id)).size !== rows.length
    ) throw new L3ProfileServiceConflict('l3_profile_generation_changed');
    const dependencies = new Set<string>();
    for (const row of rows) for (const id of row.dependency_ids ?? []) dependencies.add(id);
    const generation = expectedGeneration + 1;
    await client.query(`INSERT INTO public.layered_memory_generation
      (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,dependency_ids,created_at)
      VALUES($1,$2,$3,2,$4,NULL,$5,$6)`,
    [scope.owner_id, contactParameter(scope), generation, scenarioIds, [...dependencies].sort(), this.now()]);
    const changed = await client.query(`UPDATE public.layered_memory_state
      SET organization_generation=$3,updated_at=$4,error_code=NULL
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
        AND organization_generation=$5 AND settings_generation=$6 AND enabled`,
    [scope.owner_id, contactParameter(scope), generation, this.now(), expectedGeneration, Number(state.settings_generation)]);
    if (changed.rowCount !== 1) throw new L3ProfileServiceConflict('l3_profile_changed');
  }
}
