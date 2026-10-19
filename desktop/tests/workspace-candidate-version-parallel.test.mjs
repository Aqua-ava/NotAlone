import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { AssistantCandidateVersionSession, AssistantCandidateSourceUnavailable } from './src/main/reply/assistant-candidate-versions';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { AssistantCandidateVersionSession, AssistantCandidateSourceUnavailable, BackendRequestFailure } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));

// 门控公开传输只改变响应到达顺序；组件读取真实协议，正文仅为合成长消息。
function fixture(count = 25) {
  const scope = { contactId: randomUUID(), scopeRevision: 1, sessionId: randomUUID() };
  const candidateId = randomUUID(), messages = Array.from({ length: 8 }, () => randomUUID());
  const ids = [candidateId, ...Array.from({ length: count - 1 }, () => randomUUID())];
  const versions = ids.map((versionId, number) => {
    const group = messages.map((messageId, index) => ({ message_id: messageId,
      text: `${number}:${index}:` + '字'.repeat(8180) }));
    return { version_id: versionId, version_number: number, parent_version_id: ids[number - 1] ?? null,
      messages: group, text: group.map(item => item.text).join('\n\n'), requirements: null,
      created_at: '2026-10-20T00:00:00+00:00' };
  });
  const header = { session_id: scope.sessionId, turn_id: randomUUID(), candidate_id: candidateId,
    candidate_group_id: randomUUID(), candidate_number: 1, default_display_version_id: ids.at(-1) };
  const held = new Map(), calls = [], aborted = [], visible = [];
  let gated = true, active = 0, peak = 0, generation = 7;
  const backend = { getConnectionGeneration: () => generation, requestJson: async request => {
    const url = new URL(request.path, 'http://fixture.invalid');
    calls.push(url);
    if (url.pathname.endsWith('/selections')) return { generation: 7, data: { selection: null } };
    const number = Number(url.searchParams.get('page'));
    const response = { generation: 7, data: { ...header, versions: [versions[number]],
      page_number: number, version_count: versions.length, next_page: number + 1 < versions.length ? number + 1 : null } };
    if (number === 0 || !gated) return response;
    active++; peak = Math.max(peak, active);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true; active--; held.delete(number); request.signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => { aborted.push(number); finish(null, new BackendRequestFailure('cancelled')); };
      held.set(number, { response, finish });
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) cancel();
    });
  } };
  const session = new AssistantCandidateVersionSession(backend);
  session.setScope(scope);
  session.onStateChanged(state => visible.push(state.candidateVersions.items.map(item => item.history?.versions.length ?? 0)));
  return { session, scope: { ...scope, candidateId }, held, calls, aborted, visible, ids,
    peak: () => peak, gate() { gated = true; }, changeGeneration() { generation++; }, release(number, error, change) {
      const item = held.get(number); assert(item, `第${number}页应已开始读取`);
      if (change) change(item.response.data);
      item.finish(item.response, error);
    }, cleanup() {
      gated = false;
      for (const item of [...held.values()]) item.finish(item.response);
    } };
}

test('25个八条长消息版本以最多4页并行读取，乱序响应仍完整按版本发布', async () => {
  const f = fixture(), pending = f.session.read(f.scope);
  try {
    await tick();
    assert.equal(f.held.size, 4, '第一页确定锚点后，应开始4个独立页而不是串行等待');
    assert.deepEqual(f.calls.slice(1).map(url => url.searchParams.get('through')), Array(4).fill(f.ids.at(-1)));
    for (let batch = 0; batch < 6; batch++) {
      assert.equal(f.held.size, 4);
      assert(f.visible.every(items => items.every(count => count === 0)), '未收齐前不能发布局部正文');
      for (const page of [...f.held.keys()].sort((a, b) => b - a)) f.release(page);
      await tick();
    }
    await pending;
    const state = f.session.getState();
    assert.equal(f.peak(), 4);
    assert.equal(f.calls.filter(url => url.searchParams.has('page')).length, 25);
    assert.equal(state.candidateVersions.phase, 'ready');
    assert.deepEqual(state.candidateVersions.items[0].history.versions.map(item => item.versionId), f.ids);
    assert(state.candidateVersions.items[0].history.versions.every(item => item.messages.length === 8));
    assert(f.visible.every(items => items.every(count => count === 0 || count === 25)));
  } finally { f.cleanup(); await pending.catch(() => {}); }
});

for (const fault of ['source', 'anchor', 'page-number']) {
  test(`并行页${fault}失败取消同批请求，不发布局部历史`, async () => {
    const f = fixture();
    const pending = f.session.read(f.scope).then(() => null, error => error);
    try {
      await tick();
      assert.equal(f.held.size, 4);
      if (fault === 'source') f.release(2, new BackendRequestFailure('response', 409,
        'assistant_candidate_version_conflict', 'source_unavailable'));
      else f.release(2, undefined, page => {
        if (fault === 'anchor') page.default_display_version_id = randomUUID();
        else page.page_number = 3;
      });
      const error = await pending;
      assert(error instanceof Error);
      if (fault === 'source') assert(error instanceof AssistantCandidateSourceUnavailable);
      assert.deepEqual([...f.aborted].sort(), [1, 3, 4]);
      assert.equal(f.calls.filter(url => url.searchParams.has('page')).length, 5);
      const state = f.session.getState();
      assert.equal(state.candidateVersions.phase, 'failed');
      assert.equal(state.candidateVersions.items[0].history, null);
      assert(f.visible.every(items => items.every(count => count === 0)));
    } finally { f.cleanup(); await pending; }
  });
}

