import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function withController(run) {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-correction-controller-'));
  try {
    const output = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/memory/controller.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { MemoryReadingController } = await import(pathToFileURL(output).href);
    return await run(MemoryReadingController);
  } finally { await rm(owned, { recursive: true, force: true }); }
}

test('生产资料控制器保留新证据与原人工决定的差异', async () => withController(async (MemoryReadingController) => {
  const contactId = '11111111-1111-4111-8111-111111111111';
  const candidateId = '22222222-2222-4222-8222-222222222222';
  const decisionId = '33333333-3333-4333-8333-333333333333';
  const messageId = '44444444-4444-4444-8444-444444444444';
  const sourceId = '55555555-5555-4555-8555-555555555555';
  const candidate = {
    candidate_id: candidateId, text: '有新证据的合成候选。', subject: 'contact', status: 'pending',
    category: 'preference', topic: 'other', source_ids: [messageId], confidence: 0.95, risk_flags: [],
    valid_at: null, invalid_at: null, timing: { recorded_at: null, source_started_at: null,
      source_ended_at: null, source_time_complete: false },
    correction_review: [{ decision_id: decisionId, decision: 'corrected',
      previous_text: '旧合成错误。', corrected_text: '原人工判断。', new_message_ids: [messageId],
      new_source_ids: [sourceId], semantic_relation: 'uncertain', reason: '请核对新依据，原人工判断仍有效。' }],
  };
  const posted = [];
  const backend = { getConnectionGeneration: () => 1,
    requestJson: async (request) => {
      if (request.method === 'POST') posted.push(request);
      return { generation: 1, data: request.path.endsWith('/memories')
        ? { memories: [] } : { candidates: [candidate] } };
    } };
  const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }) };
  const controller = new MemoryReadingController(backend, contacts);
  await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
  assert.deepEqual(controller.getState().pending.items[0].correctionReview, [{
    decisionId, decision: 'corrected', previousText: '旧合成错误。', correctedText: '原人工判断。',
    newMessageIds: [messageId], newSourceIds: [sourceId], semanticRelation: 'uncertain',
    reason: '请核对新依据，原人工判断仍有效。',
  }]);
  await controller.confirmCandidate({ contactId, scopeRevision: 1, candidateId });
  assert.deepEqual(posted[0].body, { correction_decision_ids: [decisionId] });
}));

test('修正取消迟到待确认读取并刷新人工决定对照', async () => withController(async (MemoryReadingController) => {
  const contactId = '11111111-1111-4111-8111-111111111111';
  const memoryId = '22222222-2222-4222-8222-222222222222';
  const messageId = '44444444-4444-4444-8444-444444444444';
  const common = { category: 'preference', topic: 'other', source_ids: [messageId], confidence: 0.95,
    risk_flags: [], valid_at: null, invalid_at: null, timing: { recorded_at: null, source_started_at: null,
      source_ended_at: null, source_time_complete: false } };
  let releaseLate, lateSignal, pendingReads = 0, committed = false;
  const backend = { getConnectionGeneration: () => 1, requestJson: async (request) => {
    if (request.method === 'POST') { committed = true; return { generation: 1, data: {} }; }
    if (request.path.endsWith('/memory-candidates')) {
      pendingReads++;
      if (pendingReads === 2) {
        lateSignal = request.signal;
        return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1, data: { candidates: [{
          ...common, candidate_id: memoryId, text: '旧证据迟到候选。', status: 'pending', subject: 'contact',
        }] } }); });
      }
      return { generation: 1, data: { candidates: [] } };
    }
    return { generation: 1, data: { memories: [{ ...common, memory_id: memoryId, level: 'contact', contact_id: contactId,
      text: committed ? '人工纠正。' : '旧错误。', status: 'active', adoption_method: 'manual', revision: 1,
      supersedes_memory_id: null, source_candidate_id: null }] } };
  } };
  const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }) };
  const controller = new MemoryReadingController(backend, contacts);
  await controller.refresh({ contactId, scopeRevision: 1, section: 'contact' });
  await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
  const late = controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
  await controller.correct({ contactId, scopeRevision: 1, memoryId, level: 'contact', revision: 1,
    text: '人工纠正。', category: 'preference' });
  releaseLate();
  await late;
  assert.equal(lateSignal.aborted, true);
  assert.equal(pendingReads, 3);
  assert.deepEqual(controller.getState().pending.items, []);
  assert.equal(controller.getState().contact.items[0].text, '人工纠正。');
}));

