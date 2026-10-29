import {getOrCreateAnonymousUserId} from '@deepseek-ai/dsh-anonymous-user-id';
import {join,dirname} from 'node:path';
import {mkdir,lstat} from 'node:fs/promises';
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage} from 'node:http';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {resolveHostReplyConfiguration} from '../../host/host-reply-config.ts';
import {startModelHost} from '../../platform/models/model-host.ts';
import {createSqliteExtractionModelPort} from './model-port.ts';
import {SqliteMemoryExtraction,type ExtractionModelPort} from './service.ts';
import {SqliteMemoryExtractionHttp} from './http.ts';
/** 公共宿主只装配生命周期；配置、唯一许可、模型与存储保持现有窄边界。 */
export async function createSqliteMemoryRuntime(options:{ctx:Context;storage:SqliteStorage;ownerId:string;userData:string;businessHome:string;infoPath:string;envFilePath:string;environment:Readonly<NodeJS.ProcessEnv>;holders:ActiveHolders;authorize(req:IncomingMessage):boolean}){
 const configuration=resolveHostReplyConfiguration(options.environment);
 let service:SqliteMemoryExtraction;
 let modelHost:Awaited<ReturnType<typeof startModelHost>>|undefined;
 let port:ExtractionModelPort={prepare:async()=>{throw new StorageFailure('extraction_model_unconfigured');},invoke:async()=>{throw new StorageFailure('extraction_model_unconfigured');}};
 try{
  if(configuration.status==='configured'){
   modelHost=await startModelHost({runtimeEnvironment:{...options.environment,NOTALONE_MANAGED_USER_DATA:options.userData},businessHome:options.businessHome,infoPath:options.infoPath,envFilePath:options.envFilePath,
    accounting:{reserve:async(r,c)=>{await service.accounting.reserve(r,c);},recordReserved:async r=>{await service.accounting.recordReserved(r);},unconfirmedRequests:s=>service.accounting.unconfirmedRequests!(s)}});
   const identityHome=join(dirname(modelHost.statePath),'identity');await mkdir(identityHome,{recursive:true,mode:0o700});const identity=await lstat(identityHome);if(!identity.isDirectory()||(identity.mode&0o077)!==0||process.getuid&&identity.uid!==process.getuid())throw new StorageFailure('memory_model_identity_not_private');const anonymousId=getOrCreateAnonymousUserId({env:{DSH_HOME:identityHome}});
   port=createSqliteExtractionModelPort({ctx:options.ctx,configuration,permit:modelHost.permit,resolveUserId:()=>anonymousId,
    authorizePurpose:async({purpose,scope},signal)=>{signal.throwIfAborted();if(scope.owner_id!==options.ownerId||!['extraction','verification'].includes(purpose))throw new StorageFailure('memory_extraction_model_scope_invalid');}});
  }
  service=new SqliteMemoryExtraction(options.storage,options.ownerId,port,options.holders);await service.initialize();
  const http=new SqliteMemoryExtractionHttp(service,options.authorize);let closing:Promise<void>|undefined;
  return {service,http,configurationState:configuration.status,close:()=>closing??=modelHost?modelHost.close(()=>service.close()):service.close()};
 }catch(error){await port.close?.();await modelHost?.shutdown();throw error;}
}
