/** 合成画像的本地核验基准；不访问数据库或模型，前后对照使用相同参数。 */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {selectProfilePublication, validateIncrementalProfile} from '../src/memory/profiles/document.ts';
import {DEFAULT_L2_SCENARIO_BUDGET} from '../src/memory/scenarios/document.ts';

const iterations = Number(process.argv[2] ?? 500), samples = 7;
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const id = index => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function fixture(size) {
  const memories = Array.from({length:size}, (_, index) => ({
    memory_id:id(index + 1), revision:1, level:'contact', text:`合成记忆内容${index}。`,
    category:'common_fact', provenance_kind:'manual_entry', timing:{}, event:null,
    conditions:null, evolution:null, valid_at:null, invalid_at:null,
    dependency_ids:[], message_ids:[], dependency_manifest:{},
  }));
  const entries = memories.map((memory, index) => ({
    text:`合成长期背景${index}。`, kind:'fact', section:'life_context', basis:'来自合成记忆。',
    temporal_status:'stable', uncertainty:'',
    references:[memory, memories[(index + 1) % size]].map(({memory_id, revision}) => ({memory_id, revision})),
  }));
  return {memories, proposal:{entries}, existing:{version_id:id(100), entries},
    verification:{results:memories.map((memory, entry_index) => ({
      entry_index, supported:true, evidence:[{memory_id:memory.memory_id, quote:memory.text}],
    }))}};
}
function measure(run) {
  for (let index = 0; index < 100; index++) run();
  const times = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) run();
    times.push((performance.now() - start) * 1_000 / iterations);
  }
  times.sort((left, right) => left - right);
  return {medianUs:times[Math.floor(samples / 2)], minUs:times[0], maxUs:times.at(-1)};
}
const results = [];
for (const entries of [4, 8, 16]) {
  const f = fixture(entries);
  const publication = () => selectProfilePublication(f.proposal, f.verification,
    f.memories, DEFAULT_L2_SCENARIO_BUDGET, f.existing, []);
  const selected = publication();
  assert.equal(selected.accepted.length, entries);
  assert.deepEqual(selected.rejected, []);
  assert.deepEqual(selected.retained, []);
  results.push({entries,
    incremental:measure(() => validateIncrementalProfile(f.proposal, f.existing, [])),
    publication:measure(publication)});
}
console.log(JSON.stringify({node:process.version, iterations, samples, unit:'微秒/次',
  workload:'旧画像全部原样保留，每条引用两个合成记忆版本', results}, null, 2));
