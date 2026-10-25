/** 最小缺口探针；只在独占归档内经正式业务合同与本机假供应商执行。 */
import './network-guard.mjs';
import assert from 'node:assert/strict';
import {writeFile,appendFile,mkdir,chmod,readFile,readdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadFrozenMaterials,createPlan,runPlan,assembleUnifiedReport,sha} from '../resumed-nonreply-evaluation/runner.mjs';
import {createOfflineAdapter} from './offline-adapter.mjs';
import {syntheticBudget} from './send-guard.mjs';
import {PIN} from './snapshot.mjs';
import {publicObservation} from './public-metadata.mjs';
const [directory,caseArgument]=process.argv.slice(2);assert.ok(directory,'private_directory_required');
const cases=JSON.parse(caseArgument??'["l2_scenario-11","l3_profile-11","skill_learning-11","skill_learning-10"]');
const plan=createPlan(await loadFrozenMaterials(),{newCommit:PIN});
const selection=plan.runs.filter(r=>cases.includes(r.case_id)&&r.repeat===1).map(r=>r.run_id);
assert.equal(selection.length,cases.length*2,'case_selection_invalid');
await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
const journal=join(directory,'observations.jsonl');await writeFile(journal,'',{mode:0o600,flag:'wx'});
const harness=join(directory,'harness-source');await mkdir(harness,{mode:0o700});const harnessFiles={};
for(const item of await readdir(new URL('./',import.meta.url),{withFileTypes:true}))if(item.isFile()&&/\.(?:mjs|py|ts)$/.test(item.name)){
  const bytes=await readFile(new URL(item.name,import.meta.url));harnessFiles[item.name]=sha(bytes.toString('utf8'));
  await writeFile(join(harness,item.name),bytes,{mode:0o600});
}
await writeFile(join(directory,'harness-source-manifest.json'),JSON.stringify(harnessFiles,null,2)+'\n',{mode:0o600});
const budget=syntheticBudget({limit:64,problemId:'synthetic-formal-gap-probes-both-arms'});
const adapter=await createOfflineAdapter({plan,directory,budget,permission:{assertAllowed:async()=>true}});
let observations;
try{observations=await runPlan(plan,{selectedRunIds:selection,execute:adapter.execute,
  onResult:row=>appendFile(journal,JSON.stringify(row)+'\n',{mode:0o600})});}
finally{await adapter.close();}
const publicRows=observations.map(publicObservation);
const report=assembleUnifiedReport({plan,observations:publicRows,feePolicy:'waived_temporarily_by_user'});
report.scope='minimal_synthetic_gap_probes_not_formal_matrix';report.synthetic_budget=budget.snapshot();
report.original_evidence={status:'preserved_read_only',previous_final_candidate:'a61a21407c9395c462e4e68bfeee4628e7e9b15c',
  previous_smoke_logical:24,previous_smoke_loopback_http:51,previous_unified_missing:1128,imported_as_current_pin_observations:0};
await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log('PROBE_RESULT '+JSON.stringify({status:'finished',population:report.population,hard_failures:report.nonreply.hard_failures,
  records:report.nonreply.records.filter(r=>r.terminal_status!=='not_run').map(r=>({case_id:r.case_id,arm:r.arm,status:r.terminal_status,
    physical_calls:r.physical_calls,error_code:r.error_code,events:r.events,checks:r.deterministic_checks})),real_model_calls:0}));
