/** 新任务的显式核验策略、实际 A 源码闭包及统一版本身份。 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,extname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJSON,digest} from '../overview/contact-overview-evidence.ts';
import type {PreparedVerificationPolicy} from './complete-claim-verification.ts';

export interface CompleteClaimRuntimeConfig {
 version:2;mode:'legacy';rule_set_sha256:null;verification_policy:'complete-claim-v1';source_stamp:string;
}
export interface LegacyRuntimeConfig {version:1;mode:'legacy'|'bounded-runtime-v1';rule_set_sha256:string|null;}
export type ExtractionRuntimeConfig=CompleteClaimRuntimeConfig|LegacyRuntimeConfig|null;
export interface ResolvedExtractionPolicy {
 mode:'legacy'|'bounded-runtime-v1';verification:PreparedVerificationPolicy;ruleVersion:string;
 config:ExtractionRuntimeConfig;
}
export interface ExtractionPolicyVersion {
 readonly sourceStamp:string;readonly ruleVersion:string;
 newTaskConfig():CompleteClaimRuntimeConfig;
 resolve(config:unknown):ResolvedExtractionPolicy;
 assertCurrent():Promise<void>;
}
export class ExtractionPolicyVersionError extends Error {
 readonly code:string;constructor(code:string){super(code);this.code=code;}
}
const hash=/^[a-f0-9]{64}$/;
const invalid=():never=>{throw new ExtractionPolicyVersionError('extraction_runtime_config_invalid');};
const unavailable=():never=>{throw new ExtractionPolicyVersionError('extraction_policy_source_unavailable');};
export function validateExtractionRuntimeConfig(value:unknown):ExtractionRuntimeConfig {
 if(value===null||value===undefined)return null;
 if(typeof value!=='object'||Array.isArray(value))invalid();
 const row=value as Record<string,unknown>,keys=Object.keys(row).sort().join(',');
 if(row.version===1){
  if(keys!=='mode,rule_set_sha256,version'||typeof row.mode!=='string'||!['legacy','bounded-runtime-v1'].includes(row.mode)
   ||(row.mode==='legacy'?row.rule_set_sha256!==null:typeof row.rule_set_sha256!=='string'||!hash.test(row.rule_set_sha256)))invalid();
 }else if(row.version===2){
  if(keys!=='mode,rule_set_sha256,source_stamp,verification_policy,version'||row.mode!=='legacy'
   ||row.rule_set_sha256!==null||row.verification_policy!=='complete-claim-v1'
   ||typeof row.source_stamp!=='string'||!hash.test(row.source_stamp))invalid();
 }else invalid();
 return structuredClone(row) as unknown as ExtractionRuntimeConfig;
}
export function resolveExtractionPolicy(value:unknown,baseRuleVersion:string,sourceStamp?:string):ResolvedExtractionPolicy {
 const config=validateExtractionRuntimeConfig(value),mode=config?.mode??'legacy';
 if(config?.version===2){
  if(!hash.test(baseRuleVersion)||!sourceStamp||config.source_stamp!==sourceStamp)unavailable();
  const ruleVersion=digest({version:2,base_rule_version:baseRuleVersion,config});
  return {mode,verification:{id:'complete-claim-v1',rule_version:ruleVersion},ruleVersion,config};
 }
 return {mode,verification:{id:mode==='bounded-runtime-v1'?'nullable-proof-v3':'legacy-v4',rule_version:baseRuleVersion},ruleVersion:baseRuleVersion,config};
}

/** 同一判定供 A 缓存与 B 写入资格使用；窗口数字保留原 JSONB 精度表示。 */
export function assertExtractionPolicyWindow(policy:ResolvedExtractionPolicy,runtime:unknown,aRuleVersion?:string):void {
 const row=runtime&&typeof runtime==='object'&&!Array.isArray(runtime)?runtime as Record<string,unknown>:null;
 const v2=canonicalJSON(row?.config_version??null)==='2';
 if(policy.config?.version===2){
  if(!v2||row?.mode!=='legacy'||row.rule_set_sha256!==null
   ||row.verification_policy!==policy.config.verification_policy||row.source_stamp!==policy.config.source_stamp
   ||row.rule_version!==policy.ruleVersion||aRuleVersion!==undefined&&aRuleVersion!==policy.ruleVersion)
   throw new ExtractionPolicyVersionError('extraction_policy_window_mismatch');
 }else if(v2||row?.verification_policy==='complete-claim-v1')throw new ExtractionPolicyVersionError('extraction_policy_window_mismatch');
}

