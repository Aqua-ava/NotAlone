import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function check(directory) {
  return spawnSync(process.execPath, [new URL('../../scripts/prepare-runtime.mjs', import.meta.url).pathname, '--check-directory', directory],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
}
test('独立运行时检查拒绝缺少清单的目录，不能把准备失败显示为可用', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-runtime-check-'));
  try { const checked = check(owned); assert.notEqual(checked.status, 0); assert.match(checked.stderr, /runtime_manifest_missing/); }
  finally { await rm(owned, { recursive: true, force: true }); }
});

test('打包检查逐项拒绝被替换、偷偷加入或链接包外的运行时文件', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-runtime-integrity-'));
  const directory = path.join(owned, 'notalone-runtime'); await mkdir(directory);
  const paths = ['python/bin/python3.12', 'project/backend/src/notalone/server/command.py', 'project/backend/src/notalone/startup_diagnostics.py',
    'project/backend/src/notalone/managed_postgres.py', 'project/backend/src/notalone/parent_lifetime.py',
    ...['initdb','postgres','pg_isready','psql','pg_dump','pg_restore'].map((name) => `postgres/bin/${name}`)];
  try {
    for (const file of paths) { await mkdir(path.dirname(path.join(directory,file)), {recursive:true}); await writeFile(path.join(directory,file),'synthetic', { mode: file.endsWith('.py') ? 0o600 : 0o700 }); }
    const manifest = {formatVersion:1,architecture:'arm64',components:['python','postgres'].map(name=>({name,version:'1',source:'repository:synthetic',sha256:'0'.repeat(64)})),
      paths:{python:'python/bin/python3.12',project:'project',postgres:'postgres/bin'},files:paths.sort((a,b)=>a.localeCompare(b,'en')).map((name)=>({path:name,sha256:'b3cc0475bb78a5026098858e9889acf666d31062d513d303314eca31d36e72f2',...(!name.endsWith('.py') ? { executable:true } : {})}))};
    // 合成固定内容摘要由独立sha256sum预先取得，检查器不参与构造预期值。
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
    assert.equal(check(directory).status,0);
    const selected=path.join(directory,'postgres/bin/postgres'); await writeFile(selected,'modified');
    assert.match(check(directory).stderr,/runtime_inventory_mismatch/);
    await writeFile(selected,'synthetic'); await writeFile(path.join(directory,'unexpected'),'private config');
    assert.match(check(directory).stderr,/runtime_inventory_mismatch/);
    await rm(path.join(directory,'unexpected')); await rm(selected);
    await writeFile(path.join(owned,'outside'),'synthetic'); await symlink(path.join(owned,'outside'),selected);
    assert.match(check(directory).stderr,/runtime_symlink_escape/);
  } finally { await rm(owned,{recursive:true,force:true}); }
});

test('固定来源摘要不匹配时停止准备并清理自有临时产物', {skip:process.platform!=='darwin'||process.arch!=='arm64'},async()=>{
  const owned=await mkdtemp(path.join(tmpdir(),'notalone-runtime-source-'));
  try {
    const cache=path.join(owned,'cache'),output=path.join(owned,'notalone-runtime');await mkdir(cache);await writeFile(path.join(cache,'pbs.tar.gz'),'synthetic replaced archive');
    const result=spawnSync(process.execPath,[new URL('../../scripts/prepare-runtime.mjs',import.meta.url).pathname,'--source-cache',cache,'--output-directory',output],{encoding:'utf8',timeout:10_000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/runtime_source_hash:pbs.tar.gz/);
    const entries=await import('node:fs/promises').then(fs=>fs.readdir(owned));assert.deepEqual(entries,['cache']);
  }finally{await rm(owned,{recursive:true,force:true});}
});

test('构建和App载入对同一清单一致拒绝缺少来源及备份恢复工具', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-runtime-contract-'));
  const directory = path.join(owned, 'notalone-runtime'); await mkdir(directory);
  const { build } = await import('esbuild');
  const built = await build({ entryPoints: ['src/main/startup/managed-manifest.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
  await writeFile(path.join(owned, 'loader.mjs'), built.outputFiles[0].text);
  const { verifyManagedComponents } = await import(path.join(owned, 'loader.mjs'));
  const { runtimeInventory, inspectManagedRuntime } = await import('../../scripts/managed-runtime.mjs');
  const paths = ['python/bin/python3.12', 'project/backend/src/notalone/server/command.py', 'project/backend/src/notalone/startup_diagnostics.py',
    'project/backend/src/notalone/managed_postgres.py', 'project/backend/src/notalone/parent_lifetime.py',
    ...['initdb','postgres','pg_isready','psql','pg_dump','pg_restore'].map(name => `postgres/bin/${name}`)];
  try {
    for (const file of paths) { await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), 'synthetic', { mode: file.endsWith('.py') ? 0o600 : 0o700 }); }
    const manifest = { formatVersion: 1, architecture: 'arm64', components: ['python','postgres'].map(name => ({ name, version: '1', source: 'repository:synthetic', sha256: '0'.repeat(64) })),
      paths: { python: 'python/bin/python3.12', project: 'project', postgres: 'postgres/bin' }, files: await runtimeInventory(directory) };
    const save = () => writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await save(); await inspectManagedRuntime(directory); await verifyManagedComponents(owned, () => true);
    await chmod(path.join(directory, "python/bin/python3.12"), 0o600); manifest.files = await runtimeInventory(directory); await save();
    await assert.rejects(() => inspectManagedRuntime(directory));
    await assert.rejects(() => verifyManagedComponents(owned, () => true));
    await chmod(path.join(directory, "python/bin/python3.12"), 0o700); manifest.files = await runtimeInventory(directory);
    const component = manifest.components.pop(); await save();
    await assert.rejects(() => inspectManagedRuntime(directory));
    await assert.rejects(() => verifyManagedComponents(owned, () => true));
    manifest.components.push(component);
    for (const missing of ['pg_dump','pg_restore']) {
      const selected = path.join(directory, 'postgres/bin', missing); await rm(selected);
      manifest.files = await runtimeInventory(directory); await save();
      await assert.rejects(() => inspectManagedRuntime(directory));
      await assert.rejects(() => verifyManagedComponents(owned, () => true));
      await writeFile(selected, 'synthetic', { mode: 0o700 });
    }
  } finally { await rm(owned, { recursive: true, force: true }); }
});
