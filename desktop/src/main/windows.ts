import { app, BrowserWindow, type IpcMainInvokeEvent, type Session } from 'electron';
import path from 'node:path';

type WindowRole = 'manager' | 'helper';
type HostedWindow = { window: BrowserWindow; ready: Promise<void>; failed: boolean };
const pages: Record<WindowRole, string> = {
  manager: 'notalone://app/index.html#manager',
  helper: 'notalone://app/index.html#helper',
};

export class AppWindows {
  private readonly windows = new Map<WindowRole, HostedWindow>();
  private quitting = false;
  private helperPinned = false;
  private helperToggle: Promise<void> = Promise.resolve();

  constructor(private readonly appSession: Session) {}

  async open(role: WindowRole): Promise<void> {
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
    const window = hosted.window;
    if (this.quitting || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (app.isHidden()) app.show();
    window.show();
    window.focus();
  }

  prepareToQuit(): void { this.quitting = true; }

  toggleHelper(): Promise<void> {
    // 连续按键按顺序处理，加载中的小窗也只能有一个。
    this.helperToggle = this.helperToggle.catch(() => {}).then(async () => {
      if (this.quitting) return;
      const hosted = this.windows.get('helper');
      const window = hosted?.window;
      if (!window || hosted.failed || window.isDestroyed() || !window.isVisible()
        || window.isMinimized() || app.isHidden()) await this.open('helper');
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
      height: manager ? 740 : 216,
      minWidth: manager ? 800 : 680,
      minHeight: manager ? 580 : 216,
      resizable: manager,
      frame: manager,
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
    window.on('close', (event) => {
      if (!this.quitting) { event.preventDefault(); window.hide(); }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    return window;
  }
}
