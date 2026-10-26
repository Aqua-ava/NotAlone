/** L2发布前的票12来源复验；只返回判定，不复制处理事件或来源正文。 */
import type {Client} from 'pg';
import {L2ScenarioConflict} from './service.ts';
import type {L2ScenarioMemory, L2ScenarioScope} from './workspace.ts';
import {
  SourceProcessingTraceError,
  SourceProcessingTraceStore,
} from '../../diagnostics/source-processing-trace.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TraceStore = Pick<
  SourceProcessingTraceStore,
  'findMemoryTraceRecordInTransaction' | 'validateMemoryTraceRecordInTransaction'
>;
interface LayeredSourceWork {
  scope: L2ScenarioScope;
  inputs: readonly L2ScenarioMemory[];
}

function conflict(code: string): L2ScenarioConflict {
  return new L2ScenarioConflict(code);
}

function traceConflict(error: unknown): L2ScenarioConflict {
  if (!(error instanceof SourceProcessingTraceError)) return conflict('l2_scenario_source_unavailable');
  if (error.code === 'trace_processing_in_progress') return conflict('l2_scenario_source_processing');
  if (error.code === 'trace_sources_unavailable') return conflict('l2_scenario_source_changed');
  if (['trace_record_not_found', 'trace_not_found'].includes(error.code)) {
    return conflict('l2_scenario_source_not_recorded');
  }
  return conflict('l2_scenario_source_unavailable');
}

async function assertManualInput(
  client: Client,
  scope: L2ScenarioScope,
  memory: L2ScenarioMemory,
): Promise<void> {
  const table = scope.contact_id === null ? 'owner_memory' : 'confirmed_memory';
  const row = (await client.query(`SELECT status,revision,adoption_method,source_ids
    FROM public.${table}
    WHERE owner_id=$1 AND id=$2${scope.contact_id === null ? '' : ' AND contact_id=$3'}`,
  scope.contact_id === null
    ? [scope.owner_id, memory.memory_id]
    : [scope.owner_id, memory.memory_id, scope.contact_id])).rows[0];
  if (
    !row
    || row.status !== 'active'
    || Number(row.revision) !== memory.revision
    || row.adoption_method !== 'manual'
    || !Array.isArray(row.source_ids)
    || !row.source_ids.length
  ) throw conflict('l2_scenario_source_changed');

  const sourceIds = row.source_ids.map(String);
  if (
    scope.contact_id === null
    && sourceIds.length === 1
    && sourceIds[0] === scope.owner_id
  ) return;

  const manualSources = (await client.query(`SELECT id
    FROM public.source_document
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
      AND source_type='manual' AND status='active' AND id=ANY($3::uuid[])`,
  [scope.owner_id, scope.contact_id, sourceIds])).rows;
  if (manualSources.length !== sourceIds.length) throw conflict('l2_scenario_source_changed');
}

async function ownerCandidateContact(
  client: Client,
  ownerId: string,
  memory: L2ScenarioMemory,
): Promise<string> {
  const row = (await client.query(`SELECT candidate.contact_id
    FROM public.owner_memory memory
    JOIN public.memory_candidate candidate
      ON candidate.id=memory.source_candidate_id AND candidate.owner_id=memory.owner_id
    WHERE memory.owner_id=$1 AND memory.id=$2 AND candidate.status<>'deleted'
      AND candidate.contact_id IS NOT NULL`,
  [ownerId, memory.memory_id])).rows[0];
  if (!row || typeof row.contact_id !== 'string' || !UUID.test(row.contact_id)) {
    throw conflict('l2_scenario_source_not_recorded');
  }
  return row.contact_id;
}

/** 票13唯一来源 validator；根宿主在L2最终事务内复用同一client。 */
export function createL2ScenarioSourceValidator(traces: TraceStore) {
  return async function validateSources(client: Client, work: LayeredSourceWork): Promise<void> {
    for (const memory of work.inputs) {
      if (memory.provenance_kind === 'manual_entry') {
        await assertManualInput(client, work.scope, memory);
        continue;
      }
      const contactId = work.scope.contact_id
        ?? await ownerCandidateContact(client, work.scope.owner_id, memory);
      try {
        const result = await traces.validateMemoryTraceRecordInTransaction(
          client,
          {ownerId: work.scope.owner_id, contactId},
          work.scope.contact_id === null ? 'owner_memory' : 'contact_memory',
          memory.memory_id,
        );
        if (result.availability !== 'recorded') {
          throw conflict('l2_scenario_source_not_recorded');
        }
        if (
          !result.record
          || Number(result.record.revision) !== memory.revision
          || result.record.status !== 'active'
        ) throw conflict('l2_scenario_source_changed');
      } catch (error) {
        if (error instanceof L2ScenarioConflict) throw error;
        throw traceConflict(error);
      }
    }
  };
}
