/** 原Python资格SQL保持表、范围和依赖关系；只替换pg占位符。 */
import {activeRef} from './contact-overview-evidence.ts';
import {activeMessage} from './reply-assistant-erasure.ts';

export const registeredNavigation = `SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, '$.context.evidence[*].fields.navigation.fields.dependency_ids[*].uuid') AS value WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.input_payload IS NOT NULL UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, '$.context.layered_context.fields.snapshot.fields.dependency_ids[*].uuid') AS value WHERE turn.owner_id=$3 AND turn.contact_id=$4 AND turn.input_payload IS NOT NULL UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, '$.context.layered_context.fields.snapshot.fields.scenarios[*].fields.version_id.uuid') AS value WHERE turn.owner_id=$5 AND turn.contact_id=$6 AND turn.input_payload IS NOT NULL UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, '$.context.layered_context.fields.snapshot.fields.profile_version_id.uuid') AS value WHERE turn.owner_id=$7 AND turn.contact_id=$8 AND turn.input_payload IS NOT NULL UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, '$.context.owner_layered_context.fields.snapshot.fields.dependency_ids[*].uuid') AS value WHERE turn.owner_id=$9 AND turn.contact_id=$10 AND turn.input_payload IS NOT NULL UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, '$.context.owner_layered_context.fields.snapshot.fields.scenarios[*].fields.version_id.uuid') AS value WHERE turn.owner_id=$11 AND turn.contact_id=$12 AND turn.input_payload IS NOT NULL UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn AS turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context, '$.context.owner_layered_context.fields.snapshot.fields.profile_version_id.uuid') AS value WHERE turn.owner_id=$13 AND turn.contact_id=$14 AND turn.input_payload IS NOT NULL UNION SELECT value #>> '{}' AS id FROM public.reply_request AS request CROSS JOIN LATERAL jsonb_path_query(request.context_snapshot, '$.navigation_dependency_ids[*]') AS value WHERE request.owner_id=$15 AND request.contact_id=$16`;

export const ancestorRequests = `WITH RECURSIVE ancestors(id,contact_id,continued_from_candidate_id) AS (
            SELECT id,contact_id,continued_from_candidate_id FROM public.reply_request
            WHERE owner_id=$1 AND id=$2
            UNION
            SELECT parent.id,parent.contact_id,parent.continued_from_candidate_id FROM ancestors
            JOIN public.reply_candidate AS previous ON previous.id=ancestors.continued_from_candidate_id
            JOIN public.reply_request AS parent ON parent.id=previous.reply_request_id
            WHERE parent.owner_id=$3 AND parent.contact_id=ancestors.contact_id
        ) SELECT id FROM ancestors`;

