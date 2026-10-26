/** 质量执行的正式模型注入合同；质量租约与生产任务租约保持独立。 */
import type {GenerateOptions,ContentBlock} from '@deepseek-ai/dsh-llm';
import type {MessagesBudgetProfile,MessagesBudgetBinding} from '../platform/models/model-input-budget.ts';
import type {ModelLedgerReceipt} from '../platform/models/model-ledger.ts';
import {qualityInputSourceRef,type OrganizationQualitySource,type OrganizationQualityStore} from './organization-quality-store.ts';
import type {OrganizationQualityPhase,QualityRow} from './organization-quality-contract.ts';
import {OrganizationQualityError,qualityKeys} from './organization-quality-contract.ts';
import {L2ScenarioDocumentWorkspace,L2ScenarioError,L2ScenarioVerificationError,runScenarioDocumentAgent,validateScenarioDocument,
  verifyScenarioProposal,type L2ScenarioDraft,type L2ScenarioMemory,type L2ScenarioVersion,type ScenarioDocumentCall,type ScenarioDocumentCallPort} from '../memory/layered/l2-scenario-workspace.ts';
import {L3ProfileWorkspace,filterProfileProposal,runProfileDocumentAgent,validateProfile,verifyProfileProposal} from '../memory/layered/l3-profile-workspace.ts';
import {qualityModelMemories,qualityModelScenarios} from './organization-quality-snapshot.ts';
import {qualityModelRequestId} from './quality-model-authorization.ts';

export interface OrganizationQualityModelInput {
  owner_id:string;contact_id:string|null;run_id:string;case_id:string;execution_token:string;phase:OrganizationQualityPhase;
  request_id:string;attempt_id:string;binding:MessagesBudgetBinding;profile:MessagesBudgetProfile;
  messages:GenerateOptions['messages'];system?:GenerateOptions['system'];tools?:GenerateOptions['tools'];signal:AbortSignal;
  requireCurrent():Promise<void>;
  /** 正式宿主在物理发送许可处调用一次，晚到来源失效必须拒绝发送。 */
  onDispatch(input:{request_payload:QualityRow;request_route:string;measurements?:QualityRow}):Promise<void>;
  onReceipt(receipt:ModelLedgerReceipt,evidence?:{response_payload?:QualityRow;measurements?:QualityRow}):Promise<void>;
}
export interface OrganizationQualityModelResult {blocks:readonly ContentBlock[];receipt:ModelLedgerReceipt;response_payload?:QualityRow;}
export interface OrganizationQualityRuntime {
  executeNext(store:OrganizationQualityStore,ownerId:string,runId:string,allowUnreviewedSmoke:boolean,signal:AbortSignal):Promise<void>;
}
export interface OrganizationQualityRuntimeOptions {
  call(input:OrganizationQualityModelInput):Promise<OrganizationQualityModelResult>;
  binding:ScenarioDocumentCall['binding'];profile:MessagesBudgetProfile;transportKind?:'sdk'|'synthetic';
  diagnosticProblemBudgetBound?:boolean;
  sourceRef?:(input:OrganizationQualitySource)=>string|null;
}

