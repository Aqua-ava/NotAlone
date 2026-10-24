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
import {ExplorationService} from './exploration-service.ts';
import {createExplorationHttp} from './exploration-http.ts';
import {createExtractionModelCaller,extractionUnconfirmedRequests,type ExtractionModelInput,type ExtractionPermitEndpoint} from './extraction-model.ts';
import {ExtractionBatchService,ExtractionBatchError} from './extraction-batch-service.ts';
import {createExtractionBatchHttp} from './extraction-batch-http.ts';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

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
}

export async function createHostReplyRuntime(options:HostReplyOptions) {
  const stopping=new AbortController();
  const pending=new Set<Promise<unknown>>();
  let provider:ReturnType<typeof installModelProvider>|undefined;
  let service:ReplyGenerationService|undefined;
  let exploration:ExplorationService|undefined;
  let extraction:ReturnType<typeof createExtractionModelCaller>|undefined;
  let batches:ExtractionBatchService|undefined;
  async function extractionTransaction<T>(work:(client:pg.Client)=>Promise<T>):Promise<T>{
    let businessFailure:ExtractionBatchError|undefined;
    try{return await options.storage.businessTransaction(async client=>{
      try{return await work(client);}catch(error){if(error instanceof ExtractionBatchError)businessFailure=error;throw error;}
    });}catch(error){throw businessFailure??error;}
  }
  async function execute<T>(signal:AbortSignal,operation:(combined:AbortSignal)=>Promise<T>):Promise<T>{
    if(stopping.signal.aborted)throw new ReplyError('reply_remote_unavailable',503);
    const combined=AbortSignal.any([signal,stopping.signal]);
    const work=Promise.resolve().then(()=>{
      combined.throwIfAborted();
      if(!service)throw new ReplyError('reply_remote_unavailable',503);
      return operation(combined);
    });
    pending.add(work);
    try{return await work;}finally{pending.delete(work);}
  }
  const delegated:ReplyHttpService={
    prepare:(scope,body,signal,internal)=>execute(signal,combined=>service!.prepare(scope,body,combined,internal)),
    generate:(scope,body,signal,internal)=>execute(signal,combined=>service!.generate(scope,body,combined,internal)),
  };
  const owner=options.storage.runtimeOwnerId;
  const http=createReplyHttp({ownerId:owner,token:options.token,available:options.configuration!==null,
    read:work=>options.storage.businessReadTransaction(work),service:delegated});
  const explorationHttp=createExplorationHttp({ownerId:owner,token:options.token,available:options.configuration!==null,service:{execute:(scope,session,action,request,signal,internal)=>execute(signal,combined=>exploration!.execute(scope,session,action,request,combined,internal))}});
  const extractionHttp=createExtractionBatchHttp({token:options.token,execute:(input,signal)=>execute(signal,combined=>{
    if(!batches)throw new ExtractionBatchError('extraction_batch_unavailable');
    return batches.run(input,combined);
  })});
  if(options.configuration){
    provider=installModelProvider(options.ctx,options.configuration.provider);
    if(options.extractionPermit)extraction=createExtractionModelCaller({ctx:options.ctx,provider,permit:options.extractionPermit});
    try{
      service=new ReplyGenerationService({ctx:options.ctx,
        transaction:work=>options.storage.businessTransaction(work),
        arbiter:options.arbiter,ledger:options.ledger,provider,
        skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
      exploration=new ExplorationService({ctx:options.ctx,transaction:work=>options.storage.businessTransaction(work),arbiter:options.arbiter,ledger:options.ledger,provider,skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
      if(options.extractionEnabled&&extraction&&owner){
        const modules=['extraction-flow.ts','extraction-protocol.ts','extraction-protocol-calendar.ts','extraction-protocol-contract.ts','extraction-arguments.ts','extraction-evidence.ts','extraction-prompts.ts','extraction-bounded.ts','extraction-bounded-proof.ts','contact-overview-bounded-body.ts','contact-overview-bounded-contract.ts','contact-overview-bounded-graph.ts'];
        const sources=await Promise.all(modules.map(file=>readFile(new URL(file,import.meta.url))));
        const ruleVersion=createHash('sha256').update(Buffer.concat(sources)).digest('hex'),m=options.configuration.model;
        batches=new ExtractionBatchService({ownerId:owner,transaction:extractionTransaction,ruleVersion,
          model:{binding:{provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,reasoningEffort:m.reasoningEffort},profile:m.budgetProfile},
          unconfirmedRequests:scope=>extractionUnconfirmedRequests(options.extractionPermit!,scope),
          call:input=>extraction!.call({...input,signal:AbortSignal.any([input.signal,AbortSignal.timeout(m.deadline_ms)])})});
      }
    }catch(error){await provider.dispose();throw error;}
  }
  let closing:Promise<void>|undefined;
  return {
    configured:Boolean(service),
    callExtraction(input:ExtractionModelInput){return execute(input.signal,signal=>{
      if(!extraction)throw new ReplyError('reply_remote_unavailable',503);
      return extraction.call({...input,signal});
    });},
    async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
      return await extractionHttp.handle(req,res)
        || await http.handle(req,res)
        || await explorationHttp.handle(req,res);
    },
    stopAccepting(){stopping.abort();},
    close():Promise<void>{
      return closing??=(async()=>{
        stopping.abort();
        // 取消只通知业务；服务退出前仍持有真实物理许可，不能以HTTP断连代替结算。
        await Promise.allSettled([...pending]);
        await provider?.dispose();
      })();
    },
  };
}