export const availableDependencies = `SELECT NOT EXISTS (
            SELECT 1 FROM unnest($3::uuid[]) AS dependency(id)
            WHERE NOT EXISTS (
                SELECT 1 FROM public.source_document AS source
                WHERE source.owner_id = $1 AND source.id = dependency.id
                  AND source.status = 'active'
                UNION ALL
                SELECT 1 FROM public.local_wechat_observation AS observation
                WHERE observation.owner_id = $1 AND observation.id = dependency.id
                UNION ALL
                SELECT 1 FROM public.message AS message
                WHERE message.owner_id = $1 AND message.id = dependency.id
                  AND ${activeMessage}
                UNION ALL
                SELECT 1 FROM public.source_processing_batch AS batch
                WHERE batch.owner_id=$1
                  AND (batch.contact_id=$2 OR dependency.id=ANY($5::uuid[]))
                  AND batch.batch_id=dependency.id AND batch.status='recorded'
                  AND (
                    batch.source_kind='source_document' AND EXISTS (
                      SELECT 1 FROM public.source_document AS source
                      WHERE source.id=batch.source_id AND source.owner_id=batch.owner_id
                        AND source.contact_id=batch.contact_id AND source.status='active'
                    ) OR batch.source_kind='local_wechat_observation' AND EXISTS (
                      SELECT 1 FROM public.local_wechat_observation AS observation
                      WHERE observation.id=batch.source_id AND observation.owner_id=batch.owner_id
                        AND observation.contact_id=batch.contact_id
                    )
                  )
                UNION ALL
                SELECT 1 FROM public.expression_preference AS preference
                WHERE preference.owner_id = $1 AND preference.id = dependency.id
                  AND preference.status = 'active'
                  AND ($4 OR preference.contact_id IS NULL OR preference.contact_id = $2)
                UNION ALL
                SELECT 1 FROM public.confirmed_memory AS memory
                WHERE memory.owner_id = $1 AND memory.id = dependency.id
                  AND memory.contact_id = $2
                  AND (memory.status = 'active' OR $4 AND memory.status = 'invalidated')
                  AND ($4 OR (memory.valid_at IS NULL OR memory.valid_at <= now())
                    AND (memory.invalid_at IS NULL OR now() < memory.invalid_at))
                UNION ALL
                SELECT 1 FROM public.owner_memory AS memory
                WHERE memory.owner_id = $1 AND memory.id = dependency.id
                  AND (memory.status = 'active' OR $4 AND memory.status = 'invalidated')
                  AND ($4 OR (memory.valid_at IS NULL OR memory.valid_at <= now())
                    AND (memory.invalid_at IS NULL OR now() < memory.invalid_at))
                  AND (memory.source_ids <> ARRAY[$1]::uuid[]
                       OR memory.adoption_method = 'manual')
                UNION ALL
                SELECT 1 FROM public.memory_candidate AS candidate
                WHERE candidate.owner_id = $1 AND candidate.id = dependency.id
                  AND candidate.contact_id = $2
                  AND (candidate.status IN ('pending', 'confirmed')
                    OR $4 AND candidate.status IN ('rejected', 'invalidated'))
                  AND ($4 OR (candidate.valid_at IS NULL OR candidate.valid_at <= now())
                    AND (candidate.invalid_at IS NULL OR now() < candidate.invalid_at))
                UNION ALL
                SELECT 1 FROM public.message_source_ref AS ref
                JOIN public.message AS message ON message.id=ref.message_id AND message.owner_id=ref.owner_id
                WHERE ref.owner_id=$1 AND ref.id=dependency.id
                  AND dependency.id=ANY($5::uuid[])
                  AND ref.contact_id=message.contact_id AND ${activeRef}
                UNION ALL
                SELECT 1 FROM public.memory_correction_decision AS decision
                WHERE decision.owner_id=$1 AND decision.id=dependency.id
                  AND dependency.id=ANY($5::uuid[])
                  AND decision.evidence->>'kind' IS DISTINCT FROM 'erased_guard'
                UNION ALL
                SELECT 1 FROM public.scenario_document_version AS version
                WHERE version.owner_id=$1 AND (version.contact_id=$2 OR version.contact_id IS NULL)
                  AND version.id=dependency.id AND dependency.id=ANY($5::uuid[])
                UNION ALL
                SELECT 1 FROM public.layered_profile_version AS version
                WHERE version.owner_id=$1 AND (version.contact_id=$2 OR version.contact_id IS NULL)
                  AND version.id=dependency.id AND NOT version.withdrawn
                  AND dependency.id=ANY($5::uuid[])
                UNION ALL
                SELECT 1 FROM public.owner AS owner
                WHERE owner.id=$1 AND owner.id=dependency.id
                  AND dependency.id=ANY($5::uuid[])
                UNION ALL
                SELECT 1 FROM public.memory_candidate AS candidate
                WHERE candidate.owner_id=$1 AND candidate.id=dependency.id
                  AND dependency.id=ANY($5::uuid[])
                  AND (candidate.status IN ('pending','confirmed')
                    OR $4 AND candidate.status IN ('rejected','invalidated'))
                  AND ($4 OR (candidate.valid_at IS NULL OR candidate.valid_at <= now())
                    AND (candidate.invalid_at IS NULL OR now() < candidate.invalid_at))
                UNION ALL
                SELECT 1 FROM public.confirmed_memory AS memory
                WHERE memory.owner_id=$1 AND memory.id=dependency.id
                  AND dependency.id=ANY($5::uuid[])
                  AND (memory.status='active' OR $4 AND memory.status='invalidated')
                  AND ($4 OR (memory.valid_at IS NULL OR memory.valid_at <= now())
                    AND (memory.invalid_at IS NULL OR now() < memory.invalid_at))
            )
        ) AS available`;

export const forbiddenMemory = `WITH RECURSIVE used(id) AS (
          SELECT unnest($2::uuid[])
          UNION
          SELECT unnest(batch.dependencies) FROM used JOIN (
            SELECT version.id,batch.dependency_ids AS dependencies
            FROM public.scenario_document_version AS version
            JOIN public.layered_memory_batch AS batch ON batch.id=version.batch_id
            WHERE batch.owner_id=$1
            UNION ALL
            SELECT version.id,batch.dependency_ids
            FROM public.layered_profile_version AS version
            JOIN public.layered_profile_batch AS batch ON batch.id=version.batch_id
            WHERE batch.owner_id=$1
          ) AS batch ON batch.id=used.id
        )
        SELECT DISTINCT memory.id,memory.kind FROM used JOIN (
          SELECT id,id AS match_id,'confirmed_memory' AS kind,status,retirement_reason,invalid_at FROM public.confirmed_memory
          WHERE owner_id=$1
          UNION ALL
          SELECT CASE WHEN id IN (SELECT id FROM used) THEN id ELSE source_candidate_id END,source_candidate_id,
            CASE WHEN id IN (SELECT id FROM used) THEN 'confirmed_memory' ELSE 'pending_candidate' END,status,retirement_reason,invalid_at FROM public.confirmed_memory
          WHERE owner_id=$1 AND source_candidate_id IS NOT NULL
          UNION ALL
          SELECT id,id,'owner_memory',status,retirement_reason,invalid_at FROM public.owner_memory WHERE owner_id=$1
          UNION ALL
          SELECT CASE WHEN id IN (SELECT id FROM used) THEN id ELSE source_candidate_id END,source_candidate_id,
            CASE WHEN id IN (SELECT id FROM used) THEN 'owner_memory' ELSE 'pending_candidate' END,status,retirement_reason,invalid_at FROM public.owner_memory
          WHERE owner_id=$1 AND source_candidate_id IS NOT NULL
          UNION ALL
          SELECT id,id,'pending_candidate',status,'unknown',invalid_at FROM public.memory_candidate WHERE owner_id=$1
        ) AS memory ON memory.match_id=used.id
        WHERE memory.status NOT IN ('active','pending','confirmed') OR memory.invalid_at<=now()
        ORDER BY memory.kind,memory.id`;

