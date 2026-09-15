// 官网演示：仅使用预设合成场景，输入只在页面内存中保留。
const scenes = [
  { incoming: '周末要不要一起去逛逛？那家书店好像重新开了。', previous: '我看看这周的安排，晚点回你。', latest: '最近是不是有点忙？没事，有空再说。', direction: '想为没回消息道歉。', candidates: [ ['自然一点', '前两天一直没回你，不好意思。书店我还挺想去的，你这周末有空吗？'], ['简短一点', '抱歉，前两天没及时回。书店还约吗？我想去。'], ['认真一点', '上次说晚点回，结果拖到了现在，不好意思。你提的书店我记着呢，要不要再约个时间？'] ], evidence: '示例对话中，你说过“晚点回你”，阿哲随后说“有空再说”。候选先回应迟复，再接回书店的邀约；没有替你编造没回复的原因。' },
  { incoming: '周末要不要一起去逛逛？那家书店好像重新开了。', previous: '我看看这周的安排，晚点回你。', latest: '最近是不是有点忙？没事，有空再说。', original: '忘回你了，周末还去吗？', direction: '改得柔和一点，别太正式，保留原来的意思。', candidates: [ ['自然一点', '不好意思，忘了回你。周末还一起去吗？'], ['轻松一点', '哎，忘了回你，不好意思。周末还去吗？'], ['温和一点', '之前忘了回你，抱歉呀。想问问你，周末还去吗？'] ], evidence: '本次改写以你的原句“忘回你了，周末还去吗？”和一次性要求“柔和一点，别太正式”为依据。保留忘记回复和询问周末安排的原意，只调整衔接与语气，不编造原因，也不增加承诺；不使用长期关系记忆。' }
];
let currentScene = 0;
const draft = document.querySelector('#draft');
const status = document.querySelector('#copy-status');
function chooseCandidate(index) {
  draft.value = scenes[currentScene].candidates[index][1];
  document.querySelectorAll('.candidate').forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  status.textContent = '已选择候选，可以直接修改。由你亲自发送。';
}
function renderScene(index) {
  currentScene = index;
  const scene = scenes[index];
  const rewriting = Boolean(scene.original);
  document.querySelector('#original-block').hidden = !rewriting;
  document.querySelector('#original').textContent = scene.original || '';
  document.querySelector('#input-heading').textContent = rewriting ? '已经写好的话，再打磨一下。' : '这一次，你想怎么表达？';
  document.querySelector('#direction-label').textContent = rewriting ? '改写要求（可选）' : '表达方向';
  document.querySelector('#result-heading').textContent = rewriting ? '改写后：选一个更像你的说法' : '选一个更像你的说法';
  document.querySelector('#flow-caption').textContent = rewriting ? '你的原句 → 改写要求 → 改写后 → 由你决定' : '关系语境 → 表达方向 → 候选与依据 → 由你决定';
  for (const key of ['incoming', 'previous', 'latest', 'direction', 'evidence']) document.getElementById(key).textContent = scene[key];
  document.querySelectorAll('[data-scene]').forEach((button, i) => { button.classList.toggle('active', i === index); button.setAttribute('aria-pressed', String(i === index)); });
  const container = document.querySelector('#candidates');
  container.replaceChildren();
  scene.candidates.forEach(([label, value], i) => {
    const button = document.createElement('button');
    button.className = 'candidate';
    button.type = 'button';
    const radio = document.createElement('span'); radio.className = 'radio'; radio.setAttribute('aria-hidden', 'true');
    const content = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = label;
    const text = document.createElement('p'); text.textContent = value;
    content.append(title, text); button.append(radio, content);
    button.addEventListener('click', () => chooseCandidate(i)); container.append(button);
  });
  document.querySelector('.evidence').open = false;
  chooseCandidate(0);
  status.textContent = '由你修改，复制后亲自发送。';
}
document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => renderScene(Number(button.dataset.scene))));
draft.addEventListener('input', () => { status.textContent = '已修改，仅保留在当前页面。'; });
document.querySelector('#copy').addEventListener('click', async () => {
  if (!draft.value.trim()) { status.textContent = '先写下一句话，再复制。'; draft.focus(); return; }
  try { await navigator.clipboard.writeText(draft.value); status.textContent = '已复制。接下来由你亲自发送。'; }
  catch { draft.focus(); draft.select(); status.textContent = '请按 ⌘C / Ctrl+C 复制选中的文字。'; }
});
renderScene(0);

