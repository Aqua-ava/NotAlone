// 官网原型：仅使用预设合成场景，输入只在页面内存中保留。
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

// 技术架构展示的是模块职责；点击节点只更新本地说明。
const architectureViews = {
  overview: {
    intro: '本机负责管理资料与编排流程，外部模型参与生成。点击任意模块，查看它接收什么、输出什么。',
    groups: [
      ['本机 · 交互入口', [['macOS 桌面端', '联系人 / 资料 / 回复工作台', '接收用户操作，通过 HTTP 请求本地后端；后端通过 SSE 推送状态与进度。候选返回界面后，由用户选择和修改。']]],
      ['↓ HTTP 操作 · ↑ SSE 状态', [['本地后端', '身份验证与流程编排', '核对联系人与会话绑定，协调导入、任务、检索和回复模块。本地服务绑定 127.0.0.1。']]],
      ['↓ 两条业务流程', [['资料处理与后台任务', '导入 → 消息 → 关系记忆', '将授权范围内的资料整理为规范消息，保留来源；后台任务提取关系记忆并维护目录。'], ['回复流程与上下文', '方向或原句 → 本次参考材料', '回复模式准备目标消息、表达方向和相关资料；改写模式默认以原句与本次要求为主。']]],
      ['↕ 按联系人保存与查询', [['PostgreSQL', '来源 / 消息 / 记忆 / 任务 / 回复', '业务模块通过持久化适配器读取和保存资料。联系人范围的数据按 owner_id + contact_id 隔离，昵称不作为隔离键。']]],
      ['↓ 回复上下文进入生成运行时', [['生成运行时', '按需读取 Skill · 有界检索', '运行时使用本次上下文，按需读取表达策略，并在允许的范围和预算内补充历史检索。'], ['外部模型服务', '请求 → 候选与引用', '接收本次请求选取的上下文并返回生成结果。模型调用跨出本机，不能宣称所有处理都在本地。']]],
      ['↓ 返回后的处理', [['校验与保存', '检查引用 · 保存候选 · 记录台账', '生成模块校验结构、依据及有效性；回复存储保存结果，出站台账记录调用元数据。校验失败时返回失败状态。'], ['回到桌面端', '查看 → 修改 → 复制', '展示候选与依据，最终消息由用户亲自发送；不存在自动发送的下一跳。']]]
    ]
  },
  data: {
    intro: '资料准备是一条独立流程。规范消息与关系记忆分层保存，记忆仍然要能追溯到来源。',
    groups: [
      ['01 / 先明确归属', [['确认联系人', '选择联系人与会话绑定', '用户确认资料属于谁；一次历史导入只归属一位联系人，不能按昵称混合不同人的资料。']]],
      ['↓ 两种资料入口', [['历史导入', '预览 → 用户确认 → 导入', '检查文件和单联系人范围后再正式导入，保留来源信息。'], ['授权增量同步', '已绑定会话的消息增量', '当前代码将 CLI 消息增量与前台定位分开处理；同步需要用户授权和绑定。此图不将其表述为任意聊天的自动读取能力。']]],
      ['↓ 整理与保存', [['规范消息', '统一文字表示 · 去重 · 来源', '输入资料转换成可查询的规范消息；原始来源与规范消息分层保存，截图或媒体占位不会直接冒充已理解的正文。']]],
      ['↓ 后台提取', [['关系记忆候选', '语用解释 · 来源 · 风险分流', '从消息中提取可能有长期价值的内容，保留来源并检查风险；一条消息不自动等同于长期偏好。']]],
      ['↓ 按规则采纳与管理', [['关系记忆', '可查看、修正、失效与删除', '符合自动采纳条件的记忆标记 auto、可撤销，不能标成用户确认。用户也可管理关系资料。'], ['联系人记忆目录', '主题与引用 → 检索入口', '目录帮助定位有效记忆，不复制一份新的事实。记忆变化后维护目录，供后续回复按需查找。']]]
    ]
  },
  reply: {
    intro: '两种输入走同一个生成流程，但准备上下文的方式不同。原句改写不会默认加入长期关系记忆。',
    groups: [
      ['01 / 桌面端提交', [['帮我回复', '目标消息 + 表达方向', '用户选择要回复的消息，明确这次想表达什么。'], ['帮我改写', '用户原句 + 可选改写要求', '以已经写好的语句为起点；改写要求仅作用于本次请求。']]],
      ['↓ 验证范围', [['会话与联系人验证', '有效绑定 → 已验证联系人范围', '验证失败时不进入模型生成；两种模式都必须映射到用户确认的联系人。']]],
      ['↓ 准备本次上下文', [['回复上下文', '相关消息 / 关系资料 / 表达方向', '读取当前联系人下的目标消息和相关资料，为候选保留可追溯的证据。'], ['改写上下文', '默认原句 · 明确开启后补充背景', '用户原句是默认输入；只有明确开启关系背景时才加入关系资料，不静默扩展成长久的人格设定。']]],
      ['↓ 运行时与外部模型协作', [['Skill 与受限检索', '按需选策略 · 按预算补资料', '模型可按需读取受控策略文本，以及允许的历史检索工具。工具结果回到生成上下文，调用受范围与预算限制。'], ['外部模型生成', '上下文 → 候选 + 依据引用', '模型生成结果不是直接发送的消息，还必须经过结构与依据校验。']]],
      ['↓ 校验并返回', [['结果校验与持久化', '校验 → 保存 → 返回候选', '检查结果结构、引用和资料有效性，保存候选与上下文快照，并记录调用台账；异常时记录失败。'], ['用户完成表达', '选择 / 编辑 / 复制 / 亲自发送', '用户决定采用哪一句，修改后亲自发送到聊天渠道。复制不是发送，也不代表系统获得发送授权。']]]
    ]
  }
};
function renderArchitecture(key) {
  const view = architectureViews[key];
  document.querySelectorAll('[data-architecture]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.architecture === key)));
  const diagram = document.querySelector('#architecture-diagram');
  diagram.replaceChildren();
  const intro = document.createElement('p'); intro.className = 'architecture-intro'; intro.textContent = view.intro; diagram.append(intro);
  const detail = document.querySelector('#architecture-detail'); detail.textContent = '点选模块，查看职责与数据流向。';
  view.groups.forEach(([label, nodes]) => {
    const group = document.createElement('div'); group.className = 'architecture-group';
    const caption = document.createElement('div'); caption.className = 'architecture-connector'; caption.textContent = label;
    const row = document.createElement('div'); row.className = 'architecture-row';
    nodes.forEach(([title, subtitle, description]) => {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'architecture-node'; node.setAttribute('aria-pressed', 'false');
      if (title.includes('外部模型')) node.classList.add('external-node');
      const heading = document.createElement('strong'); heading.textContent = title;
      const text = document.createElement('span'); text.textContent = subtitle; node.append(heading, text);
      node.addEventListener('click', () => { diagram.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === node))); detail.textContent = title + '：' + description; });
      row.append(node);
    });
    group.append(caption, row); diagram.append(group);
  });
}
document.querySelectorAll('[data-architecture]').forEach(button => button.addEventListener('click', () => renderArchitecture(button.dataset.architecture)));
renderArchitecture('overview');
