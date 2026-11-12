import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseStableArguments, prepareStableCopy, sharedLinks, stableDirectory } from '../scripts/dev-stable.mjs';

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim();

async function repository() {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-stable-')));
  const root = path.join(parent, 'repo');
  await mkdir(path.join(root, 'desktop'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'desktop/file.txt'), 'one');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'one');
  return { parent, root, stable: stableDirectory(root) };
}

test('参数只接受 --update、--help 与绝对资料目录，并容忍 pnpm 透传的分隔符', () => {
  assert.deepEqual(parseStableArguments([]), { help: false, update: false, userData: undefined });
  assert.deepEqual(parseStableArguments(['--', '--update', '--user-data-dir', '/tmp/a']), { help: false, update: true, userData: '/tmp/a' });
  assert.equal(parseStableArguments(['--help']).help, true);
  for (const bad of [['--port', '1'], ['--user-data-dir'], ['--user-data-dir', 'relative'], ['--user-data-dir', '/tmp/a\nb']])
    assert.throws(() => parseStableArguments(bad), /dev:stable/);
});

test('稳定副本与主工作区同级，共享资源只限被忽略的运行必需项', () => {
  assert.equal(stableDirectory('/w/NotAlone'), '/w/NotAlone-stable');
  const links = sharedLinks('/w/NotAlone', '/w/NotAlone-stable');
  assert.ok(links.every(({ source, target }) => source.startsWith('/w/NotAlone/') && target.startsWith('/w/NotAlone-stable/')));
  assert.ok(links.some(({ target }) => target.endsWith('/.env')));
  assert.ok(!links.some(({ target }) => target.includes('skill-read')), 'Skill 只读器不共享，避免互相覆盖');
});

test('创建稳定副本固定在当前提交，主工作区后续改动与提交不影响它，--update 才前进', async () => {
  const { parent, root, stable } = await repository();
  try {
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, '.env'), 'X=1');
    const messages = [];
    await prepareStableCopy(root, { update: false }, message => messages.push(message));
    assert.equal(await readFile(path.join(stable, 'desktop/file.txt'), 'utf8'), 'one');
    assert.equal(await readlink(path.join(stable, 'node_modules')), path.join(root, 'node_modules'));
    assert.equal(await readlink(path.join(stable, '.env')), path.join(root, '.env'));
    await assert.rejects(lstat(path.join(stable, 'model-permits')), { code: 'ENOENT' });

    // 其他 Agent 正在改的未提交内容，以及随后提交的内容，都不会进入稳定副本。
    await writeFile(path.join(root, 'desktop/file.txt'), 'half-edited');
    assert.equal(await readFile(path.join(stable, 'desktop/file.txt'), 'utf8'), 'one');
    git(root, 'commit', '-q', '-am', 'two');
    messages.length = 0;
    await prepareStableCopy(root, { update: false }, message => messages.push(message));
    assert.equal(await readFile(path.join(stable, 'desktop/file.txt'), 'utf8'), 'one');
    assert.match(messages.join('\n'), /领先 1 个提交/);

    await prepareStableCopy(root, { update: true }, () => {});
    assert.equal(await readFile(path.join(stable, 'desktop/file.txt'), 'utf8'), 'half-edited');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('稳定副本有未提交改动时拒绝更新；不在副本内运行，也不接管陌生同名目录', async () => {
  const { parent, root, stable } = await repository();
  try {
    await prepareStableCopy(root, { update: false }, () => {});
    git(root, 'commit', '-q', '--allow-empty', '-m', 'two');
    await writeFile(path.join(stable, 'desktop/file.txt'), 'dirty');
    await assert.rejects(prepareStableCopy(root, { update: true }, () => {}), /未提交改动/);
    assert.equal(await readFile(path.join(stable, 'desktop/file.txt'), 'utf8'), 'dirty');
    await assert.rejects(prepareStableCopy(stable, { update: false }, () => {}), /主工作区运行/);
  } finally { await rm(parent, { recursive: true, force: true }); }
  const other = await repository();
  try {
    await mkdir(other.stable);
    await assert.rejects(prepareStableCopy(other.root, { update: false }, () => {}), /不是本仓库的稳定副本/);
  } finally { await rm(other.parent, { recursive: true, force: true }); }
});
