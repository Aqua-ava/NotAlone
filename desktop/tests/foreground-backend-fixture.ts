import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withBindingFixture, type BindingFixture } from './binding-backend-fixture';

// 复用真实授权库、认证后端及原精确收尾；只替换外部probe可执行文件。
export async function withPausedForegroundFixture(use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  await withBindingFixture('notalone-foreground-paused-', 'ready', async (fixture) => {
    const probe = fixture.environment().NOTALONE_SYNC_PROBE;
    if (probe !== path.join(fixture.directory, 'unavailable-probe')) throw new Error('本轮合成探针归属未确认。');
    const source = await readFile(path.resolve('tests/fixtures/foreground-probe-paused.py'), 'utf8');
    await writeFile(probe, `#!${fixture.pythonExecutable}\n${source}`, { mode: 0o700 });
    await fixture.startBackend();
    await use(fixture);
  }, cleanupConfirmed);
}
