/** 宿主装配真实回复服务；独立内部鉴权，停止后排空实际调用再释放官方适配器。 */
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {HostStorage} from './host-storage.ts';
import type {ModelPermitArbiter} from './model-permits.ts';
import type {PostgresModelLedger} from './model-ledger.ts';
import {installModelProvider,type ModelProviderConfiguration} from './model-provider.ts';
import {ReplyGenerationService,type ReplyServiceModel} from './reply-service.ts';
import {createReplyHttp,type ReplyHttpService} from './reply-http.ts';
import {ReplyError} from './reply-contract.ts';
import {ExplorationService} from './exploration-service.ts';
import {createExplorationHttp} from './exploration-http.ts';

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
}

export async function createHostReplyRuntime(options:HostReplyOptions) {
  const stopping=new AbortController();
  const pending=new Set<Promise<unknown>>();
  let provider:ReturnType<typeof installModelProvider>|undefined;
  let service:ReplyGenerationService|undefined;
  let exploration:ExplorationService|undefined;
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
  if(options.configuration){
    provider=installModelProvider(options.ctx,options.configuration.provider);
    try{
      service=new ReplyGenerationService({ctx:options.ctx,
        transaction:work=>options.storage.businessTransaction(work),
        arbiter:options.arbiter,ledger:options.ledger,provider,
        skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
      exploration=new ExplorationService({ctx:options.ctx,transaction:work=>options.storage.businessTransaction(work),arbiter:options.arbiter,ledger:options.ledger,provider,skillsRoot:options.configuration.skillsRoot,model:options.configuration.model});
    }catch(error){await provider.dispose();throw error;}
  }
  let closing:Promise<void>|undefined;
  return {
    configured:Boolean(service),
    async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{return await http.handle(req,res)||await explorationHttp.handle(req,res);},
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
