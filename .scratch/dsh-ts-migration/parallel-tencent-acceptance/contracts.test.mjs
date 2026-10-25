/** 独立合同探针；只使用合成文字、公开代码及随机自有 PG 库。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runExtractionFlow} from '../../../backend-ts/src/extraction-flow.ts';
import {DshMemoryAdjudicationRuntime} from '../../../backend-ts/src/memory-adjudication-dsh.ts';
import {createExtractionFixture} from '../../../backend-ts/test/extraction-fixture.mjs';
import {freezeExtractionSources, requireCurrent} from '../../../backend-ts/src/extraction-sources.ts';
import {attachVerifiedSourceReceipt} from '../../../backend-ts/src/extraction-evidence.ts';
import {MemoryAdoption} from '../../../backend-ts/src/memory-adoption.ts';
import {sha} from '../../../backend-ts/src/contact-overview-evidence.ts';
import {L3ProfileWorkspace, renderProfile, runProfileDocumentAgent} from '../../../backend-ts/src/l3-profile-workspace.ts';

const signal = () => new AbortController().signal;
const reply = (name, payload) => ({blocks: [{type: 'tool-call', name, arguments: JSON.stringify(payload)}]});
const fact = message => ({
  text: '合成联系人偏好午后阅读。', category: 'preference', subject: 'contact', topic: 'other',
  source_message_ids: [message], confidence: 0.9, risk_flags: [], valid_at: null, invalid_at: null,
  speech_act: 'assertion', assertion_status: 'asserted', figurative_type: 'literal',
  alternatives: [], interpretation_reason: '合成来源直接陈述', event: null, conditions: null,
});

test('独立提取：只引用背景或范围外来源的候选不得进入来源核验', async () => {
  const background = randomUUID(), target = randomUUID(), outside = randomUUID();
  for (const invalidSource of [background, outside]) {
    const purposes = [];
    const outcome = await runExtractionFlow({
      window: {owner_id: randomUUID(), contact_id: randomUUID(), target_message_ids: [target], messages: [
        {message_id: background, sender: 'contact', occurred_at: null, text: '合成背景：你午后做什么？'},
        {message_id: target, sender: 'self', occurred_at: '2026-10-01T01:02:03.123456+08:00', text: '合成用户回答：“阅读”；不改写此句。'},
      ]}, signal: signal(), requireCurrent: async () => {}, record: async () => {},
      invoke: async request => {
        purposes.push(request.purpose);
        assert.equal(request.purpose, 'extraction');
        const [context, fresh] = request.user.split('【待提取的新消息】');
        assert.ok(context.includes('[contact] [unknown]'));
        assert.ok(fresh.includes('[self] [2026-10-01T01:02:03.123456+08:00]'));
        assert.ok(fresh.includes('合成用户回答：“阅读”；不改写此句。'));
        assert.equal(request.user.includes('[assistant]'), false);
        return reply(request.tool.name, {scenes: [{scene_name: '合成阅读', memories: [fact(invalidSource)]}]});
      },
    });
    assert.deepEqual(purposes, ['extraction']);
    assert.deepEqual(outcome.accepted, []);
    assert.equal(outcome.rejected_count, 1);
  }
});

test('独立统一池：稀疏候选编号、来源、条件及未知原时刻不丢失', async () => {
  const old = randomUUID(), oldMessage = randomUUID(), newMessage = randomUUID();
  const condition = {synthetic: '仅工作日，不是长期规则'};
  const prior = {memory_id: old, revision: 7, text: '合成旧资料：仅工作日午后阅读。',
    category: 'preference', subject: 'contact', topic: 'other', adoption_method: 'auto',
    source_message_ids: [oldMessage], source_texts: [{message_id: oldMessage, text: '合成旧来源：“仅工作日”', occurred_at: null}],
    statement_time: null, valid_at: null, invalid_at: null, event: null, conditions: condition,
    source_dependency_mode: 'all', requires_all_sources: true};
  const items = [3, 8].map(candidate_index => ({candidate_index,
    candidate: {...fact(newMessage), _scene_name: '合成阅读', conditions: condition},
    candidate_source_texts: [{message_id: newMessage, text: '合成新来源：只在工作日。', occurred_at: null}],
    similar: [prior]}));
  let calls = 0;
  const runtime = new DshMemoryAdjudicationRuntime({batchKey: 'synthetic-independent-pool', port: {async call(request) {
    calls++;
    const payload = JSON.parse(request.user);
    assert.equal(payload.existing_memories.length, 1);
    const previous = payload.existing_memories[0];
    assert.equal(previous.revision, 7);
    assert.deepEqual(previous.source_message_ids, [oldMessage]);
    assert.deepEqual(previous.sources, prior.source_texts);
    assert.deepEqual(previous.conditions, condition);
    assert.equal(previous.statement_time, null);
    assert.equal(previous.source_dependency_mode, 'all');
    assert.deepEqual(payload.new_memories.map(row => row.candidate_index), [3, 8]);
    assert.ok(payload.new_memories.every(row => row.related_memory_ids[0] === old));
    assert.ok(payload.new_memories.every(row => row.source_texts[0].message_id === newMessage));
    assert.match(payload.workflow, /统一候选记忆池（共 1 条已有记忆）/);
    return reply(request.schema.title, {decisions: [3, 8].map(candidate_index => ({candidate_index, action: 'keep',
      replaced_memory_id: null, merged_memory_ids: [], merged_text: null, duplicate_memory_id: null, relation: null}))});
  }}});
  const decisions = await runtime.adjudicate(items, signal());
  assert.equal(calls, 1);
  assert.deepEqual(decisions.map(row => row.candidate_index), [3, 8]);
});

test('独立L3：正式增量入口携带旧画像和变化清单，显式完成后保留旧条目', async () => {
  const budget = {max_memories: 20, max_batch_memories: 20, max_scenarios: 15, max_paragraphs: 40,
    max_characters: 128000, max_model_calls: 8};
  const memories = ['合成双方参加过绘画课程。', '合成双方参加过陶艺课程。'].map(text => ({
    memory_id: randomUUID(), revision: 1, level: 'contact', text, category: 'common_fact', provenance_kind: 'manual_entry',
    timing: {current_status: 'historical'}, event: null, conditions: null, evolution: null, valid_at: null, invalid_at: null,
    dependency_ids: [], message_ids: [], dependency_manifest: {},
  }));
  for (const memory of memories) memory.dependency_manifest = {memory_id: memory.memory_id, revision: 1, text: memory.text};
  const scenarios = memories.map(memory => ({scenario_id: randomUUID(), version_id: randomUUID(), title: '合成课程', hint: '合成共同经历',
    paragraphs: [{text: memory.text, references: [{memory_id: memory.memory_id, revision: 1, provenance_kind: 'manual_entry',
      timing: memory.timing, event: null, conditions: null, evolution: null, valid_at: null, invalid_at: null}]}],
    input_manifest: [memory.dependency_manifest], dependency_ids: [memory.memory_id]}));
  const entries = memories.map(memory => ({text: memory.text, kind: 'fact', section: 'life_context', basis: '合成底层资料直接陈述',
    temporal_status: 'historical', uncertainty: '', references: [{memory_id: memory.memory_id, revision: 1}]}));
  const existing = {version_id: randomUUID(), entries: [entries[0]]};
  const workspace = new L3ProfileWorkspace(existing, scenarios, memories, budget);
  const owner = randomUUID(), contact = randomUUID();
  let calls = 0;
  const result = await runProfileDocumentAgent({workspace, existing, scenarios, memories, changedScenarios: [scenarios[1]],
    removedScenarioVersionIds: [], baseProfileVersionId: existing.version_id, corrections: [],
    port: {async call(request) {
      calls++;
      assert.equal(request.owner_id, owner);
      assert.equal(request.contact_id, contact);
      const payload = JSON.parse(request.messages[0].content[0].text);
      assert.equal(payload.mode, 'incremental');
      assert.match(payload.workflow, /迭代决策指南/);
      assert.deepEqual(payload.existing_profile, existing);
      assert.equal(payload.changed_scenarios[0].version_id, scenarios[1].version_id);
      assert.deepEqual(request.tools.map(row => row.name), ['read', 'write', 'edit', 'ProfileProposalComplete']);
      await request.requireCurrent();
      return calls === 1
        ? {blocks: [{type: 'tool-call', id: 'synthetic-profile-write', name: 'write', arguments: JSON.stringify({path: 'profile.md', content: renderProfile({entries})})}]}
        : {blocks: [{type: 'tool-call', id: 'synthetic-profile-complete', name: 'ProfileProposalComplete', arguments: '{}'}]};
    }},
    claim: {task_id: randomUUID(), step_id: randomUUID(), step_name: 'organize_memory', worker_id: randomUUID(), lease_generation: 1},
    owner_id: owner, contact_id: contact, batch_id: randomUUID(),
    binding: {provider: 'synthetic-provider', model: 'synthetic-model', maxTokens: 512, temperature: 0, reasoningEffort: 'off'},
    profile: {context_window_tokens: 32000, safety_margin_tokens: 512}, signal: signal(), requireCurrent: async () => {}, remainingCalls: 6});
  assert.equal(calls, 2);
  assert.deepEqual(result.proposal.entries.map(row => row.text), entries.map(row => row.text));
});

test('独立合成PG：owner/contact双键、不可移交核验依据、E后来源失效均拒绝写入', {timeout: 30000}, async () => {
  const fixture = await createExtractionFixture(), c = fixture.client;
  const owner = randomUUID(), otherOwner = randomUUID(), contact = randomUUID(), otherContact = randomUUID(), foreignContact = randomUUID();
  const transaction = async work => {
    await c.query('BEGIN');
    try {const result = await work(c); await c.query('COMMIT'); return result;}
    catch (error) {await c.query('ROLLBACK'); throw error;}
  };
  try {
    await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成所有者甲'),($2,'合成所有者乙')", [owner, otherOwner]);
    await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成同名'),($3,$2,'合成同名'),($4,$5,'合成同名')",
      [contact, owner, otherContact, foreignContact, otherOwner]);
    const rows = [];
    for (const [ownerId, contactId] of [[owner, contact], [owner, otherContact], [otherOwner, foreignContact]]) {
      const source = randomUUID(), message = randomUUID(), text = '合成联系人偏好午后阅读。';
      await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",
        [source, ownerId, contactId, sha(source)]);
      await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,NULL)",
        [message, ownerId, contactId, text]);
      await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'synthetic',$5)",
        [message, ownerId, contactId, source, {synthetic: true, text}]);
      rows.push({source, message, text});
    }
    const scope = {ownerId: owner, contactId: contact};
    for (const row of rows.slice(1)) await assert.rejects(
      freezeExtractionSources(c, scope, {target_message_ids: [row.message], context_message_ids: []}),
      {code: 'extraction_sources_unavailable'});
    const frozen = await freezeExtractionSources(c, scope, {target_message_ids: [rows[0].message], context_message_ids: []});
    await assert.rejects(requireCurrent(c, {ownerId: otherOwner, contactId: contact}, frozen), {code: 'extraction_sources_scope'});
    await assert.rejects(requireCurrent(c, {ownerId: owner, contactId: otherContact}, frozen), {code: 'extraction_sources_scope'});
    const original = {...fact(rows[0].message), requires_all_sources: false, source_dependency_mode: 'any', _scene_name: '合成阅读',
      timing: {source_started_at: null, source_ended_at: null, source_time_complete: false}};
    const verification = {candidate_index: 0, verdict: 'supported', issues: [], evidence: [{message_id: rows[0].message, quote: rows[0].text}],
      verification_mode: 'legacy-v4', model_verdict: 'supported', model_issues: [], event: null, conditions: null, proof: null, proof_verification: null};
    const window = {owner_id: owner, contact_id: contact, messages: frozen.messages, target_message_ids: [rows[0].message]};
    const verified = attachVerifiedSourceReceipt(window, original, verification);
    for (const [ownerId, contactId] of [[owner, otherContact], [otherOwner, foreignContact]]) {
      await assert.rejects(new MemoryAdoption({ownerId, transaction, embed: async texts => texts.map(() => [1, 0, 0])})
        .adoptBatch({contact_id: contactId, facts: [{fact: verified}], signal: signal()}), {code: 'adoption_source_changed'});
    }
    let calls = 0;
    await assert.rejects(runExtractionFlow({window, signal: signal(), record: async () => {},
      requireCurrent: () => requireCurrent(c, scope, frozen),
      invoke: async request => {
        calls++;
        assert.equal(request.purpose, 'extraction');
        await c.query('UPDATE source_document SET content_sha256=$1 WHERE id=$2', ['b'.repeat(64), rows[0].source]);
        return reply(request.tool.name, {scenes: [{scene_name: '合成阅读', memories: [fact(rows[0].message)]}]});
      },
    }), {code: 'extraction_sources_changed'});
    assert.equal(calls, 1);
    assert.equal((await c.query('SELECT count(*)::int n FROM memory_candidate')).rows[0].n, 0);
    assert.equal((await c.query('SELECT count(*)::int n FROM confirmed_memory')).rows[0].n, 0);
    assert.equal((await c.query('SELECT count(*)::int n FROM owner_memory')).rows[0].n, 0);
  } finally {await fixture.close();}
});
