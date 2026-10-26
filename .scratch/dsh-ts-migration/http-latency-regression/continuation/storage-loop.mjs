// 合成 PG 上的有限性能反馈；不是正式性能验收。
import { performance } from 'node:perf_hooks';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HostStorage } from '../../../../backend-ts/src/host-storage.ts';
import { createStorageFixture } from '../../../../backend-ts/test/host-storage-fixture.mjs';
const fixture = await createStorageFixture();
await chmod(fixture.directory, 0o700);
await chmod(fixture.envFilePath, 0o600);
const storage = await HostStorage.open(fixture.options);
const samples = [], stages = [];
const trace = process.argv.includes('--trace');
if (trace) {
  for (const key of ['inspect', 'requireReady']) {
    const original = storage[key];
    storage[key] = async function(...args) {
      const start = performance.now();
      try { return await original.apply(this, args); }
      finally { stages.push({stage: key, milliseconds: performance.now() - start}); }
    };
  }
}
let cleanup = false;
try {
  for (let index = -10; index < 30; index++) {
    const start = performance.now();
    const result = await storage.businessReadTransaction(async client => (await client.query('SELECT 1 AS n')).rows[0].n);
    if (result !== 1) throw new Error('合成业务结果不符');
    samples.push({index, warmup: index < 0, milliseconds: performance.now() - start, succeeded: true});
  }
} finally { await storage.close(); await fixture.close(); cleanup = true; }
const sorted = samples.filter(x => !x.warmup).map(x => x.milliseconds).sort((a,b) => a-b);
const p50 = (sorted[14] + sorted[15]) / 2;
const report = {diagnostic_only: true, source_sha256: createHash('sha256').update(await readFile(new URL('../../../../backend-ts/src/host-storage.ts',import.meta.url))).digest('hex'), warmups: 10, scored:30, concurrency:1, samples, stages, p50_ms:p50, symptom_reproduced:p50 > 5, diagnostic_target_ms:5, own_resources_cleaned:cleanup};
await writeFile(new URL(trace ? 'storage-trace.json' : 'storage-loop.json', import.meta.url), JSON.stringify(report,null,2)+'\n', {mode:0o600});
console.log(JSON.stringify({p50_ms:p50, symptom_reproduced:report.symptom_reproduced, own_resources_cleaned:cleanup}));
process.exitCode = report.symptom_reproduced ? 2 : 0;
