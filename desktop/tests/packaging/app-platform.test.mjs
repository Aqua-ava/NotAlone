import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appMinimumMacOS } from '../../scripts/app-platform.mjs';

test('应用平台配置提供格式有效的最低macOS版本', async () => {
  const platform = JSON.parse(await readFile(new URL('../../scripts/app-platform.json', import.meta.url), 'utf8'));
  assert.equal(appMinimumMacOS(platform), '15.0');
});

test('最低macOS版本拒绝缺失、宽松或带注入字符的格式', () => {
  for (const minimumMacOS of [undefined, null, 15, '', '15', '015.0', '15.00', '15.0\n', '15.0 -flag', '15.0.0.1']) {
    assert.throws(() => appMinimumMacOS({ minimumMacOS }), /app_minimum_macos_invalid/);
  }
});
