import { spawnSync } from 'node:child_process';

process.stdout.write('验证范围：类型检查与 App/无头页面测试调度 CLI 的合成进程回归。本次未运行普通页面、浏览器或 Electron；普通页面另用 test:pages，Electron 原生窗口、签名 App 与实机项仍待认可时段。\n');
const result = spawnSync(process.execPath, ['--test', 'tests/scheduling/command.test.mjs', 'tests/headless/command.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 2;
