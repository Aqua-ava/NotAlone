// 独立管理后台 + 输入法式小窗；所有资料和操作都是内存中的合成演示。
const variants = { A: '横向候选栏', B: '纵向候选窗', C: '单行工具条' };
const contacts = [
  { id: 'c1', name: '小岑', relation: '同事', color: 'green', initial: '岑', count: 128,
    latest: '这版方案你怎么看？我们想周五定下来。',
    previous: '上次讨论的调整，我已经放到新版本里了。' },
  { id: 'c2', name: '阿禾', relation: '朋友', color: 'orange', initial: '禾', count: 86,
    latest: '周六一起出去走走吗？好久没见了。',
    previous: '最近总算没那么忙了。' },
  { id: 'c3', name: '小悠', relation: '家人', color: 'blue', initial: '悠', count: 54,
    latest: '今晚回家吃饭吗？我准备买菜啦。',
    previous: '天气凉了，记得带件外套。' },
];
const chats = contacts.map((contact) => ({ id: `wx-${contact.id}`, contactId: contact.id, title: contact.name }));
const sampleDraft = '整体方向我觉得可以。预算我还要再确认一下，确认后我再给你答复。';
const sampleCandidates = [
  { label: '贴近原稿', text: '整体方向我觉得可以，预算我还需要再确认一下。确认后我再给你答复。' },
  { label: '更简洁', text: '方向可以，预算还需确认，确认后我再回复你。' },
  { label: '更自然', text: '整体方向没问题，预算我还想确认一下，确认后再给你答复。' },
];
const sampleMemories = [
  { id: 'm1', contactId: 'c1', text: '讨论方案时，先讲结论，再讲待确认的事项。', kind: '用户确认',
    source: '合成历史 · 第 18 条', date: '10 月 6 日' },
  { id: 'm2', contactId: 'c1', text: '工作沟通通常使用简短、直接的表达。', kind: '自动采纳 · 可撤销',
    source: '合成历史 · 第 42–48 条', date: '10 月 7 日' },
  { id: 'm3', contactId: 'c2', text: '喜欢散步，见面安排倾向周末。', kind: '用户确认',
    source: '合成历史 · 第 12 条', date: '10 月 5 日' },
];
const previewParams = new URL(location.href).searchParams;
const requestedVariant = previewParams.get('variant');
const requestedSurface = previewParams.get('surface') === 'manager' || (!previewParams.has('surface') && !requestedVariant) ? 'manager' : 'ime';
const state = {
  variant: variants[requestedVariant] ? requestedVariant : 'A',
  surface: requestedSurface, view: requestedSurface === 'manager' ? 'manager' : 'helper',
  running: true, configured: true, owner: '合成用户', managerHidden: false,
  wxChat: 'wx-c1', contactId: 'c1', pendingContact: '', pickerOpen: false,
  bindings: { 'wx-c1': 'c1' }, selectedBindings: new Set(['wx-c1']),
  bindingTargets: { 'wx-c1': 'c1', 'wx-c2': '', 'wx-c3': '' },
  syncEnabled: true, mode: 'rewrite', draft: sampleDraft, direction: '', tone: '原样',
  useContext: false, candidates: sampleCandidates.map((item) => ({ ...item,
    basis: { snapshot: contacts[0].latest, mode: 'rewrite', useContext: false, tone: '原样', contactId: 'c1' },
  })), selected: 0,
  snapshot: contacts[0].latest, dirty: false, generating: false,
  settingsOpen: false, editorOpen: false, popupOpen: false,
  newMessages: {}, copyBuffer: null,
  managerTab: ['contacts', 'import', 'memory', 'sync', 'config'].includes(previewParams.get('tab')) ? previewParams.get('tab') : 'contacts',
  importContact: '', importReady: false, importDone: false, importedContact: '',
  memories: sampleMemories.map((item) => ({ ...item })), memoryContact: 'c1',
  editingMemory: null, memoryEdit: '', ownerEdit: '合成用户',
  position: { x: 0, y: 0 }, toast: '', inspectorOpen: false,
};
const app = document.querySelector('#app');
let generationSerial = 0;
const escape = (value = '') => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const contact = () => contacts.find((item) => item.id === state.contactId);
const chat = () => chats.find((item) => item.id === state.wxChat);
const wxContact = () => contacts.find((item) => item.id === chat().contactId);
const canGenerate = () => state.running && state.configured && !!state.contactId && !state.generating &&
  !!(state.mode === 'rewrite' ? state.draft.trim() : state.direction.trim());
