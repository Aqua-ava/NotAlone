/** CLI 只读 plan/preflight；执行只能由根在 API 中注入受控端口。 */
import assert from 'node:assert/strict';
import {prepareFormalPlan,timeQualification} from './plan.mjs';
import {FormalExecutor,hash} from './formal-executor.mjs';
const [mode='plan',...args]=process.argv.slice(2);
assert.ok(['plan','preflight'].includes(mode),'real_execution_cli_unavailable');
assert.ok(args.length===2&&args[0]==='--candidate-commit','explicit_full_candidate_commit_required');
const plan=await prepareFormalPlan({candidateCommit:args[1]});
if(mode==='plan')console.log(JSON.stringify({candidate_commit:plan.new_commit,old_commit:plan.old_commit,
  plan_sha256:hash(plan),nonreply_runs:plan.runs.length,unified_runs:1152,domains:plan.domains,
  formal_time_qualified:(await timeQualification(plan)).formal_time_qualified,real_model_calls:0}));
else try{await new FormalExecutor({plan}).preflight();}catch(error){console.log(JSON.stringify({ready:false,
  reason:String(error.message).split('\n')[0],real_model_calls:0,root_api_injection_required:true}));process.exitCode=2;}
