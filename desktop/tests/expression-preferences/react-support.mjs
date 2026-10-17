import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export async function withPreferencePanels(run) {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-preference-react-'));
  try {
    const outfile = path.join(owned, 'panels.mjs');
    const require = createRequire(path.resolve('package.json'));
    await build({ stdin: { contents: `
      export { ExpressionPreferences } from './src/renderer/ExpressionPreferences';
      export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    `, resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'installed-react', setup(plugin) {
      // 两个生产面板与测试共用实际安装的同一份hook运行时。
      plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path), external: true }));
    } }] });
    await run(await import(pathToFileURL(outfile).href));
  } finally { await rm(owned, { recursive: true, force: true }); }
}
