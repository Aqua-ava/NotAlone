import { BrowserWindow, dialog } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { savePendingCalibrationSelection } from './calibration-selection';
import { loadBackendConfiguration } from '../backend/config';
import { requestCalibrationCoordinates, type CoordinateProposal } from './calibration-form';
import { invalidateCalibrationProfile, layoutVerificationErrors, layoutVerificationStages, readPendingSelection, saveLayoutVerificationResult, saveVerifiedProfile, saveVerificationProgress, verificationProgressReceiver } from './calibration-profile';

const verificationMessages: Record<string, string> = {
  calibration_coordinates_invalid: '选区未保存：坐标格式或五处区域边界不符合要求。',
  calibration_context_unavailable: '选区未保存：未找到唯一且受支持的可见微信窗口。',
  calibration_wechat_instances_ambiguous: '选区未保存：未找到唯一运行中的微信实例。',
  calibration_wechat_version_unsupported: '选区未保存：当前微信版本不在已验证范围内。',
  calibration_window_not_visible: '选区未保存：当前桌面没有可见的微信主窗口。',
  calibration_windows_ambiguous: '选区未保存：当前桌面存在多个微信窗口，请保留一个主窗口。',
  calibration_window_geometry_invalid: '选区未保存：微信窗口尺寸过小或几何信息不可用。',
  calibration_window_size_changed: '选区未保存：填写尺寸与实际微信窗口不一致。',
  calibration_window_changed: '选区未保存：提交期间微信窗口发生变化。',
  calibration_probe_missing: '选区未保存：当前宿主未找到可用的定位探针。',
  calibration_probe_failed: '选区未保存：定位探针进程未正常完成。',
  screen_capture_permission_missing: '校验未开始：当前探针缺少屏幕录制权限。',
  wechat_not_in_front: '校验已停止：原生检测未确认微信在前台。',
  minimal_region_layout_changed: '校验已停止：窗口或布局与所选五处区域不一致。',
  quality_unverified: '校验已停止：两处名称或布局细条未通过质量核对。',
  header_name_unreadable: '校验已停止：顶部名称未识别为完整单行，请核对选区。',
  row_name_unreadable: '校验已停止：选中行名称未识别为完整单行，请核对选区。',
  session_names_mismatch: '校验已停止：顶部名称与选中行名称识别结果不一致。',
  session_name_confidence_low: '校验已停止：名称一致，但识别置信度未达到要求。',
  minimal_region_capture_failed: '校验已停止：最小区域采集未完成。',
};

// 只由原生菜单启动明确的用户框选，不向 renderer 暴露任意命令或文件路径。
export class ForegroundCalibration {
  private flight: Promise<void> | undefined;
  private child: ChildProcess | undefined;
  private disposed = false;
  private abort: AbortController | undefined;
  constructor(private readonly userData: string, private readonly resourcesDirectory: string | undefined) {}

