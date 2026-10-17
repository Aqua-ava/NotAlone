import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const lock = JSON.parse(await readFile(new URL('../../wechat-sources.lock.json', import.meta.url), 'utf8'));
const cli = process.env.NOTALONE_TEST_WECHAT_CLI;

test('随包只读CLI补丁和合成协议测试必须匹配固定来源锁', async () => {
  for (const [file, expected] of [[lock.cliPatch.file, lock.cliPatch.sha256], [lock.cliPatch.testFile, lock.cliPatch.testSha256]]) {
    const actual = createHash('sha256').update(await readFile(new URL(`../../${file}`, import.meta.url))).digest('hex');
    assert.equal(actual, expected, file);
  }
});

test('实际CLI零参数只显示帮助，未知参数和非白名单命令不创建配置或启动其他入口', { skip: !cli }, async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-readonly-cli-'));
  const environment = {
    HOME: owned, TMPDIR: owned, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
    WECHAT_CLI_CONFIG: path.join(owned, 'missing-config.json'), WECHAT_CLI_STATE_DIR: path.join(owned, 'state'),
    WECHAT_CLI_STRICT_READ_ONLY: 'false', WX_MCP_STRICT_READ_ONLY: 'false',
    WECHAT_CLI_DISABLE_AUTO_REFRESH: 'false', WX_MCP_DISABLE_AUTO_REFRESH: 'false', WX_KEY_BIN: '/bin/sh',
  };
  const execute = args => {
    const result = spawnSync(cli, args, { cwd: owned, env: environment, input: '', encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  try {
    for (const args of [[], ['help'], ['--help'], ['sessions', '--help'], ['help', 'resolve-chat'], ['tail', '--help'], ['watch', '--help']]) {
      const result = execute(args);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.tool, 'help');
    }
    const version = execute(['--version']);
    assert.equal(version.status, 0, version.stderr);
    const payload = JSON.parse(version.stdout);
    assert.equal(payload.data.version, lock.gitSources[0].version);
    assert.equal(payload.data.commit, lock.gitSources[0].commit);
    for (const args of [['unknown'], ['--unknown'], ['mcp'], ['keychain', 'status'], ['bootstrap'], ['setup'], ['update'], ['cache', 'refresh'], ['call-json', 'sessions', '{}'], ['sql', 'SELECT 1'], ['observe', '--mode', 'sessions']]) {
      const result = execute(args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /notalone_command_disabled/);
    }
    for (const command of ['sessions', 'resolve-chat', 'tail', 'watch']) {
      const result = execute([command, '--notalone-unknown']);
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    assert.deepEqual(await readdir(owned), []);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
