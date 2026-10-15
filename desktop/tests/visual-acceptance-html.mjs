import { visualChecklist } from './visual-acceptance-view.mjs';

const checklistMarkup = visualChecklist.map(([id, label]) => `<div class="check"><div>${label}<small data-check-result="${id}">未验证</small></div>
<div class="row">${[['matches', '符合'], ['mismatches', '有问题'], ['unverified', '未验证']].map(([outcome, text]) =>
  `<button data-action="checklist" data-check="${id}" data-outcome="${outcome}" aria-label="${label}：${text}" disabled>${text}</button>`).join('')}</div></div>`).join('');

export const visualAcceptanceHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-visual-acceptance'; base-uri 'none'; form-action 'none'">
<title>正式App定位 · 实时可视验收</title><style>
*{box-sizing:border-box}body{margin:0;padding:22px;background:#f4f3ec;color:#253b32;font:14px -apple-system,sans-serif}
h1{font-size:22px;margin:4px 0 8px}p{line-height:1.6}.muted{color:#64766b;font-size:12px}.card{background:#fff;border:1px solid #d9e1d9;border-radius:12px;padding:16px;margin:14px 0}
#headline{font-size:23px;font-weight:650;line-height:1.4;margin:0 0 10px}#detail{font-weight:600}label{display:block;line-height:1.7}input[type=text]{width:100%;padding:10px;margin:8px 0 12px;border:1px solid #9cac9e;border-radius:6px;font:inherit}
button{border:1px solid #b8c9bb;border-radius:7px;background:#fff;padding:10px 12px;color:#253b32;font:inherit;cursor:pointer;margin:4px 4px 4px 0}button.primary{background:#2d614c;color:white;border-color:#2d614c}button:disabled{opacity:.45;cursor:default}[hidden]{display:none!important}.row{display:flex;gap:6px}.row button{flex:1;font-size:12px}#feedback{min-height:42px;color:#305a47}#failure{color:#97422f}.check{padding:10px 0;border-bottom:1px solid #e5e9e3}.check small{float:right;color:#64766b}.check button{padding:6px}.actions{position:sticky;bottom:0;background:#f4f3ec;padding:8px 0}dl{display:grid;grid-template-columns:82px 1fr;gap:8px;margin-bottom:0}dt{color:#64766b}dd{margin:0;overflow-wrap:anywhere}#recognized{font-size:18px;font-weight:600}
</style><h1>正式 App · 实时定位状态</h1><p class=muted>来自正式探针、认证后端和助手的结果。<br>开始后自动更新；切换应用、移动或缩放微信即可观察。</p>
<form id=setup class=card><label for=name>本次只验收哪一位微信会话？</label><input id=name type=text maxlength=256 required autocomplete=off placeholder="测试联系人 A：微信顶部准确名称">
<label for=name-b>测试联系人 B（可选，仅切换验收需要）</label><input id=name-b type=text maxlength=256 autocomplete=off placeholder="不填则保留双联系人项目未验证">
<label><input id=consent type=checkbox required> 我确认本次只识别填写的会话及群聊暂停状态</label><p class=muted>开始前不采集画面；不读私人正文、不发送消息。请用合成草稿检查恢复。</p><button class=primary type=submit>开始可视验收</button><button type=button id=cancel>取消并退出</button></form>
<main id=live hidden><section class=card aria-label="本机实时识别"><p id=headline>等待正式观察</p><p id=detail></p><p id=failure></p><p id=recognized></p><dl><dt>识别置信度</dt><dd id=confidence>—</dd><dt>当前展示</dt><dd id=selected>未选择</dd><dt>联系人绑定</dt><dd id=binding>未确认</dd><dt>新生成</dt><dd id=generation>等待确认</dd><dt>原私聊草稿</dt><dd id=draft>请在正式助手核对</dd></dl><p id=age class=muted></p><p id=heartbeat class=muted>准备读取正式状态…</p></section>
<p>你可以直接切换前台，也可以移动、缩放微信。正式观察按原间隔和失败退避执行。</p>
<div class=row><button data-action=wechat disabled>我看到微信在前台</button><button data-action=other disabled>我看到其他应用在前台</button></div>
<p id=feedback role=status aria-live=polite>点击上面任意按钮，会立即显示核对反馈。</p><p id=counts class=muted>人工核对：一致0 · 不一致0 · 未验证0</p>
<section class=card aria-label="人工验收清单"><strong>由你逐项核对</strong><p class=muted>按钮记录你的实际反馈，不代表自动测试通过。暂时无法验证的项目保持未验证。</p>${checklistMarkup}</section>
<div class=actions><button data-action=open-helper disabled>打开正式助手</button><button class=primary data-action=finish id=finish disabled>结束验收并退出</button></div></main>
<script nonce=visual-acceptance>globalThis.acceptance={begun:false,names:[],events:[],coordination:null,classification:'unknown',displayedAt:0,finishing:false};
document.getElementById('setup').addEventListener('submit',event=>{event.preventDefault();const name=document.getElementById('name').value.trim();const second=document.getElementById('name-b');const nameB=second.value.trim();second.setCustomValidity(nameB===name?'两位测试联系人名称需不同':'');if(!second.reportValidity()||!name||/[\\r\\n]/.test(name+nameB))return;acceptance.names=nameB?[name,nameB]:[name];acceptance.begun=true;document.getElementById('setup').hidden=true;document.getElementById('live').hidden=false;document.getElementById('feedback').textContent='已开始。请点击微信测试会话，状态会自动更新，无需逐步检查。';});
document.getElementById('cancel').addEventListener('click',()=>window.close());
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>{const type=button.dataset.action;const feedback=document.getElementById('feedback');
if(acceptance.events.length>=50){if(type==='finish')acceptance.events.shift();else{feedback.textContent='操作正在处理，请稍候再试。';return;}}
const age=Date.now()-acceptance.displayedAt;const classification=age>=0&&age<=2000?acceptance.classification:'unknown';
acceptance.events.push({type,runId:acceptance.coordination?.runId,stage:acceptance.coordination?.stage,classification,displayedAt:acceptance.displayedAt,checkId:button.dataset.check,outcome:button.dataset.outcome});
if(type==='finish'){acceptance.finishing=true;feedback.textContent='已收到结束操作，正在关闭本轮实例…';button.disabled=true;}
else if(type==='open-helper')feedback.textContent='已收到，正在打开正式助手；助手获焦后会暂停定位。';
else if(type==='checklist')feedback.textContent='已收到人工反馈：'+button.getAttribute('aria-label')+'。结果将在下一次刷新时记录；未验证不算通过。';
else {const seen=type==='wechat'?'微信在前台':'其他应用在前台';feedback.textContent='已收到：你看到'+seen+'。'+(classification==='unknown'?'正式判定尚未完成，先记录为未验证；具体失败见上方。':classification===type?'与当前显示的正式判定一致。':'与当前显示的正式判定不一致，已记录。');}}));</script></html>`;

// 此函数直接在实际验收窗或无头Chromium页面执行，两者消费同一DOM和按钮脚本。
export function renderVisualAcceptance({ view, coordination, counts }) {
  const state = window.acceptance;
  state.coordination = coordination;
  state.classification = view.classification;
  state.displayedAt = Date.now();
  document.getElementById('headline').textContent = view.headline;
  document.getElementById('detail').textContent = view.detail;
  document.getElementById('failure').textContent = view.failure ? `失败环节：${view.failure.layer} · ${view.failure.message}` : '';
  document.getElementById('recognized').textContent = view.recognizedName ?? '暂无有效私聊名称';
  document.getElementById('confidence').textContent = view.confidencePercent === null ? '—' : `${view.confidencePercent}%`;
  document.getElementById('selected').textContent = view.selectedLabel;
  document.getElementById('binding').textContent = view.confirmedLabel;
  document.getElementById('generation').textContent = view.generationAllowed ? '允许（仍须你主动点击）' : '已阻止';
  document.getElementById('draft').textContent = `${view.draftLength}字；在正式助手核对正文及切回恢复`;
  document.getElementById('age').textContent = view.ageSeconds === null ? '尚无有效观察时点'
    : `最近观察：${view.ageSeconds}秒前；超过5秒不作当前判断`;
  document.getElementById('heartbeat').textContent = `实时显示已连接 · 状态变化${counts.stateUpdates}次 · 自动绑定成功${counts.matchedSamples}次`;
  document.getElementById('counts').textContent = `人工核对：一致${counts.matches} · 不一致${counts.mismatches} · 未验证${counts.unverified}`;
  document.querySelectorAll('[data-check-result]').forEach(label => {
    const result = counts.checks?.[label.dataset.checkResult];
    label.textContent = result === 'matches' ? '人工：符合' : result === 'mismatches' ? '人工：有问题' : '未验证';
  });
  document.querySelectorAll('[data-action]').forEach(button => {
    button.disabled = !coordination.runId || coordination.state === 'closing' || state.finishing;
  });
  return state.events.splice(0);
}