// 收集所有字面依赖（包括类型边和注释中的可疑相对边），宁可拒绝缺失文件，不静默遗漏。
// 不能解析的动态模块来源失败关闭；包版本另由 package/lock 原字节纳入身份。
const spacing=String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*`;
function dependencies(source:string):string[]{
 const result=new Set<string>();
 for(const pattern of [new RegExp(String.raw`\bfrom${spacing}['"]([^'"]+)['"]`,'g'),
  new RegExp(String.raw`\bimport${spacing}['"]([^'"]+)['"]`,'g'),
  new RegExp(String.raw`\bimport${spacing}\(${spacing}['"]([^'"]+)['"]`,'g')]){
  for(const match of source.matchAll(pattern))if(match[1]!.startsWith('.'))result.add(match[1]!);
 }
 for(const match of source.matchAll(new RegExp(String.raw`\bimport${spacing}\(`,'g'))){
  const rest=source.slice(match.index!+match[0].length).replace(new RegExp(`^${spacing}`),'');
  if(!new RegExp(String.raw`^(['"])([^'"]+)\1${spacing}(?=[,)])`).test(rest))unavailable();
 }
 return [...result];
}
export async function createExtractionPolicyVersion(options:{rootDirectory?:string;entrypoints?:readonly string[]}={}):Promise<ExtractionPolicyVersion>{
 const root=resolve(options.rootDirectory??resolve(dirname(fileURLToPath(import.meta.url)),'../..'));
 const entries=options.entrypoints??['memory/extraction/extraction-batch-service.ts','memory/extraction/deepseek-strict-verification.ts','memory/extraction/extraction-policy-version.ts'];
 const metadata=[resolve(root,'../package.json'),resolve(root,'../pnpm-lock.yaml')];
 async function capture():Promise<string>{
  const visited=new Set<string>(),files:{path:string;sha256:string}[]=[];
  async function visit(path:string):Promise<void>{
   path=resolve(path);
   if(!path.startsWith(root+sep)||relative(root,path).split(sep).some(part=>['test','tests','node_modules'].includes(part)))unavailable();
   if(visited.has(path))return;visited.add(path);
   let content:Buffer;
   try{content=await readFile(path);}catch{
    if(path.endsWith('.js')){visited.delete(path);return visit(path.slice(0,-3)+'.ts');}
    if(!extname(path)){visited.delete(path);return visit(path+'.ts');}
    return unavailable();
   }
   files.push({path:relative(root,path).split(sep).join('/'),sha256:createHash('sha256').update(content).digest('hex')});
   if(/\.(?:ts|js|mjs)$/.test(path))for(const dependency of dependencies(content.toString('utf8')))await visit(resolve(dirname(path),dependency));
  }
  for(const entry of entries)await visit(resolve(root,entry));
  for(const path of metadata){let content:Buffer;try{content=await readFile(path);}catch{return unavailable();}
   files.push({path:relative(root,path).split(sep).join('/'),sha256:createHash('sha256').update(content).digest('hex')});}
  return digest({version:1,files:files.sort((a,b)=>a.path.localeCompare(b.path,'en'))});
 }
 const sourceStamp=await capture();
 return Object.freeze({sourceStamp,ruleVersion:sourceStamp,
  newTaskConfig:()=>({version:2 as const,mode:'legacy' as const,rule_set_sha256:null,verification_policy:'complete-claim-v1' as const,source_stamp:sourceStamp}),
  resolve:(config:unknown)=>resolveExtractionPolicy(config,sourceStamp,sourceStamp),
  assertCurrent:async()=>{if(await capture()!==sourceStamp)unavailable();},
 });
}
