// 复用当前 desktop/scripts/build.mjs 的编译配置；只构建，不执行产物或 Electron。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const [project, output] = process.argv.slice(2);
const require = createRequire(join(project, 'package.json'));
const esbuild = require('esbuild');
const result = {main: false, preload: false, renderer: false, electronStarted: false};
let phase = 'main_preload';
try {
  const {requireBuildSpace} = await import(pathToFileURL(join(project, 'scripts/build-space.mjs')).href);
  await requireBuildSpace([project, output]);
  const main = await esbuild.build({
    absWorkingDir: project,
    entryPoints: {'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts'},
    outdir: join(output, 'main-preload'), outExtension: {'.js': '.cjs'},
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false, logLevel: 'silent',
  });
  assert.equal(main.outputFiles.length, 2);
  result.main = main.outputFiles.some(file => file.path.endsWith('/main/index.cjs'));
  result.preload = main.outputFiles.some(file => file.path.endsWith('/preload/index.cjs'));
  assert.equal(result.main && result.preload, true);
  phase = 'renderer';
  const {build} = await import(pathToFileURL(require.resolve('vite')).href);
  const renderer = await build({
    configFile: false, envDir: false, root: join(project, 'src/renderer'), base: '/', logLevel: 'silent',
    cacheDir: join(output, 'vite-cache'),
    build: {outDir: join(output, 'renderer'), write: false, emptyOutDir: false},
  });
  const files = (Array.isArray(renderer) ? renderer : [renderer]).flatMap(item => item.output ?? []);
  assert.ok(files.some(file => file.fileName === 'index.html'));
  assert.ok(files.some(file => file.type === 'chunk' && file.fileName.endsWith('.js')));
  result.renderer = true;
  result.outputs = [...main.outputFiles.map(file => ({
    kind: file.path.endsWith('/main/index.cjs') ? 'main' : 'preload', bytes: file.contents.length,
    sha256: createHash('sha256').update(file.contents).digest('hex'),
  })), ...files.map(file => {
    const bytes = file.type === 'chunk' ? file.code : file.source;
    return {kind: 'renderer', name: file.fileName, bytes: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex')};
  })];
} catch (error) {
  result.error = `build_${phase}_failed`;
  result.errorCount = error.errors?.length ?? 1;
  result.missingManagedRuntimeContract = Boolean(error.errors?.some(item => item.text.includes('managed-runtime-contract.mjs')));
  process.exitCode = 1;
} finally {await esbuild.stop();}
console.log(JSON.stringify(result));
