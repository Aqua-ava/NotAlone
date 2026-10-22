import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

// 记忆卡片接线：正文与单一操作入口后的卡片不得重新暴露版本历史和技术元数据。
const require = createRequire(path.resolve('package.json'));
const compiled = await build({
  stdin: { contents: `export { MemoryCard } from './src/renderer/MemoryPage';`, resolveDir: process.cwd() },
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

function renderCard(entry) {
  return renderToStaticMarkup(createElement(ports.MemoryCard, {
    content: entry, memory: entry, sources: { phase: 'ready', items: [] }, trace: () => {},
  }));
}

test('记忆卡片不展示版本历史和详细元数据', () => {
  assert.doesNotMatch(renderCard(active), /查看版本历史|来源日期|适用性|置信度|记忆标识/);
  assert.doesNotMatch(renderCard(previous), /查看版本历史/);
});

test('记忆页接线复用既有 preload 能力，不新增通道并保留 correctionTarget 依赖', () => {
  assert.match(pageSource, /layeredMemory\.value\?\.correctionTarget/, '必须保留既有纠错定位依赖');
  assert.doesNotMatch(pageSource, /invoke\(/, 'renderer 不得直接新增 IPC 通道');
});
