/** 明确选择完整 TS 宿主；兼容分支保留到迁移验收通过。 */
export function pureTsRuntimeEnvironment(environment:Readonly<NodeJS.ProcessEnv>):NodeJS.ProcessEnv{
 const mode=environment.NOTALONE_HOST_RUNTIME??'legacy';
 if(!['legacy','typescript'].includes(mode))throw new Error('host_runtime_invalid');
 if(mode==='legacy')return {...environment};
 const result={...environment};
 for(const key of ['NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_HISTORY_RUNTIME']){
  if(result[key]!==undefined&&result[key]!=='typescript')throw new Error('host_runtime_ownership_conflict');
  result[key]='typescript';
 }
 if(['NOTALONE_REPLY_REMOTE_URL','NOTALONE_REPLY_REMOTE_TOKEN','NOTALONE_EXTRACTION_REMOTE_URL','NOTALONE_EXTRACTION_REMOTE_TOKEN','NOTALONE_MODEL_PERMIT_SOCKET','NOTALONE_MODEL_PERMIT_TOKEN'].some(key=>result[key]!==undefined))
  throw new Error('host_runtime_ownership_conflict');
 return result;
}
