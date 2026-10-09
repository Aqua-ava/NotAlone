import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withBindingFixture, type BindingFixture } from './binding-backend-fixture';

type ProbeMode = 'paused' | 'manual';
// 复用真实授权库、认证后端及原精确收尾；只替换外部probe可执行文件。
async function withForegroundFixture(mode: ProbeMode, use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  await withBindingFixture(`notalone-foreground-${mode}-`, 'ready', async (fixture) => {
    const probe = fixture.environment().NOTALONE_SYNC_PROBE;
    if (probe !== path.join(fixture.directory, 'unavailable-probe')) throw new Error('本轮合成探针归属未确认。');
    const source = await readFile(path.resolve(`tests/fixtures/foreground-probe-${mode}.py`), 'utf8');
    await writeFile(probe, `#!${fixture.pythonExecutable}\n${source}`, { mode: 0o700 });
    if (mode === 'manual') await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({ wechat_in_front: false }), { mode: 0o600 });
    await fixture.startBackend();
    await use(fixture);
  }, cleanupConfirmed);
}
export async function withPausedForegroundFixture(use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  await withForegroundFixture('paused', use, cleanupConfirmed);
}
export interface ManualForegroundFixture {
  backend: BindingFixture;
  setVisible(visible: boolean): Promise<void>;
}
export async function withManualForegroundFixture(use: (fixture: ManualForegroundFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  await withForegroundFixture('manual', async (backend) => {
    await use({ backend, async setVisible(visible) {
      await writeFile(path.join(backend.directory, 'probe-state.json'), JSON.stringify({ wechat_in_front: visible }), { mode: 0o600 });
    } });
  }, cleanupConfirmed);
}
