import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareThirdPartyNotices, verifyThirdPartyNotices } from '../../scripts/third-party-notices.mjs';

const librarySha256 = '279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3';
const runtime = { librarySha256, cliSha256: '59de512a52d7960aef70da6b42d199358429662919f5b4baababc5132a660355' };
const source = path.resolve('third-party-notices/wcdb-v2.1.15');

async function fixture(use) {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-license-test-'));
  try { await use(owned, path.join(owned, 'notalone-third-party')); }
  finally { await rm(owned, { recursive: true, force: true }); }
}

test('同字节WCDB携完整许可原文和来源索引，收集材料不冒充精确来源或许可覆盖已验证', async () => {
  await fixture(async (_owned, destination) => {
    const prepared = await prepareThirdPartyNotices(runtime, destination);
    assert.ok(prepared);
    assert.equal(prepared.licenseMaterialsCollected, true);
    assert.equal(prepared.exactBuildSourceVerified, false);
    assert.equal(prepared.binaryLicenseCoverageVerified, false);
    assert.equal(prepared.files.length, 9);
    for (const file of prepared.files) assert.deepEqual(await readFile(path.join(destination, file.name)), await readFile(path.join(source, file.name)));
    await verifyThirdPartyNotices(prepared, destination);
  });
});

test('未知WCDB字节不套用候选许可，已有目标拒绝覆盖并保留原内容', async () => {
  await fixture(async (_owned, destination) => {
    assert.equal(await prepareThirdPartyNotices({ ...runtime, librarySha256: '0'.repeat(64) }, destination), undefined);
    assert.equal(await prepareThirdPartyNotices({ ...runtime, cliSha256: '0'.repeat(64) }, destination), undefined);
    await mkdir(destination); await writeFile(path.join(destination, 'keep'), 'synthetic_preserved');
    await assert.rejects(prepareThirdPartyNotices(runtime, destination), /third_party_notice_destination/);
    assert.equal(await readFile(path.join(destination, 'keep'), 'utf8'), 'synthetic_preserved');
  });
});

test('许可资源变更、符号链接和额外文件均拒绝，不读取或输出目录外资料', async () => {
  await fixture(async (owned, destination) => {
    const prepared = await prepareThirdPartyNotices(runtime, destination);
    const file = path.join(destination, 'WCDB-LICENSE.txt');
    const original = await readFile(file);
    await writeFile(file, 'synthetic_changed');
    await assert.rejects(verifyThirdPartyNotices(prepared, destination), /third_party_notice_changed/);
    await rm(file); const external = path.join(owned, 'external'); await writeFile(external, 'synthetic_private_do_not_read');
    await symlink(external, file);
    await assert.rejects(verifyThirdPartyNotices(prepared, destination), /third_party_notice_invalid/);
    await rm(file); await writeFile(file, original);
    await writeFile(path.join(destination, 'unexpected'), 'synthetic_private_do_not_read');
    await assert.rejects(verifyThirdPartyNotices(prepared, destination), /third_party_notice_changed/);
  });
});
