import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {createSyntheticProfile} from './profile-support.mjs';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';

test('合成SQLite profile继承正式模型和Skill配置，支持带引号的插件路径', async () => {
  const plugin = '/synthetic/path with "quotes"/plugin.ts';
  const entries = parse(await createSyntheticProfile(plugin, 'http://127.0.0.1:12345/anthropic'))[0].insert;
  assert.equal(entries.find(entry => entry.id === 'notalone-sqlite-host').name, plugin);
  assert.equal(entries.filter(entry => entry.id === 'reply-skill-registry').length, 1);
  assert.equal(entries.find(entry => entry.id === 'shared-llm').name, '@deepseek-ai/dsh-llm');
  const normal = resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY: 'synthetic-only'});
  assert.equal(normal.status, 'configured');
  assert.deepEqual(entries.find(entry => entry.id === 'provider').config, {
    baseURL: 'http://127.0.0.1:12345/anthropic', thinking: normal.provider.connection.defaults.thinking,
    maxTokens: normal.model.maxTokens,
    retryPolicy: {mode: normal.provider.connection.retryPolicy.mode, maxRetries: normal.provider.connection.retryPolicy.maxRetries},
  });
});

test('合成 profile 拒绝外部模型地址和嵌入凭据', async () => {
  for (const url of ['https://api.deepseek.com/anthropic', 'http://example.invalid', 'http://user:secret@127.0.0.1']) {
    await assert.rejects(createSyntheticProfile('/synthetic/plugin.ts', url), /必须使用本机环回地址/);
  }
});
