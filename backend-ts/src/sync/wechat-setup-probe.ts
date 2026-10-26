/** 固定只读 CLI 适配；输出仅驻留内存，调试路径与摘要不进入业务结果。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { WechatProbeUnavailable } from './wechat-setup.ts';

export class BoundedWechatCliRunner {
  private readonly options: { executable: string; environment?: NodeJS.ProcessEnv };
  private closed = false;
  private readonly active = new Map<ChildProcess, Promise<void>>();
  constructor(options: { executable: string; environment?: NodeJS.ProcessEnv }) { this.options = options; }
  async run(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || signal?.aborted) throw new WechatProbeUnavailable('wechat_tool_not_ready');
    if (!this.options.executable.trim()) throw new WechatProbeUnavailable('wechat_tool_unavailable');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new WechatProbeUnavailable('wechat_probe_failed');
    // 不允许通用执行器变为任意工具或写入入口。
    if (!['status','sessions'].includes(args[0]) || !args.includes('--strict-read-only')) throw new WechatProbeUnavailable('wechat_probe_failed');
    const child = spawn(this.options.executable, [...args], { env: this.options.environment, stdio: ['ignore','pipe','ignore'], shell: false });
    let done!: () => void;
    this.active.set(child, new Promise<void>(resolve => { done = resolve; }));
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const chunks: Buffer[] = []; let bytes = 0; let failed = false;
        let unavailable = false;
        const abort = () => { failed = true; child.kill('SIGKILL'); };
        const timer = setTimeout(abort, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { failed = true; chunks.length = 0; child.kill('SIGKILL'); }
          else if (!failed) chunks.push(chunk);
        });
        child.on('error', (error: NodeJS.ErrnoException) => { failed = true; unavailable = error.code === 'ENOENT' || error.code === 'EACCES'; });
        child.once('close', code => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (failed || this.closed || code !== 0) { reject(new WechatProbeUnavailable(unavailable ? 'wechat_tool_unavailable' : 'wechat_tool_not_ready')); return; }
          try {
            const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!envelope || envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') throw new Error();
            resolve(envelope.data);
          } catch { reject(new WechatProbeUnavailable('wechat_probe_failed')); }
        });
      });
    } finally { this.active.delete(child); done(); }
  }
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.active.values()];
    for (const child of this.active.keys()) child.kill('SIGKILL');
    await Promise.all(pending);
  }
}
export interface WechatCliRunner { run(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> }
export class WechatSetupProbe {
  private readonly runner: WechatCliRunner;
  constructor(options: { executable: string; environment?: NodeJS.ProcessEnv; runner?: WechatCliRunner }) {
    this.runner = options.runner ?? new BoundedWechatCliRunner(options);
  }
  async detect(signal?: AbortSignal): Promise<string> {
    const data = await this.runner.run(['status','--include-debug','--strict-read-only'], 5000, signal) as Record<string, any>;
    return parseConfiguredWechatAccount(data);
  }
  /** 仅在用户确认必要的列表访问同意后调用，列表及摘要立即丢弃。 */
  async confirm(account: string, signal?: AbortSignal): Promise<string> {
    if (await this.detect(signal) !== account) throw new WechatProbeUnavailable('wechat_account_changed');
    const data = await this.runner.run(['sessions','--type-filter','private','--limit','1','--strict-read-only'], 1000, signal) as Record<string, unknown>;
    if (!Array.isArray(data?.sessions)) throw new WechatProbeUnavailable('wechat_probe_failed');
    if (await this.detect(signal) !== account) throw new WechatProbeUnavailable('wechat_account_changed');
    return account;
  }
  close(): Promise<void> { return this.runner.close(); }
}

/** 只投影经只读与就绪证据核验的稳定账号。 */
export function parseConfiguredWechatAccount(data: unknown): string {
  const status = (data as { status?: Record<string, any> } | null)?.status;
  if (!status || status.account?.identity_configured !== true || status.account?.schema2_ready !== true || status.live_read_ok !== true || !['ready','degraded'].includes(status.readiness) || status.mode?.strict_read_only !== true) throw new WechatProbeUnavailable('wechat_tool_not_ready');
  const identity = status.account_debug?.wxid;
  if (typeof identity !== 'string' || !/^[A-Za-z0-9_.@-]{1,255}$/.test(identity)) throw new WechatProbeUnavailable('wechat_probe_failed');
  return identity;
}
