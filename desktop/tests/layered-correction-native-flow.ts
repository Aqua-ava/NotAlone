import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RewriteFixture } from './rewrite-backend-fixture';

type Memory = { memory_id: string; revision: number; text: string; supersedes_memory_id: string | null };
type Item = { text: string; references: { memory_id: string; revision: number }[] };
type Scenario = { version_id: string; paragraphs: Item[] };
type Profile = { version_id: string; entries: Item[] };
type State = { scope_kind: string; contact_id: string | null; settings_generation: number; organization_generation: number;
  scenarios: Scenario[]; profile: Profile | null; feedback: { target_kind: string; version_id: string; item_index: number; reason: string }[] };
export type NativeCorrectionStep = { name: string; scope: 'contact' | 'owner'; kind: 'profile' | 'scenario'; action: 'summary' | 'fact';
  layeredPath: string; memoriesPath: string; before: State; memories: Memory[]; target: Item; memory: Memory;
  versionId: string; itemIndex: number; reason: string; replacement: string };

async function read<T>(fixture: RewriteFixture, path: string, key: string): Promise<T> {
  const response = await fixture.request(path);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data[key] as T;
}

// 准备只经生产公开 HTTP；这些准备动作不计为真实桌面操作。
export async function prepareNativeCorrection(fixture: RewriteFixture, scope: 'contact' | 'owner', index: number,
  previous?: NativeCorrectionStep): Promise<NativeCorrectionStep> {
  const contactId = fixture.data.contact_ids[0];
  const layeredPath = scope === 'owner' ? '/api/memories/owner/layered-memory' : `/api/contacts/${contactId}/layered-memory`;
  const memoriesPath = scope === 'owner' ? '/api/memories/owner' : `/api/contacts/${contactId}/memories`;
  let state = await read<State>(fixture, layeredPath, 'layered_memory');
  if (index === 0) {
    const enabled = await fixture.request(layeredPath + '/enable', { settings_generation: state.settings_generation, purpose_confirmed: true });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  } else if (index >= 2) {
    if (index === 2) for (const suffix of ['甲', '乙']) {
      const added = await fixture.request(`/api/memories/manual-${scope}`, {
        ...(scope === 'contact' ? { contact_id: contactId } : {}), category: 'common_fact',
        text: `${scope === 'owner' ? '本人' : '双方'}原生验收新增独立资料${suffix}。`,
      });
      assert.equal(added.status, 200, JSON.stringify(added.data));
    }
    const refreshed = await fixture.request(layeredPath + '/refresh', { settings_generation: state.settings_generation });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  }
  state = await read<State>(fixture, layeredPath, 'layered_memory');
  const kind = index % 2 === 0 ? 'profile' : 'scenario';
  const action = index < 2 ? 'summary' : 'fact';
  assert.ok(state.scenarios.length >= 2 && state.scenarios.length <= 4, JSON.stringify(state));
  // 第二次反馈选另一独立主题；后续选择新一批画像实际使用的主题，不能依赖展示排序。
  const selectedMemoryId = index === 1 ? previous?.memory.memory_id : state.profile?.entries[0]?.references[0]?.memory_id;
  if (index === 1) assert.ok(selectedMemoryId, '必须携带上一项的实际依据身份。');
  const version = kind === 'profile' ? state.profile : state.scenarios.find(scenario => scenario.paragraphs.some(item =>
    item.references.some(reference => index === 1 ? reference.memory_id !== selectedMemoryId : reference.memory_id === selectedMemoryId)));
  assert.ok(version, JSON.stringify(state));
  const items = 'entries' in version ? version.entries : version.paragraphs;
  const target = items[0];
  assert.equal(target.references.length, 1);
  const memories = await read<Memory[]>(fixture, memoriesPath, 'memories');
  const memory = memories.find(item => item.memory_id === target.references[0].memory_id && item.revision === target.references[0].revision);
  assert.ok(memory, JSON.stringify({ target, memories }));
  const name = `${scope}-${kind}-${action}`;
  return { name, scope, kind, action, layeredPath, memoriesPath, before: state, memories, target, memory,
    versionId: version.version_id, itemIndex: 0, reason: `合成验收：${name}的概括含义有误。`,
    replacement: `${scope === 'owner' ? '本人' : '双方'}原生验收已核对的${kind === 'profile' ? '长期' : '主题'}合成事实。` };
}

export async function checkNativeCorrection(fixture: RewriteFixture, step: NativeCorrectionStep) {
  const state = await read<State>(fixture, step.layeredPath, 'layered_memory');
  const memories = await read<Memory[]>(fixture, step.memoriesPath, 'memories');
  assert.equal(state.scope_kind, step.scope);
  assert.equal(state.contact_id, step.scope === 'owner' ? null : fixture.data.contact_ids[0]);
  assert.equal(state.profile, null, '受影响的长期背景必须撤下。');
  if (step.action === 'summary') {
    const expectedScenarios = step.kind === 'profile' ? step.before.scenarios
      : step.before.scenarios.filter(item => item.version_id !== step.versionId);
    assert.deepEqual(state.scenarios, expectedScenarios, '独立主题的原始版本必须保留。');
    assert.deepEqual(memories, step.memories, '总结反馈不得修改正确的底层记忆。');
    assert.ok(state.feedback.some(item => item.target_kind === step.kind && item.version_id === step.versionId
      && item.item_index === step.itemIndex && item.reason === step.reason), JSON.stringify(state));
  } else {
    assert.ok(state.scenarios.every(scenario => scenario.paragraphs.every(item =>
      item.references.every(reference => reference.memory_id !== step.memory.memory_id))), '旧事实的派生正文不得继续可读。');
    assert.ok(!memories.some(item => item.memory_id === step.memory.memory_id));
    const corrected = memories.find(item => item.supersedes_memory_id === step.memory.memory_id);
    assert.ok(corrected, JSON.stringify(memories));
    assert.equal(corrected.revision, step.memory.revision + 1);
    assert.equal(corrected.text, step.replacement);
    assert.deepEqual(memories.filter(item => item.memory_id !== corrected.memory_id),
      step.memories.filter(item => item.memory_id !== step.memory.memory_id));
    const versions = await read<Memory[]>(fixture, `${step.memoriesPath}/${corrected.memory_id}/versions`, 'versions');
    assert.ok(versions.some(item => item.memory_id === step.memory.memory_id));
  }
  return { state, memories };
}

// 仅供后验合同的公开 HTTP 预检使用，绝不产生或替代 CUA 收据。
export async function simulateNativeCorrection(fixture: RewriteFixture, step: NativeCorrectionStep) {
  const result = await fixture.request(`${step.layeredPath}/${step.action}-error`, {
    settings_generation: step.before.settings_generation, organization_generation: step.before.organization_generation,
    target_kind: step.kind, version_id: step.versionId, item_index: step.itemIndex,
    ...(step.action === 'summary' ? { reason: step.reason, operation_id: randomUUID() } : { memory_id: step.memory.memory_id }),
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  if (step.action === 'fact') {
    assert.deepEqual((result.data.layered_memory as { correction_target: unknown }).correction_target,
      { memory_id: step.memory.memory_id, revision: step.memory.revision });
    const corrected = await fixture.request(`${step.memoriesPath}/${step.memory.memory_id}/correct`, {
      text: step.replacement, revision: step.memory.revision, category: 'common_fact',
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  }
}
