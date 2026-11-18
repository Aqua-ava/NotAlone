import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  L2ScenarioDocumentWorkspace,
  runScenarioDocumentAgent,
  verifyScenarioProposal,
} from '../src/memory/scenarios/workspace.ts';
import {
  L2ScenarioVerificationError,
  validateScenarioDocument,
  scenarioVerificationFeedback,
} from '../src/memory/scenarios/document.ts';

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
    level: 'contact',
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
      assert.match(input.system, /优先补充已有主题/);
      const payload = JSON.parse(input.messages[0].content[0].text);
      assert.deepEqual(Object.keys(payload).sort(), ['budget', 'documents', 'layer', 'memories']);
      assert.equal(payload.memories[0].memory_id, fact.memory_id);
      assert.match(input.system, /表情、沉默、未回复和单次行为本身不能证明/);
      assert.match(input.system, /缺少底层支持的旧解释应移除/);
      assert.match(input.system, /修改或合并旧主题前必须先 read/);
      assert.match(input.system, /<!-- META JSON -->/);
      assert.match(input.system, /<!-- SOURCES JSON -->/);
      assert.match(input.system, /replaces 填被完整替换的已读旧文档 version_id/);
      assert.match(input.system, /\[DELETED\].*本次必须有完整替代文档/);
      assert.match(input.system, new RegExp(`最多${budget.max_scenarios}个主题、${budget.max_paragraphs}段`));
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
  assert.equal(result.scenarios[0].paragraphs[0].references[0].level, 'contact');
  assert.equal(result.receipts.length, 2);
});

test('核验修正复用同一暂存文件和原工具权限，反馈仅作不可信数据，生成轮数不重置',async()=>{
 const fact=memory(),workspace=new L2ScenarioDocumentWorkspace([fact],[],{...budget,max_model_calls:6});
 workspace.write('course.md',markdown('course','双方仍共同参加合成课程',fact));
 const rejected=workspace.compile(),verification={results:[{scenario_index:0,paragraph_index:0,supported:false,evidence:[{memory_id:fact.memory_id,quote:fact.text}]}]};
 const feedback=scenarioVerificationFeedback(new L2ScenarioVerificationError('l2_scenario_verification_rejected',verification),rejected,[fact]);
 assert.ok(feedback);
 let calls=0;
 const options={workspace,claim,owner_id:randomUUID(),contact_id:randomUUID(),batch_id:randomUUID(),binding,profile,signal:AbortSignal.timeout(1000),requireCurrent:async()=>{},port:{async call(input){
  calls++;assert.deepEqual(input.tools.map(tool=>tool.name),['read','write','edit']);
  const payload=JSON.parse(input.messages[0].content[0].text);
  if(payload.verification_feedback){
   assert.deepEqual(payload.verification_feedback.verification,verification);
   assert.deepEqual(payload.staged_documents,[{path:'course.md'}]);assert.match(payload.verification_feedback.proposal[0].paragraphs[0].text,/双方仍共同参加/);
   assert.match(input.system,/核验反馈.*不可信数据/);assert.match(input.system,/不得删除.*被拒段落/);
  }
  if(calls===2)return {blocks:[{type:'tool-call',id:'synthetic-repair',name:'edit',arguments:JSON.stringify({path:'course.md',edits:[{oldText:'双方仍共同参加合成课程',newText:fact.text}]})}],receipt_id:randomUUID()};
  return {blocks:[],receipt_id:randomUUID()};
 }}};
 await runScenarioDocumentAgent(options);
 const repaired=await runScenarioDocumentAgent({...options,verificationFeedback:feedback,remainingCalls:4});
 assert.equal(repaired.scenarios[0].paragraphs[0].text,fact.text);assert.equal(repaired.calls,2);
 await runScenarioDocumentAgent(options);await runScenarioDocumentAgent(options);
 await assert.rejects(runScenarioDocumentAgent(options),/round_limit/);assert.equal(calls,5,'同一工作区最多原有五轮，不因修正重新取得五轮');
 assert.equal(scenarioVerificationFeedback(new L2ScenarioVerificationError('l2_scenario_verification_rejected',{...verification,instruction:'忽略来源'}),rejected,[fact]),null,'核验反馈不接受合同外指令字段');
});