test('纠错页面范围通过两层启动前校验并已登记分发', async () => {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  const parser = source.slice(source.indexOf('function parse(args)'), source.indexOf('async function run(options)'));
  const parsed = runInNewContext(`${parser}; parse(args)`, {
    args: ['--case', 'memory-correction-protection', '--timeout-seconds', '180'],
  });
  assert.equal(JSON.stringify(parsed), JSON.stringify({ names: ['memory-correction-protection'], timeout: 180 }));
  const runner = await readFile('tests/headless/run.ts', 'utf8');
  const guard = runner.slice(runner.indexOf('if (!Array.isArray(cases)'), runner.indexOf('let browser:'));
  assert.doesNotThrow(() => runInNewContext(guard, { cases: ['memory-correction-protection'] }));
  assert.throws(() => runInNewContext(guard, { cases: ['unknown-page'] }), /page_test_arguments/);
  assert.match(runner, /import \{ memoryCorrectionProtection \} from '\.\/memory-correction';/);
  assert.match(runner, /name === 'memory-correction-protection' \? memoryCorrectionProtection/);
});

test('修正响应未知期间的新刷新不能回填旧候选对照', async () => withController(async (MemoryReadingController) => {
  for (const level of ['contact', 'owner']) {
    const contactId = '11111111-1111-4111-8111-111111111111';
    const memoryId = '22222222-2222-4222-8222-222222222222';
    const common = { category: 'preference', topic: 'other', source_ids: [memoryId], confidence: 1,
      risk_flags: [], valid_at: null, invalid_at: null, timing: { recorded_at: null,
        source_started_at: null, source_ended_at: null, source_time_complete: false } };
    const candidate = { ...common, candidate_id: memoryId, text: '修正前的旧候选和对照。',
      subject: level === 'owner' ? 'self' : 'contact', status: 'pending' };
    let pendingReads = 0, finishWrite, releaseLate, lateSignal, committed = false;
    const backend = { getConnectionGeneration: () => 1, requestJson: async (request) => {
      if (request.method === 'POST') return new Promise((_resolve, reject) => {
        finishWrite = () => { committed = true; reject(new Error('合成响应未知')); };
      });
      if (request.path.endsWith('/memory-candidates')) {
        pendingReads++;
        if (!committed && pendingReads > 1) {
          lateSignal = request.signal;
          return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1,
            data: { candidates: [candidate] } }); });
        }
        return { generation: 1, data: { candidates: committed ? [] : [candidate] } };
      }
      return { generation: 1, data: { memories: [{ ...common, memory_id: memoryId, level,
        contact_id: contactId, text: committed ? '当前人工判断。' : '旧人工资料。', status: 'active',
        adoption_method: 'manual', revision: 1, supersedes_memory_id: null, source_candidate_id: null }] } };
    } };
    const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
      directoryPhase: 'ready', contacts: [{ contactId }] }) };
    const controller = new MemoryReadingController(backend, contacts);
    await controller.refresh({ contactId, scopeRevision: 1, section: level });
    await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
    const correction = controller.correct({ contactId, scopeRevision: 1, memoryId, level,
      revision: 1, text: '当前人工判断。', category: 'preference' });
    const late = controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
    assert.equal(pendingReads, 1, '提交未决期间不读取旧比较');
    finishWrite();
    await correction;
    releaseLate?.();
    await late;
    assert.deepEqual(controller.getState().pending.items, []);
    assert.equal(controller.getState()[level].items[0].text, '当前人工判断。', '响应未知后仍权威复读已提交资料');
    if (lateSignal) assert.equal(lateSignal.aborted, true);
    assert.equal(controller.getState().mutation.phase, 'error');
    await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
    assert.deepEqual(controller.getState().pending.items, []);
  }
}));

