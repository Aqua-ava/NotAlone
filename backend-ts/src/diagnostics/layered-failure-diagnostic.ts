/** 分层任务的可删除失败诊断；只投影分类和代码位置，不保存异常正文。 */
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {relative,sep} from 'node:path';

export type LayeredFailurePhase='workspace'|'proposal'|'record_proposal'|'verification'|'record_verification'|'publish'|'profile'|'read';
export type LayeredFailureOperation='model_scope'|'model_recovery'|'model_prepare'|'model_permit'|'model_reservation'|'model_stream';
interface FailureFrame {file:string;line:number;column:number}
interface FailureFacts {
  name:string;
  code:string|null;
  frames:FailureFrame[];
  operation?:LayeredFailureOperation;
  provider_failure?:{code:string;status?:number};
}
export interface LayeredFailureDiagnostic {
  version:1;
  recorded_at:string;
  phase:LayeredFailurePhase;
  errors:FailureFacts[];
}
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const failureOperations=new WeakMap<object,LayeredFailureOperation>();
const operations=new Set<LayeredFailureOperation>(['model_scope','model_recovery','model_prepare','model_permit','model_reservation','model_stream']);
const errorNames=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','AbortError','AggregateError',
  'LlmError','L2ScenarioModelError','L2ScenarioError','L2ScenarioConflict','L2ScenarioVerificationError',
  'L3ProfileDocumentError','L3ProfileVerificationError','L3ProfileServiceConflict','HostStorageError']);
const providerCodes=new Set(['AUTH','RATE_LIMIT','NO_ADAPTER','NO_MODEL','MODEL_NOT_FOUND','NO_API_KEY',
  'INVALID_RESPONSE','CONTEXT_WINDOW_EXCEEDED','ABORTED','STREAM_FAILED','PROVIDER_ERROR','TRANSPORT_ERROR',
  'TIMEOUT','API_ERROR','HTTP_ERROR','NETWORK_ERROR','OVERLOADED','INVALID_REQUEST','REQUEST_FAILED','CONFIGURATION_ERROR']);
const nodeCodes=new Set(['ENOENT','EACCES','EPERM','ENOTDIR','EEXIST','ETIMEDOUT','ECONNREFUSED','ECONNRESET','EPIPE']);
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object';
/** 只附加进程内诊断位置；原异常身份、cause 和业务回执保持不变。 */
export async function withLayeredFailureOperation<T>(operation:LayeredFailureOperation,work:()=>Promise<T>):Promise<T> {
  try{return await work();}
  catch(error){if(record(error)&&!failureOperations.has(error))failureOperations.set(error,operation);throw error;}
}
function safeCode(value:unknown):string|null {
  if(typeof value!=='string')return null;
  return providerCodes.has(value)||nodeCodes.has(value)
    ||/^(?:l[23]_(?:scenario|profile)_|extraction_|model_|database_)[a-z0-9_]{1,64}$/.test(value)
    ||/^ERR_[A-Z0-9_]{1,64}$/.test(value)?value:null;
}
function frames(stack:unknown):FailureFrame[] {
  if(typeof stack!=='string')return [];
  const result:FailureFrame[]=[];
  for(const line of stack.slice(0,32_768).split('\n').slice(1,25)){
    const match=/(?:\(|at )((?:file:\/\/)?\/[^()\r\n]+):(\d+):(\d+)\)?$/.exec(line);
    if(!match)continue;
    let path:string;
    try{path=match[1].startsWith('file:')?fileURLToPath(match[1]):match[1];}catch{continue;}
    const file=relative(sourceRoot,path).split(sep).join('/');
    // 只接受当前源码树中确实存在的文件；不复制函数名、绝对路径或伪造的正文帧。
    if(file.startsWith('../')||!/^[-A-Za-z0-9_./]+\.ts$/.test(file)||!existsSync(path))continue;
    const frame={file,line:Number(match[2]),column:Number(match[3])};
    if(result.some(item=>item.file===frame.file&&item.line===frame.line&&item.column===frame.column))continue;
    result.push(frame);
    if(result.length===8)break;
  }
  return result;
}
export function layeredFailureDiagnostic(error:unknown,phase:LayeredFailurePhase):LayeredFailureDiagnostic {
  const diagnostic:LayeredFailureDiagnostic={version:1,recorded_at:new Date().toISOString(),phase,errors:[]};
  const seen=new Set<unknown>();
  let current=error;
  while(record(current)&&!seen.has(current)&&diagnostic.errors.length<6){
    seen.add(current);
    const facts:FailureFacts={name:typeof current.name==='string'&&errorNames.has(current.name)?current.name:'Error',
      code:safeCode(current.code),frames:frames(current.stack)};
    const operation=failureOperations.get(current)??current.operation;
    if(typeof operation==='string'&&operations.has(operation as LayeredFailureOperation))facts.operation=operation as LayeredFailureOperation;
    const provider=current.provider_failure??current.failure;
    if(record(provider)){
      facts.provider_failure={code:typeof provider.code==='string'&&providerCodes.has(provider.code)?provider.code:'PROVIDER_ERROR',
        ...(typeof provider.status==='number'&&Number.isInteger(provider.status)&&provider.status>=100&&provider.status<=599
          ?{status:provider.status}:{})};
    }
    diagnostic.errors.push(facts);
    current=current.cause;
  }
  return diagnostic;
}
