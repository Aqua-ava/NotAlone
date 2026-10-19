import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withBindingFixture, type BindingFixture, type BindingMode } from './binding-backend-fixture';

type ProbeMode = 'paused' | 'manual' | 'verified';
// 复用真实授权库、认证后端及原精确收尾；只替换外部probe可执行文件。
async function withForegroundFixture(mode: ProbeMode, use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void, bindingMode: BindingMode = 'ready') {
  await withBindingFixture(`notalone-foreground-${mode}-`, bindingMode, async (fixture) => {
    const probe = fixture.environment().NOTALONE_SYNC_PROBE;
    if (probe !== path.join(fixture.directory, 'unavailable-probe')) throw new Error('本轮合成探针归属未确认。');
    const source = await readFile(path.resolve(`tests/fixtures/foreground-probe-${mode}.py`), 'utf8');
    // 同一份合成观察逻辑既支持旧单次入口，也支持新的按请求传输；不访问真实微信。
    const worker = `import contextlib, io, json, sys
source = ${JSON.stringify(source)}
def observe():
    original = sys.argv
    output = io.StringIO()
    try:
        sys.argv = [original[0], '--session', '--json', '--minimal-region', '--single-frame']
        with contextlib.redirect_stdout(output):
            try:
                exec(compile(source, __file__, 'exec'), {'__name__': '__main__', '__file__': __file__})
            except SystemExit as error:
                if error.code not in (None, 0): raise
    finally:
        sys.argv = original
    return json.loads(output.getvalue())
if sys.argv[1:] == ['--session-worker', '--json']:
    print(json.dumps({'version': 1, 'event': 'ready'}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        print(json.dumps({'version': 1, 'request_id': request['request_id'], 'result': observe()}), flush=True)
else:
    print(json.dumps(observe()), flush=True)
`;
    await writeFile(probe, `#!${fixture.pythonExecutable}\n${worker}`, { mode: 0o700 });
    if (mode === 'verified') {
      // 本场景的合成消息文件就是完整数据集；用正式envelope证明空结果已读到末尾。
      // 其余绑定/失败夹具保留原JSONL，不将缺少freshness的结果伪装为完成。
      const cliPath = path.join(fixture.directory, 'controlled-cli');
      const cliSource = await readFile(cliPath, 'utf8');
      const cli = `import contextlib, io, json, sys
source = ${JSON.stringify(cliSource)}
def run():
    exec(compile(source, __file__, 'exec'), {'__name__': '__main__', '__file__': __file__})
if len(sys.argv) > 2 and sys.argv[1] == 'tail' and '--follow' not in sys.argv:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        run()
    events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
    print(json.dumps({'ok': True, 'data': {'events': events,
        'freshness': {'message_source': 'live_message_db'},
        'query': {'chat': sys.argv[2], 'has_more': False}}}))
else:
    run()
`;
      await writeFile(cliPath, `#!${fixture.pythonExecutable}\n${cli}`, { mode: 0o700 });
    }
    if (mode === 'manual') await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({ wechat_in_front: false }), { mode: 0o600 });
    await fixture.startBackend();
    await use(fixture);
  }, cleanupConfirmed);
}
export async function withPausedForegroundFixture(use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  await withForegroundFixture('paused', use, cleanupConfirmed);
}
export async function withVerifiedForegroundFixture(use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  await withForegroundFixture('verified', use, cleanupConfirmed);
}
export interface ManualForegroundFixture {
  backend: BindingFixture;
  setVisible(visible: boolean): Promise<void>;
}
export async function withManualForegroundFixture(use: (fixture: ManualForegroundFixture) => Promise<void>, cleanupConfirmed?: () => void, bindingMode: BindingMode = 'ready') {
  await withForegroundFixture('manual', async (backend) => {
    await use({ backend, async setVisible(visible) {
      await writeFile(path.join(backend.directory, 'probe-state.json'), JSON.stringify({ wechat_in_front: visible }), { mode: 0o600 });
    } });
  }, cleanupConfirmed, bindingMode);
}

export async function withContinuousForegroundFixture(use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  await withForegroundFixture('verified', use, cleanupConfirmed, 'single-account');
}
