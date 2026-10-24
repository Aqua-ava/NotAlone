import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  L3ProfileWorkspace,
  filterProfileProposal,
  renderProfile,
  runProfileDocumentAgent,
  validateIncrementalProfile,
  validateProfile,
  verifyProfileProposal,
} from '../src/l3-profile-workspace.ts';

const memory = {
  memory_id: randomUUID(),
  revision: 1,
  level: 'contact',
  text: '双方在二〇二四年参加过合成课程。',
  category: 'common_fact',
  provenance_kind: 'manual_entry',
  timing: {current_status: 'historical'},
  event: null,
  conditions: null,
  evolution: null,
  valid_at: null,
  invalid_at: null,
  dependency_ids: [],
  message_ids: [],
  dependency_manifest: {memory_id: '', revision: 1},
};
memory.dependency_manifest = {memory_id: memory.memory_id, revision: memory.revision, text: memory.text};
const scenario = {
  scenario_id: randomUUID(),
  version_id: randomUUID(),
  title: '合成课程',
  hint: '共同经历',
  paragraphs: [{text: memory.text, references: [{
    memory_id: memory.memory_id,
    revision: memory.revision,
    provenance_kind: 'manual_entry',
    timing: memory.timing,
    event: null,
    conditions: null,
    evolution: null,
    valid_at: null,
    invalid_at: null,
  }]}],
  input_manifest: [memory.dependency_manifest],
  dependency_ids: [memory.memory_id],
};
const budget = {
  max_memories: 20,
  max_batch_memories: 20,
  max_scenarios: 15,
  max_paragraphs: 40,
  max_characters: 128_000,
  max_model_calls: 8,
};
const entry = {
  text: '双方有二〇二四年的共同课程经历。',
  kind: 'fact',
  section: 'life_context',
  basis: '原记忆直接记载双方参加课程。',
  temporal_status: 'historical',
  uncertainty: '',
  references: [{memory_id: memory.memory_id, revision: 1}],
};

test('L3画像校验保留事实、推断、时间、不确定性和真实底层版本', () => {
  const checked = validateProfile({entries: [entry, {
    text: '双方可能对学习主题有兴趣，长期性尚未确认。',
    kind: 'inference',
    section: 'interests',
    basis: '共同课程只能提供兴趣线索。',
    temporal_status: 'uncertain',
    uncertainty: '仅一次共同课程，不能确认稳定偏好。',
    references: [{memory_id: memory.memory_id, revision: 1}],
  }]}, [memory], budget);
  assert.equal(checked.entries.length, 2);
  assert.equal(checked.entries[1].kind, 'inference');
  assert.equal(checked.entries[1].references[0].revision, 1);
  assert.throws(() => validateProfile({entries: [{...entry, kind: 'inference', section: 'interests', temporal_status: 'stable'}]}, [memory], budget),
    /inference|uncertain/i);
  assert.throws(() => validateProfile({entries: [{...entry, references: [{memory_id: memory.memory_id, revision: 2}]}]}, [memory], budget),
    /reference/i);
});

test('L3画像拒绝行动建议，不把一次性策略写成人物资料', () => {
  assert.throws(() => validateProfile({entries: [{
    ...entry,
    text: '下次应该先安慰对方，再替对方决定见面安排。',
  }]}, [memory], budget), /action|建议|策略/i);
});