function projectedMessages(input:ScenarioDocumentCall,memories:readonly L2ScenarioMemory[]):GenerateOptions['messages'] {
  const messages=structuredClone(input.messages);
  if(input.contact_id!==null)return messages;
  const scope={owner_id:input.owner_id,contact_id:null};
  const byId=new Map(qualityModelMemories(scope,memories).map(memory=>[memory.memory_id,memory]));
  for(const message of messages){
    if(message.role!=='user')continue;
    for(const block of message.content){
      if(block.type!=='text')continue;
      const payload=JSON.parse(block.text);
      if(Array.isArray(payload.memories))payload.memories=payload.memories.map((memory:QualityRow)=>{
        const projected=byId.get(memory.memory_id);
        if(!projected)throw new OrganizationQualityError('quality_input_changed',409);
        return 'verbatim_text' in memory?{memory_id:projected.memory_id,revision:projected.revision,
          verbatim_text:projected.text,timing:projected.timing}:projected;
      });
      for(const key of ['scenarios','changed_scenarios'])if(Array.isArray(payload[key]))payload[key]=qualityModelScenarios(scope,payload[key]);
      if(payload.proposal?.scenarios)payload.proposal.scenarios=payload.proposal.scenarios.map((draft:QualityRow)=>({
        ...draft,paragraphs:draft.paragraphs.map((paragraph:QualityRow)=>({...paragraph,references:paragraph.references.map((ref:QualityRow)=>({
          memory_id:ref.memory_id,revision:ref.revision,timing:byId.get(ref.memory_id)?.timing??{},
        }))})),
      }));
      block.text=JSON.stringify(payload);
    }
  }
  return messages;
}
function rejectedL2Challenge(value:unknown,scenarios:readonly L2ScenarioDraft[]):boolean {
  if(!qualityKeys(value,['results'])||!Array.isArray(value.results))return false;
  const expected=new Set(scenarios.flatMap((scenario,i)=>scenario.paragraphs.map((_paragraph,j)=>`${i}:${j}`)));
  const seen=new Set<string>();
  for(const row of value.results){
    if(!qualityKeys(row,['scenario_index','paragraph_index','supported','evidence'])||!Number.isSafeInteger(row.scenario_index)
      ||!Number.isSafeInteger(row.paragraph_index)||row.supported!==false||!Array.isArray(row.evidence))return false;
    const key=`${row.scenario_index}:${row.paragraph_index}`;
    if(!expected.has(key)||seen.has(key))return false;seen.add(key);
  }
  return seen.size===expected.size&&expected.size>0;
}

