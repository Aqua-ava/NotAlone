import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { expressionPreferenceModules } from '../fixtures/expression-preference-modules.mjs';

test('HTTP和页面从同一关键模块清单生成摘要，仅明确Python入口不同', async () => {
  const root = path.resolve('..');
  const [http, page] = await Promise.all(['expression-preference-backend.py', 'expression-preferences-page.py']
    .map((entry) => expressionPreferenceModules(root, `desktop/tests/fixtures/${entry}`)));
  assert.equal(Object.keys(http).length, 9);
  assert.deepEqual(Object.keys(http), Object.keys(page));
  for (const [name, actual] of Object.entries(http)) {
    assert.match(actual.sha256, /^[a-f0-9]{64}$/);
    if (name !== '__main__') assert.deepEqual(actual, page[name]);
  }
  assert.equal(http.__main__.path, 'desktop/tests/fixtures/expression-preference-backend.py');
  assert.equal(page.__main__.path, 'desktop/tests/fixtures/expression-preferences-page.py');
  assert.notEqual(http.__main__.sha256, page.__main__.sha256);
  await assert.rejects(expressionPreferenceModules('.', 'entry.py'));
  await assert.rejects(expressionPreferenceModules(root, '/entry.py'));
});
