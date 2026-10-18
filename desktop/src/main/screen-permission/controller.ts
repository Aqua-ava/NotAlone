import { initialScreenPermissionState, type ScreenPermissionState } from '../../shared/screen-permission-bridge';

export interface ScreenPermissionEffects {
  inspect(request: boolean, signal: AbortSignal): Promise<boolean | undefined>;
  openSettings(): Promise<void>;
  onGranted(): Promise<void>;
}

// 只管理权限引导，不读取微信或授予联系人／生成资格。
export class ScreenPermissionController {
  private state = { ...initialScreenPermissionState };
  private readonly listeners = new Set<(state: ScreenPermissionState) => void>();
  private flight: Promise<ScreenPermissionState> | undefined;
  private abort: AbortController | undefined;
  private disposed = false;
  private started = false;
  constructor(private readonly effects: ScreenPermissionEffects) {}
  getState(): ScreenPermissionState { return { ...this.state }; }
  onStateChanged(listener: (state: ScreenPermissionState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  startup(): Promise<ScreenPermissionState> {
    if (this.started || this.disposed) return Promise.resolve(this.getState());
    this.started = true;
    return this.operate(async (signal) => {
      // 启动与热重启仅更新页面状态；系统请求只能来自明确的授权按钮。
      await this.inspect(false, signal);
    });
  }
  recheck(): Promise<ScreenPermissionState> {
    return this.operate(async (signal) => { await this.inspect(false, signal); });
  }
  request(): Promise<ScreenPermissionState> {
    return this.operate((signal) => this.requestAccess(signal));
  }
  noteMissing(): void {
    if (!this.state.busy) this.publish({ phase: 'missing' });
  }
  dispose(): void {
    this.disposed = true; this.abort?.abort(); this.listeners.clear();
  }
  private async requestAccess(signal: AbortSignal): Promise<void> {
    const granted = await this.inspect(true, signal);
    if (granted === false && !signal.aborted) await this.effects.openSettings();
  }
  private async inspect(request: boolean, signal: AbortSignal): Promise<boolean | undefined> {
    const granted = await this.effects.inspect(request, signal);
    if (signal.aborted) return;
    this.publish({ phase: granted === true ? 'granted' : granted === false ? 'missing' : 'unavailable' });
    if (granted === true) await this.effects.onGranted();
    return granted;
  }
  private operate(operation: (signal: AbortSignal) => Promise<void>): Promise<ScreenPermissionState> {
    if (this.flight) return this.flight;
    if (this.disposed) return Promise.resolve(this.getState());
    const abort = new AbortController(); this.abort = abort;
    this.publish({ phase: 'checking', busy: true });
    const pending = Promise.resolve().then(() => operation(abort.signal)).catch(() => {
      if (!abort.signal.aborted) this.publish({ phase: 'unavailable' });
    }).finally(() => {
      this.publish({ busy: false });
      if (this.abort === abort) { this.abort = undefined; this.flight = undefined; }
    }).then(() => this.getState());
    this.flight = pending;
    return pending;
  }
  private publish(update: Partial<ScreenPermissionState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
