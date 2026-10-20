import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function withSkillPage(signal, run) {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-skill-tabs-'));
  let browser;
  const stop = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const output = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/skill-learning/controller.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { SkillLearningController } = await import(pathToFileURL(output).href);
    const contactId = randomUUID(), otherId = randomUUID(), skillId = randomUUID(), versionId = randomUUID();
    let selectedContactId = contactId, scopeRevision = 1;
    const contactListeners = new Set(), writes = [], reads = [];
    const contacts = { onStateChanged: listener => { contactListeners.add(listener); return () => contactListeners.delete(listener); },
      getState: () => ({ selectedContactId, scopeRevision, directoryPhase: 'ready', contacts: [{ contactId }, { contactId: otherId }] }) };
    const logicalId = randomUUID();
    const draft = { draft_id: randomUUID(), revision: 1, status: 'pending', logical_skill_id: logicalId, proposal_kind: 'create',
      sanitized_strategy: { name: 'new-method', description: '合成新建议', scene: '核对安排', document: '先确认再回答。',
        scope_suggestion: { kind: 'contact', contact_id: contactId, reason: '仅当前联系人经验' },
        methods: [{ method_id: randomUUID(), logical_skill_id: logicalId, key: 'confirm', title: '先确认', instruction: '先核对安排。', replaces_method_ids: [], mapping_status: 'new' }] },
      private_evidence: { materials: [], existing_skills: [], source_dependencies: [] }, target_versions: [], comparison: null, last_decision: null };
    const directory = { enabled: false, scope_revision: 0, drafts: [draft], task: null, recent_outcomes: [] };
    const history = { skills: [{ skill_id: skillId, name: 'installed-method', status: 'active', revision: 1, current_version_id: versionId,
      versions: [{ version_id: versionId, version_number: 1, document: '合成已有方法正文', is_current: true, enabled: true,
        scope: { kind: 'owner', contact_id: null, scene: null }, methods: [], source_dependency_count: 0 }] }] };
    const policies = { revision: 1, policies: [{ policy_id: randomUUID(), skill_id: skillId, name: 'installed-method',
      method_id: null, scope: { kind: 'contact', contact_id: contactId, scene: null }, revision: 1 }] };
    let failHistory = false, readGate = null;
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
      if (request.method !== 'GET') { writes.push(request); throw new Error('此用例不允许写入'); }
      reads.push(request.path);
      const other = request.path.includes(otherId);
      if (readGate && request.path.endsWith(readGate.suffix)) {
        readGate.entered();
        await readGate.promise;
      }
      if (request.path.endsWith('/skills') && failHistory) throw new Error('合成读取失败');
      const data = request.path.endsWith('/skills') ? other ? { skills: [] } : history
        : request.path.endsWith('/policies') ? policies
        : request.path.includes('/drafts/') ? { draft } : { ...directory, drafts: other ? [] : directory.drafts };
      return { generation: 1, data: structuredClone(data) };
    } };
    const controller = new SkillLearningController(backend, contacts);
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.exposeFunction('skillCommand', (method, ...args) => controller[method](...args));
    const compiled = await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { SkillLearningPage } from './src/renderer/SkillLearningPage';
      import { managerPages } from './src/renderer/pages';
      const listeners = new Set();
      window.deliverSkills = state => { for (const listener of listeners) listener(state); };
      window.notalone = { skillLearning: new Proxy({}, { get: (_, method) => method === 'onStateChanged'
        ? listener => { listeners.add(listener); return () => listeners.delete(listener); }
        : (...args) => window.skillCommand(method, ...args) }) };
      const root = createRoot(document.getElementById('root'));
      window.renderContact = state => root.render(<><h1>{managerPages.skillLearning.title}</h1><SkillLearningPage session={{state}} /></>);
      window.renderContact(${JSON.stringify(contacts.getState())});
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, write: false });
    await page.route('http://127.0.0.1/skill-tabs-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://127.0.0.1/skill-tabs-test');
    const unsubscribe = controller.onStateChanged(state => { void page.evaluate(next => window.deliverSkills(next), state).catch(() => {}); });
    try {
      await page.addScriptTag({ content: compiled.outputFiles[0].text });
      await run({ page, controller, directory, writes, reads, draft,
        scope: () => ({ contactId: selectedContactId, scopeRevision }),
        failHistory: value => { failHistory = value; },
        holdRead: (suffix = '/skills') => {
          const arrived = Promise.withResolvers(), released = Promise.withResolvers();
          readGate = { suffix, entered: arrived.resolve, promise: released.promise };
          return { arrived: arrived.promise, release: () => { readGate = null; released.resolve(); } };
        },
        changeContact: async () => {
          selectedContactId = otherId; scopeRevision++;
          for (const listener of contactListeners) listener();
          await page.evaluate(state => window.renderContact(state), contacts.getState());
        } });
    } finally { unsubscribe(); }
  } finally { signal.removeEventListener('abort', stop); await browser?.close(); await rm(owned, { recursive: true, force: true }); }
}

