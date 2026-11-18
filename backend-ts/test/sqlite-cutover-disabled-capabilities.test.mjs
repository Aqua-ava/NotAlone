import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { launchDsh } from '../src/launch.ts';
import { waitForHostReady } from './host-readiness-support.mjs';

async function startHost(t, capabilities) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-disabled-capabilities-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  const databaseId = storage.status.databaseId; await storage.close();
  const infoPath = path.join(root, 'managed/sqlite-backend.info');
  const host = await launchDsh({ nodeExecutable: process.execPath, projectDirectory: new URL('../../', import.meta.url).pathname,
    envFilePath: path.join(root, 'unused.env'), infoPath, businessHome: root, environment: {},
    sqlite: { userData: root, expectedDatabaseId: databaseId, role: 'test', capabilities } }, () => true);
  t.after(() => host.terminate());
  const info = await waitForHostReady(host, infoPath);
  const request = (route, options = {}) => fetch(`http://${info.address}${route}`, { ...options, headers: { Authorization: `Bearer ${info.token}`, ...options.headers } });
  return { host, request };
}

test('13偏好、15纠错诊断、18语音、19真实媒体与旧回复入口在SQLite宿主停用（不可用声明＋路由503）', async t => {
  const { request } = await startHost(t, ['contacts', 'discussions']);
  const status = await (await request('/api/runtime/status')).json();
  assert.equal(status.storage, 'sqlite');
  assert.deepEqual(status.capabilities, ['contacts', 'discussions']);
  for (const key of ['expressionPreferences', 'replies', 'skillLearning', 'imports', 'taskApi', 'taskManagement', 'tasks', 'mediaExtraction', 'foregroundLocation', 'contactContext']) {
    assert.equal(status.ownership[key], 'unavailable', `${key} 必须保持不可用`);
  }
  // 回复生成、Skill 学习、手动导入、媒体提取与语音转换入口：路由返回 503 且保持停用。
  for (const [route, options] of [
    ['/api/reply/generate', { method: 'POST' }],
    ['/api/skills', {}],
    ['/api/skills/anything', { method: 'POST' }],
    ['/api/imports/preview', { method: 'POST' }],
    ['/api/imports/commit', { method: 'POST' }],
    ['/api/media', {}],
    ['/api/media/extract', { method: 'POST' }],
    ['/api/contacts/synthetic/assistant-sessions', {}],
  ]) {
    const response = await request(route, options);
    assert.ok([503, 404].includes(response.status), `${route} 应为 503/404，实际 ${response.status}`);
    assert.notEqual(response.status, 200);
  }
  // 讨论能力可用的候选回复桥属于 12 已实现能力，不冒充旧 replies 生成入口。
  assert.equal(status.ownership.discussions, 'typescript');
});

test('仅联系人能力时不开放记忆、讨论、Skill、媒体提取或导入', async t => {
  const { request } = await startHost(t, ['contacts']);
  const status = await (await request('/api/runtime/status')).json();
  assert.deepEqual(status.capabilities, ['contacts']);
  for (const key of ['memory', 'memoryManagement', 'discussions', 'skills', 'skillLearning', 'imports', 'mediaExtraction']) {
    assert.equal(status.ownership[key], 'unavailable', `${key} 必须 unavailable`);
  }
  const response = await request('/api/memory/status');
  assert.ok([503, 404].includes(response.status));
});
