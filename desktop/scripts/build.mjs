import { build as buildScript } from 'esbuild';
import { build as buildRenderer } from 'vite';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { requireBuildSpace } from './build-space.mjs';

await requireBuildSpace([path.resolve('dist'), path.resolve('dist/renderer'), tmpdir()]);

await buildScript({
  entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
await buildRenderer({
  configFile: false,
  root: 'src/renderer',
  base: '/',
  build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true },
});
