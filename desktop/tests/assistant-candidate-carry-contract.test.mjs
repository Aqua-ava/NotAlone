import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/main/reply/assistant-candidate-carry.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false });
const { readAssistantCarry } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

// 直接消费生产 Python codec 的公开元数据；仅标准库，不启动后端、不连接数据库。
function serverProjection(legacy = false) {
  const result = spawnSync(process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'bin/python') : 'python3', ['-c', `
import json
import importlib.util
import sys
from pathlib import Path
from uuid import uuid4
spec = importlib.util.spec_from_file_location("candidate_carry_contract",
    Path("../backend/src/notalone/application/assistant_candidate_carry.py").resolve())
codec = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = codec
spec.loader.exec_module(codec)
origin = codec.CandidateCarryOrigin(*[uuid4() for _ in range(10)], payload_sha256="a" * 64)
payload = codec.carry_origin_to_payload(origin)
if ${legacy ? 'True' : 'False'}:
    payload["metadata_version"] = 1
    payload["style_sample_ids"] = []
    payload = codec.carry_origin_to_payload(codec.carry_origin_from_payload(payload))
payload["messages"] = [{"message_id": str(uuid4()), "text": "合成携入候选。"}]
print(json.dumps(payload))
`], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.resolve('../backend/src'),
    NOTALONE_DISABLE_DOTENV: '1', LANGSMITH_TRACING: 'false' } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('桌面读取生产后端新携入协议及旧空依赖归一化结果', () => {
  for (const legacy of [false, true]) {
    const value = serverProjection(legacy);
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
