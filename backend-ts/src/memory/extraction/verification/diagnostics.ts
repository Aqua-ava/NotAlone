/** V失败只记录包络形状；不复制模型参数、聊天正文、引文或理由。 */
import {ExtractionArgumentsError} from '../arguments.ts';

type JsonType='object'|'array'|'string'|'number'|'boolean'|'null'|'unavailable';

export interface VerificationFailureDiagnostic {
  failure_kind:'invalid_output';
  classification:
    |'missing_tool_call'|'multiple_tool_calls'|'wrong_tool_name'|'arguments_not_string'
    |'arguments_not_json'|'arguments_not_strict_json'|'root_array'|'root_not_object'
    |'root_keys_mismatch'|'results_not_array'|'results_count_mismatch'|'verification_contract_invalid';
  block_types:string[];
  tool_names:string[];
  arguments_parseable:boolean;
  json_root_type:JsonType;
  json_root_keys:string[];
  results_type:JsonType;
  results_count:number|null;
  rows:{keys:string[];candidate_index:number|'invalid';verdict:string;evidence_count:number|null}[];
}

const rootKeys=['results'];
const rowKeys=['candidate_index','verdict','issues','evidence','proof','event_verification','condition_verification'];
const verdicts=['supported','uncertain','unsupported'];
const blockTypes=new Set(['text','reasoning','image','file','tool-call','tool-addition','tool-removal']);

function record(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function jsonType(value:unknown):JsonType{
  if(value===undefined)return 'unavailable';
  if(value===null)return 'null';
  if(Array.isArray(value))return 'array';
  return typeof value==='object'?'object':typeof value==='string'?'string':typeof value==='number'?'number':typeof value==='boolean'?'boolean':'unavailable';
}
function uniqueNames(values:string[],limit=16):string[]{
  return [...new Set(values)].sort().slice(0,limit);
}
function safeBlockType(value:unknown):string{
  return typeof value==='string'&&blockTypes.has(value)?value:'<invalid>';
}
function safeToolName(value:unknown,expected:string):string{
  return value===expected?expected:'<other>';
}
function safeKeys(value:Record<string,unknown>,allowed:readonly string[]):string[]{
  return Object.keys(value).map(key=>allowed.includes(key)?key:'<other>').sort();
}
function toolCalls(blocks:readonly unknown[]):Record<string,unknown>[]{
  return blocks.filter((block):block is Record<string,unknown>=>record(block)&&block.type==='tool-call');
}
function firstRowArray(value:unknown):unknown[]|null{
  if(Array.isArray(value))return value;
  if(!record(value))return null;
  if(Array.isArray(value.results))return value.results;
  const arrays=Object.values(value).filter(Array.isArray);
  return arrays.length===1?arrays[0] as unknown[]:null;
}
function candidateIndex(value:unknown):number|'invalid'{
  return Number.isInteger(value)&&Number(value)>=0&&Number(value)<=60?Number(value):'invalid';
}
function rowShape(value:unknown):VerificationFailureDiagnostic['rows'][number]{
  if(!record(value))return {keys:[],candidate_index:'invalid',verdict:'invalid',evidence_count:null};
  return {
    keys:safeKeys(value,rowKeys),
    candidate_index:candidateIndex(value.candidate_index),
    verdict:typeof value.verdict==='string'&&verdicts.includes(value.verdict)?value.verdict:'invalid',
    evidence_count:Array.isArray(value.evidence)?value.evidence.length:null,
  };
}
function classify(
  calls:Record<string,unknown>[],expectedName:string,parsed:unknown,root:Record<string,unknown>|null,
  results:unknown[]|null,expectedCount:number,error:unknown,
):VerificationFailureDiagnostic['classification']{
  if(calls.length===0)return 'missing_tool_call';
  if(calls.length!==1)return 'multiple_tool_calls';
  if(calls[0]!.name!==expectedName)return 'wrong_tool_name';
  if(typeof calls[0]!.arguments!=='string')return 'arguments_not_string';
  if(parsed===undefined)return 'arguments_not_json';
  if(Array.isArray(parsed))return 'root_array';
  if(!root)return 'root_not_object';
  if(Object.keys(root).length!==1||!Object.hasOwn(root,'results'))return 'root_keys_mismatch';
  if(!Array.isArray(root.results))return 'results_not_array';
  if(results&&results.length!==expectedCount)return 'results_count_mismatch';
  if(error instanceof ExtractionArgumentsError)return 'arguments_not_strict_json';
  return 'verification_contract_invalid';
}

export function verificationFailureDiagnostic(
  blocks:readonly unknown[],expectedName:string,expectedCount:number,error:unknown,
):VerificationFailureDiagnostic{
  try{
    const calls=toolCalls(Array.isArray(blocks)?blocks:[]);
    const raw=calls.length===1?calls[0]!.arguments:undefined;
    let parsed:unknown;
    if(typeof raw==='string'){
      try{parsed=JSON.parse(raw);}catch{parsed=undefined;}
    }
    const root=record(parsed)?parsed:null;
    const results=root&&Array.isArray(root.results)?root.results:null;
    const rowSource=firstRowArray(parsed);
    return {
      failure_kind:'invalid_output',
      classification:classify(calls,expectedName,parsed,root,results,expectedCount,error),
      block_types:uniqueNames(Array.isArray(blocks)?blocks.map(value=>safeBlockType(record(value)?value.type:undefined)):[]),
      tool_names:uniqueNames(calls.map(call=>safeToolName(call.name,expectedName))),
      arguments_parseable:parsed!==undefined,
      json_root_type:jsonType(parsed),
      json_root_keys:root?safeKeys(root,rootKeys):[],
      results_type:root?jsonType(root.results):'unavailable',
      results_count:results?.length??null,
      rows:(rowSource??[]).slice(0,60).map(rowShape),
    };
  }catch{
    return {failure_kind:'invalid_output',classification:'verification_contract_invalid',block_types:[],tool_names:[],
      arguments_parseable:false,json_root_type:'unavailable',json_root_keys:[],results_type:'unavailable',
      results_count:null,rows:[]};
  }
}
