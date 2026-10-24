/** 过渡Python模型调用的宿主资格：只读任务元数据，同事务扣原job额度和预约收据。 */
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {PostgresModelLedger,PostgresModelLedgerDetails,validateModelLedgerReceipt,type ModelLedgerReceipt} from './model-ledger.ts';
import type {ModelTaskClaim} from './model-permit-server.ts';
type Transaction=<T>(work:(client:pg.Client)=>Promise<T>)=>Promise<T>;
export class HostModelAccountingError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const reject=(code:string):never=>{throw new HostModelAccountingError(code);};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 与Python uuid.uuid5(uuid.NAMESPACE_URL, name)逐字节一致。 */
export function modelTaskRequestId(kind:'extraction'|'skill_learning',task:string,key:string):string {
 const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
 const bytes=createHash('sha1').update(namespace).update(`notalone:${kind}:${task}:${key}`,'utf8').digest().subarray(0,16);
 bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
 const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function claimValue(value:ModelTaskClaim|undefined):ModelTaskClaim {
 if(!value||Object.keys(value).sort().join(',')!=='lease_generation,step_id,step_name,task_id,worker_id'
  ||!uuid.test(value.task_id)||!uuid.test(value.step_id)||typeof value.worker_id!=='string'||!uuid.test(value.worker_id)
  ||typeof value.step_name!=='string'||!Number.isSafeInteger(value.lease_generation)||value.lease_generation<1)return reject('model_accounting_claim_invalid');
 return structuredClone(value);
}
interface Authority {limit:number;learning?:boolean;job?:{table:'memory_upgrade_job'|'layered_memory_job';id:string;key:'id'|'task_id';tail:number};}
async function authority(client:pg.Client,r:ModelLedgerReceipt,c:ModelTaskClaim):Promise<Authority> {
 const task=(await client.query(`SELECT t.id,t.task_type,t.current_step,t.source_document_id,s.attempt_count FROM background_task t
  JOIN background_task_step s ON s.task_id=t.id WHERE t.id=$1 AND s.id=$2 AND s.step_name=$3
  AND t.owner_id=$4 AND t.contact_id IS NOT DISTINCT FROM $5 AND t.current_step=s.step_name
  AND t.status IN ('queued','running','verifying') AND s.status='running' AND s.worker_id=$6
  AND s.lease_generation=$7 AND s.lease_expires_at>clock_timestamp() FOR UPDATE OF t,s`,
  [c.task_id,c.step_id,c.step_name,r.owner_id,r.contact_id,c.worker_id,c.lease_generation])).rows[0];
 if(!task)reject('model_accounting_claim_stale');
 const bound=async()=>Boolean((await client.query("SELECT 1 FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active'",[r.owner_id,r.contact_id])).rowCount);
 if(task.task_type==='import'||task.task_type==='observation') {
  if(r.contact_id===null||c.step_name!=='extract_memory')reject('model_accounting_purpose_invalid');
  if(task.task_type==='import') {
   if(!(await client.query("SELECT 1 FROM source_document WHERE id=$1 AND owner_id=$2 AND contact_id=$3 AND status='active'",[task.source_document_id,r.owner_id,r.contact_id])).rowCount)reject('model_accounting_source_stale');
  }else if(!await bound())reject('model_accounting_source_stale');
  // 仅投影批次键；不选择window正文或完整JSON载荷。
  const traces=(await client.query(`SELECT DISTINCT tr.batch_key FROM memory_extraction_trace tr
   JOIN memory_extraction_trace_event e ON e.trace_id=tr.trace_id AND e.owner_id=tr.owner_id AND e.contact_id=tr.contact_id
   WHERE tr.owner_id=$1 AND tr.contact_id=$2 AND tr.status='running' AND e.stage='window'
   AND e.payload#>>'{task_runtime,task_id}'=$3 AND e.payload#>>'{task_runtime,step_id}'=$4
   AND e.payload#>>'{task_runtime,step_name}'=$5 AND e.payload#>>'{task_runtime,worker_id}'=$6
   AND e.payload#>>'{task_runtime,lease_generation}'=$7`,[r.owner_id,r.contact_id,c.task_id,c.step_id,c.step_name,c.worker_id,String(c.lease_generation)])).rows;
  if(!traces.some(row=>typeof row.batch_key==='string'&&/^[a-f0-9]{64}$/.test(row.batch_key)&&modelTaskRequestId('extraction',c.task_id,row.batch_key)===r.request_id))reject('model_accounting_request_invalid');
  return {limit:129};
 }
 if(task.task_type==='skill_learning') {
  if(r.contact_id===null||c.step_name!=='propose_skill'||!await bound())reject('model_accounting_purpose_invalid');
  const row=(await client.query('SELECT last_attempt_key FROM skill_learning_scope WHERE owner_id=$1 AND contact_id=$2 AND enabled FOR UPDATE',[r.owner_id,r.contact_id])).rows[0];
  if(!row?.last_attempt_key||modelTaskRequestId('skill_learning',c.task_id,row.last_attempt_key)!==r.request_id)reject('model_accounting_request_invalid');
  if(!Number.isInteger(task.attempt_count)||task.attempt_count<1||task.attempt_count>3)reject('model_accounting_retry_limit');
  return {limit:1,learning:true};
 }
 if(r.request_id!==c.task_id)reject('model_accounting_request_invalid');
 if(task.task_type==='memory_upgrade') {
  if(r.contact_id===null||c.step_name!=='preview_upgrade'||!await bound())reject('model_accounting_purpose_invalid');
  const row=(await client.query(`SELECT j.id,j.model_call_limit FROM memory_upgrade_batch b JOIN memory_upgrade_job j ON j.id=b.job_id AND j.owner_id=b.owner_id
   WHERE b.task_id=$1 AND b.owner_id=$2 AND b.contact_id=$3 AND b.state='queued' AND j.state='active'
   AND (j.scope_kind='owner' OR j.contact_id=b.contact_id) FOR UPDATE OF b,j`,[c.task_id,r.owner_id,r.contact_id])).rows[0];
  if(!row)reject('model_accounting_job_stale');
  // 同job任一批次unknown/旧permit pending都阻止换批重放；不依赖每task局部计数。
  if((await client.query(`SELECT 1 FROM model_call_receipt a JOIN memory_upgrade_batch b ON b.task_id=a.request_id AND b.owner_id=a.owner_id
   WHERE b.job_id=$1 AND (a.outcome='unknown' OR (a.outcome='pending' AND a.permit_id<>$2)) LIMIT 1`,[row.id,r.permit_id])).rowCount)reject('model_accounting_unsettled');
  return {limit:row.model_call_limit,job:{table:'memory_upgrade_job',key:'id',id:row.id,tail:0}};
 }
 if(task.task_type==='layered_memory') {
  if(c.step_name!=='organize_memory')reject('model_accounting_purpose_invalid');
  const row=(await client.query(`SELECT j.task_id,j.model_call_limit,j.contract,j.profile_required,j.settings_generation,s.organization_generation FROM layered_memory_job j JOIN layered_memory_state s
   ON s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id
   WHERE j.task_id=$1 AND j.owner_id=$2 AND j.contact_id IS NOT DISTINCT FROM $3
   AND j.state='active' AND s.enabled AND s.settings_generation=j.settings_generation FOR UPDATE OF j,s`,[c.task_id,r.owner_id,r.contact_id])).rows[0];
  if(!row)reject('model_accounting_job_stale');
  const inputs=[c.task_id,r.owner_id,r.contact_id,row.settings_generation];
  const l2=(await client.query(`SELECT id,output_payload IS NULL AS proposal FROM layered_memory_batch
   WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3
   AND settings_generation=$4 AND status='running' FOR UPDATE`,inputs)).rows;
  const l3=(await client.query(`SELECT id,output_payload IS NULL AS proposal FROM layered_profile_batch
   WHERE task_id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3 AND settings_generation=$4
   AND organization_generation=$5 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE`,[...inputs,row.organization_generation])).rows;
  // L2新prepare清理旧未提交批次；L3有效租约阻止并行prepare。歧义时拒绝，不猜最新。
  if(l2.length+l3.length!==1||l3.length&&!row.profile_required)reject('model_accounting_work_ambiguous');
  if(l3[0]&&!(await client.query('SELECT 1 FROM layered_profile_batch WHERE id=$1 AND lease_expires_at>clock_timestamp()',[l3[0].id])).rowCount)reject('model_accounting_work_stale');
  const work=l2[0]??l3[0],profile=l3.length===1,contract=new Set(String(row.contract).split(':'));
  const tools=contract.has(profile?'profile-tools-v1':'document-tools-v1');
  const tail=work.proposal&&tools?(profile?1:row.profile_required?7:1):0;
  return {limit:row.model_call_limit,job:{table:'layered_memory_job',key:'task_id',id:row.task_id,tail}};
 }
 return reject('model_accounting_purpose_invalid');
}
export function createHostModelAccounting(options:{transaction:Transaction;provider:string;model:string;unconfirmedPermitIds:()=>readonly string[]}) {
 if(typeof options.unconfirmedPermitIds!=='function')reject('model_accounting_configuration_invalid');
 if(!options.provider.trim()||!options.model.trim()||options.model==='ecnu-max')reject('model_accounting_configuration_invalid');
 const ledger=new PostgresModelLedger({transaction:options.transaction,details:new PostgresModelLedgerDetails()});
 const unconfirmed=async(client:pg.Client,owner:string,contact:string|null):Promise<string[]>=>{
  if(!uuid.test(owner)||(contact!==null&&!uuid.test(contact)))reject('model_accounting_scope_invalid');
  const permits=options.unconfirmedPermitIds();
  if(!Array.isArray(permits)||permits.some(id=>typeof id!=='string'||!uuid.test(id)))reject('model_accounting_recovery_unavailable');
  if(!permits.length)return [];
  return (await client.query('SELECT DISTINCT request_id FROM model_call_receipt WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2 AND permit_id=ANY($3::uuid[])',[owner,contact,permits])).rows.map(row=>row.request_id);
 };
 return {
  async unconfirmedRequests(scope:{owner_id:string;contact_id:string|null}):Promise<string[]> {
   return options.transaction(client=>unconfirmed(client,scope.owner_id,scope.contact_id));
  },
  async reserve(receipt:ModelLedgerReceipt,claim?:ModelTaskClaim):Promise<void> {
   validateModelLedgerReceipt(receipt);const r=structuredClone(receipt),c=claimValue(claim);
   if(r.provider!==options.provider||r.model!==options.model||r.outcome!=='pending'||r.dispatch!=='authorized_unconfirmed')reject('model_accounting_route_invalid');
   await options.transaction(async client=>{
    if(r.contact_id!==null)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${r.owner_id}:${r.contact_id}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${r.owner_id}`]);
    if((await unconfirmed(client,r.owner_id,r.contact_id)).includes(r.request_id))reject('model_accounting_consumer_unconfirmed');
    const grant=await authority(client,r,c);
    const existing=(await client.query('SELECT outcome FROM model_call_receipt WHERE attempt_id=$1',[r.attempt_id])).rows[0];
    if(grant.learning){
     const spent=(await client.query('SELECT attempt_id,request_id,task_id,step_name,worker_id FROM model_call_learning_claim WHERE step_id=$1 AND lease_generation=$2',[c.step_id,c.lease_generation])).rows[0];
     if(spent&&(spent.attempt_id!==r.attempt_id||spent.request_id!==r.request_id||spent.task_id!==c.task_id||spent.step_name!==c.step_name||spent.worker_id!==c.worker_id))reject('model_accounting_claim_spent');
     if(existing&&!spent)reject('model_accounting_claim_spent');
     // 每份扩展额度必须由唯一真实PG claim锚定；累计旧收据绝不清零。
     const used=Number((await client.query('SELECT count(*) AS n FROM model_call_receipt WHERE owner_id=$1 AND request_id=$2',[r.owner_id,r.request_id])).rows[0].n);
     grant.limit=used+(existing?0:1);
    }
    if(existing&&existing.outcome!=='pending')reject('model_accounting_attempt_already_settled');
    if((await client.query("SELECT 1 FROM model_call_receipt WHERE owner_id=$1 AND request_id=$2 AND (outcome='unknown' OR (outcome='pending' AND (permit_id<>$3 OR ($4 AND attempt_id<>$5)))) LIMIT 1",[r.owner_id,r.request_id,r.permit_id,Boolean(grant.learning),r.attempt_id])).rowCount)reject('model_accounting_unsettled');
    // 等待job行锁后再次用当前时钟检查租约；不得沿用等待前尚未过期的判断。
    if(!(await client.query('SELECT 1 FROM background_task_step WHERE id=$1 AND lease_expires_at>clock_timestamp()',[c.step_id])).rowCount)reject('model_accounting_claim_stale');
    if(!existing&&grant.job){
     const {table,key,id,tail}=grant.job; // 表与列仅由上述内部用途分支构造。
     const charged=await client.query(`UPDATE ${table} SET model_calls_used=model_calls_used+1 WHERE ${key}=$1 AND owner_id=$2 AND state='active' AND model_calls_used<model_call_limit-$3 RETURNING model_calls_used`,[id,r.owner_id,tail]);
     if(!charged.rowCount)reject('model_accounting_budget_exceeded');
    }
    // 复用外层同一事务；这里绝不另开连接或独立提交。
    const bound=new PostgresModelLedger({transaction:async work=>work(client),details:new PostgresModelLedgerDetails()});
    await bound.reserve(r,grant.limit);
    if(grant.learning&&!existing)await client.query(`INSERT INTO model_call_learning_claim(attempt_id,owner_id,contact_id,request_id,task_id,step_id,step_name,worker_id,lease_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[r.attempt_id,r.owner_id,r.contact_id,r.request_id,c.task_id,c.step_id,c.step_name,c.worker_id,c.lease_generation]);
   });
  },
  async recordReserved(receipt:ModelLedgerReceipt):Promise<void> {await ledger.recordReserved(receipt);},
 };
}
