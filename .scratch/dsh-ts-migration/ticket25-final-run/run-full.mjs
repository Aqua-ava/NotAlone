/** 固定16例×3重复×双臂入口：只消费既有问题预算，不创建、不退款、不重试。 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {collectLocal} from './runner.mjs';
import {problemBudgetBridge} from './bridge.mjs';
import {freezeExecutionPolicy} from './execution-snapshot.mjs';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function runFixed96({sourceCommit,output,configPath,executionPolicyPath,localOnly=false}){
 assert.match(sourceCommit,/^[a-f0-9]{40}$/,'完整源码commit必填');
 assert.ok(output&&resolve(output)===output,'输出必须是新建绝对路径');
 assert.ok(!output.startsWith(ROOT)&&output!==resolve(ROOT),'原始采集必须存仓库外私有目录');
 const executionPolicy=executionPolicyPath?freezeExecutionPolicy(JSON.parse(await readFile(executionPolicyPath,'utf8')),await readFile(new URL('./primary.json',import.meta.url))):undefined;
 let budget,forwarder,initial,vendorForwardFactory;
 if(localOnly){assert.equal(configPath,undefined,'本机路径不能读取真实预算配置');}
 else{
  assert.ok(configPath,'真实路径必须明确给出既有私有预算配置');
  const config=JSON.parse(await readFile(configPath,'utf8'));
  assert.equal(config.source_commit,sourceCommit,'预算配置必须固定已经审查的源码');
  budget={python:join(homedir(),'miniconda3/envs/NotAlone/bin/python'),moduleRoot:join(ROOT,'backend/src'),repositoryRoot:ROOT,budget:{ledger:config.ledger,problem_id:config.problem_id,round:config.round}};
  initial=await problemBudgetBridge(budget,'ack');
  assert.ok(initial.max_reservations-initial.used_reservations>=96,'problem_budget_insufficient_for_fixed_96');
  const {takeCredential}=await import('./vendor-forward.mjs');
  const key=takeCredential(),priceSnapshot=config.price_snapshot?{...config.price_snapshot,sha256:config.price_snapshot.source_page_sha256}:null;
  vendorForwardFactory=async({collectorRoot})=>{
   const {createVendorForwarder}=await import(pathToFileURL(join(collectorRoot,'vendor-forward.mjs')));
   forwarder=createVendorForwarder({key,initialReceipt:initial,acknowledge:()=>problemBudgetBridge(budget,'ack'),priceSnapshot});return forwarder.forward;
  };
 }
 await mkdir(output,{recursive:false,mode:0o700});
 const records=[];let capture,error;
 try{
  capture=await collectLocal({sourceCommit,full:true,localOnly,executionPolicy,...localOnly?{}:{problemBudget:budget,vendorForwardFactory},onRecord:async row=>{
   records.push(row);await writeFile(join(output,String(records.length).padStart(2,'0')+'-'+row.case_id+'-'+row.arm+'-'+row.repeat+'.json'),JSON.stringify(row)+'\n',{flag:'wx',mode:0o600});
  }});
 }catch(cause){error=cause;}
 finally{forwarder?.close(error?'collector_rejected':'fixed_96_complete');}
 const final=localOnly?null:await problemBudgetBridge(budget,'ack');
 if(capture)await writeFile(join(output,'capture.raw-96.json'),JSON.stringify(capture)+'\n',{flag:'wx',mode:0o600});
 const summary={schema_version:'ticket25-production-v2-runner-v1',source_commit:sourceCommit,local_only:localOnly,fixed_denominator:96,automatic_retries:0,received:records.length,successes:records.filter(row=>row.actual.status==='succeeded').length,physical_calls:records.reduce((n,row)=>n+row.physical_calls,0),used_delta:final?final.used_reservations-initial.used_reservations:null,ledger_created:false,capture_sha256:capture?sha(JSON.stringify(capture)+'\n'):null,error:error?.message??null,real_model_quality_verified:false,production_switch_approved:false,...executionPolicy?{cost_status:executionPolicy.cost_status,output_status:executionPolicy.output_status,max_output_tokens:executionPolicy.controls.max_output_tokens,execution_policy_sha256:capture?.execution_policy_sha256??null}:{}};
 await writeFile(join(output,'runner-summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
 if(error)throw error;
 assert.equal(records.length,96,'固定分母不能减小');
 return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--local-only'){options.localOnly=true;continue;}
  const name={'--source-commit':'sourceCommit','--output':'output','--config':'configPath','--execution-policy':'executionPolicyPath'}[args[i]];
  if(!name||!args[i+1]||options[name])throw Error('runner_arguments');options[name]=args[++i];
 }
 runFixed96(options).then(summary=>process.stdout.write(JSON.stringify(summary)+'\n')).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}
