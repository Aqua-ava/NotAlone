import test from 'node:test';
import assert from 'node:assert/strict';
import {cases, equivalentPairs} from './fixtures/hash-profile/cases.mjs';
import {expected} from './fixtures/hash-profile/expected-hexes.mjs';
import {rowIdentity} from '../src/history/sqlite/deletion-target.ts';
import {address as extractionAddress} from '../src/memory/sqlite/deletion.ts';
import {identity as documentsIdentity} from '../src/memory/sqlite/documents/deletion.ts';
import {identity as managementIdentity} from '../src/memory/sqlite/management/deletion.ts';
import {identity as mediaIdentity, canonical as mediaCanonical} from '../src/media/sqlite/deletion.ts';
import {canonical as replyCanonical, hash as replyHash} from '../src/reply/sqlite/deletion.ts';
import {identity as callsIdentity} from '../src/reply/sqlite/model-deletion.ts';
import {identity as candidatesIdentity} from '../src/reply/sqlite/candidates/deletion.ts';

/** 特征测试：把 8 个删除身份调用点的当前串行化+哈希输出逐字节钉住。
 * 期望值 fixtures/hash-profile/expected-hexes.mjs 由生成器按“重构前实现”一次性写出，
 * 合并重构时必须一字不改地全部通过；任何一处输出漂移都会让已库存的删除身份校验失败。 */
const impl = {
  'history.rowIdentity': rowIdentity,
  'extraction.address': extractionAddress,
  'documents.identity': documentsIdentity,
  'management.identity': managementIdentity,
  'media.identity': mediaIdentity,
  'media.canonical': mediaCanonical,
  'reply.canonical': replyCanonical,
  'reply.hash': replyHash,
  'calls.identity': callsIdentity,
  'candidates.identity': candidatesIdentity,
};

test('删除身份哈希特征覆盖全部 8 个调用点且满足清单完整性', () => {
  assert.equal(Object.keys(impl).length, 10);
  const covered = new Set(cases.map(c => c.fd));
  for (const name of Object.keys(impl)) assert.ok(covered.has(name), `无用例覆盖：${name}`);
  for (const c of cases) {
    assert.ok(impl[c.fd], `未知调用点：${c.fd}`);
    assert.ok(impl[c.fd](...c.args) === expected[c.id], `用例缺失期望：${c.id}`);
  }
});

test('删除身份哈希特征：逐字节匹配重构前期望', () => {
  for (const c of cases) {
    const actual = impl[c.fd](...c.args);
    assert.equal(actual, expected[c.id], `特征漂移：${c.id}（调用点 ${c.fd}）`);
    if (c.kind === 'hex') assert.match(actual, /^[0-9a-f]{64}$/, `非 hex 输出：${c.id}`);
  }
});

test('删除身份哈希特征：同键不同插入顺序产出同一身份', () => {
  for (const [left, right] of equivalentPairs) {
    assert.equal(impl[cases.find(c => c.id === left).fd](...cases.find(c => c.id === left).args), impl[cases.find(c => c.id === right).fd](...cases.find(c => c.id === right).args));
    assert.equal(expected[left], expected[right], `带序不变量失效：${left} vs ${right}`);
    assert.notEqual(left, right);
  }
});
