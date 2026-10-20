import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const groups = ['safe-node', 'headless', 'isolated-http-pg', 'native', 'app'];
const testName = /\.(?:test\.mjs|test\.ts|spec\.ts)$/;

// 只枚举文件名，不导入测试；有副作用的测试不能在分类检查中执行。
export async function validateTestInventory(desktopDirectory, inventory) {
  if (!inventory || Object.keys(inventory).length !== groups.length
    || Object.keys(inventory).some(group => !groups.includes(group))) throw new Error('测试分类必须完整且仅使用约定的五类');
  const found = new Set();
  async function scan(relative) {
    for (const entry of await readdir(path.join(desktopDirectory, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await scan(file);
      else if (testName.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`测试文件不可使用符号链接：${file}`);
        found.add(file);
      }
    }
  }
  await scan('tests');
  const registered = new Set();
  const counts = {};
  for (const group of groups) {
    if (!Array.isArray(inventory[group])) throw new Error(`测试分类不是列表：${group}`);
    counts[group] = inventory[group].length;
    for (const file of inventory[group]) {
      if (typeof file !== 'string' || !found.has(file)) throw new Error(`登记的测试不存在：${file}`);
      if (registered.has(file)) throw new Error(`测试重复登记：${file}`);
      registered.add(file);
    }
  }
  const missing = [...found].filter(file => !registered.has(file)).sort();
  if (missing.length) throw new Error(`测试未登记，请先核对前置条件再分类：${missing.join(', ')}`);
  return { safeNode: [...inventory['safe-node']].sort(), counts };
}

export async function loadTestInventory(desktopDirectory) {
  const inventory = JSON.parse(await readFile(path.join(desktopDirectory, 'tests/inventory.json'), 'utf8'));
  return validateTestInventory(desktopDirectory, inventory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { counts } = await loadTestInventory(desktop);
  console.log(`测试分类登记通过：${JSON.stringify(counts)}；只检查文件名，未执行测试。`);
}
