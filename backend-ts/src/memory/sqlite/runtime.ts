import {getOrCreateAnonymousUserId} from '@deepseek-ai/dsh-anonymous-user-id';
import {join,dirname} from 'node:path';
import {mkdir,lstat} from 'node:fs/promises';
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage} from 'node:http';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {resolveHostReplyConfiguration,type HostReplyConfiguration} from '../../host/host-reply-config.ts';
import {startModelHost} from '../../platform/models/model-host.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ExtractionPermitEndpoint} from '../extraction/model.ts';
import {createSqliteExtractionModelPort} from './model-port.ts';
import {SqliteMemoryExtraction,type ExtractionModelPort} from './service.ts';
import {SqliteMemoryExtractionHttp} from './http.ts';
/** 只消费共享host的许可端点；关闭能力继续由唯一宿主持有。 */
export interface SqliteMemorySharedModel {
 configuration:HostReplyConfiguration;
 permit:ExtractionPermitEndpoint;
 provider:ReturnType<typeof installModelProvider>;
 /** 匿名身份已绑定在共享provider上；记忆分支不另建目录或生成身份。 */
 resolveUserId:()=>string;
}
/** environment须由宿主安全加载env文件；configuration可复用该宿主已冻结的同一解析结果。 */
export async function createSqliteMemoryRuntime(options:{ctx:Context;storage:SqliteStorage;ownerId:string;userData:string;businessHome:string;infoPath:string;envFilePath:string;environment:Readonly<NodeJS.ProcessEnv>;sharedModel?:SqliteMemorySharedModel;holders:ActiveHolders;authorize(req:IncomingMessage):boolean}){
 const configuration=options.sharedModel?.configuration??resolveHostReplyConfiguration(options.environment);
 let service:SqliteMemoryExtraction;
 let modelHost:Awaited<ReturnType<typeof startModelHost>>|undefined;
 let port:ExtractionModelPort={prepare:async()=>{throw new StorageFailure('extraction_model_unconfigured');},invoke:async()=>{throw new StorageFailure('extraction_model_unconfigured');}};
 try{
  if(configuration.status==='configured'){
   let resolveUserId:Parameters<typeof createSqliteExtractionModelPort>[0]['resolveUserId'];
   if(!options.sharedModel){
   modelHost=await startModelHost({runtimeEnvironment:{...options.environment,NOTALONE_MANAGED_USER_DATA:options.userData},businessHome:options.businessHome,infoPath:options.infoPath,envFilePath:options.envFilePath,
    accounting:{reserve:async(r,c)=>{await service.accounting.reserve(r,c);},recordReserved:async r=>{await service.accounting.recordReserved(r);},unconfirmedRequests:s=>service.accounting.unconfirmedRequests!(s)}});
   const identityHome=join(dirname(modelHost.statePath),'identity');await mkdir(identityHome,{recursive:true,mode:0o700});const identity=await lstat(identityHome);if(!identity.isDirectory()||(identity.mode&0o077)!==0||process.getuid&&identity.uid!==process.getuid())throw new StorageFailure('memory_model_identity_not_private');const anonymousId=getOrCreateAnonymousUserId({env:{DSH_HOME:identityHome}});
   resolveUserId=()=>anonymousId;
   }
   port=createSqliteExtractionModelPort({ctx:options.ctx,configuration,permit:options.sharedModel?.permit??modelHost!.permit,resolveUserId,
    ...(options.sharedModel?{provider:options.sharedModel.provider}:{}),
    authorizePurpose:async({purpose,scope},signal)=>{signal.throwIfAborted();if(scope.owner_id!==options.ownerId||!['extraction','verification'].includes(purpose))throw new StorageFailure('memory_extraction_model_scope_invalid');}});
  }
  service=new SqliteMemoryExtraction(options.storage,options.ownerId,port,options.holders);await service.initialize();
  const http=new SqliteMemoryExtractionHttp(service,options.authorize);let closing:Promise<void>|undefined;
  return {service,http,configurationState:configuration.status,close:()=>closing??=(async()=>{
   // 自有许可先停领；业务释放失败时保留host，重试成功后才关闭其账本与socket。
   modelHost?.arbiter.stop();await service.close();if(modelHost)await modelHost.close(async()=>{});
  })().catch(error=>{closing=undefined;throw error;})};
 }catch(error){await port.close?.();await modelHost?.shutdown();throw error;}
}
