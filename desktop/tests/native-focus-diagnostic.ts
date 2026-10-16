import type { App, BrowserWindow } from 'electron';

export type NativeFocusDiagnosticStage = 'setup' | 'ordinary-hide-open' | 'system-hide-open' | 'quit';

// Electron 44.7.0 官方约定：app.show不自动聚焦，App激活与窗口焦点分别观察。
// https://github.com/electron/electron/blob/v44.7.0/docs/api/app.md
// https://github.com/electron/electron/blob/v44.7.0/docs/api/browser-window.md
// 此函数由现有app.evaluateHandle在自有主进程执行；全部运行时依赖必须留在函数内。
export function installNativeFocusDiagnostic(electron: { app: App;
  BrowserWindow: Pick<typeof BrowserWindow, 'getAllWindows' | 'getFocusedWindow'> },
  identity: { managerId: number; helperId: number }) {
  type Role = 'manager' | 'helper' | 'other';
  type WindowState = { role: Role; id: number | null; visible: boolean | null;
    focused: boolean | null; minimized: boolean | null };
  type Sample = { sequence: number; atMs: number; monotonicMs: number; stage: NativeFocusDiagnosticStage;
    appHidden: boolean | null; appActive: boolean | null; focusedWindowId: number | null;
    windows: WindowState[]; complete: boolean };
  type Event = { sequence: number; atMs: number; monotonicMs: number; stage: NativeFocusDiagnosticStage;
    source: 'app' | 'window'; event: string; role: Role | 'app'; id: number | null };
  const { app, BrowserWindow } = electron;
  const samples: Sample[] = [];
  const events: Event[] = [];
  const listeners: { source: NodeJS.EventEmitter; event: string; listener: (...args: unknown[]) => void }[] = [];
  const limits = { samples: 2048, events: 512, bytes: 1024 * 1024 };
  let stage: NativeFocusDiagnosticStage = 'setup';
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = true;
  let disposed = false;
  let incomplete = false;
  let cleanupComplete = false;
  let storedBytes = 0;
  const saturated = { samples: false, events: false, bytes: false };
  const role = (id: number | null): Role => id === identity.managerId ? 'manager'
    : id === identity.helperId ? 'helper' : 'other';
  const number = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) > 0
    ? value as number : null;
  const boolean = (read: () => unknown): boolean | null => {
    try { const value = read(); if (typeof value === 'boolean') return value; } catch {}
    incomplete = true;
    return null;
  };
  const halt = () => {
    running = false;
    if (timer !== undefined) {
      try { clearInterval(timer); timer = undefined; } catch { incomplete = true; }
    }
    // 只有实际移除成功才删除登记；失败项保留给后续dispose重试。
    for (let index = listeners.length - 1; index >= 0; index--) {
      const { source, event, listener } = listeners[index];
      try { source.removeListener(event, listener); listeners.splice(index, 1); }
      catch { incomplete = true; }
    }
    cleanupComplete = timer === undefined && listeners.length === 0;
  };
  const append = (kind: 'samples' | 'events', row: Sample | Event) => {
    if (!running) return;
    if ((kind === 'samples' ? samples : events).length >= limits[kind]) {
      saturated[kind] = true; halt(); return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    // 为最终固定元数据和数组标点预留空间，整个诊断JSON仍小于1MiB。
    if (storedBytes + bytes > limits.bytes - 4096) { saturated.bytes = true; halt(); return; }
    storedBytes += bytes;
    if (kind === 'samples') samples.push(row as Sample);
    else events.push(row as Event);
  };
  const takeSample = () => {
    if (!running) return;
    let complete = true;
    let current: BrowserWindow[] = [];
    let focusedWindowId: number | null = null;
    try { current = BrowserWindow.getAllWindows(); } catch { complete = false; }
    try {
      const focused = BrowserWindow.getFocusedWindow();
      focusedWindowId = focused ? number(focused.id) : null;
      if (focused && focusedWindowId === null) complete = false;
    } catch { complete = false; }
    if (current.length !== 2 || new Set(current.map(window => window.id)).size !== 2
      || !current.some(window => window.id === identity.managerId)
      || !current.some(window => window.id === identity.helperId)) complete = false;
    if (focusedWindowId !== null && !current.some(window => window.id === focusedWindowId)) complete = false;
    const windows = current.slice(0, 32).map(window => {
      const id = number(window.id);
      const item = { role: role(id), id, visible: boolean(() => window.isVisible()),
        focused: boolean(() => window.isFocused()), minimized: boolean(() => window.isMinimized()) };
      if (id === null || item.visible === null || item.focused === null || item.minimized === null) complete = false;
      return item;
    });
    const appHidden = boolean(() => app.isHidden());
    const appActive = boolean(() => app.isActive());
    complete &&= appHidden !== null && appActive !== null;
    incomplete ||= !complete;
    append('samples', { sequence: samples.length + 1, atMs: Date.now(), monotonicMs: performance.now(),
      stage, appHidden, appActive, focusedWindowId, windows, complete });
  };
  const listen = (source: NodeJS.EventEmitter, event: string, actor: 'app' | 'window', id: number | null) => {
    const listener = (...args: unknown[]) => {
      const window = actor === 'app' && event.startsWith('browser-window-') ? args[1] as BrowserWindow | undefined : null;
      const eventId = window ? number(window.id) : id;
      if (actor === 'app' && event.startsWith('browser-window-') && eventId === null) incomplete = true;
      append('events', { sequence: events.length + 1, atMs: Date.now(), monotonicMs: performance.now(),
        stage, source: actor, event, role: eventId === null ? 'app' : role(eventId), id: eventId });
    };
    try { source.on(event, listener); listeners.push({ source, event, listener }); }
    catch { incomplete = true; }
  };
  for (const event of ['did-become-active', 'did-resign-active', 'browser-window-focus', 'browser-window-blur']) {
    listen(app, event, 'app', null);
  }
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (![identity.managerId, identity.helperId].includes(window.id)) continue;
      for (const event of ['focus', 'blur', 'show', 'hide']) listen(window, event, 'window', window.id);
    }
  } catch { incomplete = true; }
  takeSample();
  if (running) timer = setInterval(takeSample, 250);
  const snapshot = () => ({ version: 1, intervalMs: 250, limits, storedBytes, stage, running, disposed,
    cleanupComplete, saturated: { ...saturated }, unknown: incomplete || Object.values(saturated).some(Boolean),
    samples: [...samples], events: [...events] });
  return {
    setStage(next: NativeFocusDiagnosticStage) {
      if (!['setup', 'ordinary-hide-open', 'system-hide-open', 'quit'].includes(next)) {
        throw new Error('native_focus_diagnostic_stage_invalid');
      }
      stage = next;
      takeSample();
    },
    snapshot,
    dispose() { disposed = true; halt(); return snapshot(); },
  };
}

type NativeFocusSnapshot = ReturnType<ReturnType<typeof installNativeFocusDiagnostic>['snapshot']>;

export async function releaseNativeFocusDiagnostic(cleanup: () => Promise<NativeFocusSnapshot>,
  release: () => Promise<void>, until: number, attempts: 1 | 2) {
  let snapshot: NativeFocusSnapshot | null = null;
  let unknown = false;
  let unavailable = false;
  for (let attempt = 0; attempt < attempts && Date.now() < until; attempt++) {
    try {
      snapshot = await cleanup();
      unknown ||= snapshot.unknown || !snapshot.cleanupComplete;
      if (!snapshot.cleanupComplete) continue;
      if (Date.now() >= until) break;
      await release();
      return { snapshot, released: true, unknown, unavailable };
    } catch { unknown = true; unavailable = true; }
  }
  return { snapshot, released: false, unknown: true, unavailable };
}
