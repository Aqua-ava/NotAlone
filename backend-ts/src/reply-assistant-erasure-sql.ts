/** 原 SQL 合同逐条移植；占位符改为 pg 参数，执行不依赖 Python。 */

export const carryRows = `SELECT id, owner_id, contact_id, conversation_binding_id, session_id, content FROM public.assistant_session_input WHERE owner_id=$1 AND input_type='candidate_carry' AND state='active' ORDER BY id`;

export const carryParent = `SELECT CASE WHEN version.version_number=0 THEN candidate.message_group ELSE version.message_group END AS message_group FROM public.assistant_session_input AS parent JOIN public.assistant_session_turn AS turn ON turn.id=parent.turn_id AND turn.input_version_id=parent.id AND turn.owner_id=parent.owner_id AND turn.contact_id=parent.contact_id AND turn.session_id=parent.session_id AND turn.conversation_binding_id=parent.conversation_binding_id JOIN public.reply_request AS request ON request.id=turn.reply_request_id AND request.idempotency_key=turn.idempotency_key AND request.owner_id=turn.owner_id AND request.contact_id=turn.contact_id AND request.conversation_binding_id=turn.conversation_binding_id JOIN public.reply_candidate AS candidate ON candidate.reply_request_id=request.id AND candidate.owner_id=request.owner_id AND candidate.contact_id=request.contact_id AND candidate.conversation_binding_id=request.conversation_binding_id JOIN public.assistant_candidate_version AS version ON version.candidate_id=candidate.id AND version.owner_id=parent.owner_id AND version.contact_id=parent.contact_id AND version.session_id=parent.session_id AND version.turn_id=turn.id JOIN public.assistant_candidate_selection AS selection ON selection.version_id=version.id AND selection.candidate_id=candidate.id AND selection.session_id=parent.session_id AND selection.owner_id=parent.owner_id AND selection.contact_id=parent.contact_id WHERE parent.owner_id=$1 AND parent.contact_id=$2 AND parent.conversation_binding_id=$3 AND parent.session_id=$4 AND parent.id=$5 AND turn.id=$6 AND request.id=$7 AND candidate.id=$8 AND version.id=$9 AND selection.id=$10`;

export const sourceTurns = `SELECT turn.id, turn.input_payload, turn.dependency_ids,
               request.state AS request_state, request.id AS request_id
        FROM public.assistant_session_turn AS turn
        LEFT JOIN public.reply_request AS request
          ON request.owner_id = turn.owner_id AND request.contact_id = turn.contact_id
         AND request.idempotency_key = turn.idempotency_key
        WHERE turn.owner_id = $1 AND turn.state <> 'redacted'
          AND (turn.dependency_ids && $2::uuid[] OR request.id = ANY($3::uuid[])
               OR (turn.id = ANY($4::uuid[])
                   AND ($5::uuid IS NULL OR turn.contact_id = $6)))
        FOR UPDATE OF turn`;

export const selectedSkills = `SELECT turn.id FROM public.assistant_session_turn AS turn JOIN public.reply_skill_version AS version ON turn.input_payload->>'skill_version_id'=version.id::text JOIN public.reply_skill AS skill ON skill.id=version.skill_id AND skill.owner_id=turn.owner_id WHERE turn.owner_id=$1 AND turn.state<>'redacted' AND version.id=ANY($2::uuid[])`;

export const lineage = `WITH RECURSIVE inputs AS (
                SELECT input.id, input.contact_id, input.session_id, input.conversation_binding_id,
                       input.input_type, turn.id AS turn_id, request.id AS request_id,
                       coalesce(turn.dependency_ids,input.dependency_ids) AS dependencies,
                       turn.idempotency_key, turn.input_digest,
                       turn.input_payload->'continuation' AS continuation
                FROM public.assistant_session_input AS input
                LEFT JOIN public.assistant_session_turn AS turn ON turn.id=input.turn_id
                  AND turn.input_version_id=input.id AND turn.owner_id=input.owner_id
                  AND turn.contact_id=input.contact_id AND turn.session_id=input.session_id
                  AND turn.conversation_binding_id=input.conversation_binding_id
                LEFT JOIN public.reply_request AS request ON request.owner_id=turn.owner_id
                  AND request.contact_id=turn.contact_id AND request.idempotency_key=turn.idempotency_key
                  AND request.conversation_binding_id=turn.conversation_binding_id
                  AND (turn.reply_request_id IS NULL OR request.id=turn.reply_request_id)
                WHERE input.owner_id=$1 AND input.state<>'redacted'
            ), edges AS (
                SELECT child.id AS child_id, parent.id AS parent_id FROM inputs AS child
                JOIN inputs AS parent
                  ON child.continuation->'submission'->>'expected_input_version_id'=parent.id::text
                  AND child.contact_id=parent.contact_id AND child.session_id=parent.session_id
                  AND child.conversation_binding_id=parent.conversation_binding_id
                WHERE child.input_type='generation' AND child.turn_id IS NOT NULL
                  AND parent.input_type='generation' AND parent.turn_id IS NOT NULL
                  AND parent.request_id IS NOT NULL AND parent.input_digest IS NOT NULL
                  AND child.continuation->>'version'='1'
                  AND child.continuation->>'scope'='this_assistant_session_only'
                  AND child.continuation->'submission'->>'idempotency_key'=child.idempotency_key::text
                  AND child.continuation->'submission'->'displayed_group'->>'session_id'=child.session_id::text
                UNION
                SELECT child.id, parent.id
                FROM jsonb_to_recordset($6::jsonb)
                  AS carry(child uuid,parent uuid,contact uuid,binding uuid)
                JOIN inputs AS child ON child.id=carry.child AND child.contact_id=carry.contact
                  AND child.conversation_binding_id=carry.binding AND child.input_type='candidate_carry'
                JOIN inputs AS parent ON parent.id=carry.parent AND parent.contact_id=child.contact_id
                  AND parent.conversation_binding_id=child.conversation_binding_id
                WHERE parent.turn_id IS NOT NULL AND parent.request_id IS NOT NULL
                  AND parent.input_digest IS NOT NULL
                UNION
                SELECT child.id, parent.id
                FROM jsonb_to_recordset($7::jsonb) AS captured(child uuid,parent uuid)
                JOIN inputs AS child ON child.id=captured.child
                JOIN inputs AS parent ON parent.id=captured.parent
                  AND parent.contact_id=child.contact_id AND parent.session_id=child.session_id
            ), affected(id) AS (
                SELECT id FROM inputs WHERE dependencies && $2::uuid[]
                  OR request_id=ANY($3::uuid[])
                  OR (turn_id=ANY($4::uuid[])
                      AND ($5::uuid IS NULL OR contact_id=$5))
                UNION
                SELECT edges.child_id FROM affected JOIN edges ON edges.parent_id=affected.id
            )
            SELECT id,turn_id,request_id FROM inputs WHERE id IN (SELECT id FROM affected)
            ORDER BY id`;