test('并行读取期间切换范围取消全部旧页，迟到结果不恢复原历史', async () => {
  const f = fixture();
  const pending = f.session.read(f.scope);
  try {
    await tick();
    assert.equal(f.held.size, 4);
    const late = [...f.held.values()];
    f.session.setScope(null);
    await pending;
    for (const item of late) item.finish(item.response);
    assert.deepEqual([...f.aborted].sort(), [1, 2, 3, 4]);
    assert.deepEqual(f.session.getState().candidateVersions, { phase: 'idle', sessionId: null, items: [] });
    assert(f.visible.every(items => items.every(count => count === 0)));
  } finally { f.cleanup(); await pending.catch(() => {}); }
});


test('22版的最后不足四页仍完整收齐，不多发越界页', async () => {
  const f = fixture(22), pending = f.session.read(f.scope);
  try {
    await tick();
    for (const expected of [4, 4, 4, 4, 4, 1]) {
      assert.equal(f.held.size, expected);
      for (const page of [...f.held.keys()]) f.release(page);
      await tick();
    }
    await pending;
    assert.equal(f.calls.filter(url => url.searchParams.has('page')).length, 22);
    assert.deepEqual(f.session.getState().candidateVersions.items[0].history.versions.map(item => item.versionId), f.ids);
  } finally { f.cleanup(); await pending.catch(() => {}); }
});


test('连接世代变化后旧批次不读取后续页，也不发布旧连接历史', async () => {
  const f = fixture(), pending = f.session.read(f.scope);
  try {
    await tick();
    assert.equal(f.held.size, 4);
    f.changeGeneration();
    for (const page of [...f.held.keys()]) f.release(page);
    await pending;
    assert.equal(f.calls.filter(url => url.searchParams.has('page')).length, 5);
    assert(f.session.getState().candidateVersions.items.every(item => item.history === null));
    assert(f.visible.every(items => items.every(count => count === 0)));
  } finally { f.session.setScope(null); f.cleanup(); await pending.catch(() => {}); }
});


for (const sourceFirst of [false, true]) {
  test(`已有历史缓存时${sourceFirst ? '来源撤回先到' : '普通失败先到'}均优先处理来源撤回`, async () => {
    const f = fixture();
    f.cleanup();
    await f.session.read(f.scope);
    assert.equal(f.session.getState().candidateVersions.items[0].history.versions.length, 25);
    f.gate();
    const pending = f.session.read(f.scope).then(() => null, error => error);
    try {
      await tick();
      assert.equal(f.held.size, 4);
      // 两个公开响应均已收到，不能因普通错误先到而遗失后一个明确来源撤回。
      const ordinary = () => f.release(1, new BackendRequestFailure('response', 500, 'service_error'));
      const unavailable = () => f.release(2, new BackendRequestFailure('response', 409,
        'assistant_candidate_version_conflict', 'source_unavailable'));
      if (sourceFirst) { unavailable(); ordinary(); } else { ordinary(); unavailable(); }
      const error = await pending;
      assert(error instanceof AssistantCandidateSourceUnavailable);
      assert.deepEqual([...f.aborted].sort(), [3, 4]);
      const state = f.session.getState();
      assert.equal(state.candidateVersions.phase, 'failed');
      assert.equal(state.candidateVersions.items[0].history, null);
    } finally { f.cleanup(); await pending; }
  });
}


test('同批取消不能盖过原始分页结构错误并保留旧历史', async () => {
  const f = fixture();
  f.cleanup(); await f.session.read(f.scope); f.gate();
  const pending = f.session.read(f.scope).then(() => null, error => error);
  try {
    await tick();
    f.release(2, undefined, page => { page.default_display_version_id = randomUUID(); });
    assert(await pending instanceof Error);
    assert.deepEqual([...f.aborted].sort(), [1, 3, 4]);
    assert.equal(f.session.getState().candidateVersions.items[0].history, null);
  } finally { f.cleanup(); await pending; }
});

test('已有历史缓存时普通失败不能掩盖同批已收到的分页结构错误', async () => {
  const f = fixture();
  f.cleanup(); await f.session.read(f.scope); f.gate();
  const pending = f.session.read(f.scope).then(() => null, error => error);
  try {
    await tick();
    f.release(1, new BackendRequestFailure('response', 500, 'service_error'));
    f.release(2, undefined, page => { page.page_number = 99; });
    assert(await pending instanceof Error);
    assert.deepEqual([...f.aborted].sort(), [3, 4]);
    assert.equal(f.session.getState().candidateVersions.items[0].history, null);
  } finally { f.cleanup(); await pending; }
});

test('收到来源撤回后切换范围，旧批次不能覆盖新范围状态', async () => {
  const f = fixture(), pending = f.session.read(f.scope);
  try {
    await tick();
    f.release(2, new BackendRequestFailure('response', 409,
      'assistant_candidate_version_conflict', 'source_unavailable'));
    f.session.setScope(null);
    await pending;
    assert.deepEqual(f.session.getState().candidateVersions, { phase: 'idle', sessionId: null, items: [] });
    assert.deepEqual([...f.aborted].sort(), [1, 3, 4]);
  } finally { f.cleanup(); await pending.catch(() => {}); }
});
