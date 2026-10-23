/** 沿历史实际身份展开全部来源；仅查询，不生成学习材料。 */
import type {Client} from 'pg';
import {activeRef} from './contact-overview-evidence.ts';
import {SkillPortError} from './skill-execution-view.ts';
import {captureParentPublications} from './skill-source-proof.ts';
import type {Visit} from './skill-source-proof.ts';
const EXPAND=`
            WITH RECURSIVE material_provenance(id) AS (
                SELECT unnest($3::uuid[])
                UNION
                SELECT edge.id FROM material_provenance AS origin
                CROSS JOIN LATERAL (
                    SELECT turn.reply_request_id AS id FROM public.assistant_session_turn AS turn
                    WHERE turn.owner_id=$1 AND turn.contact_id=$2
                      AND turn.id=origin.id AND turn.state='completed'
                    UNION ALL SELECT turn.id FROM public.assistant_session_turn AS turn
                    WHERE turn.owner_id=$1 AND turn.contact_id=$2
                      AND turn.reply_request_id=origin.id AND turn.state='completed'
                    UNION ALL SELECT unnest(turn.dependency_ids) FROM public.assistant_session_turn AS turn
                    WHERE turn.owner_id=$1 AND turn.contact_id=$2
                      AND turn.id=origin.id AND turn.state='completed'
                    UNION ALL SELECT input.turn_id FROM public.assistant_session_input AS input
                    WHERE input.owner_id=$1 AND input.contact_id=$2 AND input.id=origin.id
                    UNION ALL SELECT unnest(input.dependency_ids) FROM public.assistant_session_input AS input
                    WHERE input.owner_id=$1 AND input.contact_id=$2 AND input.id=origin.id
                    UNION ALL SELECT version.turn_id FROM public.assistant_candidate_version AS version
                    WHERE version.owner_id=$1 AND version.contact_id=$2 AND version.id=origin.id
                    UNION ALL SELECT selection.candidate_id FROM public.assistant_candidate_selection AS selection
                    WHERE selection.owner_id=$1 AND selection.contact_id=$2 AND selection.id=origin.id
                    UNION ALL SELECT selection.version_id FROM public.assistant_candidate_selection AS selection
                    WHERE selection.owner_id=$1 AND selection.contact_id=$2 AND selection.id=origin.id
                    UNION ALL SELECT candidate.reply_request_id FROM public.reply_candidate AS candidate
                    WHERE candidate.owner_id=$1 AND candidate.contact_id=$2 AND candidate.id=origin.id
                    UNION ALL SELECT request.skill_id FROM public.reply_request AS request
                    WHERE request.owner_id=$1 AND request.contact_id=$2 AND request.id=origin.id
                    UNION ALL SELECT request.skill_version_id FROM public.reply_request AS request
                    WHERE request.owner_id=$1 AND request.contact_id=$2 AND request.id=origin.id
                    UNION ALL SELECT request.continued_from_candidate_id FROM public.reply_request AS request
                    WHERE request.owner_id=$1 AND request.contact_id=$2 AND request.id=origin.id
                    UNION ALL SELECT evidence.evidence_id FROM public.reply_context_evidence AS evidence
                    WHERE evidence.owner_id=$1 AND evidence.contact_id=$2
                      AND evidence.reply_request_id=origin.id
                      AND evidence.kind NOT IN ('user_draft','user_purpose','continued_candidate')
                    UNION ALL SELECT use.source_id FROM public.reply_original_source_use AS use
                    WHERE use.owner_id=$1 AND use.contact_id=$2 AND use.reply_request_id=origin.id
                    UNION ALL SELECT use.preference_id FROM public.reply_expression_preference_use AS use
                    WHERE use.owner_id=$1 AND use.contact_id=$2 AND use.reply_request_id=origin.id
                    UNION ALL SELECT unnest(preference.source_ids) FROM public.expression_preference AS preference
                    WHERE preference.owner_id=$1
                      AND (preference.contact_id IS NULL OR preference.contact_id=$2)
                      AND preference.id=origin.id AND preference.status='active'
                    UNION ALL SELECT unnest(draft.dependency_ids) FROM public.skill_draft AS draft
                    WHERE draft.owner_id=$1 AND draft.published_version_id=origin.id AND draft.status='published'
                ) AS edge WHERE edge.id IS NOT NULL
            ) SELECT id FROM material_provenance
        `;
