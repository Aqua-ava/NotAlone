/** 默认只计划/拒绝未注入端口；不提供默认凭据或真实transport。 */
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isAbsolute,dirname,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {prepareFormalPlan} from '../nonreply-formal-model-seam/plan.mjs';
import {FullOrchestrator,reportFor,privateDirectory} from './orchestrator.mjs';
import {materialCoverage} from './router.mjs';
import {exportBlind} from './blind.mjs';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';

async function main(){
  const args=process.argv.slice(2),command=args.shift(),arg=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
  assert.ok(['plan','preflight','resume','pair','run','export-blind'].includes(command),'command_required');
  const plan=await prepareFormalPlan({candidateCommit:arg('candidate-commit')}),directory=arg('directory');
  if(command==='plan'){
    const coverage=materialCoverage(plan),summary={plan_sha256:sha(plan),population:reportFor(plan,[]).population,cases:coverage.length,coverage};
    if(arg('output')){assert.ok(isAbsolute(arg('output')),'private_output_absolute_required');await privateDirectory(dirname(arg('output')));await writeFile(arg('output'),JSON.stringify({plan,summary},null,2),{mode:0o600,flag:'wx'});}
    console.log(JSON.stringify({plan_sha256:sha(plan),population:summary.population,cases:coverage.length,executed:0}));return;
  }
  let ports,owner,orchestrator;
  try{
    if(arg('ports')){assert.ok(isAbsolute(arg('ports')),'root_ports_absolute_path_required');const module=await import(pathToFileURL(arg('ports')));assert.equal(typeof module.createPorts,'function','root_createPorts_export_required');
      owner=await module.createPorts({plan,directory});ports=owner.ports??owner;}
    orchestrator=new FullOrchestrator({plan,directory,ports});
    if(command==='preflight'){console.log(JSON.stringify(await orchestrator.preflight()));return;}
    await orchestrator.open();let report;
    if(command==='resume')report=await orchestrator.report();
    else if(command==='pair'){
      const pair=plan.runs.filter(r=>r.case_id===arg('case-id')&&r.repeat===Number(arg('repeat'))&&(!arg('domain')||r.domain===arg('domain')));
      assert.equal(pair.length,2,'one_pair_required');report=(await orchestrator.executePair(pair.map(r=>r.run_id),{resume:args.includes('--resume')})).report;
    }else if(command==='run'){
      const selected=arg('selection')?JSON.parse(await readFile(arg('selection'),'utf8')):undefined;
      report=await orchestrator.run({selectedRunIds:selected,resume:true});
    }else report=await orchestrator.report();
    let blind=null;if(command==='export-blind')blind=await exportBlind({plan,report,directory:arg('output'),projector:ports.blindProjector});
    if(arg('report'))await orchestrator.saveReport(arg('report'));
    console.log(JSON.stringify({schema_version:report.schema_version,new_commit:plan.new_commit,population:report.population,overall:report.overall,blind,tickets_25_26_approved:false}));
  }finally{await orchestrator?.close();await owner?.close?.();}
}
main().catch(error=>{const code=String(error.message).split('\n')[0];console.error(JSON.stringify({ready:false,error_code:/^[a-z][a-z0-9_:.-]+$/i.test(code)?code:'orchestration_failed',real_model_calls_by_default:0}));process.exitCode=2;});