// 总览图仅展示模块职责，不连接真实服务。
const architectureNodes = {
 desktop: ['macOS 桌面端', '确认联系人 · 管理资料 · 编辑候选', '通过 HTTP 向本地后端提交操作，通过 SSE 接收状态与进度；用户在桌面端查看和修改候选。'],
 backend: ['本地后端', '联系人验证与流程编排', '核对已确认的联系人与有效会话绑定，再编排资料处理或回复流程。本地服务监听 127.0.0.1。'],
 input: ['导入与授权同步', '历史资料 / 已绑定会话增量', '用户确认资料归属后导入历史，或授权同步已绑定会话。CLI 消息增量与前台定位分别处理。'],
 messages: ['规范消息', '统一文字 · 去重 · 保留来源', '将资料整理为可查询的规范消息；来源和规范消息分层保存，未解析的媒体不会冒充正文。'],
 memory: ['关系记忆', '后台提取 → 风险分流 → 目录', '后台任务提取带来源的记忆候选，按规则采纳并维护目录。自动采纳标记 auto、可撤销；关系资料可查看、修正和删除。'],
 request: ['两种表达入口', '帮我回复 / 帮我改写', '帮我回复提交目标消息与表达方向；帮我改写提交用户原句与可选的一次性改写要求。两种模式均属于已确认联系人。'],
 context: ['本次回复上下文', '按需检索消息与关系资料', '回复模式读取当前联系人相关资料；改写默认以原句为输入，明确开启关系背景后才补充关系记忆。'],
 runtime: ['生成运行时', '按需读取 Skill · 有界检索', '运行时结合上下文、按需读取的表达策略和预算内检索结果调用模型。检索始终受联系人范围限制。'],
 model: ['外部模型', '选定上下文 ⇄ 候选与引用', '本次模型请求会跨出本机边界，模型结果返回生成运行时。此图不代表全部处理都在本地。'],
 check: ['校验与保存', '校验依据 · 保存候选 · 调用台账', '检查结果结构、引用和资料有效性，保存候选与上下文快照，记录调用元数据；失败时返回错误状态。'],
 result: ['回到桌面端', '查看依据 → 修改 → 复制', '候选回到桌面端供用户选择、修改和复制。发送始终由用户亲自完成，不存在后台发送工具。'],
 database: ['PostgreSQL', '来源 · 消息 · 记忆 · 任务 · 回复记录', '各业务模块通过持久化适配器共用数据库。联系人范围数据按 owner_id + contact_id 隔离；存储并非生成流程的一个顺序步骤。']
};
const graph = document.querySelector('#architecture-diagram');
function architectureNode(key, extra = '') {
 const [title, subtitle] = architectureNodes[key];
 return '<button type="button" class="map-node ' + extra + '" data-node="' + key + '" aria-pressed="false"><strong>' + title + '</strong><span>' + subtitle + '</span><i aria-hidden="true">↗</i></button>';
}
graph.innerHTML = '<div class="map-intro"><span class="map-kicker">SYSTEM / 01</span><p>资料成为语境，语境帮助表达。<br>一张图，看懂 NotAlone 如何工作。</p><span class="map-legend"><i></i> 本机模块 <b></b> 外部服务</span></div>' +
 '<div class="map-top">' + architectureNode('desktop') + '<div class="map-wire">↓ HTTP 操作 &nbsp; · &nbsp; ↑ SSE 状态</div>' + architectureNode('backend', 'map-hub') + '</div>' +
 '<div class="map-split" aria-hidden="true"><span>↓ 资料处理</span><span>↓ 回复请求</span></div>' +
 '<div class="map-lanes"><div class="map-lane map-data"><div class="lane-title"><em>01</em><div><strong>准备关系资料</strong><span>让每一份资料，都有明确归属</span></div></div>' + architectureNode('input') + '<div class="map-wire">↓ 规范化</div>' + architectureNode('messages') + '<div class="map-wire">↓ 后台任务</div>' + architectureNode('memory') + '<div class="lane-note">消息与记忆分层保存<br>来源可追溯，资料可管理</div></div>' +
 '<div class="map-bridge"><span>消息 / 记忆</span><b>→</b><span>按需检索</span></div>' +
 '<div class="map-lane map-reply"><div class="lane-title"><em>02</em><div><strong>找到合适的表达</strong><span>从你的方向，或你已经写好的话出发</span></div></div>' + architectureNode('request') + '<div class="map-wire">↓ 准备材料</div>' + architectureNode('context') + '<div class="map-wire">↓ 本次上下文</div>' + architectureNode('runtime') + '<div class="model-roundtrip"><div class="model-wire">↓ 请求 &nbsp; ↑ 结果</div>' + architectureNode('model','map-external') + '</div><div class="map-wire">↓ 运行时返回结果</div>' + architectureNode('check') + '<div class="map-wire">↓ 返回候选</div>' + architectureNode('result') + '<div class="human-finish"><span>最后一步，留给你。</span><strong>亲自发送 ↗</strong></div></div></div>' +
 '<div class="storage-wire">↕ 各业务模块通过持久化适配器读写 · 共用数据层</div><div class="map-storage">' + architectureNode('database') + '<span class="scope-tag">owner_id + contact_id<br>联系人范围隔离</span></div>';
const architectureDetail = document.querySelector('#architecture-detail');
architectureDetail.textContent = '点击任意模块，查看它的职责与数据流向。';
graph.querySelectorAll('[data-node]').forEach(button => button.addEventListener('click', () => {
 graph.querySelectorAll('[data-node]').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
 const [title, , description] = architectureNodes[button.dataset.node];
 architectureDetail.textContent = title + '：' + description;
}));