export const historicalRows = `WITH RECURSIVE nodes AS (
          SELECT id, 'confirmed_memory' AS kind, supersedes_memory_id AS previous,
            revision, status, retirement_reason, text_content, source_ids, valid_at, invalid_at, category, created_at AS recorded_at, owner_id, contact_id, event, confirmed_memory.conditions AS conditions, confirmed_memory.evolution AS evolution
          FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2
          UNION ALL
          SELECT id, 'owner_memory', supersedes_memory_id, revision, status, retirement_reason,
            text_content, source_ids, valid_at, invalid_at, category, created_at, owner_id, NULL::uuid, event, owner_memory.conditions, owner_memory.evolution
          FROM public.owner_memory WHERE owner_id=$3
          UNION ALL
          SELECT id, 'pending_candidate', NULL::uuid, 0, status, 'unknown',
            text_content, source_ids, valid_at, invalid_at, category, created_at, owner_id, contact_id, event, memory_candidate.conditions, memory_candidate.evolution
          FROM public.memory_candidate WHERE owner_id=$4 AND contact_id=$5
        ), used AS (
          SELECT * FROM nodes WHERE id=ANY($6::uuid[])
          UNION
          SELECT node.* FROM nodes AS node JOIN used ON node.previous=used.id AND node.kind=used.kind
        )
        SELECT *, valid_at > now() AS future, invalid_at <= now() AS expired
        FROM used ORDER BY kind, id`;

export const basisRows = `SELECT evidence.evidence_id, evidence.kind, evidence.owner_id, evidence.contact_id,
          evidence.evidence_status AS original_status, evidence.evidence_revision AS original_revision,
          coalesce(memory.status, own.status, candidate.status) AS current_status,
          coalesce(memory.retirement_reason, own.retirement_reason, 'unknown') AS retirement_reason,
          coalesce(memory.revision, own.revision) AS revision,
          coalesce(memory.category, own.category, candidate.category) AS category,
          coalesce(memory.event, own.event, candidate.event) AS event,
          coalesce(memory.conditions, own.conditions, candidate.conditions) AS conditions,
          coalesce(memory.evolution, own.evolution, candidate.evolution) AS evolution,
          coalesce(memory.source_candidate_id, own.source_candidate_id, candidate.id) AS event_candidate_id,
          coalesce(memory.text_content, own.text_content, candidate.text_content) AS text_content,
          coalesce(memory.source_ids, own.source_ids, candidate.source_ids) AS source_ids,
          coalesce(memory.created_at, own.created_at, candidate.created_at) AS recorded_at,
          coalesce(memory.valid_at, own.valid_at, candidate.valid_at) AS valid_at,
          coalesce(memory.invalid_at, own.invalid_at, candidate.invalid_at) AS invalid_at,
          coalesce(memory.valid_at, own.valid_at, candidate.valid_at) > now() AS future,
          coalesce(memory.invalid_at, own.invalid_at, candidate.invalid_at) <= now() AS expired
        FROM public.reply_context_evidence AS evidence
        LEFT JOIN public.confirmed_memory AS memory ON evidence.kind='confirmed_memory'
          AND memory.id=evidence.evidence_id AND memory.owner_id=evidence.owner_id
          AND memory.contact_id=evidence.contact_id
        LEFT JOIN public.owner_memory AS own ON evidence.kind='owner_memory'
          AND own.id=evidence.evidence_id AND own.owner_id=evidence.owner_id
        LEFT JOIN public.memory_candidate AS candidate ON evidence.kind='pending_candidate'
          AND candidate.id=evidence.evidence_id AND candidate.owner_id=evidence.owner_id
          AND candidate.contact_id=evidence.contact_id
        WHERE evidence.owner_id=$1 AND evidence.contact_id=$2
          AND evidence.reply_request_id=$3
          AND evidence.kind IN ('confirmed_memory', 'owner_memory', 'pending_candidate')
        ORDER BY evidence.evidence_id, evidence.kind`;
