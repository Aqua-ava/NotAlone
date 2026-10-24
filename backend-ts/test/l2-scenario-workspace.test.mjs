import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  L2ScenarioDocumentWorkspace,
  L2ScenarioVerificationError,
  runScenarioDocumentAgent,
  validateScenarioDocument,
  verifyScenarioProposal,
} from '../src/l2-scenario-workspace.ts';

const budget = {
  max_memories: 12,
  max_batch_memories: 6,
  max_scenarios: 4,
  max_paragraphs: 8,
  max_characters: 4_000,
  max_model_calls: 4,
};
const claim = {
  task_id: randomUUID(),
  step_id: randomUUID(),
  step_name: 'organize_memory',
  worker_id: randomUUID(),
  lease_generation: 1,
};
const binding = {
  provider: 'synthetic',
  model: 'synthetic-model',
  maxTokens: 512,
  temperature: 0,
  reasoningEffort: 'off',
};
const profile = {context_window_tokens: 32_000, safety_margin_tokens: 512};

function memory(text = '双方共同参加过合成课程') {
  const memoryId = randomUUID();
  return {
    memory_id: memoryId,
    revision: 1,
    text,
    category: 'common_fact',
    provenance_kind: 'source_supported',
    timing: {
      recorded_at: '2026-10-01T00:00:00+00:00',
      source_started_at: '2026-10-01T00:00:00+00:00',
      source_ended_at: '2026-10-01T00:00:00+00:00',
      source_time_complete: true,
      current_status: 'historical',
      current_status_reason: '合成历史来源',
    },
    event: null,
    conditions: null,
    evolution: null,
    valid_at: null,
    invalid_at: null,
    dependency_ids: [],
    dependency_manifest: {memory_id: memoryId, revision: 1, status: 'active', source_ids: []},
  };
}

function scenario(memoryInput) {
  const scenarioId = randomUUID();
  return {
    scenario_id: scenarioId,
    version_id: randomUUID(),
    title: '合成课程',
    hint: '共同经历与当前状态',
    paragraphs: [{
      text: '双方共同参加过课程；目前是否继续未核实。',
      references: [{
        memory_id: memoryInput.memory_id,
        revision: memoryInput.revision,
        provenance_kind: memoryInput.provenance_kind,
        timing: memoryInput.timing,
        event: null,
        conditions: null,
        evolution: null,
        valid_at: null,
        invalid_at: null,
      }],
    }],
    input_manifest: [memoryInput.dependency_manifest],
    dependency_ids: [memoryInput.memory_id],
  };
}

function markdown(topic, text, memoryInput) {
  return `<!-- META ${JSON.stringify({topic_key: topic, title: '合成课程', hint: '共同经历与当前状态'})} -->

${text}
<!-- SOURCES ${JSON.stringify([{memory_id: memoryInput.memory_id, revision: memoryInput.revision}])} -->`;
}

test('文档工具只暴露read/write/edit，且模型只能依赖内存暂存与来源引用',async()=>{
  const fact = memory(), workspace = new L2ScenarioDocumentWorkspace([fact], [], budget);
  assert.deepEqual(workspace.tools().map(tool => tool.name), ['read', 'write', 'edit']);
  assert.throws(() => workspace.write('../escape.md', markdown('course', fact.text, fact)), /path_forbidden/);
  let calls = 0;
  const port = {
    async call(input) {
      calls++;
      assert.deepEqual(input.tools.map(tool => tool.name), ['read', 'write', 'edit']);
      assert.match(input.system,/不得把表情、沉默、未回复或单次行为解释为情绪、态度、意图或关系信号/);
      assert.match(input.system,/旧主题中无法由来源逐字支持的解释必须删除，不因为曾发布而保留/);
      await input.requireCurrent();
      if (calls === 1) {
        return {blocks: [{type: 'tool-call', id: 'call-1', name: 'write',
          arguments: JSON.stringify({path: 'course.md', content: markdown('course', fact.text, fact)})}], receipt_id: randomUUID()};
      }
      return {blocks: [], receipt_id: randomUUID()};
    },
  };
  const result = await runScenarioDocumentAgent({
    workspace, port, claim, owner_id: randomUUID(), contact_id: randomUUID(), batch_id: randomUUID(),
    binding, profile, signal: new AbortController().signal, requireCurrent: async()=>{},
  });
  assert.equal(calls, 2);
  assert.equal(result.scenarios.length, 1);
  assert.equal(result.scenarios[0].paragraphs[0].text, fact.text);
  assert.equal(result.receipts.length, 2);
});

