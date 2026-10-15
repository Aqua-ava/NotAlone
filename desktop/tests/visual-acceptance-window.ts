import type { ElectronApplication, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectVisualAcceptance, visualPreviewAction, type VisualAction, type VisualCounts,
  type VisualCoordination } from './visual-acceptance-view.mjs';
import { visualAcceptanceHtml, renderVisualAcceptance } from './visual-acceptance-html.mjs';
export { visualAcceptanceHtml } from './visual-acceptance-html.mjs';
import { verifyAppTestLease } from './app-test-gate';

type ControlWindow = Window & { acceptance: { begun: boolean; name: string; events: VisualAction[];
  classification: string; displayedAt: number; coordination: VisualCoordination | null } };
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
export async function openVisualAcceptance(app: ElectronApplication) {
  const opened = app.waitForEvent('window');
  const id = await app.evaluate(async ({ BrowserWindow, screen }, html) => {
    const area = screen.getPrimaryDisplay().workArea;
    const window = new BrowserWindow({ title: '正式App定位 · 实时可视验收', width: 460, height: 740,
      x: area.x + area.width - 480, y: area.y + 20, type: 'panel', alwaysOnTop: true,
      acceptFirstMouse: true, show: false, minimizable: false, maximizable: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'visual-acceptance' } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.showInactive();
    return window.id;
  }, visualAcceptanceHtml);
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

export async function monitorVisualAcceptance({ page, helper, directory, expectedContactId, requestFinish, openHelper }: {
  page: Page; helper: Page; directory: string; expectedContactId: string; requestFinish: () => Promise<boolean>;
  openHelper: () => Promise<void>;
}) {
  let stopped = false;
  let lastRevision: number | undefined;
  const counts: VisualCounts = { matches: 0, mismatches: 0, unverified: 0, monitorFailed: false,
    stateUpdates: 0, matchedSamples: 0, helperPausedSamples: 0, otherPausedSamples: 0, failures: {} };
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
        if (input.foreground.revision !== lastRevision) {
          lastRevision = input.foreground.revision;
          counts.stateUpdates += 1;
          if (view.matched) counts.matchedSamples += 1;
          if (input.foreground.suspendedByHelperFocus) counts.helperPausedSamples += 1;
          else if (view.classification === 'other') counts.otherPausedSamples += 1;
          if (view.failure) counts.failures[view.failure.code] = (counts.failures[view.failure.code] ?? 0) + 1;
        }
        const events = await page.evaluate(renderVisualAcceptance, { view, coordination, counts });
        for (const event of events) {
          const action = visualPreviewAction(coordination, event);
          if (!action) continue;
          if (['wechat', 'other'].includes(action)) {
            const age = Date.now() - (event.displayedAt ?? 0);
            if (age < 0 || age > 2000 || !['wechat', 'other'].includes(event.classification ?? '')) counts.unverified += 1;
            else if (event.classification === event.type) counts.matches += 1;
            else counts.mismatches += 1;
          } else if (action === 'finish') {
            await requestFinish();
            return;
          } else if (action === 'open-helper') await openHelper();
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
