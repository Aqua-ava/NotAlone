import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import {readBounded, readPackage, validateName} from '../backend-ts/src/skills/skill-package.ts';
import {openRomanceEvidence, readRomanceTranslations, renderRomanceSourceSkill, renderRomanceLicenseAppendix, romanceSourceRoot} from './romance-source-material.mjs';

export const romanceBundleRoot = fileURLToPath(new URL('../reply-skills/romance/', import.meta.url));

/** 使用产品实际校验器核对内容包，仅读仓库内的教学材料。 */
export async function validateRomanceBundle(root = romanceBundleRoot, {sourceRoot = romanceSourceRoot} = {}) {
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
  assert.equal(catalog.schema_version, 2);
  assert.equal(catalog.content_policy, 'pinned-source-excerpts-with-source-bound-chinese-translation');
  const provenance = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'));
  const evidence = openRomanceEvidence(provenance, sourceRoot);
  const translations = readRomanceTranslations(readBounded(join(root, 'translations.json')).toString('utf8'), provenance, evidence);
  const sourcesDocument = readBounded(join(root, 'SOURCES.md')).toString('utf8');
  assert.ok(sourcesDocument.endsWith(renderRomanceLicenseAppendix(provenance, evidence)), '来源总文档缺少原作者许可声明或内容有变');
  assert.equal(catalog.entries.length, 92, '须保留用户确认的 92 个独立场景');
  assert.equal(provenance.skills.length, 92);
  assert.equal(new Set(provenance.skills.map(item => item.id)).size, 92);
  assert.equal(new Set(catalog.entries.map(entry => entry.name)).size, 92);
  assert.equal(new Set(catalog.entries.map(entry => entry.title)).size, 92);
  const folders = (await readdir(root, {withFileTypes:true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(folders, catalog.entries.map(entry => entry.name).sort(), '目录与已确认清单必须完全对应');
  const descriptions = new Set(), packages = [];
  for (const [index, entry] of catalog.entries.entries()) {
    assert.equal(entry.id, index + 1);
    validateName(entry.name);
    assert.ok(entry.name.startsWith(`romance-${String(entry.id).padStart(3, '0')}-`));
    assert.ok(entry.category && entry.title && entry.inventory_candidates.length);
    const selection = provenance.skills.find(item => item.id === entry.id);
    assert.ok(selection);
    const expected = renderRomanceSourceSkill(entry, selection, evidence, provenance.common_methods, translations);
    assert.deepEqual(selection.methods, expected.references.methods, `${entry.name} 的方法出处不完整`);
    assert.deepEqual(selection.examples, expected.references.examples, `${entry.name} 的示例出处不完整`);
    assert.deepEqual(provenance.common_methods, expected.references.common, '共用规则的出处不完整');
    assert.equal(entry.provenance_status, selection.support);
    assert.equal(entry.source_method_count, selection.methods.length);
    assert.equal(entry.source_example_count, selection.examples.length);
    let pkg;
    try { pkg = readPackage(join(root, entry.name)); }
    catch (error) { throw new Error(`${entry.name}: ${error.code ?? error.message}`, {cause:error}); }
    assert.equal(pkg.name, entry.name);
    assert.ok([...pkg.description].length >= 20 && [...pkg.description].length <= 120, `${entry.name} 的描述须保持简明且有足够场景信息`);
    assert.ok(!descriptions.has(pkg.description), `${entry.name} 的描述与其他场景相同`);
    descriptions.add(pkg.description);
    assert.ok(pkg.content.includes('references/cases.md'), `${entry.name} 缺少案例读取指针`);
    assert.ok(readBounded(join(root,entry.name,'SKILL.md')).equals(expected.document), `${entry.name} 的方法正文不是已核对原文的编排结果`);
    assert.deepEqual(pkg.resources.map(item => item.relative_path).sort(), [...expected.resources.keys()].sort(), `${entry.name} 存在未登记的资源`);
    for (const resource of pkg.resources) assert.ok(resource.content.equals(expected.resources.get(resource.relative_path)), `${entry.name}/${resource.relative_path} 出现无来源改写或新增内容`);
    for (const id of entry.inventory_candidates) {
      assert.match(id, /^[DEGCT]\d{2}$/);
      assert.ok(Number(id.slice(1)) >= 1 && Number(id.slice(1)) <= {D:33, E:28, G:43, C:17, T:6}[id[0]], `${entry.name} 的来源编号超出固定盘点范围`);
    }
    packages.push({entry, pkg, selection});
  }
  const summary = {
    packages: packages.length,
    resources: packages.reduce((sum, item) => sum + item.pkg.resources.length, 0),
    direct: packages.filter(item => item.selection.support === 'direct').length,
    sharedMethod: packages.filter(item => item.selection.support === 'shared_method').length,
    unsupported: packages.filter(item => item.selection.support === 'unsupported').length,
    methodExcerpts: packages.reduce((sum,item) => sum + item.selection.methods.length, 0),
    exampleExcerpts: packages.reduce((sum,item) => sum + item.selection.examples.length, 0),
    uniqueExampleExcerpts: new Set(packages.flatMap(item => item.selection.examples.map(ref => `${ref.source}/${ref.path}:${ref.start_line}-${ref.end_line}`))).size,
    withoutSeparateExamples: packages.filter(item => item.selection.examples.length === 0).length,
    verifiedSourceFiles: evidence.files.size,
    bodyBytes: packages.reduce((sum, item) => sum + Buffer.byteLength(item.pkg.content), 0),
    resourceBytes: packages.reduce((sum, item) => sum + item.pkg.resources.reduce((n, resource) => n + resource.content.length, 0), 0),
    warnings: packages.reduce((sum, item) => sum + item.pkg.warnings.length, 0),
    localizedExcerpts: translations.size,
  };
  return {catalog, provenance, packages, summary};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify((await validateRomanceBundle()).summary)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
