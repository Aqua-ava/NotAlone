import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { loadTestInventory } from './test-inventory.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { safeNode, counts } = await loadTestInventory(desktop);
process.stdout.write(`测试分类：${JSON.stringify(counts)}。默认只运行 safe-node；合成回环 HTTP、进程与 macOS 编译/签名不代表原生验收。不会启动浏览器、Electron、微信或执行探针，不构建产品 App 包。\n`);
const temporary = await mkdtemp(path.join(tmpdir(), 'notalone-safe-tests-'));
try {
  const files = [];
  for (const file of safeNode) {
    if (!file.endsWith('.test.ts')) { files.push(file); continue; }
    const output = path.join(temporary, `${files.length}-${path.basename(file, '.ts')}.cjs`);
    await build({ absWorkingDir: desktop, entryPoints: [file], outfile: output,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
    files.push(output);
  }
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: desktop, stdio: 'inherit' });
  process.exitCode = result.status ?? 2;
} finally { await rm(temporary, { recursive: true, force: true }); }
