import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
import {openManagedLifetimeFile} from '../src/managed-database-lifetime.ts';
test('纯 TS 正式宿主在业务运行期持有原数据库共享寿命锁，完整退出后释放',{timeout:15000},async t=>{
 if(process.platform!=='darwin'){t.skip('Darwin原生锁互操作，仅在支持平台运行');return;}
 const f=await pureTsFixture(t),lock=join(f.directory,'database.lifetime');await writeFile(lock,'',{mode:0o600});
 const app=await f.start({NOTALONE_MANAGED_LIFETIME_LOCK:lock});
 await assert.rejects(openManagedLifetimeFile(lock,'exclusive'),{code:'managed_lifetime_busy'});
 assert.equal((await app.request('/api/runtime/shutdown',{})).data.state,'stopped');assert.equal(await app.host.waitForExit(7000),true);
 const exclusive=await openManagedLifetimeFile(lock,'exclusive');await exclusive.close();
});
