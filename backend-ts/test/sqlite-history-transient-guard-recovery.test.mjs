import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './sqlite-clear-support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';

for (const checkAction of ['history.guardCheck', 'history.acceptPage']) for (const failureCode of ['history_native_timeout', 'history_source_unverified', 'history_source_changed']) {
  test(`首次页${checkAction}期间${failureCode}保留真实原因及对应恢复边界`, { timeout: 5000 }, async t => {
    const cleanup = [], f = await fixture({ after: callback => cleanup.push(callback) }), storage = f.current.storage;
    let channels = 0, current;
    const accepted = Promise.withResolvers(), released = Promise.withResolvers();
    const history = new SqliteHistoryService(storage, f.current.contacts, () => {
      channels++;
      const loss = Promise.withResolvers(), state = { loss, code: null };
      current = state;
      return { ...f.channel,
        guardSession: { loss: loss.promise, failureCode: () => state.code },
        inspect: async scope => ({ ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1' }),
        close: async () => {},
      };
    }, undefined, undefined, () => accepted.resolve());
    f.state.pageRecords = [record('shard-a', '1')];
    const execute = storage.execute.bind(storage);
    let injected = false;
    storage.execute = async (name, input, ...rest) => {
      if (name === checkAction && !injected) {
        injected = true; current.code = failureCode; current.loss.resolve();
        // 等失效事务真正完成再返回检查结果，稳定复现布尔检查覆盖原始错误的交错。
        await released.promise;
      }
      const result = await execute(name, input, ...rest);
      if (name === 'history.guardRelease') released.resolve();
      return result;
    };
    const directory = { directory: async () => {
      const saved = await f.current.contacts.directory();
      return { ...saved, bindings: saved.bindings.filter(binding => binding.contact_id === f.contactA) };
    } };
    const coordinator = new FirstHistoryCoordinator(directory, history, { retryMinMs: 5, retryMaxMs: 5 });
    t.after(async () => {
      storage.execute = execute; await coordinator.close(); await history.close();
      for (const callback of cleanup.reverse()) await callback();
    });
    coordinator.wake(); await coordinator.waitForIdle();
    const token = await f.current.contacts.eligibility(f.contactA);
    if (failureCode !== 'history_source_changed') {
      assert.equal(await execute('history.normalUseRevalidationCandidate', { token }), true);
      assert.notEqual(coordinator.getState().contacts[0].phase, 'blocked', '瞬时超时不能永久停止同步');
      await accepted.promise; await coordinator.waitForIdle();
      assert.equal((await history.coverage(f.contactA)).phase, 'complete');
      assert.equal((await history.read(f.contactA)).messages.length, 1);
      assert.equal(channels, 2, '不需要额外的用户唤醒即可重验并自动读取');
    } else {
      assert.equal(await execute('history.normalUseRevalidationCandidate', { token }), true, '围栏允许后续元数据核对，候选资格本身不放行正文');
      assert.equal(coordinator.getState().contacts[0].phase, 'blocked');
      assert.equal(channels, 1); assert.equal(f.state.pageCalls, checkAction === 'history.acceptPage' ? 1 : 0);
      assert.equal((await history.read(f.contactA)).messages.length, 0, '失证后在途页不能入库');
    }
  });
}
