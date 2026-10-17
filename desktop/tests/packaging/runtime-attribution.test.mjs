import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRuntimeAttribution } from '../../scripts/runtime-attribution.mjs';

test('固定Git原文核对提交路径与blob，不为三份通知下载整个源码归档', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-attribution-blob-'));
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  try {
    const text = Buffer.from('Synthetic original permission text.\n');
    const commit = 'a'.repeat(40); const original = path.join(owned, 'LICENSE'); await writeFile(original, text);
    const blob = createHash('sha1').update(`blob ${text.length}\0`).update(text).digest('hex');
    const lock = { formatVersion: 1, sources: [{ name: 'synthetic', version: '1', filename: 'original-LICENSE.txt', source: `https://raw.githubusercontent.com/synthetic/project/${commit}/LICENSE`, sha256: digest(text), scope: 'test', retain: true, format: 'git-blob', revision: commit, gitPath: 'LICENSE', gitBlobSha1: blob }], notices: [{ archive: 'original-LICENSE.txt', member: 'LICENSE', path: 'notices/synthetic/LICENSE', sha256: digest(text), gitBlobSha1: blob }] };
    const output = path.join(owned, 'result'); const download = async () => original;
    await prepareRuntimeAttribution({ lock, download, directory: output });
    assert.deepEqual(await readFile(path.join(output, 'notices/synthetic/LICENSE')), text);
    const changed = structuredClone(lock); changed.sources[0].gitBlobSha1 = '0'.repeat(40);
    await assert.rejects(prepareRuntimeAttribution({ lock: changed, download, directory: path.join(owned, 'changed') }), /runtime_attribution_git_blob_hash/);
    const wrongPath = structuredClone(lock); wrongPath.sources[0].source = `https://raw.githubusercontent.com/synthetic/project/${commit}/OTHER`;
    await assert.rejects(prepareRuntimeAttribution({ lock: wrongPath, download, directory: path.join(owned, 'wrong-path') }), /runtime_attribution_lock/);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('固定扩展路径与编译器提交允许观察来源，major2保守集合须同原始许可且不能绕过遗漏门', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-attribution-native-'));
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  try {
    const commit = 'b'.repeat(40); const native = Buffer.from(`observed-1.0.0/src/lib.rs\0/rustc/${commit}/library/std\0rustc_hash`);
    await mkdir(path.join(owned, 'wheel')); await writeFile(path.join(owned, 'wheel/native.so'), native);
    const cargo = 'rustc-hash = "2"\n'; await writeFile(path.join(owned, 'wheel/Cargo.toml'), cargo);
    const wheel = path.join(owned, 'wheel.tar.gz'); execFileSync('/usr/bin/tar', ['-czf', wheel, '-C', owned, 'wheel']);
    const sources = [{ name: 'synthetic-wheel', version: '1', filename: 'wheel.tar.gz', source: 'https://example.invalid/wheel.tar.gz', sha256: digest(await readFile(wheel)), scope: 'test', retain: false }];
    const notices = []; const files = new Map([['wheel.tar.gz', wheel]]);
    for (const [name, version, scope] of [['observed', '1.0.0', 'tiktoken-native-observed'], ['rustc-hash', '2.0.0', 'tiktoken-rustc-hash-major2-superset'], ['rustc-hash', '2.1.0', 'tiktoken-rustc-hash-major2-superset']]) {
      const root = `${name}-${version}`; await mkdir(path.join(owned, root));
      for (const member of ['LICENSE-MIT', 'LICENSE-APACHE']) {
        await writeFile(path.join(owned, root, member), member);
        notices.push({ archive: root + '.crate', member: root + '/' + member, path: 'notices/' + root + '/' + member, sha256: digest(member) });
      }
      const archive = path.join(owned, root + '.crate'); execFileSync('/usr/bin/tar', ['-czf', archive, '-C', owned, root]); files.set(root + '.crate', archive);
      sources.push({ name, version, filename: root + '.crate', source: `https://static.crates.io/crates/${name}/${root}.crate`, sha256: digest(await readFile(archive)), ecosystem: 'cargo', scope, retain: true });
    }
    const evidence = { archive: 'wheel.tar.gz', member: 'wheel/native.so', sha256: digest(native), rustCommit: commit, observedCrates: ['observed-1.0.0.crate'], major2Superset: { sdistArchive: 'wheel.tar.gz', cargoMember: 'wheel/Cargo.toml', cargoSha256: digest(cargo), sources: ['rustc-hash-2.0.0.crate', 'rustc-hash-2.1.0.crate'], noticeHashes: { 'LICENSE-MIT': digest('LICENSE-MIT'), 'LICENSE-APACHE': digest('LICENSE-APACHE') } } };
    const lock = { formatVersion: 1, sources, notices, nativeEvidence: [evidence] }; const download = async (item) => files.get(item.filename);
    assert.equal((await prepareRuntimeAttribution({ lock, download, directory: path.join(owned, 'result') })).nativeEvidenceCount, 1);
    for (const [label, mutate, error] of [
      ['member', (copy) => { copy.nativeEvidence[0].sha256 = '0'.repeat(64); }, /runtime_native_member_hash/],
      ['path', (copy) => { copy.sources[1].version = '9.0.0'; }, /runtime_native_crate_path/],
      ['commit', (copy) => { copy.nativeEvidence[0].rustCommit = 'c'.repeat(40); }, /runtime_native_rust_commit/],
      ['declaration', (copy) => { copy.nativeEvidence[0].major2Superset.cargoSha256 = '0'.repeat(64); }, /runtime_native_major2_declaration/],
      ['major', (copy) => { copy.sources[2].version = '3.0.0'; }, /runtime_native_major2_source/],
      ['license', (copy) => { copy.nativeEvidence[0].major2Superset.noticeHashes['LICENSE-MIT'] = '0'.repeat(64); }, /runtime_native_superset_notice/],
      ['missing', (copy) => { copy.nativeEvidence = []; }, /runtime_sbom_unreferenced_crate/],
    ]) {
      const changed = structuredClone(lock); mutate(changed);
      await assert.rejects(prepareRuntimeAttribution({ lock: changed, download, directory: path.join(owned, label) }), error);
    }
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('运行时构建从固定源归档提取真实通知，保留对应源并拒绝通知摘要不符', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-attribution-'));
  const text = 'Synthetic component copyright\nPermission is granted for this fixture.\n';
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  try {
    await mkdir(path.join(owned, 'component'));
    await writeFile(path.join(owned, 'component/LICENSE'), text);
    const archive = path.join(owned, 'component.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', owned, 'component']);
    const lock = { formatVersion: 1, sources: [{ name: 'synthetic', version: '1', filename: 'component.tar.gz', source: 'https://example.invalid/component.tar.gz', sha256: digest(await readFile(archive)), scope: 'test', retain: true }],
      notices: [{ name: 'synthetic', version: '1', archive: 'component.tar.gz', member: 'component/LICENSE', path: 'notices/synthetic/LICENSE', sha256: digest(text) }] };
    const download = async () => archive;
    const output = path.join(owned, 'result');
    await prepareRuntimeAttribution({ lock, download, directory: output });
    assert.equal(await readFile(path.join(output, 'notices/synthetic/LICENSE'), 'utf8'), text);
    assert.deepEqual(await readFile(path.join(output, 'sources/component.tar.gz')), await readFile(archive));
    const damaged = structuredClone(lock); damaged.notices[0].sha256 = '0'.repeat(64);
    await assert.rejects(prepareRuntimeAttribution({ lock: damaged, download, directory: path.join(owned, 'damaged') }), /runtime_notice_hash/);
    const escaped = structuredClone(lock); escaped.notices[0].path = '../outside';
    await assert.rejects(prepareRuntimeAttribution({ lock: escaped, download, directory: path.join(owned, 'escaped') }), /runtime_attribution_lock/);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('固定通知库存覆盖每个随包 wheel，拒绝仅提供许可名称或留空的闭包', async () => {
  const read = async (name) => JSON.parse(await readFile(new URL(`../../scripts/runtime/${name}`, import.meta.url), 'utf8'));
  const lock = await read('attribution-sources.lock.json');
  const wheels = await read('python-wheels.lock.json');
  for (const wheel of wheels) {
    assert.ok(lock.sources.some((source) => source.filename === wheel.filename && source.sha256 === wheel.sha256));
    assert.ok(lock.notices.some((notice) => notice.archive === wheel.filename), wheel.name);
  }
  for (const name of ['psycopg-c', 'psycopg-upstream', 'postgresql', 'python-build-standalone']) assert.ok(lock.sources.some((source) => source.name === name && source.retain));
  for (const suffix of ['COPYING.GPLv3', 'COPYING.LGPLv2.1']) assert.ok(lock.notices.some((notice) => notice.member.endsWith(suffix)), suffix);
});

test('静态客户端库来源对应实际wheel中的OpenSSL与libyaml版本，并保留其他组件的旧版来源', async () => {
  const lock = JSON.parse(await readFile(new URL('../../scripts/runtime/attribution-sources.lock.json', import.meta.url), 'utf8'));
  for (const expected of [
    { filename: 'source-openssl-4.0.3.tar.gz', version: '4.0.3', sha256: '325b5c806167c13b40b1ffeadfe0248197c00eccc4cf123ec1e28d2d2fd216d9', scope: 'cryptography' },
    { filename: 'source-libyaml-0.2.5.tar.gz', version: '0.2.5', sha256: 'c642ae9b75fee120b2d96c712538bd2cf283228d2337df2cf2988e3c02678ef4', scope: 'pyyaml' },
  ]) {
    assert.ok(lock.sources.some((source) => source.filename === expected.filename && source.version === expected.version && source.sha256 === expected.sha256 && source.scope === expected.scope && source.retain), expected.filename);
    assert.ok(lock.notices.some((notice) => notice.archive === expected.filename), expected.filename);
  }
  assert.ok(lock.sources.some((source) => source.filename === 'source-openssl-3.5.8.tar.gz' && source.scope === 'pbs' && source.retain));
});

test('固定wheel的SBOM原字节与SDist锁共同约束crate来源，拒绝仅凭许可表达式补全', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-sbom-'));
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  try {
    await mkdir(path.join(owned, 'crate')); await mkdir(path.join(owned, 'wheel'));
    const notice = 'Synthetic crate original permission text\n';
    await writeFile(path.join(owned, 'crate/LICENSE'), notice);
    const crate = path.join(owned, 'synthetic.crate');
    execFileSync('/usr/bin/tar', ['-czf', crate, '-C', owned, 'crate']);
    const checksum = digest(await readFile(crate));
    const sbom = { bomFormat: 'CycloneDX', components: [{ name: 'synthetic-crate', version: '1.0.0', purl: 'pkg:cargo/synthetic-crate@1.0.0', scope: 'required', hashes: [{ alg: 'SHA-256', content: checksum }] }] };
    await writeFile(path.join(owned, 'wheel/sbom.json'), JSON.stringify(sbom));
    await writeFile(path.join(owned, 'wheel/Cargo.lock'), `[[package]]\nname = "synthetic-crate"\nversion = "1.0.0"\nchecksum = "${checksum}"\n`);
    const archive = path.join(owned, 'wheel.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', owned, 'wheel']);
    const lock = { formatVersion: 1, sources: [
      { name: 'synthetic-wheel', version: '1', filename: 'wheel.tar.gz', source: 'https://example.invalid/wheel.tar.gz', sha256: digest(await readFile(archive)), scope: 'test', retain: true },
      { name: 'synthetic-crate', version: '1.0.0', filename: 'synthetic.crate', source: 'https://static.crates.io/crates/synthetic-crate/synthetic-crate-1.0.0.crate', sha256: checksum, scope: 'rust-sbom-required', ecosystem: 'cargo', retain: true },
    ], notices: [{ archive: 'synthetic.crate', member: 'crate/LICENSE', path: 'notices/synthetic/LICENSE', sha256: digest(notice) }],
    sbomEvidence: [{ archive: 'wheel.tar.gz', member: 'wheel/sbom.json', sha256: digest(JSON.stringify(sbom)), path: 'evidence/sbom.json', sdistArchive: 'wheel.tar.gz', cargoLockMember: 'wheel/Cargo.lock' }] };
    const download = async (item) => item.filename === 'synthetic.crate' ? crate : archive;
    const output = path.join(owned, 'result');
    const result = await prepareRuntimeAttribution({ lock, download, directory: output });
    assert.equal(result.sbomCount, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'evidence/sbom.json'), 'utf8')), sbom);
    const wrong = structuredClone(lock); wrong.sources[1].name = 'unrelated-crate';
    await assert.rejects(prepareRuntimeAttribution({ lock: wrong, download, directory: path.join(owned, 'wrong') }), /runtime_sbom_crate_source/);
    const wrongBlob = structuredClone(lock); wrongBlob.notices[0].gitBlobSha1 = 'f'.repeat(40);
    await assert.rejects(prepareRuntimeAttribution({ lock: wrongBlob, download, directory: path.join(owned, 'wrong-blob') }), /runtime_notice_git_blob_hash/);
    const excessive = structuredClone(lock);
    excessive.sources = Array.from({ length: 513 }, (_, index) => ({ ...lock.sources[0], filename: `source-${index}.tar.gz` }));
    let downloaded = false;
    await assert.rejects(prepareRuntimeAttribution({ lock: excessive, download: async () => { downloaded = true; return archive; }, directory: path.join(owned, 'excessive') }), /runtime_attribution_lock/);
    assert.equal(downloaded, false);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