const icon = (name, size = 18) => {
  const paths = {
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    left: '<path d="m14 6-6 6 6 6"/>',
    right: '<path d="m10 6 6 6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    contacts: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5"/>',
    import: '<path d="M4 15v5h16v-5M12 3v12m-5-5 5 5 5-5"/>',
    memory: '<path d="M4 5h6a2 2 0 0 1 2 2v14a4 4 0 0 0-4-3H4V5Zm16 0h-6a2 2 0 0 0-2 2v14a4 4 0 0 1 4-3h4V5Z"/>',
    sync: '<path d="M20 7h-5l3-3M4 17h5l-3 3M4 9a8 8 0 0 1 14-5M20 15a8 8 0 0 1-14 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    message: '<path d="M20 4H4v12h5l3 4 3-4h5V4Z"/>',
    pin: '<path d="m9 3-1 6-3 3h14l-3-3-1-6H9Zm3 9v9"/>',
    power: '<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
};
function avatar(item, small = false) {
  return `<span class="avatar ${item.color} ${small ? 'small' : ''}">${item.initial}</span>`;
}
function options(selected = '', placeholder = '请选择联系人') {
  return `<option value="">${placeholder}</option>${contacts.map((item) =>
    `<option value="${item.id}" ${selected === item.id ? 'selected' : ''}>${item.name} · ${item.relation}</option>`).join('')}`;
}
function notify(message) {
  state.toast = message;
  const toast = document.querySelector('#toast');
  if (toast) { toast.textContent = message; toast.classList.add('visible'); }
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    state.toast = '';
    document.querySelector('#toast')?.classList.remove('visible');
  }, 3000);
}
// A / B / C 只比较输入法式小窗：横向候选栏、纵向候选窗、单行工具条。
// 使用经典脚本中的具名函数，预览不依赖模块加载或构建工具。
function imeHeader() {
  const item = contact();
  return `<div class="ime-header drag-handle">
    <button class="contact-pill" data-action="choose-contact" aria-label="确认或切换联系人">${item ? `<span class="contact-dot"></span><b>${item.name}</b>${icon('down', 11)}` : '选择联系人'}</button>
    <span class="binding-hint">${item ? (state.bindings[state.wxChat] === item.id ? '已绑定' : '本次确认') : '未确认'}</span>
    <div class="ime-modes" role="group" aria-label="写作方式"><button class="${state.mode === 'rewrite' ? 'active' : ''}" data-action="mode" data-value="rewrite" aria-label="改写草稿">改写</button><button class="${state.mode === 'reply' ? 'active' : ''}" data-action="mode" data-value="reply" aria-label="帮我回复">回复</button></div>
    <button class="icon-button" data-action="toggle-settings" aria-label="本次表达要求">${icon('settings', 15)}</button>
    <a class="icon-button" href="./index.html?surface=manager" target="_blank" rel="noopener" aria-label="打开独立管理后台">${icon('contacts', 15)}</a>
    <button class="icon-button" data-action="hide-helper" aria-label="收起输入小窗">${icon('close', 15)}</button>
  </div>${contactPicker()}${contextNotice()}${state.settingsOpen ? expressionSettings() : ''}`;
}
function contactPicker() {
  if (contact() && !state.pickerOpen) return '';
  return `<div class="contact-picker"><p>请确认这次回复发给谁。</p><div class="inline-row"><select data-field="pending-contact" aria-label="本次回复的联系人">${options(state.pendingContact)}</select><button class="button primary" data-action="confirm-contact">确认</button></div><small>本次确认不扩大后台读取范围。</small></div>`;
}
function contextNotice() {
  if (!state.configured) return '<div class="notice">请先在管理后台完成配置。</div>';
  if (state.dirty) return '<div class="notice"><span>有新消息，草稿与候选已保留。</span><button data-action="refresh-context">更新上下文</button></div>';
  return '';
}
function expressionSettings() {
  return `<div class="expression-settings"><span>仅本次</span><div class="tone-options">${['原样', '更短', '温和', '直接'].map((tone) => `<button class="chip ${state.tone === tone ? 'selected' : ''}" data-action="tone" data-value="${tone}">${tone}</button>`).join('')}</div><label><input type="checkbox" data-field="use-context" ${state.useContext ? 'checked' : ''}/>参考关系背景</label></div>`;
}
function compactInput() {
  const rewrite = state.mode === 'rewrite';
  return `<div class="ime-input"><textarea rows="1" wrap="off" data-field="${rewrite ? 'draft' : 'direction'}" aria-label="${rewrite ? '草稿' : '回复方向'}" placeholder="${rewrite ? '写下你的意思…' : '先写回复方向，例如：认可方向，但预算还需确认…'}">${escape(rewrite ? state.draft : state.direction)}</textarea><button class="generate-button" data-action="generate" aria-label="生成候选" title="生成候选 · ⌘ / Ctrl + Enter" ${canGenerate() ? '' : 'disabled'}>${state.generating ? '<span class="loading-dot">···</span>' : icon('spark', 17)}</button></div>`;
}
function copyActions(index = state.selected) {
  return `<div class="copy-actions"><button data-action="copy" data-index="${index}">${icon('copy', 13)}复制</button><button class="copy-hide" data-action="copy-hide" data-index="${index}">复制并收起</button></div>`;
}
function sourceEvidence(index = state.selected) {
  const basis = state.candidates[index]?.basis || state;
  return `<details class="evidence"><summary>依据 ${icon('down', 10)}</summary><p>联系人：${contacts.find((item) => item.id === basis.contactId)?.name || '未确认'}；${basis.mode === 'rewrite' ? '生成时的草稿' : '你填写的回复方向'}；语气：${basis.tone}。</p><p>会话快照：「${escape(basis.snapshot)}」</p><p>${basis.mode === 'reply' || basis.useContext ? '参考同一联系人的合成历史，第 18 条。' : '本次未使用关系资料。'} 修改后请核对事实与承诺。</p><small>合成来源 · 一次性要求不写入长期偏好</small></details>`;
}
function candidateEditor(index = state.selected) {
  if (!state.candidates[index]) return '';
  return `<div class="candidate-editor" role="region" aria-label="编辑所选候选"><div class="editor-heading"><span>${index + 1} · ${state.candidates[index].label}</span><button class="icon-button" data-action="close-editor" aria-label="收起候选编辑">${icon('close', 13)}</button></div><textarea rows="2" data-field="candidate" data-index="${index}" aria-label="候选 ${index + 1}">${escape(state.candidates[index].text)}</textarea><div class="editor-actions">${sourceEvidence(index)}${copyActions(index)}</div></div>`;
}
function imeFooter() {
  return `<div class="ime-footer"><span>${state.candidates.length ? `已选 ${state.selected + 1} · ${state.candidates[state.selected].label}` : (state.mode === 'reply' ? '先明确回复方向' : '先输入草稿') } · 手动发送</span>${state.candidates.length ? `<button class="text-button" data-action="edit-selected">编辑</button>${copyActions()}` : ''}</div>`;
}
function VariantA() {
  return `<section class="ime-pane ime-a" role="dialog" aria-label="输入小窗：横向候选栏">${imeHeader()}${compactInput()}<div class="horizontal-candidates">${state.candidates.map((item, index) => `<button class="candidate-chip ${state.selected === index ? 'active' : ''}" data-action="select-candidate" data-index="${index}" title="${escape(item.text)}"><span>${index + 1}</span><div><b>${item.label}</b><p>${escape(item.text)}</p></div></button>`).join('') || '<p class="empty-hint">输入后生成 2–3 个候选</p>'}</div>${imeFooter()}${state.editorOpen ? candidateEditor() : ''}</section>`;
}
function VariantB() {
  return `<section class="ime-pane ime-b" role="dialog" aria-label="输入小窗：纵向候选窗">${imeHeader()}${compactInput()}<ol class="vertical-candidates">${state.candidates.map((item, index) => `<li class="${state.selected === index ? 'active' : ''}"><button data-action="select-candidate" data-index="${index}"><span>${index + 1}</span><p>${escape(item.text)}</p><small>${item.label}</small></button>${state.editorOpen && state.selected === index ? candidateEditor(index) : ''}</li>`).join('') || '<li class="empty-hint">输入后生成 2–3 个候选</li>'}</ol>${imeFooter()}</section>`;
}
function VariantC() {
  const item = contact();
  return `<section class="ime-pane ime-c" role="dialog" aria-label="输入小窗：单行工具条"><div class="single-toolbar drag-handle">
    <button class="contact-pill" data-action="choose-contact" aria-label="确认或切换联系人"><span class="contact-dot"></span>${item?.name || '选联系人'} ${icon('down', 10)}</button>
    <button class="inline-mode" data-action="mode-toggle" aria-label="切换写作方式">${state.mode === 'rewrite' ? '改写' : '回复'}</button>
    ${compactInput()}<button class="candidate-count" data-action="toggle-popup" aria-label="展开候选列表">${state.candidates.length} 候选 ${icon('down', 11)}</button>
    <button class="icon-button" data-action="toggle-settings" aria-label="本次表达要求">${icon('settings', 15)}</button>
    <a class="icon-button" href="./index.html?surface=manager" target="_blank" rel="noopener" aria-label="打开独立管理后台">${icon('contacts', 15)}</a>
    <button class="icon-button" data-action="hide-helper" aria-label="收起输入小窗">${icon('close', 14)}</button></div>
    ${contactPicker()}${contextNotice()}${state.settingsOpen ? expressionSettings() : ''}
    ${state.popupOpen ? `<div class="candidate-popup"><div class="popup-heading">选择一句 · 手动发送</div>${state.candidates.map((candidate, index) => `<button class="popup-choice ${state.selected === index ? 'active' : ''}" data-action="select-candidate" data-index="${index}"><span>${index + 1}</span><p>${escape(candidate.text)}</p></button>`).join('') || '<p class="empty-hint">先输入草稿或回复方向</p>'}${state.editorOpen ? candidateEditor() : imeFooter()}</div>` : ''}
  </section>`;
}

