import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { hashFile } from './managed-runtime.mjs';

const run = promisify(execFile);
const sha256 = /^[a-f0-9]{64}$/;
const basename = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
const relative = (value) => typeof value === 'string' && value.length < 1024 && !/[\0\r\n\\]/.test(value) &&
  !path.posix.isAbsolute(value) && value.split('/').every((part) => part && part !== '.' && part !== '..');

// 归档只作数据读取；不解包运行、不调用源码中的安装脚本。
export async function prepareRuntimeAttribution({ lock, download, directory }) {
  if (lock?.formatVersion !== 1 || !Array.isArray(lock.sources) || !lock.sources.length || lock.sources.length > 512 ||
    !Array.isArray(lock.notices) || !lock.notices.length || lock.notices.length > 4096) throw new Error('runtime_attribution_lock');
  const sources = new Map(); const destinations = new Set();
  for (const item of lock.sources) {
    if (!basename(item.filename) || !sha256.test(item.sha256) || typeof item.retain !== 'boolean' ||
      typeof item.name !== 'string' || typeof item.version !== 'string' || typeof item.scope !== 'string' ||
      typeof item.source !== 'string' || !item.source.startsWith('https://') || sources.has(item.filename)) throw new Error('runtime_attribution_lock');
    if (item.format !== undefined && (item.format !== 'git-blob' || !/^[a-f0-9]{40}$/.test(item.revision) ||
      !/^[a-f0-9]{40}$/.test(item.gitBlobSha1) || !relative(item.gitPath) ||
      !/^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(item.source) ||
      item.source.split('/').slice(5).join('/') !== `${item.revision}/${item.gitPath}`)) throw new Error('runtime_attribution_lock');
    sources.set(item.filename, item);
  }
  for (const notice of lock.notices) {
    if (!sources.has(notice.archive) || !relative(notice.member) || !relative(notice.path) || !notice.path.startsWith('notices/') ||
      !sha256.test(notice.sha256) || (notice.gitBlobSha1 !== undefined && !/^[a-f0-9]{40}$/.test(notice.gitBlobSha1)) || destinations.has(notice.path)) throw new Error('runtime_attribution_lock');
    destinations.add(notice.path);
  }
  const sboms = lock.sbomEvidence ?? [];
  if (!Array.isArray(sboms) || sboms.length > 32) throw new Error('runtime_attribution_lock');
  for (const item of sboms) {
    if (!sources.has(item.archive) || !sources.has(item.sdistArchive) || !relative(item.member) || !relative(item.cargoLockMember) ||
      !sha256.test(item.sha256) || !relative(item.path) || !item.path.startsWith('evidence/') || destinations.has(item.path)) throw new Error('runtime_attribution_lock');
    destinations.add(item.path);
  }
  const nativeEvidence = lock.nativeEvidence ?? [];
  if (!Array.isArray(nativeEvidence) || nativeEvidence.length > 1) throw new Error('runtime_attribution_lock');
  for (const item of nativeEvidence) {
    const superset = item.major2Superset;
    if (!sources.has(item.archive) || !relative(item.member) || !sha256.test(item.sha256) || !/^[a-f0-9]{40}$/.test(item.rustCommit) ||
      !Array.isArray(item.observedCrates) || !item.observedCrates.length || item.observedCrates.length > 64 || item.observedCrates.some((file) => !sources.has(file)) ||
      !superset || !sources.has(superset.sdistArchive) || !relative(superset.cargoMember) || !sha256.test(superset.cargoSha256) ||
      !Array.isArray(superset.sources) || !superset.sources.length || superset.sources.length > 8 || superset.sources.some((file) => !sources.has(file)) ||
      ['LICENSE-MIT', 'LICENSE-APACHE'].some((member) => !sha256.test(superset.noticeHashes?.[member])) ||
      !Array.isArray(item.rustNoticeSources ?? []) || (item.rustNoticeSources ?? []).length > 3 ||
      (item.rustNoticeSources ?? []).some((file) => sources.get(file)?.format !== 'git-blob' || sources.get(file)?.revision !== item.rustCommit)) throw new Error('runtime_attribution_lock');
  }
  await mkdir(directory, { recursive: true });
  const archives = new Map(); const originalBlobs = new Map();
  for (let index = 0; index < lock.sources.length; index += 8) {
    await Promise.all(lock.sources.slice(index, index + 8).map(async (item) => {
      const selected = await download(item);
      if (await hashFile(selected) !== item.sha256) throw new Error(`runtime_attribution_source_hash:${item.filename}`);
      if (item.format === 'git-blob') {
        if ((await lstat(selected)).size > 8 * 1024 * 1024) throw new Error('runtime_attribution_git_blob_budget');
        const raw = await readFile(selected);
        if (createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex') !== item.gitBlobSha1) throw new Error('runtime_attribution_git_blob_hash');
        originalBlobs.set(item.filename, raw);
      }
      archives.set(item.filename, selected);
      if (item.retain) {
        await mkdir(path.join(directory, 'sources'), { recursive: true });
        await cp(selected, path.join(directory, 'sources', item.filename));
      }
    }));
  }
  const readMember = async (archive, selected) => {
    if (sources.get(archive).format === 'git-blob') {
      if (selected !== sources.get(archive).gitPath) throw new Error('runtime_attribution_git_blob_member');
      return originalBlobs.get(archive);
    }
    return (await run(archive.endsWith('.whl') ? '/usr/bin/unzip' : '/usr/bin/tar',
      archive.endsWith('.whl') ? ['-p', archives.get(archive), selected] : ['-xOf', archives.get(archive), selected],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 10_000 })).stdout;
  };
  for (const notice of lock.notices) {
    const stdout = await readMember(notice.archive, notice.member);
    if (createHash('sha256').update(stdout).digest('hex') !== notice.sha256) throw new Error(`runtime_notice_hash:${notice.path}`);
    if (notice.gitBlobSha1 && createHash('sha1').update(`blob ${stdout.length}\0`).update(stdout).digest('hex') !== notice.gitBlobSha1) throw new Error('runtime_notice_git_blob_hash');
    const selected = path.join(directory, notice.path);
    await mkdir(path.dirname(selected), { recursive: true }); await writeFile(selected, stdout);
  }
  const usedCrates = new Set();
  for (const evidence of sboms) {
    const raw = await readMember(evidence.archive, evidence.member);
    if (createHash('sha256').update(raw).digest('hex') !== evidence.sha256) throw new Error('runtime_sbom_hash');
    const bom = JSON.parse(raw.toString('utf8'));
    if (bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components) || bom.components.length > 512) throw new Error('runtime_sbom_format');
    const scopes = bom.components.reduce((result, component) => { const scope = component.scope ?? 'unspecified'; result[scope] = (result[scope] ?? 0) + 1; return result; }, {});
    if (evidence.scopes && JSON.stringify(Object.entries(evidence.scopes).sort()) !== JSON.stringify(Object.entries(scopes).sort())) throw new Error('runtime_sbom_scope_counts');
    const cargo = await readMember(evidence.sdistArchive, evidence.cargoLockMember);
    if (evidence.cargoLockSha256 && createHash('sha256').update(cargo).digest('hex') !== evidence.cargoLockSha256) throw new Error('runtime_sbom_cargo_lock_hash');
    const packages = cargo.toString('utf8').split('[[package]]').slice(1).map((text) => ({
      name: /^name = "([^"]+)"/m.exec(text)?.[1], version: /^version = "([^"]+)"/m.exec(text)?.[1], checksum: /^checksum = "([^"]+)"/m.exec(text)?.[1] }));
    for (const component of bom.components) {
      const checksum = component.hashes?.find((hash) => hash.alg === 'SHA-256')?.content;
      if (!component.purl?.startsWith('pkg:cargo/')) {
        if (checksum && !lock.sources.some((source) => source.version === component.version && source.sha256 === checksum && source.retain)) throw new Error('runtime_sbom_external_source');
        continue;
      }
      if (!['required', 'excluded'].includes(component.scope)) throw new Error('runtime_sbom_scope');
      const entry = packages.find((item) => item.name === component.name && item.version === component.version);
      if (component.purl.includes('?download_url=file:')) {
        if (!entry || entry.checksum || checksum) throw new Error('runtime_sbom_local_source');
        continue;
      }
      const source = lock.sources.find((item) => item.ecosystem === 'cargo' && item.name === component.name && item.version === component.version);
      if (!sha256.test(checksum) || entry?.checksum !== checksum || source?.sha256 !== checksum || !source.retain ||
        (component.scope === 'required' && source.scope !== 'rust-sbom-required') ||
        !['rust-sbom-required', 'rust-sbom-excluded-build'].includes(source.scope)) throw new Error('runtime_sbom_crate_source');
      if (source.sbomReferences && !source.sbomReferences.some((ref) => ref.archive === evidence.archive && ref.member === evidence.member && ref.scope === component.scope)) throw new Error('runtime_sbom_crate_reference');
      usedCrates.add(source.filename);
    }
    const selected = path.join(directory, evidence.path);
    await mkdir(path.dirname(selected), { recursive: true }); await writeFile(selected, raw);
  }
  // 仅补固定扩展可观察的来源与major2保守材料，不从字符串推断完整链接闭包。
  for (const evidence of nativeEvidence) {
    const native = await readMember(evidence.archive, evidence.member);
    if (createHash('sha256').update(native).digest('hex') !== evidence.sha256) throw new Error('runtime_native_member_hash');
    if (!native.includes(Buffer.from(`rustc/${evidence.rustCommit}/`))) throw new Error('runtime_native_rust_commit');
    for (const filename of evidence.observedCrates) {
      const source = sources.get(filename);
      if (source.ecosystem !== 'cargo' || !source.retain || !['rust-sbom-required', 'tiktoken-native-observed', 'tiktoken-rust-stdlib-observed'].includes(source.scope) ||
        !native.includes(Buffer.from(`${source.name}-${source.version}/src/`))) throw new Error('runtime_native_crate_path');
      usedCrates.add(filename);
    }
    const superset = evidence.major2Superset;
    const cargo = await readMember(superset.sdistArchive, superset.cargoMember);
    if (createHash('sha256').update(cargo).digest('hex') !== superset.cargoSha256 ||
      !/^rustc-hash\s*=\s*"2"\s*$/m.test(cargo.toString('utf8')) || !native.includes(Buffer.from('rustc_hash'))) throw new Error('runtime_native_major2_declaration');
    for (const filename of superset.sources) {
      const source = sources.get(filename);
      if (source.ecosystem !== 'cargo' || source.name !== 'rustc-hash' || !/^2\.\d+\.\d+$/.test(source.version) ||
        source.scope !== 'tiktoken-rustc-hash-major2-superset' || !source.retain) throw new Error('runtime_native_major2_source');
      for (const member of ['LICENSE-MIT', 'LICENSE-APACHE']) {
        const selected = `${source.name}-${source.version}/${member}`;
        const bytes = await readMember(filename, selected);
        if (createHash('sha256').update(bytes).digest('hex') !== superset.noticeHashes[member] ||
          !lock.notices.some((notice) => notice.archive === filename && notice.member === selected && notice.sha256 === superset.noticeHashes[member])) throw new Error('runtime_native_superset_notice');
      }
      usedCrates.add(filename);
    }
  }
  if (lock.sources.some((source) => source.ecosystem === 'cargo' && !usedCrates.has(source.filename))) throw new Error('runtime_sbom_unreferenced_crate');
  await writeFile(path.join(directory, 'sources-and-notices.json'), JSON.stringify(lock, null, 2) + '\n');
  return { sourceCount: lock.sources.filter((source) => source.retain).length, noticeCount: lock.notices.length, sbomCount: sboms.length, nativeEvidenceCount: nativeEvidence.length };
}
