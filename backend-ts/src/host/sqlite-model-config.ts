import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {StorageFailure} from '../storage/sqlite/contracts.ts';
import {MODEL_PARAMETER_ENV_KEYS} from './model-parameters.ts';
const keys=new Set(['NOTALONE_OPENCODE_API_KEY','NOTALONE_DEEPSEEK_API_KEY','NOTALONE_DEEPSEEK_BASE_URL','NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS','NOTALONE_DEEPSEEK_MODEL',
 'NOTALONE_BACKGROUND_PROCESSING','NOTALONE_IMAGE_PROCESSING','NOTALONE_EXTRACTION_BATCH_CONCURRENCY','NOTALONE_PROBLEM_BUDGET','NOTALONE_PROBLEM_ROUND',
 'NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_REPLY_REMOTE_URL','NOTALONE_REPLY_REMOTE_TOKEN',
 'NOTALONE_EXTRACTION_REMOTE_URL','NOTALONE_EXTRACTION_REMOTE_TOKEN',...MODEL_PARAMETER_ENV_KEYS]);
const invalid=()=>new StorageFailure('sqlite_model_configuration_invalid');
/** 解析dotenv单行：支持export前缀与成对引号；非赋值行返回undefined。 */
export function parseEnvLine(line:string):[string,string]|undefined{
 const match=/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim().replace(/^export\s+/,''));
 if(!match)return;let value=match[2].trim();
 if(value.length>=2&&['"',"'"].includes(value[0])&&value.at(-1)===value[0])value=value.slice(1,-1);
 return [match[1],value];
}
/** 受限读取dotenv：拒绝符号链接与非常规文件，上限1MB；文件不存在返回undefined，其余失败原样抛出，由调用方映射错误码。 */
export async function readBoundedEnvFile(location:string):Promise<string|undefined>{
 let file;
 try{
  file=await open(location,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=await file.stat();if(!info.isFile()||info.size>1024*1024)throw new Error('env_file_invalid');
  const source=await file.readFile('utf8');if(Buffer.byteLength(source)>1024*1024)throw new Error('env_file_invalid');
  return source;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 finally{await file?.close();}
}
/** 沿用既有dotenv优先级与引号语义，只从明确配置指针读取模型键，不实例化PG或修改进程环境。 */
export async function readSqliteModelEnvironment(location:string,environment:Readonly<NodeJS.ProcessEnv>):Promise<Readonly<NodeJS.ProcessEnv>>{
 const values:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(environment).filter(([key])=>keys.has(key)));
 if(environment.NOTALONE_DISABLE_DOTENV==='1')return Object.freeze(values);
 let source;
 try{source=await readBoundedEnvFile(location);}catch{throw invalid();}
 for(const line of source?.split(/\r?\n/)??[]){
  const entry=parseEnvLine(line);
  if(!entry||!keys.has(entry[0])||values[entry[0]]!==undefined)continue;
  values[entry[0]]=entry[1];
 }
 return Object.freeze(values);
}

/** 显式manual只关闭自动派发，不撤销业务授权或手动单联系人入口。 */
export function resolveBackgroundProcessingMode(environment:Readonly<NodeJS.ProcessEnv>):'automatic'|'manual'{
 const value=environment.NOTALONE_BACKGROUND_PROCESSING??'automatic';
 if(value!=='automatic'&&value!=='manual')throw new StorageFailure('sqlite_background_configuration_invalid');
 return value;
}

/** 图片可单独自动补查，不同时启动历史、引用或模型任务。 */
export function resolveImageProcessingMode(environment:Readonly<NodeJS.ProcessEnv>):'automatic'|'manual'{
 const value=environment.NOTALONE_IMAGE_PROCESSING??resolveBackgroundProcessingMode(environment);
 if(value!=='automatic'&&value!=='manual')throw new StorageFailure('sqlite_image_configuration_invalid');
 return value;
}