const managerTabs = { contacts: ['contacts', '联系人与绑定'], import: ['import', '历史导入'], memory: ['memory', '关系记忆'], sync: ['sync', '后台同步'], config: ['settings', '基础配置'] };
function manager() {
  const reading = state.running && state.syncEnabled && Object.keys(state.bindings).length > 0;
  return `<div class="admin-layout"><aside class="admin-sidebar"><div class="admin-brand"><span class="brand-symbol">n</span><div><b>NotAlone</b><small>关系回复管理后台</small></div></div><span class="sidebar-label">工作区</span><nav>${Object.entries(managerTabs).map(([key, [symbol, label]]) => `<button class="${state.managerTab === key ? 'active' : ''}" data-action="manager-tab" data-value="${key}">${icon(symbol, 18)}${label}</button>`).join('')}</nav><div class="sidebar-help"><span class="status-dot ${reading ? '' : 'off'}"></span><b>${reading ? '后台同步中' : '后台读取已停止'}</b><p>${Object.keys(state.bindings).length} 个已确认会话</p></div></aside>
    <div class="admin-workspace"><header class="admin-topbar"><span>工作区 <i>/</i> ${managerTabs[state.managerTab][1]}</span><div><span class="prototype-badge">原型 · 合成资料</span><a class="button primary" href="./index.html?surface=ime&variant=A" target="_blank" rel="noopener">打开输入小窗 ${icon('right', 14)}</a></div></header>
    <main class="manager-content" aria-label="管理后台">${managerContent()}</main><footer class="admin-footer">资料按联系人分开管理 · 回复始终由你选择并亲自发送</footer></div></div>`;
}

