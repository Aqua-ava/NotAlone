import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { BackendFailure } from './connection';
import { validateLaunchConfiguration, type BackendConfiguration } from './config';

export class OwnedBackendProcess {
  private readonly exited: Promise<void>;

  private constructor(private readonly child: ChildProcess, readonly pid: number) {
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()));
  }

  static async launch(config: BackendConfiguration, canStart: () => boolean): Promise<OwnedBackendProcess> {
    if (!canStart()) throw new BackendFailure('backend_connection_failed');
    const { pythonExecutable, projectDirectory } = await validateLaunchConfiguration(config);
    // 路径核验含异步 I/O，最终 spawn 前再次检查退出/连接代际，不在退出后新建读取进程。
    if (!canStart()) throw new BackendFailure('backend_connection_failed');
    // 不用 shell 或 PATH，模块路径固定到所选项目，避免 editable install 指向另一个 checkout。
    const child = spawn(pythonExecutable, ['-m', 'notalone.server.command', '--host', '127.0.0.1'], {
      cwd: projectDirectory,
      env: { ...process.env, PYTHONPATH: path.join(projectDirectory, 'backend/src'), PYTHONNOUSERSITE: '1',
        NOTALONE_BACKEND_INFO: config.infoPath,
        NOTALONE_ENV_FILE: config.envFilePath || path.join(projectDirectory, '.env') },
      // 后端 stdout 含 token；不用 stdout 发现连接，也不转发任何原始输出。
      stdio: 'ignore',
    });
    return new Promise((resolve, reject) => {
      child.once('error', () => reject(new BackendFailure('backend_connection_failed')));
      child.once('spawn', () => {
        if (!child.pid) reject(new BackendFailure('backend_connection_failed'));
        else resolve(new OwnedBackendProcess(child, child.pid));
      });
    });
  }

  isRunning(): boolean { return this.child.pid === this.pid && this.child.exitCode === null && this.child.signalCode === null; }

  async waitForExit(timeout: number): Promise<boolean> {
    if (!this.isRunning()) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.exited.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout); })]);
    } finally { clearTimeout(timer); }
  }

  async terminate(): Promise<boolean> {
    if (!this.isRunning()) return true;
    this.child.kill('SIGTERM');
    // 后端资源收尾预算是 4 秒，预留 HTTP 服务循环退出的余量。
    if (await this.waitForExit(5000)) return true;
    if (this.isRunning()) this.child.kill('SIGKILL');
    return this.waitForExit(1000);
  }
}
