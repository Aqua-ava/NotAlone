import {AssistantRuntimeProjection} from '../reply/runtime/assistant-runtime-projection.ts';
/** 宿主装配真实回复服务；独立内部鉴权，停止后排空实际调用再释放官方适配器。 */
import {assistantRuntimeConfiguration,AssistantRuntime} from '../reply/runtime/assistant-runtime.ts';
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type pg from 'pg';
import type {HostStorage} from '../platform/database/host-storage.ts';
import type {ModelPermitArbiter} from '../platform/models/model-permits.ts';
import type {PostgresModelLedger} from '../platform/models/model-ledger.ts';
import {installModelProvider,type ModelProviderConfiguration} from '../platform/models/model-provider.ts';
import {ReplyGenerationService,type ReplyServiceModel} from '../reply/generation/reply-service.ts';
import {createReplyHttp,type ReplyHttpService} from '../reply/generation/reply-http.ts';
import {ReplyError} from '../reply/generation/reply-contract.ts';
import {ReplyStoreError} from '../reply/generation/reply-store.ts';
import {ExplorationService} from '../reply/exploration/exploration-service.ts';
import {createExplorationHttp} from '../reply/exploration/exploration-http.ts';
import {createExtractionModelCaller,extractionUnconfirmedRequests,type ExtractionModelInput,type ExtractionPermitEndpoint} from '../memory/extraction/model.ts';
import {ExtractionBatchService,ExtractionBatchError,type ExtractionRetryPolicy} from '../memory/extraction/service.ts';
import {createExtractionBatchHttp} from '../memory/extraction/http.ts';
import {createExtractionAdoptionHost,runExtractionWithAdoption} from '../memory/adoption/host.ts';
import {ExtractionTaskStore} from '../memory/extraction/tasks/store.ts';
import {ExtractionTaskRunner} from '../memory/extraction/tasks/runner.ts';
import {ExtractionWorker} from '../memory/extraction/tasks/worker.ts';
import {ContactMemoryIndexRunner} from '../memory/overview/catalog.ts';
import {ExtractionWorkerTaskControl,type TaskControlPort} from '../tasks/task-control.ts';
import {createLocalEmbeddingLifecycle} from '../platform/models/local-embedding-lifecycle.ts';
import {createExtractionPolicyVersion} from '../memory/extraction/policy-version.ts';
import {AssistantDiscussionError,AssistantDiscussionService} from '../reply/discussion/assistant-discussion-service.ts';
import {createAssistantDiscussionHttp} from '../reply/discussion/assistant-discussion-http.ts';
import {createPureTsPublicApi} from './pure-ts-public-api.ts';
import {AssistantGenerationLifecycle} from '../reply/discussion/assistant-generation-lifecycle.ts';
import {resolveRequestBinding,withPublicReplyScope,withoutPublicReplyScope} from './pure-ts-reply-scope.ts';
import {
  createL2ScenarioHost,
  type L2ScenarioHostCandidate,
} from '../memory/scenarios/host.ts';
import {createL2ScenarioHttp} from '../memory/scenarios/http.ts';
import {createL2ScenarioSourceValidator} from '../memory/scenarios/source-validation.ts';
import {createL2ScenarioWorkerRunner} from '../memory/scenarios/worker.ts';
import {
  L2ScenarioConflict,
  type L2ScenarioQualityReader,
} from '../memory/scenarios/service.ts';
import {L2ScenarioError,DEFAULT_L2_SCENARIO_BUDGET,type L2ScenarioBudget} from '../memory/scenarios/workspace.ts';
import {createOrganizationQualityApi} from '../diagnostics/organization-quality-api.ts';
import {createOrganizationQualityContract} from '../diagnostics/organization-quality-contract.ts';
import {createOrganizationQualityRuntime,type OrganizationQualityRuntime} from '../diagnostics/organization-quality-runtime.ts';
import {createQualityModelCaller} from '../diagnostics/quality-model-caller.ts';
import {qualityInputSourceRef} from '../diagnostics/organization-quality-store.ts';
import type {SourceProcessingTraceStore} from '../diagnostics/source-processing-trace.ts';
import {SkillFiles} from '../skills/skill-files.ts';
import {SkillLibrary} from '../skills/skill-library.ts';
import {SkillLearningStore} from '../skills/skill-learning-store.ts';
import {SkillLearningRuntime} from '../skills/skill-learning-runtime.ts';
import {SkillLearningTaskRunner} from '../skills/skill-learning-worker.ts';
import {SkillReviewStore} from '../skills/skill-review-store.ts';
import {SkillReviewService} from '../skills/skill-review-service.ts';
import {SkillHistoryPolicyStore} from '../skills/skill-history-policy-store.ts';
import {SkillLearningHttp} from '../skills/skill-learning-http.ts';
import type {SkillDiscussionValidator} from '../skills/skill-source-proof.ts';

