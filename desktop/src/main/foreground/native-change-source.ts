import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { diagnosticSignal, NativeHeaderChangeDiagnosticDecoder, type HeaderChangeDiagnosticRecord,
  type HeaderChangeDiagnosticSink, type HeaderChangeHostReason } from './header-change-diagnostics';

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
  private stopChild: ((reason: HeaderChangeHostReason) => void) | undefined;
  private closed: Promise<void> = Promise.resolve();
  private ordinal = 0;
  private readonly diagnosticBegan = performance.now();

  constructor(private readonly executable: () => Promise<string | undefined>,
    private readonly diagnostics?: HeaderChangeDiagnosticSink) {
    if (!diagnostics) return;
    try {
      const before = performance.now();
      const epochMs = Date.now();
      const after = performance.now();
      diagnostics.record({ kind: 'clock-anchor', elapsedMs: before + (after - before) / 2 - this.diagnosticBegan,
        epochMs, sampleSpanMs: after - before });
    } catch { /* 单次诊断锚点不参与调度或采集许可。 */ }
  }

  private record(event: Extract<HeaderChangeDiagnosticRecord, { kind: 'host' }>['event'],
    reason: HeaderChangeHostReason,
    details: Partial<Pick<Extract<HeaderChangeDiagnosticRecord, { kind: 'host' }>,
      'leaseElapsedMs' | 'epochCurrent' | 'paused' | 'stopping' | 'renewalEligible' | 'code' | 'signal'>> = {}): void {
    if (!this.diagnostics) return;
    try {
      this.diagnostics.record({ kind: 'host', event, reason, ordinal: this.ordinal,
        elapsedMs: performance.now() - this.diagnosticBegan, leaseElapsedMs: null,
        permitPresent: Boolean(this.desired), childPresent: Boolean(this.child), resolving: this.resolving,
        blocked: Boolean(this.desired && this.blockedScope === this.desired.scope),
        freshProof: Boolean(this.desired && this.lastProof !== this.desired.observation),
        epochCurrent: true, paused: false, stopping: false, renewalEligible: false, code: null, signal: 'none', ...details });
    } catch { /* 诊断故障不得改变原采集门禁。 */ }
  }

  update(permit: HeaderChangePermit | undefined, listener: (event: HeaderChangeEvent) => void): void {
    if (this.disposed) { this.record('permit', 'disposed'); return; }
    this.listener = listener;
    if (permit?.scope !== this.desired?.scope) {
      ++this.epoch; this.stopChild?.('scope_changed');
      this.blockedScope = undefined; this.lastProof = undefined;
    }
    this.desired = permit;
    this.record('permit', permit ? 'permit_present' : 'permit_absent');
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.desired = undefined; ++this.epoch;
    this.record('dispose', 'shutdown');
    this.stopChild?.('shutdown');
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
    const reason = this.disposed ? 'disposed' : !permit ? 'no_permit' : this.child ? 'child_running'
      : this.resolving ? 'resolving' : this.blockedScope === permit.scope ? 'scope_blocked'
        : this.lastProof === permit.observation ? 'proof_reused' : undefined;
    if (reason) { this.record('reconcile', reason); return; }
    if (!permit) return;
    this.resolving = true;
    this.record('reconcile', 'resolve');
    const epoch = this.epoch;
    void this.executable().then((executable) => {
      if (this.disposed || epoch !== this.epoch || this.desired?.scope !== permit.scope) {
        this.record('reconcile', 'resolve_stale', { epochCurrent: epoch === this.epoch }); return;
      }
      if (!executable || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
        this.blockedScope = permit.scope; this.record('reconcile', 'executable_unavailable'); return;
      }
      this.launch(executable, permit, epoch);
    }).catch(() => {
      if (epoch === this.epoch) this.blockedScope = permit.scope;
      this.record('reconcile', 'resolve_failed', { epochCurrent: epoch === this.epoch });
    })
      .finally(() => { this.resolving = false; this.reconcile(); });
  }

  private launch(executable: string, permit: HeaderChangePermit, epoch: number): void {
    const child = spawn(executable, ['--header-change-source', '--json'], {
      cwd: path.dirname(executable), env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
        ...(this.diagnostics ? { NOTALONE_HEADER_CHANGE_DIAGNOSTICS: '1' } : {}) },
      stdio: ['ignore', 'pipe', this.diagnostics ? 'pipe' : 'ignore'], windowsHide: true,
    });
    const ordinal = ++this.ordinal;
    this.child = child; this.lastProof = permit.observation;
    let closed!: () => void;
    this.closed = new Promise<void>((resolve) => { closed = resolve; });
    const began = Date.now();
    const diagnosticBegan = performance.now();
    let accepting = true, stopping = false, paused = false, bytes = 0, pending = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () => accepting && !this.disposed && this.child === child
      && epoch === this.epoch && this.desired?.scope === permit.scope;
    const details = () => ({ leaseElapsedMs: performance.now() - diagnosticBegan,
      epochCurrent: epoch === this.epoch, paused, stopping });
    this.record('launch', 'started', details());
    const stop = (reason: HeaderChangeHostReason) => {
      this.record('stop', reason, details());
      if (current() && !paused) { paused = true; this.listener('paused'); }
      accepting = false;
      if (stopping) return;
      stopping = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    };
    this.stopChild = stop;
    const watchdog = setTimeout(() => stop('watchdog'), 65_000);
    const invalid = (reason: HeaderChangeHostReason) => { this.blockedScope = permit.scope; stop(reason); };
    const decoder = this.diagnostics ? new NativeHeaderChangeDiagnosticDecoder((record) => {
      const value = 'kind' in record ? record : { kind: 'native' as const, ...record };
      try { this.diagnostics?.record({ ordinal,
        elapsedMs: performance.now() - this.diagnosticBegan, ...value }); } catch {}
    }, () => this.record('reconcile', 'native_diagnostic_rejected', details())) : undefined;
    if (decoder) child.stderr!.on('data', (chunk: Buffer) => decoder.push(chunk));
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!current()) return;
      bytes += chunk.length;
      if (bytes > 8192) { invalid('invalid_stdout'); return; }
      pending += chunk.toString('utf8');
      if (pending.length > 64 && !pending.includes('\n')) { invalid('invalid_stdout'); return; }
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!current()) return;
        if (line === '{"event":"changed"}') {
          this.record('changed', 'stdout_changed', details()); this.listener('changed');
        }
        else if (line === '{"event":"paused"}') {
          paused = true; accepting = false;
          this.record('paused', 'stdout_paused', details()); this.listener('paused');
          // 原生在停止采集之后才发paused；异常不退出仍由宿主有限兜底。
          killTimer = setTimeout(() => stop('stdout_paused'), 1000);
          return;
        } else { invalid('invalid_stdout'); return; }
      }
      if (pending.length > 64) invalid('invalid_stdout');
    });
    child.once('error', () => invalid('child_error'));
    child.once('close', (code, signal) => {
      decoder?.finish();
      closed();
      if (current() && !paused) { paused = true; this.listener('paused'); }
      clearTimeout(watchdog); clearTimeout(killTimer);
      accepting = false;
      if (this.child !== child) return;
      this.child = undefined; this.stopChild = undefined;
      // 只有真实完整租期正常到期可续租；提前退出／无效协议在连续许可内锁住。
      const renewalEligible = epoch === this.epoch && code === 0 && paused && !stopping && Date.now() - began >= 55_000;
      if (epoch === this.epoch && !renewalEligible) {
        this.blockedScope = permit.scope;
      }
      this.record('close', 'closed', { ...details(), renewalEligible, code, signal: diagnosticSignal(signal) });
      this.reconcile();
    });
  }
}
