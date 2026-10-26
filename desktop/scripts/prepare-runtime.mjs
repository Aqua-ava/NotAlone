import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, inspectManagedRuntime, runtimeInventory } from './managed-runtime.mjs';
import { prepareBackendRuntime } from './prepare-backend-runtime.mjs';
import { prepareRuntimeAttribution } from './runtime-attribution.mjs';
import { buildPostgresRuntime } from './build-postgres.mjs';
import { requireBuildSpace } from './build-space.mjs';
import { auditNative } from './audit-runtime-native.mjs';
const run = promisify(execFile), scripts = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scripts, '../..');
const locked = JSON.parse(await readFile(path.join(scripts, 'runtime/component-sources.lock.json'), 'utf8'));
const attribution = JSON.parse(await readFile(path.join(scripts, 'runtime/attribution-sources.lock.json'), 'utf8'));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--source-cache', '--output-directory', '--check-directory'].includes(key) || key in options || !value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('runtime_arguments');
  options[key] = path.resolve(value);
}
if (options['--check-directory']) {
  if (Object.keys(options).length !== 1) throw new Error('runtime_arguments');
  const checked = await inspectManagedRuntime(options['--check-directory']);
  console.log(`运行时完整性检查通过：${checked.files.length}个文件。`);
} else {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('runtime_platform');
  const output = options['--output-directory']; if (!output) throw new Error('runtime_output_required');
  const cache = options['--source-cache'] || path.join(repository, 'desktop/artifacts/runtime-sources');
  await requireBuildSpace([output, cache]);
  await mkdir(path.dirname(output), { recursive: true });
  if (await lstat(output).catch(() => undefined)) throw new Error('runtime_output_exists');
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), '.runtime-build-'));
  try {
    const download = async item => {
      const destination = path.join(cache, item.filename);
      if (await lstat(destination).catch(() => undefined)) {
        if ((await lstat(destination)).isSymbolicLink() || await hashFile(destination) !== item.sha256) throw new Error(`runtime_source_hash:${item.filename}`);
        return destination;
      }
      const response = await fetch(item.source, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`runtime_source_unavailable:${item.filename}`);
      const temporary = `${destination}.partial-${process.pid}`;
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (await hashFile(temporary) !== item.sha256) throw new Error(`runtime_source_hash:${item.filename}`);
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
      return destination;
    };
    const archive = await download(locked.postgres);
    const root = path.join(staging, 'notalone-runtime'); await mkdir(root);
    await buildPostgresRuntime({ archive, directory: path.join(root, 'postgres'), workDirectory: path.join(staging, 'postgres-build') });
    const project = path.join(root, 'project');
    const backend = await prepareBackendRuntime({ repository, project, workDirectory: staging });
    const licenses = path.join(root, 'licenses'); await mkdir(licenses);
    await prepareRuntimeAttribution({ lock: attribution, download, directory: path.join(licenses, 'attribution') });
    await cp(path.join(scripts, 'runtime/THIRD-PARTY-SOURCES.md'), path.join(licenses, 'README.md'));
    await cp(path.join(scripts, 'runtime/component-sources.lock.json'), path.join(licenses, 'component-sources.json'));
    const nodeVersion = (await run(process.execPath, ['--version'])).stdout.trim();
    const native = await auditNative(root, (file, args) => run(file, args));
    await writeFile(path.join(licenses, 'native-audit.json'), JSON.stringify(native, null, 2) + '\n');
    await writeFile(path.join(licenses, 'node-dependencies.json'), JSON.stringify({ nodeVersion, lockSha256: await hashFile(path.join(project, 'pnpm-lock.yaml')),
      deployedLockSha256: await hashFile(path.join(backend, 'pnpm-lock.yaml')),
      runtime: 'Electron内置Node，ELECTRON_RUN_AS_NODE=1', notices: 'project/backend-ts/node_modules中保留各包原始许可' }, null, 2) + '\n');
    const manifest = { formatVersion: 1, architecture: 'arm64', components: [locked.postgres,
      { name: 'notalone-typescript', version: '0.0.0', source: 'repository:backend-ts', sha256: await hashFile(path.join(backend, 'package.json')) }],
      paths: { project: 'project', postgres: 'postgres/bin' }, files: await runtimeInventory(root) };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await inspectManagedRuntime(root); await rename(root, output);
    console.log(`TypeScript与PostgreSQL运行时已准备：${output}；未认证打包版、搬动或首启。`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
