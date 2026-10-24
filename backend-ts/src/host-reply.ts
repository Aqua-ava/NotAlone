/** 宿主装配真实回复服务；独立内部鉴权，停止后排空实际调用再释放官方适配器。 */
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type pg from 'pg';
import type {HostStorage} from './host-storage.ts';
import type {ModelPermitArbiter} from './model-permits.ts';
import type {PostgresModelLedger} from './model-ledger.ts';
import {installModelProvider,type ModelProviderConfiguration} from './model-provider.ts';
import {ReplyGenerationService,type ReplyServiceModel} from './reply-service.ts';
import {createReplyHttp,type ReplyHttpService} from './reply-http.ts';
import {ReplyError} from './reply-contract.ts';
import {ReplyStoreError} from './reply-store.ts';
import {ExplorationService} from './exploration-service.ts';
import {createExplorationHttp} from './exploration-http.ts';
import {createExtractionModelCaller,extractionUnconfirmedRequests,type ExtractionModelInput,type ExtractionPermitEndpoint} from './extraction-model.ts';
import {ExtractionBatchService,ExtractionBatchError} from './extraction-batch-service.ts';
import {createExtractionBatchHttp} from './extraction-batch-http.ts';
import {createExtractionAdoptionHost,runExtractionWithAdoption} from './extraction-adoption-host.ts';
import {ExtractionTaskStore} from './extraction-task-store.ts';
import {ExtractionTaskRunner} from './extraction-task-runner.ts';
import {ExtractionWorker} from './extraction-worker.ts';
import {ContactMemoryIndexRunner} from './contact-memory-index.ts';
import {ExtractionWorkerTaskControl,type TaskControlPort} from './task-control.ts';
import {createLocalEmbeddingLifecycle} from './local-embedding-lifecycle.ts';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AssistantDiscussionError,AssistantDiscussionService} from './assistant-discussion-service.ts';
import {createAssistantDiscussionHttp} from './assistant-discussion-http.ts';
import {
  createL2ScenarioHost,
  type L2ScenarioHostCandidate,
} from './l2-scenario-host.ts';
import {createL2ScenarioHttp} from './l2-scenario-http.ts';
import {createL2ScenarioSourceValidator} from './l2-scenario-source-validation.ts';
import {createL2ScenarioWorkerRunner} from './l2-scenario-worker.ts';
import {
  L2ScenarioConflict,
  type L2ScenarioQualityReader,
} from './l2-scenario-service.ts';
import {L2ScenarioError,type L2ScenarioBudget} from './l2-scenario-workspace.ts';
import type {SourceProcessingTraceStore} from './source-processing-trace.ts';

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
  embeddingFactory?:Parameters<typeof createLocalEmbeddingLifecycle>[0];
  discussionSkillsRoot?:string;
  sourceTraces?:Pick<SourceProcessingTraceStore,
    'findMemoryTraceRecordInTransaction'|'validateMemoryTraceRecordInTransaction'>;
  l2Quality?:L2ScenarioQualityReader;
  l2Budget?:L2ScenarioBudget;
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
  const delegated:ReplyHttpService={
    prepare:(scope,body,signal,internal)=>execute(signal,combined=>{
      if(!service)throw new ReplyError('reply_remote_unavailable',503);
      return service.prepare(scope,body,combined,internal);
    }),
    generate:(scope,body,signal,internal)=>execute(signal,combined=>{
      if(!service)throw new ReplyError('reply_remote_unavailable',503);
      return service.generate(scope,body,combined,internal);
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
      withdrawScenario:(scope,settings,organization,version,signal)=>execute(signal,()=>{
        if(!l2Scenarios)throw new ReplyError('reply_remote_unavailable',503);
        return l2Scenarios.service.withdrawScenario(scope,settings,organization,version);
      }),
    }});
  const discussionSkillsRoot=options.discussionSkillsRoot??options.configuration?.skillsRoot;
  if(!discussionSkillsRoot?.trim())throw new Error('discussion_skills_root_required');
  const discussionHttp=createAssistantDiscussionHttp({ownerId:owner,token:options.token,
    service:new AssistantDiscussionService({
      transaction:discussionTransaction,
      skillsRoot:discussionSkillsRoot,
      environment:options.storage.runtimeEnvironment(),
    })});
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
      service=new ReplyGenerationService({ctx:options.ctx,
        transaction:work=>options.storage.businessTransaction(work),
        arbiter:options.arbiter,ledger:options.ledger,provider,
        skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
      exploration=new ExplorationService({ctx:options.ctx,transaction:work=>options.storage.businessTransaction(work),arbiter:options.arbiter,ledger:options.ledger,provider,skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
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
        const modules=['extraction-flow.ts','extraction-protocol.ts','extraction-protocol-calendar.ts','extraction-protocol-contract.ts','extraction-arguments.ts','extraction-verification-diagnostics.ts','extraction-evidence.ts','extraction-prompts.ts','extraction-bounded.ts','extraction-bounded-proof.ts','contact-overview-bounded-body.ts','contact-overview-bounded-contract.ts','contact-overview-bounded-graph.ts'];
        const sources=await Promise.all(modules.map(file=>readFile(new URL(file,import.meta.url))));
        const ruleVersion=createHash('sha256').update(Buffer.concat(sources)).digest('hex'),m=options.configuration.model;
        const call=(input:ExtractionModelInput)=>extraction!.call({...input,signal:AbortSignal.any([input.signal,AbortSignal.timeout(m.deadline_ms)])});
        batches=new ExtractionBatchService({ownerId:owner,transaction:extractionTransaction,ruleVersion,
          model:{binding:{provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,reasoningEffort:m.reasoningEffort},profile:m.budgetProfile},
          unconfirmedRequests:scope=>extractionUnconfirmedRequests(options.extractionPermit!,scope),
          call});
        if(options.extractionAdoptionEnabled){
          adoptionPool=await options.storage.businessPool();
          const store=new ExtractionTaskStore(adoptionPool);
          const binding={provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,
            reasoningEffort:m.reasoningEffort},profile=m.budgetProfile;
          adoptionHost=createExtractionAdoptionHost({ownerId:owner,taskStore:store,
            transaction:work=>options.storage.businessTransaction(work),call,binding,profile,
            ...(options.embeddingFactory?{embeddingFactory:options.embeddingFactory}:{})});
          const runner=new ExtractionTaskRunner({
            store,batches,
            adopt:(input,aResult,signal)=>adoptionHost!.run(input,aResult,signal),
            batchSize:10,contextBefore:5,contextAfter:0,
            concurrency:options.extractionConcurrency??1,ruleVersion,
            provider:m.provider,modelName:m.model,
          });
          extractionWorker=new ExtractionWorker({store,ownerId:owner,runner,
            indexRunner:new ContactMemoryIndexRunner({store}),
            ...(l2Scenarios?{organizationRunner:createL2ScenarioWorkerRunner(l2Scenarios)}:{})});
          if(!await extractionWorker.start())throw new Error('extraction_worker_already_running');
          extractionControl=new ExtractionWorkerTaskControl({store,worker:extractionWorker});
        }
      }
    }catch(error){
      await adoptionHost?.close().catch(()=>{});
      await adoptionPool?.end().catch(()=>{});
      await provider.dispose();
      throw error;
    }
  }
  let closing:Promise<void>|undefined;
  return {
    configured:Boolean(service),
    extractionControl:extractionControl as TaskControlPort|undefined,
    extractionWorkerStatus:extractionWorker?.status()??null,
    callExtraction(input:ExtractionModelInput){return execute(input.signal,signal=>{
      if(!extraction)throw new ReplyError('reply_remote_unavailable',503);
      return extraction.call({...input,signal});
    });},
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
    stopAccepting(){stopping.abort();},
    close():Promise<void>{
      return closing??=(async()=>{
        stopping.abort();
        await extractionControl?.close();
        if(extractionWorker&&!await extractionWorker.stop())throw new Error('extraction_worker_unsettled');
        // 取消只通知业务；服务退出前仍持有真实物理许可，不能以HTTP断连代替结算。
        await Promise.allSettled([...pending]);
        await adoptionHost?.close();
        await adoptionPool?.end();
        extractionWorker=undefined;extractionControl=undefined;
        await provider?.dispose();
      })();
    },
  };
}
