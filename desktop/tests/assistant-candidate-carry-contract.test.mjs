import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/main/reply/assistant-candidate-carry.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false });
const { readAssistantCarry } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

// 固定 v2 公开投影用于桌面解析合同；旧Python codec对照由历史命令保留。
function serverProjection() {
  const ids = ['origin_owner_id','origin_contact_id','origin_binding_id','origin_session_id',
    'origin_input_version_id','origin_turn_id','origin_reply_request_id','origin_candidate_id',
    'origin_version_id','origin_selection_id'];
  return {type:'candidate_carry',metadata_version:2,...Object.fromEntries(ids.map(key=>[key,randomUUID()])),
    payload_sha256:'a'.repeat(64),messages:[{message_id:randomUUID(),text:'合成携入候选。'}]};
}

test('桌面读取固定v2携入投影，不接受退役偏好依赖字段', () => {
  {
    const value = serverProjection();
    assert.equal(value.metadata_version, 2);
    assert.equal(Object.hasOwn(value, 'style_sample_ids'), false);
    const carry = readAssistantCarry(value, value.origin_contact_id, randomUUID(), value.origin_binding_id);
    assert.deepEqual(carry.messages, [{ messageId: value.messages[0].message_id, text: '合成携入候选。' }]);
    assert.equal(carry.originCandidateId, value.origin_candidate_id);
  }
});

test('桌面拒绝未经后端归一化的旧协议、未知字段及跨联系人携入', () => {
  const value = serverProjection(), sessionId = randomUUID();
  for (const changed of [{ ...value, metadata_version: 1 }, { ...value, style_sample_ids: [] },
    { ...value, style_sample_ids: [randomUUID()] }, { ...value, origin_contact_id: randomUUID() },
    { ...value, origin_session_id: sessionId }, { ...value, metadata_version: 3 }]) {
    assert.throws(() => readAssistantCarry(changed, value.origin_contact_id, sessionId, value.origin_binding_id));
  }
});