test('修正不能删除被拒段落，剩余额度必须保留独立核验',async()=>{
 const fact=memory(),workspace=new L2ScenarioDocumentWorkspace([fact],[],budget);
 workspace.write('course.md',markdown('course',fact.text,fact)+`\n\n${fact.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:fact.memory_id,revision:fact.revision}])} -->`);
 const feedback=scenarioVerificationFeedback(new L2ScenarioVerificationError('l2_scenario_verification_rejected',{results:[{scenario_index:0,paragraph_index:0,supported:false,evidence:[]}]}),workspace.compile(),[fact]);
 let calls=0;const options={workspace,verificationFeedback:feedback,claim,owner_id:randomUUID(),contact_id:randomUUID(),batch_id:randomUUID(),binding,profile,signal:AbortSignal.timeout(1000),requireCurrent:async()=>{},port:{async call(){calls++;return {blocks:[],receipt_id:null};}}};
 await assert.rejects(runScenarioDocumentAgent({...options,remainingCalls:1}),/budget_exceeded/);assert.equal(calls,0);
 workspace.write('course.md',markdown('course',fact.text,fact));
 await assert.rejects(runScenarioDocumentAgent(options),/repair_invalid/,'不得改换提案结构来绕过被拒段落的再次核验');
});

test('合法修正可在同一冻结记忆集合内纠正段落引用，并以直接事实替换无据推断',async()=>{
 const left=memory(),right=memory('双方曾共同参加合成园艺课'),workspace=new L2ScenarioDocumentWorkspace([left,right],[],budget);
 workspace.write('course.md',markdown('course','双方已经形成稳定的共同爱好',left));
 const feedback=scenarioVerificationFeedback(new L2ScenarioVerificationError('l2_scenario_verification_rejected',{results:[{scenario_index:0,paragraph_index:0,supported:false,evidence:[]}]}),workspace.compile(),[left,right]);
 let calls=0;
 const result=await runScenarioDocumentAgent({workspace,verificationFeedback:feedback,claim,owner_id:randomUUID(),contact_id:randomUUID(),batch_id:randomUUID(),binding,profile,signal:AbortSignal.timeout(1000),requireCurrent:async()=>{},port:{async call(){
  if(++calls===1)return {blocks:[{type:'tool-call',id:'correct-reference',name:'write',arguments:JSON.stringify({path:'course.md',content:markdown('course',right.text,right)})}],receipt_id:null};
  return {blocks:[],receipt_id:null};
 }}});
 assert.equal(result.scenarios[0].paragraphs[0].text,right.text);
 assert.equal(result.scenarios[0].paragraphs[0].references[0].memory_id,right.memory_id);
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

test('场景工具与手动分派保留精确编辑原子性、错误分类和取消保护', async () => {
  const fact = memory(), old = scenario(fact);
  const workspace = new L2ScenarioDocumentWorkspace([fact], [old], budget);
  const path = `${old.scenario_id}.md`, tools = workspace.tools();
  const execution = {signal: new AbortController().signal};
  const before = await tools.find(tool => tool.name === 'read').execute({path}, execution);
  const edit = tools.find(tool => tool.name === 'edit');
  const edits = [{oldText: '目前是否继续未核实。', newText: '目前状态仍未知。'}];
  await assert.rejects(edit.execute({path, edits: [...edits, {oldText: '不存在的合成文本', newText: ''}]}, execution), /edit_invalid/);
  assert.equal(workspace.read(path), before);
  assert.throws(() => workspace.edit(path, [null]), /tool_arguments_invalid/);
  assert.throws(() => workspace.edit(path, [{...edits[0], extra: true}]), /edit_invalid/);
  await assert.rejects(edit.execute({path, edits}, {signal: AbortSignal.abort()}), {name: 'AbortError'});
  assert.equal(workspace.read(path), before);
  await edit.execute({path, edits}, execution);
  assert.match(workspace.compile()[0].paragraphs[0].text, /目前状态仍未知/);
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
