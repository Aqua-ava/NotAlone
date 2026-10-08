import { build as buildScript } from 'esbuild';
import { build as buildRenderer } from 'vite';
import path from 'node:path';

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
