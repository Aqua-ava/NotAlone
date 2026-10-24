/** 显式验收入口的统一模型宿主；稳定journal、可信PG授权及唯一私有回复。 */
import type {Context} from '@deepseek-ai/cordis';
import {getOrCreateAnonymousUserId} from '@deepseek-ai/dsh-anonymous-user-id';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {mkdir,lstat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {resolveSkillsRoot} from './skills-root.ts';
import {randomBytes} from 'node:crypto';
import type {HostStorage} from './host-storage.ts';
import {resolveHostReplyConfiguration} from './host-reply-config.ts';
import {createHostReplyRuntime} from './host-reply.ts';
import {createHostModelAccounting} from './host-model-accounting.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from './model-ledger.ts';
import {startModelHost,assertModelHostFallbackSafe,modelBackgroundConcurrency} from './model-host.ts';
import type {SourceProcessingTraceStore} from './source-processing-trace.ts';
import type {L2ScenarioQualityReader} from './l2-scenario-service.ts';
import type {L2ScenarioBudget} from './l2-scenario-workspace.ts';
import {UnavailableTaskControl,type TaskControlPort} from './task-control.ts';

export class HostModelRuntimeError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;}
}
export interface HostModelRuntimeOptions {
  ctx:Context;storage:HostStorage;environment:Readonly<NodeJS.ProcessEnv>;
  businessHome:string;projectDirectory:string;infoPath:string;envFilePath:string;
  sourceTraces?:Pick<SourceProcessingTraceStore,
    'findMemoryTraceRecordInTransaction'|'validateMemoryTraceRecordInTransaction'>;
  l2Quality?:L2ScenarioQualityReader;
  l2Budget?:L2ScenarioBudget;
}
/** 默认Python只是一项启动决定，不安装提供者或第二套后台仲裁器。 */
export async function startHostModelRuntime(options:HostModelRuntimeOptions){
  const environment=options.environment,mode=environment.NOTALONE_REPLY_RUNTIME??'python';
  const extractionMode=environment.NOTALONE_EXTRACTION_RUNTIME??'python';
  if(!['python','typescript'].includes(extractionMode)||extractionMode==='typescript'&&mode!=='typescript')throw new HostModelRuntimeError('extraction_runtime_ownership_invalid');
  if(mode!=='python'&&mode!=='typescript')throw new HostModelRuntimeError('reply_runtime_invalid');
  if(mode==='python'){
    if(environment.NOTALONE_REPLY_REMOTE_URL!==undefined||environment.NOTALONE_REPLY_REMOTE_TOKEN!==undefined
      ||environment.NOTALONE_MODEL_PERMIT_SOCKET!==undefined||environment.NOTALONE_MODEL_PERMIT_TOKEN!==undefined)
      throw new HostModelRuntimeError('reply_runtime_ownership_conflict');
    try{
      await assertModelHostFallbackSafe({runtimeEnvironment:environment,businessHome:options.businessHome,infoPath:options.infoPath,envFilePath:options.envFilePath});
    }catch{throw new HostModelRuntimeError('reply_runtime_recovery_required');}
    return undefined;
  }
  const configuration=resolveHostReplyConfiguration(environment);
  if(configuration.status!=='configured'&&configuration.code!=='reply_model_unconfigured')throw new HostModelRuntimeError(configuration.code);
  const ownerConfigured=Boolean(options.storage.runtimeOwnerId&&(await options.storage.setupStatus()).runtime_owner_configured);
  const unavailable=configuration.status!=='configured'?'reply_model_unconfigured':!ownerConfigured?'reply_owner_unconfigured':undefined;
  const replyStatus=unavailable?{state:'unconfigured' as const,reason:unavailable}:{state:'ready' as const};
  const transaction=options.storage.businessTransaction.bind(options.storage);
  const ledger=new PostgresModelLedger({transaction,details:new PostgresModelLedgerDetails()});
  // Python010/真实transport使用供应商名deepseek；不拿TS内部路由名替代其台账身份。
  let currentHost:Awaited<ReturnType<typeof startModelHost>>|undefined;
  const accounting=createHostModelAccounting({transaction,...(configuration.status==='configured'&&!unavailable
    ?{provider:'deepseek',typescriptProvider:configuration.provider.provider,model:configuration.model.model}:{route:null}),
    unconfirmedPermitIds:()=>{
      if(!currentHost)throw new HostModelRuntimeError('model_runtime_starting');
      return currentHost.unconfirmedPermitIds();
    }});
  const modelHost=await startModelHost({runtimeEnvironment:environment,businessHome:options.businessHome,
    infoPath:options.infoPath,envFilePath:options.envFilePath,accounting});
  currentHost=modelHost;
  let reply:Awaited<ReturnType<typeof createHostReplyRuntime>>|undefined;
  try{
    const configuredSkillsRoot=resolveSkillsRoot(environment,options.businessHome,options.projectDirectory);
    // journal只有在核实旧进程消失后才给出unknown；提交PG恢复先于任何Python队列启动。
    const recovered=await ledger.recoverUnknownPermits(modelHost.unknownSettlements().map(item=>item.id));
    const token=randomBytes(32).toString('base64url');
    let activeConfiguration:Parameters<typeof createHostReplyRuntime>[0]['configuration']=null;
    if(configuration.status==='configured'&&!unavailable){
      const anonymousHome=join(dirname(modelHost.statePath),'identity');
      try{await mkdir(anonymousHome,{mode:0o700});}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      const identityDirectory=await lstat(anonymousHome);
      if(!identityDirectory.isDirectory()||(identityDirectory.mode&0o077)!==0
        ||process.getuid&&identityDirectory.uid!==process.getuid())throw new HostModelRuntimeError('model_identity_directory_not_private');
      const anonymousId=getOrCreateAnonymousUserId({env:{DSH_HOME:anonymousHome}});
      activeConfiguration={skillsRoot:configuredSkillsRoot,model:configuration.model,
        provider:{...configuration.provider,resolveUserId:()=>anonymousId}};
    }
    reply=await createHostReplyRuntime({ctx:options.ctx,storage:options.storage,arbiter:modelHost.arbiter,
      ledger,token,configuration:activeConfiguration,extractionEnabled:extractionMode==='typescript',
      extractionAdoptionEnabled:extractionMode==='typescript',
      extractionConcurrency:modelBackgroundConcurrency(environment),
      discussionSkillsRoot:configuredSkillsRoot,
      ...(options.sourceTraces?{sourceTraces:options.sourceTraces}:{}),
      ...(options.l2Quality?{l2Quality:options.l2Quality}:{}),
      ...(options.l2Budget?{l2Budget:options.l2Budget}:{}),
      extractionPermit:{path:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_SOCKET,token:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_TOKEN}});
    const runtime=reply;
    if(extractionMode==='typescript'&&!unavailable&&!runtime.extractionControl)
      throw new HostModelRuntimeError('extraction_worker_unavailable');
    const extractionControl:TaskControlPort|undefined=extractionMode==='typescript'
      ? runtime.extractionControl??new UnavailableTaskControl(unavailable
        ?'model_configuration_unavailable':'worker_unavailable')
      : undefined;
    let closing:Promise<void>|undefined;
    const stopAccepting=()=>{runtime.stopAccepting();modelHost.arbiter.stop();};
    return {
      statePath:modelHost.statePath,recoveredUnknown:recovered.length,replyStatus,
      pythonEnvironment(address:string){
        if(!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(address))throw new HostModelRuntimeError('reply_remote_address_invalid');
        return {...modelHost.pythonEnvironment,NOTALONE_REPLY_RUNTIME:'typescript',
          NOTALONE_REPLY_REMOTE_URL:address,NOTALONE_REPLY_REMOTE_TOKEN:token,
          ...(extractionMode==='typescript'?{NOTALONE_EXTRACTION_RUNTIME:'typescript',
            NOTALONE_EXTRACTION_B_RUNTIME:'typescript',
            NOTALONE_TASK_WORKER_RUNTIME:'typescript',
            NOTALONE_EXTRACTION_REMOTE_URL:address,NOTALONE_EXTRACTION_REMOTE_TOKEN:token}:{}),
          // 仅宿主到本次Legacy的允许列表协议；配置保存后整体重启，不热切换。
          NOTALONE_MODEL_UNCONFIGURED_REASON:unavailable??'',
          ...(!ownerConfigured?{NOTALONE_OWNER_ID:''}:{})};
      },
      handle(req:IncomingMessage,res:ServerResponse){return runtime.handle(req,res);},
      handleLayeredMemory(req:IncomingMessage,res:ServerResponse,url:URL){return runtime.handleLayeredMemory(req,res,url);},
      callExtraction:runtime.callExtraction,
      extractionControl,
      extractionWorkerStatus:runtime.extractionWorkerStatus,
      stopAccepting,
      close(stopPython:()=>Promise<void>):Promise<void>{
        return closing??=(async()=>{
          stopAccepting();
          // 排队者已唤醒；两侧实际SDK退出后才能释放适配器/socket，不凭HTTP断线结算。
          const stopped=await Promise.allSettled([Promise.resolve().then(stopPython),runtime.close()]);
          const failures=stopped.filter(result=>result.status==='rejected').map(result=>result.reason);
          const state=modelHost.arbiter.snapshot();
          if(failures.length||state.orphaned||state.foregroundActive||state.backgroundActive){
            await modelHost.shutdown(); // 仅停止控制面，active/unknown仍保留在稳定journal。
            throw new HostModelRuntimeError('model_runtime_unsettled');
          }
          await modelHost.close(async()=>{});
        })();
      },
    };
  }catch(error){
    reply?.stopAccepting();modelHost.arbiter.stop();
    await reply?.close().catch(()=>{});
    await modelHost.shutdown();
    throw error;
  }
}
