import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {StorageFailure} from '../storage/sqlite/contracts.ts';
const keys=new Set(['NOTALONE_OPENCODE_API_KEY','NOTALONE_DEEPSEEK_API_KEY','NOTALONE_DEEPSEEK_BASE_URL','NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS','NOTALONE_DEEPSEEK_MODEL',
 'NOTALONE_BACKGROUND_PROCESSING','NOTALONE_EXTRACTION_BATCH_CONCURRENCY','NOTALONE_PROBLEM_BUDGET','NOTALONE_PROBLEM_ROUND',
 'NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_REPLY_REMOTE_URL','NOTALONE_REPLY_REMOTE_TOKEN',
 'NOTALONE_EXTRACTION_REMOTE_URL','NOTALONE_EXTRACTION_REMOTE_TOKEN','NOTALONE_MODEL_PERMIT_SOCKET','NOTALONE_MODEL_PERMIT_TOKEN']);
const invalid=()=>new StorageFailure('sqlite_model_configuration_invalid');
/** 沿用既有dotenv优先级与引号语义，只从明确配置指针读取模型键，不实例化PG或修改进程环境。 */
export async function readSqliteModelEnvironment(location:string,environment:Readonly<NodeJS.ProcessEnv>):Promise<Readonly<NodeJS.ProcessEnv>>{
 const values:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(environment).filter(([key])=>keys.has(key)));
 if(environment.NOTALONE_DISABLE_DOTENV==='1')return Object.freeze(values);
 let file;
 try{
  file=await open(location,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=await file.stat();if(!info.isFile()||info.size>1024*1024)throw invalid();
  const source=await file.readFile('utf8');if(Buffer.byteLength(source)>1024*1024)throw invalid();
  for(const line of source.split(/\r?\n/)){
   const match=/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim().replace(/^export\s+/,''));
   if(!match||!keys.has(match[1])||values[match[1]]!==undefined)continue;
   let value=match[2].trim();if(value.length>=2&&['"',"'"].includes(value[0])&&value.at(-1)===value[0])value=value.slice(1,-1);
   values[match[1]]=value;
  }
  return Object.freeze(values);
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return Object.freeze(values);throw invalid();}
 finally{if(file)try{await file.close();}catch{throw invalid();}}
}

/** 显式manual只关闭自动派发，不撤销业务授权或手动单联系人入口。 */
export function resolveBackgroundProcessingMode(environment:Readonly<NodeJS.ProcessEnv>):'automatic'|'manual'{
 const value=environment.NOTALONE_BACKGROUND_PROCESSING??'automatic';
 if(value!=='automatic'&&value!=='manual')throw new StorageFailure('sqlite_background_configuration_invalid');
 return value;
}
