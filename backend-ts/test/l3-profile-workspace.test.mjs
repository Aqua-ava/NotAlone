import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {
  L3ProfileWorkspace,
  runProfileDocumentAgent,
  verifyProfileProposal,
} from '../src/memory/profiles/workspace.ts';
import {
  filterProfileProposal,
  renderProfile,
  validateIncrementalProfile,
  validateProfile,
} from '../src/memory/profiles/document.ts';

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

test('L3事实正文与依据中的联系人名词不会被当成联系行动',()=>{
 const text='合成车票的版式应该相同，联系人的票根标注甲区。';
 for(const field of ['text','basis']){
  const checked=validateProfile({entries:[{...entry,[field]:text}]},[{...memory,text}],budget);
  assert.equal(checked.entries[0][field],text);
 }
});

test('L3正文与依据中的真实联系、回复建议仍被拒绝',()=>{
 for(const text of ['以后应该联系对方核对合成行程。','建议联系合成组织者，并回复确认。','下次应该联系人事部门。','建议联系人员核对。'])for(const field of ['text','basis']){
  assert.throws(()=>validateProfile({entries:[{...entry,[field]:text}]},[memory],budget),/l3_profile_action_guidance/);
 }
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

test('画像工具保留场景只读权限、精确编辑原子性和取消保护', async () => {
  const workspace = new L3ProfileWorkspace({version_id: randomUUID(), entries: [entry]}, [scenario], [memory], budget);
  const before = workspace.read('profile.md'), execution = {signal: new AbortController().signal};
  const edit = workspace.tools().find(tool => tool.name === 'edit');
  const edits = [{oldText: entry.text, newText: '双方有合成课程经历，当前状态尚未确认。'}];
  await assert.rejects(edit.execute({path: `${scenario.scenario_id}.md`, edits}, execution), /path_forbidden/);
  await assert.rejects(edit.execute({path: 'profile.md', edits: [...edits, {oldText: '不存在的合成文本', newText: ''}]}, execution), /edit_invalid/);
  assert.equal(workspace.read('profile.md'), before);
  assert.throws(() => workspace.edit([null]), /edit_invalid/);
  assert.throws(() => workspace.edit([{...edits[0], extra: true}]), /edit_invalid/);
  await assert.rejects(edit.execute({path: 'profile.md', edits}, {signal: AbortSignal.abort()}), {name: 'AbortError'});
  assert.equal(workspace.read('profile.md'), before);
  await edit.execute({path: 'profile.md', edits}, execution);
  assert.equal(workspace.compile().entries[0].text, edits[0].newText);
});

test('L3增量核验接受16条旧内容及来源重排，不改写输入', () => {
  const extra = {memory_id:randomUUID(), revision:1};
  const entries = Array.from({length:16}, (_, index) => ({...entry,
    text:`合成背景${index}。`, references:[...entry.references, extra]}));
  const existing = {version_id:randomUUID(), entries};
  const proposal = {entries:entries.toReversed().map(item => ({...item, references:item.references.toReversed()}))};
  const before = structuredClone({existing, proposal});
  assert.doesNotThrow(() => validateIncrementalProfile(proposal, existing, []));
  assert.deepEqual({existing, proposal}, before);
});

test('L3增量核验要求未变化旧条目的完整含义和精确版本保持一致', () => {
  const existing = {version_id:randomUUID(), entries:[entry]};
  for (const change of [
    {text:'另一条合成事实。'}, {basis:'另一份依据。'}, {kind:'inference'},
    {section:'interests'}, {temporal_status:'uncertain'}, {uncertainty:'仍待确定。'},
    {references:[{...entry.references[0], revision:2}]},
  ]) {
    assert.throws(() => validateIncrementalProfile({entries:[{...entry, ...change}]}, existing, []),
      {code:'l3_profile_incremental_entry_missing'});
  }
});

test('L3增量核验允许变化场景改写，但仍保护原有来源', () => {
  const existing = {version_id:randomUUID(), entries:[entry]};
  const rewritten = {...entry, text:'合成课程背景有了新的进展。'};
  assert.doesNotThrow(() => validateIncrementalProfile({entries:[rewritten]}, existing, [scenario]));
  assert.throws(() => validateIncrementalProfile({entries:[]}, existing, [scenario]),
    {code:'l3_profile_incremental_reference_missing'});
});

test('L3增量核验按旧条目顺序报告缺失内容或缺失来源', () => {
  const unchanged = {...entry, text:'另一条未变化背景。', references:[{memory_id:randomUUID(), revision:1}]};
  for (const [entries, code] of [
    [[entry, unchanged], 'l3_profile_incremental_reference_missing'],
    [[unchanged, entry], 'l3_profile_incremental_entry_missing'],
  ]) {
    assert.throws(() => validateIncrementalProfile({entries:[]}, {version_id:randomUUID(), entries}, [scenario]), {code});
  }
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

test('L3生成上下文深冻结且不能改写工作区的读取和编译依据', () => {
  const workspace=new L3ProfileWorkspace({version_id:randomUUID(),entries:[entry]},[scenario],[memory],budget);
  const context=workspace.generationContext();
  for(const value of [context,context.existing.entries,context.existing.entries[0],context.scenarios,
    context.scenarios[0].paragraphs[0],context.memories,context.memories[0].timing,context.budget])assert.equal(Object.isFrozen(value),true);
  assert.throws(()=>{context.existing.entries[0].text='尝试覆盖画像';},TypeError);
  assert.throws(()=>{context.scenarios[0].paragraphs[0].text='尝试覆盖场景';},TypeError);
  assert.throws(()=>{context.memories[0].timing.current_status='stable';},TypeError);
  assert.throws(()=>{context.memories.push({...memory,revision:2});},TypeError);
  assert.equal(workspace.memories,context.memories);
  assert.match(workspace.read(`${scenario.scenario_id}.md`),new RegExp(memory.text));
  workspace.write('profile.md',renderProfile({entries:[entry]}));
  assert.equal(workspace.compile().entries[0].references[0].timing.current_status,'historical');
});

test('L3生成与编译使用同一冻结输入，构造后的外部修改不改变完整请求序列', async () => {
  const initial = {existing:{version_id:randomUUID(),entries:[entry]},scenarios:[scenario],memories:[memory],budget};
  const claim = {task_id:randomUUID(),step_id:randomUUID(),step_name:'organize_memory',worker_id:randomUUID(),lease_generation:1};
  const ownerId=randomUUID(),contactId=randomUUID(),batchId=randomUUID();
  async function run(mutate) {
    const input=structuredClone(initial),requests=[];
    const workspace=new L3ProfileWorkspace(input.existing,input.scenarios,input.memories,input.budget);
    if(mutate){
      input.existing.entries[0].text='构造后改写的旧画像';
      input.scenarios[0].title='构造后改写的场景';
      input.scenarios[0].paragraphs[0].text='构造后改写的场景正文';
      input.memories[0].text='构造后改写的底层记忆';
      input.memories[0].revision=2;
      input.memories[0].timing.current_status='stable';
      input.budget.max_characters=1;
    }
    const port={async call(request){
      const {signal,requireCurrent,messages,...data}=request;
      requests.push({...structuredClone(data),messages:messages.map(({id,...message})=>structuredClone(message))});
      const round=requests.length;
      const [name,args]=round===1?['read',{path:`${scenario.scenario_id}.md`}]
        :round===2?['write',{path:'profile.md',content:renderProfile({entries:[entry]})}]
        :['ProfileProposalComplete',{}];
      return {blocks:[{type:'tool-call',id:`frozen-profile-${round}`,name,arguments:JSON.stringify(args)}],receipt_id:null};
    }};
    const result=await runProfileDocumentAgent({
      workspace,changedScenarioIds:input.scenarios.map(scene=>scene.scenario_id),removedScenarioVersionIds:[],corrections:[],
      port,claim,owner_id:ownerId,contact_id:contactId,batch_id:batchId,
      binding:{provider:'synthetic-provider',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
      profile:{context_window_tokens:32_000,safety_margin_tokens:512},signal:new AbortController().signal,
      requireCurrent:async()=>{},remainingCalls:6,
    });
    return {workspace,requests,result};
  }
  const baseline=await run(false),mutated=await run(true);
  let initialText=baseline.requests[0].messages[0].content[0].text;
  for(const [identity,label] of [[memory.memory_id,'memory-id'],[scenario.scenario_id,'scenario-id'],[scenario.version_id,'scenario-version'],[initial.existing.version_id,'profile-version']])initialText=initialText.replaceAll(identity,label);
  assert.equal(createHash('sha256').update(initialText).digest('hex'),'861405cc7101398543f8ab0e1fd547ccda4f4d7a0c8c56341a87d123240d4547','保持重构前模型初始输入的完整字段、顺序与逐字内容');
  assert.equal(mutated.requests.length,3);
  assert.ok(isDeepStrictEqual(mutated.requests,baseline.requests),'消息正文、字段顺序、工具、提示及调用序列保持一致');
  assert.deepEqual(mutated.result,baseline.result);
  assert.equal(mutated.result.proposal.entries[0].references[0].revision,1);
  assert.equal(mutated.result.proposal.entries[0].references[0].timing.current_status,'historical');
});

test('L3多轮提案压缩已执行工具历史，不以旧写入参数耗尽下一轮预算', async () => {
  const constrained = {...budget, max_characters:6_000};
  const workspace = new L3ProfileWorkspace(null, [scenario], [memory], constrained);
  let calls = 0, compacted;
  const port = {async call(input) {
    assert.match(input.system, /增量维护时保留所有未受变化场景影响的旧条目/);
    assert.match(input.system, /通过 ProfileProposalComplete 显式结束提案/);
    const workflowInput = JSON.parse(input.messages[0].content[0].text);
    assert.equal(Object.hasOwn(workflowInput, 'workflow'), false);
    assert.equal(Object.hasOwn(workflowInput, 'previous_profile'), false);
    assert.equal(workflowInput.mode, 'first');
    assert.equal(workflowInput.existing_profile, null);
    assert.equal(workflowInput.changed_scenarios[0].version_id, scenario.version_id);
    assert.equal(workflowInput.scenarios[0].version_id, scenario.version_id);
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
    changedScenarioIds:[scenario.scenario_id],
    removedScenarioVersionIds:[],
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
    changedScenarioIds:[scenario.scenario_id],
    removedScenarioVersionIds:[],
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
    changedScenarioIds:[scenario.scenario_id],
    removedScenarioVersionIds:[],
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
    changedScenarioIds:[scenario.scenario_id],
    removedScenarioVersionIds:[],
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