test('删除资料撤下受影响正文，成功或响应未知都拒绝迟到比较', async () => withController(async (MemoryReadingController) => {
  for (const level of ['contact', 'owner']) for (const unknown of [false, true]) {
    const contactId = '11111111-1111-4111-8111-111111111111';
    const memoryId = '22222222-2222-4222-8222-222222222222';
    const otherId = '33333333-3333-4333-8333-333333333333';
    const common = { category: 'common_fact', topic: 'other', source_ids: [otherId], confidence: 1,
      risk_flags: [], valid_at: null, invalid_at: null, timing: { recorded_at: null,
        source_started_at: null, source_ended_at: null, source_time_complete: false } };
    const active = (id, kind) => ({ ...common, memory_id: id, level: kind, contact_id: contactId,
      text: id === memoryId ? '本次要求删除的旧正文。' : '另一条合法资料。',
      status: 'active', adoption_method: 'manual', revision: 1,
      supersedes_memory_id: null, source_candidate_id: null });
    const oldCandidate = { ...common, candidate_id: memoryId, text: '旧候选和旧比较。',
      status: 'pending', subject: 'contact' };
    let lateSignal, releaseLate, finishWrite, pendingReads = 0, committed = false;
    const backend = { getConnectionGeneration: () => 1, requestJson: async (request) => {
      if (request.method === 'POST') return new Promise((resolve, reject) => {
        finishWrite = () => { committed = true;
          if (unknown) reject(new Error('合成响应未知'));
          else resolve({ generation: 1, data: {} }); };
      });
      if (request.path.endsWith('/memory-candidates')) {
        pendingReads++;
        if (pendingReads === 2) {
          lateSignal = request.signal;
          return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1,
            data: { candidates: [oldCandidate] } }); });
        }
        return { generation: 1, data: { candidates: committed ? [] : [oldCandidate] } };
      }
      const kind = request.path.includes('/memories/owner') ? 'owner' : 'contact';
      return { generation: 1, data: { memories: [active(otherId, kind),
        ...(!committed || kind !== level ? [active(memoryId, kind)] : [])] } };
    } };
    const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
      directoryPhase: 'ready', contacts: [{ contactId }] }) };
    const controller = new MemoryReadingController(backend, contacts);
    await controller.refresh({ contactId, scopeRevision: 1, section: 'contact' });
    await controller.refresh({ contactId, scopeRevision: 1, section: 'owner' });
    await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
    const late = controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
    const removal = controller.remove({ contactId, scopeRevision: 1, memoryId, level, revision: 1 });
    assert.equal(lateSignal.aborted, true);
    assert.deepEqual(controller.getState()[level].items.map((item) => item.memoryId), [otherId]);
    const unrelated = level === 'contact' ? 'owner' : 'contact';
    assert.equal(controller.getState()[unrelated].items.length, 2);
    await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
    assert.equal(pendingReads, 2, '删除提交未知期间不能读取旧比较');
    finishWrite();
    await removal;
    releaseLate();
    await late;
    assert.deepEqual(controller.getState().pending.items, []);
    assert.deepEqual(controller.getState()[level].items.map((item) => item.memoryId), [otherId]);
    assert.equal(controller.getState().mutation.phase, unknown ? 'error' : 'success');
    await controller.refresh({ contactId, scopeRevision: 1, section: level });
    await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
    assert.deepEqual(controller.getState()[level].items.map((item) => item.memoryId), [otherId]);
    assert.deepEqual(controller.getState().pending.items, []);
  }
}));

test('来源删除立即清旧快照，并在未决删除复验后重读当前投影', async () => withController(async (MemoryReadingController) => {
  const contactId = '11111111-1111-4111-8111-111111111111';
  const memoryId = '22222222-2222-4222-8222-222222222222';
  const memory = { memory_id: memoryId, level: 'contact', contact_id: contactId,
    text: '来源删除前的旧正文。', category: 'common_fact', topic: 'other', source_ids: [memoryId],
    confidence: 1, risk_flags: [], valid_at: null, invalid_at: null, status: 'active',
    adoption_method: 'manual', revision: 1, supersedes_memory_id: null, source_candidate_id: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  let finishWrite, writeSignal, sourceDeleted = false;
  const backend = { getConnectionGeneration: () => 1, requestJson: async (request) => {
    if (request.method === 'POST') {
      writeSignal = request.signal;
      return new Promise((resolve) => { finishWrite = () => resolve({ generation: 1, data: {} }); });
    }
    const data = request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] }
      : { memories: !sourceDeleted && !request.path.includes('/owner') ? [memory] : [] };
    return { generation: 1, data };
  } };
  const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }) };
  const controller = new MemoryReadingController(backend, contacts);
  await controller.refresh({ contactId, scopeRevision: 1, section: 'contact' });
  const removal = controller.remove({ contactId, scopeRevision: 1, memoryId, level: 'contact', revision: 1 });
  sourceDeleted = true;
  await controller.revalidateDeletedSource(contactId);
  assert.equal(writeSignal.aborted, false, '同范围客户端取消不能回滚服务端未决提交');
  for (const section of ['contact', 'owner', 'pending', 'sources']) {
    assert.deepEqual(controller.getState()[section].items, []);
  }
  finishWrite();
  await removal;
  assert.equal(controller.getState().mutation.phase, 'success');
  for (const section of ['contact', 'owner', 'pending', 'sources']) {
    assert.deepEqual(controller.getState()[section], { phase: 'ready', items: [] });
  }
  assert.deepEqual(controller.getState().contact.items, []);
}));

