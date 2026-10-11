import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents:
  "export { AssistantGenerationJobs } from './src/main/reply/assistant-generation-jobs';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { AssistantGenerationJobs } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const owner = { connectionGeneration: 7, contactId: '38c6e784-93dc-476b-8a2c-2733523a23b9',
  sessionId: 'ad630563-b558-40ec-bdaa-c34201756c42' };
const requestKey = '69b51458-cf1d-47d2-a96c-fd465f15c353';
const receipt = { sessionId: owner.sessionId, requestKey, turnId: '7a750bd7-d1b9-4b96-969c-99e5464d896a',
  inputVersionId: 'a4afba16-2fa1-45d0-ac42-de8d06045bda', state: 'running' };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('已接纳准备的退出须等待实际回执及异步中断确认，不提前结束', async () => {
  const jobs = new AssistantGenerationJobs();
  const job = jobs.begin({ ...owner, requestKey });
  const confirmation = deferred(), received = [];
  let finished = false;
  const closing = Promise.resolve(jobs.beginClosing(async (actual) => {
    received.push(actual); await confirmation.promise;
  })).then(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, false, '尚无真实回执时退出不能提前完成。');
  assert.equal(job.signal.aborted, false, '实际回执在途时保持认证准备请求。');
  jobs.receiveReceipt(job, receipt);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(received, [{ ...owner, ...receipt }]);
  assert.equal(job.signal.aborted, true);
  assert.equal(finished, false, '中断尚未确认时退出不能完成。');
  confirmation.resolve(); await closing;
  assert.equal(finished, true);
  jobs.finish(job);
});

test('未知请求键的已确认操作先登记准备，退出时晚回执只能中断一次', async () => {
  const jobs = new AssistantGenerationJobs();
  const preparation = jobs.beginPreparation(owner);
  const received = [];
  let finished = false;
  const closing = jobs.beginClosing(async (actual) => { received.push(actual); }).then(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(jobs.pendingReceipts(), []);
  const job = jobs.receivePrepared(preparation, receipt);
  await closing;
  assert.deepEqual(job.identity, { ...owner, requestKey });
  assert.equal(job.signal.aborted, true);
  assert.equal(jobs.canPublish(job, owner), false);
  assert.deepEqual(received, [{ ...owner, ...receipt }]);
  await jobs.beginClosing(async () => { throw new Error('不能重复交付成功中断。'); });
  assert.equal(received.length, 1);
  jobs.finish(job);
  assert.throws(() => jobs.beginPreparation(owner), /退出/);
});

test('正式准备明确不生成候选才可排空，不能伪造请求回执', async () => {
  const jobs = new AssistantGenerationJobs();
  const preparation = jobs.beginPreparation(owner);
  let calls = 0;
  const closing = jobs.beginClosing(async () => { calls += 1; });
  jobs.completePreparationWithoutGeneration(preparation);
  await closing;
  assert.equal(calls, 0);
  assert.deepEqual(jobs.pendingReceipts(), []);
  assert.throws(() => jobs.receivePrepared(preparation, receipt), /归属/);
});

test('实际中断确认丢失时退出失败，显式重试只提交同一个实际身份', async () => {
  const jobs = new AssistantGenerationJobs();
  const job = jobs.begin({ ...owner, requestKey });
  jobs.receiveReceipt(job, receipt);
  const received = [];
  const interrupt = async (actual) => {
    received.push(actual);
    if (received.length === 1) throw new Error('中断确认丢失。');
  };
  await assert.rejects(jobs.beginClosing(interrupt), /确认丢失/);
  jobs.finish(job);
  await jobs.beginClosing(interrupt);
  assert.deepEqual(received, [{ ...owner, ...receipt }, { ...owner, ...receipt }]);
});

test('准备身份未确认而请求已结束时仍拒绝退出，不能把缺回执视作未领取', async () => {
  const jobs = new AssistantGenerationJobs();
  const preparation = jobs.beginPreparation(owner);
  jobs.finish(preparation);
  let calls = 0;
  await assert.rejects(jobs.beginClosing(async () => { calls += 1; }), /身份尚未确认/);
  assert.equal(calls, 0);
});

test('已知请求键的正式澄清仍是明确零生成结果，不阻塞退出', async () => {
  const jobs = new AssistantGenerationJobs();
  const preparation = jobs.begin({ ...owner, requestKey });
  jobs.completePreparationWithoutGeneration(preparation);
  let calls = 0;
  await jobs.beginClosing(async () => { calls += 1; });
  assert.equal(calls, 0);
  assert.deepEqual(jobs.pendingReceipts(), []);
});
