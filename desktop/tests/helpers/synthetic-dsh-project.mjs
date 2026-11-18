// 受控启动测试共用的合成 DSH 项目脚手架：只写入空白入口与空 profile，不含真实后台代码。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 在 project 下建立 backend-ts 骨架并返回 DSH 可执行入口路径（其内容由调用方按用例写入）。 */
export async function syntheticDshProject(project) {
  const executable = path.join(project, 'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(project, 'backend-ts/src'), { recursive: true });
  await mkdir(path.join(project, 'backend-ts/profile'), { recursive: true });
  await writeFile(path.join(project, 'backend-ts/src/launch.ts'), '// 合成入口\n');
  await writeFile(path.join(project, 'backend-ts/profile/sqlite.patch.yml'), '[]\n');
  return executable;
}
