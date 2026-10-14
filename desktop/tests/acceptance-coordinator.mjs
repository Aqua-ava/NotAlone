import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

// 只协调已由受限入口启动的实例；此模块没有任何启动或重启能力。
export async function createAcceptanceCoordinator({ directory, pid, checkLease, isAlive,
  now = Date.now, wait = () => new Promise(resolve => setTimeout(resolve, 250)) }) {
  const runId = randomUUID();
  let foreground = null;
  let closing = false;
  const publish = async (state, stage = null) => {
    if (closing && state !== 'closing') throw new Error('acceptance_closing');
    const temporary = path.join(directory, 'control-state.json.tmp');
    await writeFile(temporary, JSON.stringify({ runId, pid, state, stage, foreground }), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'control-state.json'));
  };
  const check = async () => {
    if (closing) throw new Error('acceptance_closing');
    if (!isAlive()) throw new Error('acceptance_instance_exited');
    try { await checkLease(); } catch { throw new Error('acceptance_lease_ended'); }
  };
  const signaled = async stage => {
    try { return await readFile(path.join(directory, `${stage}.trigger`), 'utf8') === runId; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  await check();
  await publish('ready');
  const close = async () => { closing = true; await publish('closing'); };
  return {
    runId,
    close,
    async waitFor(stage) {
      await publish('waiting-trigger', stage);
      while (true) {
        await check();
        if (stage !== 'finish' && await signaled('finish')) throw new Error('acceptance_finished');
        if (await signaled(stage)) return;
        await wait();
      }
    },
    async waitForForeground(stage, read, timeoutMs = 15000) {
      await publish('waiting-foreground', stage);
      let started = now();
      while (true) {
        await check();
        if (await signaled('finish')) throw new Error('acceptance_finished');
        if (now() - started >= timeoutMs) {
          await publish('waiting-user', stage);
          while (true) {
            await check();
            if (await signaled('finish')) throw new Error('acceptance_finished');
            if (await signaled(`${stage}-retry`)) {
              await unlink(path.join(directory, `${stage}-retry.trigger`));
              break;
            }
            await wait();
          }
          started = now();
        }
        const sample = await read(started);
        foreground = { stage, helperBlurred: sample.helperBlurred === true,
          wechatInFront: sample.wechatInFront === true, freshObservation: sample.freshObservation === true };
        await publish('waiting-foreground', stage);
        if (foreground.helperBlurred && foreground.wechatInFront && foreground.freshObservation) {
          await publish('measuring', stage);
          return;
        }
        await wait();
      }
    },
    async holdFailure() {
      if (closing) return 'closing';
      await publish('failed-held');
      let result = 'finished';
      try {
        while (true) {
          await check();
          if (await signaled('finish')) break;
          await wait();
        }
      } catch (error) { result = error.message === 'acceptance_instance_exited' ? 'exited' : 'lease-ended'; }
      await close();
      return result;
    },
  };
}
