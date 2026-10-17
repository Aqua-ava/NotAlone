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
  assert.throws(() => jobs.beginPreparation(owner), /收尾/);
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


test('未知key的严格未领取证明只结算当前准备，保留失败发布到finally且可退出', async () => {
  const jobs = new AssistantGenerationJobs();
  const preparation = jobs.beginPreparation(owner);
  const proof = { contactId: owner.contactId, sessionId: owner.sessionId, requestKey, state: 'not_reserved' };
  jobs.receivePreparationNoGenerationProof(preparation, proof, owner.connectionGeneration);
  assert.equal(jobs.isActive(preparation), true);
  jobs.finish(preparation);
  assert.equal(jobs.isActive(preparation), false);
  await jobs.beginClosing(async () => { throw new Error('未领取不应发中断。'); });
});

test('未知key的未领取证明拒绝错范围或实际回执，并不能释放旧未知准备', async () => {
  const jobs = new AssistantGenerationJobs();
  const previous = jobs.beginPreparation(owner);
  jobs.finish(previous);
  const preparation = jobs.beginPreparation(owner);
  const proof = { contactId: owner.contactId, sessionId: owner.sessionId, requestKey, state: 'not_reserved' };
  for (const invalid of [{ ...proof, sessionId: receipt.turnId }, { ...proof, contactId: receipt.turnId },
    { ...proof, requestKey: 'invalid' }, { ...proof, extra: true }, { ...proof, state: 'running' }]) {
    assert.throws(() => jobs.receivePreparationNoGenerationProof(preparation, invalid, owner.connectionGeneration), /归属/);
  }
  assert.throws(() => jobs.receivePreparationNoGenerationProof(preparation, proof, owner.connectionGeneration + 1), /归属/);
  const known = jobs.begin({ ...owner, requestKey });
  jobs.prepareStarted(known);
  assert.throws(() => jobs.receivePreparationNoGenerationProof(known, proof, owner.connectionGeneration), /归属/);
  jobs.receiveReceipt(known, receipt);
  assert.throws(() => jobs.receivePreparationNoGenerationProof(known, proof, owner.connectionGeneration), /归属/);
  jobs.receivePreparationNoGenerationProof(preparation, proof, owner.connectionGeneration);
  jobs.finish(preparation);
  jobs.finish(known, true);
  await assert.rejects(jobs.beginClosing(async () => { throw new Error('旧身份没有实际回执。'); }), /身份尚未确认/);
});

test('未知key准备的证明在退出等待中迟到时仍结算当前身份', async () => {
  const jobs = new AssistantGenerationJobs();
  const preparation = jobs.beginPreparation(owner);
  const closing = jobs.beginClosing(async () => { throw new Error('实际未领取。'); });
  jobs.receivePreparationNoGenerationProof(preparation,
    { contactId: owner.contactId, sessionId: owner.sessionId, requestKey, state: 'not_reserved' }, owner.connectionGeneration);
  await closing;
  jobs.finish(preparation);
});


const commandIdentity = { taskId: '0e052c91-1538-487b-ae5a-acd2d0095968',
  inputVersionId: 'ea989846-90e7-47a1-952a-45c91e42ef9b', action: 'confirm',
  suggestionId: '3c347949-9a9f-4605-aa9c-05f3d1596f13', operationKey: '6927ca6d-b347-41bb-a0c5-4e20c0812cb8' };
const noGeneration = { contactId: owner.contactId, sessionId: owner.sessionId, requestKey, state: 'not_reserved' };

for (const action of ['confirm', 'answer']) test(`冻结策略命令的结束传输未知身份在${action}实际回执后收口`, async () => {
  const jobs = new AssistantGenerationJobs();
  const command = { ...commandIdentity, action, ...(action === 'answer' ? { suggestionId: null } : {}) };
  const previous = jobs.beginPreparation(owner, undefined, undefined, command);
  jobs.finish(previous);
  const preparation = jobs.beginPreparation(owner, undefined, undefined, command);
  const current = jobs.receivePrepared(preparation, receipt);
  assert.equal(jobs.isActive(previous), false);
  jobs.finish(current, true);
  await jobs.beginClosing(async () => { throw new Error('已完成的同冻结命令无需重复停止。'); });
});

