import { spawnSync } from 'node:child_process';

process.stdout.write('验证范围：类型检查与测试调度 CLI/门禁的合成进程回归。真实 App 未运行；窗口、业务 UI、打包与实机项仍待预约验收。\n');
const result = spawnSync(process.execPath, ['--test', 'tests/scheduling/command.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 2;