function managerTitle(title, description) {
  return `<div class="manager-title"><span class="eyebrow">${managerTabs[state.managerTab][1]}</span><h1>${title}</h1><p>${description}</p></div>`;
}
function managerContent() {
  if (state.managerTab === 'contacts') return `${managerTitle('每一句，都有明确的对象。', '先确认微信会话对应的联系人，再单独选择后台同步范围。')}
    <div class="contact-summary">${contacts.map((item) => `<div>${avatar(item, true)}<span><b>${item.name}</b><small>${item.relation} · ${item.count} 条合成历史</small></span></div>`).join('')}</div>
    <div class="section-heading"><h3>微信会话与读取范围</h3><span>首次默认不选 · 新会话不自动授权</span></div>
    <div class="binding-table"><div class="table-heading"><span>微信会话</span><span>对应联系人</span><span>允许后台读取</span></div>
      ${chats.map((entry) => `<div class="binding-row"><span><b>${entry.title}</b><small>${state.bindings[entry.id] ? '已确认绑定' : '等待确认'}</small></span>
      <select data-field="binding-target" data-id="${entry.id}" aria-label="${entry.title}的对应联系人">${options(state.bindingTargets[entry.id])}</select>
      <label class="scope-checkbox"><input type="checkbox" data-field="binding-scope" data-id="${entry.id}" aria-label="${entry.title}会话允许后台读取" ${state.selectedBindings.has(entry.id) ? 'checked' : ''}/><span>授权</span></label></div>`).join('')}
    </div><div class="manager-actions"><p>确认范围后，只有勾选并绑定的会话可以后台读取。</p><button class="button primary" data-action="confirm-bindings">确认绑定与范围</button></div>`;
  if (state.managerTab === 'import') return `${managerTitle('从一位联系人的历史开始。', '一次导入只属于一位联系人。多联系人混合资料需要先拆分。')}
    <div class="import-layout"><div class="import-dropzone">${icon('import', 32)}<h3>导入聊天历史</h3><p>选择一份历史，再确认它属于谁。<br/>本页使用一份 24 条消息的合成样例。</p><button class="button" data-action="load-import">选择合成样例</button></div>
    <div class="import-preview"><span class="step-label"><span>01</span> 确认归属</span><label class="field-heading" for="import-contact">这份历史属于谁？</label><select id="import-contact" data-field="import-contact">${options(state.importContact)}</select>
      <div class="import-facts"><p><span>消息</span><b>${state.importReady ? '24 条' : '等待选择'}</b></p><p><span>会话</span><b>${state.importReady ? '1 位联系人' : '—'}</b></p><p><span>处理</span><b>${state.importDone ? '模拟导入完成' : '确认后导入'}</b></p></div>
      <button class="button primary" data-action="import" ${state.importReady && state.importContact && !state.importDone ? '' : 'disabled'}>确认归属并模拟导入</button>
    </div></div>
    ${state.importDone ? `<div class="success-panel">${icon('check')}<div><b>已模拟导入到${contacts.find((item) => item.id === state.importedContact).name}</b><p>24 条合成消息有独立来源；关系候选不会标成用户确认。</p></div></div>` : '<p class="panel-note">请选择单联系人样例，并明确确认资料归属。</p>'}`;
  if (state.managerTab === 'memory') return `${managerTitle('让背景可见，也可改。', '自动采纳带来源、可撤销；本次回复策略不会静默成为长期偏好。')}
    <div class="memory-filter"><label>查看联系人</label><select data-field="memory-contact" aria-label="查看谁的记忆">${options(state.memoryContact)}</select></div>
    <div class="memory-list">${state.memories.filter((item) => item.contactId === state.memoryContact).map((item) => `<article class="memory-card">
      <div class="memory-badges"><span class="badge ${item.kind.startsWith('自动') ? 'auto' : ''}">${item.kind}</span><span>${item.date}</span></div>
      ${state.editingMemory === item.id ? `<textarea data-field="memory-edit" rows="2" aria-label="修正记忆">${escape(state.memoryEdit)}</textarea>` : `<p>${escape(item.text)}</p>`}
      <div class="memory-bottom"><details><summary>查看来源</summary><p>${item.source}<br/>合成资料 · 仅属于${contacts.find((entry) => entry.id === item.contactId).name}</p></details>
      <div>${state.editingMemory === item.id ? `<button class="text-button" data-action="save-memory" data-id="${item.id}">保存修正</button>` : `<button class="text-button" data-action="edit-memory" data-id="${item.id}">修正</button>`}<button class="text-button danger" data-action="delete-memory" data-id="${item.id}">${item.kind.startsWith('自动') ? '撤销采纳' : '删除'}</button></div></div>
    </article>`).join('') || '<div class="empty-candidates"><p>这位联系人暂无合成关系记忆。</p></div>'}</div>`;
  if (state.managerTab === 'sync') {
    const enabled = state.running && state.syncEnabled && Object.keys(state.bindings).length;
    return `${managerTitle('读取多少，由你决定。', '后台文字同步与前台 OCR 分开控制；关闭或退出时停止读取。')}
      <div class="sync-control"><div><span class="eyebrow">后台文字同步</span><h2>${enabled ? '已开启' : '已停止'}</h2><p>${Object.keys(state.bindings).length} 个已确认会话 · 新会话不自动授权</p></div><button class="switch ${enabled ? 'on' : ''}" data-action="toggle-sync" role="switch" aria-checked="${!!enabled}" aria-label="后台同步总开关"><span></span></button></div>
      <div class="section-heading"><h3>已确认的范围</h3><button class="text-button" data-action="manage-bindings">修改范围 ${icon('right', 14)}</button></div>
      <div class="sync-scopes">${Object.entries(state.bindings).map(([id, cid]) => `<div>${avatar(contacts.find((item) => item.id === cid), true)}<span><b>${chats.find((item) => item.id === id).title}</b><small>${enabled ? '已模拟同步 · 仅此会话' : '停读 · 下次开启按已确认范围补齐'}</small></span><span class="badge">${enabled ? '已追平' : '已停止'}</span></div>`).join('') || '<p class="panel-note">尚无已确认会话，请先选择联系人和读取范围。</p>'}</div>
      <div class="ocr-note">${icon('message', 20)}<div><b>前台 OCR：仅定位当前微信会话</b><p>原始画面默认在端侧内存处理。这里不采集、不上传，也不以 OCR 作为后台文字同步门禁。</p></div><span class="badge">原型未接入</span></div>`;
  }
  return `${managerTitle('先把自己的环境准备好。', '这里演示配置的位置与流程；无需填写任何真实账号或密钥。')}
    <div class="config-form"><label for="owner-name">使用者名称</label><input id="owner-name" data-field="owner-edit" value="${escape(state.ownerEdit)}" placeholder="合成用户"/>
      <label for="model-name">模型服务</label><select id="model-name" aria-label="合成模型服务"><option>演示模型 · 仅示意</option></select>
      <label for="model-key">API 密钥</label><input id="model-key" type="password" disabled placeholder="原型不收集真实密钥"/>
      <div class="config-status"><span class="status-dot ${state.configured ? '' : 'off'}"></span>${state.configured ? '已模拟配置完成' : '尚未配置'}</div>
      <button class="button primary" data-action="save-config">保存模拟配置</button>
    </div><div class="onboarding-path"><span>首次使用</span><b>配置 → 单联系人导入 → 确认会话与范围 → 呼出浮窗</b></div>`;
}
function stateSnapshot() {
  return {
    独立界面: state.surface, 布局: state.variant, 显示窗口: state.view, 管理页面: state.managerTab,
    应用运行: state.running, 管理后台已隐藏: state.managerHidden, 使用者: state.owner, 配置完成: state.configured,
    本次联系人: state.contactId || '未确认', 当前会话标识: state.wxChat,
    已确认绑定: state.bindings, 待确认读取范围: [...state.selectedBindings],
    后台总开关: state.syncEnabled, 实际模拟读取: state.running && state.syncEnabled && Object.keys(state.bindings).length > 0,
    写作方式: state.mode, 草稿: state.draft, 回复方向: state.direction,
    本次语气: state.tone, 参考关系背景: state.useContext, 会话快照: state.snapshot,
    有待刷新消息: state.dirty, 候选: state.candidates, 当前候选: state.selected + 1,
    编辑已展开: state.editorOpen, 候选弹层已展开: state.popupOpen, 模拟复制: state.copyBuffer,
    导入: { 已选择样例: state.importReady, 目标联系人: state.importContact, 已完成: state.importDone },
    关系记忆: state.memories, 浮窗位置: state.position,
  };
}
function stateSummary() {
  return `${contact()?.name || '未确认联系人'} · ${state.candidates.length} 个候选 · ${state.running && state.syncEnabled && Object.keys(state.bindings).length ? '后台读取中' : '已停读'}`;
}
function prototypeControls() {
  return `<aside class="prototype-console" aria-label="原型操作与状态"><details id="prototype-tools" ${state.inspectorOpen ? 'open' : ''}><summary><span class="prototype-dot"></span>原型 · 合成演示 <span id="state-summary">${stateSummary()}</span></summary><div class="prototype-controls">
    <div class="preview-links"><button data-action="preview-manager">管理后台预览</button><button data-action="preview-ime">输入小窗预览</button></div>
    <label>示意会话<select data-field="demo-session" aria-label="切换合成会话">${chats.map((item) => `<option value="${item.id}" ${state.wxChat === item.id ? 'selected' : ''}>${item.title}</option>`).join('')}</select></label>
    <div class="scenario-controls"><button data-action="first-use">首次确认</button><button data-action="new-message">新消息</button><button data-action="configure-demo">模拟配置完成</button><button data-action="hide-manager">模拟关闭后台窗口</button><button data-action="lifecycle">${state.running ? '模拟退出' : '重新打开'}</button></div>
    <pre id="state-json">${escape(JSON.stringify(stateSnapshot(), null, 2))}</pre></div></details></aside>`;
}
function updateStatePanel() {
  document.querySelector('#state-summary').textContent = stateSummary();
  document.querySelector('#state-json').textContent = JSON.stringify(stateSnapshot(), null, 2);
  document.querySelectorAll('[data-action="generate"]').forEach((button) => { button.disabled = !canGenerate(); });
  const importButton = document.querySelector('[data-action="import"]');
  if (importButton) importButton.disabled = !state.importReady || !state.importContact || state.importDone;
}
function PrototypeSwitcher() {
  if (state.surface !== 'ime' || document.documentElement.dataset.prototype !== 'true') return '';
  return `<nav class="prototype-switcher" aria-label="原型布局切换"><button data-action="variant-prev" aria-label="上一套布局">${icon('left')}</button><div><span>小窗 ${state.variant} / 3</span><strong>${variants[state.variant]}</strong></div><button data-action="variant-next" aria-label="下一套布局">${icon('right')}</button></nav>`;
}
function updateURL() {
  const url = new URL(location.href);
  url.searchParams.set('surface', state.surface);
  if (state.surface === 'ime') url.searchParams.set('variant', state.variant);
  else url.searchParams.set('tab', state.managerTab);
  history.replaceState(null, '', url);
}
function render() {
  document.body.className = state.surface === 'ime' ? 'ime-page' : 'manager-page';
  document.title = `NotAlone · ${state.surface === 'ime' ? '输入小窗' : '管理后台'}原型`;
  const hidden = state.view === 'hidden' || !state.running;
  app.innerHTML = `${state.surface === 'manager' && !hidden ? manager() : `<main class="ime-preview" aria-label="独立输入小窗预览"><span class="preview-label">${state.surface === 'ime' ? '输入小窗' : '管理后台'} · 交互原型</span>${hidden ? `<div class="hidden-state"><span class="brand-symbol">n</span><p>${state.running ? (state.surface === 'ime' ? '小窗已收起，草稿保留在本次运行。' : '后台窗口已隐藏，读取状态保持。') : '已模拟退出，后台停读，草稿已清空。'}</p><button class="button primary" data-action="${state.surface === 'ime' ? 'show-helper' : 'preview-manager'}">${state.running ? '模拟唤起' : '重新打开'}</button></div>` : ({ A: VariantA, B: VariantB, C: VariantC }[state.variant])()}</main>`}${prototypeControls()}${PrototypeSwitcher()}<div id="toast" class="toast ${state.toast ? 'visible' : ''}" role="status">${escape(state.toast)}</div>`;
  const helper = document.querySelector('.ime-pane');
  if (helper) helper.style.transform = `translate(${state.position.x}px, ${state.position.y}px)`;
  document.querySelector('#prototype-tools').addEventListener('toggle', (event) => { state.inspectorOpen = event.target.open; });
  bindDrag();
}

