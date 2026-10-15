import type { ElectronApplication, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectVisualAcceptance, visualAcceptanceAction, type VisualAction,
  type VisualCoordination } from './visual-acceptance-view.mjs';
import { verifyAppTestLease } from './app-test-gate';

type ControlWindow = Window & { acceptance: { begun: boolean; name: string; events: VisualAction[];
  classification: string; displayedAt: number; coordination: VisualCoordination | null } };
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
const instructions: Record<string, string> = {
  baseline: '原位：点击微信中的测试会话，让微信在前台，再点击“本步检查”。',
  moved: '移动：拖动微信窗口到另一位置，保持同一会话，再点击“本步检查”。',
  resized: '缩放：调整微信窗口大小，保持同一会话，再点击“本步检查”。',
  'other-app': '其他应用：点击另一个应用，让微信离开前台，再点击“本步检查”。',
  'helper-pause': '助手暂停：点击“本步检查”将打开正式助手并填入合成草稿，自动检查获焦暂停和草稿保留。',
  'resume-a': '返回：点击同一个微信测试会话，再点击“本步检查”。',
  finish: '本轮自动检查已完成，可以点击“完成并退出”。',
};
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-visual-acceptance'; base-uri 'none'; form-action 'none'">
<title>前台定位18 · 正式App可视验收</title><style>
*{box-sizing:border-box}body{margin:0;padding:22px;background:#f4f3ec;color:#253b32;font:14px -apple-system,sans-serif}
h1{font-size:22px;margin:4px 0 8px}p{line-height:1.6}.muted{color:#64766b;font-size:12px}.card{background:#fff;border:1px solid #d9e1d9;border-radius:12px;padding:16px;margin:16px 0}
#headline{font-size:24px;font-weight:650;line-height:1.4;margin:0 0 12px}#detail{font-weight:600}label{display:block;line-height:1.7}input[type=text]{width:100%;padding:10px;margin:8px 0 12px;border:1px solid #9cac9e;border-radius:6px;font:inherit}
button{border:1px solid #b8c9bb;border-radius:7px;background:#fff;padding:10px 12px;color:#253b32;font:inherit;cursor:pointer;margin:4px 4px 4px 0}button.primary{background:#2d614c;color:white;border-color:#2d614c}button:disabled{opacity:.45;cursor:default}#live[hidden]{display:none}.row{display:flex;gap:6px}.row button{flex:1;font-size:12px}
</style><h1>正式 App · 可视验收</h1><p class=muted>同一正式探针 → 认证后端 → 助手状态<br>开始后浮窗不抢焦点，20分钟内自动收尾。</p>
<form id=setup class=card><label for=name>本次只验收哪一位微信会话？</label><input id=name type=text maxlength=256 required autocomplete=off placeholder="填写微信顶部显示的准确会话名称">
<label><input id=consent type=checkbox required> 我确认本次只识别这一会话的名称</label><p class=muted>正文、CLI和模型使用合成资料；不会发送微信消息。开始前不采集画面。</p><button class=primary type=submit>开始可视验收</button><button type=button id=cancel>取消并退出</button></form>
<main id=live hidden><section class=card><p id=headline>等待正式观察</p><p id=detail></p><p id=age class=muted></p></section>
<section class=card><strong id=stage>准备中</strong><p id=instruction></p><button class=primary data-action=check id=check disabled>本步检查</button><button data-action=finish id=finish>结束本轮</button></section>
<p class=muted>像刚才一样，对照你实际看见的前台：</p><div class=row><button data-action=wechat>我看到微信在前台</button><button data-action=other>我看到其他应用在前台</button></div><p id=counts class=muted>人工核对：一致0 · 不一致0 · 未验证0</p></main>
<script nonce=visual-acceptance>globalThis.acceptance={begun:false,name:'',events:[],coordination:null,classification:'unknown',displayedAt:0};
document.getElementById('setup').addEventListener('submit',event=>{event.preventDefault();const name=document.getElementById('name').value.trim();if(!name||/[\\r\\n]/.test(name))return;acceptance.name=name;acceptance.begun=true;document.getElementById('setup').hidden=true;document.getElementById('live').hidden=false;});
document.getElementById('cancel').addEventListener('click',()=>window.close());
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>{if(acceptance.events.length<50)acceptance.events.push({type:button.dataset.action,runId:acceptance.coordination?.runId,stage:acceptance.coordination?.stage,classification:acceptance.classification,displayedAt:acceptance.displayedAt});}));</script></html>`;

export async function openVisualAcceptance(app: ElectronApplication) {
  const opened = app.waitForEvent('window');
  const id = await app.evaluate(async ({ BrowserWindow, screen }, html) => {
    const area = screen.getPrimaryDisplay().workArea;
    const window = new BrowserWindow({ title: '前台定位18 · 正式App可视验收', width: 460, height: 700,
      x: area.x + area.width - 480, y: area.y + 20, type: 'panel', alwaysOnTop: true,
      acceptFirstMouse: true, show: false, minimizable: false, maximizable: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'visual-acceptance' } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.showInactive();
    return window.id;
  }, html);
  const page = await opened;
  return {
    page,
    async waitForName() {
      try {
        while (!page.isClosed()) {
          await verifyAppTestLease();
          const name = await page.evaluate(() => {
            const state = (window as unknown as ControlWindow).acceptance;
            return state.begun ? state.name : null;
          });
          if (name && name.length <= 256 && !/[\r\n]/.test(name)) {
            await page.evaluate(() => { (window as unknown as ControlWindow).acceptance.name = ''; document.getElementById('name')?.remove(); });
            await app.evaluate(({ BrowserWindow }, id) => {
              const window = BrowserWindow.fromId(id);
              if (!window) throw new Error('visual_window_closed');
              // macOS仅setFocusable(false)不会释放现有焦点，因此先hide再showInactive。
              window.hide(); window.setFocusable(false); window.showInactive();
            }, id);
            return name;
          }
          await pause();
        }
      } catch (error) {
        if (!page.isClosed() && !(error instanceof Error && error.message.includes('visual_window_closed'))) throw error;
      }
      throw new Error('visual_acceptance_cancelled');
    },
  };
}

export async function monitorVisualAcceptance({ page, helper, directory, expectedContactId, requestFinish }: {
  page: Page; helper: Page; directory: string; expectedContactId: string; requestFinish: () => Promise<boolean>;
}) {
  let stopped = false;
  const counts = { matches: 0, mismatches: 0, unverified: 0, monitorFailed: false };
  const done = (async () => {
    try {
      while (!stopped) {
        await verifyAppTestLease();
        const coordination: VisualCoordination = JSON.parse(await readFile(path.join(directory, 'control-state.json'), 'utf8'));
        if (coordination.state === 'closing') return;
        if (page.isClosed()) {
          await requestFinish();
          return;
        }
        const input = await helper.evaluate(async () => ({ foreground: await window.notalone.foreground.getState(),
          selectedContactId: (await window.notalone.contacts.getState()).selectedContactId }));
        const view = projectVisualAcceptance({ ...input, expectedContactId });
        const events = await page.evaluate(({ view, coordination, instruction, counts }) => {
          const state = (window as unknown as ControlWindow).acceptance;
          state.coordination = coordination;
          state.classification = view.classification;
          state.displayedAt = Date.now();
          document.getElementById('headline')!.textContent = view.headline;
          document.getElementById('detail')!.textContent = view.detail;
          document.getElementById('age')!.textContent = view.ageSeconds === null ? '尚无有效观察时点' : `最近观察：${view.ageSeconds}秒前；超过5秒不作当前判断`;
          document.getElementById('stage')!.textContent = coordination.state === 'failed-held' ? '本轮检查失败，保留同一实例' : '当前验收步骤';
          document.getElementById('instruction')!.textContent = coordination.state === 'failed-held' ? '可以对照状态记录人工判断，或结束本轮。不会自动重启。'
            : coordination.state === 'waiting-user' ? '尚未取得微信前台新观察。请点击微信，再点“重试本步”。' : instruction;
          const check = document.getElementById('check') as HTMLButtonElement;
          check.disabled = !['waiting-trigger', 'waiting-user'].includes(coordination.state);
          check.textContent = coordination.stage === 'finish' ? '完成并退出' : coordination.state === 'waiting-user' ? '重试本步' : '本步检查';
          document.getElementById('counts')!.textContent = `人工核对：一致${counts.matches} · 不一致${counts.mismatches} · 未验证${counts.unverified}`;
          return state.events.splice(0);
        }, { view, coordination, counts, instruction: instructions[coordination.stage ?? ''] ?? '正在进行正式App检查，请稍候。' });
        for (const event of events) {
          if (event.runId !== coordination.runId || event.stage !== coordination.stage) continue;
          if (['wechat', 'other'].includes(event.type)) {
            const age = Date.now() - (event.displayedAt ?? 0);
            if (age < 0 || age > 2000 || !['wechat', 'other'].includes(event.classification ?? '')) counts.unverified += 1;
            else if (event.classification === event.type) counts.matches += 1;
            else counts.mismatches += 1;
          } else {
            const signal = visualAcceptanceAction(coordination, event);
            if (signal) await writeFile(path.join(directory, signal), coordination.runId, { mode: 0o600 });
            if (signal === 'finish.trigger') return;
          }
        }
        await pause();
      }
    } catch {
      counts.monitorFailed = true;
      process.stdout.write('continuous_visual_monitor_failed\n');
      await requestFinish().catch(() => false);
    }
  })();
  return { counts, async stop() { stopped = true; await done; } };
}