test('L3画像文档工具为常见 schema 字段错误返回可区分且可纠正的工具结果', () => {
  const cases = [
    {
      name:'section',
      value:{...entry, section:'communication'},
      code:'l3_profile_section_invalid',
      detail:/section|basic_information|life_context/i,
    },
    {
      name:'kind',
      value:{...entry, kind:'observation'},
      code:'l3_profile_kind_invalid',
      detail:/kind|fact|preference|inference|contradiction/i,
    },
    {
      name:'temporal_status',
      value:{...entry, temporal_status:'current'},
      code:'l3_profile_temporal_status_invalid',
      detail:/temporal_status|stable|historical|uncertain/i,
    },
    {
      name:'unexpected_keys',
      value:{...entry, confidence:0.8},
      code:'l3_profile_unexpected_keys',
      detail:/confidence|unexpected|允许字段/i,
    },
    {
      name:'reference',
      value:{...entry, references:[{memory_id:memory.memory_id, revision:2}]},
      code:'l3_profile_reference_invalid',
      detail:/reference|引用|revision/i,
    },
  ];
  for (const item of cases) {
    const workspace = new L3ProfileWorkspace(null, [scenario], [memory], budget);
    const result = workspace.write(
      'profile.md',
      `# 长期背景\n\n<!-- ENTRY ${JSON.stringify(item.value)} -->\n${item.value.text}`,
    );
    assert.match(result, new RegExp(item.code), item.name);
    assert.match(result, item.detail, item.name);
  }
});

test('L3画像文档工具区分标题、自由格式与ENTRY元数据错误', () => {
  const cases = [
    {
      name:'header',
      content:'# 错误标题\n',
      code:'l3_profile_document_header_invalid',
    },
    {
      name:'free_format',
      content:'# 长期背景\n\n## 生活背景\n没有ENTRY元数据。',
      code:'l3_profile_document_format_invalid',
    },
    {
      name:'entry_format',
      content:'# 长期背景\n\n<!-- ENTRY {"kind":"fact"} -->',
      code:'l3_profile_entry_format_invalid',
    },
    {
      name:'entry_metadata',
      content:'# 长期背景\n\n<!-- ENTRY {not-json} -->\n正文',
      code:'l3_profile_entry_metadata_invalid',
    },
  ];
  for (const item of cases) {
    const workspace = new L3ProfileWorkspace(null, [scenario], [memory], budget);
    const result = workspace.write('profile.md', item.content);
    assert.match(result, new RegExp(item.code), item.name);
    assert.match(result, /ENTRY|长期背景|JSON|正文/, item.name);
  }
});

test('L3画像纠错正文逐项隔离，合法新条目仍可核验发布', () => {
  const rejected = '双方一定长期喜欢课程。';
  const filtered = filterProfileProposal({entries: [
    {...entry, text:rejected},
    {
      ...entry,
      text:'双方可能对课程有兴趣，长期性尚未确认。',
      kind:'inference',
      section:'interests',
      temporal_status:'uncertain',
      uncertainty:'共同课程只能提供兴趣线索。',
    },
  ]}, [memory], budget, new Set([rejected]));
  assert.deepEqual(filtered.entries.map(item => item.text), ['双方可能对课程有兴趣，长期性尚未确认。']);
  assert.equal(filtered.rejected.length, 1);
  assert.equal(filtered.rejected[0].index, 0);
});

test('L3文档工具只能读取场景并写profile.md，增量不得丢弃未变化旧条目', () => {
  const existing = {version_id: randomUUID(), entries: [entry]};
  const workspace = new L3ProfileWorkspace(existing, [scenario], [memory], budget);
  assert.match(workspace.read(`${scenario.scenario_id}.md`), /SOURCES/);
  assert.throws(() => workspace.read('../profile.md'), /path|文件/i);
  assert.match(workspace.write('profile.md', renderProfile({entries: [entry]})), /暂存/);
  assert.throws(() => workspace.write(`${scenario.scenario_id}.md`, '篡改场景'), /profile\.md|写入/i);
  const compiled = workspace.compile().entries[0];
  assert.equal(compiled.text, entry.text);
  assert.equal(compiled.kind, entry.kind);
  assert.equal(compiled.references[0].memory_id, memory.memory_id);
  assert.throws(() => validateIncrementalProfile({entries: []}, existing, [{
    ...scenario,
    paragraphs: [{text: '另一个合成主题。', references: [{
      ...scenario.paragraphs[0].references[0],
      memory_id: randomUUID(),
      revision: 1,
    }]}],
  }], [memory]), /遗漏|旧条目/i);
});

