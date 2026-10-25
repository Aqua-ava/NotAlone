// 仅合成 PG：比较旧包装、当前来源跟踪和停用来源跟踪三个版本；不启动宿主或模型。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStorageFixture } from '../../../../backend-ts/test/host-storage-fixture.mjs';

const variantRoot = process.argv[2];
assert.ok(variantRoot);
const rows = [];
for (const variant of ['before_contract_fix', 'current', 'tracking_disabled']) {
  const { HostStorage, HostStorageError } = await import(pathToFileURL(join(variantRoot, variant, 'host-storage.ts')));
  const { WechatSetupService, PostgresWechatSetupStore, WechatProbeUnavailable } = await import(
    pathToFileURL(join(variantRoot, variant, 'wechat-setup.ts')));
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open({ ...fixture.options, environment: {
    NOTALONE_DISABLE_DOTENV: '1', NOTALONE_DATABASE_URL: `host=/tmp dbname=${fixture.client.database}`,
  } });
  try {
    for (const mode of ['close', 'probe_error', 'http_cancel']) {
      const owner = randomUUID();
      await fixture.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [owner, '合成取消围栏']);
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const blocked = new Promise(resolve => { release = resolve; });
      const delayedStorage = { businessTransaction: operation => storage.businessTransaction(client => operation(
        new Proxy(client, { get(target, key) {
          if (key === 'query') return async (...args) => {
            const value = await target.query(...args);
            if (String(args[0]).startsWith('INSERT INTO public.front_sync_state')) { entered(); await blocked; }
            return value;
          };
          return Reflect.get(target, key);
        } }),
      )) };
      const service = new WechatSetupService({ ownerId: owner, store: new PostgresWechatSetupStore(delayedStorage),
        probe: async () => `wxid_${variant}_${mode}`, confirmProbe: async account => account, historySessions: async () => [] });
      try {
        const ready = await service.detect();
        let valid = true;
        const work = service.confirm({ candidate_token: ready.candidate_token, mode: 'all_private', historyAuthorized: true }, () => {
          if (!valid) {
            if (mode === 'probe_error') throw new WechatProbeUnavailable('cancelled');
            // 与生产 wechat-scope-api.ts 的 check 使用相同类型和稳定错误码。
            throw new HostStorageError('runtime_stopping');
          }
        });
        const settled = work.then(value => ({ status: 'fulfilled', value }), error => ({
          status: 'rejected', error_type: error.constructor.name, code: error.code,
        }));
        await Promise.race([started, settled.then(() => { throw new Error('未到最后写入阻塞点'); })]);
        const closing = mode === 'close' ? service.close() : Promise.resolve();
        if (mode !== 'close') valid = false;
        release();
        const outcome = await settled;
        await closing;
        const authorization_rows = {};
        for (const table of ['owner_channel_identity', 'wechat_sync_scope', 'wechat_history_sync_authorization', 'front_sync_state']) {
          authorization_rows[table] = (await fixture.client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE owner_id=$1`, [owner])).rows[0].n;
        }
        assert.deepEqual(Object.values(authorization_rows), [0, 0, 0, 0]);
        if (mode === 'close' || mode === 'http_cancel') {
          assert.equal(outcome.status, 'rejected');
          assert.equal(outcome.code, 'runtime_stopping');
        } else if (variant === 'before_contract_fix') {
          assert.equal(outcome.status, 'rejected');
          assert.equal(outcome.code, 'database_unavailable');
        } else {
          assert.equal(outcome.status, 'fulfilled');
          assert.equal(outcome.value.state, 'tool_not_ready');
          assert.equal(outcome.value.failure_code, 'wechat_probe_failed');
        }
        rows.push({ variant, mode, last_insert_blocked: true, outcome, authorization_rows });
      } finally { release(); await service.close(); }
    }
  } finally { await storage.close(); await fixture.close(); }
}
process.stdout.write(JSON.stringify({ cases: rows.length, rows, all_fixture_teardowns_passed: true }, null, 2) + '\n');
