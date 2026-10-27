import {memoryScopePaused} from '../../processing/control.ts';
/** 原公开 L2/L3 管理合同；只调度原任务，不持有模型或第二套状态库。 */
import type {Client} from 'pg';
import {L2ScenarioService,L2ScenarioConflict} from '../../scenarios/service.ts';
import {L3ProfileServiceConflict} from '../../profiles/service.ts';
import {DEFAULT_L2_SCENARIO_BUDGET,type L2ScenarioBudget,type L2ScenarioScope} from '../../scenarios/workspace.ts';
import {
  LayeredMemoryManagementError,lockManagementScope,managementState,managementInputs,
  managementJobs,refreshManagementGeneration,cancelManagementJobs,cancelInvalidatedManagementJobs,disableManagementScope,enqueueManagementJob,type ManagementTransaction,
} from './store.ts';
import {reportManagementFactError,type LayeredMemoryFactError} from './facts.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS=new Set(['enable','refresh','disable','delete','pause','continue','quality-input','fact-error',
  'summary-error','withdraw-scenario','withdraw-profile']);
export interface LayeredMemoryVersionSelection {memory_id:string;revision:number;}
export interface LayeredMemoryManagementOptions {
  ownerId:string;
  transaction:ManagementTransaction;
  read?:(scope:L2ScenarioScope,cursor?:string|null)=>Promise<Record<string,any>>;
  wake?:(scope:L2ScenarioScope,taskId:string)=>Promise<unknown>|unknown;
  cancel?:(scope:L2ScenarioScope,taskId:string)=>Promise<unknown>|unknown;
  modelWorkAvailable?:()=>boolean;
  qualityInput?:(client:Client,scope:L2ScenarioScope,versions:readonly LayeredMemoryVersionSelection[])=>Promise<Record<string,unknown>>;
  budget?:L2ScenarioBudget;
  contract?:string;
  now?:()=>Date;
}
export interface LayeredMemoryManagementResponse {status:number;body:unknown;}
export interface LayeredMemoryMaintenanceResult {enqueued:string[];nextDueAt:string|null;nextDelayMs:number;}

function route(url:URL):{contactId:string|null;action:string}|undefined{
  const contact=/^\/api\/contacts\/([^/]+)\/layered-memory(?:\/([^/]+))?$/.exec(url.pathname);
  const owner=/^\/api\/memories\/owner\/layered-memory(?:\/([^/]+))?$/.exec(url.pathname);
  if(!contact&&!owner)return;
  const action=contact?.[2]??owner?.[1]??'';
  if(action&&!ACTIONS.has(action))return;
  return {contactId:contact?.[1]??null,action};
}
function object(value:unknown):value is Record<string,any>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function keys(value:unknown,allowed:string[]):value is Record<string,any>{
  return object(value)&&Object.keys(value).sort().join(',')===[...allowed].sort().join(',');
}
function invalid():never{throw new LayeredMemoryManagementError('layered_memory_request_invalid',400);}

