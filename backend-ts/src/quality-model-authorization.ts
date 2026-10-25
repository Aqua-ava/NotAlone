/** 质量case独立授权；不接受生产任务claim，不签发自动使用资格。 */
import {createHash} from 'node:crypto';
import type pg from 'pg';
import type {ModelLedgerReceipt} from './model-ledger.ts';
import {REQUIRED_PHASES,type OrganizationQualityPhase} from './organization-quality-contract.ts';
import {checkQualityCase} from './organization-quality-snapshot.ts';
import {qualityInputSourceRef} from './organization-quality-store.ts';

export interface ModelQualityClaim {
  kind:'quality_case';run_id:string;case_id:string;execution_token:string;phase:OrganizationQualityPhase;
}
export class QualityModelAuthorizationError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;}
}
const reject=(code:string):never=>{throw new QualityModelAuthorizationError(code);};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 同case同phase的稳定请求身份；随机attempt不能扩展授权或抹除unknown。 */
export function qualityModelRequestId(runId:string,caseId:string,phase:OrganizationQualityPhase):string {
  if(!uuid.test(runId)||!uuid.test(caseId)||!REQUIRED_PHASES.includes(phase))reject('quality_model_claim_invalid');
  const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
  const bytes=createHash('sha1').update(namespace).update(`notalone:organization_quality:${runId}:${caseId}:${phase}`,'utf8').digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function validateQualityModelClaim(value:ModelQualityClaim|undefined):ModelQualityClaim {
  if(!value)return reject('quality_model_claim_invalid');
  if(Object.keys(value).sort().join(',')!=='case_id,execution_token,kind,phase,run_id'
    ||value.kind!=='quality_case'||!uuid.test(value.run_id)||!uuid.test(value.case_id)||!uuid.test(value.execution_token)
    ||!REQUIRED_PHASES.includes(value.phase))reject('quality_model_claim_invalid');
  return structuredClone(value);
}

/** 调用方已持owner锁；原Store先持久计数，宿主只核对且从不二次扣run。 */
export async function authorizeQualityModelReservation(client:pg.Client,r:ModelLedgerReceipt,c:ModelQualityClaim):Promise<number>{
  if(r.request_id!==qualityModelRequestId(c.run_id,c.case_id,c.phase))reject('quality_model_request_invalid');
  const row=(await client.query(`SELECT c.*,r.contract_id AS run_contract_id,r.state AS run_state,
    r.max_http_attempts,r.http_attempts_used,r.data_kind,r.stage
    FROM public.organization_quality_case c JOIN public.organization_quality_run r ON r.id=c.run_id AND r.owner_id=c.owner_id
    WHERE c.id=$1 AND c.run_id=$2 AND c.owner_id=$3 AND c.contact_id IS NOT DISTINCT FROM $4
      AND c.execution_token=$5 AND c.execution_state='running' AND c.lease_expires_at>clock_timestamp()
    FOR UPDATE OF c,r`,[c.case_id,c.run_id,r.owner_id,r.contact_id,c.execution_token])).rows[0];
  if(!row||row.run_state!=='running'||row.contract_id!==row.run_contract_id
    ||row.data_kind!=='fixed_synthetic'||row.stage!=='organization')reject('quality_model_claim_stale');
  await checkQualityCase(client,row,new Date());
  const max=row.max_http_attempts,used=row.http_attempts_used;
  if(!Number.isSafeInteger(max)||max<1||max>750||!Number.isSafeInteger(used)||used<1||used>max)reject('quality_model_budget_exceeded');
  const attempts=(await client.query(`SELECT id,case_id,ordinal,phase,outcome,request_model,request_route,measurements
    FROM public.organization_quality_attempt WHERE run_id=$1 ORDER BY ordinal FOR UPDATE`,[c.run_id])).rows;
  const own=attempts.find(attempt=>attempt.id===r.attempt_id);
  if(!own||own.case_id!==c.case_id||own.phase!==c.phase||own.ordinal<1||own.ordinal>used||own.request_model!==r.model
    ||own.request_route!==r.provider||attempts.length!==used)reject('quality_model_attempt_invalid');
  if(own.outcome!=='unknown')reject('quality_model_attempt_already_settled');
  if(own.measurements?.source_ref!==qualityInputSourceRef({case_id:row.id,input_sha256:row.input_sha256}))reject('quality_model_source_ref_invalid');
  if(!r.input_budget||own.measurements?.request_sha256!==r.input_budget.request_sha256)reject('quality_model_payload_invalid');
  // 六阶段共享同case失败保护；换request/phase/permit都不能绕旧pending或unknown。
  if((await client.query(`SELECT 1 FROM public.organization_quality_attempt a
    LEFT JOIN public.model_call_receipt m ON m.attempt_id=a.id
    WHERE a.case_id=$1 AND a.id<>$2 AND (a.outcome='unknown' OR m.outcome IN ('pending','unknown')) LIMIT 1`,[c.case_id,r.attempt_id])).rowCount)
    reject('quality_model_unsettled');
  const caseLimit=Number(row.contract?.budget?.max_model_calls);
  if(!Number.isSafeInteger(caseLimit)||caseLimit<2||caseLimit>16
    ||attempts.filter(attempt=>attempt.case_id===c.case_id&&attempt.id!==r.attempt_id).length>=caseLimit)reject('quality_model_budget_exceeded');
  // 等待锁/来源核对之后再查当前时钟；不沿用进入事务前的租约结论。
  if(!(await client.query(`SELECT 1 FROM public.organization_quality_case WHERE id=$1 AND execution_token=$2
    AND execution_state='running' AND lease_expires_at>clock_timestamp()`,[c.case_id,c.execution_token])).rowCount)reject('quality_model_claim_stale');
  return caseLimit;
}
