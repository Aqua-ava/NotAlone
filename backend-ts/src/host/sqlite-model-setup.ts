import {constants} from 'node:fs';
import {open, mkdir, rename, unlink} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StorageFailure} from '../storage/sqlite/contracts.ts';
import {readSqliteModelEnvironment} from './sqlite-model-config.ts';
import {normalizeModelBaseUrl} from './model-base-url.ts';

const modelKeys=['NOTALONE_DEEPSEEK_API_KEY','NOTALONE_DEEPSEEK_MODEL','NOTALONE_DEEPSEEK_BASE_URL'] as const;
function parseLine(line:string):[string,string]|undefined {
 const match=/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim().replace(/^export\s+/,''));
 if(!match)return;let value=match[2].trim();
 if(value.length>=2&&['"',"'"].includes(value[0])&&value.at(-1)===value[0])value=value.slice(1,-1);
 return [match[1],value];
}
async function readFile(location:string):Promise<string> {
 let file;
 try {file=await open(location,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await file.stat();
  if(!stat.isFile()||stat.size>1024*1024)throw new Error();const text=await file.readFile('utf8');if(Buffer.byteLength(text)>1024*1024)throw new Error();return text;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw new StorageFailure('configuration_unavailable');}
 finally{await file?.close();}
}
/** 只管理受控文件中的模型设置；不会返回或记录密钥。 */
export class SqliteModelSetup {
 private pending=false;private tail:Promise<void>=Promise.resolve();
 private readonly location:string;private readonly environment:Readonly<NodeJS.ProcessEnv>;private readonly values:NodeJS.ProcessEnv;private readonly overridden:boolean;
 private constructor(location:string,environment:Readonly<NodeJS.ProcessEnv>,values:NodeJS.ProcessEnv,overridden:boolean){this.location=location;this.environment=environment;this.values=values;this.overridden=overridden;this.pending=overridden;}
 static async open(location:string,environment:Readonly<NodeJS.ProcessEnv>):Promise<SqliteModelSetup>{
  const values={...await readSqliteModelEnvironment(location,environment)};
  const fileValues=environment.NOTALONE_DISABLE_DOTENV==='1'?{}:await readSqliteModelEnvironment(location,{});
  const overridden=modelKeys.some(key=>environment[key]!==undefined&&fileValues[key]!==undefined&&environment[key]!==fileValues[key]);
  return new SqliteModelSetup(location,{...environment},values,overridden);
 }
 runtimeEnvironment():Readonly<NodeJS.ProcessEnv>{return Object.freeze({...this.values});}
 private baseUrl():string|null {try{return normalizeModelBaseUrl(this.values.NOTALONE_DEEPSEEK_BASE_URL??'https://api.deepseek.com');}catch{return null;}}
 status(){return {deepseek_base_url:this.baseUrl(),initialized:true,owner_configured:true,runtime_owner_configured:true,
  credentials_configured:Boolean(this.values.NOTALONE_DEEPSEEK_API_KEY?.trim()),
  official_deepseek_defaults:(this.values.NOTALONE_DEEPSEEK_MODEL||'deepseek-flash')==='deepseek-flash'&&['https://api.deepseek.com','https://api.deepseek.com/v1'].includes((this.values.NOTALONE_DEEPSEEK_BASE_URL??'https://api.deepseek.com').replace(/\/+$/,'')),
  runtime_configuration_pending:this.pending,runtime_configuration_environment_override:this.overridden};}
 async save(key:string,official:boolean):Promise<void>{
  if(typeof key!=='string'||!key.trim()||key.length>4096||!/^[-A-Za-z0-9_]+$/.test(key.trim()))throw new StorageFailure('setup_request_invalid');
  const changes:Record<string,string>={NOTALONE_DEEPSEEK_API_KEY:key.trim()};
  if(official){changes.NOTALONE_DEEPSEEK_MODEL='deepseek-flash';changes.NOTALONE_DEEPSEEK_BASE_URL='https://api.deepseek.com';}
  await this.writeChanges(changes);
 }
 async saveConfiguration(baseUrl:string,apiKey:string):Promise<void>{
  const normalized=normalizeModelBaseUrl(baseUrl);
  if(typeof apiKey!=='string'||!apiKey.trim()||apiKey.length>4096||!/^[-A-Za-z0-9_]+$/.test(apiKey.trim()))throw new StorageFailure('setup_request_invalid');
  await this.writeChanges({NOTALONE_DEEPSEEK_BASE_URL:normalized,NOTALONE_DEEPSEEK_API_KEY:apiKey.trim()});
 }
 private async writeChanges(changes:Record<string,string>):Promise<void>{
  if(this.environment.NOTALONE_DISABLE_DOTENV==='1'||Object.entries(changes).some(([name,value])=>this.environment[name]!==undefined&&this.environment[name]!==value))throw new StorageFailure('configuration_environment_override');
  const operation=this.tail.then(async()=>{
   let temp:string|undefined;
   try{await mkdir(dirname(this.location),{recursive:true,mode:0o700});const existing=await readFile(this.location);
    const lines=existing.split(/\r?\n/).filter(line=>{const entry=parseLine(line);return !entry||!(entry[0] in changes);});
    while(lines.at(-1)==='')lines.pop();const output=[...lines,...Object.entries(changes).map(([name,value])=>`${name}=${value}`),''].join('\n');
    temp=join(dirname(this.location),`.${basename(this.location)}.${randomUUID()}.tmp`);
    const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await file.writeFile(output);await file.sync();}finally{await file.close();}
    await rename(temp,this.location);Object.assign(this.values,changes);this.pending=true;
   }catch(error){if(error instanceof StorageFailure)throw error;throw new StorageFailure('configuration_write_failed');}
   finally{if(temp)await unlink(temp).catch(()=>{});}
  });
  this.tail=operation.catch(()=>{});await operation;
 }
}