export interface HostReplyConfiguration {
  provider:ModelProviderConfiguration;
  model:ReplyServiceModel;
  skillsRoot:string;
}
export interface HostReplyOptions {
  ctx:Context;
  storage:HostStorage;
  arbiter:Pick<ModelPermitArbiter,'acquire'>;
  ledger:Pick<PostgresModelLedger,'reserve'|'record'>;
  token:string;
  configuration:HostReplyConfiguration|null;
  extractionPermit?:ExtractionPermitEndpoint;
  extractionEnabled?:boolean;
  extractionAdoptionEnabled?:boolean;
  extractionConcurrency?:number;
  extractionVerificationPolicy?:'complete-claim-v1';
  extractionRetryPolicy?:Readonly<ExtractionRetryPolicy>;
  embeddingFactory?:Parameters<typeof createLocalEmbeddingLifecycle>[0];
  discussionSkillsRoot?:string;
  publicRuntime?:boolean;
  /** 完整启用前仅由隔离合成装配显式提供。 */
  persistentAssistantHome?:string;
  assistantRuntime?:AssistantRuntime;
  assistantClock?:import('../reply/discussion/assistant-user-activity.ts').AssistantClock;
  sourceTraces?:Pick<SourceProcessingTraceStore,
    'findMemoryTraceRecordInTransaction'|'validateMemoryTraceRecordInTransaction'>;
  l2Quality?:L2ScenarioQualityReader;
  l2Budget?:L2ScenarioBudget;
  skillLibrary?:SkillLibrary;
  requireDiscussionDependencies?:SkillDiscussionValidator;
}