test('旧场景修改必须先读，保留身份并要求显式完整替换',async()=>{
  const fact = memory(), old = scenario(fact), workspace = new L2ScenarioDocumentWorkspace([fact], [old], budget);
  const path = `${old.scenario_id}.md`;
  assert.throws(() => workspace.edit(path, [{oldText: '目前是否继续未核实。', newText: '目前未再讨论。'}]),
    /read_required/);
  const content = workspace.read(path);
  assert.match(content, /SOURCES/);
  workspace.edit(path, [{oldText: '目前是否继续未核实。', newText: '目前状态仍未知。'}]);
  const compiled = workspace.compile();
  assert.equal(compiled[0].scenario_id, old.scenario_id);
  assert.deepEqual(compiled[0].replaces, [old.version_id]);
  assert.match(compiled[0].paragraphs[0].text, /状态仍未知/);
  assert.throws(() => validateScenarioDocument({scenarios: [{...compiled[0], scenario_id: randomUUID()}]},
    [fact], [old], budget), /proposal_invalid/);
});

test('已有场景写入也即时校验并返回可纠正的格式原因',()=>{
  const fact=memory(),old=scenario(fact),workspace=new L2ScenarioDocumentWorkspace([fact],[old],budget);
  const path=`${old.scenario_id}.md`;
  workspace.read(path);
  const invalid=`<!-- META ${JSON.stringify({
    topic_key:'continued-course',
    title:'合成课程',
    hint:'共同经历与当前状态',
  })} -->

正文缺少来源注释。`;
  const result=workspace.write(path,invalid);
  assert.match(result,/^工具错误：/);
  assert.match(result,/SOURCES/);
  assert.match(result,/尚未发布/);
});

test('两个已读旧主题可合并为一个显式替换的新版本',()=>{
  const left=memory('双方共同参加过合成课程。'),right=memory('双方后来共同整理课程笔记。');
  const leftOld=scenario(left),rightOld=scenario(right),workspace=new L2ScenarioDocumentWorkspace([left,right],[leftOld,rightOld],budget);
  const leftPath=`${leftOld.scenario_id}.md`,rightPath=`${rightOld.scenario_id}.md`;
  workspace.read(leftPath);
  workspace.read(rightPath);
  const content=`<!-- META ${JSON.stringify({
    topic_key:'merged-course',
    title:'合成课程合并记录',
    hint:'共同经历与后续整理',
    replaces:[leftOld.version_id,rightOld.version_id],
  })} -->

${left.text}
<!-- SOURCES ${JSON.stringify([{memory_id:left.memory_id,revision:left.revision}])} -->

${right.text}
<!-- SOURCES ${JSON.stringify([{memory_id:right.memory_id,revision:right.revision}])} -->`;
  assert.match(workspace.write('merged.md',content),/已暂存/);
  const compiled=workspace.compile();
  assert.equal(compiled.length,1);
  assert.equal(compiled[0].scenario_id,leftOld.scenario_id);
  assert.deepEqual(compiled[0].replaces,[leftOld.version_id,rightOld.version_id]);
  assert.equal(compiled[0].paragraphs.length,2);
});

test('独立核验拒绝非逐字引用和缺失段落，成功时才返回回执',async()=>{
  const fact = memory(), draft = validateScenarioDocument({scenarios: [{
    topic_key: 'course',
    title: '合成课程',
    hint: '共同经历与当前状态',
    replaces: [],
    paragraphs: [{text: fact.text, references: [{memory_id: fact.memory_id, revision: 1}]}],
  }]}, [fact], [], budget);
  const run = async quote => {
    const port = {async call(input) {
      await input.requireCurrent();
      return {blocks: [{type: 'tool-call', id: 'verify', name: 'ScenarioVerificationOutput',
        arguments: JSON.stringify({results: [{scenario_index: 0, paragraph_index: 0, supported: true,
          evidence: [{memory_id: fact.memory_id, quote}]}]})}], receipt_id: randomUUID()};
    }};
    return verifyScenarioProposal({
      scenarios: draft, memories: [fact], port, claim, owner_id: randomUUID(), contact_id: randomUUID(),
      batch_id: randomUUID(), binding, profile, signal: new AbortController().signal, requireCurrent: async()=>{},
    });
  };
  const accepted = await run(fact.text);
  assert.equal(accepted.receipts.length, 1);
  assert.equal(accepted.result.results.length, 1);
  const rejected = await run('合成模型改写过的引用').catch(error => error);
  assert.ok(rejected instanceof L2ScenarioVerificationError);
  assert.match(rejected.code, /quote_invalid/);
  assert.equal(rejected.verification.results[0].evidence[0].quote, '合成模型改写过的引用');
});