test('冻结命令实际未领取证明释放已结束未知alias，当前发布保留到finally', async () => {
  const jobs = new AssistantGenerationJobs();
  const previous = jobs.beginPreparation(owner, undefined, undefined, commandIdentity);
  jobs.finish(previous);
  const current = jobs.beginPreparation(owner, undefined, undefined, commandIdentity);
  jobs.receivePreparationNoGenerationProof(current, noGeneration, owner.connectionGeneration);
  assert.equal(jobs.isActive(previous), false);
  assert.equal(jobs.isActive(current), true);
  jobs.finish(current);
  await jobs.beginClosing(async () => { throw new Error('严格同冻结命令未领取。'); });
});

test('命令关联不释放live、legacy、不同task/input/action/suggestion/operation或实际回执', () => {
  const identities = [
    { ...commandIdentity, taskId: receipt.turnId }, { ...commandIdentity, inputVersionId: receipt.inputVersionId },
    { ...commandIdentity, action: 'answer', suggestionId: null }, { ...commandIdentity, suggestionId: receipt.turnId },
    { ...commandIdentity, operationKey: receipt.turnId },
  ];
  for (const command of identities) {
    // 每类关联各用一份真实有界队列，避免夹具先撞上每owner八项的上限。
    const jobs = new AssistantGenerationJobs();
    const unmatched = jobs.beginPreparation(owner, undefined, undefined, command);
    jobs.finish(unmatched);
    const foreignOwner = jobs.beginPreparation({ ...owner, connectionGeneration: owner.connectionGeneration + 1 }, undefined, undefined, commandIdentity);
    jobs.finish(foreignOwner);
    const legacy = jobs.beginPreparation(owner); jobs.finish(legacy);
    const live = jobs.beginPreparation(owner, undefined, undefined, commandIdentity);
    const actual = jobs.beginPreparation(owner, undefined, undefined, commandIdentity);
    const withReceipt = jobs.receivePrepared(actual, { ...receipt, requestKey: commandIdentity.taskId });
    jobs.finish(withReceipt);
    const current = jobs.beginPreparation(owner, undefined, undefined, commandIdentity);
    jobs.receivePreparationNoGenerationProof(current, noGeneration, owner.connectionGeneration);
    jobs.finish(current);
    for (const untouched of [unmatched, foreignOwner, legacy, live, withReceipt]) assert.equal(jobs.isActive(untouched), true);
    assert.deepEqual(jobs.pendingReceipts(), [{ ...owner, ...receipt, requestKey: commandIdentity.taskId }]);
  }
});

test('策略准备命令只允许精确五字段UUID关联，拒绝正文或不完整身份', async () => {
  const jobs = new AssistantGenerationJobs();
  const invalid = [
    { ...commandIdentity, privateText: '不得保存的合成正文' }, { ...commandIdentity, operationKey: undefined },
    { ...commandIdentity, taskId: 'invalid' }, { ...commandIdentity, inputVersionId: 'invalid' },
    { ...commandIdentity, action: 'stop' }, { ...commandIdentity, suggestionId: 'invalid' },
    { ...commandIdentity, action: 'answer' },
  ];
  for (const command of invalid) assert.throws(() => jobs.beginPreparation(owner, undefined, undefined, command), /命令/);
  await jobs.beginClosing(async () => { throw new Error('无有效登记。'); });
});

test('登记时复制冻结命令身份，后来修改调用方对象不能误清旧身份', () => {
  const jobs = new AssistantGenerationJobs();
  const mutable = { ...commandIdentity };
  const previous = jobs.beginPreparation(owner, undefined, undefined, mutable); jobs.finish(previous);
  mutable.operationKey = receipt.turnId;
  const different = jobs.beginPreparation(owner, undefined, undefined, mutable);
  jobs.receivePreparationNoGenerationProof(different, noGeneration, owner.connectionGeneration); jobs.finish(different);
  assert.equal(jobs.isActive(previous), true);
  const matching = jobs.beginPreparation(owner, undefined, undefined, commandIdentity);
  jobs.receivePreparationNoGenerationProof(matching, noGeneration, owner.connectionGeneration); jobs.finish(matching);
  assert.equal(jobs.isActive(previous), false);
});
