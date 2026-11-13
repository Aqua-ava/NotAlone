/** 新采集的资格门禁；只核实际wire与完成后的PG，不从候选回推输入。 */
import {createHash} from 'node:crypto';
import {auditReplyRuntimeSources} from '../../../backend-ts/src/reply-comparison-sources.ts';
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const fail=reason=>{throw Error('ticket25_normalize_invalid:'+reason);};
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b)=>canonical(a)===canonical(b);
export function verifyCapturedSources(capture,dataset){
 const binding=capture.source_bindings;
 if(capture.source_capture_version!=='production_v2_actual_wire_pg')fail('production_v2_capture_required');
 const old=binding?.old_profile,files=binding?.legacy_source_files;
 if(!old||!files||Object.keys(files).length<1||Object.values(files).some(value=>!isHash(value))||old.source_commit!==binding.old_commit||old.source_files_sha256!==hash(files)||binding.old_profile_sha256!==hash(old)||old.runner_sha256!==binding.evaluation_runtime_files?.['collector/old-arm.py']||old.primary_sha256!==binding.evaluation_runtime_files?.['collector/primary.json'])fail('legacy_source_or_profile_incomplete');
 if(!isHash(binding.profile_sha256)||!binding.executed_profile||hash(binding.executed_profile.raw_utf8)!==binding.profile_sha256)fail('executed_profile_missing');
 const collector=binding.collector_binding;
 const newFiles=Object.entries(binding.new_source_files??{}).filter(([name])=>name.startsWith('backend-ts/src/')||name.startsWith('backend-ts/profile/')||['backend-ts/package.json','backend-ts/pnpm-lock.yaml'].includes(name)).sort(([a],[b])=>a<b?-1:a>b?1:0);
 if(!collector||collector.source_commit!==binding.new_commit||!isHash(collector.argv_sha256)||collector.workspace_clean!==true||collector.source_tree_sha256!==hash(newFiles))fail('collector_source_tree_binding');
 const members=new Map(dataset.cases.map(member=>[member.case_id,member]));
 const prompts=[],tools=[];
 for(const row of capture.records){
  if(row.commit!==binding[row.arm+'_commit'])fail('record_source_commit');
  if(!Array.isArray(row.runtime_sources?.attempts)||row.runtime_sources.attempts.length!==row.physical_calls)fail('runtime_attempt_count');
  if(row.actual.status==='succeeded'&&!row.runtime_sources.attempts.length)fail('runtime_attempts_missing');
  for(const [index,attempt]of row.runtime_sources.attempts.entries()){
   if(attempt.request?.hash_kind!=='wire_utf8_sha256')fail('actual_wire_required');
   if(typeof attempt.request.raw_utf8!=='string'||hash(attempt.request.raw_utf8)!==attempt.request.sha256)fail('request_wire_hash');
   let parsed;try{parsed=JSON.parse(attempt.request.raw_utf8);}catch{fail('request_wire_json');}
   if(!same(parsed,attempt.request.body))fail('request_wire_body');
   const body=attempt.request.body,key=[row.case_id,row.repeat,row.arm,index];
   if(!Array.isArray(body.tools)||body.tools.length===0)fail('actual_tools_missing');
   const prompt=row.arm==='old'?body.messages: {system:body.system,messages:body.messages};
   if(!prompt||row.arm==='new'&&(typeof body.system!=='string'||!body.system))fail('actual_prompt_missing');
   prompts.push({key,sha256:hash(prompt)});tools.push({key,sha256:hash(body.tools)});
   if(row.actual.status!=='succeeded')continue;
   if(row.arm==='new'){
    const source=attempt.source_binding;
    if(attempt.catalog?.schema_version!=='reply-runtime-source-catalog-v2'||!Array.isArray(attempt.model_alias_mapping))fail('model_alias_mapping_required');
    for(const name of ['source_commit','source_tree_sha256','workspace_clean','argv_sha256'])if(source?.[name]!==collector[name])fail('attempt_source_binding');
   }else if(attempt.catalog?.schema_version!=='reply-runtime-source-catalog-v1'||attempt.source_binding?.source_commit!==binding.old_commit||attempt.source_binding.source_tree_sha256!==hash(files))fail('legacy_attempt_source_incomplete');
  }
  if(row.actual.status!=='succeeded')continue;
  const audit=auditReplyRuntimeSources(members.get(row.case_id),{...row,terminal_status:'succeeded'},row.output,'model_run');
  if(audit.status!=='verified')fail('source_audit_'+audit.reason);
 }
 const order=(a,b)=>canonical(a.key).localeCompare(canonical(b.key));prompts.sort(order);tools.sort(order);
 return {schema_version:'reply-model-surface-hashes-v1',basis:'actual_wire_per_attempt',prompt_hash:hash(prompts),tool_schema_hash:hash(tools),prompts,tools,profile_hashes:{old:binding.old_profile_sha256,new:binding.profile_sha256}};
}
