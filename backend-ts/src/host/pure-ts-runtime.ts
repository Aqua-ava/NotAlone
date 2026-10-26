/** 正常启动只有 TS；旧选择器显式失败，不启动第二个执行者。 */
export function pureTsRuntimeEnvironment(environment:Readonly<NodeJS.ProcessEnv>):NodeJS.ProcessEnv{
 const mode=environment.NOTALONE_HOST_RUNTIME??'typescript';
 if(mode!=='typescript')throw new Error('host_runtime_invalid');
 const result:NodeJS.ProcessEnv={...environment,NOTALONE_HOST_RUNTIME:'typescript'};
 for(const key of ['NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_HISTORY_RUNTIME']){
  if(result[key]!==undefined&&result[key]!=='typescript')throw new Error('host_runtime_ownership_conflict');
  result[key]='typescript';
 }
 if(['NOTALONE_REPLY_REMOTE_URL','NOTALONE_REPLY_REMOTE_TOKEN','NOTALONE_EXTRACTION_REMOTE_URL','NOTALONE_EXTRACTION_REMOTE_TOKEN','NOTALONE_MODEL_PERMIT_SOCKET','NOTALONE_MODEL_PERMIT_TOKEN'].some(key=>result[key]!==undefined))
  throw new Error('host_runtime_ownership_conflict');
 for(const key of ['NOTALONE_EXTRACTION_B_RUNTIME','NOTALONE_TASK_WORKER_RUNTIME']){
  if(result[key]!==undefined&&result[key]!=='typescript')throw new Error('host_runtime_ownership_conflict');
  result[key]='typescript';
 }
 return result;
}
