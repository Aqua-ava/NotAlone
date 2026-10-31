import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, cp, readFile, writeFile, appendFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {romanceBundleRoot, validateRomanceBundle} from '../../scripts/validate_romance_reply_skills.mjs';
import {romanceSourceRoot, sourceDigest, gitBlobDigest} from '../../scripts/romance-source-material.mjs';

test('原文不足时保留空示例，并将出处放在包外', async () => {
  const {packages, summary} = await validateRomanceBundle();
  assert.equal(summary.packages, 92);
  const withoutExamples = packages.filter(item => item.selection.examples.length === 0);
  assert.ok(withoutExamples.length > 0);
  for (const {pkg} of withoutExamples) {
    const text = pkg.resources.find(item => item.relative_path === 'references/cases.md').content.toString();
    assert.match(text, /暂无单列示例/);
  }
  for (const {pkg} of packages) {
    assert.deepEqual(pkg.resources.map(item => item.relative_path).sort(), ['references/LICENSES.txt', 'references/cases.md']);
    assert.doesNotMatch(pkg.content, /github\.com|excerpt_sha256|start_line/);
    assert.doesNotMatch(pkg.resources.find(item => item.relative_path === 'references/cases.md').content.toString(), /github\.com|excerpt_sha256|start_line/);
  }
});

test('来源校验拒绝无依据正文、示例及被改动的引用', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'notalone-romance-evidence-')));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const catalog = JSON.parse(await readFile(join(romanceBundleRoot, 'catalog.json'), 'utf8'));
  const name = catalog.entries[0].name;
  async function copyBundle(label) {
    const root = join(directory, label);
    await cp(romanceBundleRoot, root, {recursive:true});
    return root;
  }

  await t.test('即使保留全部原片段，额外编写的示例也不能通过', async () => {
    const root = await copyBundle('extra-example');
    await appendFile(join(root, name, 'references/cases.md'), '\n未登记的校验标记。\n');
    await assert.rejects(validateRomanceBundle(root), /出现无来源改写或新增内容/);
  });

  await t.test('额外编写的方法不能通过', async () => {
    const root = await copyBundle('extra-method');
    await appendFile(join(root, name, 'SKILL.md'), '\n未登记的校验标记。\n');
    await assert.rejects(validateRomanceBundle(root), /方法正文不是已核对原文的编排结果/);
  });

  await t.test('行号改变而片段哈希未变时拒绝引用', async () => {
    const root = await copyBundle('changed-lines');
    const path = join(root, 'provenance.json');
    const provenance = JSON.parse(await readFile(path, 'utf8'));
    const ref = provenance.skills.flatMap(item => item.methods).find(item => item.end_line - item.start_line > 3);
    assert.ok(ref);
    ref.start_line += 1;
    await writeFile(path, JSON.stringify(provenance));
    await assert.rejects(validateRomanceBundle(root), /引用片段哈希不一致/);
  });

  await t.test('伪造源正文并同时重算全部自报哈希仍被独立锁表拒绝', async () => {
    const root = await copyBundle('changed-source');
    const sourceRoot = join(directory, 'changed-source-snapshots');
    await cp(romanceSourceRoot, sourceRoot, {recursive:true});
    const proofPath = join(root, 'provenance.json');
    const provenance = JSON.parse(await readFile(proofPath, 'utf8'));
    const file = provenance.files[0];
    const path = join(sourceRoot, file.source, `${file.path}.json`);
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    snapshot.content += '\n';
    snapshot.sha256 = file.sha256 = sourceDigest(snapshot.content);
    snapshot.blob_sha = file.blob_sha = gitBlobDigest(Buffer.from(snapshot.content));
    const refs = [...provenance.common_methods, ...provenance.skills.flatMap(item => [...item.methods, ...item.examples])];
    for (const ref of refs.filter(item => item.source === file.source && item.path === file.path)) {
      ref.source_sha256 = file.sha256;
      ref.blob_sha = file.blob_sha;
    }
    await writeFile(path, JSON.stringify(snapshot));
    await writeFile(proofPath, JSON.stringify(provenance));
    await assert.rejects(validateRomanceBundle(root, {sourceRoot}), /不符合已核对的源文件锁/);
  });
});
