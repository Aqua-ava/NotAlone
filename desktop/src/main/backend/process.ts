import path from 'node:path';
import { launchDsh } from '../../../../backend-ts/src/launch';
import { BackendFailure } from './connection';
import { validateLaunchConfiguration, wechatConfigurationPath, type BackendConfiguration } from './config';

export interface OwnedProcess {
  readonly pid: number;
  isRunning(): boolean;
  waitForExit(timeout: number): Promise<boolean>;
  terminate(): Promise<boolean>;
}

export class OwnedBackendProcess {
  static async launch(config: BackendConfiguration, canStart: () => boolean): Promise<OwnedProcess> {
    if (!canStart()) throw new BackendFailure('backend_connection_failed');
    const { projectDirectory } = await validateLaunchConfiguration(config);
    // 路径核验含异步 I/O，最终 spawn 前再次检查退出/连接代际，不在退出后新建读取进程。
    if (!canStart()) throw new BackendFailure('backend_connection_failed');
    // 唯一受支持的业务存储是受控 SQLite；没有控制面结果时不启动后台。
    if (!config.sqlite) throw new BackendFailure('backend_launch_requires_sqlite');
    const environment: NodeJS.ProcessEnv = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ, TMPDIR: process.env.TMPDIR,
      // 显式诊断预算必须进入实际 DSH 进程，不能只留在开发监督器环境中。
      NOTALONE_PROBLEM_BUDGET: process.env.NOTALONE_PROBLEM_BUDGET,
      NOTALONE_PROBLEM_ROUND: process.env.NOTALONE_PROBLEM_ROUND,
      NOTALONE_WECHAT_CONFIG: wechatConfigurationPath(), ...(config.syncProbePath ? { NOTALONE_SYNC_PROBE: config.syncProbePath } : {}) };
    return launchDsh({ nodeExecutable: process.execPath, projectDirectory,
      envFilePath: config.envFilePath || path.join(projectDirectory, '.env'), infoPath: config.infoPath,
      environment, businessHome: config.sqlite.userData, sqlite: config.sqlite }, canStart);
  }
}