function clearWriting() {
  generationSerial += 1;
  state.draft = ''; state.direction = ''; state.candidates = []; state.selected = 0;
  state.useContext = false; state.tone = '原样'; state.dirty = false;
  state.copyBuffer = null; state.generating = false;
  state.settingsOpen = false; state.editorOpen = false; state.popupOpen = false;
}
function selectWxChat(id) {
  if (state.wxChat === id) return;
  state.wxChat = id; state.contactId = state.bindings[id] || '';
  state.pendingContact = ''; state.pickerOpen = false;
  clearWriting();
  state.snapshot = state.newMessages[id] || wxContact().latest;
  render(); notify(state.contactId ? '已通过确认绑定定位联系人；联系人变化，草稿与候选已清空。' : '这个会话尚未绑定，请先确认本次联系人。');
}
function changeVariant(direction) {
  const keys = Object.keys(variants);
  state.variant = keys[(keys.indexOf(state.variant) + direction + keys.length) % keys.length];
  state.position = { x: 0, y: 0 };
  const url = new URL(location.href); url.searchParams.set('variant', state.variant);
  history.replaceState(null, '', url);
  state.editorOpen = false; state.popupOpen = false; render();
}
function generate() {
  if (!canGenerate()) return;
  state.generating = true; render();
  const contactId = state.contactId;
  const session = state.wxChat;
  const generation = ++generationSerial;
  const mode = state.mode;
  const value = (mode === 'rewrite' ? state.draft : state.direction).trim();
  const basis = { snapshot: state.snapshot, mode, useContext: state.useContext, tone: state.tone, contactId };
  setTimeout(() => {
    if (!state.running || state.contactId !== contactId || state.wxChat !== session || generation !== generationSerial) return;
    if (mode === 'rewrite' && value === sampleDraft) {
      state.candidates = sampleCandidates.map((item) => ({ ...item }));
    } else {
      // 自定义输入只做排版示意，不调用模型，也不改写用户的事实和立场。
      state.candidates = [
        { label: '贴近原稿', text: value },
        { label: '分句呈现', text: value.replace(/。(?=.)/g, '。\n') },
        { label: '紧凑呈现', text: value.replace(/\s+/g, ' ') },
      ];
    }
    state.candidates = state.candidates.map((item) => ({ ...item, basis }));
    state.selected = 0; state.generating = false; state.editorOpen = false; state.popupOpen = state.variant === 'C';
    render(); notify('已生成合成示意候选；自定义输入仅演示排版，未调用模型。');
  }, 450);
}
function restart() {
  state.running = true; state.view = state.surface === 'manager' ? 'manager' : 'helper'; clearWriting();
  state.contactId = state.bindings[state.wxChat] || '';
  state.snapshot = state.newMessages[state.wxChat] || wxContact().latest;
  render(); notify('模拟重新打开；只恢复已确认读取范围，未恢复草稿。');
}
function copy(index, hide) {
  if (!state.candidates[index]?.text.trim()) { notify('候选为空，请先填写内容。'); return; }
  state.copyBuffer = { text: state.candidates[index].text, contactId: state.contactId, wxChat: state.wxChat };
  if (hide) { state.view = 'hidden'; render(); }
  else updateStatePanel();
  notify('已模拟复制；真实剪贴板未改动，最终由你手动发送。');
}
app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action, value, index, id } = button.dataset;
  if (action === 'variant-next' || action === 'variant-prev') { changeVariant(action === 'variant-next' ? 1 : -1); return; }
  if (action === 'wx-chat') { selectWxChat(value); return; }
  if (action === 'generate') { generate(); return; }
  if (action === 'copy' || action === 'copy-hide') { copy(Number(index), action === 'copy-hide'); return; }
  if (action === 'show-helper' || action === 'preview-ime') {
    state.surface = 'ime';
    if (!state.running) { restart(); return; }
    state.view = 'helper'; updateURL();
  }
  if (action === 'preview-manager') {
    state.surface = 'manager'; state.managerHidden = false;
    if (!state.running) { restart(); return; }
    state.view = 'manager'; updateURL();
  }
  if (action === 'hide-helper') state.view = 'hidden';
  if (action === 'hide-manager') {
    state.managerHidden = true;
    if (state.surface === 'manager') state.view = 'hidden';
    notify('管理后台已模拟隐藏；后台读取状态保持，输入小窗独立运行。');
  }
  if (action === 'choose-contact') state.pickerOpen = !state.pickerOpen;
  if (action === 'confirm-contact') {
    if (!state.pendingContact) { notify('先选择本次回复的联系人。'); return; }
    if (state.contactId !== state.pendingContact) clearWriting();
    state.contactId = state.pendingContact; state.pickerOpen = false;
    notify('已确认本次联系人；后台读取范围没有改变。');
  }
  if ((action === 'mode' && value !== state.mode) || action === 'mode-toggle') {
    generationSerial += 1; state.generating = false;
    state.mode = action === 'mode-toggle' ? (state.mode === 'rewrite' ? 'reply' : 'rewrite') : value;
    state.candidates = []; state.selected = 0; state.editorOpen = false; state.popupOpen = false;
  }
  if (action === 'tone') state.tone = value;
  if (action === 'select-candidate') { state.selected = Number(index); state.editorOpen = true; }
  if (action === 'edit-selected') state.editorOpen = !state.editorOpen;
  if (action === 'close-editor') state.editorOpen = false;
  if (action === 'toggle-settings') state.settingsOpen = !state.settingsOpen;
  if (action === 'toggle-popup') state.popupOpen = !state.popupOpen;
  if (action === 'new-message') {
    state.newMessages[state.wxChat] = '补充一下，你先按自己的节奏确认就好，有结果再告诉我。';
    state.dirty = true; notify('模拟收到新消息；草稿、候选和生成时的快照保持不变。');
  }
  if (action === 'refresh-context') {
    state.snapshot = state.newMessages[state.wxChat] || wxContact().latest;
    state.dirty = false; notify('已更新会话快照；草稿和现有候选仍保留，可主动重新生成。');
  }
  if (action === 'manager-tab') { state.managerTab = value; updateURL(); }
  if (action === 'manage-bindings') { state.managerTab = 'contacts'; updateURL(); }
  if (action === 'confirm-bindings') {
    if ([...state.selectedBindings].some((key) => !state.bindingTargets[key])) { notify('每个勾选的会话都需要明确选择对应联系人。'); return; }
    state.bindings = Object.fromEntries([...state.selectedBindings].map((key) => [key, state.bindingTargets[key]]));
    if (!state.bindings[state.wxChat] || state.bindings[state.wxChat] !== state.contactId) {
      clearWriting(); state.contactId = state.bindings[state.wxChat] || '';
    }
    if (!Object.keys(state.bindings).length) state.syncEnabled = false;
    notify('已模拟确认会话与范围；未勾选的会话不读取。');
  }
  if (action === 'toggle-sync') {
    if (!Object.keys(state.bindings).length) { notify('请先确认会话与读取范围。'); return; }
    state.syncEnabled = !state.syncEnabled;
    notify(state.syncEnabled ? '已模拟开启，仅在已确认范围内补齐。' : '已模拟关闭，后台停止读取。');
  }
  if (action === 'load-import') { state.importReady = true; state.importDone = false; notify('已选择单联系人合成样例，没有读取真实文件。'); }
  if (action === 'import') { state.importDone = true; state.importedContact = state.importContact; notify('已模拟导入 24 条消息；只属于选中的联系人。'); }
  if (action === 'edit-memory') { state.editingMemory = id; state.memoryEdit = state.memories.find((item) => item.id === id).text; }
  if (action === 'save-memory') {
    if (!state.memoryEdit.trim()) { notify('请填写修正后的记忆内容。'); return; }
    const item = state.memories.find((entry) => entry.id === id);
    item.text = state.memoryEdit.trim(); item.kind = '用户修正'; state.editingMemory = null;
    notify('已模拟修正；原来源仍保留。');
  }
  if (action === 'delete-memory') { state.memories = state.memories.filter((item) => item.id !== id); notify('已从本页内存删除／撤销这条合成记忆。'); }
  if (action === 'save-config') { state.configured = true; state.owner = state.ownerEdit.trim() || '合成用户'; notify('已保存模拟配置，没有连接模型服务。'); }
  if (action === 'configure-demo') { state.configured = true; notify('已模拟完成配置，未连接模型服务。'); }
  if (action === 'lifecycle') {
    if (!state.running) { restart(); return; }
    state.running = false; state.view = 'hidden'; clearWriting();
    notify('应用已模拟退出；后台停读，未提交草稿和候选已清空。');
  }
  if (action === 'first-use') {
    clearWriting(); state.running = true; state.view = state.surface === 'manager' ? 'manager' : 'helper'; state.configured = false;
    state.bindings = {}; state.bindingTargets = { 'wx-c1': '', 'wx-c2': '', 'wx-c3': '' };
    state.selectedBindings = new Set(); state.syncEnabled = false; state.contactId = ''; state.pendingContact = '';
    state.snapshot = state.newMessages[state.wxChat] || wxContact().latest;
    state.importReady = false; state.importDone = false; state.importContact = '';
    if (state.surface === 'manager') { state.managerTab = 'config'; updateURL(); }
    notify('已切到首次确认场景：联系人未选，后台范围未选，读取关闭。');
  }
  render();
});
app.addEventListener('input', (event) => {
  const { field, index } = event.target.dataset;
  if (field === 'draft') state.draft = event.target.value;
  if (field === 'direction') state.direction = event.target.value;
  if (field === 'candidate') state.candidates[Number(index)].text = event.target.value;
  if (field === 'memory-edit') state.memoryEdit = event.target.value;
  if (field === 'owner-edit') state.ownerEdit = event.target.value;
  updateStatePanel();
});
app.addEventListener('change', (event) => {
  const { field, id } = event.target.dataset;
  if (field === 'pending-contact') state.pendingContact = event.target.value;
  if (field === 'use-context') state.useContext = event.target.checked;
  if (field === 'binding-target') state.bindingTargets[id] = event.target.value;
  if (field === 'binding-scope') {
    if (event.target.checked) state.selectedBindings.add(id); else state.selectedBindings.delete(id);
  }
  if (field === 'import-contact') state.importContact = event.target.value;
  if (field === 'memory-contact') { state.memoryContact = event.target.value; render(); }
  if (field === 'demo-session') { selectWxChat(event.target.value); return; }
  updateStatePanel();
});
document.addEventListener('keydown', (event) => {
  const editing = event.target.closest('input, textarea, select, [contenteditable="true"]');
  if (state.surface === 'ime' && !editing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault(); changeVariant(event.key === 'ArrowRight' ? 1 : -1);
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Space') {
    event.preventDefault(); state.surface = 'ime';
    if (!state.running) restart(); else { state.view = 'helper'; updateURL(); render(); }
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && state.surface === 'ime') { event.preventDefault(); generate(); }
  if (event.key === 'Escape' && state.view === 'helper') { state.view = 'hidden'; render(); }
});
function bindDrag() {
  const header = document.querySelector('.drag-handle');
  if (!header) return;
  header.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, a, input, textarea, select') || event.button !== 0) return;
    const helper = header.closest('.ime-pane');
    const stage = document.querySelector('.ime-preview');
    const bounds = helper.getBoundingClientRect(), area = stage.getBoundingClientRect();
    const start = { clientX: event.clientX, clientY: event.clientY, ...state.position };
    header.setPointerCapture(event.pointerId);
    const move = (next) => {
      const dx = Math.max(area.left - bounds.left, Math.min(next.clientX - start.clientX, area.right - bounds.right));
      const dy = Math.max(area.top - bounds.top, Math.min(next.clientY - start.clientY, area.bottom - bounds.bottom));
      state.position = { x: start.x + dx, y: start.y + dy };
      helper.style.transform = `translate(${state.position.x}px, ${state.position.y}px)`;
    };
    const end = () => {
      header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', end);
      updateStatePanel();
    };
    header.addEventListener('pointermove', move); header.addEventListener('pointerup', end);
  });
}
render();