export async function requireSkillDependencies(client:Client,owner:string,contact:string,dependencies:string[],visit:Visit){
 const refs=new Set(dependencies),checked=new Set<string>();
 while(true){
  for(const row of (await client.query(EXPAND,[owner,contact,[...refs]])).rows)refs.add(row.id);
  const discussion=(await client.query("SELECT id FROM public.reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND context_snapshot ? 'assistant_discussion_snapshot'",[owner,contact,[...refs].filter(id=>!checked.has(id))])).rows;
  if(!discussion.length)break;
  if(!visit.requireDiscussionDependencies)throw new SkillPortError('skill_discussion_proof_unavailable');
  for(const row of discussion){
   if(checked.size>=256)throw new SkillPortError();
   const related=await visit.requireDiscussionDependencies(client,owner,contact,row.id);
   if(!Array.isArray(related)||related.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))throw new SkillPortError();
   for(const id of related)refs.add(id);checked.add(row.id);
  }
 }
 const expanded=[...refs];
 const {inherited}=await captureParentPublications(client,owner,contact,expanded,visit);
 const known=new Set<string>(inherited);
 for(const [table,predicate] of [['assistant_session',''],['assistant_session_input',"AND state='active'"],['assistant_session_turn',"AND state='completed'"],['assistant_candidate_version',''],['assistant_candidate_selection',''],['reply_request',"AND state='completed'"],['reply_candidate',''],['reply_skill',"AND status<>'deleted'"]]){
  const rows=(await client.query(`SELECT id FROM public.${table} WHERE owner_id=$1 AND ${table==='reply_skill'?'(contact_id IS NULL OR contact_id=$2)':'contact_id=$2'} AND id=ANY($3::uuid[]) ${predicate}`,[owner,contact,expanded])).rows;
  for(const row of rows)known.add(row.id);
 }
 const nav=(await client.query(`SELECT value #>> '{}' AS id FROM public.reply_request request CROSS JOIN LATERAL jsonb_path_query(request.context_snapshot,'$.navigation_dependency_ids[*]') value WHERE request.owner_id=$1 AND request.contact_id=$2
 UNION SELECT value #>> '{}' AS id FROM public.assistant_session_turn turn CROSS JOIN LATERAL jsonb_path_query(turn.prepared_context,'$.context.evidence[*].fields.navigation.fields.dependency_ids[*].uuid') value WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.input_payload IS NOT NULL`,[owner,contact])).rows.map(r=>r.id);
 const remaining=expanded.filter(id=>!known.has(id));
 const rows=(await client.query(`SELECT source.id FROM public.source_document source WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND status='active'
 UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND id=ANY($3::uuid[])
 UNION SELECT message.id FROM public.message message WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND ${activeRef})
 UNION SELECT id FROM public.expression_preference WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2) AND id=ANY($3::uuid[]) AND status='active'
 UNION SELECT id FROM public.confirmed_memory WHERE owner_id=$1 AND (contact_id=$2 OR id=ANY($4::uuid[])) AND id=ANY($3::uuid[]) AND status IN ('active','invalidated')
 UNION SELECT id FROM public.owner_memory WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND status IN ('active','invalidated') AND (source_ids<>ARRAY[$1]::uuid[] OR adoption_method='manual')
 UNION SELECT id FROM public.memory_candidate WHERE owner_id=$1 AND (contact_id=$2 OR id=ANY($4::uuid[])) AND id=ANY($3::uuid[]) AND status IN ('pending','confirmed','rejected','invalidated')
 UNION SELECT ref.id FROM public.message_source_ref ref JOIN public.message message ON message.id=ref.message_id AND message.owner_id=ref.owner_id AND message.contact_id=ref.contact_id WHERE ref.owner_id=$1 AND ref.id=ANY($3::uuid[]) AND ref.id=ANY($4::uuid[]) AND ${activeRef}
 UNION SELECT id FROM public.memory_correction_decision WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND id=ANY($4::uuid[]) AND evidence->>'kind' IS DISTINCT FROM 'erased_guard'
 UNION SELECT id FROM public.owner WHERE id=$1 AND id=ANY($3::uuid[]) AND id=ANY($4::uuid[])
 UNION SELECT batch.batch_id AS id FROM public.source_processing_batch batch WHERE batch.owner_id=$1 AND (batch.contact_id=$2 OR batch.batch_id=ANY($4::uuid[])) AND batch.batch_id=ANY($3::uuid[]) AND batch.status='recorded' AND (batch.source_kind='source_document' AND EXISTS(SELECT 1 FROM public.source_document source WHERE source.id=batch.source_id AND source.owner_id=batch.owner_id AND source.contact_id=batch.contact_id AND source.status='active') OR batch.source_kind='local_wechat_observation' AND EXISTS(SELECT 1 FROM public.local_wechat_observation o WHERE o.id=batch.source_id AND o.owner_id=batch.owner_id AND o.contact_id=batch.contact_id))
 UNION SELECT id FROM public.scenario_document_version WHERE owner_id=$1 AND (contact_id=$2 OR contact_id IS NULL) AND id=ANY($3::uuid[]) AND id=ANY($4::uuid[])
 UNION SELECT id FROM public.layered_profile_version WHERE owner_id=$1 AND (contact_id=$2 OR contact_id IS NULL) AND id=ANY($3::uuid[]) AND id=ANY($4::uuid[]) AND NOT withdrawn`,[owner,contact,remaining,nav])).rows;
 if(new Set(rows.map(r=>r.id)).size!==new Set(remaining).size)throw new SkillPortError();
}