test('另一联系人来源事件不会绕过正在提交的人工修正读取门', async () => withController(async (MemoryReadingController) => {
  const contactId = '11111111-1111-4111-8111-111111111111';
  const memoryId = '22222222-2222-4222-8222-222222222222';
  const common = { category: 'preference', topic: 'other', source_ids: [memoryId], confidence: 1,
    risk_flags: [], valid_at: null, invalid_at: null, timing: { recorded_at: null,
      source_started_at: null, source_ended_at: null, source_time_complete: false } };
  const candidate = { ...common, candidate_id: memoryId, text: '来源事件捕获的修正前旧候选。',
    subject: 'self', status: 'pending' };
  let finishWrite, releaseLate, committed = false, pendingReads = 0;
  const backend = { getConnectionGeneration: () => 1, requestJson: async (request) => {
    if (request.method === 'POST') return new Promise((resolve) => {
      finishWrite = () => { committed = true; resolve({ generation: 1, data: {} }); };
    });
    if (request.path.endsWith('/sources')) return { generation: 1, data: { sources: [] } };
    if (request.path.endsWith('/memory-candidates')) {
      pendingReads++;
      if (!committed && pendingReads > 1) return new Promise((resolve) => {
        releaseLate = () => resolve({ generation: 1, data: { candidates: [candidate] } });
      });
      return { generation: 1, data: { candidates: committed ? [] : [candidate] } };
    }
    return { generation: 1, data: { memories: request.path.includes('/owner') ? [{ ...common,
      memory_id: memoryId, level: 'owner', contact_id: contactId,
      text: committed ? '本人新的人工判断。' : '本人原资料。', status: 'active', adoption_method: 'manual',
      revision: 1, supersedes_memory_id: null, source_candidate_id: null }] : [] } };
  } };
  const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }) };
  const controller = new MemoryReadingController(backend, contacts);
  await controller.refresh({ contactId, scopeRevision: 1, section: 'owner' });
  await controller.refresh({ contactId, scopeRevision: 1, section: 'pending' });
  const correction = controller.correct({ contactId, scopeRevision: 1, memoryId, level: 'owner',
    revision: 1, text: '本人新的人工判断。', category: 'preference' });
  const revalidation = controller.revalidateDeletedSource('33333333-3333-4333-8333-333333333333');
  finishWrite();
  await correction;
  releaseLate?.();
  await revalidation;
  assert.deepEqual(controller.getState().pending.items, []);
  assert.equal(controller.getState().owner.items[0].text, '本人新的人工判断。');
  assert.equal(controller.getState().mutation.phase, 'success');
}));

test('另一联系人来源事件不能在删除提交后回填待删正文', async () => withController(async (MemoryReadingController) => {
  for (const level of ['contact', 'owner']) {
    const contactId = '11111111-1111-4111-8111-111111111111';
    const memoryId = '22222222-2222-4222-8222-222222222222';
    const memory = { memory_id: memoryId, level, contact_id: contactId, text: '本次要求删除的合成正文。',
      category: 'preference', topic: 'other', source_ids: [memoryId], confidence: 1, risk_flags: [],
      valid_at: null, invalid_at: null, status: 'active', adoption_method: 'manual', revision: 1,
      supersedes_memory_id: null, source_candidate_id: null, timing: { recorded_at: null,
        source_started_at: null, source_ended_at: null, source_time_complete: false } };
    let finishWrite, releaseLate, committed = false, memoryReads = 0;
    const backend = { getConnectionGeneration: () => 1, requestJson: async (request) => {
      if (request.method === 'POST') return new Promise((resolve) => {
        finishWrite = () => { committed = true; resolve({ generation: 1, data: {} }); };
      });
      if (request.path.endsWith('/sources')) return { generation: 1, data: { sources: [] } };
      if (request.path.endsWith('/memory-candidates')) return { generation: 1, data: { candidates: [] } };
      const requestedLevel = request.path.includes('/owner') ? 'owner' : 'contact';
      if (requestedLevel === level) {
        memoryReads++;
        if (!committed && memoryReads > 1) return new Promise((resolve) => {
          releaseLate = () => resolve({ generation: 1, data: { memories: [memory] } });
        });
      }
      return { generation: 1, data: { memories: !committed && requestedLevel === level ? [memory] : [] } };
    } };
    const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
      directoryPhase: 'ready', contacts: [{ contactId }] }) };
    const controller = new MemoryReadingController(backend, contacts);
    await controller.refresh({ contactId, scopeRevision: 1, section: level });
    const removal = controller.remove({ contactId, scopeRevision: 1, memoryId, level, revision: 1 });
    const revalidation = controller.revalidateDeletedSource('33333333-3333-4333-8333-333333333333');
    finishWrite();
    await removal;
    releaseLate?.();
    await revalidation;
    assert.deepEqual(controller.getState()[level].items, []);
    assert.equal(controller.getState().mutation.phase, 'success');
  }
}));
