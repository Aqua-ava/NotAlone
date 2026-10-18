import { app, BrowserWindow, type IpcMainInvokeEvent, type Session } from 'electron';
import path from 'node:path';

type WindowRole = 'manager' | 'helper';
type HostedWindow = { window: BrowserWindow; ready: Promise<void>; failed: boolean };
type HelperLifecycle = 'focused' | 'blurred' | 'hidden' | 'closed';
type HelperObservationHooks = {
  beforeShow(): Promise<void>;
  onLifecycle(event: HelperLifecycle): void;
};
const pages: Record<WindowRole, string> = {
  manager: 'notalone://app/index.html#manager',
  helper: 'notalone://app/index.html#helper',
};

export class AppWindows {
  private readonly windows = new Map<WindowRole, HostedWindow>();
  private quitting = false;
  private helperPinned = false;
  private helperToggle: Promise<void> = Promise.resolve();
  private helperObservation: HelperObservationHooks | undefined;

  constructor(private readonly appSession: Session) {}

  open(role: WindowRole, { background = false }: { background?: boolean } = {}): Promise<void> {
    return this.present(role, true, background);
  }

  private async present(role: WindowRole, focus: boolean, background = false): Promise<void> {
    if (this.quitting) return;
    let hosted = this.windows.get(role);
    if (hosted?.failed || hosted?.window.isDestroyed()) {
      if (!hosted.window.isDestroyed()) hosted.window.destroy();
      this.windows.delete(role);
      hosted = undefined;
    }
    if (!hosted) {
      hosted = { window: this.create(role), ready: Promise.resolve(), failed: false };
      this.windows.set(role, hosted);
      hosted.ready = this.load(role, hosted);
    }
    await hosted.ready;
    // 开发热重启只预加载；显式打开仍走原来的显示和焦点流程。
    if (background) return;
    const window = hosted.window;
    if (this.quitting || window.isDestroyed()) return;
    if (role === 'helper' && !hosted.failed && focus) {
      // 必须在 app.show、恢复窗口和取得焦点之前完成本次有界观察。
      // 定位不可用仍允许打开小窗，由具名定位状态要求人工确认。
      await this.helperObservation?.beforeShow().catch(() => {});
      if (this.quitting || window.isDestroyed()) return;
    }
    const shortcutPanel = role === 'helper' && !focus && process.platform === 'darwin';
    if (!shortcutPanel && app.isHidden()) {
      // app.show 会恢复整体隐藏前的窗口，先明确隐藏非目标窗口。
      for (const { window: other } of this.windows.values()) {
        if (other !== window && !other.isDestroyed()) other.hide();
      }
      app.show();
    }
    if (window.isMinimized()) window.restore();
    if (role === 'helper' && !focus) window.showInactive();
    else { window.show(); window.focus(); }
  }

  setHelperObservation(hooks: HelperObservationHooks): void { this.helperObservation = hooks; }

  prepareToQuit(): void {
    this.quitting = true;
    this.helperObservation?.onLifecycle('closed');
  }

  publish(channel: string, value: unknown, targetRole?: WindowRole): void {
    for (const [role, hosted] of this.windows) {
      if (targetRole && role !== targetRole) continue;
      if (!hosted.failed && !hosted.window.isDestroyed() && hosted.window.webContents.getURL() === pages[role]) {
        hosted.window.webContents.send(channel, value);
      }
    }
  }

  toggleHelper(): Promise<void> {
    // 连续按键按顺序处理，加载中的小窗也只能有一个。
    this.helperToggle = this.helperToggle.catch(() => {}).then(async () => {
      if (this.quitting) return;
      const hosted = this.windows.get('helper');
      const window = hosted?.window;
      if (!window || hosted.failed || window.isDestroyed() || !window.isVisible()
        || window.isMinimized() || (process.platform !== 'darwin' && app.isHidden())) await this.present('helper', false);
      else window.hide();
    });
    return this.helperToggle;
  }

  setHelperPinned(pinned: boolean): void {
    const window = this.windows.get('helper')?.window;
    if (window && !window.isDestroyed()) window.setAlwaysOnTop(pinned);
    this.helperPinned = pinned;
  }

  isHelperPinned(): boolean {
    const window = this.windows.get('helper')?.window;
    return window && !window.isDestroyed() ? window.isAlwaysOnTop() : this.helperPinned;
  }

  validateCaller(event: IpcMainInvokeEvent, args: unknown[]): BrowserWindow {
    const entry = [...this.windows.entries()].find(([, item]) => item.window.webContents === event.sender);
    const role = entry?.[0];
    const hosted = entry?.[1];
    const window = hosted?.window;
    if (!window || !role || hosted.failed || this.quitting || args.length !== 0
      || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== pages[role]) {
      throw new Error('窗口操作不可用');
    }
    return window;
  }

  private async load(role: WindowRole, hosted: HostedWindow): Promise<void> {
    try { await hosted.window.loadURL(pages[role]); }
    catch {
      hosted.window.destroy();
      if (this.quitting) return;
      hosted.failed = true;
      hosted.window = this.create(role);
      const title = role === 'manager' ? 'NotAlone · 管理后台' : 'NotAlone · 输入小窗';
      // 安全说明页独立于随包资源，无脚本；调用来源校验也拒绝它使用桥接。
      const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
        <title>${title}</title><style>body{margin:36px;background:#f3eee3;color:#31495b;font:16px system-ui}h1{font-size:20px}</style>
        <h1>窗口暂时无法打开</h1><p>请从“窗口”菜单重试。</p></html>`;
      try { await hosted.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); }
      catch {
        hosted.window.destroy();
        this.windows.delete(role);
        throw new Error('窗口操作不可用');
      }
    }
  }

  private create(role: WindowRole): BrowserWindow {
    const manager = role === 'manager';
    const window = new BrowserWindow({
      title: manager ? 'NotAlone · 管理后台' : 'NotAlone · 输入小窗',
      width: manager ? 1080 : 680,
      height: manager ? 740 : 520,
      minWidth: manager ? 800 : 680,
      minHeight: manager ? 580 : 520,
      resizable: manager,
      frame: manager,
      // 快捷键仅显示非激活面板；显式打开仍允许用户取得键盘焦点。
      type: !manager && process.platform === 'darwin' ? 'panel' : undefined,
      alwaysOnTop: !manager && this.helperPinned,
      show: false,
      backgroundColor: manager ? '#f3eee3' : '#fff9ed',
      webPreferences: {
        session: this.appSession,
        preload: path.join(app.getAppPath(), 'dist/preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    });
    if (!manager) window.setAlwaysOnTop(this.helperPinned);
    window.on('close', (event) => {
      if (!this.quitting) { event.preventDefault(); window.hide(); }
    });
    if (!manager) {
      window.on('focus', () => this.helperObservation?.onLifecycle('focused'));
      window.on('blur', () => this.helperObservation?.onLifecycle('blurred'));
      window.on('hide', () => this.helperObservation?.onLifecycle('hidden'));
      window.on('closed', () => this.helperObservation?.onLifecycle('closed'));
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    return window;
  }
}