test('Skill 默认展示已有条目，待审核独立计数并随权威刷新消失，浏览不授权学习', { timeout: 20000 }, async t => {
  await withSkillPage(t.signal, async ({ page, directory, controller, scope, writes }) => {
    await expect(page.getByRole('heading', { name: 'Skill', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '已有 Skill', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('article', { name: '版本历史 installed-method', exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: '待审核 new-method', exact: true })).toHaveCount(0);
    const pending = page.getByRole('tab', { name: '待审核 · 1', exact: true });
    await expect(pending).toBeVisible(); await pending.click();
    await expect(page.getByRole('article', { name: '待审核 new-method', exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: '版本历史 installed-method', exact: true })).toHaveCount(0);
    directory.drafts = []; await controller.refresh(scope());
    await expect(page.getByRole('tab', { name: '待审核', exact: true })).toBeVisible();
    await expect(page.getByText('暂无待审核建议。', { exact: true })).toBeVisible();
    assert.equal(writes.length, 0);
  });
});

test('无变化的后台轮询期间已有 Skill 按钮不消失、不变灰且保留焦点', { timeout: 20000 }, async t => {
  await withSkillPage(t.signal, async ({ page, controller, scope, holdRead, reads }) => {
    const refresh = page.getByRole('button', { name: '刷新已有 Skill', exact: true });
    const policies = page.getByRole('button', { name: '管理方法停用', exact: true });
    await expect(policies).toBeVisible();
    await policies.focus();
    const gate = holdRead();
    const polling = controller.poll(scope());
    let repeated;
    try {
      await gate.arrived;
      await expect(policies).toBeVisible({ timeout: 1000 });
      await expect(refresh).toBeEnabled({ timeout: 1000 });
      await expect(policies).toBeFocused();
      const count = reads.length;
      repeated = controller.poll(scope());
      await Promise.resolve();
      assert.equal(reads.length, count, '上一轮未结束时共享当前读取，不重发请求或取消在途核验');
    } finally { gate.release(); await Promise.all([polling, repeated]); }
  });
});

test('后台轮询保留经验整理开关及停用列表按钮，失败仍撤下旧历史', { timeout: 20000 }, async t => {
  await withSkillPage(t.signal, async ({ page, controller, scope, holdRead, failHistory }) => {
    await expect(page.getByRole('button', { name: '管理方法停用', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '待审核 · 1', exact: true }).click();
    const configure = page.getByRole('button', { name: '开启此联系人的经验整理', exact: true });
    const directoryGate = holdRead('/skill-learning');
    const directoryRead = controller.poll(scope());
    try {
      await directoryGate.arrived;
      await expect(configure).toBeEnabled({ timeout: 1000 });
      await page.getByRole('button', { name: '刷新待审核', exact: true }).click();
      await expect(configure).toBeDisabled({ timeout: 1000 });
    } finally { directoryGate.release(); await directoryRead; }
    await expect(configure).toBeEnabled();

    await page.getByRole('tab', { name: '已有 Skill', exact: true }).click();
    await page.getByRole('button', { name: '管理方法停用', exact: true }).click();
    const undo = page.getByRole('button', { name: '撤销此停用', exact: true });
    await expect(undo).toBeEnabled(); await undo.focus();
    const policyGate = holdRead('/policies');
    const policyRead = controller.poll(scope());
    try {
      await policyGate.arrived;
      await expect(undo).toBeVisible({ timeout: 1000 });
      await expect(undo).toBeEnabled({ timeout: 1000 });
      await expect(undo).toBeFocused();
    } finally { policyGate.release(); await policyRead; }
    failHistory(true);
    await controller.poll(scope());
    await expect(page.getByRole('article', { name: '版本历史 installed-method', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toBeVisible();
  });
});

test('页签切换保留未保存审核编辑，换联系人后恢复已有页签并清除旧建议和数量', { timeout: 20000 }, async t => {
  await withSkillPage(t.signal, async ({ page, changeContact }) => {
    await expect(page.getByRole('article', { name: '版本历史 installed-method', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '待审核 · 1', exact: true }).click();
    await page.getByRole('button', { name: '打开对照审核', exact: true }).click();
    const description = page.getByRole('textbox', { name: '方法描述', exact: true });
    await description.fill('合成未保存的编辑');
    await page.getByRole('tab', { name: '已有 Skill', exact: true }).click();
    await expect(page.getByRole('article', { name: '版本历史 installed-method', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '待审核 · 1', exact: true }).click();
    await expect(description).toHaveValue('合成未保存的编辑');
    await changeContact();
    await expect(page.getByRole('tab', { name: '已有 Skill', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '待审核', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '方法描述', exact: true })).toHaveCount(0);
    await expect(page.getByRole('article')).toHaveCount(0);
    await expect(page.getByText('当前没有可查看的有效发布版本。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '管理方法停用', exact: true })).toBeEnabled();
  });
});

test('已有 Skill 读取失败可显式刷新恢复，键盘可切换两个页签', { timeout: 20000 }, async t => {
  await withSkillPage(t.signal, async ({ page, failHistory }) => {
    await expect(page.getByRole('article', { name: '版本历史 installed-method', exact: true })).toBeVisible();
    failHistory(true);
    await page.getByRole('button', { name: '刷新已有 Skill', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(0);
    failHistory(false);
    await page.getByRole('button', { name: '刷新已有 Skill', exact: true }).click();
    await expect(page.getByRole('article', { name: '版本历史 installed-method', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '已有 Skill', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '待审核 · 1', exact: true })).toBeFocused();
    await expect(page.getByRole('article', { name: '待审核 new-method', exact: true })).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: '已有 Skill', exact: true })).toBeFocused();
  });
});