export function createLayeredMemoryManagement(options:LayeredMemoryManagementOptions){
  const budget=structuredClone(options.budget??DEFAULT_L2_SCENARIO_BUDGET);
  const contract=options.contract??'scenario-v3:verified_items:document-tools-v1:profile-tools-v1:typescript-management-v1';
  // HostStorage 将未知异常折叠成 database_unavailable；保留事务内原业务冲突供 HTTP 正确映射。
  const transaction:ManagementTransaction=async work=>{
    let failure:unknown;
    try{return await options.transaction(async client=>{try{return await work(client);}catch(error){failure=error;throw error;}});}
    catch(error){throw failure??error;}
  };
  // 状态读取和纠错复用现有服务；此端口没有模型执行能力，不伪造调用或成功回执。
  const createStateService=(serviceTransaction:ManagementTransaction)=>new L2ScenarioService({transaction:serviceTransaction,budget,
    model:{async call(){throw new LayeredMemoryManagementError('model_configuration_unavailable',503);}},
    binding:{provider:'unconfigured',model:'unconfigured',maxTokens:1,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:128_000,safety_margin_tokens:1},...(options.now?{now:options.now}:{})});
  async function read(scope:L2ScenarioScope,cursor:string|null=null){
    let state:Record<string,any>;
    if(options.read){
      await transaction(async client=>{await lockManagementScope(client,scope);});
      state=await options.read(scope,cursor);
    }else{
      state=await createStateService(async work=>transaction(async client=>{
        await lockManagementScope(client,scope);return work(client);
      })).read(scope,cursor);
    }
    const job=await transaction(async client=>{
      await lockManagementScope(client,scope);
      return (await managementJobs(client,scope)).find(row=>Number(row.settings_generation)===state.settings_generation);
    });
    if(!job)return state;
    const used=Number(job.model_calls_used),limit=Number(job.model_call_limit);
    return {...state,work_id:job.task_id,work_revision:Number(job.revision),current_batch:Number(job.batch_number),
      model_calls_used:used,model_call_limit:limit,
      budget:{...state.budget,max_model_calls:limit,model_calls_used:used,model_calls_remaining:Math.max(0,limit-used)}};
  }
  return {
    matches(_method:string,url:URL){return Boolean(route(url));},
    read,
    async runMaintenance(signal:AbortSignal):Promise<LayeredMemoryMaintenanceResult>{
      signal.throwIfAborted();
      if(options.modelWorkAvailable?.()===false)return {enqueued:[],nextDueAt:null,nextDelayMs:1_000};
      const now=options.now?.()??new Date();
      const scopes=await transaction(async client=>(await client.query(`SELECT contact_id FROM public.layered_memory_state
        WHERE owner_id=$1 AND enabled AND maintenance_allowed AND (
          next_due_at<=$2 AND (dirty_revision>consumed_revision OR status='stale') OR next_boundary_at<=$2)
        ORDER BY LEAST(next_due_at,next_boundary_at),scope_kind,scope_key LIMIT 64`,[options.ownerId,now])).rows);
      const enqueued:string[]=[];
      for(const candidate of scopes){
        signal.throwIfAborted();
        const scope:L2ScenarioScope={owner_id:options.ownerId,contact_id:candidate.contact_id};
        const outcome=await transaction(async client=>{
          await lockManagementScope(client,scope);signal.throwIfAborted();
          if(await memoryScopePaused(client,{ownerId:scope.owner_id,contactId:scope.contact_id}))return;
          const state=await managementState(client,scope);
          if(!state.enabled||!state.maintenance_allowed
            ||(await managementJobs(client,scope)).some(job=>job.state==='active'
              &&Number(job.settings_generation)===Number(state.settings_generation)))return;
          const inputs=await managementInputs(client,scope,now);
          const current=await managementState(client,scope);
          if(Number(current.dirty_revision)<=Number(current.consumed_revision)&&current.status!=='stale')return;
          const refreshed=await refreshManagementGeneration(client,scope,current,inputs);
          const result=await enqueueManagementJob(client,scope,refreshed,inputs,budget,contract,'refresh');
          signal.throwIfAborted();
          return result;
        });
        if(outcome){
          for(const id of outcome.cancelled)await options.cancel?.(scope,id);
          if(outcome.execute){await options.wake?.(scope,outcome.taskId);enqueued.push(outcome.taskId);}
        }
      }
      const next=await transaction(async client=>(await client.query(`SELECT min(LEAST(next_due_at,next_boundary_at)) AS due
        FROM public.layered_memory_state WHERE owner_id=$1 AND enabled AND maintenance_allowed
        AND (dirty_revision>consumed_revision OR status='stale' OR next_boundary_at IS NOT NULL)`,[options.ownerId])).rows[0]?.due);
      const nextDueAt=next?new Date(next).toISOString():null;
      // 没有 LISTEN 的宿主仍可用有界一秒轮询观察新资料；不创建常驻私有 Timer。
      return {enqueued,nextDueAt,nextDelayMs:next?Math.max(50,Math.min(1_000,new Date(next).getTime()-now.getTime())):1_000};
    },
    async handle(method:string,url:URL,body:unknown,signal:AbortSignal):Promise<LayeredMemoryManagementResponse|undefined>{
      const matched=route(url);if(!matched)return;
      try{
        signal.throwIfAborted();
        if(!UUID.test(options.ownerId)||matched.contactId!==null&&!UUID.test(matched.contactId))invalid();
        const scope:L2ScenarioScope={owner_id:options.ownerId.toLowerCase(),contact_id:matched.contactId?.toLowerCase()??null};
        if(!matched.action){
          if(method!=='GET')return {status:405,body:{error:'method_not_allowed'}};
          if([...url.searchParams.keys()].some(key=>key!=='mapping_cursor')||url.searchParams.getAll('mapping_cursor').length>1)invalid();
          return {status:200,body:{layered_memory:await read(scope,url.searchParams.get('mapping_cursor'))}};
        }
        if(method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
        if(url.search)invalid();
        const action=matched.action;
        if(action==='quality-input'){
          if(!keys(body,['memory_versions'])||!Array.isArray(body.memory_versions)
            ||!body.memory_versions.length||body.memory_versions.length>budget.max_memories
            ||body.memory_versions.some((version:unknown)=>!keys(version,['memory_id','revision'])
              ||typeof version.memory_id!=='string'||!UUID.test(version.memory_id)
              ||!Number.isSafeInteger(version.revision)||version.revision<1)
            ||new Set(body.memory_versions.map((version:LayeredMemoryVersionSelection)=>version.memory_id.toLowerCase())).size!==body.memory_versions.length)invalid();
          const qualityInput=options.qualityInput;
          if(!qualityInput)throw new LayeredMemoryManagementError('quality_evaluation_unavailable',503);
          const prepared=await transaction(async client=>{
            await lockManagementScope(client,scope);signal.throwIfAborted();
            return qualityInput(client,scope,body.memory_versions);
          });
          signal.throwIfAborted();
          return {status:200,body:{quality_input:prepared}};
        }
        if(['summary-error','withdraw-scenario','withdraw-profile'].includes(action)){
          const allowed=action==='summary-error'?['settings_generation','organization_generation','target_kind','version_id','item_index','reason','operation_id']
            :['settings_generation','organization_generation',action==='withdraw-scenario'?'scenario_version_id':'profile_version_id'];
          if(!keys(body,allowed)||!Number.isSafeInteger(body.settings_generation)||body.settings_generation<0
            ||!Number.isSafeInteger(body.organization_generation)||body.organization_generation<0)invalid();
          if(action==='summary-error'&&(!['scenario','profile'].includes(body.target_kind)
            ||typeof body.version_id!=='string'||!UUID.test(body.version_id)
            ||typeof body.operation_id!=='string'||!UUID.test(body.operation_id)
            ||!Number.isSafeInteger(body.item_index)||body.item_index<0||body.item_index>=100
            ||typeof body.reason!=='string'||![...body.reason.trim()].length||[...body.reason.trim()].length>500))invalid();
          const versionId=action==='withdraw-scenario'?body.scenario_version_id:body.profile_version_id;
          if(action!=='summary-error'&&(typeof versionId!=='string'||!UUID.test(versionId)))invalid();
          const cancelled=new Set<string>();
          const service=createStateService(async work=>transaction(async client=>{
            await lockManagementScope(client,scope);signal.throwIfAborted();
            const value=await work(client);
            for(const id of await cancelInvalidatedManagementJobs(client,scope))cancelled.add(id);
            return value;
          }));
          if(action==='summary-error'){
            const command={settings_generation:body.settings_generation,organization_generation:body.organization_generation,
              version_id:body.version_id,item_index:body.item_index,reason:body.reason,operation_id:body.operation_id};
            if(body.target_kind==='profile')await service.reportProfileError(scope,command);
            else await service.reportParagraphError(scope,command);
          }else if(action==='withdraw-scenario')await service.withdrawScenario(scope,body.settings_generation,body.organization_generation,versionId);
          else await service.withdrawProfile(scope,body.settings_generation,body.organization_generation,versionId);
          for(const id of cancelled)await options.cancel?.(scope,id);
          return {status:200,body:{layered_memory:await read(scope)}};
        }
        if(action==='fact-error'){
          if(!keys(body,['settings_generation','organization_generation','target_kind','version_id','item_index','memory_id'])
            ||!Number.isSafeInteger(body.settings_generation)||body.settings_generation<0
            ||!Number.isSafeInteger(body.organization_generation)||body.organization_generation<0
            ||!['scenario','profile'].includes(body.target_kind)||!UUID.test(body.version_id)||!UUID.test(body.memory_id)
            ||!Number.isSafeInteger(body.item_index)||body.item_index<0||body.item_index>=100)invalid();
          const result=await transaction(async client=>{
            await lockManagementScope(client,scope);signal.throwIfAborted();
            return reportManagementFactError(client,scope,await managementState(client,scope),body as LayeredMemoryFactError,options.now?.()??new Date());
          });
          for(const id of result.cancelled)await options.cancel?.(scope,id);
          return {status:200,body:{layered_memory:{...await read(scope),correction_target:result.target}}};
        }
        const allowed=action==='enable'?['settings_generation','purpose_confirmed']
          :['pause','continue'].includes(action)?['settings_generation','work_revision']:['settings_generation'];
        if(!keys(body,allowed)||!Number.isSafeInteger(body.settings_generation)||body.settings_generation<0
          ||action==='enable'&&body.purpose_confirmed!==true
          ||['pause','continue'].includes(action)&&(!Number.isSafeInteger(body.work_revision)||body.work_revision<1))invalid();
        if(['enable','refresh','continue'].includes(action)&&options.modelWorkAvailable?.()===false)
          throw new LayeredMemoryManagementError('model_configuration_unavailable',503);
        const outcome=await transaction(async client=>{
          await lockManagementScope(client,scope);signal.throwIfAborted();
          if(['enable','refresh','continue'].includes(action)&&await memoryScopePaused(client,{ownerId:scope.owner_id,contactId:scope.contact_id}))throw new LayeredMemoryManagementError('memory_processing_paused');
          const state=await managementState(client,scope),generation=Number(state.settings_generation);
          let cancelled:string[]=[];
          const replay=generation!==body.settings_generation&&['enable','disable','delete'].includes(action)
            &&state.last_action===action&&generation===body.settings_generation+1;
          if(generation!==body.settings_generation&&!replay)throw new LayeredMemoryManagementError();
          if(replay&&action!=='enable')return {cancelled};
          if(action==='disable'||action==='delete')return {cancelled:await disableManagementScope(client,scope,action==='delete')};
          if(action==='enable'&&!replay){
            cancelled=await cancelManagementJobs(client,scope);
            await client.query(`UPDATE public.layered_memory_state SET enabled=true,settings_generation=settings_generation+1,
              status='stale',error_code=NULL,last_action='enable' WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
            [scope.owner_id,scope.contact_id]);
            state.settings_generation=generation+1;state.enabled=true;
          }
          if(!state.enabled)throw new LayeredMemoryManagementError();
          const inputs=await managementInputs(client,scope,options.now?.()??new Date());
          let current=await managementState(client,scope);
          if(action==='refresh'||action==='enable')current=await refreshManagementGeneration(client,scope,current,inputs);
          const enqueued=await enqueueManagementJob(client,scope,current,inputs,budget,contract,action,body.work_revision);
          return {...enqueued,cancelled:[...cancelled,...enqueued.cancelled]};
        });
        for(const id of outcome.cancelled)await options.cancel?.(scope,id);
        if('execute' in outcome&&outcome.execute&&'taskId' in outcome)await options.wake?.(scope,outcome.taskId);
        signal.throwIfAborted();
        return {status:200,body:{layered_memory:await read(scope)}};
      }catch(error){
        if(signal.aborted)throw error;
        if(error instanceof LayeredMemoryManagementError)return {status:error.status,body:{error:error.code}};
        if(error instanceof L2ScenarioConflict||error instanceof L3ProfileServiceConflict)
          return {status:409,body:{error:'layered_memory_changed'}};
        const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
        if(code==='quality_request_invalid'||code==='l2_scenario_mapping_cursor_invalid')
          return {status:400,body:{error:'layered_memory_request_invalid'}};
        if(code==='quality_input_changed')return {status:409,body:{error:'layered_memory_changed'}};
        if(code==='quality_evidence_not_found')return {status:404,body:{error:'layered_memory_not_found'}};
        return {status:503,body:{error:'layered_memory_unavailable'}};
      }
    },
  };
}
