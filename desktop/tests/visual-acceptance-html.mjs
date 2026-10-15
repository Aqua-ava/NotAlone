export const visualAcceptanceHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-visual-acceptance'; base-uri 'none'; form-action 'none'">
<title>正式App定位 · 实时可视验收</title><style>
*{box-sizing:border-box}body{margin:0;padding:22px;background:#f4f3ec;color:#253b32;font:14px -apple-system,sans-serif}
h1{font-size:22px;margin:4px 0 8px}p{line-height:1.6}.muted{color:#64766b;font-size:12px}.card{background:#fff;border:1px solid #d9e1d9;border-radius:12px;padding:16px;margin:14px 0}
#headline{font-size:23px;font-weight:650;line-height:1.4;margin:0 0 10px}#detail{font-weight:600}label{display:block;line-height:1.7}input[type=text]{width:100%;padding:10px;margin:8px 0 12px;border:1px solid #9cac9e;border-radius:6px;font:inherit}
button{border:1px solid #b8c9bb;border-radius:7px;background:#fff;padding:10px 12px;color:#253b32;font:inherit;cursor:pointer;margin:4px 4px 4px 0}button.primary{background:#2d614c;color:white;border-color:#2d614c}button:disabled{opacity:.45;cursor:default}[hidden]{display:none!important}.row{display:flex;gap:6px}.row button{flex:1;font-size:12px}#feedback{min-height:42px;color:#305a47}#failure{color:#97422f}
</style><h1>正式 App · 实时定位状态</h1><p class=muted>来自正式探针、认证后端和助手的结果。<br>开始后自动更新；切换应用、移动或缩放微信即可观察。</p>
<form id=setup class=card><label for=name>本次只验收哪一位微信会话？</label><input id=name type=text maxlength=256 required autocomplete=off placeholder="填写微信顶部显示的准确会话名称">
<label><input id=consent type=checkbox required> 我确认本次只识别这一会话的名称</label><p class=muted>开始前不采集画面；不读私人正文、不发送消息。</p><button class=primary type=submit>开始可视验收</button><button type=button id=cancel>取消并退出</button></form>
<main id=live hidden><section class=card><p id=headline>等待正式观察</p><p id=detail></p><p id=failure></p><p id=age class=muted></p><p id=heartbeat class=muted>准备读取正式状态…</p></section>
<p>你可以直接切换前台，也可以移动、缩放微信。正式观察按原间隔和失败退避执行。</p>
<div class=row><button data-action=wechat disabled>我看到微信在前台</button><button data-action=other disabled>我看到其他应用在前台</button></div>
<p id=feedback role=status aria-live=polite>点击上面任意按钮，会立即显示核对反馈。</p><p id=counts class=muted>人工核对：一致0 · 不一致0 · 未验证0</p>
<button data-action=open-helper disabled>打开正式助手</button><button class=primary data-action=finish id=finish disabled>结束验收并退出</button></main>
<script nonce=visual-acceptance>globalThis.acceptance={begun:false,name:'',events:[],coordination:null,classification:'unknown',displayedAt:0,finishing:false};
document.getElementById('setup').addEventListener('submit',event=>{event.preventDefault();const name=document.getElementById('name').value.trim();if(!name||/[\\r\\n]/.test(name))return;acceptance.name=name;acceptance.begun=true;document.getElementById('setup').hidden=true;document.getElementById('live').hidden=false;document.getElementById('feedback').textContent='已开始。请点击微信测试会话，状态会自动更新，无需逐步检查。';});
document.getElementById('cancel').addEventListener('click',()=>window.close());
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>{const type=button.dataset.action;const feedback=document.getElementById('feedback');
if(acceptance.events.length>=50){if(type==='finish')acceptance.events.shift();else{feedback.textContent='操作正在处理，请稍候再试。';return;}}
const age=Date.now()-acceptance.displayedAt;const classification=age>=0&&age<=2000?acceptance.classification:'unknown';
acceptance.events.push({type,runId:acceptance.coordination?.runId,stage:acceptance.coordination?.stage,classification,displayedAt:acceptance.displayedAt});
if(type==='finish'){acceptance.finishing=true;feedback.textContent='已收到结束操作，正在关闭本轮实例…';button.disabled=true;}
else if(type==='open-helper')feedback.textContent='已收到，正在打开正式助手；助手获焦后会暂停定位。';
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
  document.getElementById('age').textContent = view.ageSeconds === null ? '尚无有效观察时点'
    : `最近观察：${view.ageSeconds}秒前；超过5秒不作当前判断`;
  document.getElementById('heartbeat').textContent = `实时显示已连接 · 状态变化${counts.stateUpdates}次 · 自动绑定成功${counts.matchedSamples}次`;
  document.getElementById('counts').textContent = `人工核对：一致${counts.matches} · 不一致${counts.mismatches} · 未验证${counts.unverified}`;
  document.querySelectorAll('[data-action]').forEach(button => {
    button.disabled = !coordination.runId || coordination.state === 'closing' || state.finishing;
  });
  return state.events.splice(0);
}
