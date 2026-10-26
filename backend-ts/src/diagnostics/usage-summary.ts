/** 本机用量只读投影；receipt为权威尝试，旧表仅补未关联的历史记录。 */
import type {HostStorage} from '../platform/database/host-storage.ts';
import {HostStorageError} from '../platform/database/host-storage.ts';

const rows = `WITH attempts AS MATERIALIZED (
 SELECT coalesce(ledger_entry_id,attempt_id) AS entry_id,contact_id,scope_kind,provider,model_name,
 called_at,latency_ms,dispatch,outcome,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
 cost_status,cost_amount,currency,pricing_version,'receipt'::text AS source,
 dispatch IN ('response_observed','http_accepted') AS confirmed
 FROM public.model_call_receipt WHERE owner_id=$1::uuid
 UNION ALL
 SELECT id,contact_id,'contact',provider,model_name,called_at,latency_ms,'legacy_recorded',outcome,
 input_tokens,output_tokens,NULL::integer,NULL::integer,'unknown',NULL::numeric,NULL::text,NULL::text,'legacy',true
 FROM public.outbound_ledger_entry l WHERE owner_id=$1::uuid
 AND NOT EXISTS (SELECT 1 FROM public.model_call_receipt r WHERE r.owner_id=$1::uuid AND r.ledger_entry_id=l.id)
), confirmed AS MATERIALIZED (SELECT * FROM attempts WHERE confirmed)
`;

/** 既有字段保持用途；总用量含未知时返回null，已知部分另列，不填成0。 */
export async function usageSummary(storage:HostStorage):Promise<Record<string,unknown>> {
 const owner=storage.runtimeOwnerId;
 if(!owner || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner))
  throw new HostStorageError('runtime_owner_unconfigured');
 return storage.businessReadTransaction(async client=>{
  const result=(await client.query(`${rows}
   SELECT count(*)::float8 AS total_calls,
    (SELECT count(*)::float8 FROM attempts) AS total_attempts,
    (SELECT count(*)::float8 FROM attempts WHERE dispatch='authorized_unconfirmed') AS authorized_unconfirmed_calls,
    (SELECT count(*)::float8 FROM attempts WHERE dispatch='not_sent') AS not_sent_attempts,
    count(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL)::float8 AS unknown_usage_calls,
    CASE WHEN count(*) FILTER (WHERE input_tokens IS NULL)>0 THEN NULL ELSE coalesce(sum(input_tokens),0)::float8 END AS total_input_tokens,
    CASE WHEN count(*) FILTER (WHERE output_tokens IS NULL)>0 THEN NULL ELSE coalesce(sum(output_tokens),0)::float8 END AS total_output_tokens,
    coalesce(sum(input_tokens),0)::float8 AS known_input_tokens,coalesce(sum(output_tokens),0)::float8 AS known_output_tokens,
    count(*) FILTER (WHERE cost_status='unknown')::float8 AS unknown_cost_calls,
    coalesce((SELECT jsonb_object_agg(provider,n) FROM (SELECT provider,count(*) AS n FROM confirmed GROUP BY provider) p),'{}') AS provider_counts,
    coalesce((SELECT jsonb_object_agg(outcome,n) FROM (SELECT outcome,count(*) AS n FROM confirmed GROUP BY outcome) o),'{}') AS outcome_counts,
    coalesce((SELECT jsonb_agg(c) FROM (SELECT cost_status AS status,currency,pricing_version,sum(cost_amount)::text AS amount,count(*)::float8 AS calls FROM confirmed WHERE cost_status<>'unknown' GROUP BY cost_status,currency,pricing_version ORDER BY cost_status,currency,pricing_version) c),'[]') AS cost_totals,
    coalesce((SELECT jsonb_agg(r ORDER BY called_at DESC,entry_id DESC) FROM
      (SELECT entry_id,contact_id,scope_kind,provider,model_name,called_at,latency_ms,dispatch,outcome,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
       cost_status,cost_amount::text AS cost_amount,currency,pricing_version,source,confirmed
       FROM attempts ORDER BY called_at DESC,entry_id DESC LIMIT 10) r),'[]') AS recent
   FROM confirmed`,[owner])).rows[0];
  for(const value of Object.values(result))if(typeof value==='number'&&!Number.isSafeInteger(value))throw new HostStorageError('ledger_summary_unavailable');
  return {schema_version:1,...result};
 });
}
