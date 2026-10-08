// 比较草稿优先、消息优先、候选优先三种浮窗；所有资料和操作都是内存中的合成演示。
const variants = { A: '草稿优先', B: '消息优先', C: '候选优先' };
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
const requestedVariant = new URL(location.href).searchParams.get('variant');
const state = {
  variant: variants[requestedVariant] ? requestedVariant : 'A',
  view: 'helper', running: true, configured: true, owner: '合成用户',
  wxChat: 'wx-c1', contactId: 'c1', pendingContact: '', pickerOpen: false,
  bindings: { 'wx-c1': 'c1' }, selectedBindings: new Set(['wx-c1']),
  bindingTargets: { 'wx-c1': 'c1', 'wx-c2': '', 'wx-c3': '' },
  syncEnabled: true, mode: 'rewrite', draft: sampleDraft, direction: '', tone: '原样',
  useContext: false, candidates: sampleCandidates.map((item) => ({ ...item,
    basis: { snapshot: contacts[0].latest, mode: 'rewrite', useContext: false, tone: '原样', contactId: 'c1' },
  })), selected: 0,
  snapshot: contacts[0].latest, dirty: false, generating: false, composerOpen: false,
  newMessages: {}, copyBuffer: null, wxComposer: '', managerTab: 'contacts',
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
function windowHeader() {
  const item = contact();
  const bound = state.bindings[state.wxChat] === state.contactId && state.contactId;
  return `<header class="helper-header drag-handle">
    <div class="wordmark"><span class="brand-symbol">n</span><span>NotAlone</span><span class="pin">${icon('pin', 13)}</span></div>
    <button class="icon-button" data-action="hide-helper" aria-label="收起回复浮窗">${icon('close')}</button>
  </header>
  <div class="contact-header">
    ${item ? avatar(item, true) : '<span class="avatar small unknown">?</span>'}
    <button class="contact-name" data-action="choose-contact">${item ? `<strong>${item.name}</strong><span>${item.relation} · ${bound ? '已验证绑定' : '本次手动确认'}</span>` : '<strong>先确认联系人</strong><span>这条回复准备发给谁？</span>'}${icon('down', 14)}</button>
    <span class="subtle-label">${state.mode === 'rewrite' ? '改写' : '回复'}</span>
  </div>${state.pickerOpen || !item ? contactPicker() : ''}${contextNotice()}`;
}
function contactPicker() {
  return `<section class="contact-picker">
    <p>微信会话「${escape(chat().title)}」${state.bindings[state.wxChat] ? '已有绑定，可手动校正本次联系人。' : '尚未绑定，请明确选择联系人。'}</p>
    <div class="inline-row"><select data-field="pending-contact" aria-label="本次回复的联系人">${options(state.pendingContact)}</select>
    <button class="button primary small-button" data-action="confirm-contact">确认</button></div>
    <small>这里只确认本次回复；后台读取范围在管理窗口单独确认。</small>
  </section>`;
}
function contextNotice() {
  if (!state.configured) return `<div class="notice"><span>先完成首次配置，再生成候选。</span><button data-action="open-config">去配置</button></div>`;
  if (state.dirty) return `<div class="notice"><span>有新消息，当前草稿和候选已保留。</span><button data-action="refresh-context">更新上下文</button></div>`;
  return '';
}
function modeTabs() {
  return `<div class="mode-tabs" role="group" aria-label="写作方式">
    <button class="${state.mode === 'rewrite' ? 'active' : ''}" data-action="mode" data-value="rewrite">改写草稿</button>
    <button class="${state.mode === 'reply' ? 'active' : ''}" data-action="mode" data-value="reply">帮我回复</button>
  </div>`;
}
function inputArea(label = true) {
  const rewrite = state.mode === 'rewrite';
  return `<div class="composer">
    ${label ? `<div class="field-heading"><label for="writing-input">${rewrite ? '先写下你的意思' : '这次想怎么回应？'}</label><span>${rewrite ? '保留原意与立场' : '先定方向，再生成'}</span></div>` : ''}
    <textarea id="writing-input" aria-label="${rewrite ? '草稿' : '回复方向'}" data-field="${rewrite ? 'draft' : 'direction'}" rows="3" placeholder="${rewrite ? '输入或粘贴草稿，不用先把措辞想好…' : '例如：认可方向，但预算尚未确认，先别答应周五。'}">${escape(rewrite ? state.draft : state.direction)}</textarea>
    <div class="tone-options" role="group" aria-label="本次表达要求">
      ${['原样', '更短', '温和', '直接'].map((tone) => `<button class="chip ${state.tone === tone ? 'selected' : ''}" data-action="tone" data-value="${tone}">${tone}</button>`).join('')}
      <span>仅本次</span>
    </div>
    ${rewrite ? `<label class="context-option"><input type="checkbox" data-field="use-context" ${state.useContext ? 'checked' : ''}/>参考关系背景<span>默认关闭</span></label>` : '<p class="input-hint">候选会参考这位联系人的资料，你决定表达立场。</p>'}
    <button class="button primary generate-button" data-action="generate" ${canGenerate() ? '' : 'disabled'}>${icon('spark', 16)}${state.generating ? '正在模拟生成…' : state.candidates.length ? '重新生成候选' : '生成候选'}</button>
  </div>`;
}
function sourceEvidence(index = 0) {
  const basis = state.candidates[index]?.basis || state;
  const usesRelationship = basis.mode === 'reply' || basis.useContext;
  const basisContact = contacts.find((item) => item.id === basis.contactId);
  return `<details class="evidence"><summary>依据与边界<span>${icon('down', 12)}</span></summary>
    <div><p><b>表达依据</b>：${basis.mode === 'rewrite' ? '生成时的草稿' : '生成时填写的回复方向'}；语气：${basis.tone}。</p>
    <p><b>会话快照</b>：「${escape(basis.snapshot)}」</p>
    <p><b>关系资料</b>：${usesRelationship ? `${basisContact?.name || '未选择'}的合成历史，第 18 条；仅使用当前联系人资料。` : '本次未启用；只调整草稿的表达。'}</p>
    <p><b>核对点</b>：未加入新承诺；最终语气和事实请自行核对。</p>
    <small>合成来源 · 候选 ${index + 1} · 这次要求不会保存成长期偏好</small></div>
  </details>`;
}
function copyActions(index, compact = false) {
  return `<div class="copy-actions">
    <button class="button ${compact ? 'small-button' : 'quiet'}" data-action="copy" data-index="${index}">${icon('copy', 14)}复制</button>
    <button class="button ${compact ? 'small-button' : 'primary'}" data-action="copy-hide" data-index="${index}">复制并收起 ${icon('right', 14)}</button>
  </div>`;
}
function emptyCandidates() {
  return `<div class="empty-candidates">${icon('spark', 25)}<strong>措辞交给助手，意思由你决定</strong><p>${state.contactId ? '写下草稿或回复方向，再生成 2–3 个候选。' : '先确认联系人，再填写草稿或回复方向。'}</p></div>`;
}
function footer() {
  return '<footer class="helper-footer"><span class="status-dot"></span>你选择、修改，再亲自发送<button data-action="open-manager">管理</button></footer>';
}

// A：纵向写作台，草稿与完整候选沿纵向排列。
export function VariantA() {
  return `<section class="helper-window variant-a" role="dialog" aria-label="回复浮窗：草稿优先">
    ${windowHeader()}
    <div class="helper-scroll">${modeTabs()}${inputArea()}
      <div class="result-heading"><h3>选一句，再改一改</h3><span>${state.candidates.length ? '3 个合成候选 · 可直接编辑' : '等待生成'}</span></div>
      ${state.candidates.length ? state.candidates.map((item, index) => `<article class="candidate-card">
        <div class="candidate-heading"><span class="candidate-number">0${index + 1}</span><b>${item.label}</b></div>
        <textarea data-field="candidate" data-index="${index}" rows="2" aria-label="候选 ${index + 1}">${escape(item.text)}</textarea>
        ${copyActions(index, true)}${sourceEvidence(index)}
      </article>`).join('') : emptyCandidates()}
    </div>${footer()}
  </section>`;
}

// B：双栏，对话背景占左栏，右栏按方向、表达、选择推进。
export function VariantB() {
  const item = state.candidates[state.selected];
  return `<section class="helper-window variant-b" role="dialog" aria-label="回复浮窗：消息优先">
    ${windowHeader()}
    <div class="context-workspace">
      <aside class="conversation-column">
        <span class="eyebrow">当前对话</span><h2>先看清，<br/>再回应。</h2>
        <div class="context-message">${escape(state.snapshot)}</div>
        <span class="caption">${escape(contact()?.name || '待确认联系人')} · 本次上下文快照</span>
        <div class="context-note">${icon('memory', 18)}<div><b>${state.useContext || state.mode === 'reply' ? '已参考这位联系人的资料' : '改写默认只看原稿'}</b><p>一次性的表达要求，<br/>不会变成长期偏好。</p></div></div>
        <button class="text-button" data-action="open-manager">查看关系资料 ${icon('right', 14)}</button>
      </aside>
      <div class="workflow-column">
        ${modeTabs()}<div class="step-label"><span>01</span> ${state.mode === 'rewrite' ? '你的原意' : '你的方向'}</div>${inputArea(false)}
        <div class="step-label"><span>02</span> 选择一种表达</div>
        ${item ? `<div class="candidate-tabs">${state.candidates.map((candidate, index) => `<button class="${state.selected === index ? 'active' : ''}" data-action="select-candidate" data-index="${index}">${candidate.label}</button>`).join('')}</div>
          <textarea class="large-result" data-field="candidate" data-index="${state.selected}" rows="4" aria-label="候选 ${state.selected + 1}">${escape(item.text)}</textarea>
          ${sourceEvidence(state.selected)}` : emptyCandidates()}
      </div>
    </div>${item ? `<div class="workspace-actions">${copyActions(state.selected)}</div>` : ''}${footer()}
  </section>`;
}

// C：候选列表占据首屏，选中后展开；编辑原意在底部的独立抽屉中。
export function VariantC() {
  return `<section class="helper-window variant-c" role="dialog" aria-label="回复浮窗：候选优先">
    ${windowHeader()}
    <div class="helper-scroll">
      <div class="compact-heading"><div><span class="eyebrow">挑一句顺口的</span><h2>还是你的意思。</h2></div><span class="result-count">${state.candidates.length || '—'}</span></div>
      ${state.candidates.length ? `<div class="candidate-list">${state.candidates.map((item, index) => `<article class="candidate-row ${state.selected === index ? 'active' : ''}">
        <button class="candidate-select" data-action="select-candidate" data-index="${index}">
          <span class="radio-dot"></span><span><b>${item.label}</b><span class="candidate-preview">${escape(item.text)}</span></span>
        </button>
        ${state.selected === index ? `<div class="candidate-expanded"><textarea data-field="candidate" data-index="${index}" rows="3" aria-label="候选 ${index + 1}">${escape(item.text)}</textarea>${sourceEvidence(index)}${copyActions(index)}</div>` : ''}
      </article>`).join('')}</div>` : emptyCandidates()}
      <div class="draft-drawer ${state.composerOpen || !state.candidates.length ? 'open' : ''}">
        <button class="drawer-toggle" data-action="toggle-composer"><span>${icon('spark', 15)} ${state.mode === 'rewrite' ? '调整原稿与语气' : '调整回复方向'}</span>${icon('down', 14)}</button>
        ${state.composerOpen || !state.candidates.length ? `<div class="drawer-content">${modeTabs()}${inputArea()}</div>` : `<p class="draft-preview">${escape(state.mode === 'rewrite' ? state.draft : state.direction || '请展开后明确回复方向')}</p>`}
      </div>
    </div>${footer()}
  </section>`;
}
function wechat() {
  const item = wxContact();
  const latest = state.newMessages[state.wxChat] || item.latest;
  return `<section class="wechat-window" aria-label="合成微信会话">
    <div class="wechat-rail"><span class="rail-avatar">我</span>${icon('message', 25)}${icon('contacts', 25)}<span class="rail-bottom">${icon('settings', 22)}</span></div>
    <aside class="wechat-sidebar"><div class="mock-traffic"><i></i><i></i><i></i></div><div class="mock-search">搜索合成联系人 ${icon('plus', 13)}</div>
      ${chats.map((entry) => {
        const person = contacts.find((c) => c.id === entry.contactId);
        return `<button class="wechat-chat ${state.wxChat === entry.id ? 'active' : ''}" data-action="wx-chat" data-value="${entry.id}">${avatar(person, true)}<span><b>${entry.title}</b><small>${person.latest}</small></span><time>14:20</time></button>`;
      }).join('')}
      <span class="synthetic-sidebar">会话与名称均为合成</span>
    </aside>
    <div class="wechat-conversation"><header><b>${item.name}</b><span>合成微信环境 · 无真实连接</span></header>
      <div class="wechat-messages"><span class="chat-time">今天 14:20</span>
        <div class="bubble-row">${avatar(item, true)}<p class="chat-bubble">${item.previous}</p></div>
        <div class="bubble-row mine"><p class="chat-bubble">好，我看一下。</p><span class="avatar small me">我</span></div>
        <div class="bubble-row">${avatar(item, true)}<p class="chat-bubble">${escape(latest)}</p></div>
      </div>
      <div class="wechat-composer"><div class="composer-tools"><span>☺　⌕　▢</span><button class="text-button" data-action="paste-sample" ${state.copyBuffer ? '' : 'disabled'}>${icon('copy', 13)} 模拟粘贴</button></div>
        <textarea data-field="wx-composer" rows="3" aria-label="合成微信输入框" placeholder="候选复制后，在这里模拟粘贴…">${escape(state.wxComposer)}</textarea>
        <span class="manual-send">粘贴后由你手动发送 · 本页不执行发送</span>
      </div>
    </div>
  </section>`;
}
const managerTabs = { contacts: ['contacts', '联系人与绑定'], import: ['import', '历史导入'], memory: ['memory', '关系记忆'], sync: ['sync', '后台同步'], config: ['settings', '基础配置'] };
function manager() {
  return `<section class="manager-window" role="dialog" aria-label="管理窗口">
    <header class="manager-header"><div class="wordmark"><span class="brand-symbol">n</span>NotAlone <span>管理窗口</span></div><button class="icon-button" data-action="hide-manager" aria-label="关闭管理窗口">${icon('close')}</button></header>
    <div class="manager-body"><aside class="manager-sidebar"><span class="eyebrow">你的关系资料</span>
      <nav>${Object.entries(managerTabs).map(([key, [symbol, label]]) => `<button class="${state.managerTab === key ? 'active' : ''}" data-action="manager-tab" data-value="${key}">${icon(symbol, 19)}${label}</button>`).join('')}</nav>
      <div class="sidebar-help"><span class="status-dot ${state.syncEnabled && state.running ? '' : 'off'}"></span><b>${state.syncEnabled && state.running ? '后台同步中' : '后台读取已停止'}</b><p>关闭窗口只隐藏。<br/>明确退出应用后停读。</p></div>
    </aside><main class="manager-content">${managerContent()}</main></div>
    <footer class="manager-footer"><span>合成资料 · 修改只留在本页内存</span><button class="text-button" data-action="show-helper">呼出回复浮窗 ${icon('right', 14)}</button></footer>
  </section>`;
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
    <div class="import-layout"><div class="import-dropzone">${icon('import', 32)}<h3>导入聊天历史</h3><p>支持范围和真实格式在正式规格中确认。<br/>本页使用一份 24 条消息的合成样例。</p><button class="button" data-action="load-import">选择合成样例</button></div>
    <div class="import-preview"><span class="step-label"><span>01</span> 确认归属</span><label class="field-heading" for="import-contact">这份历史属于谁？</label><select id="import-contact" data-field="import-contact">${options(state.importContact)}</select>
      <div class="import-facts"><p><span>消息</span><b>${state.importReady ? '24 条' : '等待选择'}</b></p><p><span>会话</span><b>${state.importReady ? '1 位联系人' : '—'}</b></p><p><span>处理</span><b>${state.importDone ? '模拟导入完成' : '确认后导入'}</b></p></div>
      <button class="button primary" data-action="import" ${state.importReady && state.importContact && !state.importDone ? '' : 'disabled'}>确认归属并模拟导入</button>
    </div></div>
    ${state.importDone ? `<div class="success-panel">${icon('check')}<div><b>已模拟导入到${contacts.find((item) => item.id === state.importedContact).name}</b><p>24 条合成消息有独立来源；关系候选不会标成用户确认。</p></div></div>` : '<p class="panel-note">预览、确认归属和删除来源的入口会在正式导入流程中落实。</p>'}`;
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
    布局: state.variant, 显示窗口: state.view, 管理页面: state.managerTab, 应用运行: state.running,
    浮窗位置: state.position, 使用者: state.owner,
    当前微信会话: state.wxChat, 本次联系人: state.contactId || '未确认',
    已确认绑定: state.bindings, 待确认读取范围: [...state.selectedBindings],
    后台总开关: state.syncEnabled, 实际模拟读取: state.running && state.syncEnabled && Object.keys(state.bindings).length > 0,
    配置完成: state.configured, 写作方式: state.mode, 草稿: state.draft, 回复方向: state.direction,
    本次语气: state.tone, 参考关系背景: state.useContext, 会话快照: state.snapshot,
    有待刷新消息: state.dirty, 候选: state.candidates, 当前候选: state.selected + 1,
    模拟复制: state.copyBuffer, 合成微信输入框: state.wxComposer,
    导入: { 已选择样例: state.importReady, 目标联系人: state.importContact, 已完成: state.importDone, 已导入联系人: state.importedContact },
    关系记忆: state.memories,
  };
}
function statePanel() {
  return `<section class="prototype-state" aria-label="原型状态">
    <div id="state-summary">${stateSummary()}</div>
    <details id="state-details" ${state.inspectorOpen ? 'open' : ''}><summary>查看完整模拟状态</summary><pre id="state-json">${escape(JSON.stringify(stateSnapshot(), null, 2))}</pre></details>
  </section>`;
}
function stateSummary() {
  const reads = state.running && state.syncEnabled && Object.keys(state.bindings).length;
  return `<span><b>本次联系人</b> ${contact()?.name || '未确认'}</span><span><b>草稿</b> ${state.draft.length} 字</span><span><b>候选</b> ${state.candidates.length} 条</span><span><b>新消息</b> ${state.dirty ? '待刷新' : '已追平'}</span><span><b>后台</b> ${reads ? `读取 ${Object.keys(state.bindings).length} 个确认会话` : '停读'}</span><span><b>运行</b> ${state.running ? '当前会话' : '已退出，草稿已清空'}</span>`;
}
function updateStatePanel() {
  document.querySelector('#state-summary').innerHTML = stateSummary();
  document.querySelector('#state-json').textContent = JSON.stringify(stateSnapshot(), null, 2);
  document.querySelectorAll('[data-action="generate"]').forEach((button) => { button.disabled = !canGenerate(); });
  const importButton = document.querySelector('[data-action="import"]');
  if (importButton) importButton.disabled = !state.importReady || !state.importContact || state.importDone;
}
function PrototypeSwitcher() {
  if (document.documentElement.dataset.prototype !== 'true' || !location.pathname.startsWith('/prototype/')) return '';
  return `<nav class="prototype-switcher" aria-label="原型布局切换"><button data-action="variant-prev" aria-label="上一套布局">${icon('left')}</button><div><span>布局 ${state.variant} / 3</span><strong>${variants[state.variant]}</strong></div><button data-action="variant-next" aria-label="下一套布局">${icon('right')}</button></nav>`;
}
function render() {
  app.innerHTML = `<div class="prototype-shell"><header class="prototype-toolbar">
    <div class="prototype-brand"><span class="brand-symbol">n</span><div><b>NotAlone · 双窗口原型</b><span>合成资料 · 所有操作仅模拟</span></div></div>
    <div class="surface-switch"><button class="${state.view === 'helper' ? 'active' : ''}" data-action="show-helper">回复浮窗</button><button class="${state.view === 'manager' ? 'active' : ''}" data-action="open-manager">管理窗口</button></div>
    <div class="scenario-controls"><button data-action="first-use">首次确认</button><button data-action="new-message">新消息</button><button data-action="lifecycle">${state.running ? '模拟退出' : '重新打开'}</button></div>
  </header>
  <div class="prototype-intro"><div><span class="eyebrow">日常入口 / 浮窗 + 管理窗口</span><h1>一句话，还是你的意思。</h1></div><p>${state.view === 'manager' ? '管理关系与读取范围。关闭窗口后，后台仍保持运行。' : `${variants[state.variant]}：${{ A: '先写，再比较三份完整候选。', B: '对话在左，表达与选择在右。', C: '先挑候选，需要时再展开原稿。' }[state.variant]}`}<br/>底部切换 A / B / C，也可以用键盘 ← →。</p></div>
  <div class="desktop-stage ${state.view === 'manager' ? 'manager-stage' : ''}">
    ${wechat()}
    ${state.running && state.view === 'helper' ? ({ A: VariantA, B: VariantB, C: VariantC }[state.variant])() : ''}
    ${state.running && state.view === 'manager' ? manager() : ''}
    ${state.view === 'desktop' || !state.running ? `<div class="summon-card"><span class="brand-symbol">n</span><div><b>${state.running ? '浮窗已收起' : '应用已模拟退出'}</b><p>${state.running ? '同一联系人下，草稿与候选保留在本次运行。' : '后台已停读；未提交草稿不会跨运行保留。'}</p></div><button class="button primary" data-action="show-helper">${state.running ? '模拟唤起' : '重新打开'}</button></div>` : ''}
    <span class="desktop-caption">模拟桌面环境 · 拖动浮窗标题栏可调整位置 · 真实全局快捷键待宿主实现</span>
  </div>
  ${statePanel()}${PrototypeSwitcher()}<div id="toast" class="toast ${state.toast ? 'visible' : ''}" role="status">${escape(state.toast)}</div></div>`;
  const helper = document.querySelector('.helper-window');
  if (helper) helper.style.transform = `translate(${state.position.x}px, ${state.position.y}px)`;
  document.querySelector('#state-details').addEventListener('toggle', (event) => { state.inspectorOpen = event.target.open; });
  bindDrag();
}
function clearWriting() {
  generationSerial += 1;
  state.draft = ''; state.direction = ''; state.candidates = []; state.selected = 0;
  state.useContext = false; state.tone = '原样'; state.dirty = false;
  state.copyBuffer = null; state.wxComposer = ''; state.generating = false;
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
  history.replaceState(null, '', url); render();
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
    state.selected = 0; state.generating = false; state.composerOpen = false;
    render(); notify('已生成合成示意候选；自定义输入仅演示排版，未调用模型。');
  }, 450);
}
function restart() {
  state.running = true; state.view = 'helper'; clearWriting();
  state.contactId = state.bindings[state.wxChat] || '';
  state.snapshot = state.newMessages[state.wxChat] || wxContact().latest;
  render(); notify('模拟重新打开；只恢复已确认读取范围，未恢复草稿。');
}
function copy(index, hide) {
  if (!state.candidates[index]?.text.trim()) { notify('候选为空，请先填写内容。'); return; }
  state.copyBuffer = { text: state.candidates[index].text, contactId: state.contactId, wxChat: state.wxChat };
  if (hide) { state.view = 'desktop'; render(); }
  else {
    document.querySelector('[data-action="paste-sample"]').disabled = false;
    updateStatePanel();
  }
  notify('已放入页面内的模拟剪贴板；可以在合成微信窗口模拟粘贴。');
}
app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action, value, index, id } = button.dataset;
  if (action === 'variant-next' || action === 'variant-prev') { changeVariant(action === 'variant-next' ? 1 : -1); return; }
  if (action === 'wx-chat') { selectWxChat(value); return; }
  if (action === 'generate') { generate(); return; }
  if (action === 'copy' || action === 'copy-hide') { copy(Number(index), action === 'copy-hide'); return; }
  if (action === 'show-helper') { if (!state.running) { restart(); return; } state.view = 'helper'; }
  if (action === 'open-manager' || action === 'open-config') {
    if (!state.running) { restart(); }
    state.view = 'manager';
    if (action === 'open-config') state.managerTab = 'config';
  }
  if (action === 'hide-helper' || action === 'hide-manager') { state.view = 'desktop'; }
  if (action === 'choose-contact') state.pickerOpen = !state.pickerOpen;
  if (action === 'confirm-contact') {
    if (!state.pendingContact) { notify('先选择本次回复的联系人。'); return; }
    if (state.contactId !== state.pendingContact) clearWriting();
    state.contactId = state.pendingContact; state.pickerOpen = false;
    notify('已确认本次联系人；后台读取范围没有改变。');
  }
  if (action === 'mode') { generationSerial += 1; state.generating = false; state.mode = value; state.candidates = []; state.selected = 0; state.composerOpen = true; }
  if (action === 'tone') state.tone = value;
  if (action === 'select-candidate') state.selected = Number(index);
  if (action === 'toggle-composer') state.composerOpen = !state.composerOpen;
  if (action === 'new-message') {
    state.newMessages[state.wxChat] = '补充一下，你先按自己的节奏确认就好，有结果再告诉我。';
    state.dirty = true; notify('模拟收到新消息；草稿、候选和生成时的快照保持不变。');
  }
  if (action === 'refresh-context') {
    state.snapshot = state.newMessages[state.wxChat] || wxContact().latest;
    state.dirty = false; notify('已更新会话快照；草稿和现有候选仍保留，可主动重新生成。');
  }
  if (action === 'paste-sample') {
    if (!state.copyBuffer || state.copyBuffer.wxChat !== state.wxChat) { notify('没有属于当前合成会话的复制内容。'); return; }
    state.wxComposer = state.copyBuffer.text; notify('已模拟粘贴；本页不会执行外部发送。');
  }
  if (action === 'manager-tab') state.managerTab = value;
  if (action === 'manage-bindings') state.managerTab = 'contacts';
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
  if (action === 'lifecycle') {
    if (!state.running) { restart(); return; }
    state.running = false; state.view = 'desktop'; clearWriting();
    notify('应用已模拟退出；后台停读，未提交草稿和候选已清空。');
  }
  if (action === 'first-use') {
    clearWriting(); state.running = true; state.view = 'helper'; state.configured = false;
    state.bindings = {}; state.bindingTargets = { 'wx-c1': '', 'wx-c2': '', 'wx-c3': '' };
    state.selectedBindings = new Set(); state.syncEnabled = false; state.contactId = ''; state.pendingContact = '';
    state.snapshot = state.newMessages[state.wxChat] || wxContact().latest;
    state.importReady = false; state.importDone = false; state.importContact = '';
    notify('已切到首次确认场景：联系人未选，后台范围未选，读取关闭。');
  }
  render();
});
app.addEventListener('input', (event) => {
  const { field, index } = event.target.dataset;
  if (field === 'draft') state.draft = event.target.value;
  if (field === 'direction') state.direction = event.target.value;
  if (field === 'candidate') state.candidates[Number(index)].text = event.target.value;
  if (field === 'wx-composer') state.wxComposer = event.target.value;
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
  updateStatePanel();
});
document.addEventListener('keydown', (event) => {
  const editing = event.target.closest('input, textarea, select, [contenteditable="true"]');
  if (!editing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault(); changeVariant(event.key === 'ArrowRight' ? 1 : -1);
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Space') {
    event.preventDefault(); if (!state.running) restart(); else { state.view = 'helper'; render(); }
  }
  if (event.key === 'Escape' && state.view === 'helper') { state.view = 'desktop'; render(); }
});
function bindDrag() {
  const header = document.querySelector('.drag-handle');
  if (!header) return;
  header.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || event.button !== 0) return;
    const helper = header.closest('.helper-window');
    const stage = document.querySelector('.desktop-stage');
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
