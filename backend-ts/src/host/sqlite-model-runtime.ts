import type {Context} from '@deepseek-ai/cordis';
import {getOrCreateAnonymousUserId} from '@deepseek-ai/dsh-anonymous-user-id';
import {mkdir,lstat} from 'node:fs/promises';
import {StorageFailure} from '../storage/sqlite/contracts.ts';
import {resolveHostReplyConfiguration} from './host-reply-config.ts';
import {startModelHost} from '../platform/models/model-host.ts';
import {installModelProvider} from '../platform/models/model-provider.ts';
import type {ModelPermitAccounting} from '../platform/models/model-permit-port.ts';

/** 记忆与讨论共用一个真实许可宿主和provider；配置来自明确env指针，领域不持有共享关闭权。 */
export async function createSqliteModelRuntime(options:{ctx:Context;environment:Readonly<NodeJS.ProcessEnv>;userData:string;businessHome:string;infoPath:string;envFilePath:string;accounting?:ModelPermitAccounting}){
 const environment=options.environment;
 if((environment.NOTALONE_REPLY_RUNTIME??'typescript')!=='typescript'||(environment.NOTALONE_EXTRACTION_RUNTIME??'typescript')!=='typescript'
  ||['NOTALONE_REPLY_REMOTE_URL','NOTALONE_REPLY_REMOTE_TOKEN','NOTALONE_EXTRACTION_REMOTE_URL','NOTALONE_EXTRACTION_REMOTE_TOKEN'].some(key=>environment[key]!==undefined))throw new StorageFailure('sqlite_model_runtime_ownership_invalid');
 const configuration=resolveHostReplyConfiguration(environment);
 if(configuration.status!=='configured')return {configuration,shared:undefined,stopAccepting(){},async close():Promise<{forced?:readonly string[]}>{return {};}};
 const modelHost=await startModelHost({...options,runtimeEnvironment:{...environment,NOTALONE_MANAGED_USER_DATA:options.userData}});
 let provider:ReturnType<typeof installModelProvider>|undefined;
 try{
  const identityHome=modelHost.identityHome;await mkdir(identityHome,{recursive:true,mode:0o700});
  const identity=await lstat(identityHome);
  if(!identity.isDirectory()||identity.isSymbolicLink()||(identity.mode&0o077)!==0||process.getuid&&identity.uid!==process.getuid())throw new StorageFailure('sqlite_model_identity_not_private');
  const anonymousId=getOrCreateAnonymousUserId({env:{DSH_HOME:identityHome}}),resolveUserId=()=>anonymousId;
  provider=installModelProvider(options.ctx,{...configuration.provider,resolveUserId});
  const shared={configuration,provider,permit:modelHost.permit,arbiter:modelHost.arbiter,resolveUserId};let closing:Promise<{forced?:readonly string[]}>|undefined;
  return {configuration,shared,stopAccepting(){modelHost.arbiter.stop();},close():Promise<{forced?:readonly string[]}>{
   // 孤儿调用与超时的真实在途调用只记入停读报告；权威记录仍在SQLite台账，下次启动继续按未知调用阻塞。
   return closing??=(async()=>{await modelHost.close(async()=>{});await shared.provider.dispose();
    const drain=modelHost.drainReport;
    return {forced:[...(drain?.timedOut?['models']:[]),...(drain&&drain.orphaned>0?['modelOrphans']:[])]};})().catch(error=>{closing=undefined;throw error;});
  }};
 }catch{
  await provider?.dispose().catch(()=>{});await modelHost.shutdown().catch(()=>{});
  throw new StorageFailure('sqlite_model_runtime_unavailable');
 }
}
