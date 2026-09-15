// 官网原型：仅使用预设合成场景，输入只在页面内存中保留。
const scenes = [
  { incoming: '周末要不要一起去逛逛？那家书店好像重新开了。', previous: '我看看这周的安排，晚点回你。', latest: '最近是不是有点忙？没事，有空再说。', direction: '想为没回消息道歉，但不想显得卑微。', candidates: [ ['自然一点', '前两天一直没回你，不好意思。书店我还挺想去的，你这周末有空吗？'], ['简短一点', '抱歉，前两天没及时回。书店还约吗？我想去。'], ['认真一点', '上次说晚点回，结果拖到了现在，不好意思。你提的书店我记着呢，要不要再约个时间？'] ], evidence: '示例对话中，你说过“晚点回你”，阿哲随后说“有空再说”。候选先回应迟复，再接回书店的邀约；没有替你编造没回复的原因。' },
  { incoming: '周六搬家，你能不能过来帮我一下？', previous: '周六我已经有安排了，我再确认一下时间。', latest: '好，你看看，不方便也没关系。', direction: '这周六确实没空，想明确拒绝，也谢谢他的理解。', candidates: [ ['自然一点', '确认了一下，周六确实抽不开身，这次没法过去帮忙了。谢谢你理解，希望搬家顺利。'], ['简短一点', '周六时间挪不开，这次帮不上了。谢谢理解，搬家顺利！'], ['认真一点', '我看过安排了，周六没办法过去，跟你确认一下，免得耽误你找人。谢谢你体谅。'] ], evidence: '示例对话中，你已经说过周六有安排，阿哲也表示“不方便也没关系”。候选明确说明无法到场，不编造新理由，也不加入你没有承诺的补偿。' }
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
