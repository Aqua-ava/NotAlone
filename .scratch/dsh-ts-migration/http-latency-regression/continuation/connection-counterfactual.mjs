// 仅诊断连接复用的可达上界；不实现租约/故障/Query合同，不是产品或gate结果。
import { performance } from 'node:perf_hooks';
import { writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HostStorage,connectConfigured,connectionOptions } from '../../../../backend-ts/src/host-storage.ts';
import { createStorageFixture } from '../../../../backend-ts/test/host-storage-fixture.mjs';
process.umask(0o077);
const fixture=await createStorageFixture();
const storage=await HostStorage.open(fixture.options);
const client=await connectConfigured(await connectionOptions(storage.databaseUrl,{}));
const rows=[];
try {
 for(let index=-10;index<30;index++) for(const mode of ['baseline','reuse-only']) {
  const start=performance.now();
  if(mode==='baseline') await storage.businessReadTransaction(async c=>c.query('SELECT 1 AS value'));
  else {
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await client.query("SET LOCAL search_path=pg_catalog,public");
   await client.query("SET LOCAL statement_timeout='3000ms'");
   await client.query("SET LOCAL lock_timeout='1000ms'");
   if(await storage.inspect(client)!=='ready')throw Error('合成状态不符');
   await client.query('SELECT 1 AS value');
   await client.query('COMMIT');
  }
  rows.push({index,mode,milliseconds:performance.now()-start});
 }
} finally {await client.end();await storage.close();await fixture.close();}
const summaries=Object.fromEntries(['baseline','reuse-only'].map(mode=>{const values=rows.filter(r=>r.mode===mode&&r.index>=0).map(r=>r.milliseconds).sort((a,b)=>a-b);return[mode,{p50_ms:(values[14]+values[15])/2}]}));
await writeFile(new URL('connection-counterfactual.json',import.meta.url),JSON.stringify({diagnostic_only:true,gate_eligible:false,full_files_and_db_rechecked:true,source_sha256:createHash('sha256').update(await readFile(new URL('../../../../backend-ts/src/host-storage.ts',import.meta.url))).digest('hex'),summaries,rows,own_resources_cleaned:true},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(summaries));
