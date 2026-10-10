import { BrowserWindow, dialog } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { savePendingCalibrationSelection } from './calibration-selection';
import { loadBackendConfiguration } from '../backend/config';

// 只由原生菜单启动明确的用户框选，不向 renderer 暴露任意命令或文件路径。
export class ForegroundCalibration {
  private flight: Promise<void> | undefined;
  private child: ChildProcess | undefined;
  private disposed = false;
  private abort: AbortController | undefined;
  constructor(private readonly userData: string, private readonly resourcesDirectory: string | undefined) {}

  start(): void {
    if (this.disposed || this.flight) return;
    const parent = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'notalone://app/index.html#manager');
    if (!parent) return;
    this.abort = new AbortController();
    this.flight = this.run(parent, this.abort.signal).catch(async () => {
      if (!this.disposed && !parent.isDestroyed()) await dialog.showMessageBox(parent, { type: 'error', title: 'NotAlone',
        message: '最小区域选择未完成；前台定位继续暂停，请从窗口菜单重试。', signal: this.abort?.signal });
    }).finally(() => { this.flight = undefined; this.abort = undefined; });
  }
  async cancel(): Promise<void> {
    this.disposed = true;
    this.abort?.abort();
    this.child?.kill('SIGTERM');
    const child = this.child;
    const escalation = setTimeout(() => {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    try { await this.flight; } finally { clearTimeout(escalation); this.disposed = false; }
  }
  isRunning(): boolean { return this.flight !== undefined; }

  private async run(parent: BrowserWindow, signal: AbortSignal): Promise<void> {
    const instructions = await dialog.showMessageBox(parent, { type: 'info', title: '选择微信最小定位区域', signal,
      message: '请准备无私人资料的微信测试会话',
      detail: '点击开始后，手工切回微信。框选器只覆盖该微信窗口，按说明选择两处会话名和三条无文字细条；回车确认、Esc取消。此次只保存几何，不截图、不读取聊天或启用自动定位。',
      buttons: ['开始选择', '取消'], defaultId: 0, cancelId: 1 });
    if (this.disposed || instructions.response !== 0) return;
    const configuration = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
    if (!configuration.syncProbePath || this.disposed) throw new Error('calibration_unavailable');
    const output = await this.invoke(configuration.syncProbePath);
    if (this.disposed) return;
    const envelope: unknown = JSON.parse(output);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('calibration_output_invalid');
    const result = envelope as Record<string, unknown>;
    if (result.ok !== true) {
      if (result.error === 'calibration_cancelled') return;
      throw new Error('calibration_unavailable');
    }
    if (!await savePendingCalibrationSelection(this.userData, result.selection, () => !this.disposed)) return;
    if (!this.disposed && !parent.isDestroyed()) await dialog.showMessageBox(parent, { type: 'info', title: '最小区域选择已保存', signal,
      message: '区域已选，等待布局校验', detail: '仅保存微信版本、进程与窗口标识及五处几何。没有保存或采集图像，自动定位仍暂停。', buttons: ['知道了'] });
  }

  private invoke(executable: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['--calibrate-minimal-region', '--json'], {
        stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' },
      });
      this.child = child;
      let output = Buffer.alloc(0);
      let failed = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        failed = true; child.kill('SIGTERM');
        escalation ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 3000);
      };
      const timeout = setTimeout(stop, 400_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (output.length + chunk.length > 8192) { stop(); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.once('error', () => { failed = true; });
      child.once('close', (code) => {
        clearTimeout(timeout);
        clearTimeout(escalation);
        if (this.child === child) this.child = undefined;
        if (failed || code !== 0) reject(new Error('calibration_unavailable'));
        else resolve(output.toString('utf8'));
      });
    });
  }
}