export async function createHostReplyRuntime(options:HostReplyOptions) {
  const stopping=new AbortController();
  const pending=new Set<Promise<unknown>>();
  let provider:ReturnType<typeof installModelProvider>|undefined;
  let service:ReplyGenerationService|undefined;
  let exploration:ExplorationService|undefined;
  let extraction:ReturnType<typeof createExtractionModelCaller>|undefined;
  let batches:ExtractionBatchService|undefined;
  let adoptionHost:ReturnType<typeof createExtractionAdoptionHost>|undefined;
  let adoptionPool:pg.Pool|undefined;
  let extractionWorker:ExtractionWorker|undefined;
  let extractionControl:ExtractionWorkerTaskControl|undefined;
  let l2Scenarios:L2ScenarioHostCandidate|undefined;
  let qualityRuntime:OrganizationQualityRuntime|undefined;
  let learningPool:pg.Pool|undefined;
  let learningTaskStore:ExtractionTaskStore|undefined;
  let learningStore:SkillLearningStore|undefined;
  let learningRuntime:SkillLearningRuntime|undefined;
  let learningHttp:SkillLearningHttp|undefined;
  let learningWorker:SkillLearningTaskRunner|undefined;
  async function extractionTransaction<T>(work:(client:pg.Client)=>Promise<T>):Promise<T>{
    let businessFailure:ExtractionBatchError|undefined;
    try{return await options.storage.businessTransaction(async client=>{
      try{return await work(client);}catch(error){if(error instanceof ExtractionBatchError)businessFailure=error;throw error;}
    });}catch(error){throw businessFailure??error;}
  }
  async function discussionTransaction<T>(work:(client:pg.Client)=>Promise<T>):Promise<T>{
    let businessFailure:AssistantDiscussionError|ReplyStoreError|undefined;
    try{return await options.storage.businessTransaction(async client=>{
      try{return await work(client);}
      catch(error){
        if(error instanceof AssistantDiscussionError||error instanceof ReplyStoreError)businessFailure=error;
        throw error;
      }
    });}catch(error){throw businessFailure??error;}
  }
  async function l2Transaction<T>(work:(client:pg.Client)=>Promise<T>):Promise<T>{
    let businessFailure:L2ScenarioError|L2ScenarioConflict|undefined;
    try{return await options.storage.businessTransaction(async client=>{
      try{return await work(client);}
      catch(error){
        if(error instanceof L2ScenarioError||error instanceof L2ScenarioConflict)businessFailure=error;
        throw error;
      }
    });}catch(error){throw businessFailure??error;}
  }
  async function execute<T>(signal:AbortSignal,operation:(combined:AbortSignal)=>Promise<T>):Promise<T>{
    if(stopping.signal.aborted)throw new ReplyError('reply_remote_unavailable',503);
    const combined=AbortSignal.any([signal,stopping.signal]);
    const work=Promise.resolve().then(()=>{
      combined.throwIfAborted();
      return operation(combined);
    });
    pending.add(work);
    try{return await work;}finally{pending.delete(work);}
  }
  const scheduleLearning=(scope:{owner_id:string;contact_id:string})=>
    withoutPublicReplyScope(()=>execute(new AbortController().signal,async()=>{await learningHttp?.notify(scope);})).catch(()=>{});
  const delegated:ReplyHttpService={
    prepare:(scope,body,signal,internal)=>execute(signal,combined=>{
      if(!service)throw new ReplyError('reply_remote_unavailable',503);
      return service.prepare(scope,body,combined,internal);
    }),
    generate:(scope,body,signal,internal)=>execute(signal,combined=>{
      if(!service)throw new ReplyError('reply_remote_unavailable',503);
      return service.generate(scope,body,combined,internal).then(async result=>{
        await scheduleLearning({owner_id:scope.owner_id,contact_id:scope.contact_id});
        return result;
      });
    }),
  };
  const owner=options.storage.runtimeOwnerId;
  const l2Http=createL2ScenarioHttp({...(owner?{ownerId:owner}:{}),token:options.token,
    service:{
      run:(scope,claim,signal)=>execute(signal,combined=>{
        if(!l2Scenarios)throw new ReplyError('reply_remote_unavailable',503);
        return l2Scenarios.run(scope,claim,combined);
      }),
      read:(scope,cursor,signal)=>execute(signal,()=>{
        if(!l2Scenarios)throw new ReplyError('reply_remote_unavailable',503);
        return l2Scenarios.read(scope,cursor);
      }),
      reportParagraphError:(scope,command,signal)=>execute(signal,()=>{
        if(!l2Scenarios)throw new ReplyError('reply_remote_unavailable',503);
        return l2Scenarios.service.reportParagraphError(scope,command);
      }),
      reportProfileError:(scope,command,signal)=>execute(signal,()=>{
        if(!l2Scenarios)throw new ReplyError('reply_remote_unavailable',503);
        return l2Scenarios.service.reportProfileError(scope,command);
      }),
      withdrawScenario:(scope,settings,organization,version,signal)=>execute(signal,()=>{
        if(!l2Scenarios)throw new ReplyError('reply_remote_unavailable',503);
        return l2Scenarios.service.withdrawScenario(scope,settings,organization,version);
      }),
      withdrawProfile:(scope,settings,organization,version,signal)=>execute(signal,()=>{
        if(!l2Scenarios)throw new ReplyError('reply_remote_unavailable',503);
        return l2Scenarios.service.withdrawProfile(scope,settings,organization,version);
      }),
    }});
  const discussionSkillsRoot=options.discussionSkillsRoot??options.configuration?.skillsRoot;
  if(!discussionSkillsRoot?.trim())throw new Error('discussion_skills_root_required');
  const qualityContract=options.publicRuntime?createOrganizationQualityContract({
    ...(options.configuration?{provider:'deepseek',request_model:options.configuration.model.model,verifier_provider:'deepseek',verifier_model:options.configuration.model.model}:{}),
    budget:{...(options.l2Budget??DEFAULT_L2_SCENARIO_BUDGET),max_profile_entries:16},
  }):undefined;
  const qualityApi=options.publicRuntime&&owner?createOrganizationQualityApi({
    ownerId:owner,transaction:work=>options.storage.businessTransaction(work),contract:qualityContract,
    get runtime(){return qualityRuntime;},
  }):undefined;
  const assistantRuntime=options.assistantRuntime??(options.persistentAssistantHome?new AssistantRuntime({ctx:options.ctx,transaction:work=>options.storage.businessTransaction(work),home:options.persistentAssistantHome}):undefined);
  const runtimeProjection=new AssistantRuntimeProjection(discussionSkillsRoot);
  const discussionService=new AssistantDiscussionService({
      materializeRuntime:assistantRuntime?.persistent&&options.configuration?(scope,session,binding,signal)=>execute(signal,combined=>assistantRuntime.materialize(scope,session,assistantRuntimeConfiguration({version:1,model:options.configuration!.model,binding}),(client,build)=>runtimeProjection.read(client,scope,session,binding,undefined,undefined,build),combined)):undefined,
      eraseRuntime:assistantRuntime?(client,scope,session)=>assistantRuntime.erase(client,scope,session):undefined,
      transaction:discussionTransaction,assistantClock:options.assistantClock,
      skillsRoot:discussionSkillsRoot,
      environment:options.storage.runtimeEnvironment(),
      ...(options.publicRuntime?{resolveBinding:resolveRequestBinding}:{}),
    });
  const generation=options.publicRuntime?new AssistantGenerationLifecycle({
    transaction:async work=>{
      let failure:unknown;
      try{return await options.storage.businessTransaction(async client=>{
        try{return await work(client);}catch(error){failure=error;throw error;}
      });}catch(error){throw failure??error;}
    },requireSessionReady:assistantRuntime?.persistent?(client,scope,session,key)=>assistantRuntime.requireGenerationReady(client,scope,session,key):undefined,assistantClock:options.assistantClock,skillsRoot:discussionSkillsRoot,environment:options.storage.runtimeEnvironment(),replyService:delegated,resolveBinding:resolveRequestBinding,runInScope:withPublicReplyScope,
  }):undefined;
  if(generation&&owner)await generation.recover(owner);
  const publicApi=createPureTsPublicApi({ownerId:owner,available:options.configuration!==null,discussion:discussionService,reply:delegated,storage:options.storage,skillsRoot:discussionSkillsRoot,generation,
    exploration:{execute:(scope,session,action,request,signal,internal)=>execute(signal,combined=>exploration!.execute(scope,session,action,request,combined,internal))}});
  const discussionHttp=createAssistantDiscussionHttp({ownerId:owner,token:options.token,
    service:discussionService,deleteEnabled:!assistantRuntime?.persistent,
    onChanged:scope=>{void scheduleLearning({owner_id:scope.owner_id,contact_id:scope.contact_id});}});
  const learningFiles=new SkillFiles(discussionSkillsRoot);
  let reviewStore:SkillReviewStore|undefined;
  let historyPolicy:SkillHistoryPolicyStore|undefined;
  if(owner&&options.configuration){
    learningPool=await options.storage.businessPool();
    learningTaskStore=new ExtractionTaskStore(learningPool);
    learningStore=new SkillLearningStore({transaction:work=>options.storage.businessTransaction(work),
      files:learningFiles,taskStore:learningTaskStore,
      ...(options.requireDiscussionDependencies?{requireDiscussionDependencies:options.requireDiscussionDependencies}:{})});
    const skillLibrary=options.skillLibrary??new SkillLibrary(options.storage,learningFiles,{
      ...(options.requireDiscussionDependencies?{requireDiscussionDependencies:options.requireDiscussionDependencies}:{})});
    reviewStore=new SkillReviewStore({transaction:work=>options.storage.businessTransaction(work),learning:learningStore,
      files:learningFiles,library:skillLibrary,
      ...(options.requireDiscussionDependencies?{requireDiscussionDependencies:options.requireDiscussionDependencies}:{})});
    historyPolicy=new SkillHistoryPolicyStore({transaction:work=>options.storage.businessTransaction(work),
      files:learningFiles,library:skillLibrary,
      ...(options.requireDiscussionDependencies?{requireDiscussionDependencies:options.requireDiscussionDependencies}:{})});
  }
  let reviewService:SkillReviewService|undefined;
  const http=createReplyHttp({ownerId:owner,token:options.token,available:options.configuration!==null,
    read:work=>options.storage.businessReadTransaction(work),service:delegated});
  const explorationHttp=createExplorationHttp({ownerId:owner,token:options.token,available:options.configuration!==null,service:{execute:(scope,session,action,request,signal,internal)=>execute(signal,combined=>exploration!.execute(scope,session,action,request,combined,internal))}});
  const extractionHttp=createExtractionBatchHttp({token:options.token,
    execute:(input,signal)=>execute(signal,combined=>{
      if(!batches)throw new ExtractionBatchError('extraction_batch_unavailable');
      return batches.run(input,combined);
    }),
    ...(options.extractionAdoptionEnabled?{executeWithAdoption:(input,signal)=>execute(signal,combined=>{
      if(!batches||!adoptionHost)throw new ExtractionBatchError('extraction_adoption_unavailable');
      return runExtractionWithAdoption(batches,adoptionHost,input,combined);
    })}:{})});
  if(options.configuration){
    provider=installModelProvider(options.ctx,options.configuration.provider);
    if(options.extractionPermit)extraction=createExtractionModelCaller({ctx:options.ctx,provider,permit:options.extractionPermit});
    try{
      const m=options.configuration.model;
      if(options.publicRuntime&&qualityApi&&options.extractionPermit){
        const qualityModel=createQualityModelCaller({ctx:options.ctx,provider,permit:options.extractionPermit});
        qualityRuntime=createOrganizationQualityRuntime({call:input=>qualityModel.call(input),
          binding:{provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,reasoningEffort:m.reasoningEffort},profile:m.budgetProfile,
          diagnosticProblemBudgetBound:qualityModel.diagnosticProblemBudgetBound,sourceRef:qualityInputSourceRef});
      }
      // 前台等待预算调整不扩大后台提取与Skill学习的单次模型期限。
      const call=(input:ExtractionModelInput)=>extraction!.call({...input,
        signal:AbortSignal.any([input.signal,AbortSignal.timeout(Math.min(m.deadline_ms,20_000))])});
      if(owner&&extraction&&learningStore)learningRuntime=new SkillLearningRuntime({store:learningStore,call,
        binding:{provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,reasoningEffort:m.reasoningEffort},
        profile:m.budgetProfile});
      service=new ReplyGenerationService({ctx:options.ctx,assistantRuntime,
        transaction:work=>options.storage.businessTransaction(work),
        arbiter:options.arbiter,ledger:options.ledger,provider,
        skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
      if(reviewStore)reviewService=new SkillReviewService({ctx:options.ctx,transaction:work=>options.storage.businessTransaction(work),
        review:reviewStore,filesRoot:options.configuration.skillsRoot,provider,arbiter:options.arbiter,ledger:options.ledger,
        model:options.configuration.model});
      exploration=new ExplorationService({ctx:options.ctx,assistantClock:options.assistantClock,transaction:work=>options.storage.businessTransaction(work),arbiter:options.arbiter,ledger:options.ledger,provider,skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
      if(owner&&options.extractionPermit&&options.sourceTraces){
        l2Scenarios=createL2ScenarioHost({
          ctx:options.ctx,
          transaction:l2Transaction,
          provider,
          permit:options.extractionPermit,
          binding:{
            provider:options.configuration.model.provider,
            model:options.configuration.model.model,
            maxTokens:options.configuration.model.maxTokens,
            temperature:options.configuration.model.temperature,
            reasoningEffort:options.configuration.model.reasoningEffort,
          },
          profile:options.configuration.model.budgetProfile,
          ...(options.l2Budget?{budget:options.l2Budget}:{}),
          ...(options.l2Quality?{quality:options.l2Quality}:{}),
          validateSources:createL2ScenarioSourceValidator(options.sourceTraces),
        });
      }
      if(options.extractionEnabled&&extraction&&owner){
        const policyVersion=await createExtractionPolicyVersion(),ruleVersion=policyVersion.ruleVersion;
        batches=new ExtractionBatchService({ownerId:owner,transaction:extractionTransaction,ruleVersion,policyVersion,
          ...(options.extractionRetryPolicy===undefined?{}:{extractionRetryPolicy:options.extractionRetryPolicy}),
          model:{binding:{provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,reasoningEffort:m.reasoningEffort},profile:m.budgetProfile},
          unconfirmedRequests:scope=>extractionUnconfirmedRequests(options.extractionPermit!,scope),
          call});
        if(options.extractionAdoptionEnabled){
          adoptionPool=await options.storage.businessPool();
          const store=new ExtractionTaskStore(adoptionPool,{policyVersion,verificationPolicy:options.extractionVerificationPolicy});
          const binding={provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,
            reasoningEffort:m.reasoningEffort},profile=m.budgetProfile;
          adoptionHost=createExtractionAdoptionHost({ownerId:owner,taskStore:store,
            transaction:work=>options.storage.businessTransaction(work),call,binding,profile,
            ...(options.embeddingFactory?{embeddingFactory:options.embeddingFactory}:{})});
          const runner=new ExtractionTaskRunner({
            store,batches,
            adopt:(input,aResult,signal)=>adoptionHost!.run(input,aResult,signal),
            batchSize:10,contextBefore:5,contextAfter:0,
            concurrency:options.extractionConcurrency??1,ruleVersion,policyVersion,
            provider:m.provider,modelName:m.model,
          });
          learningWorker=new SkillLearningTaskRunner({store:learningStore!,
            ...(learningRuntime?{runtime:learningRuntime}:{})});
          extractionWorker=new ExtractionWorker({store,ownerId:owner,runner,
            indexRunner:new ContactMemoryIndexRunner({store}),
            ...(l2Scenarios?{organizationRunner:createL2ScenarioWorkerRunner(l2Scenarios)}:{}),
            learningRunner:learningWorker});
          if(!await extractionWorker.start())throw new Error('extraction_worker_already_running');
          extractionControl=new ExtractionWorkerTaskControl({store,worker:extractionWorker});
        }
      }
    }catch(error){
      await adoptionHost?.close().catch(()=>{});
      await adoptionPool?.end().catch(()=>{});
      await learningPool?.end().catch(()=>{});
      await provider.dispose();
      throw error;
    }
  }
  if(owner&&learningStore&&reviewStore&&historyPolicy){
    learningHttp=new SkillLearningHttp({ownerId:owner,learning:learningStore,review:reviewStore,
      ...(reviewService?{reviewService}:{}),historyPolicy,canSchedule:Boolean(learningRuntime&&extractionWorker),
      wake:async(scope,taskId)=>{
        if(!extractionWorker?.wake({ownerId:scope.owner_id,contactId:scope.contact_id},taskId))
          throw new Error('skill_learning_worker_unavailable');
      }});
  }
  let closing:Promise<void>|undefined;
  return {
    configured:Boolean(service),
    qualityApi:qualityApi?{...qualityApi,
      handle:(method:string,url:URL,body:unknown,signal:AbortSignal)=>execute(signal,combined=>qualityApi.handle(method,url,body,combined)),
    }:undefined,
    extractionControl:extractionControl as TaskControlPort|undefined,
    extractionWorkerStatus:extractionWorker?.status()??null,
    callExtraction(input:ExtractionModelInput){return execute(input.signal,signal=>{
      if(!extraction)throw new ReplyError('reply_remote_unavailable',503);
      return extraction.call({...input,signal});
    });},
    handleSkillLearning(method:string,url:URL,body:unknown,signal:AbortSignal){
      return execute(signal,combined=>learningHttp
        ? learningHttp.handle(method,url,body,combined)
        : Promise.resolve({status:503,body:{error:'skill_learning_unavailable'}}));
    },
    async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
      return await l2Http.handlePrivate(req,res)
        || await extractionHttp.handle(req,res)
        || await discussionHttp.handle(req,res)
        || await http.handle(req,res)
        || await explorationHttp.handle(req,res);
    },
    handleLayeredMemory(req:IncomingMessage,res:ServerResponse,url:URL){
      return l2Http.handlePublic(req,res,url);
    },
    handlePublic(req:IncomingMessage,res:ServerResponse,url:URL){return publicApi.handle(req,res,url);},
    stopAccepting(){stopping.abort();},
    close():Promise<void>{
      return closing??=(async()=>{
        stopping.abort();
        await generation?.drain();
        await extractionControl?.close();
        if(extractionWorker&&!await extractionWorker.stop())throw new Error('extraction_worker_unsettled');
        // 取消只通知业务；服务退出前仍持有真实物理许可，不能以HTTP断连代替结算。
        await Promise.allSettled([...pending]);
        await adoptionHost?.close();
        await adoptionPool?.end();
        await learningPool?.end();
        extractionWorker=undefined;extractionControl=undefined;
        await provider?.dispose();
      })();
    },
  };
}
