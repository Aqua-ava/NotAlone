// 官网原型：仅使用预设合成场景，输入只在页面内存中保留。
const scenes = [
  { incoming: '周末要不要一起去逛逛？那家书店好像重新开了。', previous: '我看看这周的安排，晚点回你。', latest: '最近是不是有点忙？没事，有空再说。', direction: '想为没回消息道歉，但不想显得卑微。', candidates: [ ['自然一点', '前两天一直没回你，不好意思。书店我还挺想去的，你这周末有空吗？'], ['简短一点', '抱歉，前两天没及时回。书店还约吗？我想去。'], ['认真一点', '上次说晚点回，结果拖到了现在，不好意思。你提的书店我记着呢，要不要再约个时间？'] ], evidence: '示例对话中，你说过“晚点回你”，阿哲随后说“有空再说”。候选先回应迟复，再接回书店的邀约；没有替你编造没回复的原因。' },
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
