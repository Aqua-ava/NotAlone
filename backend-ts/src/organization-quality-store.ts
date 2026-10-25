/** 质量输入、审核与运行复用 079 原表和 owner 短事务，不发布产品记忆。 */
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import type {ManagementTransaction} from './layered-memory-management-store.ts';
import {scenarioTopicId,validateScenarioDocument,type L2ScenarioDraft,type L2ScenarioMemory,type L2ScenarioScope,type L2ScenarioVersion} from './l2-scenario-workspace.ts';
import {createOrganizationQualityContract,FACT_PREPARATION_DATASET_VERSION,qualityConflict,qualityDigest,qualityInvalid,
  qualityKeys,qualityMissing,qualityJSON,QUALITY_UUID,OrganizationQualityError,type OrganizationQualityContract,type QualityRow} from './organization-quality-contract.ts';
import {checkQualityCase,qualityBoundedInput,qualityCurrentScenarios,qualityFactCorrections,qualityMemory,qualityModelMemories,
  qualityModelScenarios,qualityScopeSnapshot} from './organization-quality-snapshot.ts';
import {qualityAnnotations,qualityDecision,qualityHumanApproved,qualityOutputReview,qualityReviewer} from './organization-quality-review.ts';

export interface OrganizationQualityStoreOptions {
  transaction:ManagementTransaction;contract?:OrganizationQualityContract;now?:()=>Date;
}
export interface OrganizationQualitySource {case_id:string;input_sha256:string;}
/** 服务器侧冻结输入引用；不接受客户端自定范围或替换摘要。 */
export function qualityInputSourceRef(input:OrganizationQualitySource):string {
  if(!QUALITY_UUID.test(input.case_id)||!/^[0-9a-f]{64}$/.test(input.input_sha256))
    throw new OrganizationQualityError('quality_evaluation_unavailable',503);
  return `organization-quality-input-v1:${input.case_id}:${input.input_sha256}`;
}
export class OrganizationQualityStore {
  readonly contract:OrganizationQualityContract;
  readonly contractId:string;
  private readonly transaction:ManagementTransaction;
  readonly now:()=>Date;
  constructor(options:OrganizationQualityStoreOptions){
    this.transaction=options.transaction;this.contract=structuredClone(options.contract??createOrganizationQualityContract());
    this.contractId=qualityDigest(this.contract);this.now=options.now??(()=>new Date());
  }
  private async ownerTransaction<T>(ownerId:string,work:(client:Client)=>Promise<T>):Promise<T>{
    if(!QUALITY_UUID.test(ownerId))qualityInvalid();
    let failure:unknown;
    try{return await this.transaction(async client=>{
      try{
        await client.query("SET LOCAL lock_timeout='2s'");await client.query("SET LOCAL statement_timeout='5s'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${ownerId}`]);
        return await work(client);
      }catch(error){failure=error;throw error;}
    });}catch(error){throw failure??error;}
  }
  async insertInputInTransaction(client:Client,scope:L2ScenarioScope,versions:unknown):Promise<QualityRow>{
    const budget=this.contract.budget;
    if(!Array.isArray(versions)||!versions.length||versions.length>budget.max_memories||versions.some(item=>
      !qualityKeys(item,['memory_id','revision'])||!QUALITY_UUID.test(item.memory_id)||!Number.isSafeInteger(item.revision)||item.revision<1))qualityInvalid();
    const chosen=new Map(versions.map(item=>[item.memory_id.toLowerCase(),item.revision]));
    if(chosen.size!==versions.length)qualityInvalid();
    const snapshot=await qualityScopeSnapshot(client,scope,this.now());
    let entries=snapshot.entries.filter(entry=>chosen.has(entry.memory.memory_id));
    if(entries.length!==chosen.size||entries.some(entry=>chosen.get(entry.memory.memory_id)!==entry.memory.revision))qualityConflict();
    const selected=new Set(entries.map(entry=>entry.memory.memory_id));
    const scenarios=await qualityCurrentScenarios(client,scope,Number(snapshot.state.organization_generation));
    const current=new Map(snapshot.manifest.map(item=>[item.memory_id,qualityJSON(item)]));
    const contexts=[],inherited:string[]=[];
    for(const scenario of scenarios.slice(0,budget.max_scenarios)){
      if(scenario.input_manifest.some(item=>current.get(item.memory_id)!==qualityJSON(item)))continue;
      const combined=new Set([...selected,...scenario.input_manifest.map(item=>item.memory_id)]);
      const combinedEntries=snapshot.entries.filter(entry=>combined.has(entry.memory.memory_id));
      const payload={memories:qualityModelMemories(scope,combinedEntries.map(qualityMemory)),
        scenarios:qualityModelScenarios(scope,[...contexts,scenario]),corrections:snapshot.corrections};
      try{qualityBoundedInput(payload,budget);}catch{
        if(budget.max_batch_memories<budget.max_memories)qualityInvalid();
        continue;
      }
      entries=combinedEntries;for(const id of combined)selected.add(id);contexts.push(scenario);inherited.push(...scenario.dependency_ids);
    }
    // 正式 L3 会读入所有合法当前主题，冻结输入不得遗漏其底层实际版本。
    for(const scenario of scenarios){
      if(!scenario.paragraphs.every(paragraph=>paragraph.references.every(ref=>current.has(ref.memory_id))))continue;
      if(scenario.input_manifest.some(item=>!selected.has(item.memory_id)))qualityInvalid();
    }
    const modelInput={memories:qualityModelMemories(scope,entries.map(qualityMemory)),scenarios:qualityModelScenarios(scope,contexts),corrections:snapshot.corrections};
    qualityBoundedInput(modelInput,budget);
    const manifest=snapshot.manifest.filter(item=>selected.has(item.memory_id));
    const id=randomUUID(),facts=await qualityFactCorrections(client,scope,manifest,id,true);
    const dependencies=[...new Set([...entries.flatMap(entry=>[entry.memory.memory_id,...(entry.dependency_ids??[])]),
      ...inherited,...snapshot.guardDependencies,
      ...facts.flatMap(fact=>[fact.decision_id,fact.record_id,fact.replacement_memory_id,...(fact.fact_error_receipt?.dependency_ids??[])])])].sort();
    const construction=entries.map(entry=>({memory_id:entry.memory.memory_id,revision:entry.memory.revision,
      provenance_kind:entry.provenance.kind,timing:entry.memory.timing??{}}));
    const evidence={fact_corrections:facts},digest=qualityDigest(modelInput);
    await client.query(`INSERT INTO public.organization_quality_case(id,owner_id,contact_id,settings_generation,contract_id,contract,
      input_sha256,input_manifest,model_input,construction,dependency_ids,guard_snapshot,stage_evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id,scope.owner_id,scope.contact_id,snapshot.state.settings_generation,this.contractId,JSON.stringify(this.contract),digest,
      JSON.stringify(manifest),JSON.stringify(modelInput),JSON.stringify(construction),dependencies,JSON.stringify(snapshot.guard),JSON.stringify(evidence)]);
    await client.query(`UPDATE public.organization_quality_fact_intent SET state='consumed',consumer_case_id=$1
      WHERE id=ANY($2::uuid[]) AND state='resolved'`,[id,facts.flatMap(fact=>fact.fact_error_receipt?[fact.fact_error_receipt.intent_id]:[])]);
    return {case_id:id,scope_kind:scope.contact_id===null?'owner':'contact',contact_id:scope.contact_id,contract_id:this.contractId,
      input_sha256:digest,model_input:modelInput,construction,guard_snapshot:snapshot.guard,stage_evidence:evidence,review_status:'unknown',quality_verified:false};
  }
  async readInput(ownerId:string,id:string):Promise<QualityRow>{
    return this.ownerTransaction(ownerId,async client=>{
      const row=await this.caseRow(client,ownerId,id);await checkQualityCase(client,row,this.now());
      return this.inputDTO(row);
    });
  }
  private inputDTO(row:QualityRow):QualityRow {
    return {case_id:row.id,scope_kind:row.contact_id===null?'owner':'contact',contact_id:row.contact_id,contract_id:row.contract_id,
      input_sha256:row.input_sha256,model_input:row.model_input,construction:row.construction,guard_snapshot:row.guard_snapshot,
      review_status:row.review_status,annotations:row.annotations,output:row.output_payload,stage_evidence:row.stage_evidence,quality_verified:false};
  }
  private async caseRow(client:Client,ownerId:string,id:string,lock=false):Promise<QualityRow>{
    const row=(await client.query(`SELECT * FROM public.organization_quality_case WHERE owner_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ownerId,id])).rows[0];
    return row??qualityMissing();
  }
  async reviewInput(ownerId:string,id:string,payload:unknown,{output=false}={}):Promise<QualityRow>{
    await this.ownerTransaction(ownerId,async client=>{
      const row=await this.caseRow(client,ownerId,id,true);await checkQualityCase(client,row,this.now());
      if(!output&&row.run_id){
        const run=(await client.query('SELECT state,dataset_version FROM public.organization_quality_run WHERE id=$1',[row.run_id])).rows[0];
        if(run?.dataset_version===FACT_PREPARATION_DATASET_VERSION||run?.state!=='prepared')qualityConflict();
      }
      if(output&&!['complete','failed'].includes(row.execution_state))qualityConflict();
      const checked=output?qualityOutputReview(payload,row):qualityAnnotations(payload,row);
      if(output)await client.query('UPDATE public.organization_quality_case SET output_review=$1 WHERE id=$2',[JSON.stringify(checked),id]);
      else await client.query('UPDATE public.organization_quality_case SET annotations=$1,review_status=$2 WHERE id=$3',
        [JSON.stringify(checked),qualityHumanApproved(checked)?'human_reviewed':'unknown',id]);
    });
    return this.readInput(ownerId,id);
  }
  async createRun(ownerId:string,payload:unknown):Promise<string>{
    if(!qualityKeys(payload,['case_ids','max_http_attempts','dataset_version','data_kind','purpose_confirmed'])||payload.purpose_confirmed!==true
      ||!Array.isArray(payload.case_ids)||payload.case_ids.length<1||payload.case_ids.length>240||new Set(payload.case_ids).size!==payload.case_ids.length
      ||payload.case_ids.some((id:unknown)=>typeof id!=='string'||!QUALITY_UUID.test(id))||!Number.isSafeInteger(payload.max_http_attempts)
      ||payload.max_http_attempts<1||payload.max_http_attempts>750||typeof payload.dataset_version!=='string'
      ||!payload.dataset_version.trim()||[...payload.dataset_version].length>160||payload.data_kind!=='fixed_synthetic')qualityInvalid();
    return this.ownerTransaction(ownerId,async client=>{
      const database=(await client.query('SELECT current_database() AS name')).rows[0].name;
      if(!database.endsWith('_test'))qualityInvalid();
      const rows=(await client.query('SELECT * FROM public.organization_quality_case WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [ownerId,payload.case_ids])).rows;
      if(rows.length!==payload.case_ids.length||rows.some(row=>row.run_id||row.contract.input_projection_version!==this.contract.input_projection_version))qualityConflict();
      for(const row of rows)await checkQualityCase(client,row,this.now());
      if(payload.dataset_version===FACT_PREPARATION_DATASET_VERSION&&(rows.length!==1||payload.max_http_attempts!==1
        ||rows[0].input_manifest.length!==1||rows[0].annotations!==null||rows[0].output_payload!==null||rows[0].execution_state!=='prepared'))qualityConflict();
      const id=randomUUID(),hash=qualityDigest(rows.map(row=>({case_id:row.id,input_sha256:row.input_sha256})));
      await client.query(`INSERT INTO public.organization_quality_run(id,owner_id,stage,contract_id,contract,dataset_version,dataset_sha256,
        data_kind,case_count,max_http_attempts) VALUES($1,$2,'organization',$3,$4,$5,$6,$7,$8,$9)`,
      [id,ownerId,this.contractId,JSON.stringify(this.contract),payload.dataset_version,hash,payload.data_kind,rows.length,payload.max_http_attempts]);
      await client.query('UPDATE public.organization_quality_case SET run_id=$1 WHERE owner_id=$2 AND id=ANY($3::uuid[])',[id,ownerId,payload.case_ids]);
      return id;
    });
  }
  async reportRows(ownerId:string,id:string):Promise<{run:QualityRow;cases:QualityRow[];attempts:QualityRow[]}>{
    return this.ownerTransaction(ownerId,async client=>{
      const run=(await client.query(`SELECT * FROM public.organization_quality_run WHERE owner_id=$1 AND id=$2 AND stage='organization'`,[ownerId,id])).rows[0];
      if(!run)qualityMissing();
      const cases=(await client.query('SELECT * FROM public.organization_quality_case WHERE owner_id=$1 AND run_id=$2 ORDER BY id',[ownerId,id])).rows;
      for(const row of cases)await checkQualityCase(client,row,this.now());
      const attempts=(await client.query('SELECT * FROM public.organization_quality_attempt WHERE run_id=$1 ORDER BY ordinal',[id])).rows;
      return {run,cases,attempts};
    });
  }
  async withdraw(ownerId:string,id:string,{run=false}={}):Promise<QualityRow>{
    await this.ownerTransaction(ownerId,async client=>{
      const column=run?'origin_run_id':'origin_case_id';
      const removed=await client.query(`DELETE FROM public.organization_quality_fact_intent WHERE owner_id=$1
        AND (${column}=$2 OR consumer_case_id=$2) RETURNING id`,[ownerId,id]);
      const table=run?'organization_quality_run':'organization_quality_case';
      const result=await client.query(`DELETE FROM public.${table} WHERE owner_id=$1 AND id=$2 RETURNING id`,[ownerId,id]);
      if(!removed.rowCount&&!result.rowCount)qualityMissing();
    });
    return {withdrawn:true};
  }
  async calibrate(ownerId:string,id:string,payload:unknown):Promise<void>{
    if(!qualityKeys(payload,['contract_id','reviewer','decision','notes'])||payload.contract_id!==this.contractId
      ||typeof payload.notes!=='string'||!payload.notes.trim()||[...payload.notes].length>4000)qualityInvalid();
    qualityReviewer(payload.reviewer);qualityDecision(payload.decision);
    await this.ownerTransaction(ownerId,async client=>{
      const result=await client.query(`UPDATE public.organization_quality_run SET calibration=$1 WHERE owner_id=$2 AND id=$3
        AND contract_id=$4 AND state='complete' RETURNING id`,[JSON.stringify(payload),ownerId,id,this.contractId]);
      if(!result.rowCount)qualityConflict();
    });
  }
  async claimCase(ownerId:string,runId:string,transportKind:'sdk'|'synthetic',allowUnreviewedSmoke:boolean,
    sourceRef:(input:OrganizationQualitySource)=>string|null=qualityInputSourceRef):Promise<QualityRow|null>{
    return this.ownerTransaction(ownerId,async client=>{
      const run=(await client.query('SELECT * FROM public.organization_quality_run WHERE id=$1 AND owner_id=$2 FOR UPDATE',[runId,ownerId])).rows[0];
      if(!run)qualityMissing();
      if(run.dataset_version===FACT_PREPARATION_DATASET_VERSION||run.contract_id!==this.contractId)qualityConflict();
      const cases=(await client.query('SELECT * FROM public.organization_quality_case WHERE run_id=$1 ORDER BY id',[runId])).rows;
      if(run.state==='prepared'){
        const frozen=cases.every(row=>qualityHumanApproved(row.annotations));
        if(!frozen&&!allowUnreviewedSmoke)qualityConflict();
        const digest=qualityDigest(cases.map(row=>({input_sha256:row.input_sha256,annotations:row.annotations})));
        await client.query(`UPDATE public.organization_quality_run SET state='running',transport_kind=$1,input_review_frozen=$2,
          input_review_sha256=$3 WHERE id=$4`,[transportKind,frozen,digest,runId]);
      }else if(run.transport_kind!==transportKind)qualityConflict();
      const running=cases.find(row=>row.execution_state==='running');
      if(running){
        const active=(await client.query('SELECT lease_expires_at>clock_timestamp() AS active FROM public.organization_quality_case WHERE id=$1',[running.id])).rows[0]?.active;
        if(active)qualityConflict();
        await client.query(`UPDATE public.organization_quality_case SET execution_state='failed',error_code='interrupted_request_unknown',
          execution_token=NULL,lease_expires_at=NULL WHERE id=$1`,[running.id]);
      }
      const row=cases.find(row=>row.execution_state==='prepared');
      if(!row){await client.query("UPDATE public.organization_quality_run SET state='complete',finished_at=clock_timestamp() WHERE id=$1",[runId]);return null;}
      const memories=await checkQualityCase(client,row,this.now()),token=randomUUID();
      const sourceInput={case_id:String(row.id),input_sha256:String(row.input_sha256)},source=sourceRef(sourceInput);
      if(source!==qualityInputSourceRef(sourceInput))throw new OrganizationQualityError('quality_evaluation_unavailable',503);
      await client.query(`UPDATE public.organization_quality_case SET execution_state='running',execution_token=$1,
        lease_expires_at=clock_timestamp()+interval '195 seconds' WHERE id=$2`,[token,row.id]);
      return {...row,execution_token:token,memories,source_ref:source};
    });
  }
  private async executionRow(client:Client,ownerId:string,id:string,token:string):Promise<QualityRow>{
    const row=(await client.query(`SELECT * FROM public.organization_quality_case WHERE owner_id=$1 AND id=$2
      AND execution_token=$3 AND execution_state='running' AND lease_expires_at>clock_timestamp() FOR UPDATE`,[ownerId,id,token])).rows[0];
    if(!row)qualityMissing();
    await checkQualityCase(client,row,this.now());return row;
  }
  async checkExecution(ownerId:string,id:string,token:string):Promise<void>{
    await this.ownerTransaction(ownerId,async client=>{await this.executionRow(client,ownerId,id,token);});
  }
  async recordStage(ownerId:string,id:string,token:string,phase:string,value:unknown,{errorCode=null,finished=false}:{errorCode?:string|null;finished?:boolean}={}):Promise<void>{
    await this.ownerTransaction(ownerId,async client=>{
      const row=await this.executionRow(client,ownerId,id,token);
      await client.query(`UPDATE public.organization_quality_case SET output_payload=$1,output_review=NULL,error_code=$2,execution_state=$3,
        execution_token=CASE WHEN $4 THEN NULL ELSE execution_token END WHERE id=$5`,
      [JSON.stringify({...row.output_payload,[phase]:value}),errorCode,errorCode?'failed':finished?'complete':'running',Boolean(errorCode||finished),id]);
      if(errorCode||finished){
        const pending=await client.query("SELECT 1 FROM public.organization_quality_case WHERE run_id=$1 AND execution_state IN ('prepared','running') LIMIT 1",[row.run_id]);
        if(!pending.rowCount)await client.query("UPDATE public.organization_quality_run SET state='complete',finished_at=clock_timestamp() WHERE id=$1",[row.run_id]);
      }
    });
  }
  async recordEvidence(ownerId:string,id:string,token:string,key:string,value:unknown):Promise<void>{
    await this.ownerTransaction(ownerId,async client=>{
      await this.executionRow(client,ownerId,id,token);
      await client.query('UPDATE public.organization_quality_case SET stage_evidence=stage_evidence||$1::jsonb WHERE id=$2',[JSON.stringify({[key]:value}),id]);
    });
  }
  async checkpointL2(ownerId:string,id:string,token:string,proposal:readonly L2ScenarioDraft[]):Promise<L2ScenarioVersion[]>{
    return this.ownerTransaction(ownerId,async client=>{
      const row=await this.executionRow(client,ownerId,id,token),scope={owner_id:ownerId,contact_id:row.contact_id};
      const memories=await checkQualityCase(client,row,this.now());
      const current=await qualityCurrentScenarios(client,scope,Number(row.guard_snapshot.organization_generation));
      validateScenarioDocument({scenarios:proposal},memories,current,this.contract.budget);
      const replaced=new Set(proposal.flatMap(item=>item.replaces));
      const retained=current.filter(item=>!replaced.has(item.version_id)&&!proposal.some(draft=>draft.scenario_id===item.scenario_id));
      const documents:L2ScenarioVersion[]=[...retained,...proposal.map(draft=>{
        const scenarioId=draft.scenario_id??scenarioTopicId(scope.contact_id??ownerId,`${ownerId}:${draft.topic_key}`);
        return {scenario_id:scenarioId,version_id:scenarioTopicId(id,qualityDigest(draft)),title:draft.title,hint:draft.hint,
          paragraphs:structuredClone(draft.paragraphs),input_manifest:row.input_manifest,dependency_ids:row.dependency_ids};
      })];
      const allowed=new Set(memories.map(memory=>memory.memory_id));
      if(new Set(documents.map(item=>item.scenario_id)).size!==documents.length||documents.some(item=>item.input_manifest.some(input=>!allowed.has(String(input.memory_id)))))qualityConflict();
      const payload={memories:qualityModelMemories(scope,memories),scenarios:qualityModelScenarios(scope,documents),corrections:row.model_input.corrections};
      qualityBoundedInput(payload,this.contract.budget);
      const evidence={kind:'evaluation_checkpoint',published_to_product:false,normal_call_required:Boolean(documents.length),
        documents:qualityModelScenarios(scope,documents),model_input:payload,input_manifest:row.input_manifest,input_sha256:qualityDigest(payload)};
      await client.query('UPDATE public.organization_quality_case SET stage_evidence=stage_evidence||$1::jsonb WHERE id=$2',
        [JSON.stringify({l3_checkpoint:evidence}),id]);
      return documents;
    });
  }
  async reserveAttempt(ownerId:string,runId:string,id:string,token:string,phase:string,request:QualityRow,route='unknown',measurements:QualityRow={},attemptId=randomUUID()):Promise<string>{
    return this.ownerTransaction(ownerId,async client=>{
      const row=await this.executionRow(client,ownerId,id,token);if(row.run_id!==runId)qualityMissing();
      const reserved=(await client.query(`UPDATE public.organization_quality_run SET http_attempts_used=http_attempts_used+1
        WHERE id=$1 AND owner_id=$2 AND http_attempts_used<max_http_attempts RETURNING http_attempts_used`,[runId,ownerId])).rows[0];
      if(!reserved)throw new OrganizationQualityError('physical_attempt_budget_exhausted',409);
      await client.query(`INSERT INTO public.organization_quality_attempt(id,run_id,case_id,ordinal,phase,request_payload,request_model,request_route,measurements)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[attemptId,runId,id,reserved.http_attempts_used,phase,JSON.stringify(request),String(request.model??'unknown'),route,JSON.stringify(measurements)]);
      return attemptId;
    });
  }
  async finishAttempt(ownerId:string,id:string,outcome:string,durationMs:number,response:QualityRow|null=null,measurements:QualityRow={}):Promise<void>{
    await this.ownerTransaction(ownerId,async client=>{
      // 删除后只丢弃迟到回执，绝不重建正文、输入或报告。
      await client.query(`UPDATE public.organization_quality_attempt SET response_payload=$1,outcome=$2,response_model=$3,
        system_fingerprint=$4,duration_ms=$5,measurements=measurements||$6::jsonb
        WHERE id=$7 AND run_id IN (SELECT id FROM public.organization_quality_run WHERE owner_id=$8)`,
      [response?JSON.stringify(response):null,outcome,response?.model??null,response?.system_fingerprint??null,durationMs,JSON.stringify(measurements),id,ownerId]);
    });
  }
  async finishExecutionAttempt(ownerId:string,caseId:string,token:string,id:string,outcome:string,durationMs:number,response:QualityRow|null=null,measurements:QualityRow={}):Promise<void>{
    await this.ownerTransaction(ownerId,async client=>{
      await this.executionRow(client,ownerId,caseId,token);
      await client.query(`UPDATE public.organization_quality_attempt SET response_payload=$1,outcome=$2,response_model=$3,
        system_fingerprint=$4,duration_ms=$5,measurements=measurements||$6::jsonb WHERE id=$7 AND case_id=$8`,
      [response?JSON.stringify(response):null,outcome,response?.model??null,response?.system_fingerprint??null,
        durationMs,JSON.stringify(measurements),id,caseId]);
    });
  }
}
