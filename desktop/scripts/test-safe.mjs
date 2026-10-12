import { spawnSync } from 'node:child_process';

process.stdout.write('验证范围：类型检查、App/无头页面调度 CLI 合成进程、helper 静态核查/搬运及 Node 启动配置。macOS 仅编译/签名合成 C 夹具和仓库探针源码，不执行其二进制；本次不运行普通页面、浏览器、Electron、探针或微信，不构建 App 包。原生窗口、签名 App 与实机项仍待认可时段。\n');
const result = spawnSync(process.execPath, ['--test', 'tests/scheduling/command.test.mjs', 'tests/headless/command.test.mjs', 'tests/helpers/command.test.mjs', 'tests/helpers/probe.test.mjs', 'tests/helpers/calibration-progress.test.mjs', 'tests/helpers/third-party-notices.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 2;
