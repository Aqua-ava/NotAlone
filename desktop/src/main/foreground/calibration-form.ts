import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';

export type CoordinateProposal = {
  schemaVersion: 1;
  windowSize: { width: number; height: number };
  regions: Record<string, { x: number; y: number; width: number; height: number }>;
};
const fields = [
  ['displayName', '顶部会话名'], ['selectedRowName', '选中行会话名'],
  ['verticalDivider', '聊天区左侧分隔细条'], ['headerDivider', '标题下方分隔细条'],
  ['selectedHighlight', '选中行无文字高亮细条'],
] as const;
const submission = 'https://notalone-calibration.invalid/submit';

// 独立无脚本表单，无preload或IPC；提交只接受固定几何字段，导航与网络均拦截。
export function requestCalibrationCoordinates(parent: BrowserWindow, signal: AbortSignal): Promise<CoordinateProposal | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || parent.isDestroyed()) { resolve(undefined); return; }
    const isolated = session.fromPartition(`calibration-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ parent, modal: true, title: 'NotAlone · 最小区域坐标',
      width: 650, height: 680, resizable: false, show: false,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
    let settled = false;
    const finish = (value?: CoordinateProposal, error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); signal.removeEventListener('abort', cancel);
      if (!window.isDestroyed()) window.destroy();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish();
    const deadline = setTimeout(cancel, 180_000);
    signal.addEventListener('abort', cancel, { once: true });
    window.on('closed', cancel);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame) event.preventDefault(); });
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      try {
        if (url.length > 4096) throw new Error('calibration_coordinates_invalid');
        const target = new URL(url);
        if (target.origin + target.pathname !== submission || target.hash || target.username || target.password) return;
        const allowed = ['windowWidth', 'windowHeight', ...fields.map(([name]) => name), 'cancel'];
        if ([...target.searchParams.keys()].some(key => !allowed.includes(key) || target.searchParams.getAll(key).length !== 1)) return;
        if (target.searchParams.get('cancel') === '1') { finish(); return; }
        const scalar = (text: string | null) => {
          if (text === null || !/^\d+(?:\.\d+)?$/.test(text.trim())) throw new Error('calibration_coordinates_invalid');
          const value = Number(text); if (!Number.isFinite(value) || value > 10_000) throw new Error('calibration_coordinates_invalid');
          return value;
        };
        const width = scalar(target.searchParams.get('windowWidth')), height = scalar(target.searchParams.get('windowHeight'));
        if (width < 600 || height < 400) throw new Error('calibration_coordinates_invalid');
        const regions: CoordinateProposal['regions'] = {};
        for (const [name] of fields) {
          const parts = target.searchParams.get(name)?.split(',');
          if (parts?.length !== 4) throw new Error('calibration_coordinates_invalid');
          const [x, y, width, height] = parts.map(scalar);
          regions[name] = { x, y, width, height };
        }
        finish({ schemaVersion: 1, windowSize: { width, height }, regions });
      } catch { finish(undefined, new Error('calibration_coordinates_invalid')); }
    });
    const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action https://notalone-calibration.invalid">
      <title>NotAlone · 最小区域坐标</title><style>body{margin:26px;font:15px system-ui;color:#243c48;background:#f3eee3}h1{font-size:21px}label{display:block;margin-top:13px}input{display:block;width:95%;padding:7px;font:15px system-ui}button{margin:20px 12px 0 0;padding:9px}p{line-height:1.5}</style>
      <h1>输入五处最小区域</h1><p>以微信窗口左上角为原点，单位为点。每个区域填写 x,y,宽,高。只保存待校验几何，不采集图像或确认联系人。</p>
      <form action="${submission}" method="get">
      <label>微信窗口宽度<input name="windowWidth" required maxlength="8" inputmode="decimal"></label>
      <label>微信窗口高度<input name="windowHeight" required maxlength="8" inputmode="decimal"></label>
      ${fields.map(([name, label]) => `<label>${label}<input name="${name}" required maxlength="64" placeholder="x,y,宽,高"></label>`).join('')}
      <button type="submit">确认五处选区，仅保存待校验几何</button><button name="cancel" value="1" formnovalidate>取消</button></form></html>`;
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
      if (!settled && !window.isDestroyed()) { window.show(); window.focus(); }
    }).catch(() => finish(undefined, new Error('calibration_form_unavailable')));
  });
}
