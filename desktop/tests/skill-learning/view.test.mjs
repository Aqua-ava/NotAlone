import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('生产待审核卡片分别展示清洗方法和真实私人依据及建议范围', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-learning-view-'));
  try {
    await symlink(path.resolve('node_modules'), path.join(owned, 'node_modules'), 'dir');
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, `export { SkillDraftCard } from ${JSON.stringify(path.resolve('src/renderer/SkillLearningPage.tsx'))};\n`
      + `export { createElement } from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};\n`
      + `export { renderToStaticMarkup } from ${JSON.stringify(path.resolve('node_modules/react-dom/server.node.js'))};\n`);
    const output = path.join(owned, 'view.mjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      jsx: 'automatic', packages: 'external', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const { SkillDraftCard, createElement, renderToStaticMarkup } = await import(pathToFileURL(output).href);
    const html = renderToStaticMarkup(createElement(SkillDraftCard, { draft: {
      draft_id: 'synthetic-draft', revision: 1, proposal_kind: 'update',
      sanitized_strategy: { name: 'careful-response', scene: '回应情绪', description: '先回应感受', document: '清洗策略',
        methods: [{ method_id: 'synthetic-method', title: '先回应感受', instruction: '随后说明情况。' }],
        scope_suggestion: { kind: 'contact', reason: '仅同联系人经验，尚未证实通用。' } },
      private_evidence: { materials: [{ material_id: 'synthetic-input', session_id: 'synthetic-session', kind: 'assistant_discussion',
        priority: 'correction', content: { correction: '合成用户纠正' }, candidates: [{candidate_id:'synthetic-candidate',message_group:[{message_id:'synthetic-fragment',text:'合成实际候选措辞'}]}], external_messages: [{ message_id: 'synthetic-message', text: '合成相关原话', speaker: 'contact' }] }],
        source_dependencies: ['synthetic-source'], existing_skills: [] },
      target_versions: [{ skill_id: 'synthetic-skill', version_id: 'synthetic-version', version_number: 2 }],
    } }));
    for (const text of ['先回应感受', '随后说明情况。', '合成用户纠正', '合成相关原话', '合成实际候选措辞', '仅同联系人经验', '版本 2', '尚未审核']) assert.ok(html.includes(text), text);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('真实回复场景输入明确可选且说明场景限定方法的使用条件', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-reply-scene-view-'));
  try {
    await symlink(path.resolve('node_modules'), path.join(owned, 'node_modules'), 'dir');
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, `export { ReplySceneInput } from ${JSON.stringify(path.resolve('src/renderer/ReplySceneInput.tsx'))};\n`
      + `export { createElement } from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};\n`
      + `export { renderToStaticMarkup } from ${JSON.stringify(path.resolve('node_modules/react-dom/server.node.js'))};\n`);
    const output = path.join(owned, 'view.mjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', jsx: 'automatic', packages: 'external',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const { ReplySceneInput, createElement, renderToStaticMarkup } = await import(pathToFileURL(output).href);
    const html = renderToStaticMarkup(createElement(ReplySceneInput, { replies: { state: { contactId: 'synthetic-contact', scene: '',
      phase: 'idle', exploration: { phase: 'idle' }, scopeRevision: 1 }, updateScene() {} } }));
    for (const text of ['本次精确场景', '可选', '空白', '场景限定', '重新生成']) assert.ok(html.includes(text), text);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('生产审核视图显示可编辑方法、明确范围、冻结版本和真实两侧结果', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-review-view-'));
  try {
    await symlink(path.resolve('node_modules'), path.join(owned, 'node_modules'), 'dir');
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, `export { SkillReviewPanel } from ${JSON.stringify(path.resolve('src/renderer/SkillLearningPage.tsx'))};\n`
      + `export { createElement } from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};\n`
      + `export { renderToStaticMarkup } from ${JSON.stringify(path.resolve('node_modules/react-dom/server.node.js'))};\n`);
    const output = path.join(owned, 'view.mjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      jsx: 'automatic', packages: 'external', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const { SkillReviewPanel, createElement, renderToStaticMarkup } = await import(pathToFileURL(output).href);
    const input = { incoming_text: '合成冻结来话', intent: '先核对事实，不承诺', scene: '核对安排' };
    const scope = { kind: 'scene', contact_id: null, scene: '核对安排' };
    const strategy = { name: 'confirm-meaning', description: '合成审核方法', scene: '核对安排',
      methods: [{ key: 'ask-first', title: '先核对', instruction: '确认安排后再作答。', replaces_method_ids: [] }] };
    const review = { contactId: 'synthetic-contact', draft: { draft_id: 'synthetic-draft', revision: 2, status: 'pending', proposal_kind: 'update',
      target_versions: [{ skill_id: 'synthetic-old-skill', version_id: 'synthetic-old-version', version_number: 1 }],
      private_evidence: { existing_skills: [{ skill_id: 'synthetic-old-skill', version_id: 'synthetic-old-version', name: 'old-confirm-meaning',
        scope: { kind: 'contact', contact_id: 'synthetic-contact', scene: null }, document: '合成原版本策略' }], materials: [], source_dependencies: [] },
      sanitized_strategy: { ...strategy, methods: strategy.methods.map(method => ({ ...method, method_id: 'synthetic-method' })), document: '清洗策略', scope_suggestion: { kind: 'contact', reason: '有限经验' } } },
      form: { strategy, input, scope }, comparison: { comparison_id: 'synthetic-comparison', draft_revision: 2,
        input_version: 'synthetic-frozen-version', input, scope, valid: true,
        before: { name: null, version_id: null, load_state: 'not_used', candidates: [{ text: '合成旧回复', basis: '旧侧依据', risk_notes: [] }] },
        after: { name: 'confirm-meaning', version_id: 'synthetic-comparison', load_state: 'loaded', candidates: [{ text: '合成新回复', basis: '新侧依据', risk_notes: ['核对承诺'] }] } },
      phase: 'ready', dirty: false, stale: false, retry: null, published: null, error: null };
    const html = renderToStaticMarkup(createElement(SkillReviewPanel, { review, actions: {} }));
    for (const text of ['保存方法编辑', '相同输入生成对照', '适用范围', '合成旧回复', '合成新回复', '旧侧依据', '新侧依据',
      'synthetic-frozen-version', '合成冻结来话', '先核对事实，不承诺', '核对承诺', '批准并发布', '私人事实', '拒绝草稿', '暂留待审',
      '版本变化与替代范围', '合成原版本策略', '原适用范围', '对照拟发布的新正文']) assert.ok(html.includes(text), text);
  } finally { await rm(owned, { recursive: true, force: true }); }
});


test('生产历史视图展示合法版本与方法映射，停用状态和写入期间禁止重复回滚', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-history-view-'));
  try {
    await symlink(path.resolve('node_modules'), path.join(owned, 'node_modules'), 'dir');
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, 'export { SkillHistoryPanel } from ' + JSON.stringify(path.resolve('src/renderer/SkillHistoryPanel.tsx')) + ';\n'
      + 'export { createElement } from ' + JSON.stringify(path.resolve('node_modules/react/index.js')) + ';\n'
      + 'export { renderToStaticMarkup } from ' + JSON.stringify(path.resolve('node_modules/react-dom/server.node.js')) + ';\n');
    const output = path.join(owned, 'view.mjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      jsx: 'automatic', packages: 'external', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const { SkillHistoryPanel, createElement, renderToStaticMarkup } = await import(pathToFileURL(output).href);
    const state = { phase: 'writing', error: null, retry: false, skills: [{ skill_id: 'synthetic-skill', name: 'confirm-meaning',
      status: 'disabled', current_version_id: 'synthetic-v2', revision: 3, versions: [{ version_id: 'synthetic-v1', version_number: 1,
        document: '合成历史策略正文', is_current: false, enabled: true, source_dependency_count: 2,
        scope: { kind: 'scene', contact_id: null, scene: '核对安排' },
        methods: [{ method_id: 'synthetic-method', title: '先核对', instruction: '合成历史方法', replaces_method_ids: ['synthetic-ancestor'], mapping_state: 'confirmed' }] }] }] };
    const html = renderToStaticMarkup(createElement(SkillHistoryPanel, { state, rollback() {}, retry() {}, close() {} }));
    for (const text of ['已停用', '合成历史策略正文', '合成历史方法', 'synthetic-method', 'synthetic-ancestor', '核对安排', '正在核验并回滚', '保留 Skill 当前']) assert.ok(html.includes(text), text);
    assert.match(html, /disabled=""[^>]*>回滚到版本 1/);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('明确停用入口要求分别选择目标与范围，不从普通措辞意见猜测长期决定', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-policy-view-'));
  try {
    await symlink(path.resolve('node_modules'), path.join(owned, 'node_modules'), 'dir');
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, `export { SkillPolicyPanel } from ${JSON.stringify(path.resolve('src/renderer/SkillPolicyPanel.tsx'))};\n`
      + `export { createElement } from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};\n`
      + `export { renderToStaticMarkup } from ${JSON.stringify(path.resolve('node_modules/react-dom/server.node.js'))};\n`);
    const output = path.join(owned, 'view.mjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      jsx: 'automatic', packages: 'external', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const { SkillPolicyPanel, createElement, renderToStaticMarkup } = await import(pathToFileURL(output).href);
    const html = renderToStaticMarkup(createElement(SkillPolicyPanel, { contactId: 'synthetic-contact',
      state: { phase: 'ready', revision: 0, policies: [], error: null, retry: false },
      skills: [{ skill_id: 'synthetic-skill', name: '合成策略', versions: [{ version_id: 'synthetic-version',
        is_current: true, methods: [{ method_id: 'synthetic-method', title: '合成做法' }] }] }],
      change() {}, undo() {}, retry() {}, close() {} }));
    for (const phrase of ['请选择具体方法或整个Skill', '请选择停用范围', '当前联系人 · 所有场景', '当前联系人 · 精确场景',
      '本人所有联系人', '所有联系人 · 精确场景', '先在当前回复中修改', '待审核草稿', '不会直接改写已发布方法']) assert(html.includes(phrase), phrase);
    assert.match(html, /disabled=""[^>]*>按此范围停用/);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('主动联系已有候选时提供明确重新生成入口，保留原次重试的独立含义', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-policy-regenerate-view-'));
  try {
    await symlink(path.resolve('node_modules'), path.join(owned, 'node_modules'), 'dir');
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, `export { ProactiveReplyInput } from ${JSON.stringify(path.resolve('src/renderer/ProactiveReplyInput.tsx'))};\n`
      + `export { createElement } from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};\n`
      + `export { renderToStaticMarkup } from ${JSON.stringify(path.resolve('node_modules/react-dom/server.node.js'))};\n`);
    const output = path.join(owned, 'view.mjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      jsx: 'automatic', packages: 'external', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const { ProactiveReplyInput, createElement, renderToStaticMarkup } = await import(pathToFileURL(output).href);
    const replies = { state: { contactId: 'synthetic-contact', purpose: '当前意图不变', phase: 'ready',
      generationBlock: null, exploration: { phase: 'idle' }, result: { replyRequestId: 'synthetic-request' }, canRetry: true,
      skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], correction: '', requirements: '', clarificationAnswer: '' } };
    const html = renderToStaticMarkup(createElement(ProactiveReplyInput, { replies }));
    assert.match(html, />重新生成<\/button>/);
    assert.match(html, />重试同一次生成<\/button>/);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
