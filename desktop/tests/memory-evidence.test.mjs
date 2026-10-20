import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/renderer/memory-evidence.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { readMemoryEvidence } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const scope = 'contact-a';
const message = (id, text) => ({ message_id: id, text, sender: 'contact',
  occurred_at: '2026-10-01T12:00:00+08:00', text_representation: 'text' });
function fixture() {
  return { contact_id: scope, status: 'succeeded',
    links: [{ record_kind: 'contact_memory', record_id: 'memory-a', commit_status: 'committed' }],
    write_receipts: [],
    events: [{ stage: 'window', payload: { messages: [message('message-a', '合成直接依据'), message('message-b', '合成无关上下文')] } },
      { stage: 'write_result', payload: { commit_status: 'committed',
        actual: { memory_id: 'memory-a', contact_id: scope, source_ids: ['message-a'] } } }] };
}
const read = (detail) => readMemoryEvidence(detail, scope, 'contact_memory', 'memory-a');

test('只呈现实际写入记录的直接来源，不把整窗或其他候选当依据', () => {
  const detail = fixture();
  detail.events.push({ stage: 'candidate_raw', payload: { fields: { source_message_ids: ['message-b'] } } });
  detail.events.push({ stage: 'write_result', payload: { commit_status: 'committed',
    actual: { memory_id: 'memory-other', source_ids: ['message-b'] } } });
  assert.deepEqual(read(detail).messages.map((row) => row.text), ['合成直接依据']);
  assert.equal(readMemoryEvidence(detail, scope, 'contact_memory', 'memory-other').linked, false);
});
test('手动确认的提取候选沿权威关联定位原候选的直接消息', () => {
  const detail = fixture();
  detail.links = [{ record_kind: 'candidate', record_id: 'candidate-a', commit_status: 'committed' }];
  detail.write_receipts = [{ record_kind: 'contact_memory', record_id: 'memory-a',
    source_candidate_id: 'candidate-a', commit_status: 'committed' }];
  detail.events[1].payload.actual = { candidate_id: 'candidate-a', contact_id: scope, source_ids: ['message-a'] };
  assert.equal(read(detail).messages[0].text, '合成直接依据');
  detail.write_receipts[0].record_kind = 'owner_memory';
  assert.deepEqual(read(detail).messages, []);
});
test('本人记忆只接受当前联系人批次中对应类型的权威关联', () => {
  const detail = fixture();
  detail.links[0].record_kind = 'owner_memory';
  delete detail.events[1].payload.actual.contact_id;
  assert.equal(readMemoryEvidence(detail, scope, 'owner_memory', 'memory-a').messages.length, 1);
  assert.equal(read(detail).messages.length, 0);
});
test('跨联系人和已删除过程不返回正文', () => {
  const detail = fixture();
  detail.contact_id = 'contact-b';
  assert.deepEqual(read(detail).messages, []);
  detail.contact_id = scope;
  detail.status = 'deleted';
  assert.deepEqual(read(detail).messages, []);
  detail.status = 'succeeded';
  detail.events[1].payload.actual.contact_id = 'contact-b';
  assert.deepEqual(read(detail).messages, []);
});
test('计划写入、未提交结果和模型返回不能成为已保存依据', () => {
  const detail = fixture();
  detail.events[1].payload.commit_status = 'planned';
  assert.equal(read(detail).linked, false);
  detail.events[1].payload.commit_status = 'committed';
  detail.events[1].stage = 'write_plan';
  assert.equal(read(detail).linked, false);
});
test('来源引用或历史窗口缺失保留缺口，不以附近消息补齐', () => {
  const detail = fixture();
  detail.events[1].payload.actual.source_ids.push('source-document', 'missing-message');
  assert.equal(read(detail).missingCount, 2);
  assert.equal(read(detail).messages.length, 1);
});
test('同一消息快照冲突时不猜测正文；格式损坏不抛出异常', () => {
  const detail = fixture();
  detail.events.push({ stage: 'window', payload: { messages: [message('message-a', '不同的合成正文')] } });
  assert.equal(read(detail).messages.length, 0);
  assert.equal(read(detail).missingCount, 1);
  assert.deepEqual(read({ contact_id: scope, events: [null, [], { stage: 'window', payload: null }] }).messages, []);
});
test('媒体占位和缺失时间原样标记，不伪造媒体原话或日期', () => {
  const detail = fixture();
  Object.assign(detail.events[0].payload.messages[0], { text: '[图片]', text_representation: 'placeholder', occurred_at: null });
  const result = read(detail).messages[0];
  assert.equal(result.representation, 'placeholder');
  assert.equal(result.occurredAt, null);
});

test('依据尚未核验时不渲染父页面传入的记忆正文', async () => {
  const output = await build({ stdin: { contents: `
    export { MemoryEvidence } from './src/renderer/MemoryEvidence';
    export { createElement } from 'react';
    export { renderToStaticMarkup } from 'react-dom/server';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  loader: { '.css': 'empty' },
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
  const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const text = '合成的旧记忆正文不得在范围核验前回显';
  for (const selectedContactId of [scope, null]) {
    const html = ports.renderToStaticMarkup(ports.createElement(ports.MemoryEvidence, {
      session: { state: { selectedContactId, scopeRevision: 1 } },
      kind: 'contact_memory', recordId: 'memory-a', text, onClose() {},
    }));
    assert.match(html, /aria-label="记忆依据"/);
    assert.doesNotMatch(html, /合成的旧记忆正文/);
    assert.doesNotMatch(html, /<blockquote/);
  }
});