test('L3核验输入超预算时在物理调用前拒绝', async () => {
  const port = {calls:0, async call(){this.calls++;throw new Error('must_not_call_model');}};
  await assert.rejects(verifyProfileProposal({
    entries:[entry],
    memories:[memory],
    scenarios:[scenario],
    budget:{...budget,max_characters:16},
    port,
    claim:{
      task_id:randomUUID(),
      step_id:randomUUID(),
      step_name:'organize_memory',
      worker_id:randomUUID(),
      lease_generation:1,
    },
    owner_id:randomUUID(),
    contact_id:randomUUID(),
    batch_id:randomUUID(),
    binding:{provider:'synthetic-provider',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:32_000,safety_margin_tokens:512},
    signal:new AbortController().signal,
    async requireCurrent(){},
    corrections:[],
    remainingCalls:1,
  }), /context_budget/);
  assert.equal(port.calls, 0);
});

test('L3多轮提案压缩已执行工具历史，不以旧写入参数耗尽下一轮预算', async () => {
  const constrained = {...budget, max_characters:6_000};
  const workspace = new L3ProfileWorkspace(null, [scenario], [memory], constrained);
  let calls = 0, compacted;
  const port = {async call(input) {
    calls++;
    if (calls < 5) {
      return {
        blocks:[{
          type:'tool-call',
          id:`profile-round-${calls}`,
          name:'write',
          arguments:JSON.stringify({
            path:'profile.md',
            content:renderProfile({entries:[{
              ...entry,
              text:`第${calls}轮合成课程背景。`,
              basis:`第${calls}轮依据。${'合成依据'.repeat(70)}`,
            }]}),
          }),
        }],
        receipt_id:randomUUID(),
      };
    }
    for (const message of input.messages) {
      const text = message.content.find(block => block.type === 'text')?.text;
      if (!text) continue;
      try {
        const payload = JSON.parse(text);
        if (payload.history_compacted) compacted = payload;
      } catch {}
    }
    return {blocks:[],receipt_id:randomUUID()};
  }};
  const result = await runProfileDocumentAgent({
    workspace,
    existing:null,
    scenarios:[scenario],
    memories:[memory],
    changedScenarios:[scenario],
    removedScenarioVersionIds:[],
    baseProfileVersionId:null,
    corrections:[],
    port,
    claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'organize_memory',worker_id:randomUUID(),lease_generation:1},
    owner_id:randomUUID(),
    contact_id:randomUUID(),
    batch_id:randomUUID(),
    binding:{provider:'synthetic-provider',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:32_000,safety_margin_tokens:512},
    signal:new AbortController().signal,
    requireCurrent:async()=>{},
    remainingCalls:6,
  });
  assert.equal(calls, 5);
  assert.match(result.proposal.entries[0].text, /第4轮/);
  assert.equal(compacted.history_compacted, true);
  assert.equal(compacted.completed_tool_calls[0].name, 'write');
  assert.match(compacted.current_profile_markdown, /第[1-4]轮合成课程背景/);
  assert.doesNotMatch(JSON.stringify(compacted), /profile-round-/);
});

test('L3多轮提案保留跨轮成功写入，末轮只读确认仍可提交', async () => {
  const workspace = new L3ProfileWorkspace(null, [scenario], [memory], budget);
  let calls = 0;
  const port = {async call() {
    calls++;
    return {
      blocks:[calls === 1 ? {
        type:'tool-call',
        id:'profile-write',
        name:'write',
        arguments:JSON.stringify({
          path:'profile.md',
          content:renderProfile({entries:[entry]}),
        }),
      } : {
        type:'tool-call',
        id:`profile-read-${calls}`,
        name:'read',
        arguments:JSON.stringify({path:'profile.md'}),
      }],
      receipt_id:randomUUID(),
    };
  }};
  const result = await runProfileDocumentAgent({
    workspace,
    existing:null,
    scenarios:[scenario],
    memories:[memory],
    changedScenarios:[scenario],
    removedScenarioVersionIds:[],
    baseProfileVersionId:null,
    corrections:[],
    port,
    claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'organize_memory',worker_id:randomUUID(),lease_generation:1},
    owner_id:randomUUID(),
    contact_id:randomUUID(),
    batch_id:randomUUID(),
    binding:{provider:'synthetic-provider',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:32_000,safety_margin_tokens:512},
    signal:new AbortController().signal,
    requireCurrent:async()=>{},
    remainingCalls:6,
  });
  assert.equal(calls, 5);
  assert.equal(result.calls, 5);
  assert.equal(result.proposal.entries[0].text, entry.text);
});

