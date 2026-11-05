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

test('停读失败暴露固定的资源键供状态诊断，重试开始即清空，成功后保持为空',async()=>{
 let calls=0;
 const failure=Object.assign(new Error('SQLITE_HOST_RESOURCE_CLOSE_FAILED'),{resources:['imageSync','合成私密名称','memory']});
 const shutdown=new SqliteHostShutdown(async()=>{if(++calls===1)throw failure;});
 assert.deepEqual(shutdown.failedResources,[]);
 await assert.rejects(shutdown.stop());
 assert.deepEqual([...shutdown.failedResources],['imageSync','memory'],'只保留符合固定名称形状的键');
 shutdown.begin();assert.deepEqual(shutdown.failedResources,[]);await shutdown.stop();
 assert.equal(shutdown.state,'stopped');assert.deepEqual(shutdown.failedResources,[]);
 // 未知形状的错误不产生资源键。
 const other=new SqliteHostShutdown(async()=>{throw new Error('任意错误');});
 await assert.rejects(other.stop());assert.deepEqual(other.failedResources,[]);
});
