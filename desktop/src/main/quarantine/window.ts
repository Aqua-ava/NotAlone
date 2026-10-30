import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { QuarantineViewer } from '../../../../backend-ts/src/history/quarantine-viewer.ts';
import type { QuarantineVault } from '../../../../backend-ts/src/history/quarantine-vault.ts';
import type { QuarantinePresentation } from './controller';

/** 没有 preload 的独立本机窗口；正文不经过普通业务页面与模型服务。 */
export async function presentQuarantine(vault: QuarantineVault): Promise<QuarantinePresentation> {
  const viewer = await QuarantineViewer.start(vault);
  const origin = new URL(viewer.url).origin;
  const isolated = session.fromPartition(`quarantine-${randomUUID()}`, { cache: false });
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try { allowed = new URL(details.url).origin === origin; } catch {}
    callback({cancel:!allowed});
  });
  let window: BrowserWindow | undefined;
  let stopped: Promise<void> | undefined;
  const close = () => stopped ??= (async () => {
    if (window && !window.isDestroyed()) window.destroy();
    await viewer.close();
    await isolated.clearStorageData();
  })();
  try {
    window = new BrowserWindow({width:880,height:720,minWidth:560,minHeight:420,show:false,
      title:'NotAlone · 未核验历史',backgroundColor:'#f7f7f4',
      webPreferences:{session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false}});
    const closed = new Promise<void>(resolve => window!.once('closed', () => resolve()));
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    await window.loadURL(viewer.url);
    if (window.isDestroyed()) throw new Error('quarantine_window_closed');
    window.show();
    return {closed,close,focus:()=>{if (window && !window.isDestroyed()) {if(window.isMinimized())window.restore();window.show();window.focus();}}};
  } catch (error) { await close(); throw error; }
}