export function createOrganizationQualityRuntime(options:OrganizationQualityRuntimeOptions):OrganizationQualityRuntime {
  const binding=structuredClone(options.binding),profile=structuredClone(options.profile),transport=options.transportKind??'sdk';
  const budgetBound=options.diagnosticProblemBudgetBound===true,resolveSource=options.sourceRef;
  return {async executeNext(store,ownerId,runId,allowUnreviewedSmoke,signal){
    signal.throwIfAborted();
    if(transport==='sdk'&&(!budgetBound||!resolveSource))throw new OrganizationQualityError('quality_evaluation_unavailable',503);
    // 同一认领事务核对来源；错误配置回滚，不消费 case 或冻结其审核。
    const candidate=await store.claimCase(ownerId,runId,transport,allowUnreviewedSmoke,resolveSource??qualityInputSourceRef);
    if(!candidate)return;
    const caseId=String(candidate.id),token=String(candidate.execution_token),source=String(candidate.source_ref),scope={owner_id:ownerId,contact_id:candidate.contact_id};
    const memories=candidate.memories as L2ScenarioMemory[];
    const current=candidate.model_input.scenarios.map((scenario:QualityRow)=>({...scenario,input_manifest:candidate.input_manifest,dependency_ids:candidate.dependency_ids})) as L2ScenarioVersion[];
    const budget=store.contract.budget,corrections=candidate.model_input.corrections??[];
    const rejectedTexts=new Set<string>(corrections.map((item:QualityRow)=>String(item.rejected_text)));
    const executionSignal=AbortSignal.any([signal,AbortSignal.timeout(190_000)]);
    // 工作区只携带调用元数据；模型端口只授权实际质量 case，不领取或伪造后台任务。
    // 旧工作区只透传 claim；适配器保留真实质量身份，绝不构造生产任务或假租约。
    const workspaceClaim={kind:'organization_quality',run_id:runId,case_id:caseId,execution_token:token} as unknown as ScenarioDocumentCall['claim'];
    let phase:OrganizationQualityPhase='l2_proposal',phaseSignal=executionSignal,calls=0;
    // 取消阻止发送，由 caller 的 signal 检查承担；收尾仍须保存已发生请求的回执。
    const requireCurrent=async()=>{await store.checkExecution(ownerId,caseId,token);};
    const port:ScenarioDocumentCallPort={async call(input){
      if(calls>=budget.max_model_calls)throw new OrganizationQualityError('physical_attempt_budget_exhausted',409);
      const attemptId=crypto.randomUUID();let dispatched=false,settled=false,dispatchFailure:unknown;
      const requestId=qualityModelRequestId(runId,caseId,phase);
      const result=await options.call({owner_id:ownerId,contact_id:scope.contact_id,run_id:runId,case_id:caseId,
        execution_token:token,phase,request_id:requestId,attempt_id:attemptId,binding:structuredClone(binding),profile:structuredClone(profile),
        messages:projectedMessages(input,memories),system:input.system,tools:input.tools,signal:phaseSignal,requireCurrent,
        async onDispatch(value){
          try{
            if(dispatched)throw new OrganizationQualityError('quality_physical_dispatch_duplicate',409);
            await requireCurrent();
            const actual=value.measurements?.request_entity_characters;
            if(!Number.isSafeInteger(actual)||actual<0)throw new OrganizationQualityError('quality_request_measurement_unavailable',503);
            if(actual>budget.max_characters){
              await store.recordEvidence(ownerId,caseId,token,'budget_rejections',[{phase,...value.measurements,
                limit_characters:budget.max_characters,http_attempt_reserved:false}]);
              throw new OrganizationQualityError('actual_request_budget_exceeded',409);
            }
            if(source!==qualityInputSourceRef({case_id:caseId,input_sha256:String(candidate.input_sha256)}))
              throw new OrganizationQualityError('quality_evaluation_unavailable',503);
            await store.reserveAttempt(ownerId,runId,caseId,token,phase,value.request_payload,value.request_route,
              {...value.measurements,source_ref:source},attemptId);
            calls++;dispatched=true;
          }catch(error){dispatchFailure=error;throw error;}
        },
        async onReceipt(receipt,evidence){
          if(!dispatched||settled||receipt.attempt_id!==attemptId||receipt.request_id!==requestId||receipt.owner_id!==ownerId
            ||receipt.contact_id!==scope.contact_id)throw new OrganizationQualityError('quality_model_receipt_invalid',409);
          const normalized=receipt.usage;
          const response=evidence?.response_payload?{...evidence.response_payload,...(normalized?{usage:{...evidence.response_payload.usage,
            prompt_tokens:normalized.input_tokens,completion_tokens:normalized.output_tokens,
            total_tokens:normalized.input_tokens+normalized.output_tokens}}:{})}:null;
          await store.finishExecutionAttempt(ownerId,caseId,token,attemptId,receipt.outcome,receipt.latency_ms??0,response,
            {...evidence?.measurements,...(normalized?{usage_measurement:'normalized_llm_stream'}:{})});
          settled=true;
        },
      }).catch(error=>{throw dispatchFailure??error;});
      if(!dispatched||!settled||result.receipt.outcome!=='succeeded')throw new OrganizationQualityError('quality_model_receipt_unknown',503);
      return {blocks:result.blocks,receipt_id:attemptId};
    }};
    const context=()=>({port,claim:workspaceClaim,owner_id:ownerId,contact_id:scope.contact_id,batch_id:caseId,binding,profile,
      signal:phaseSignal,requireCurrent});
    const start=(next:OrganizationQualityPhase)=>{phase=next;phaseSignal=AbortSignal.any([executionSignal,AbortSignal.timeout(30_000)]);};
    const record=(key:string,value:unknown,finished=false)=>store.recordStage(ownerId,caseId,token,key,value,{finished});
    try{
      start('l2_proposal');
      const workspace=new L2ScenarioDocumentWorkspace(memories,current,budget);
      const l2=await runScenarioDocumentAgent({...context(),workspace});
      await record('l2_proposal_isolation',{original:{scenarios:l2.scenarios},rejected:[]});
      if(l2.scenarios.some(scenario=>rejectedTexts.has(scenario.title)||rejectedTexts.has(scenario.hint)
        ||scenario.paragraphs.some(paragraph=>rejectedTexts.has(paragraph.text))))throw new L2ScenarioError('l2_scenario_correction_rejected');
      await record('l2',{scenarios:l2.scenarios});
      start('l2_verification');
      const verified=await verifyScenarioProposal({...context(),scenarios:l2.scenarios,memories});
      await record('l2_verification_isolation',{verdict:verified.result,rejected:[]});
      await record('l2_verification',true);
      const documents=await store.checkpointL2(ownerId,caseId,token,l2.scenarios);
      if(!documents.length){await record('l3',{entries:[]});await record('l3_not_required',true);}
      else{
        start('l3_proposal');
        const workspace=new L3ProfileWorkspace(null,documents,memories,budget);
        const proposal=await runProfileDocumentAgent({...context(),workspace,existing:null,scenarios:documents,memories,
          changedScenarios:documents,removedScenarioVersionIds:[],baseProfileVersionId:null,corrections,remainingCalls:budget.max_model_calls-calls});
        const filtered=filterProfileProposal(proposal.proposal,memories,budget,rejectedTexts);
        await record('l3_proposal_isolation',{original:proposal.proposal,rejected:filtered.rejected,trace:proposal.trace});
        if(proposal.proposal.entries.length&&!filtered.entries.length)throw new L2ScenarioError('l3_profile_proposal_invalid');
        await record('l3',{entries:filtered.entries});
        start('l3_verification');
        const verification=await verifyProfileProposal({...context(),entries:filtered.entries,memories,scenarios:documents,budget,
          corrections,remainingCalls:budget.max_model_calls-calls});
        await record('l3_verification_isolation',{verdict:verification.result,
          rejected:verification.result.results.filter(result=>!result.supported)});
        const supported=filtered.entries.filter((_entry,index)=>verification.result.results.some(result=>result.entry_index===index&&result.supported));
        if(filtered.entries.length&&!supported.length){
          await store.recordStage(ownerId,caseId,token,'l3_verification',false,{errorCode:'faithfulness_rejected'});return;
        }
        await record('l3_verification',true);
        await record('l3',validateProfile({entries:supported},memories,budget));
      }
      for(const layer of ['l2','l3'] as const){
        start(`${layer}_challenge`);
        const challenge=candidate.annotations?.verifier_challenges?.[layer];
        if(!challenge){await record(phase,null,layer==='l3');continue;}
        const proposal=challenge.proposal;
        if(layer==='l2')validateScenarioDocument(proposal,memories,current,budget);
        else validateProfile(proposal,memories,budget);
        await store.recordEvidence(ownerId,caseId,token,phase,{layer,memories:qualityModelMemories(scope,memories),
          scenarios:qualityModelScenarios(scope,layer==='l2'?current:documents),corrections,proposal});
        let passed=false,verdict:unknown;
        if(layer==='l2'){
          try{verdict=(await verifyScenarioProposal({...context(),scenarios:proposal.scenarios,memories})).result;}
          catch(error){if(error instanceof L2ScenarioVerificationError){verdict=error.verification;passed=rejectedL2Challenge(verdict,proposal.scenarios);}else throw error;}
        }else{
          const verification=await verifyProfileProposal({...context(),entries:proposal.entries,memories,scenarios:documents,budget,
            corrections,remainingCalls:budget.max_model_calls-calls});
          verdict=verification.result;
          passed=proposal.entries.length>0&&verification.result.results.every(result=>result.supported===false);
        }
        await record(`${phase}_isolation`,{verdict,rejected:[]});
        // 原 DTO 保存核验器是否放行：反例的正确结果是 false。
        await store.recordStage(ownerId,caseId,token,phase,!passed,{finished:layer==='l3',errorCode:passed?null:'verifier_false_accept'});
        if(!passed)return;
      }
    }catch(error){
      if(error instanceof OrganizationQualityError&&error.code==='quality_evidence_not_found')return;
      if(String(phase)==='l2_verification'&&error instanceof L2ScenarioVerificationError&&error.code==='l2_scenario_verification_rejected'){
        await record('l2_verification_isolation',{verdict:error.verification,rejected:[]});
        await store.recordStage(ownerId,caseId,token,phase,false,{errorCode:'faithfulness_rejected'});return;
      }
      const code=error instanceof OrganizationQualityError&&['physical_attempt_budget_exhausted','actual_request_budget_exceeded'].includes(error.code)
        ?error.code:error instanceof L2ScenarioError?'evaluation_stage_invalid':'evaluation_stage_failed';
      try{await store.recordStage(ownerId,caseId,token,`${phase}_error`,code,{errorCode:code});}
      catch(error){if(!(error instanceof OrganizationQualityError&&['quality_evidence_not_found','quality_input_changed'].includes(error.code)))throw error;}
    }
  }};
}
