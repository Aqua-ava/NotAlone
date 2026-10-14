import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

test('真实绑定观察自动跟随，候选编辑恢复；在途生成仍归原联系人且观察零新增模型调用', async t => {
 const f = await budgetPublicFixture(t, { continuous: true });
 const [a,b] = f.data.contact_ids;
 await f.connect(a);
 await f.request('/api/sync/enable', {});
 const follow = async index => {
  await f.command('foreground', { index });
  await f.foreground.observeBeforeShow();
  assert.equal(f.foreground.getState().confirmation, 'verified-binding', f.foreground.getState().reason);
  const contactId = f.data.contact_ids[index];
  assert.equal(f.contacts.getState().selectedContactId, contactId);
  const scope = { contactId, scopeRevision: f.contacts.getState().scopeRevision };
  await f.bridge.readSavedSession(scope); return scope;
 };
 let scope = await follow(0);
 f.contacts.setDraft({ ...scope, text:'甲的合成草稿' });
 await f.command('plan', { plan: { text:'甲的合成候选', count:1 } });
 await f.bridge.generate({ ...scope, newRequest:true });
 const before = await f.bridge.getState();
 const candidate = before.result.candidates[0];
 await f.bridge.editCandidate({ ...scope, replyRequestId:before.result.replyRequestId,
  candidateId:candidate.original.candidateId, text:'甲未保存的合成编辑' });
 await follow(1);
 scope = await follow(0);
 assert.equal(f.contacts.getState().draft, '甲的合成草稿');
 assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '甲未保存的合成编辑');
 assert.equal((await f.command('metrics')).model_calls, 1);
 await f.command('plan', { plan: { text:'甲的后台合成结果', count:1 } });
 await f.command('hold');
 const running = f.bridge.generate({ ...scope, newRequest:true });
 try {
  for (let attempt=0; !(await f.command('metrics')).model_entered; attempt++) {
   assert.ok(attempt < 100); await new Promise(resolve => setTimeout(resolve, 20));
  }
  await follow(1);
  assert.equal((await f.bridge.getState()).contactId, b);
  assert.equal((await f.bridge.getState()).result, null);
  await f.command('release'); await running;
  assert.equal((await f.bridge.getState()).contactId, b);
  assert.equal((await f.bridge.getState()).result, null);
  await follow(0);
  assert.ok((await f.bridge.getState()).savedSession.turns.some(turn => turn.state === 'completed'));
  assert.equal((await f.command('metrics')).model_calls, 2, '观察和切换没有模型调用');
 } finally { await f.command('release'); await running; }
 await follow(1);
 let release, received;
 const held = new Promise(resolve => { release = resolve; });
 const arrived = new Promise(resolve => { received = resolve; });
 f.delivery.after = async options => { if (options.path.endsWith('/foreground/observe')) { received(); await held; } };
 await f.command('foreground', { index:0 });
 const pending = f.foreground.observeBeforeShow();
 try {
  await arrived;
  await f.command('delete_contact', { contact_id:a });
  await f.contacts.refreshContacts();
  release(); await pending;
  assert.equal(f.contacts.getState().selectedContactId, b);
  assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
  f.delivery.after = undefined;
  await f.foreground.observeBeforeShow();
  assert.equal(f.contacts.getState().selectedContactId, b);
  assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
  assert.equal((await f.command('metrics')).model_calls, 2);
 } finally { release(); await pending; f.delivery.after = undefined; }

});
