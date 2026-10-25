/** 完整冻结计划；不执行业务、不建立预算、不构造供应商传输。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadFrozenMaterials,createPlan,BASELINE} from '../resumed-nonreply-evaluation/runner.mjs';
import {hash} from './formal-executor.mjs';
const execute=promisify(execFile),root=fileURLToPath(new URL('../../../',import.meta.url));
export async function prepareFormalPlan({candidateCommit}){
  assert.match(candidateCommit??'',/^[a-f0-9]{40}$/,'full_candidate_commit_required');
  assert.equal((await execute('git',['rev-parse',candidateCommit+'^{commit}'],{cwd:root})).stdout.trim(),candidateCommit);
  return createPlan(await loadFrozenMaterials(),{newCommit:candidateCommit});
}
export async function timeQualification(plan){
  const builder=(await execute('git',['show',BASELINE+':backend/src/notalone/memory_extraction/evaluation.py'],{cwd:root,maxBuffer:2*1024*1024})).stdout;
  const window=builder.slice(builder.indexOf('def build_window('),builder.indexOf('\n\n@dataclass',builder.indexOf('def build_window(')));
  assert.match(window,/base = datetime\(2026, 9, 15, tzinfo=timezone.utc\)/,'original_message_anchor_changed');
  assert.match(window,/occurred_at=base \+ timedelta\(minutes=index\)/,'original_message_order_changed');
  const cases=[...new Map(plan.runs.map(r=>[r.case_id,r])).values()];
  const inputTimes=[...new Set(cases.filter(r=>r.material.input).map(r=>r.material.input.as_of))];
  const paths=['backend-ts/src/skill-learning-store.ts','backend-ts/src/skill-learning-runtime.ts','backend-ts/src/host-reply.ts'];
  const sources={};for(const path of paths)sources[path]=hash((await execute('git',['show',plan.new_commit+':'+path],{cwd:root,maxBuffer:4*1024*1024})).stdout);
  return {schema_version:'nonreply-time-qualification-v1',candidate_commit:plan.new_commit,old_commit:BASELINE,
    extraction:{cases:140,material_has_as_of:false,original_builder:{path:'backend/src/notalone/memory_extraction/evaluation.py',sha256:hash(builder),lines:'82–101'},
      message_time:{anchor:'2026-09-15T00:00:00.000Z',increment:'每条消息按序号增加一分钟',status:'matches_frozen_original_builder'},
      event_time:{source:'仅沿原文及原oracle，不由消息时刻或系统now补造'},evaluation_as_of:'unknown',
      qualification:'not_approved_pending_root_experimental_context_and_independent_semantics'},
    l2_l3:{as_of_values:inputTimes,public_seam:'createL2ScenarioHost({now}) / 旧PostgresLayeredMemoryStore(clock)',
      source_and_event_times_distinct:true,integrated_driver_in_this_directory:'not_implemented'},
    skill:{source_observation_times:'保留冻结observed_at',public_evaluation_clock:'absent',
      qualification:'not_approved_no_independent_public_clock_boundary',candidate_sources:sources,
      proposed_root_decision:'明确将as_of限定为实验观察截点并由独立审阅确认；若要求实际统一学习时钟，根另决定只作用于内容捕获的clock参数，不改租约/额度/PG now'},
    operational_clock:{budget_deadline:'实际壁钟毫秒',leases:'实际PG时间及租约代次',global_Date_mocked:false,pg_now_mocked:false},
    formal_time_qualified:false,oracle_modified:false};
}
