import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

type Result = Record<string, unknown>;
type Pending = { resolve: (value: Result) => void; reject: (error: Error) => void };

// 仅处理自有合成进程的传输；业务控制、环境隔离及资源收尾由各夹具负责。
export class FixtureTransport<Prepared> {
  readonly ready: Promise<Prepared>;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private failure: Error | undefined;
  private readonly child: ChildProcess;
  private readonly commandTimeoutMs: number;

  constructor(child: ChildProcess, label: string, readyTimeoutMs = 70_000, commandTimeoutMs = 5000) {
    this.child = child;
    this.commandTimeoutMs = commandTimeoutMs;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`本轮${label} HTTP/PG 夹具启动超时。`)), readyTimeoutMs);
      const fail = (error: Error, terminal = true) => {
        clearTimeout(timer);
        if (terminal) this.failure ??= error;
        reject(error);
        for (const command of this.pending.values()) command.reject(error);
        this.pending.clear();
      };
      child.on('exit', () => fail(new Error(`本轮${label}夹具已退出。`)));
      child.on('error', () => fail(new Error(`本轮${label}夹具未启动。`)));
      child.stdin!.on('error', () => fail(new Error('本轮夹具控制通道已关闭。')));
      createInterface({ input: child.stdout! }).on('line', (line) => {
        try {
          const value = JSON.parse(line) as { ready?: Prepared; id?: number; result: Result };
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          if (value.ready) { clearTimeout(timer); resolve(value.ready); }
          else if (typeof value.id === 'number') {
            this.pending.get(value.id)?.resolve(value.result);
            this.pending.delete(value.id);
          }
          // 清理报告等无 id 的记录不作为命令成功；最终收尾仍须核验子进程退出码。
        } catch {
          // 记录损坏拒绝本次等待，但保留仍存活进程的控制通道供夹具明确停读收尾。
          fail(new Error('本轮夹具传输记录无效。'), false);
        }
      });
    });
  }

  command(operation: string, extra: object = {}): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本轮模型边界控制未完成。'));
      }, this.commandTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin!.write(`${JSON.stringify({ id, operation, ...extra })}\n`);
    });
  }
}

export async function requestFixtureHttp(infoPath: string, endpoint: string, body?: object) {
  const info = await readFile(infoPath, 'utf8');
  const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
  const token = /^token=([^\n]+)$/m.exec(info)?.[1];
  if (!address || !token) throw new Error('本轮受控握手未就绪。');
  const response = await fetch(`http://${address}${endpoint}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() as Result };
}
