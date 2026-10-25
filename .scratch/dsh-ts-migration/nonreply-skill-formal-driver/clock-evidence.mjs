/** 只查固定公共签名、原来源时间及SDK运行时间；不创造学习clock参数。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {PIN,LEGACY,REPO,sha} from './snapshot.mjs';
const execute=promisify(execFile);
const requests=[
  [LEGACY,'backend/src/notalone/persistence/skill_learning.py',['def capture(','def validate(','def save(']],
  [LEGACY,'backend/src/notalone/persistence/skill_learning_materials.py',['def select_learning_batch(','24 hours']],
  [LEGACY,'backend/src/notalone/skills/learning_runtime.py',['def propose(','datetime.now(']],
  [PIN,'backend-ts/src/skill-learning-store.ts',['interface SkillLearningStoreOptions','async capture(','async validate(','async save(']],
  [PIN,'backend-ts/src/skill-learning-materials.ts',['function selectLearningBatch(','24 hours']],
  [PIN,'backend-ts/src/skill-learning-runtime.ts',['interface SkillLearningRuntimeOptions','async propose(']],
  [PIN,'backend-ts/src/host-reply.ts',['new SkillLearningStore(','new SkillLearningRuntime(']],
];
const sources=[];
for(const [commit,path,terms] of requests){
  const bytes=(await execute('git',['show',commit+':'+path],{cwd:REPO,maxBuffer:1024*1024})).stdout;
  sources.push({commit,path,sha256:sha(bytes),boundaries:terms.flatMap(term=>bytes.split('\n').flatMap((line,index)=>line.includes(term)?[{line:index+1,signature:line.trim()}]:[]))});
}
const bytes=(await execute('git',['show',PIN+':.scratch/dsh-ts-migration/baseline/organization-learning-cases.json'],{cwd:REPO})).stdout;
const frozen=JSON.parse(bytes).cases.filter(c=>c.domain==='skill_learning');assert.equal(frozen.length,12);
const result={schema_version:'skill-public-clock-source-v1',old_commit:LEGACY,candidate_commit:PIN,sources,
  frozen_input_sha256:sha(bytes),frozen_as_of_values:[...new Set(frozen.map(c=>c.input.as_of))],
  frozen_observed_at_values:[...new Set(frozen.flatMap(c=>c.input.sources.map(s=>s.observed_at)))],
  evaluation_as_of_applied:false,public_learning_clock_parameter:'absent_in_both_public_capture_and_propose_signatures',
  source_time_policy:'消息和assistant_session_input沿冻结observed_at保存；不改原文或oracle。',
  actual_time_policy:'PG租约/确认/草稿created_at和SDK调用时间使用实际系统及PG时钟；成功报告另有actual_wall_started_at/actual_pg_observed_at/draft_persisted_at。',
  source_relative_followup_window:'24小时规则比较message.occurred_at与turn.created_at，不是实验as_of。',
  global_Date_mocked:false,pg_now_mocked:false,formal_time_qualified:false,
  unknown_reason:'冻结input.as_of没有可注入的公开学习clock；本驱动仅记录观察截点，不能证明两臂在统一学习时钟下正式等价。'};
await writeFile(new URL('./clock-evidence.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sources:sources.length,public_learning_clock:'absent',formal_time_qualified:false}));