test('L3多轮提案末轮工具错误不会被此前的成功写入掩盖', async () => {
  const workspace = new L3ProfileWorkspace(null, [scenario], [memory], budget);
  let calls = 0;
  const port = {async call() {
    calls++;
    return {
      blocks:[{
        type:'tool-call',
        id:`profile-error-${calls}`,
        name:calls === 1 ? 'write' : 'read',
        arguments:JSON.stringify(calls === 1 ? {
          path:'profile.md',
          content:renderProfile({entries:[entry]}),
        } : {
          path:calls === 5 ? '../profile.md' : 'profile.md',
        }),
      }],
      receipt_id:randomUUID(),
    };
  }};
  await assert.rejects(runProfileDocumentAgent({
    workspace,
    existing:null,
    scenarios:[scenario],
    memories:[memory],
    changedScenarios:[scenario],
    removedScenarioVersionIds:[],
    baseProfileVersionId:null,
    corrections:[],
    port,
    claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'organize_memory',worker_id:randomUUID(),lease_generation:1},
    owner_id:randomUUID(),
    contact_id:randomUUID(),
    batch_id:randomUUID(),
    binding:{provider:'synthetic-provider',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:32_000,safety_margin_tokens:512},
    signal:new AbortController().signal,
    requireCurrent:async()=>{},
    remainingCalls:6,
  }), /round_limit/);
  assert.equal(calls, 5);
});

test('L3画像在错误写入后成功修正，并在五轮内通过显式完成工具收敛', async () => {
  const workspace = new L3ProfileWorkspace(null, [scenario], [memory], budget);
  let calls = 0, completeAdvertised = false;
  const port = {async call(input) {
    calls++;
    const tool = (name,args) => ({
      blocks:[{type:'tool-call',id:`profile-converge-${calls}`,name,arguments:JSON.stringify(args)}],
      receipt_id:randomUUID(),
    });
    if (calls === 1) return tool('read', {path:'profile.md'});
    if (calls === 2) return tool('write', {
      path:'profile.md',
      content:'# 长期背景\n\n## 生活背景\n正文没有逐条ENTRY元数据。',
    });
    if (calls === 3) return tool('write', {
      path:'profile.md',
      content:renderProfile({entries:[entry]}),
    });
    if (calls === 4) return tool('read', {path:`${scenario.scenario_id}.md`});
    if (calls === 5) {
      completeAdvertised = input.tools.some(item => item.name === 'ProfileProposalComplete');
      return tool('ProfileProposalComplete', {});
    }
    throw new Error('unexpected_profile_convergence_call');
  }};
  const result = await runProfileDocumentAgent({
    workspace,
    existing:null,
    scenarios:[scenario],
    memories:[memory],
    changedScenarios:[scenario],
    removedScenarioVersionIds:[],
    baseProfileVersionId:null,
    corrections:[],
    port,
    claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:'organize_memory',worker_id:randomUUID(),lease_generation:1},
    owner_id:randomUUID(),
    contact_id:randomUUID(),
    batch_id:randomUUID(),
    binding:{provider:'synthetic-provider',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:32_000,safety_margin_tokens:512},
    signal:new AbortController().signal,
    requireCurrent:async()=>{},
    remainingCalls:6,
  });
  assert.equal(calls, 5);
  assert.equal(result.calls, 5);
  assert.equal(completeAdvertised, true);
  assert.equal(result.proposal.entries[0].text, entry.text);
});
