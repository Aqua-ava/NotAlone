import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

// 记忆 UI 接线：版本历史、撤销自动更新与联系人/本人关系概览必须能在记忆页渲染。
const require = createRequire(path.resolve('package.json'));
const compiled = await build({
  stdin: { contents: `export { MemorySecondaryPanels, MemoryCard } from './src/renderer/MemoryPage';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const ports = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const createElement = React.createElement;
const pageSource = await readFile('src/renderer/MemoryPage.tsx', 'utf8');

const ids = { contact: '11111111-1111-4111-8111-111111111111', current: '22222222-2222-4222-8222-222222222222',
  previous: '33333333-3333-4333-8333-333333333333', message: '44444444-4444-4444-8444-444444444444',
  source: '55555555-5555-4555-8555-555555555555' };
const timing = { recordedAt: '2026-10-14T11:00:00+08:00', sourceStartedAt: '2026-08-01T10:00:00+08:00',
  sourceEndedAt: '2026-08-01T10:00:00+08:00', sourceTimeComplete: true,
  currentStatus: 'current_unverified', currentStatusReason: '合成状态未核实。' };
function memory(overrides = {}) {
  return { memoryId: ids.current, level: 'contact', text: '合成自动更新的当前资料。', category: 'relationship_note',
    topic: 'other', sourceIds: [ids.source], confidence: 0.9, riskFlags: [], status: 'active', adoptionMethod: 'auto',
    revision: 2, supersedesMemoryId: ids.previous, sourceCandidateId: null, validAt: null, invalidAt: null,
    event: null, timing, canRevertAutoUpdate: true, ...overrides };
}
const active = memory();
const previous = memory({ memoryId: ids.previous, text: '合成自动更新的上一版资料。', revision: 1,
  status: 'invalidated', retirementReason: 'state_changed', canRevertAutoUpdate: undefined });
const history = { phase: 'ready', items: [active, previous], memoryId: ids.current, level: 'contact' };
const idleHistory = { phase: 'idle', items: [], memoryId: null, level: null };
const overview = { phase: 'ready', value: { version: 1, scopeKind: 'contact', contactId: ids.contact,
  projectionRevision: 'a'.repeat(64), memoryRevision: 3, builtAt: '2026-10-14T12:00:00+08:00',
  entries: [{ memory: active, isLatest: true, currentLeaf: { memoryId: ids.current, revision: 2 },
    provenance: { kind: 'source_supported', references: [{ sourceId: ids.source, sourceKind: 'source_document',
      messageId: ids.message, sourceRefId: null, locator: '合成记录第 1 条' }] } }] } };
const ownerOverview = { phase: 'ready', value: { version: 1, scopeKind: 'owner', contactId: null,
  projectionRevision: 'b'.repeat(64), memoryRevision: 1, builtAt: '2026-10-14T12:00:00+08:00',
  entries: [{ memory: memory({ level: 'owner', text: '合成本人偏好资料。', adoptionMethod: 'manual',
    supersedesMemoryId: null, canRevertAutoUpdate: undefined }), isLatest: true,
  currentLeaf: { memoryId: ids.current, revision: 2 },
  provenance: { kind: 'manual_entry', references: [{ sourceId: ids.source, sourceKind: 'manual',
    messageId: null, sourceRefId: null, locator: null }] } }] } };
const noop = async () => {};

function renderPanels(view, overrides = {}) {
  return renderToStaticMarkup(createElement(ports.MemorySecondaryPanels, {
    view, history, overview, ownerOverview,
    memories: { phase: 'ready', items: [active] }, ownerMemories: { phase: 'ready', items: [active] },
    contactId: ids.contact, openVersions: noop, revert: noop, refreshOverview: noop, refreshOwnerOverview: noop,
    trace: () => {}, ...overrides,
  }));
}

test('联系人版本历史接回记忆页：展示关系概览、版本链与撤销自动更新入口', () => {
  const html = renderPanels('contact');
  assert.match(html, /联系人经历与关系变化/);
  assert.match(html, /合成自动更新的当前资料/);
  assert.match(html, /资料版本历史/);
  assert.match(html, /合成自动更新的上一版资料/);
  assert.match(html, /撤销本次自动更新/);
  assert.doesNotMatch(html, /本人事实与偏好概览/);
});

test('本人概览接回记忆页：展示本人事实偏好与本人层版本历史', () => {
  const html = renderPanels('owner', { history: { ...history, level: 'owner' } });
  assert.match(html, /本人事实与偏好概览/);
  assert.match(html, /合成本人偏好资料/);
  assert.match(html, /资料版本历史/);
  assert.doesNotMatch(html, /联系人经历与关系变化/);
});

test('版本历史为空时不渲染空壳，待确认页不展示概览与历史', () => {
  assert.doesNotMatch(renderPanels('contact', { history: idleHistory }), /资料版本历史/);
  const pending = renderPanels('pending');
  assert.doesNotMatch(pending, /资料版本历史|联系人经历与关系变化|本人事实与偏好概览/);
});

test('记忆卡片不展示版本历史和详细元数据', () => {
  const renderCard = (entry) => renderToStaticMarkup(createElement(ports.MemoryCard, {
    content: entry, memory: entry, sources: { phase: 'ready', items: [] }, trace: () => {}, openVersions: noop,
  }));
  assert.doesNotMatch(renderCard(active), /查看版本历史|来源日期|适用性|置信度|记忆标识/);
  assert.doesNotMatch(renderCard(previous), /查看版本历史/);
});

test('记忆页接线复用既有 preload 能力，不新增通道并保留 correctionTarget 依赖', () => {
  assert.match(pageSource, /<MemorySecondaryPanels/);
  assert.match(pageSource, /openVersions=\{openVersions\}/);
  assert.match(pageSource, /refreshOverview\(\{ contactId/);
  assert.match(pageSource, /refreshOwnerOverview\(\{ contactId/);
  assert.match(pageSource, /revert=\{memory\.revertAutoUpdate\}/);
  assert.match(pageSource, /layeredMemory\.value\?\.correctionTarget/, '必须保留既有纠错定位依赖');
  assert.doesNotMatch(pageSource, /invoke\(/, 'renderer 不得直接新增 IPC 通道');
});
