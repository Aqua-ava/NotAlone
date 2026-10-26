import path from 'node:path';
import os from 'node:os';
import { launchDsh } from '../../../../backend-ts/src/launch';
import { BackendFailure } from './connection';
import { backendEnvironment, validateLaunchConfiguration, type BackendConfiguration } from './config';

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
    const environment = backendEnvironment({ ...config, projectDirectory }, config.source === 'managed' ? path.dirname(path.dirname(config.infoPath)) : projectDirectory);
    return launchDsh({ nodeExecutable: process.execPath, projectDirectory,
      envFilePath: config.envFilePath || path.join(projectDirectory, '.env'), infoPath: config.infoPath,
      environment, businessHome: environment.HOME || os.homedir() }, canStart);
  }
}
