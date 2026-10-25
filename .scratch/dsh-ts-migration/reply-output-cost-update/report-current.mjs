/** 显式本轮报告入口；不执行模型、不读取预算，不修改输入或历史报告。 */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildReplyComparisonReport} from '../../../backend-ts/src/reply-comparison.ts';
import {freezeExecutionPolicy} from '../ticket25-final-run/execution-snapshot.mjs';
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
const sha=value=>createHash('sha256').update(value).digest('hex');
export async function reportCurrent({manifest,dataset,run:runPath,executionPolicy:policyPath,output}){
 const paths=[manifest,dataset,runPath,policyPath];assert.ok(paths.every(path=>typeof path==='string'&&path),'explicit_report_paths_required');
 assert.ok(output&&!paths.map(path=>resolve(path)).includes(resolve(output)),'report_overwrites_input');
 const [manifestText,datasetText,runText,policyText,primary,scope]=await Promise.all([...paths.map(path=>readFile(path,'utf8')),readFile(new URL('../ticket25-final-run/primary.json',import.meta.url)),readFile(new URL('./scope-snapshot.md',import.meta.url))]);
 const policy=freezeExecutionPolicy(JSON.parse(policyText),primary),run=JSON.parse(runText),policySha=sha(canonical(policy));
 assert.equal(sha(scope),policy.scope_sha256,'explicit_scope_snapshot_binding');
 assert.equal(canonical(run.execution_policy),canonical(policy),'normalized_execution_policy_binding');
 assert.equal(run.execution_policy_sha256,policySha,'normalized_execution_policy_digest');
 assert.equal(run.configuration.execution_policy_sha256,policySha,'normalized_configuration_policy_binding');
 assert.equal(run.configuration.max_output_tokens,policy.controls.max_output_tokens,'normalized_output_control_binding');
 const report=buildReplyComparisonReport(manifestText,datasetText,run,{costWaiver:{status:policy.cost_status,scope_ref:policy.scope_ref,scope_sha256:policy.scope_sha256}});
 const result={...report,execution_policy_sha256:policySha,output_status:policy.output_status};
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),names={'--manifest':'manifest','--dataset':'dataset','--run':'run','--execution-policy':'executionPolicy','--output':'output'},options={};
 for(let i=0;i<args.length;i+=2){const key=names[args[i]];assert.ok(key&&args[i+1]&&options[key]===undefined,'report_arguments');options[key]=args[i+1];}
 reportCurrent(options).then(report=>{process.stdout.write(JSON.stringify({status:report.overall.status,cost_status:report.cost_status,output_status:report.output_status,planned:report.population.planned})+'\n');process.exitCode=report.overall.status==='passed'?0:2;}).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}
