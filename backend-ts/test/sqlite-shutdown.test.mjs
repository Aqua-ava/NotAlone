import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteHostShutdown} from '../src/host/sqlite-shutdown.ts';

test('停读请求立即接纳并去重，真实资源排空后才报告停止',async()=>{
 const gate=Promise.withResolvers();let calls=0;
 const shutdown=new SqliteHostShutdown(async()=>{calls++;await gate.promise;});
 shutdown.begin();shutdown.begin();
 assert.equal(shutdown.state,'stopping');assert.equal(shutdown.shutdownFailed,false);
 const waiting=shutdown.stop();await new Promise(setImmediate);assert.equal(calls,1);
 gate.resolve();await waiting;assert.equal(shutdown.state,'stopped');
 shutdown.begin();await shutdown.stop();assert.equal(calls,1);
});

test('停读失败保留失败状态，查询不重放关闭，明确重试才续清',async()=>{
 let calls=0;const shutdown=new SqliteHostShutdown(async()=>{if(++calls===1)throw Error('合成资源未释放');});
 await assert.rejects(shutdown.stop(),/合成资源未释放/);
 assert.equal(shutdown.state,'stopping');assert.equal(shutdown.shutdownFailed,true);
 assert.equal(shutdown.state,'stopping');assert.equal(calls,1);
 shutdown.begin();assert.equal(shutdown.shutdownFailed,false);await shutdown.stop();
 assert.equal(shutdown.state,'stopped');assert.equal(calls,2);
});