  start(verify = false): void {
    if (this.disposed || this.flight) return;
    const parent = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'notalone://app/index.html#manager');
    if (!parent) return;
    this.abort = new AbortController();
    this.flight = (verify ? this.verify(parent, this.abort.signal) : this.run(parent, this.abort.signal)).catch(async (error: unknown) => {
      if (!verify && !this.disposed) {
        const code = error instanceof Error && layoutVerificationErrors.includes(error.message as typeof layoutVerificationErrors[number])
          ? error.message : 'calibration_unavailable';
        await saveLayoutVerificationResult(this.userData, 'failed', code, 'selection', () => !this.disposed);
      }
      if (!this.disposed && !parent.isDestroyed()) await dialog.showMessageBox(parent, { type: 'error', title: 'NotAlone',
        message: (error instanceof Error && verificationMessages[error.message])
          || '最小区域选择或校验未完成；前台定位继续暂停，请从窗口菜单重试。', signal: this.abort?.signal });
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
    await invalidateCalibrationProfile(this.userData);
    const instructions = await dialog.showMessageBox(parent, { type: 'info', title: '选择微信最小定位区域', signal,
      message: '请准备无私人资料的微信测试会话',
      detail: '可输入明确的五处坐标，也可手工切回微信拖动框选。选择只保存待校验几何，不截图、不读取聊天或启用自动定位。',
      buttons: ['输入坐标', '拖动框选', '取消'], defaultId: 0, cancelId: 2 });
    if (this.disposed || instructions.response === 2) return;
    const coordinates = instructions.response === 0 ? await requestCalibrationCoordinates(parent, signal) : undefined;
    if (this.disposed || (instructions.response === 0 && !coordinates)) return;
    const configuration = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
    if (!configuration.syncProbePath || this.disposed) throw new Error('calibration_probe_missing');
    const output = await this.invoke(configuration.syncProbePath, coordinates);
    if (this.disposed) return;
    const envelope: unknown = JSON.parse(output);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('calibration_output_invalid');
    const result = envelope as Record<string, unknown>;
    if (result.ok !== true) {
      if (result.error === 'calibration_cancelled') return;
      throw new Error(layoutVerificationErrors.includes(result.error as typeof layoutVerificationErrors[number])
        ? result.error as string : 'calibration_unavailable');
    }
    if (!await savePendingCalibrationSelection(this.userData, result.selection, () => !this.disposed)) return;
    if (!this.disposed && !parent.isDestroyed()) await dialog.showMessageBox(parent, { type: 'info', title: '最小区域选择已保存', signal,
      message: '区域已选，等待布局校验', detail: '仅保存微信版本、进程与窗口标识及五处几何。没有保存或采集图像，自动定位仍暂停。', buttons: ['知道了'] });
  }

  private async verify(parent: BrowserWindow, signal: AbortSignal): Promise<void> {
    await invalidateCalibrationProfile(this.userData);
    let code: typeof layoutVerificationErrors[number] = 'calibration_unavailable';
    let stage: typeof layoutVerificationStages[number] = 'host';
    try {
      const selection = await readPendingSelection(this.userData);
      const choice = await dialog.showMessageBox(parent, { type: 'info', title: '校验微信最小区域', signal,
        message: '校验已选择的五处区域',
        detail: '只读取两处会话名与三处无文字细条，在本机内存核对。不会保存图像或确认联系人。开始后请切回当前微信窗口，60秒内未就绪即停止。',
        buttons: ['校验', '取消'], defaultId: 0, cancelId: 1 });
      if (this.disposed || choice.response !== 0) return;
      const configuration = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
      if (!configuration.syncProbePath || this.disposed) throw new Error('calibration_unavailable');
      await saveVerificationProgress(this.userData, 'host', () => !this.disposed);
      const result = JSON.parse(await this.invoke(configuration.syncProbePath, undefined, selection)) as Record<string, unknown>;
      if (this.disposed) return;
      if (result?.ok !== true) {
        if (layoutVerificationErrors.includes(result?.error as typeof layoutVerificationErrors[number])) code = result.error as typeof code;
        if (layoutVerificationStages.includes(result?.verification_stage as typeof layoutVerificationStages[number])) stage = result.verification_stage as typeof stage;
        throw new Error(code);
      }
      if (!await saveVerifiedProfile(this.userData, result.profile, () => !this.disposed)) return;
      await saveLayoutVerificationResult(this.userData, 'verified', null, 'profile', () => !this.disposed);
    } catch {
      if (this.disposed) return;
      await invalidateCalibrationProfile(this.userData, false);
      await saveLayoutVerificationResult(this.userData, 'failed', code, stage, () => !this.disposed);
      throw new Error(code);
    }
    if (!parent.isDestroyed()) await dialog.showMessageBox(parent, { type: 'info', title: '布局校验已保存', signal,
      message: '当前微信布局已校验', detail: '只保存几何、缩放比例和细条摘要；没有保存图像。联系人仍需与已确认的绑定核对。', buttons: ['知道了'] });
  }

  private invoke(executable: string, coordinates?: CoordinateProposal, selection?: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      const input = coordinates ?? selection;
      const arguments_ = selection ? ['--verify-minimal-region', '--json'] : ['--calibrate-minimal-region', '--json', ...(coordinates ? ['--coordinates'] : [])];
      const child = spawn(executable, arguments_, {
        stdio: [input ? 'pipe' : 'ignore', 'pipe', selection ? 'pipe' : 'ignore'], env: { PATH: '/usr/bin:/bin' },
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
      let progressWrites = Promise.resolve();
      const receiveProgress = verificationProgressReceiver((stage) => {
        progressWrites = progressWrites.then(() => saveVerificationProgress(this.userData, stage, () => !this.disposed));
        void progressWrites.catch(stop);
      });
      child.stderr?.on('data', (chunk: Buffer) => { if (!receiveProgress(chunk)) stop(); });
      child.stdin?.on('error', stop);
      if (input) child.stdin?.end(JSON.stringify(input));
      child.stdout?.on('data', (chunk: Buffer) => {
        if (output.length + chunk.length > 8192) { stop(); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.once('error', () => { failed = true; });
      child.once('close', async (code) => {
        clearTimeout(timeout);
        clearTimeout(escalation);
        if (this.child === child) this.child = undefined;
        try { await progressWrites; } catch { failed = true; }
        if (failed || code !== 0) reject(new Error(selection ? 'calibration_unavailable' : 'calibration_probe_failed'));
        else resolve(output.toString('utf8'));
      });
    });
  }
}