export const eraseInputs = `WITH erased AS (UPDATE public.assistant_session_input AS input SET state = 'redacted', content = NULL, dependency_ids = '{}', updated_at = now() WHERE input.owner_id = $1 AND (input.id = ANY($2::uuid[]) OR (input.state <> 'redacted' AND (input.dependency_ids && $3::uuid[] OR EXISTS (SELECT 1 FROM public.assistant_session_turn AS turn WHERE turn.id = input.turn_id AND turn.input_version_id = input.id AND turn.owner_id = input.owner_id AND turn.contact_id = input.contact_id AND turn.session_id = input.session_id AND turn.state = 'redacted')))) RETURNING input.id, input.session_id, input.owner_id, input.contact_id) UPDATE public.assistant_session AS session SET current_input_version_id = NULL, updated_at = now() FROM erased WHERE session.id = erased.session_id AND session.owner_id = erased.owner_id AND session.contact_id = erased.contact_id AND session.current_input_version_id = erased.id`;

export const anchor = `SELECT turn.id,turn.session_id,turn.input_version_id,turn.input_digest,turn.input_payload, turn.conversation_binding_id,turn.state,turn.dependency_ids,input.state AS anchor_input_state, input.conversation_binding_id AS anchor_binding_id FROM public.assistant_session_turn AS turn JOIN public.assistant_session_input AS input ON input.id=turn.input_version_id AND input.turn_id=turn.id AND input.owner_id=turn.owner_id AND input.contact_id=turn.contact_id AND input.session_id=turn.session_id WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.idempotency_key=$3`;

export const generation = `SELECT turn.idempotency_key,turn.reply_request_id,request.id AS request_id,request.conversation_binding_id FROM public.assistant_session_turn AS turn LEFT JOIN public.reply_request AS request ON request.owner_id=turn.owner_id AND request.contact_id=turn.contact_id AND request.idempotency_key=turn.idempotency_key AND request.conversation_binding_id=turn.conversation_binding_id AND (turn.reply_request_id IS NULL OR request.id=turn.reply_request_id) WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.session_id=$3 AND turn.id=$4 AND turn.input_version_id=$5 AND turn.conversation_binding_id=$6`;

export const candidate = `SELECT candidate.id,candidate.reply_request_id,candidate.ordinal,candidate.message_group,candidate.created_at,$1::uuid AS turn_id FROM public.reply_candidate AS candidate JOIN public.reply_request AS request ON request.id=candidate.reply_request_id AND request.owner_id=candidate.owner_id AND request.contact_id=candidate.contact_id AND request.conversation_binding_id=candidate.conversation_binding_id LEFT JOIN public.assistant_candidate_version AS version ON version.candidate_id=candidate.id AND version.owner_id=candidate.owner_id AND version.contact_id=candidate.contact_id AND version.id=$2 AND version.session_id=$3 AND version.turn_id=$4 WHERE candidate.owner_id=$5 AND candidate.contact_id=$6 AND candidate.id=$7 AND candidate.reply_request_id=$8 AND candidate.conversation_binding_id=$9 AND (version.id IS NOT NULL OR (candidate.id=$10 AND NOT EXISTS (SELECT 1 FROM public.assistant_candidate_version AS original WHERE original.id=candidate.id)))`;

export const replyDependencies = `WITH RECURSIVE lineage AS (
            SELECT id, continued_from_candidate_id, context_snapshot
            FROM public.reply_request WHERE owner_id = $1 AND contact_id = $2 AND id = $3
            UNION
            SELECT parent.id, parent.continued_from_candidate_id, parent.context_snapshot
            FROM lineage
            JOIN public.reply_candidate AS candidate ON candidate.id = lineage.continued_from_candidate_id
            JOIN public.reply_request AS parent ON parent.id = candidate.reply_request_id
            WHERE parent.owner_id = $4 AND parent.contact_id = $5
        )
        SELECT turn.dependency_ids, lineage.id AS request_id, lineage.context_snapshot,
               evidence.items AS evidence
        FROM lineage JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object('evidence_id', item.evidence_id,
                       'kind', item.kind, 'source_ids', item.source_ids)) AS items
            FROM public.reply_context_evidence AS item WHERE item.reply_request_id = lineage.id
            HAVING count(*) > 0
        ) AS evidence ON true
        LEFT JOIN public.assistant_session_turn AS turn ON turn.reply_request_id = lineage.id
          AND turn.owner_id = $6 AND turn.contact_id = $7`;
