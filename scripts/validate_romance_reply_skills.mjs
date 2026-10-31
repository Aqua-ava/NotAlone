import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import {readPackage, validateName} from '../backend-ts/src/skills/skill-package.ts';

export const romanceBundleRoot = fileURLToPath(new URL('../reply-skills/romance/', import.meta.url));

/** 使用产品实际校验器核对内容包，仅读仓库内的教学材料。 */
export async function validateRomanceBundle(root = romanceBundleRoot) {
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
  assert.equal(catalog.schema_version, 1);
  assert.equal(catalog.entries.length, 92, '须保留用户确认的 92 个独立场景');
  assert.equal(new Set(catalog.entries.map(entry => entry.name)).size, 92);
  assert.equal(new Set(catalog.entries.map(entry => entry.title)).size, 92);
  const folders = (await readdir(root, {withFileTypes:true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(folders, catalog.entries.map(entry => entry.name).sort(), '目录与已确认清单必须完全对应');
  const descriptions = new Set(), packages = [];
  for (const [index, entry] of catalog.entries.entries()) {
    assert.equal(entry.id, index + 1);
    validateName(entry.name);
    assert.ok(entry.name.startsWith(`romance-${String(entry.id).padStart(3, '0')}-`));
    assert.ok(entry.category && entry.title && entry.source_candidates.length);
    let pkg;
    try { pkg = readPackage(join(root, entry.name)); }
    catch (error) { throw new Error(`${entry.name}: ${error.code ?? error.message}`, {cause:error}); }
    assert.equal(pkg.name, entry.name);
    assert.ok([...pkg.description].length >= 20 && [...pkg.description].length <= 120, `${entry.name} 的描述须保持简明且有足够场景信息`);
    assert.ok(!descriptions.has(pkg.description), `${entry.name} 的描述与其他场景相同`);
    descriptions.add(pkg.description);
    assert.ok(pkg.content.includes('references/cases.md'), `${entry.name} 缺少案例读取指针`);
    const cases = pkg.resources.find(resource => resource.relative_path === 'references/cases.md');
    assert.ok(cases, `${entry.name} 缺少案例资源`);
    const caseText = cases.content.toString('utf8');
    assert.ok((caseText.match(/^#{1,6}\s*(?:案例|示例)\s*[一二三四五六七八九十\d]/gm) ?? []).length >= 2, `${entry.name} 须有两则明确分开的案例`);
    assert.match(caseText, /虚构|合成/, `${entry.name} 须标明示例性质`);
    for (const id of entry.source_candidates) {
      assert.match(id, /^[DEGCT]\d{2}$/);
      assert.ok(Number(id.slice(1)) >= 1 && Number(id.slice(1)) <= {D:33, E:28, G:43, C:17, T:6}[id[0]], `${entry.name} 的来源编号超出固定盘点范围`);
      assert.ok(`${pkg.content}\n${caseText}`.includes(id), `${entry.name} 缺少来源 ${id}`);
    }
    packages.push({entry, pkg});
  }
  const summary = {
    packages: packages.length,
    resources: packages.reduce((sum, item) => sum + item.pkg.resources.length, 0),
    cases: packages.reduce((sum, item) => sum + (item.pkg.resources.find(resource => resource.relative_path === 'references/cases.md').content.toString('utf8').match(/^#{1,6}\s*(?:案例|示例)\s*[一二三四五六七八九十\d]/gm) ?? []).length, 0),
    bodyBytes: packages.reduce((sum, item) => sum + Buffer.byteLength(item.pkg.content), 0),
    resourceBytes: packages.reduce((sum, item) => sum + item.pkg.resources.reduce((n, resource) => n + resource.content.length, 0), 0),
    warnings: packages.reduce((sum, item) => sum + item.pkg.warnings.length, 0),
  };
  return {catalog, packages, summary};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify((await validateRomanceBundle()).summary)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
