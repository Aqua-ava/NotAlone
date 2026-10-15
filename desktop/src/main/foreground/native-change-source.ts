import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export type HeaderChangeEvent = 'changed' | 'paused';
export type HeaderChangePermit = { scope: string; observation: string };
export interface ForegroundChangeSource {
  update(permit: HeaderChangePermit | undefined, listener: (event: HeaderChangeEvent) => void): void;
  dispose(): void;
}

// 只拥有一个自有、有限寿命的子进程。旧子close前永不替换，输出不写日志。
export class NativeHeaderChangeSource implements ForegroundChangeSource {
  private desired: HeaderChangePermit | undefined;
  private listener: (event: HeaderChangeEvent) => void = () => {};
  private child: ChildProcess | undefined;
  private epoch = 0;
  private resolving = false;
  private disposed = false;
  private blockedScope: string | undefined;
  private lastProof: string | undefined;
  private stopChild: (() => void) | undefined;
  private closed: Promise<void> = Promise.resolve();

  constructor(private readonly executable: () => Promise<string | undefined>) {}

  update(permit: HeaderChangePermit | undefined, listener: (event: HeaderChangeEvent) => void): void {
    if (this.disposed) return;
    this.listener = listener;
    if (permit?.scope !== this.desired?.scope) {
      ++this.epoch; this.stopChild?.();
      this.blockedScope = undefined; this.lastProof = undefined;
    }
    this.desired = permit;
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.desired = undefined; ++this.epoch;
    this.stopChild?.();
  }

  async shutdown(): Promise<void> {
    this.dispose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('header_change_shutdown_unconfirmed')), 2500);
      })]);
    } finally { clearTimeout(timer); }
  }

  private reconcile(): void {
    const permit = this.desired;
    if (this.disposed || !permit || this.child || this.resolving || this.blockedScope === permit.scope
      || this.lastProof === permit.observation) return;
    this.resolving = true;
    const epoch = this.epoch;
    void this.executable().then((executable) => {
      if (this.disposed || epoch !== this.epoch || this.desired?.scope !== permit.scope) return;
      if (!executable || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
        this.blockedScope = permit.scope; return;
      }
      this.launch(executable, permit, epoch);
    }).catch(() => { if (epoch === this.epoch) this.blockedScope = permit.scope; })
      .finally(() => { this.resolving = false; this.reconcile(); });
  }

  private launch(executable: string, permit: HeaderChangePermit, epoch: number): void {
    const child = spawn(executable, ['--header-change-source', '--json'], {
      cwd: path.dirname(executable), env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    this.child = child; this.lastProof = permit.observation;
    let closed!: () => void;
    this.closed = new Promise<void>((resolve) => { closed = resolve; });
    const began = Date.now();
    let accepting = true, stopping = false, paused = false, bytes = 0, pending = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () => accepting && !this.disposed && this.child === child
      && epoch === this.epoch && this.desired?.scope === permit.scope;
    const stop = () => {
      if (current() && !paused) { paused = true; this.listener('paused'); }
      accepting = false;
      if (stopping) return;
      stopping = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    };
    this.stopChild = stop;
    const watchdog = setTimeout(stop, 65_000);
    const invalid = () => { this.blockedScope = permit.scope; stop(); };
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!current()) return;
      bytes += chunk.length;
      if (bytes > 8192) { invalid(); return; }
      pending += chunk.toString('utf8');
      if (pending.length > 64 && !pending.includes('\n')) { invalid(); return; }
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!current()) return;
        if (line === '{"event":"changed"}') this.listener('changed');
        else if (line === '{"event":"paused"}') {
          paused = true; accepting = false; this.listener('paused');
          // 原生在停止采集之后才发paused；异常不退出仍由宿主有限兜底。
          killTimer = setTimeout(stop, 1000);
          return;
        } else { invalid(); return; }
      }
      if (pending.length > 64) invalid();
    });
    child.once('error', invalid);
    child.once('close', (code) => {
      closed();
      if (current() && !paused) { paused = true; this.listener('paused'); }
      clearTimeout(watchdog); clearTimeout(killTimer);
      accepting = false;
      if (this.child !== child) return;
      this.child = undefined; this.stopChild = undefined;
      // 只有真实完整租期正常到期可续租；提前退出／无效协议在连续许可内锁住。
      if (epoch === this.epoch && !(code === 0 && paused && !stopping && Date.now() - began >= 55_000)) {
        this.blockedScope = permit.scope;
      }
      this.reconcile();
    });
  }
}
