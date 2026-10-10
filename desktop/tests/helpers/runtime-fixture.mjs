import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export async function withRuntime(use, rpaths = ['@executable_path'], absoluteDependency = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-helper-runtime-'));
  const build = (program, values) => {
    const result = spawnSync(program, values, { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, '合成原生夹具静态构建失败。');
  };
  try {
    await writeFile(path.join(directory, 'wcdb.c'), 'int synthetic_wcdb(void) { return 0; }\n');
    const sentinel = path.join(directory, 'executed');
    await writeFile(path.join(directory, 'cli.c'), `#include <stdio.h>\nextern int synthetic_wcdb(void);\nint main(void) { FILE *f = fopen(${JSON.stringify(sentinel)}, "w"); if (f) fclose(f); return synthetic_wcdb(); }\n`);
    const installName = absoluteDependency ? path.join(await realpath(directory), 'libWCDB.dylib') : '@rpath/libWCDB.dylib';
    build('/usr/bin/xcrun', ['clang', '-dynamiclib', path.join(directory, 'wcdb.c'), `-Wl,-install_name,${installName}`, '-o', path.join(directory, 'libWCDB.dylib')]);
    build('/usr/bin/xcrun', ['clang', path.join(directory, 'cli.c'), '-L', directory, '-lWCDB', ...rpaths.map((value) => `-Wl,-rpath,${value}`), '-o', path.join(directory, 'wechat-cli')]);
    for (const name of ['wechat-cli', 'libWCDB.dylib']) build('/usr/bin/codesign', ['--force', '--sign', '-', path.join(directory, name)]);
    await use(directory, sentinel);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
