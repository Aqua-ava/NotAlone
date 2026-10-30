import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dependencyNames = ['pg', '@types/pg'];

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (['node_modules', 'dist', '.build'].includes(entry.name)) continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(relative));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) result.push(relative);
  }
  return result;
}

test('当前源码和测试不再导入 PostgreSQL 驱动', async () => {
  const imports = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]pg['"]/;
  const violations = [];
  for (const directory of ['backend-ts/src', 'backend-ts/test', 'desktop/src', 'desktop/tests', 'desktop/scripts', 'scripts']) {
    for (const file of await sources(directory)) {
      if (imports.test(await readFile(path.join(root, file), 'utf8'))) violations.push(file);
    }
  }
  assert.deepEqual(violations, [], '当前工作树不应保留 pg 值导入、类型导入或驱动测试');
});

test('workspace 清单与锁文件不再声明 pg 或其类型包', async () => {
  for (const project of ['', 'backend-ts', 'desktop']) {
    const manifest = JSON.parse(await readFile(path.join(root, project, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of dependencyNames) assert.equal(manifest[field]?.[dependency], undefined, `${project || 'root'}:${field}:${dependency}`);
    }
  }
  const lock = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(lock, /^\s+["']?(?:@types\/pg|pg)(?:@[^\n]*|["']?)?:\s*$/m);
});
